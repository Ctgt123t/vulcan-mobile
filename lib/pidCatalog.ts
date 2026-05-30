import AsyncStorage from "@react-native-async-storage/async-storage";
import { signalKeyOf, type PidDescriptor } from "./obd2";

// ----------------------------------------------------------------------------
// PID catalog — bridges the server's /api/pids/<make>/<model>/<year>
// response, the mode 01 support bitmask reported by the live ECU, and the
// technician's per-vehicle preferences (selected signal IDs, saved
// presets, known-unsupported signal IDs).
//
// Storage keys (v3 — bumped from v2's plain-id selection):
//   vulcan:pids:catalog:<vk>          — full OBDb catalog cache (snapshot)
//   vulcan:pids:bitmask:<vk>          — ECU mode-01 support bitmask
//   vulcan:pids:selected:v3:<vk>      — array of selected signalKeys
//   vulcan:pids:unsupported:v3:<vk>   — array of signalKeys that didn't
//                                       respond after N poll attempts
//   vulcan:pids:presets:v3            — cross-vehicle saved selections
//
// v1 → v2: was code-keyed ("01 01"). Code collisions across signals
// sharing a command response (MIL + DTC_CNT + readiness bits) made
// selection ambiguous.
// v2 → v3: was id-keyed ("RPM", "SHRTFT11"). Five OBDb ids collide
// across commands in the SAE J1979 standard alone (SHRTFT11 at 01 14
// AND 01 15; O2S{N}_EXISTS at 01 13 AND 01 1D). v3 uses signalKey =
// `${code}@${id}` which IS globally unique. annotateCommandWidths()
// also runs a dev-time assertion that warns if any signalKey
// collides — catches the same class of bug at data-load time rather
// than as a downstream React render error.
//
// vehicleKey = `${make}|${model}|${year}` lower-cased.
// ----------------------------------------------------------------------------

const BASE_URL = (process.env.EXPO_PUBLIC_API_BASE_URL ?? "").replace(
  /\/+$/,
  "",
);

export interface PidCatalogResponse {
  make: string;
  model: string;
  year: number | null;
  source: string;
  license: string;
  standardCount: number;
  vehicleCount: number;
  categories: string[];
  signals: PidDescriptor[];
}

export interface PidPreset {
  id: string;
  name: string;
  signalKeys: string[]; // composite keys (`${code}@${id}`)
  createdAt: number;
}

function vehicleKey(make: string, model: string, year: string | number): string {
  return [String(make), String(model), String(year)].map((s) => s.trim().toLowerCase()).join("|");
}

// ---------- Server fetch ----------

export async function fetchPidCatalog(
  make: string,
  model: string,
  year: string | number,
): Promise<PidCatalogResponse | null> {
  if (!BASE_URL || !make || !model || !year) return null;
  const url = `${BASE_URL}/api/pids/${encodeURIComponent(make)}/${encodeURIComponent(model)}/${encodeURIComponent(String(year))}`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { "ngrok-skip-browser-warning": "true" },
    });
    if (!res.ok) return null;
    return (await res.json()) as PidCatalogResponse;
  } catch {
    return null;
  }
}

// ---------- Per-vehicle persistence (catalog) ----------

export async function loadCachedCatalog(
  make: string,
  model: string,
  year: string | number,
): Promise<PidCatalogResponse | null> {
  try {
    const raw = await AsyncStorage.getItem(
      `vulcan:pids:catalog:${vehicleKey(make, model, year)}`,
    );
    if (!raw) return null;
    return JSON.parse(raw) as PidCatalogResponse;
  } catch {
    return null;
  }
}

export async function saveCatalog(
  catalog: PidCatalogResponse,
): Promise<void> {
  if (!catalog.year) return;
  try {
    await AsyncStorage.setItem(
      `vulcan:pids:catalog:${vehicleKey(catalog.make, catalog.model, catalog.year)}`,
      JSON.stringify(catalog),
    );
  } catch (err) {
    console.warn("[pidCatalog] saveCatalog failed:", err);
  }
}

// ---------- Per-vehicle persistence (bitmask, selected, unsupported) ----------

export async function loadCachedBitmask(
  make: string,
  model: string,
  year: string | number,
): Promise<Set<number> | null> {
  try {
    const raw = await AsyncStorage.getItem(
      `vulcan:pids:bitmask:${vehicleKey(make, model, year)}`,
    );
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return new Set(parsed.filter((n) => typeof n === "number"));
  } catch {
    return null;
  }
}

export async function saveCachedBitmask(
  make: string,
  model: string,
  year: string | number,
  supported: Set<number>,
): Promise<void> {
  try {
    await AsyncStorage.setItem(
      `vulcan:pids:bitmask:${vehicleKey(make, model, year)}`,
      JSON.stringify(Array.from(supported).sort((a, b) => a - b)),
    );
  } catch (err) {
    console.warn("[pidCatalog] saveCachedBitmask failed:", err);
  }
}

export async function loadSelectedKeys(
  make: string,
  model: string,
  year: string | number,
): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(
      `vulcan:pids:selected:v3:${vehicleKey(make, model, year)}`,
    );
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s) => typeof s === "string") : [];
  } catch {
    return [];
  }
}

export async function saveSelectedKeys(
  make: string,
  model: string,
  year: string | number,
  keys: string[],
): Promise<void> {
  try {
    await AsyncStorage.setItem(
      `vulcan:pids:selected:v3:${vehicleKey(make, model, year)}`,
      JSON.stringify(keys),
    );
  } catch (err) {
    console.warn("[pidCatalog] saveSelectedKeys failed:", err);
  }
}

export async function loadUnsupportedKeys(
  make: string,
  model: string,
  year: string | number,
): Promise<Set<string>> {
  try {
    const raw = await AsyncStorage.getItem(
      `vulcan:pids:unsupported:v3:${vehicleKey(make, model, year)}`,
    );
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((s) => typeof s === "string") : []);
  } catch {
    return new Set();
  }
}

export async function saveUnsupportedKeys(
  make: string,
  model: string,
  year: string | number,
  keys: Set<string>,
): Promise<void> {
  try {
    await AsyncStorage.setItem(
      `vulcan:pids:unsupported:v3:${vehicleKey(make, model, year)}`,
      JSON.stringify(Array.from(keys)),
    );
  } catch (err) {
    console.warn("[pidCatalog] saveUnsupportedKeys failed:", err);
  }
}

// ---------- Display-type routing ----------

// A signal is "live-monitorable" (renders as a numeric gauge) when it's a
// byte-aligned scalar reading. Bit-level signals (MIL, readiness bits)
// and enum signals (categorical) flow into the Status panel instead.
export function isLiveMonitorable(p: PidDescriptor): boolean {
  if (p.hidden) return false;
  const d = p.decode ?? {};
  if (d.enum) return false;
  if (d.length == null) return false;
  if (d.length < 8 || d.length % 8 !== 0) return false;
  return true;
}

export function isStatusSignal(p: PidDescriptor): boolean {
  if (p.hidden) return false;
  if (isLiveMonitorable(p)) return false;
  // Anything non-hidden that isn't gauge-able is a status signal.
  return true;
}

// ---------- Mode 01 bitmask intersection ----------

// Filter to only mode 01 PIDs the ECU actually supports (the bitmask is
// authoritative for mode 01). Mode 22 manufacturer PIDs have no bitmask
// equivalent; they pass through and get lazy-marked unsupported by the
// polling driver if they fail.
export function intersectWithSupport(
  signals: PidDescriptor[],
  supportedMode01: Set<number>,
): PidDescriptor[] {
  return signals.filter((p) => {
    if (p.command.mode !== "01") return true;
    const pidByte = parseInt(p.command.pid, 16);
    return supportedMode01.has(pidByte);
  });
}

// ---------- Per-command total byte width ----------
//
// Each signal needs to know how many bytes follow its command's response
// header so the multi-PID parser advances correctly even when only one
// signal at a multi-signal command was selected. We compute this once
// from the catalog (looking at ALL signals at each code) and embed it on
// each descriptor.

function computeBytesByCode(signals: PidDescriptor[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of signals) {
    if (!s.code) continue;
    const bix = s.decode?.startBit ?? 0;
    const len = s.decode?.length ?? 0;
    const bitsNeeded = bix + len;
    const bytesNeeded = Math.max(1, Math.ceil(bitsNeeded / 8));
    const prev = out.get(s.code) ?? 0;
    if (bytesNeeded > prev) out.set(s.code, bytesNeeded);
  }
  return out;
}

// Annotate every signal in the catalog with the total bytes per command
// it lives on AND its globally-unique signalKey. Called once per catalog
// hydration. Runs a dev-time assertion that warns about any
// signalKey collisions — that would mean OBDb shipped genuinely
// duplicate signals (same id + same code), which is a real data bug
// we'd want to know about immediately rather than as a downstream
// React render error.
export function annotateCommandWidths(
  signals: PidDescriptor[],
): PidDescriptor[] {
  const bytesByCode = computeBytesByCode(signals);
  const seenKeys = new Set<string>();
  const dupKeys = new Set<string>();
  const annotated = signals.map((s) => {
    if (!s.code) return s;
    const key = signalKeyOf(s);
    if (seenKeys.has(key)) dupKeys.add(key);
    else seenKeys.add(key);
    const bytes = bytesByCode.get(s.code);
    return {
      ...s,
      signalKey: key,
      ...(bytes != null ? { commandTotalBytes: bytes } : {}),
    };
  });
  if (dupKeys.size > 0) {
    console.warn(
      `[pidCatalog] catalog has ${dupKeys.size} duplicate signalKey(s) — ` +
        "downstream React keys may collide. This indicates a true data bug " +
        "(same id at same code in OBDb). Duplicates: " +
        Array.from(dupKeys).slice(0, 10).join(", "),
    );
  }
  return annotated;
}

// ---------- Presets ----------

const PRESETS_KEY = "vulcan:pids:presets:v3";

export async function loadPresets(): Promise<PidPreset[]> {
  try {
    const raw = await AsyncStorage.getItem(PRESETS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p) =>
        p &&
        typeof p.id === "string" &&
        typeof p.name === "string" &&
        Array.isArray(p.signalKeys),
    );
  } catch {
    return [];
  }
}

export async function savePresets(presets: PidPreset[]): Promise<void> {
  try {
    await AsyncStorage.setItem(PRESETS_KEY, JSON.stringify(presets));
  } catch (err) {
    console.warn("[pidCatalog] savePresets failed:", err);
  }
}

export async function createPreset(
  name: string,
  signalKeys: string[],
): Promise<PidPreset> {
  const preset: PidPreset = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    signalKeys,
    createdAt: Date.now(),
  };
  const all = await loadPresets();
  all.push(preset);
  await savePresets(all);
  return preset;
}

export async function deletePreset(id: string): Promise<void> {
  const all = await loadPresets();
  await savePresets(all.filter((p) => p.id !== id));
}

// ---------- Convenience: build the descriptors to poll ----------

// Given the catalog, the user's selected signalKeys, and the unsupported
// set, return the PidDescriptor[] to hand to obd2.startPolling().
// Annotates each descriptor with commandTotalBytes + signalKey so the
// polling parser advances correctly past multi-signal commands and
// React keys stay unique.
export function buildSelectedDescriptors(
  catalog: PidCatalogResponse | null,
  selectedKeys: string[],
  unsupportedKeys: Set<string>,
  aiSelectedKeys?: Set<string>,
): PidDescriptor[] {
  if (!catalog) return [];
  const annotated = annotateCommandWidths(catalog.signals);
  const byKey = new Map<string, PidDescriptor>();
  for (const s of annotated) {
    if (s.signalKey) byKey.set(s.signalKey, s);
  }
  const out: PidDescriptor[] = [];
  for (const key of selectedKeys) {
    const sig = byKey.get(key);
    if (!sig) continue;
    if (unsupportedKeys.has(key)) continue;
    if (aiSelectedKeys?.has(key)) {
      out.push({ ...sig, aiSelected: true });
    } else {
      out.push(sig);
    }
  }
  return out;
}

// Convenience: resolve a list of bare signal IDs (e.g. the
// DEFAULT_PID_IDS starter set) to their signalKeys in the current
// catalog. Picks the first matching signal when an id is ambiguous.
export function resolveIdsToKeys(
  catalog: PidCatalogResponse | null,
  ids: string[],
): string[] {
  if (!catalog) return [];
  const annotated = annotateCommandWidths(catalog.signals);
  const firstByIdLower = new Map<string, string>();
  for (const s of annotated) {
    if (!s.id || !s.signalKey) continue;
    const key = s.id.toLowerCase();
    if (!firstByIdLower.has(key)) firstByIdLower.set(key, s.signalKey);
  }
  return ids
    .map((id) => firstByIdLower.get(id.toLowerCase()))
    .filter((k): k is string => Boolean(k));
}
