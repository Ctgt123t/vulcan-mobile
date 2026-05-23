// ============================================================================
// OBD2 / ELM327 connectivity over BLE.
//
// Singleton manager — components subscribe to status / live data / log events
// via the Obd2Context. Direct calls into this module are also fine for
// imperative operations (connect, scanDtcs, clearDtcs).
//
// Protocol notes:
//   - ELM327 adapters speak ASCII over a write+notify BLE characteristic pair.
//   - Commands are terminated with carriage return ("\r").
//   - Responses are terminated with the prompt character ">".
//   - Multi-line responses use "\r" as line separator before the prompt.
//   - Service/characteristic UUIDs vary by adapter — we discover them at
//     runtime rather than hard-coding, so unknown vendors should still work.
// ============================================================================

import {
  BleManager,
  type Characteristic,
  type Device,
  type Subscription,
} from "react-native-ble-plx";
import { PermissionsAndroid, Platform } from "react-native";

// ---------- Public types ----------

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

// ---------- Adapter-name heuristic ----------

const OBD_NAME_PATTERNS = [
  /obd/i, // covers OBD, OBDII, OBD2, OBDLink, OBDLink MX+ in one shot
  /elm/i, // ELM327 etc.
  /obdlink/i, // explicit OBDLink — redundant w/ /obd/ but documents intent
  /vlink/i, // catches IOS-Vlink as well as vLink
  /vgate/i,
  /icar/i,
  /konnwei/i,
  /carista/i,
  /viecar/i,
  /bafx/i,
  /kiwi/i, // Kiwi 3
  /lelink/i, // LELink
];

export function looksLikeObdAdapter(name: string | null | undefined): boolean {
  if (!name) return false;
  return OBD_NAME_PATTERNS.some((p) => p.test(name));
}

// Service UUIDs that OBD2 BLE adapters commonly advertise. Used to flag
// adapters whose advertised name doesn't match a known pattern (some clones
// rebrand themselves with generic BLE module names). Lowercase comparison.
const OBD_SERVICE_UUIDS = [
  "0000fff0-0000-1000-8000-00805f9b34fb", // vLink / OBDLink family
  "0000ffe0-0000-1000-8000-00805f9b34fb", // Veepeak / generic ELM327 clones
  "0000ffb0-0000-1000-8000-00805f9b34fb", // Konnwei family
  "6e400001-b5a3-f393-e0a9-e50e24dcca9e", // Nordic UART (used by some adapters)
];

function hasObdServiceUUID(uuids: string[] | null | undefined): boolean {
  if (!uuids || uuids.length === 0) return false;
  const lower = uuids.map((u) => u.toLowerCase());
  return OBD_SERVICE_UUIDS.some((target) => lower.includes(target));
}

// ---------- Discovery filtering ----------

const MIN_RSSI = -80; // anything weaker is too far away to be useful
const MIN_SIGHTINGS = 2; // suppress momentary phantom advertisements
const MAX_RESULTS = 10;

// ---------- Base64 / ASCII helpers (no Buffer dependency) ----------
// react-native-ble-plx's characteristic.value is base64-encoded. ELM327
// payloads are ASCII text ("41 0C 1A F8\r>"), so we round-trip via atob/btoa.

function asciiToB64(s: string): string {
  // RN runtimes provide global btoa for ASCII.
  return globalThis.btoa(s);
}

function b64ToAscii(b64: string): string {
  return globalThis.atob(b64);
}

// ---------- PID decoders ----------
// Each takes the data bytes from the ELM327 response (after the mode echo and
// PID echo) and returns the engineering-units value, or null if the response
// shape is wrong.

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

// ---------- DTC byte → "P0301" decoder ----------

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

// ---------- Manager ----------

class Obd2Manager {
  private bleManager: BleManager | null = null;
  private device: Device | null = null;
  private writeServiceUUID: string | null = null;
  private writeCharUUID: string | null = null;
  private notifyServiceUUID: string | null = null;
  private notifyCharUUID: string | null = null;
  private notifySub: Subscription | null = null;
  private disconnectSub: Subscription | null = null;

  private rxBuffer = "";
  private pendingResolve: ((response: string) => void) | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;

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

  private log(dir: LogLine["dir"], text: string) {
    const line: LogLine = { ts: Date.now(), dir, text };
    this.logListeners.forEach((cb) => cb(line));
  }

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

    return new Promise<void>((resolve) => {
      this.scanResolver = resolve;

      this.bleManager!.startDeviceScan(null, null, (error, device) => {
        if (error) {
          this.log("•", `Scan error: ${error.message}`);
          this.setStatus("error", error.message);
          this.stopScan();
          return;
        }
        if (!device) return;

        // Filter 1: drop anything without a name. Unnamed devices are almost
        // never OBD2 adapters and clog the picker.
        const name = device.name || device.localName;
        if (!name || name.trim().length === 0) return;

        // Filter 2: drop weak signals. If rssi is null/unknown we keep the
        // device (some adapters/platforms don't report rssi), but explicit
        // weak readings are dropped.
        if (device.rssi != null && device.rssi < MIN_RSSI) return;

        // Sighting counter — only surface devices seen ≥ MIN_SIGHTINGS times
        // to filter out momentary phantom detections.
        const id = device.id;
        const entry: DiscoveredDevice = {
          id,
          name,
          rssi: device.rssi ?? null,
          likelyObd:
            looksLikeObdAdapter(name) ||
            hasObdServiceUUID(device.serviceUUIDs),
        };
        const prev = this.sightings.get(id);
        const count = (prev?.count ?? 0) + 1;
        // Keep the strongest rssi we've seen for this device.
        if (
          prev &&
          prev.device.rssi != null &&
          entry.rssi != null &&
          prev.device.rssi > entry.rssi
        ) {
          entry.rssi = prev.device.rssi;
        }
        this.sightings.set(id, { device: entry, count });
        this.recomputeVisible();
      });

      setTimeout(() => this.stopScan(), durationMs);
    });
  }

  private recomputeVisible(): void {
    const visible = Array.from(this.sightings.values())
      .filter((s) => s.count >= MIN_SIGHTINGS)
      .map((s) => s.device)
      .sort((a, b) => {
        // Likely OBD adapters first (so a faintly-detected adapter still
        // appears even if 10+ phones are louder).
        if (a.likelyObd !== b.likelyObd) return a.likelyObd ? -1 : 1;
        // Then by RSSI, strongest first. Treat null as -100.
        const ar = a.rssi ?? -100;
        const br = b.rssi ?? -100;
        return br - ar;
      })
      .slice(0, MAX_RESULTS);

    this.discovered.clear();
    for (const d of visible) this.discovered.set(d.id, d);
    this.deviceListeners.forEach((cb) => cb(visible));
  }

  stopScan(): void {
    if (!this.bleManager) return;
    this.bleManager.stopDeviceScan();
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

  // ---------- Connect + handshake ----------

  async connect(deviceId: string): Promise<{ ok: boolean; message: string }> {
    this.init();
    if (!this.bleManager) {
      return { ok: false, message: "Bluetooth not available." };
    }
    this.stopScan();
    this.setStatus("connecting", "Connecting…");
    this.log("•", `Connecting to ${deviceId}`);

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

      // Start listening for responses.
      this.notifySub = device.monitorCharacteristicForService(
        this.notifyServiceUUID!,
        this.notifyCharUUID!,
        (err, characteristic) => this.onNotify(err, characteristic),
      );

      // Handle unexpected disconnect.
      this.disconnectSub = device.onDisconnected(() => {
        this.log("•", "Device disconnected");
        this.teardownAfterDisconnect();
      });

      this.setStatus("handshaking", "Handshaking with adapter…");
      const handshakeOk = await this.runHandshake();
      if (!handshakeOk) {
        await this.disconnect();
        return {
          ok: false,
          message:
            "This device doesn't appear to be a compatible OBD2 adapter.",
        };
      }

      this.setStatus("connected", "Connected");
      return { ok: true, message: "Connected" };
    } catch (err) {
      const msg = (err as Error).message ?? "Connection failed";
      this.log("•", `Connect failed: ${msg}`);
      this.setStatus("error", msg);
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
          `Using service ${service.uuid.slice(0, 8)}… write=${writable.uuid.slice(0, 8)}… notify=${notifiable.uuid.slice(0, 8)}…`,
        );
        return true;
      }
    }
    return false;
  }

  private async runHandshake(): Promise<boolean> {
    // ATZ: reset adapter. Some adapters take >1s to come back; allow longer.
    const reset = await this.sendCommand("ATZ", 4000);
    if (!reset) return false;
    // ATE0: turn off command echo.
    await this.sendCommand("ATE0", 1500);
    // ATL0: turn off linefeeds (just in case).
    await this.sendCommand("ATL0", 1500);
    // ATH1: enable headers (lets us parse multi-frame DTC responses).
    await this.sendCommand("ATH1", 1500);
    // ATSP0: protocol auto.
    await this.sendCommand("ATSP0", 1500);
    // Quick sanity check — supported PIDs in mode 01.
    const pids = await this.sendCommand("0100", 3000);
    return pids != null && /41\s*00/.test(pids);
  }

  // ---------- Low-level command ----------

  private async sendCommand(
    cmd: string,
    timeoutMs = 3000,
  ): Promise<string | null> {
    if (!this.device || !this.writeServiceUUID || !this.writeCharUUID) {
      return null;
    }
    this.log("→", cmd);
    this.rxBuffer = "";

    const p = new Promise<string | null>((resolve) => {
      this.pendingResolve = (text) => {
        resolve(text);
      };
      this.pendingTimer = setTimeout(() => {
        const buf = this.rxBuffer;
        this.pendingResolve = null;
        this.pendingTimer = null;
        resolve(buf || null);
      }, timeoutMs);
    });

    try {
      await this.device.writeCharacteristicWithResponseForService(
        this.writeServiceUUID,
        this.writeCharUUID,
        asciiToB64(cmd + "\r"),
      );
    } catch (err) {
      this.log("•", `Write failed: ${(err as Error).message}`);
      this.clearPending();
      return null;
    }

    return p;
  }

  private onNotify(error: unknown, characteristic: Characteristic | null) {
    if (error || !characteristic?.value) return;
    const chunk = b64ToAscii(characteristic.value);
    this.rxBuffer += chunk;
    if (this.rxBuffer.includes(">")) {
      // Response complete.
      const full = this.rxBuffer.slice(0, this.rxBuffer.indexOf(">"));
      const clean = full.replace(/\r/g, " ").replace(/\s+/g, " ").trim();
      this.log("←", clean || "(empty)");
      if (this.pendingResolve) {
        const resolve = this.pendingResolve;
        this.pendingResolve = null;
        if (this.pendingTimer) {
          clearTimeout(this.pendingTimer);
          this.pendingTimer = null;
        }
        resolve(clean);
      }
      this.rxBuffer = "";
    }
  }

  private clearPending() {
    this.pendingResolve = null;
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
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

    // Mode 02 PID 02 = the DTC that caused the freeze frame.
    const freezeDtc = (await this.sendCommand("0202", 3000)) ?? "";
    const freezeDtcParsed = this.parseDtcResponse(freezeDtc, "42")[0] ?? null;

    // Pull a few freeze frame PIDs (Mode 02 + PID + frame number 00).
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
    // Strip headers and prompt artifacts; the bytes we want come after the
    // mode echo (e.g. "43"). Some adapters return multiple ECU responses
    // with header bytes — we accept any occurrence of the mode echo and
    // collect 2-byte DTC chunks until we hit something that isn't a hex pair.
    const bytes = response
      .replace(/^[^A-F0-9]+/i, "")
      .split(/\s+/)
      .filter((s) => /^[0-9A-F]{2}$/i.test(s))
      .map((s) => parseInt(s, 16));

    const out: string[] = [];
    for (let i = 0; i < bytes.length - 1; i++) {
      if (bytes[i] === parseInt(modeEcho, 16) && i + 2 < bytes.length) {
        // Walk pairs after the mode byte.
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

  // Issue Mode 02 query for a freeze-frame PID at frame 0.
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

  // Given a raw response, extract the data bytes that follow the mode echo
  // and the PID echo. Handles headers (when ATH1 is on) by scanning for the
  // mode+PID pattern anywhere in the line.
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
    this.clearPending();
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
    }
    this.teardownAfterDisconnect();
  }

  private teardownAfterDisconnect() {
    this.device = null;
    this.writeServiceUUID = null;
    this.writeCharUUID = null;
    this.notifyServiceUUID = null;
    this.notifyCharUUID = null;
    this.rxBuffer = "";
    this.liveData = { ...EMPTY_LIVE };
    this.liveListeners.forEach((cb) => cb(this.liveData));
    this.setStatus("idle", "");
  }
}

export const obd2 = new Obd2Manager();
