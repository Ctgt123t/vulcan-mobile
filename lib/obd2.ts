// ============================================================================
// OBD2 / ELM327 connectivity over BLE *and* Bluetooth Classic SPP.
//
// Architecture
// ------------
// Obd2Manager (singleton)
//   ├── BLE scan (react-native-ble-plx) + Classic bonded enumeration (RNBT)
//   ├── Active transport (BleTransport | ClassicTransport)
//   │     └── connect / disconnect / sendCommand → raw IO
//   └── Protocol layer (handshake, DTC parse, PID poll)  — transport-agnostic
//
// Every protocol-level routine (the ELM327 handshake, scanDtcs, clearDtcs,
// pollPid) goes through Obd2Manager.sendCommand → this.transport.sendCommand,
// so adding a new transport in the future is a matter of implementing the
// Obd2Transport interface and wiring it into Obd2Manager.connect.
//
// Platform notes
// --------------
// - BLE scanning works on iOS + Android.
// - Bluetooth Classic SPP is Android-only here. iOS Classic requires MFi
//   licensing (Apple's external accessory framework), which we don't have.
//   On iOS, getBondedDevices effectively returns nothing OBD-shaped, so the
//   Classic enumeration path is skipped entirely.
// ============================================================================

import RNBluetoothClassic, {
  type BluetoothDevice,
} from "react-native-bluetooth-classic";
import {
  BleManager,
  type Characteristic,
  type Device,
  type Subscription,
} from "react-native-ble-plx";
import { PermissionsAndroid, Platform } from "react-native";
import {
  clearSavedAdapter,
  loadSavedAdapter,
  saveAdapter,
  type SavedAdapter,
} from "./savedAdapter";

// ---------- Public types ----------

export type TransportKind = "ble" | "classic";

export type ConnectionStatus =
  | "idle"
  | "scanning"
  | "connecting"
  | "handshaking"
  | "connected"
  | "error";

export interface DiscoveredDevice {
  id: string;
  name: string;
  rssi: number | null;
  likelyObd: boolean;
  transport: TransportKind;
}

export interface Dtc {
  code: string;
  rawA: number;
  rawB: number;
}

export interface FreezeFrame {
  dtc: string | null;
  rpm: number | null;
  speedKph: number | null;
  coolantC: number | null;
  fuelPressure: number | null;
}

export interface LiveData {
  rpm: number | null;
  speedKph: number | null;
  coolantC: number | null;
  intakeAirC: number | null;
  mafGps: number | null;
  throttlePct: number | null;
  shortFuelTrimPct: number | null;
  longFuelTrimPct: number | null;
  batteryV: number | null;
  updatedAt: number;
}

const EMPTY_LIVE: LiveData = {
  rpm: null,
  speedKph: null,
  coolantC: null,
  intakeAirC: null,
  mafGps: null,
  throttlePct: null,
  shortFuelTrimPct: null,
  longFuelTrimPct: null,
  batteryV: null,
  updatedAt: 0,
};

export interface LogLine {
  ts: number;
  dir: "→" | "←" | "•";
  text: string;
}

type LogFn = (dir: LogLine["dir"], text: string) => void;

// ---------- Adapter-name heuristic ----------

const OBD_NAME_PATTERNS = [
  /obd/i,
  /elm/i,
  /obdlink/i,
  /vlink/i,
  /vgate/i,
  /icar/i,
  /konnwei/i,
  /carista/i,
  /viecar/i,
  /bafx/i,
  /kiwi/i,
  /lelink/i,
];

export function looksLikeObdAdapter(name: string | null | undefined): boolean {
  if (!name) return false;
  return OBD_NAME_PATTERNS.some((p) => p.test(name));
}

const OBD_SERVICE_UUIDS = [
  "0000fff0-0000-1000-8000-00805f9b34fb",
  "0000ffe0-0000-1000-8000-00805f9b34fb",
  "0000ffb0-0000-1000-8000-00805f9b34fb",
  "6e400001-b5a3-f393-e0a9-e50e24dcca9e",
];

function hasObdServiceUUID(uuids: string[] | null | undefined): boolean {
  if (!uuids || uuids.length === 0) return false;
  const lower = uuids.map((u) => u.toLowerCase());
  return OBD_SERVICE_UUIDS.some((target) => lower.includes(target));
}

// ---------- Discovery filtering ----------

// DIAGNOSTIC MODE: loosened to surface every plausible device while we hunt
// down adapter-detection edge cases. Restore to MIN_RSSI=-80, MIN_SIGHTINGS=2
// once stable.
const MIN_RSSI = -90;
const MIN_SIGHTINGS = 1;
const MAX_RESULTS = 10;

// ---------- Base64 / ASCII helpers (BLE only) ----------

function asciiToB64(s: string): string {
  return globalThis.btoa(s);
}
function b64ToAscii(b64: string): string {
  return globalThis.atob(b64);
}

// ---------- PID decoders ----------

function decodeRpm(bytes: number[]): number | null {
  if (bytes.length < 2) return null;
  return ((bytes[0] << 8) | bytes[1]) / 4;
}
function decodeSpeed(bytes: number[]): number | null {
  if (bytes.length < 1) return null;
  return bytes[0];
}
function decodeTempC(bytes: number[]): number | null {
  if (bytes.length < 1) return null;
  return bytes[0] - 40;
}
function decodeMaf(bytes: number[]): number | null {
  if (bytes.length < 2) return null;
  return ((bytes[0] << 8) | bytes[1]) / 100;
}
function decodePercent(bytes: number[]): number | null {
  if (bytes.length < 1) return null;
  return (bytes[0] * 100) / 255;
}
function decodeFuelTrim(bytes: number[]): number | null {
  if (bytes.length < 1) return null;
  return ((bytes[0] - 128) * 100) / 128;
}
function decodeVoltage(bytes: number[]): number | null {
  if (bytes.length < 2) return null;
  return ((bytes[0] << 8) | bytes[1]) / 1000;
}

function decodeDtcBytes(a: number, b: number): string | null {
  if (a === 0 && b === 0) return null;
  const types = ["P", "C", "B", "U"];
  const type = types[(a >> 6) & 0x03];
  const second = (a >> 4) & 0x03;
  const third = (a & 0x0f).toString(16).toUpperCase();
  const fourth = ((b >> 4) & 0x0f).toString(16).toUpperCase();
  const fifth = (b & 0x0f).toString(16).toUpperCase();
  return `${type}${second}${third}${fourth}${fifth}`;
}

// VIN character set per SAE J853 — uppercase letters except I, O, Q, plus
// digits 0-9. Used to filter ISO-TP framing bytes (0x10, 0x21, 0x22) out
// of multi-frame Mode 09 PID 02 responses without needing to understand
// the exact framing each adapter emits.
const VIN_CHAR = /^[A-HJ-NPR-Z0-9]$/;

export function parseVinFromResponse(raw: string): string | null {
  // Tokenize on whitespace, keep only 2-char hex bytes. This drops 11-bit
  // CAN IDs (3-char tokens like "7E8"), ELM327 line-index prefixes ("0:",
  // "1:"), and the total-length header ("014") that some adapters emit
  // before multi-frame responses.
  const tokens = raw.split(/\s+/).filter((t) => /^[0-9A-F]{2}$/i.test(t));
  if (tokens.length < 4) return null;
  const bytes = tokens.map((t) => parseInt(t, 16));

  // Find 49 02 (Mode 09 response code + PID 02). Walk past the count byte
  // (typically 01) that follows, then collect 17 printable VIN chars.
  for (let i = 0; i + 2 < bytes.length; i++) {
    if (bytes[i] !== 0x49 || bytes[i + 1] !== 0x02) continue;
    const out: string[] = [];
    for (let j = i + 3; j < bytes.length && out.length < 17; j++) {
      const ch = String.fromCharCode(bytes[j]);
      if (VIN_CHAR.test(ch)) out.push(ch);
    }
    if (out.length === 17) return out.join("");
  }
  return null;
}

// ---------- Command buffer (shared between transports) ----------
//
// ELM327 responses arrive as ASCII text terminated by ">". Each transport
// accumulates raw bytes via its own IO mechanism (BLE characteristic notify
// vs Classic onDataReceived) and pushes them into a CommandBuffer; the
// buffer resolves a pending awaitResponse() when the prompt arrives.

class CommandBuffer {
  private buf = "";
  private pendingResolve: ((response: string) => void) | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;

  receive(text: string): void {
    this.buf += text;
    if (!this.buf.includes(">")) return;
    const full = this.buf.slice(0, this.buf.indexOf(">"));
    const clean = full.replace(/\r/g, " ").replace(/\s+/g, " ").trim();
    if (this.pendingResolve) {
      const resolve = this.pendingResolve;
      this.pendingResolve = null;
      if (this.pendingTimer) {
        clearTimeout(this.pendingTimer);
        this.pendingTimer = null;
      }
      resolve(clean);
    }
    this.buf = "";
  }

  awaitResponse(timeoutMs: number): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      this.pendingResolve = (text) => resolve(text);
      this.pendingTimer = setTimeout(() => {
        const partial = this.buf;
        this.pendingResolve = null;
        this.pendingTimer = null;
        resolve(partial || null);
      }, timeoutMs);
    });
  }

  reset(): void {
    this.buf = "";
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    this.pendingResolve = null;
  }
}

// ---------- Transport abstraction ----------

interface Obd2Transport {
  readonly kind: TransportKind;
  connect(
    deviceId: string,
    onDisconnected: () => void,
  ): Promise<{ ok: boolean; message: string }>;
  disconnect(): Promise<void>;
  sendCommand(cmd: string, timeoutMs: number): Promise<string | null>;
  isConnected(): boolean;
}

// ---------- BLE transport ----------

class BleTransport implements Obd2Transport {
  readonly kind: TransportKind = "ble";
  private device: Device | null = null;
  private writeServiceUUID: string | null = null;
  private writeCharUUID: string | null = null;
  private notifyServiceUUID: string | null = null;
  private notifyCharUUID: string | null = null;
  private notifySub: Subscription | null = null;
  private disconnectSub: Subscription | null = null;
  private cmdBuf = new CommandBuffer();

  constructor(
    private bleManager: BleManager,
    private log: LogFn,
  ) {}

  async connect(
    deviceId: string,
    onDisconnected: () => void,
  ): Promise<{ ok: boolean; message: string }> {
    try {
      const device = await this.bleManager.connectToDevice(deviceId, {
        timeout: 12000,
      });
      this.device = device;
      await device.discoverAllServicesAndCharacteristics();
      const found = await this.findCharacteristics(device);
      if (!found) {
        await this.disconnect();
        return {
          ok: false,
          message:
            "Couldn't find a compatible read/write channel on this device.",
        };
      }

      this.notifySub = device.monitorCharacteristicForService(
        this.notifyServiceUUID!,
        this.notifyCharUUID!,
        (error, characteristic) => {
          if (error || !characteristic?.value) return;
          this.cmdBuf.receive(b64ToAscii(characteristic.value));
        },
      );

      this.disconnectSub = device.onDisconnected(() => {
        onDisconnected();
      });

      return { ok: true, message: "Connected" };
    } catch (err) {
      const msg = (err as Error).message ?? "Connection failed";
      this.log("•", `BLE connect failed: ${msg}`);
      return { ok: false, message: msg };
    }
  }

  private async findCharacteristics(device: Device): Promise<boolean> {
    const services = await device.services();
    for (const service of services) {
      const chars = await service.characteristics();
      let writable: Characteristic | null = null;
      let notifiable: Characteristic | null = null;
      for (const c of chars) {
        if (c.isWritableWithResponse || c.isWritableWithoutResponse) {
          if (!writable) writable = c;
        }
        if (c.isNotifiable || c.isIndicatable) {
          if (!notifiable) notifiable = c;
        }
      }
      if (writable && notifiable) {
        this.writeServiceUUID = service.uuid;
        this.writeCharUUID = writable.uuid;
        this.notifyServiceUUID = service.uuid;
        this.notifyCharUUID = notifiable.uuid;
        this.log(
          "•",
          `BLE channel: service ${service.uuid.slice(0, 8)}…`,
        );
        return true;
      }
    }
    return false;
  }

  async sendCommand(cmd: string, timeoutMs: number): Promise<string | null> {
    if (!this.device || !this.writeServiceUUID || !this.writeCharUUID) {
      return null;
    }
    this.log("→", cmd);
    this.cmdBuf.reset();
    const p = this.cmdBuf.awaitResponse(timeoutMs);
    try {
      await this.device.writeCharacteristicWithResponseForService(
        this.writeServiceUUID,
        this.writeCharUUID,
        asciiToB64(cmd + "\r"),
      );
    } catch (err) {
      this.log("•", `BLE write failed: ${(err as Error).message}`);
      this.cmdBuf.reset();
      return null;
    }
    const response = await p;
    this.log("←", response ?? "(no response)");
    return response;
  }

  isConnected(): boolean {
    return this.device !== null;
  }

  async disconnect(): Promise<void> {
    this.cmdBuf.reset();
    if (this.notifySub) {
      this.notifySub.remove();
      this.notifySub = null;
    }
    if (this.disconnectSub) {
      this.disconnectSub.remove();
      this.disconnectSub = null;
    }
    if (this.device) {
      try {
        await this.device.cancelConnection();
      } catch {
        // already gone
      }
      this.device = null;
    }
    this.writeServiceUUID = null;
    this.writeCharUUID = null;
    this.notifyServiceUUID = null;
    this.notifyCharUUID = null;
  }
}

// ---------- Classic SPP transport ----------

// Well-known Serial Port Profile UUID — every standard Bluetooth Classic SPP
// device (including OBDLink MX+) exposes a service with this UUID. Some
// react-native-bluetooth-classic builds use it as the implicit default, but
// we don't rely on that — explicit is better here.
const SPP_UUID = "00001101-0000-1000-8000-00805F9B34FB";

const CLASSIC_CONNECT_ATTEMPTS = 3;
const CLASSIC_CONNECT_RETRY_MS = 1000;
const CLASSIC_POST_CONNECT_SETTLE_MS = 2500;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

class ClassicTransport implements Obd2Transport {
  readonly kind: TransportKind = "classic";
  private device: BluetoothDevice | null = null;
  private dataSub: { remove: () => void } | null = null;
  private disconnectSub: { remove: () => void } | null = null;
  private cmdBuf = new CommandBuffer();

  constructor(private log: LogFn) {}

  async connect(
    deviceId: string,
    onDisconnected: () => void,
  ): Promise<{ ok: boolean; message: string }> {
    let lastErrorMessage = "Unknown error";

    for (let attempt = 1; attempt <= CLASSIC_CONNECT_ATTEMPTS; attempt++) {
      console.log(
        `[obd2 classic] === connect attempt ${attempt}/${CLASSIC_CONNECT_ATTEMPTS} → ${deviceId} ===`,
      );
      try {
        // Connect options for the OBDLink MX+:
        //
        // - SECURE_SOCKET: false → insecure RFCOMM (many ELM327/STN clones
        //   refuse the secure path).
        // - CONNECTOR_TYPE: "rfcomm" → standard SPP socket.
        // - UUID: the well-known SPP service UUID.
        // - charset: "ascii" → match the ELM327's ASCII-only protocol.
        //   (Lowercase key because StandardOption.DEVICE_CHARSET reads
        //   "charset", not "CHARSET" — uppercase is silently ignored.)
        // - DELIMITER: "" → IMPORTANT. The library's default
        //   DelimitedStringDeviceConnectionImpl waits for "\n" before
        //   firing onDataReceived. ELM327 terminates with "\r\r>" and
        //   never sends "\n", so the default makes the listener silent
        //   forever. Passing an empty delimiter switches the library into
        //   "emit the whole buffer on every chunk" mode (see the comment
        //   in DelimitedStringDeviceConnectionImpl.java), which gives us
        //   raw streaming. Our CommandBuffer already detects ">" itself.
        const options = {
          CONNECTOR_TYPE: "rfcomm" as const,
          SECURE_SOCKET: false,
          charset: "ascii" as const,
          DELIMITER: "",
          UUID: SPP_UUID,
        };
        console.log(
          `[obd2 classic] calling RNBluetoothClassic.connectToDevice with ${JSON.stringify(options)}`,
        );
        const device = await RNBluetoothClassic.connectToDevice(
          deviceId,
          options,
        );
        console.log(
          `[obd2 classic] socket OPEN — address=${device.address} name=${JSON.stringify(device.name)}`,
        );
        this.device = device;

        this.dataSub = device.onDataReceived((event) => {
          const data = event.data;
          const len = typeof data === "string" ? data.length : 0;
          console.log(
            `[obd2 classic] RX (${len} chars): ${JSON.stringify(data)}`,
          );
          if (typeof data === "string") {
            this.cmdBuf.receive(data);
          }
        });

        this.disconnectSub = RNBluetoothClassic.onDeviceDisconnected(
          (event) => {
            console.log(
              `[obd2 classic] DISCONNECT event: ${JSON.stringify(event)}`,
            );
            if (event.address === deviceId) onDisconnected();
          },
        );

        // The MX+ needs a moment after socket open before it'll accept
        // commands — without this delay the first ATZ often times out.
        console.log(
          `[obd2 classic] waiting ${CLASSIC_POST_CONNECT_SETTLE_MS}ms for adapter to settle…`,
        );
        await sleep(CLASSIC_POST_CONNECT_SETTLE_MS);
        console.log(`[obd2 classic] settle complete, ready for handshake`);

        return { ok: true, message: "Connected" };
      } catch (err) {
        lastErrorMessage = (err as Error).message ?? "Unknown error";
        console.log(
          `[obd2 classic] attempt ${attempt} FAILED: ${lastErrorMessage}`,
        );

        // Tear down any partial state from this failed attempt before retry.
        if (this.dataSub) {
          try {
            this.dataSub.remove();
          } catch {}
          this.dataSub = null;
        }
        this.device = null;

        if (attempt < CLASSIC_CONNECT_ATTEMPTS) {
          console.log(
            `[obd2 classic] sleeping ${CLASSIC_CONNECT_RETRY_MS}ms before retry…`,
          );
          await sleep(CLASSIC_CONNECT_RETRY_MS);
        }
      }
    }

    // All attempts failed — surface a tailored message.
    const isBondError = /bond|pair|not.*found/i.test(lastErrorMessage);
    const isSocketError = /socket|read failed|timeout|ret:/i.test(
      lastErrorMessage,
    );
    let friendly: string;
    if (isBondError) {
      friendly =
        "This adapter isn't paired yet. Open Android Bluetooth Settings, pair it there (PIN is usually 1234 or 0000), then try Vulcan again.";
    } else if (isSocketError) {
      friendly =
        "Couldn't open a Bluetooth socket to the adapter after 3 attempts. " +
        "Make sure no other app (OBDLink, Torque, etc.) is connected to it, " +
        "and the adapter LED isn't already lit solid. Power-cycle the adapter and try again.";
    } else {
      friendly = `Couldn't connect after 3 attempts. Last error: ${lastErrorMessage}`;
    }
    this.log("•", `Classic connect gave up: ${lastErrorMessage}`);
    return { ok: false, message: friendly };
  }

  async sendCommand(cmd: string, timeoutMs: number): Promise<string | null> {
    if (!this.device) return null;
    console.log(`[obd2 classic] TX: ${JSON.stringify(cmd)} (timeout ${timeoutMs}ms)`);
    this.log("→", cmd);
    this.cmdBuf.reset();
    const p = this.cmdBuf.awaitResponse(timeoutMs);
    try {
      await this.device.write(cmd + "\r");
    } catch (err) {
      console.log(
        `[obd2 classic] write threw: ${(err as Error).message}`,
      );
      this.cmdBuf.reset();
      return null;
    }
    const response = await p;
    console.log(
      `[obd2 classic] response for ${JSON.stringify(cmd)}: ${JSON.stringify(response)}`,
    );
    this.log("←", response ?? "(no response)");
    return response;
  }

  isConnected(): boolean {
    return this.device !== null;
  }

  async disconnect(): Promise<void> {
    this.cmdBuf.reset();
    if (this.dataSub) {
      try {
        this.dataSub.remove();
      } catch {}
      this.dataSub = null;
    }
    if (this.disconnectSub) {
      try {
        this.disconnectSub.remove();
      } catch {}
      this.disconnectSub = null;
    }
    if (this.device) {
      try {
        await this.device.disconnect();
      } catch {
        // already gone
      }
      this.device = null;
    }
  }
}

// ---------- Manager ----------

class Obd2Manager {
  private bleManager: BleManager | null = null;
  private transport: Obd2Transport | null = null;

  private status: ConnectionStatus = "idle";
  private statusMessage = "";

  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private pollPaused = false;
  private liveData: LiveData = { ...EMPTY_LIVE };

  // Subscribers
  private statusListeners = new Set<
    (s: ConnectionStatus, msg: string) => void
  >();
  private liveListeners = new Set<(d: LiveData) => void>();
  private logListeners = new Set<(line: LogLine) => void>();
  private deviceListeners = new Set<(devices: DiscoveredDevice[]) => void>();

  private discovered = new Map<string, DiscoveredDevice>();
  private sightings = new Map<
    string,
    { device: DiscoveredDevice; count: number }
  >();
  private scanResolver: (() => void) | null = null;

  // ---------- Public state ----------

  getStatus(): { status: ConnectionStatus; message: string } {
    return { status: this.status, message: this.statusMessage };
  }
  isConnected(): boolean {
    return this.status === "connected";
  }
  getLiveData(): LiveData {
    return this.liveData;
  }
  getDiscovered(): DiscoveredDevice[] {
    return Array.from(this.discovered.values());
  }

  // ---------- Subscribers ----------

  onStatus(cb: (s: ConnectionStatus, msg: string) => void): () => void {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }
  onLive(cb: (d: LiveData) => void): () => void {
    this.liveListeners.add(cb);
    return () => this.liveListeners.delete(cb);
  }
  onLog(cb: (l: LogLine) => void): () => void {
    this.logListeners.add(cb);
    return () => this.logListeners.delete(cb);
  }
  onDevices(cb: (d: DiscoveredDevice[]) => void): () => void {
    this.deviceListeners.add(cb);
    return () => this.deviceListeners.delete(cb);
  }

  // ---------- Logging ----------

  private log: LogFn = (dir, text) => {
    const line: LogLine = { ts: Date.now(), dir, text };
    this.logListeners.forEach((cb) => cb(line));
  };

  private setStatus(s: ConnectionStatus, msg = "") {
    this.status = s;
    this.statusMessage = msg;
    this.statusListeners.forEach((cb) => cb(s, msg));
  }

  // ---------- Permissions ----------

  async ensurePermissions(): Promise<{ ok: boolean; reason?: string }> {
    if (Platform.OS === "android") {
      const apiLevel = Platform.Version as number;
      try {
        if (apiLevel >= 31) {
          const granted = await PermissionsAndroid.requestMultiple([
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          ]);
          const ok =
            granted[PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN] ===
              "granted" &&
            granted[PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT] ===
              "granted";
          return ok
            ? { ok: true }
            : { ok: false, reason: "Bluetooth permission denied." };
        }
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        );
        return granted === "granted"
          ? { ok: true }
          : { ok: false, reason: "Location permission required for BLE scan." };
      } catch (err) {
        return { ok: false, reason: (err as Error).message };
      }
    }
    return { ok: true };
  }

  // ---------- Lifecycle ----------

  init(): void {
    if (this.bleManager) return;
    try {
      this.bleManager = new BleManager();
    } catch (err) {
      this.log("•", `BleManager init failed: ${(err as Error).message}`);
    }
  }

  async checkBluetoothOn(): Promise<boolean> {
    if (!this.bleManager) this.init();
    if (!this.bleManager) return false;
    const state = await this.bleManager.state();
    return state === "PoweredOn";
  }

  // ---------- Scan ----------
  //
  // BLE scan runs continuously for `durationMs`; the callback fires per
  // advertisement. Classic enumeration is one-shot via getBondedDevices()
  // on Android — paired adapters appear instantly with no RSSI.

  clearDiscovered(): void {
    this.discovered.clear();
    this.sightings.clear();
    this.deviceListeners.forEach((cb) => cb([]));
  }

  async startScan(durationMs = 20000): Promise<void> {
    this.init();
    const perm = await this.ensurePermissions();
    if (!perm.ok) {
      this.setStatus("error", perm.reason || "Permission denied.");
      return;
    }
    if (!this.bleManager) {
      this.setStatus("error", "Bluetooth not available on this device.");
      return;
    }
    const btState = await this.bleManager.state();
    if (btState !== "PoweredOn") {
      this.setStatus(
        "error",
        "Bluetooth is off. Turn it on in Settings and try again.",
      );
      return;
    }

    this.clearDiscovered();
    this.setStatus("scanning", "Looking for OBD2 adapters…");
    this.log("•", "Scan started");

    // Classic bonded enumeration (Android only) — synchronous-ish, happens
    // immediately so paired Classic adapters appear in the picker right away.
    if (Platform.OS === "android") {
      this.enumerateClassicBonded().catch((err) => {
        this.log("•", `Classic enumeration failed: ${err.message}`);
      });
    }

    return new Promise<void>((resolve) => {
      this.scanResolver = resolve;

      this.bleManager!.startDeviceScan(null, null, (error, device) => {
        if (error) {
          this.log("•", `BLE scan error: ${error.message}`);
          this.setStatus("error", error.message);
          this.stopScan();
          return;
        }
        if (!device) return;
        this.ingestBleDevice(device);
      });

      setTimeout(() => this.stopScan(), durationMs);
    });
  }

  private ingestBleDevice(device: {
    id: string;
    name: string | null;
    localName?: string | null;
    rssi: number | null;
    serviceUUIDs?: string[] | null;
  }): void {
    const rawName = device.name;
    const rawLocal = device.localName;
    const rawRssi = device.rssi;
    const rawSvc = device.serviceUUIDs;
    const prevCount = this.sightings.get(device.id)?.count ?? 0;
    console.log(
      `[obd2 scan] RAW id=${device.id} name=${JSON.stringify(rawName)} ` +
        `localName=${JSON.stringify(rawLocal)} rssi=${rawRssi} ` +
        `serviceUUIDs=${JSON.stringify(rawSvc)} priorSightings=${prevCount}`,
    );

    const name = device.name || device.localName;
    if (!name || name.trim().length === 0) {
      console.log(`[obd2 scan] DROP id=${device.id} reason=no_name`);
      return;
    }
    if (device.rssi != null && device.rssi < MIN_RSSI) {
      console.log(
        `[obd2 scan] DROP id=${device.id} name=${JSON.stringify(name)} ` +
          `reason=weak_rssi rssi=${device.rssi} threshold=${MIN_RSSI}`,
      );
      return;
    }

    const id = device.id;
    const isObd =
      looksLikeObdAdapter(name) || hasObdServiceUUID(device.serviceUUIDs);
    const entry: DiscoveredDevice = {
      id,
      name,
      rssi: device.rssi ?? null,
      likelyObd: isObd,
      transport: "ble",
    };
    const prev = this.sightings.get(id);
    const count = (prev?.count ?? 0) + 1;
    if (
      prev &&
      prev.device.rssi != null &&
      entry.rssi != null &&
      prev.device.rssi > entry.rssi
    ) {
      entry.rssi = prev.device.rssi;
    }
    this.sightings.set(id, { device: entry, count });
    console.log(
      `[obd2 scan] ACCEPT id=${id} name=${JSON.stringify(name)} ` +
        `rssi=${entry.rssi} count=${count} likelyObd=${isObd} transport=ble`,
    );
    this.recomputeVisible();
  }

  private async enumerateClassicBonded(): Promise<void> {
    let bonded: BluetoothDevice[] = [];
    try {
      bonded = await RNBluetoothClassic.getBondedDevices();
    } catch (err) {
      // Library not initialized or BT off — already logged by the caller's catch.
      return;
    }
    let added = 0;
    for (const dev of bonded) {
      const name = dev.name ?? "";
      // Classic enumeration includes EVERY paired device (headphones, car
      // stereos, etc.). Filter to OBD-shaped names only.
      if (!looksLikeObdAdapter(name)) continue;
      const entry: DiscoveredDevice = {
        id: dev.address,
        name,
        rssi: null,
        likelyObd: true,
        transport: "classic",
      };
      // Bonded devices are real; skip the sighting-count filter by
      // initializing to MIN_SIGHTINGS so they pass recomputeVisible().
      this.sightings.set(entry.id, { device: entry, count: MIN_SIGHTINGS });
      this.log("•", `Classic bonded: ${name} (${dev.address})`);
      added++;
    }
    if (added > 0) this.recomputeVisible();
    console.log(`[obd2 scan] Classic bonded: added ${added} likely-OBD devices`);
  }

  private recomputeVisible(): void {
    const allSightings = Array.from(this.sightings.values());
    const droppedBySightings = allSightings.filter(
      (s) => s.count < MIN_SIGHTINGS,
    );
    const visible = allSightings
      .filter((s) => s.count >= MIN_SIGHTINGS)
      .map((s) => s.device)
      .sort((a, b) => {
        if (a.likelyObd !== b.likelyObd) return a.likelyObd ? -1 : 1;
        const ar = a.rssi ?? -100;
        const br = b.rssi ?? -100;
        return br - ar;
      })
      .slice(0, MAX_RESULTS);

    if (droppedBySightings.length > 0) {
      console.log(
        `[obd2 scan] DROP-sightings (${droppedBySightings.length}):`,
        droppedBySightings.map(
          (s) =>
            `${JSON.stringify(s.device.name)} (count=${s.count}, threshold=${MIN_SIGHTINGS})`,
        ),
      );
    }
    console.log(
      `[obd2 scan] VISIBLE (${visible.length}/${allSightings.length}):`,
      visible.map(
        (d) =>
          `${JSON.stringify(d.name)} transport=${d.transport} rssi=${d.rssi} obd=${d.likelyObd}`,
      ),
    );

    this.discovered.clear();
    for (const d of visible) this.discovered.set(d.id, d);
    this.deviceListeners.forEach((cb) => cb(visible));
  }

  stopScan(): void {
    if (this.bleManager) this.bleManager.stopDeviceScan();
    if (this.status === "scanning") {
      this.setStatus("idle");
      this.log("•", "Scan stopped");
    }
    if (this.scanResolver) {
      const resolve = this.scanResolver;
      this.scanResolver = null;
      resolve();
    }
  }

  // ---------- Connect ----------

  async connect(deviceId: string): Promise<{ ok: boolean; message: string }> {
    this.stopScan();
    const known = this.discovered.get(deviceId);
    if (!known) {
      return {
        ok: false,
        message: "Device no longer in scan results. Tap Scan Again.",
      };
    }

    this.setStatus("connecting", `Connecting via ${known.transport}…`);
    this.log("•", `Connecting to ${known.name} (${known.transport})`);

    if (known.transport === "classic") {
      if (Platform.OS !== "android") {
        return {
          ok: false,
          message: "Classic Bluetooth isn't supported on this platform.",
        };
      }
      this.transport = new ClassicTransport(this.log);
    } else {
      if (!this.bleManager) {
        return { ok: false, message: "Bluetooth not available." };
      }
      this.transport = new BleTransport(this.bleManager, this.log);
    }

    const onDisconnected = () => {
      this.log("•", "Device disconnected");
      this.teardownAfterDisconnect();
    };

    const result = await this.transport.connect(deviceId, onDisconnected);
    if (!result.ok) {
      this.transport = null;
      this.setStatus("error", result.message);
      return result;
    }

    this.setStatus("handshaking", "Handshaking with adapter…");
    const handshakeFailure = await this.runHandshake();
    if (handshakeFailure) {
      await this.disconnect();
      return { ok: false, message: handshakeFailure };
    }

    this.setStatus("connected", "Connected");
    // Remember this adapter so the next session can auto-reconnect without
    // making the user re-scan. Replaces any previously saved adapter.
    saveAdapter({
      deviceId,
      name: known.name,
      transport: known.transport,
    }).catch(() => {});
    return { ok: true, message: "Connected" };
  }

  // Auto-reconnect path: connect to a previously-saved adapter without going
  // through the device picker / BLE scan. Uses the saved deviceId directly,
  // which works for Classic (paired devices are always addressable) and for
  // BLE on iOS/Android via the underlying retrievePeripherals call. If the
  // adapter isn't reachable (powered off, out of range, unpaired), the
  // transport's connect() resolves with ok=false and the caller falls back
  // to the manual picker.
  async connectDirect(
    saved: SavedAdapter,
  ): Promise<{ ok: boolean; message: string }> {
    this.stopScan();
    this.init();

    const perm = await this.ensurePermissions();
    if (!perm.ok) {
      this.setStatus("error", perm.reason || "Permission denied.");
      return { ok: false, message: perm.reason || "Permission denied." };
    }

    this.setStatus(
      "connecting",
      `Connecting to ${saved.name}…`,
    );
    this.log("•", `Auto-connecting to ${saved.name} (${saved.transport})`);

    if (saved.transport === "classic") {
      if (Platform.OS !== "android") {
        const msg = "Classic Bluetooth isn't supported on this platform.";
        this.setStatus("idle", "");
        return { ok: false, message: msg };
      }
      this.transport = new ClassicTransport(this.log);
    } else {
      if (!this.bleManager) {
        const msg = "Bluetooth not available.";
        this.setStatus("idle", "");
        return { ok: false, message: msg };
      }
      this.transport = new BleTransport(this.bleManager, this.log);
    }

    const onDisconnected = () => {
      this.log("•", "Device disconnected");
      this.teardownAfterDisconnect();
    };

    const result = await this.transport.connect(saved.deviceId, onDisconnected);
    if (!result.ok) {
      this.transport = null;
      // Reset to idle (not "error") so the screen can show its own friendly
      // fallback prompt rather than the raw transport error.
      this.setStatus("idle", "");
      return result;
    }

    this.setStatus("handshaking", "Handshaking with adapter…");
    const handshakeFailure = await this.runHandshake();
    if (handshakeFailure) {
      await this.disconnect();
      return { ok: false, message: handshakeFailure };
    }

    this.setStatus("connected", "Connected");
    // Refresh the timestamp so the most-recently-used adapter stays accurate.
    saveAdapter({
      deviceId: saved.deviceId,
      name: saved.name,
      transport: saved.transport,
    }).catch(() => {});
    return { ok: true, message: "Connected" };
  }

  async loadSavedAdapter(): Promise<SavedAdapter | null> {
    return loadSavedAdapter();
  }

  async forgetSavedAdapter(): Promise<void> {
    return clearSavedAdapter();
  }

  // Returns null on success, or a user-facing failure message on failure.
  // Every command's raw response is logged to the Metro console so we can
  // diagnose adapter-specific quirks (STN vs ELM banners, unusual prompts,
  // protocol-search behavior).
  private async runHandshake(): Promise<string | null> {
    console.log(`[obd2 handshake] === starting ===`);

    // ATZ: full adapter reset. The MX+ STN chipset can take ~2-3 s to come
    // back with its boot banner ("STN2120 v5.5.2", "OBDLink MX+…"), so we
    // give it 5 s. Banner content varies by chip — we DON'T validate its
    // text; the real gate is the 0100 response below.
    console.log(`[obd2 handshake] → ATZ (timeout 5000)`);
    const reset = await this.sendCommand("ATZ", 5000);
    console.log(`[obd2 handshake] ATZ response: ${JSON.stringify(reset)}`);
    if (!reset) {
      return "Adapter didn't respond to reset. It may be powered down or another app is holding the connection. Power-cycle the adapter and try again.";
    }

    // ATE0 / ATL0 / ATH1 / ATSP0 — straightforward config commands.
    // 5 s timeout each (was 1.5 s) because the MX+ on a fresh connection
    // sometimes batches responses.
    console.log(`[obd2 handshake] → ATE0 (timeout 5000)`);
    const ate0 = await this.sendCommand("ATE0", 5000);
    console.log(`[obd2 handshake] ATE0 response: ${JSON.stringify(ate0)}`);

    console.log(`[obd2 handshake] → ATL0 (timeout 5000)`);
    const atl0 = await this.sendCommand("ATL0", 5000);
    console.log(`[obd2 handshake] ATL0 response: ${JSON.stringify(atl0)}`);

    console.log(`[obd2 handshake] → ATH1 (timeout 5000)`);
    const ath1 = await this.sendCommand("ATH1", 5000);
    console.log(`[obd2 handshake] ATH1 response: ${JSON.stringify(ath1)}`);

    console.log(`[obd2 handshake] → ATSP0 (timeout 5000)`);
    const atsp0 = await this.sendCommand("ATSP0", 5000);
    console.log(`[obd2 handshake] ATSP0 response: ${JSON.stringify(atsp0)}`);

    // 0100 is the real sanity check — supported PIDs in mode 01. The first
    // 0100 after ATSP0 triggers protocol auto-detection ("SEARCHING…"),
    // which can take up to 8-10 s on some vehicles, so give it 10 s.
    console.log(
      `[obd2 handshake] → 0100 (timeout 10000, may trigger protocol search)`,
    );
    const pids = await this.sendCommand("0100", 10000);
    console.log(`[obd2 handshake] 0100 response: ${JSON.stringify(pids)}`);

    if (!pids) {
      return "Adapter connected but didn't respond to OBD2 query. Check that the key is in Run (not just Accessory).";
    }
    if (/UNABLE\s*TO\s*CONNECT/i.test(pids)) {
      return "Adapter is online but can't reach the vehicle's ECU. Make sure the key is in Run, not just Accessory.";
    }
    if (/NO\s*DATA/i.test(pids)) {
      return "Adapter reached the ECU but the vehicle returned no data. Try cycling the key and retrying.";
    }
    if (/41\s*00/.test(pids)) {
      console.log(`[obd2 handshake] === PASS ===`);
      return null;
    }

    console.log(
      `[obd2 handshake] === FAIL: 0100 didn't return "41 00", got ${JSON.stringify(pids)} ===`,
    );
    return `Adapter connected but the OBD2 sanity check returned an unexpected response: "${pids}". The adapter may not be ELM327-compatible.`;
  }

  // ---------- Low-level command (delegates to active transport) ----------

  private async sendCommand(
    cmd: string,
    timeoutMs = 3000,
  ): Promise<string | null> {
    if (!this.transport) return null;
    return this.transport.sendCommand(cmd, timeoutMs);
  }

  // ---------- VIN retrieval (Mode 09 PID 02) ----------

  // Mode 09 PID 02 returns the vehicle's 17-character VIN. The response
  // arrives as multiple CAN frames; with our handshake settings (ATH1,
  // default ATCAF1) the ELM327 collapses the frames into ASCII text with
  // optional headers/line prefixes. We parse defensively:
  //   1. Tokenize on whitespace, keep only 2-char hex bytes (drops the
  //      CAN ID `7E8`, line-index prefixes like `0:`, the total-length
  //      indicator `014`).
  //   2. Find the `49 02` response header.
  //   3. Skip the count byte that follows (usually `01`).
  //   4. Walk the remaining bytes and keep only those that decode to a
  //      valid VIN character (uppercase, no I/O/Q, digits 0-9). This
  //      naturally filters out any ISO-TP sequence markers (`21`, `22`)
  //      that some adapters leave in the stream.
  //   5. Stop at 17 valid chars.
  //
  // Returns null if the vehicle / adapter doesn't support Mode 09 PID 02
  // (most pre-2008 vehicles don't), the response is malformed, or we
  // couldn't extract 17 valid chars. Callers fall back to manual entry.
  async getVin(): Promise<string | null> {
    if (!this.isConnected()) return null;
    const raw = await this.sendCommand("0902", 5000);
    if (!raw) return null;
    if (/NO\s*DATA|UNABLE\s*TO\s*CONNECT|ERROR|STOPPED|\?/i.test(raw)) {
      this.log("•", "VIN request: vehicle doesn't expose VIN via OBD2");
      return null;
    }
    return parseVinFromResponse(raw);
  }

  // ---------- DTC scan / clear / freeze frame ----------

  async scanDtcs(): Promise<{
    dtcs: string[];
    pending: string[];
    freezeFrame: FreezeFrame | null;
  }> {
    if (!this.isConnected()) {
      return { dtcs: [], pending: [], freezeFrame: null };
    }
    const mode03 = (await this.sendCommand("03", 3500)) ?? "";
    const dtcs = this.parseDtcResponse(mode03, "43");

    const mode07 = (await this.sendCommand("07", 3500)) ?? "";
    const pending = this.parseDtcResponse(mode07, "47");

    const freezeDtc = (await this.sendCommand("0202", 3000)) ?? "";
    const freezeDtcParsed = this.parseDtcResponse(freezeDtc, "42")[0] ?? null;

    const freezeRpm = await this.queryMode02(0x0c);
    const freezeSpeed = await this.queryMode02(0x0d);
    const freezeCoolant = await this.queryMode02(0x05);
    const freezeFp = await this.queryMode02(0x0a);

    const freezeFrame: FreezeFrame = {
      dtc: freezeDtcParsed,
      rpm: freezeRpm ? decodeRpm(freezeRpm) : null,
      speedKph: freezeSpeed ? decodeSpeed(freezeSpeed) : null,
      coolantC: freezeCoolant ? decodeTempC(freezeCoolant) : null,
      fuelPressure: freezeFp ? (freezeFp[0] ?? 0) * 3 : null,
    };

    return { dtcs, pending, freezeFrame };
  }

  async clearDtcs(): Promise<{ ok: boolean; message: string }> {
    if (!this.isConnected()) {
      return { ok: false, message: "Not connected." };
    }
    const res = (await this.sendCommand("04", 3500)) ?? "";
    if (/44/.test(res)) {
      return { ok: true, message: "Codes cleared." };
    }
    return { ok: false, message: "Adapter did not confirm the clear." };
  }

  private parseDtcResponse(response: string, modeEcho: string): string[] {
    const bytes = response
      .replace(/^[^A-F0-9]+/i, "")
      .split(/\s+/)
      .filter((s) => /^[0-9A-F]{2}$/i.test(s))
      .map((s) => parseInt(s, 16));

    const out: string[] = [];
    for (let i = 0; i < bytes.length - 1; i++) {
      if (bytes[i] === parseInt(modeEcho, 16) && i + 2 < bytes.length) {
        let j = i + 1;
        while (j + 1 < bytes.length) {
          const code = decodeDtcBytes(bytes[j], bytes[j + 1]);
          if (!code) break;
          out.push(code);
          j += 2;
        }
        i = j;
      }
    }
    return Array.from(new Set(out));
  }

  private async queryMode02(pid: number): Promise<number[] | null> {
    const hex = pid.toString(16).padStart(2, "0").toUpperCase();
    const res = (await this.sendCommand(`02${hex}00`, 2500)) ?? "";
    return this.extractDataBytes(res, 0x42, pid);
  }

  // ---------- Live data polling ----------

  startPolling(intervalMs = 250): void {
    if (this.pollTimer) return;
    this.pollPaused = false;
    let i = 0;
    const sequence: Array<() => Promise<void>> = [
      () => this.pollPid(0x0c, decodeRpm, "rpm"),
      () => this.pollPid(0x0d, decodeSpeed, "speedKph"),
      () => this.pollPid(0x05, decodeTempC, "coolantC"),
      () => this.pollPid(0x0f, decodeTempC, "intakeAirC"),
      () => this.pollPid(0x10, decodeMaf, "mafGps"),
      () => this.pollPid(0x11, decodePercent, "throttlePct"),
      () => this.pollPid(0x06, decodeFuelTrim, "shortFuelTrimPct"),
      () => this.pollPid(0x07, decodeFuelTrim, "longFuelTrimPct"),
      () => this.pollPid(0x42, decodeVoltage, "batteryV"),
    ];

    const tick = async () => {
      if (!this.isConnected()) {
        this.stopPolling();
        return;
      }
      if (!this.pollPaused) {
        await sequence[i % sequence.length]();
        i++;
      }
      this.pollTimer = setTimeout(tick, intervalMs);
    };

    this.pollTimer = setTimeout(tick, intervalMs);
  }

  stopPolling(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }
  pausePolling(): void {
    this.pollPaused = true;
  }
  resumePolling(): void {
    this.pollPaused = false;
  }
  isPolling(): boolean {
    return this.pollTimer !== null;
  }
  isPaused(): boolean {
    return this.pollPaused;
  }

  private async pollPid<K extends keyof LiveData>(
    pid: number,
    decode: (bytes: number[]) => number | null,
    field: K,
  ): Promise<void> {
    const hex = pid.toString(16).padStart(2, "0").toUpperCase();
    const res = (await this.sendCommand(`01${hex}`, 1500)) ?? "";
    const bytes = this.extractDataBytes(res, 0x41, pid);
    if (!bytes) return;
    const value = decode(bytes);
    if (value == null) return;
    this.liveData = {
      ...this.liveData,
      [field]: value,
      updatedAt: Date.now(),
    } as LiveData;
    this.liveListeners.forEach((cb) => cb(this.liveData));
  }

  private extractDataBytes(
    response: string,
    modeEcho: number,
    pid: number,
  ): number[] | null {
    const bytes = response
      .split(/\s+/)
      .filter((s) => /^[0-9A-F]{2}$/i.test(s))
      .map((s) => parseInt(s, 16));
    for (let i = 0; i < bytes.length - 1; i++) {
      if (bytes[i] === modeEcho && bytes[i + 1] === pid) {
        return bytes.slice(i + 2);
      }
    }
    return null;
  }

  // ---------- Disconnect ----------

  async disconnect(): Promise<void> {
    this.stopPolling();
    if (this.transport) {
      try {
        await this.transport.disconnect();
      } catch {
        // best-effort
      }
      this.transport = null;
    }
    this.teardownAfterDisconnect();
  }

  private teardownAfterDisconnect() {
    this.stopPolling();
    if (this.transport) {
      this.transport.disconnect().catch(() => {});
      this.transport = null;
    }
    this.liveData = { ...EMPTY_LIVE };
    this.liveListeners.forEach((cb) => cb(this.liveData));
    this.setStatus("idle", "");
  }
}

export const obd2 = new Obd2Manager();
