import AsyncStorage from "@react-native-async-storage/async-storage";
import type { PidDescriptor } from "./obd2";

// ----------------------------------------------------------------------------
// PID catalog — bridges the server's /api/pids/<make>/<model>/<year>
// response, the mode 01 support bitmask reported by the live ECU, and the
// technician's per-vehicle preferences (selected signal IDs, saved
// presets, known-unsupported signal IDs).
//
// Storage keys (v2 — bumped from v1's code-based selection):
//   vulcan:pids:catalog:<vk>          — full OBDb catalog cache (snapshot)
//   vulcan:pids:bitmask:<vk>          — ECU mode-01 support bitmask
//   vulcan:pids:selected:v2:<vk>      — array of selected signal IDs
//   vulcan:pids:unsupported:v2:<vk>   — array of signal IDs that didn't
//                                       respond after N poll attempts
//   vulcan:pids:presets:v2            — cross-vehicle saved selections
//
// Why v2: the v1 schema keyed everything by command code (e.g. "01 01"),
// but many SAE PIDs carry MULTIPLE signals in the same command response
// (PID 01 01 holds MIL, DTC_CNT, and 22 readiness bits). Code-keyed
// selection collapsed all of them to a single row in the UI. v2 keys by
// the OBDb signal `id` (e.g. "RPM", "MIL", "DTC_CNT"), which is unique
// within a catalog and lets us select / decode each signal independently.
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
  pidIds: string[];
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

export async function loadSelectedIds(
  make: string,
  model: string,
  year: string | number,
): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(
      `vulcan:pids:selected:v2:${vehicleKey(make, model, year)}`,
    );
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s) => typeof s === "string") : [];
  } catch {
    return [];
  }
}

export async function saveSelectedIds(
  make: string,
  model: string,
  year: string | number,
  ids: string[],
): Promise<void> {
  try {
    await AsyncStorage.setItem(
      `vulcan:pids:selected:v2:${vehicleKey(make, model, year)}`,
      JSON.stringify(ids),
    );
  } catch (err) {
    console.warn("[pidCatalog] saveSelectedIds failed:", err);
  }
}

export async function loadUnsupportedIds(
  make: string,
  model: string,
  year: string | number,
): Promise<Set<string>> {
  try {
    const raw = await AsyncStorage.getItem(
      `vulcan:pids:unsupported:v2:${vehicleKey(make, model, year)}`,
    );
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((s) => typeof s === "string") : []);
  } catch {
    return new Set();
  }
}

export async function saveUnsupportedIds(
  make: string,
  model: string,
  year: string | number,
  ids: Set<string>,
): Promise<void> {
  try {
    await AsyncStorage.setItem(
      `vulcan:pids:unsupported:v2:${vehicleKey(make, model, year)}`,
      JSON.stringify(Array.from(ids)),
    );
  } catch (err) {
    console.warn("[pidCatalog] saveUnsupportedIds failed:", err);
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
// it lives on. Called once per catalog hydration.
export function annotateCommandWidths(
  signals: PidDescriptor[],
): PidDescriptor[] {
  const bytesByCode = computeBytesByCode(signals);
  return signals.map((s) => {
    if (!s.code) return s;
    const bytes = bytesByCode.get(s.code);
    if (bytes == null) return s;
    return { ...s, commandTotalBytes: bytes };
  });
}

// ---------- Presets ----------

const PRESETS_KEY = "vulcan:pids:presets:v2";

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
        Array.isArray(p.pidIds),
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

export async function createPreset(name: string, pidIds: string[]): Promise<PidPreset> {
  const preset: PidPreset = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    pidIds,
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

// Given the catalog, the user's selected signal IDs, and the unsupported
// set, return the PidDescriptor[] to hand to obd2.startPolling().
// Annotates each descriptor with commandTotalBytes so the polling parser
// advances correctly past multi-signal commands.
export function buildSelectedDescriptors(
  catalog: PidCatalogResponse | null,
  selectedIds: string[],
  unsupportedIds: Set<string>,
  aiSelectedIds?: Set<string>,
): PidDescriptor[] {
  if (!catalog) return [];
  const annotated = annotateCommandWidths(catalog.signals);
  const byId = new Map<string, PidDescriptor>();
  for (const s of annotated) {
    if (s.id) byId.set(s.id, s);
  }
  const out: PidDescriptor[] = [];
  for (const id of selectedIds) {
    const sig = byId.get(id);
    if (!sig) continue;
    if (unsupportedIds.has(id)) continue;
    if (aiSelectedIds?.has(id)) {
      out.push({ ...sig, aiSelected: true });
    } else {
      out.push(sig);
    }
  }
  return out;
}
