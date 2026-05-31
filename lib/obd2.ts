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

// Classic Bluetooth is Android-only here — iOS requires MFi licensing for
// SPP/RFCOMM and the OBDLink MX+ / generic ELM327s aren't MFi devices.
// The library itself ships an iOS implementation that has been reported
// to crash at native init under the New Architecture. Two-part guard:
//
//   1. `import type` for the BluetoothDevice type — TypeScript erases it
//      at runtime, so it produces no JS or native module load.
//   2. Lazy `require()` for the value, only on Android. On iOS the
//      module is never loaded, the native TurboModule registration
//      never runs, and the iOS-only crash path is bypassed.
//
// Every call site below checks `RNBluetoothClassic != null` (or relies
// on the pre-existing `Platform.OS === "android"` guards) so iOS reads
// of the value are safe no-ops.
import type { BluetoothDevice } from "react-native-bluetooth-classic";

import {
  BleManager,
  type Characteristic,
  type Device,
  type Subscription,
} from "react-native-ble-plx";
import { PermissionsAndroid, Platform } from "react-native";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let RNBluetoothClassic: any = null;
if (Platform.OS === "android") {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    RNBluetoothClassic = require("react-native-bluetooth-classic").default;
  } catch (err) {
    console.warn(
      "[obd2] react-native-bluetooth-classic failed to load on Android:",
      (err as Error).message,
    );
  }
}
import {
  clearSavedAdapter,
  loadSavedAdapter,
  saveAdapter,
  type SavedAdapter,
} from "./savedAdapter";
import { DEBUG_OBD2 } from "./debug";
import {
  decodeDtcBytes,
  parseDtcResponse,
  runDtcParserSelfTest,
} from "./dtcParser";

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

// Describes a single PID the manager can poll: the OBD-II command, decode
// metadata, display labels, and a priority hint used by the polling driver.
// Built from the server's /api/pids/... response by the mobile pidCatalog.
export interface PidDecode {
  length: number | null;
  multiplier: number | null;
  divisor: number | null;
  offset: number | null;
  signed: boolean;
  startBit: number | null;
  enum?: Record<string, unknown> | null;
}

export interface PidDescriptor {
  code: string; // e.g. "01 0C" — command identifier (one or more signals may share it)
  command: { mode: string; pid: string };
  id: string; // OBDb signal id — UNIQUE-PER-COMMAND but NOT globally unique
              // (SHRTFT11 appears at both 01 14 and 01 15; O2S{N}_EXISTS
              // appears at 01 13 and 01 1D). Use `signalKey` for any
              // global identity (storage keys, React keys, polling maps).
  name: string;
  unit: string | null;
  category: string;
  min: number;
  max: number | null;
  decode: PidDecode;
  hidden?: boolean; // OBDb flags some signals as debug-only
  // Pre-computed by pidCatalog.annotateCommandWidths(): total bytes that
  // follow the `41 PID` (or `62 PID`) marker for this command. Used by the
  // multi-PID parser to know how far to advance past each PID block.
  commandTotalBytes?: number;
  // Globally unique key derived as `${code}@${id}`. Stable across reloads
  // for the same catalog. Annotated alongside commandTotalBytes; consult
  // `signalKeyOf(s)` if you need to derive it ad-hoc.
  signalKey?: string;
  // Optional caller-supplied flag (set by the AI integration). Carried into
  // the live value so the UI can render an "AI-selected" badge.
  aiSelected?: boolean;
}

// Globally unique key for a signal. OBDb ids aren't unique on their own;
// pairing with the command code yields a stable identifier we use as a
// React key, AsyncStorage key, and LiveValues map key.
export function signalKeyOf(s: { code: string; id: string }): string {
  return `${s.code}@${s.id}`;
}

// Per-PID current value snapshot. Keyed by code in the LiveValues map.
export interface LiveValue {
  value: number | null;
  name: string;
  unit: string | null;
  category: string;
  min: number;
  max: number | null;
  timestamp: number;
  aiSelected?: boolean;
}

export type LiveValues = Record<string, LiveValue>;

// Kept as a type alias so existing context wiring keeps compiling — the
// inner shape is now the keyed map.
export type LiveData = LiveValues;

// One entry in the rolling ring buffer — a full LiveValues snapshot stamped
// at the moment the poll tick completed. Used by captureSnapshot() to produce
// a 5-second averaged window for the diagnostic assessment.
export interface RingBufferEntry {
  timestamp: number;
  values: LiveValues;
}

const EMPTY_LIVE: LiveValues = {};

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

// ---------- Generic PID decoding ----------

// Tokenize a raw ELM327 response into a clean byte stream, dropping
// non-byte tokens (11-bit CAN IDs like "7E8", line-index prefixes "0:",
// total-length headers like "014").
function responseToBytes(raw: string): number[] {
  return raw
    .split(/\s+/)
    .filter((t) => /^[0-9A-F]{2}$/i.test(t))
    .map((t) => parseInt(t, 16));
}

// Find the first `<modeEcho> <pid>` marker in a response and return up to
// `expectedBytes` bytes following it. `expectedBytes` may be null if the
// caller wants everything remaining (used by mode 03/07 DTC parsing).
function extractFirstPidData(
  raw: string,
  modeEcho: number,
  pid: number,
  expectedBytes: number | null,
): number[] | null {
  const bytes = responseToBytes(raw);
  for (let i = 0; i + 1 < bytes.length; i++) {
    if (bytes[i] === modeEcho && bytes[i + 1] === pid) {
      const start = i + 2;
      const end = expectedBytes != null ? start + expectedBytes : bytes.length;
      if (end > bytes.length) return null;
      return bytes.slice(start, end);
    }
  }
  return null;
}

// Like extractFirstPidData but tolerates mode 22 PIDs (2-byte PID) — pass
// the hex string. expectedBits comes from the PidDecode `length` field;
// converted to byte count by ceil(bits/8).
function extractPidDataBytes(
  raw: string,
  responseCode: number,
  pidHex: string,
  expectedBits: number | null,
): number[] | null {
  const bytes = responseToBytes(raw);
  const pidBytes: number[] = [];
  for (let p = 0; p < pidHex.length; p += 2) {
    pidBytes.push(parseInt(pidHex.slice(p, p + 2), 16));
  }
  const bytesNeeded =
    expectedBits != null ? Math.ceil(expectedBits / 8) : null;
  for (let i = 0; i + pidBytes.length < bytes.length; i++) {
    if (bytes[i] !== responseCode) continue;
    let match = true;
    for (let p = 0; p < pidBytes.length; p++) {
      if (bytes[i + 1 + p] !== pidBytes[p]) {
        match = false;
        break;
      }
    }
    if (!match) continue;
    const start = i + 1 + pidBytes.length;
    if (bytesNeeded == null) return bytes.slice(start);
    if (start + bytesNeeded > bytes.length) return null;
    return bytes.slice(start, start + bytesNeeded);
  }
  return null;
}

// Parse a multi-PID mode 01 response and pull out each requested SIGNAL's
// value (keyed by signal id). Many SAE PIDs carry multiple signals in one
// response — e.g. `41 01 XX YY ZZ WW` packs MIL, DTC count, and a dozen
// readiness bits into 4 bytes; `41 14 V T` packs an O2 sensor voltage AND
// its associated short-term fuel trim into 2 bytes. We group requested
// signals by PID byte, find each `41 XX` marker, slice the right number of
// bytes (commandTotalBytes — pre-computed from the catalog so we advance
// correctly past unselected signals at the same command), and decode each
// selected signal using its own bit-range.
function parseMultiPidResponse(
  raw: string,
  batch: PidDescriptor[],
): Map<string, number | null> {
  // Map keyed by signalKey (code@id) — id alone collides for the 5
  // duplicate-id signals in the SAE J1979 standard.
  const result = new Map<string, number | null>();
  for (const s of batch) result.set(signalKeyOf(s), null);

  const bytes = responseToBytes(raw);

  // Group signals by mode-01 PID byte. For each PID byte, also remember
  // the total bytes the command produces (max commandTotalBytes among the
  // signals — they should all agree, but max is the safe pick).
  const signalsByPidByte = new Map<number, PidDescriptor[]>();
  const bytesByPidByte = new Map<number, number>();
  for (const s of batch) {
    const pidByte = parseInt(s.command.pid, 16);
    const arr = signalsByPidByte.get(pidByte) ?? [];
    arr.push(s);
    signalsByPidByte.set(pidByte, arr);
    const bytesForS =
      s.commandTotalBytes ??
      Math.max(
        1,
        Math.ceil(((s.decode.startBit ?? 0) + (s.decode.length ?? 8)) / 8),
      );
    const prev = bytesByPidByte.get(pidByte) ?? 0;
    if (bytesForS > prev) bytesByPidByte.set(pidByte, bytesForS);
  }

  let i = 0;
  while (i + 1 < bytes.length) {
    if (bytes[i] !== 0x41 || !signalsByPidByte.has(bytes[i + 1])) {
      i++;
      continue;
    }
    const pidByte = bytes[i + 1];
    const bytesNeeded = bytesByPidByte.get(pidByte) ?? 1;
    const dataStart = i + 2;
    if (dataStart + bytesNeeded > bytes.length) {
      i++;
      continue;
    }
    const data = bytes.slice(dataStart, dataStart + bytesNeeded);
    for (const sig of signalsByPidByte.get(pidByte)!) {
      result.set(signalKeyOf(sig), decodePidGeneric(data, sig.decode));
    }
    i = dataStart + bytesNeeded;
  }
  return result;
}

// Decode raw bytes into a numeric value using the OBDb decode metadata.
// Supports byte-aligned signals. For bit-level signals (startBit set with
// length not a multiple of 8) we mask the relevant bit range out of the
// combined integer. Returns null when the decode can't be performed.
function decodePidGeneric(
  bytes: number[],
  decode: PidDecode,
): number | null {
  if (!bytes || bytes.length === 0) return null;

  // When startBit is unspecified, the signal begins at byte 0 and is
  // ceil(length/8) bytes wide. Without this slice, a command that returns
  // multiple signals (e.g. PID 0x14 = [O2 voltage, STFT B1S1]) would fold
  // all bytes into raw before the formula is applied, producing ~115V
  // instead of ~0.45V for an O2 sensor that is byte-aligned at offset 0.
  // The bit-field path (startBit != null) is unaffected — it already
  // extracts the correct bits from the full combined raw value.
  const relevant =
    decode.startBit == null && decode.length != null
      ? bytes.slice(0, Math.ceil(decode.length / 8))
      : bytes;

  // Combine big-endian into a single integer. JS bitwise is 32-bit; for
  // signals > 32 bits we fall back to plain arithmetic.
  let raw = 0;
  for (const b of relevant) raw = raw * 256 + b;

  const totalBits = relevant.length * 8;
  let value = raw;

  // Bit-field extraction when startBit/length narrow the window.
  if (
    decode.startBit != null &&
    decode.length != null &&
    decode.length < totalBits
  ) {
    const shift = totalBits - decode.startBit - decode.length;
    if (shift < 0) return null;
    const mask = decode.length >= 32 ? -1 : (1 << decode.length) - 1;
    value = (raw >>> shift) & (mask >>> 0);
  } else if (
    decode.signed &&
    decode.length != null &&
    decode.length <= 32
  ) {
    const signBit = 1 << (decode.length - 1);
    if ((value & signBit) !== 0) value -= 1 << decode.length;
  }

  if (decode.multiplier != null) value *= decode.multiplier;
  if (decode.divisor != null) value /= decode.divisor;
  if (decode.offset != null) value += decode.offset;
  return value;
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
    // Defensive: if the platform-gated require failed (unlikely on Android,
    // impossible on iOS where we never call connect with transport=classic
    // in the first place) we surface a clean error rather than crashing
    // on `.connectToDevice` of null.
    if (!RNBluetoothClassic) {
      return {
        ok: false,
        message: "Classic Bluetooth isn't available on this platform.",
      };
    }
    let lastErrorMessage = "Unknown error";

    for (let attempt = 1; attempt <= CLASSIC_CONNECT_ATTEMPTS; attempt++) {
      if (DEBUG_OBD2) {
        console.log(
          `[obd2 classic] === connect attempt ${attempt}/${CLASSIC_CONNECT_ATTEMPTS} → ${deviceId} ===`,
        );
      }
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
        if (DEBUG_OBD2) {
          console.log(
            `[obd2 classic] calling RNBluetoothClassic.connectToDevice with ${JSON.stringify(options)}`,
          );
        }
        const device = await RNBluetoothClassic.connectToDevice(
          deviceId,
          options,
        );
        if (DEBUG_OBD2) {
          console.log(
            `[obd2 classic] socket OPEN — address=${device.address} name=${JSON.stringify(device.name)}`,
          );
        }
        this.device = device;

        this.dataSub = device.onDataReceived((event: { data?: unknown }) => {
          const data = event.data;
          if (DEBUG_OBD2) {
            const len = typeof data === "string" ? data.length : 0;
            console.log(
              `[obd2 classic] RX (${len} chars): ${JSON.stringify(data)}`,
            );
          }
          if (typeof data === "string") {
            this.cmdBuf.receive(data);
          }
        });

        this.disconnectSub = RNBluetoothClassic.onDeviceDisconnected(
          (event: { address?: string }) => {
            // Disconnect event is rare and useful for tracing — keep it
            // visible without the debug flag.
            console.log(
              `[obd2 classic] DISCONNECT event: ${JSON.stringify(event)}`,
            );
            if (event.address === deviceId) onDisconnected();
          },
        );

        // The MX+ needs a moment after socket open before it'll accept
        // commands — without this delay the first ATZ often times out.
        if (DEBUG_OBD2) {
          console.log(
            `[obd2 classic] waiting ${CLASSIC_POST_CONNECT_SETTLE_MS}ms for adapter to settle…`,
          );
        }
        await sleep(CLASSIC_POST_CONNECT_SETTLE_MS);
        if (DEBUG_OBD2) {
          console.log(`[obd2 classic] settle complete, ready for handshake`);
        }

        return { ok: true, message: "Connected" };
      } catch (err) {
        lastErrorMessage = (err as Error).message ?? "Unknown error";
        // Failure path is rare and load-bearing for diagnosis — always log.
        console.warn(
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
          if (DEBUG_OBD2) {
            console.log(
              `[obd2 classic] sleeping ${CLASSIC_CONNECT_RETRY_MS}ms before retry…`,
            );
          }
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
    if (DEBUG_OBD2) {
      console.log(`[obd2 classic] TX: ${JSON.stringify(cmd)} (timeout ${timeoutMs}ms)`);
    }
    this.log("→", cmd);
    this.cmdBuf.reset();
    const p = this.cmdBuf.awaitResponse(timeoutMs);
    try {
      await this.device.write(cmd + "\r");
    } catch (err) {
      console.warn(
        `[obd2 classic] write threw: ${(err as Error).message}`,
      );
      this.cmdBuf.reset();
      return null;
    }
    const response = await p;
    if (DEBUG_OBD2) {
      console.log(
        `[obd2 classic] response for ${JSON.stringify(cmd)}: ${JSON.stringify(response)}`,
      );
    }
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

  // Rolling ring buffer of full LiveValues snapshots, one entry per poll tick.
  // Maintained for RING_BUFFER_DURATION_MS (10s). captureSnapshot() slices the
  // last N ms out of it to produce an averaged snapshot for the diagnostic engine.
  private ringBuffer: RingBufferEntry[] = [];
  private static readonly RING_BUFFER_DURATION_MS = 10_000;

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
    if (DEBUG_OBD2) {
      const prevCount = this.sightings.get(device.id)?.count ?? 0;
      console.log(
        `[obd2 scan] RAW id=${device.id} name=${JSON.stringify(device.name)} ` +
          `localName=${JSON.stringify(device.localName)} rssi=${device.rssi} ` +
          `serviceUUIDs=${JSON.stringify(device.serviceUUIDs)} priorSightings=${prevCount}`,
      );
    }

    const name = device.name || device.localName;
    if (!name || name.trim().length === 0) {
      if (DEBUG_OBD2) {
        console.log(`[obd2 scan] DROP id=${device.id} reason=no_name`);
      }
      return;
    }
    if (device.rssi != null && device.rssi < MIN_RSSI) {
      if (DEBUG_OBD2) {
        console.log(
          `[obd2 scan] DROP id=${device.id} name=${JSON.stringify(name)} ` +
            `reason=weak_rssi rssi=${device.rssi} threshold=${MIN_RSSI}`,
        );
      }
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
    if (DEBUG_OBD2) {
      console.log(
        `[obd2 scan] ACCEPT id=${id} name=${JSON.stringify(name)} ` +
          `rssi=${entry.rssi} count=${count} likelyObd=${isObd} transport=ble`,
      );
    }
    this.recomputeVisible();
  }

  private async enumerateClassicBonded(): Promise<void> {
    if (!RNBluetoothClassic) return;
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
    if (DEBUG_OBD2) {
      console.log(`[obd2 scan] Classic bonded: added ${added} likely-OBD devices`);
    }
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

    if (DEBUG_OBD2) {
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
    }

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
    // Handshake start/finish always log — connection events are rare and
    // load-bearing for diagnosis. Per-command request/response chatter is
    // gated behind DEBUG_OBD2.
    console.log(`[obd2 handshake] === starting ===`);

    // ATZ: full adapter reset. The MX+ STN chipset can take ~2-3 s to come
    // back with its boot banner ("STN2120 v5.5.2", "OBDLink MX+…"), so we
    // give it 5 s.
    if (DEBUG_OBD2) console.log(`[obd2 handshake] → ATZ (timeout 5000)`);
    const reset = await this.sendCommand("ATZ", 5000);
    if (DEBUG_OBD2) console.log(`[obd2 handshake] ATZ response: ${JSON.stringify(reset)}`);
    if (!reset) {
      return "Adapter didn't respond to reset. It may be powered down or another app is holding the connection. Power-cycle the adapter and try again.";
    }

    // ATE0 / ATL0 / ATH1 / ATSP0 — straightforward config commands.
    if (DEBUG_OBD2) console.log(`[obd2 handshake] → ATE0 (timeout 5000)`);
    const ate0 = await this.sendCommand("ATE0", 5000);
    if (DEBUG_OBD2) console.log(`[obd2 handshake] ATE0 response: ${JSON.stringify(ate0)}`);

    if (DEBUG_OBD2) console.log(`[obd2 handshake] → ATL0 (timeout 5000)`);
    const atl0 = await this.sendCommand("ATL0", 5000);
    if (DEBUG_OBD2) console.log(`[obd2 handshake] ATL0 response: ${JSON.stringify(atl0)}`);

    if (DEBUG_OBD2) console.log(`[obd2 handshake] → ATH1 (timeout 5000)`);
    const ath1 = await this.sendCommand("ATH1", 5000);
    if (DEBUG_OBD2) console.log(`[obd2 handshake] ATH1 response: ${JSON.stringify(ath1)}`);

    if (DEBUG_OBD2) console.log(`[obd2 handshake] → ATSP0 (timeout 5000)`);
    const atsp0 = await this.sendCommand("ATSP0", 5000);
    if (DEBUG_OBD2) console.log(`[obd2 handshake] ATSP0 response: ${JSON.stringify(atsp0)}`);

    // 0100 is the real sanity check — supported PIDs in mode 01. The first
    // 0100 after ATSP0 triggers protocol auto-detection ("SEARCHING…"),
    // which can take up to 8-10 s on some vehicles, so give it 10 s.
    if (DEBUG_OBD2) {
      console.log(
        `[obd2 handshake] → 0100 (timeout 10000, may trigger protocol search)`,
      );
    }
    const pids = await this.sendCommand("0100", 10000);
    if (DEBUG_OBD2) console.log(`[obd2 handshake] 0100 response: ${JSON.stringify(pids)}`);

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

  // Mutex chain — every sendCommand() awaits the prior call's completion
  // before issuing its own. Without this, concurrent callers (e.g. the
  // selection screen's getSupportedMode01Pids() racing with the live poll
  // loop) overwrite each other's pending-resolve on the shared
  // CommandBuffer, producing scrambled responses and inconsistent results.
  private commandQueue: Promise<unknown> = Promise.resolve();

  private async sendCommand(
    cmd: string,
    timeoutMs = 3000,
  ): Promise<string | null> {
    if (!this.transport) return null;
    const transport = this.transport;
    const next = this.commandQueue.then(() => transport.sendCommand(cmd, timeoutMs));
    // Swallow any rejection in the chain so one failure doesn't poison
    // all subsequent commands. Result handed back to caller carries its
    // own resolution.
    this.commandQueue = next.catch(() => null);
    return next;
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
    permanent: string[];
    freezeFrame: FreezeFrame | null;
  }> {
    if (!this.isConnected()) {
      return { dtcs: [], pending: [], permanent: [], freezeFrame: null };
    }

    const mode03 = (await this.sendCommand("03", 3500)) ?? "";
    // Always log DTC raw responses — rare events critical for diagnosing parse
    // bugs. Verbose byte-level trace is gated behind DEBUG_OBD2.
    console.log(`[dtc scan] Mode 03 raw: "${mode03}"`);
    const dtcs = this.parseDtcResponse(mode03, "43");
    console.log(`[dtc scan] Mode 03 parsed: [${dtcs.join(", ") || "none"}]`);

    const mode07 = (await this.sendCommand("07", 3500)) ?? "";
    console.log(`[dtc scan] Mode 07 raw: "${mode07}"`);
    const pending = this.parseDtcResponse(mode07, "47");
    console.log(`[dtc scan] Mode 07 parsed: [${pending.join(", ") || "none"}]`);

    // Mode 0A — permanent / confirmed codes. These survive a clear-codes command
    // and require a completed OBD2 drive cycle to extinguish. Queried as a
    // standard part of every scan; results surfaced in the UI and snapshot.
    const mode0A = (await this.sendCommand("0A", 3500)) ?? "";
    console.log(`[dtc scan] Mode 0A raw: "${mode0A}"`);
    const permanent =
      mode0A && !/NO\s*DATA|UNABLE|STOPPED|\?/i.test(mode0A)
        ? this.parseDtcResponse(mode0A, "4A")
        : [];
    console.log(`[dtc scan] Mode 0A parsed: [${permanent.join(", ") || "none"}]`);

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

    return { dtcs, pending, permanent, freezeFrame };
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

  // DTC response parsing is in lib/dtcParser.ts (standalone pure module, tested in dtcParser.test.ts).
  // This private shim delegates so the call sites in scanDtcs() stay unchanged.
  private parseDtcResponse(response: string, modeEcho: string): string[] {
    return parseDtcResponse(response, modeEcho);
  }

    private async queryMode02(pid: number): Promise<number[] | null> {
    const hex = pid.toString(16).padStart(2, "0").toUpperCase();
    const res = (await this.sendCommand(`02${hex}00`, 2500)) ?? "";
    return this.extractDataBytes(res, 0x42, pid);
  }

  // ---------- Mode 01 PID support discovery ----------
  //
  // OBD-II Mode 01 PID 00 returns a 4-byte bitmask indicating which of the
  // next 32 PIDs (0x01-0x20) the ECU supports. PID 20 reports 0x21-0x40,
  // PID 40 reports 0x41-0x60, and so on through PID E0. We walk the chain
  // until either a PID isn't supported (high bit of the bitmask says "no
  // more groups available") or the response is missing.
  //
  // Returns a Set of supported PID numbers (e.g. 0x0C, 0x0D, …) covering
  // every mode 01 PID the vehicle's ECU will respond to. Used by
  // pidCatalog to filter the UI's "available PIDs" list down from the
  // OBDb superset to what this specific vehicle actually exposes.
  async getSupportedMode01Pids(): Promise<Set<number>> {
    const supported = new Set<number>();
    if (!this.isConnected()) return supported;

    const groupPids = [0x00, 0x20, 0x40, 0x60, 0x80, 0xa0, 0xc0, 0xe0];
    for (const base of groupPids) {
      const hex = base.toString(16).padStart(2, "0").toUpperCase();
      const res = (await this.sendCommand(`01${hex}`, 2000)) ?? "";
      const data = extractFirstPidData(res, 0x41, base, 4);
      if (!data) break;
      // 32 bits — bit (31 - i) at byte i mod 4 corresponds to PID (base + 1 + i).
      for (let i = 0; i < 32; i++) {
        const byteIdx = (i / 8) | 0;
        const bitIdx = 7 - (i % 8);
        if ((data[byteIdx] >> bitIdx) & 1) {
          supported.add(base + 1 + i);
        }
      }
      // High bit of the LAST byte of this group's bitmask indicates whether
      // the NEXT group's "supported" PID itself is supported. If not, stop.
      const nextGroupSupported = (data[3] & 0x01) === 1;
      if (!nextGroupSupported) break;
    }
    // Short summary always (fires once per session). Full PID list only
    // when DEBUG_OBD2 — useful when the support set looks wrong.
    if (DEBUG_OBD2) {
      console.log(
        `[obd2] bitmask query → ${supported.size} mode-01 PIDs supported: ` +
          Array.from(supported)
            .sort((a, b) => a - b)
            .map((n) => n.toString(16).padStart(2, "0").toUpperCase())
            .join(","),
      );
    } else {
      console.log(`[obd2] bitmask query → ${supported.size} mode-01 PIDs supported`);
    }
    return supported;
  }

  // ---------- Selected-PID live polling ----------
  //
  // Driven by the technician's selected PID list (or by the AI when it
  // injects monitoring choices). Replaces the old hard-coded round-robin.
  //
  // Mode 01 PIDs are "fast tier": batched up to 6 per request using the
  // ELM327 multi-PID syntax (`01 0C 0D 0E 11`) and parsed by walking the
  // interleaved `41 XX` response markers. Mode 22 manufacturer PIDs are
  // "slow tier": polled sequentially every Nth tick (default every 4th)
  // because they can't share a request with mode 01 and individual mode 22
  // responses are usually slower.
  //
  // PIDs that consistently fail (NO DATA, time out, or vehicle doesn't
  // support them) are added to an in-process `unsupportedPids` set and
  // skipped on future ticks. The mobile pidCatalog also persists these
  // per-vehicle so the selection UI can mark them unsupported.

  private selectedPids: PidDescriptor[] = [];
  private unsupportedPids = new Set<string>();
  private slowTierEvery = 4;
  private pollIntervalMs = 250;
  private tickIndex = 0;

  startPolling(
    pids: PidDescriptor[],
    options?: { intervalMs?: number; slowTierEvery?: number },
  ): void {
    this.selectedPids = pids;
    this.pollIntervalMs = options?.intervalMs ?? 250;
    this.slowTierEvery = options?.slowTierEvery ?? 4;
    if (this.pollTimer) return; // tick loop already running — just swap the list
    this.pollPaused = false;
    this.tickIndex = 0;
    console.log(
      `[obd2 poll] startPolling — ${pids.length} PIDs at ${this.pollIntervalMs}ms`,
    );

    const tick = async () => {
      if (!this.isConnected()) {
        // Disconnect during polling is rare and worth logging once.
        console.log("[obd2 poll] tick: disconnected, stopping");
        this.stopPolling();
        return;
      }
      if (!this.pollPaused) {
        if (DEBUG_OBD2) {
          console.log(
            `[obd2 poll] tick #${this.tickIndex} — selectedPids=${this.selectedPids.length}`,
          );
        }
        await this.pollSelectedOnce();
        // Maintain the rolling ring buffer for the diagnostic snapshot engine.
        const nowMs = Date.now();
        this.ringBuffer.push({ timestamp: nowMs, values: this.liveData });
        const cutoff = nowMs - Obd2Manager.RING_BUFFER_DURATION_MS;
        while (this.ringBuffer.length > 0 && this.ringBuffer[0].timestamp < cutoff) {
          this.ringBuffer.shift();
        }
        this.tickIndex++;
      }
      this.pollTimer = setTimeout(tick, this.pollIntervalMs);
    };

    this.pollTimer = setTimeout(tick, this.pollIntervalMs);
  }

  // Reports the unsupported signal IDs so callers (pidCatalog) can persist
  // them and grey out PIDs in the selection UI.
  getUnsupportedPids(): Set<string> {
    return new Set(this.unsupportedPids);
  }

  setSelectedPids(pids: PidDescriptor[]): void {
    this.selectedPids = pids;
    // Selection change resets per-signal failure tracking so previously-
    // flaky entries get a fresh chance.
    this.failureCounts.clear();
  }

  // Per-signal consecutive-miss counter (keyed by signalKey since plain
  // ids collide). A signal is added to unsupportedPids only after
  // MAX_CONSECUTIVE_MISSES misses in a row — so a one-off multi-PID
  // partial response doesn't kill an entire batch.
  private failureCounts: Map<string, number> = new Map();
  private static readonly MAX_CONSECUTIVE_MISSES = 4;

  private recordMiss(key: string): void {
    const n = (this.failureCounts.get(key) ?? 0) + 1;
    this.failureCounts.set(key, n);
    if (n >= Obd2Manager.MAX_CONSECUTIVE_MISSES) {
      this.unsupportedPids.add(key);
      console.log(
        `[obd2 poll] ${key} marked unsupported after ${n} consecutive misses`,
      );
    }
  }

  private recordHit(key: string): void {
    this.failureCounts.delete(key);
  }

  private async pollSelectedOnce(): Promise<void> {
    const supported = this.selectedPids.filter(
      (p) => !this.unsupportedPids.has(signalKeyOf(p)),
    );

    // Group by command code first. Multiple selected signals may share a
    // command (e.g. MIL + DTC_CNT both live under `01 01`); they should
    // produce ONE outgoing request, not one per signal. The parser then
    // decodes each selected signal from the shared response.
    const fastByCode = new Map<string, PidDescriptor[]>();
    const slowByCode = new Map<string, PidDescriptor[]>();
    for (const p of supported) {
      const bucket = p.command.mode === "01" ? fastByCode : slowByCode;
      const arr = bucket.get(p.code) ?? [];
      arr.push(p);
      bucket.set(p.code, arr);
    }

    // Fast tier — batch up to 6 unique mode-01 PIDs per multi-PID command.
    const fastCodes = Array.from(fastByCode.keys());
    for (let i = 0; i < fastCodes.length; i += 6) {
      const codes = fastCodes.slice(i, i + 6);
      const signals = codes.flatMap((c) => fastByCode.get(c) ?? []);
      await this.pollMultiplePids(codes, signals);
    }

    // Slow tier — sequential, one command per slowTierEvery ticks.
    const slowCodes = Array.from(slowByCode.keys());
    if (slowCodes.length > 0 && this.tickIndex % this.slowTierEvery === 0) {
      const idx = Math.floor(this.tickIndex / this.slowTierEvery) % slowCodes.length;
      const code = slowCodes[idx];
      await this.pollSingleCommand(slowByCode.get(code)!);
    }
  }

  // Send a multi-PID mode 01 request and parse the interleaved response.
  // All PIDs in `batch` must be mode 01.
  //
  // Failure handling: many GM ECUs (and some other CAN implementations) only
  // answer the FIRST PID of a multi-PID request — the rest get dropped at
  // the ECU side. To avoid marking those PIDs unsupported prematurely, any
  // PID that didn't appear in the multi-PID response is RE-polled
  // individually before we count it as a miss. This is the costliest path
  // (1 multi-PID + N single-PIDs per tick) but it self-correcting and
  // results in accurate per-PID hit / miss accounting.
  // Multi-PID poll. `codes` are the unique command codes batched into one
  // request (max 6 per ELM327 spec); `signals` is every selected signal
  // that lives under any of those codes. The parser decodes each signal
  // independently from the shared command responses.
  async pollMultiplePids(
    codes: string[],
    signals: PidDescriptor[],
  ): Promise<void> {
    if (codes.length === 0 || signals.length === 0) return;
    const pidBytes = codes.map((c) => c.split(" ")[1]).join("");
    const cmd = `01${pidBytes}`;
    const res = (await this.sendCommand(cmd, 2500)) ?? "";
    const parsed = parseMultiPidResponse(res, signals);
    const now = Date.now();
    let multiHits = 0;
    const misses: PidDescriptor[] = [];
    // Immutable update — re-handing the same map reference to setLiveData
    // short-circuits React's prevState === nextState comparison and the
    // gauges never re-render even when the values are changing.
    let next: LiveValues = this.liveData;
    for (const s of signals) {
      const k = signalKeyOf(s);
      const v = parsed.get(k);

      // O2 trace for multi-PID path — same always-on logging as single path.
      const isO2 = /\bO2\b|oxygen|lambda/i.test(s.name) || /^O2S|^LAMBDAV/i.test(s.id);
      if (isO2) {
        console.log(
          `[o2 decode] signal="${s.name}" id=${s.id} cmd=${cmd} (multi-pid) ` +
            `raw_response="${res}" ` +
            `mult=${s.decode.multiplier} div=${s.decode.divisor} off=${s.decode.offset} ` +
            `startBit=${s.decode.startBit} length=${s.decode.length} → ${v ?? "miss"}`,
        );
      }

      if (v == null) {
        misses.push(s);
        continue;
      }
      this.recordHit(k);
      multiHits++;
      next = {
        ...next,
        [k]: {
          value: v,
          name: s.name,
          unit: s.unit,
          category: s.category,
          min: s.min,
          max: s.max,
          timestamp: now,
          aiSelected: s.aiSelected,
        },
      };
    }
    if (DEBUG_OBD2) {
      console.log(
        `[obd2 poll] multi cmd=${cmd} → ${multiHits}/${signals.length} hits: ` +
          signals
            .slice(0, 8)
            .map((s) => {
              const k = signalKeyOf(s);
              return `${k}=${parsed.get(k) ?? "—"}`;
            })
            .join(", ") +
          (signals.length > 8 ? `, +${signals.length - 8} more` : ""),
      );
    }
    // Commit the multi-PID hits before any single-PID fallbacks run so
    // listeners see the partial result immediately.
    if (next !== this.liveData) {
      this.liveData = next;
      this.liveListeners.forEach((cb) => cb(this.liveData));
    }

    // Fall back to single-command polling for signals that didn't show up
    // in the multi-PID response — many GM ECUs only answer the first PID
    // of a multi-PID request. Group misses by command code so we send
    // each missing command once (decoding all the signals at it that we
    // wanted in the first place).
    if (misses.length > 0 && codes.length > 1) {
      const missByCode = new Map<string, PidDescriptor[]>();
      for (const m of misses) {
        const arr = missByCode.get(m.code) ?? [];
        arr.push(m);
        missByCode.set(m.code, arr);
      }
      for (const signalsForCode of missByCode.values()) {
        await this.pollSingleCommand(signalsForCode);
      }
    } else if (misses.length > 0) {
      for (const s of misses) this.recordMiss(signalKeyOf(s));
    }
  }

  // Issue ONE command and decode every selected signal under it. Used by
  // the slow tier (mode 22 PIDs) and as the single-PID fallback path
  // when multi-PID returns partial results.
  private async pollSingleCommand(signals: PidDescriptor[]): Promise<void> {
    if (signals.length === 0) return;
    const first = signals[0];
    const cmd = `${first.command.mode}${first.command.pid}`;
    const res = (await this.sendCommand(cmd, 2500)) ?? "";
    if (/NO\s*DATA|UNABLE|STOPPED|\?|CAN\s*ERROR/i.test(res)) {
      for (const s of signals) this.recordMiss(signalKeyOf(s));
      return;
    }
    // Mode response code is mode + 0x40 (01 → 41, 22 → 62).
    const responseCode = parseInt(first.command.mode, 16) + 0x40;
    const totalBytes =
      first.commandTotalBytes ??
      Math.max(
        1,
        Math.ceil(((first.decode.startBit ?? 0) + (first.decode.length ?? 8)) / 8),
      );
    const data = extractPidDataBytes(
      res,
      responseCode,
      first.command.pid,
      totalBytes * 8,
    );
    if (data == null) {
      for (const s of signals) this.recordMiss(signalKeyOf(s));
      return;
    }
    let next: LiveValues = this.liveData;
    const logBits: string[] = [];
    for (const s of signals) {
      const k = signalKeyOf(s);
      const value = decodePidGeneric(data, s.decode);

      // O2 sensor decode trace — always logged (not just DEBUG_OBD2) because
      // >10V from a narrowband O2 is a definitive data-integrity signal that
      // should surface in every build during investigation.
      const isO2 = /\bO2\b|oxygen|lambda/i.test(s.name) || /^O2S|^LAMBDAV/i.test(s.id);
      if (isO2) {
        const dataHex = data.map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");
        console.log(
          `[o2 decode] signal="${s.name}" id=${s.id} cmd=${cmd} ` +
            `data=[${dataHex}] ` +
            `mult=${s.decode.multiplier} div=${s.decode.divisor} off=${s.decode.offset} ` +
            `signed=${s.decode.signed} startBit=${s.decode.startBit} length=${s.decode.length} ` +
            `→ ${value}`,
        );
      }

      if (value == null) {
        this.recordMiss(k);
        logBits.push(`${k}=—`);
        continue;
      }
      this.recordHit(k);
      logBits.push(`${k}=${value}`);
      next = {
        ...next,
        [k]: {
          value,
          name: s.name,
          unit: s.unit,
          category: s.category,
          min: s.min,
          max: s.max,
          timestamp: Date.now(),
          aiSelected: s.aiSelected,
        },
      };
    }
    if (DEBUG_OBD2) {
      console.log(`[obd2 poll] single cmd=${cmd} → ${logBits.join(", ")}`);
    }
    if (next !== this.liveData) {
      this.liveData = next;
      this.liveListeners.forEach((cb) => cb(this.liveData));
    }
  }

  // Returns ring buffer entries from the last `durationMs` milliseconds.
  // Used by the diagnostic snapshot builder to compute averaged signal values.
  // Returns whatever is available — callers should check getRingBufferAge()
  // first if they need a minimum data window.
  captureSnapshot(durationMs: number = 5000): RingBufferEntry[] {
    const cutoff = Date.now() - durationMs;
    return this.ringBuffer.filter((e) => e.timestamp >= cutoff);
  }

  // Returns the age (ms) of the oldest entry in the ring buffer, or 0 if empty.
  // Use this to check whether enough data has accumulated before triggering
  // an assessment (e.g. guard: getRingBufferAge() >= 3000 before proceeding).
  getRingBufferAge(): number {
    if (this.ringBuffer.length === 0) return 0;
    return Date.now() - this.ringBuffer[0].timestamp;
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
    this.ringBuffer = [];
    this.liveListeners.forEach((cb) => cb(this.liveData));
    this.setStatus("idle", "");
  }
}

// Run the DTC parser self-test on module load when debug logging is on.
// All fixtures validate before any vehicle is connected — regressions surface
// immediately in the Metro console rather than on the next real-vehicle test.
if (DEBUG_OBD2) {
  runDtcParserSelfTest();
}

export const obd2 = new Obd2Manager();
