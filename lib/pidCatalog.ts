import AsyncStorage from "@react-native-async-storage/async-storage";
import type { PidDescriptor } from "./obd2";

// ----------------------------------------------------------------------------
// PID catalog — bridges the server's /api/pids/<make>/<model>/<year>
// response, the mode 01 support bitmask reported by the live ECU, and the
// technician's per-vehicle preferences (selected PIDs, saved presets,
// known-unsupported mode 22 PIDs).
//
// All technician-specific state is per-device AsyncStorage. Per CLAUDE.md
// scalability: no backend per-user storage; the backend is stateless and
// only serves the curated PID catalog by vehicle.
//
// Storage layout:
//   vulcan:pids:catalog:<vehicleKey>   — full catalog snapshot for this
//                                         vehicle (so the selection screen
//                                         works offline once visited once)
//   vulcan:pids:selected:<vehicleKey>  — array of selected PID codes
//   vulcan:pids:unsupported:<vehicleKey> — array of PID codes the ECU
//                                         didn't respond to (lazy-marked)
//   vulcan:pids:presets                 — user-defined presets (cross-vehicle)
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
  pidCodes: string[];
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

// ---------- Per-vehicle persistence ----------

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

// Mode 01 bitmask is cached separately from the catalog so re-querying the
// bitmask (or failing to query it) doesn't shrink the persisted catalog.
// Prior version overwrote catalog cache with the intersected set, which
// produced an ever-shrinking PID list across selection-screen openings
// whenever a bitmask query partially failed.
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

export async function loadSelectedCodes(
  make: string,
  model: string,
  year: string | number,
): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(
      `vulcan:pids:selected:${vehicleKey(make, model, year)}`,
    );
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s) => typeof s === "string") : [];
  } catch {
    return [];
  }
}

export async function saveSelectedCodes(
  make: string,
  model: string,
  year: string | number,
  codes: string[],
): Promise<void> {
  try {
    await AsyncStorage.setItem(
      `vulcan:pids:selected:${vehicleKey(make, model, year)}`,
      JSON.stringify(codes),
    );
  } catch (err) {
    console.warn("[pidCatalog] saveSelectedCodes failed:", err);
  }
}

export async function loadUnsupportedCodes(
  make: string,
  model: string,
  year: string | number,
): Promise<Set<string>> {
  try {
    const raw = await AsyncStorage.getItem(
      `vulcan:pids:unsupported:${vehicleKey(make, model, year)}`,
    );
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((s) => typeof s === "string") : []);
  } catch {
    return new Set();
  }
}

export async function saveUnsupportedCodes(
  make: string,
  model: string,
  year: string | number,
  codes: Set<string>,
): Promise<void> {
  try {
    await AsyncStorage.setItem(
      `vulcan:pids:unsupported:${vehicleKey(make, model, year)}`,
      JSON.stringify(Array.from(codes)),
    );
  } catch (err) {
    console.warn("[pidCatalog] saveUnsupportedCodes failed:", err);
  }
}

// ---------- Live-monitoring filters ----------

// A signal is "live-monitorable" if we can render it as a numeric gauge
// that updates at poll cadence: whole-byte width, not packed into a bit
// field, no enum lookup, not hidden by OBDb.
export function isLiveMonitorable(p: PidDescriptor): boolean {
  if (p.hidden) return false;
  const d = p.decode ?? {};
  if (d.enum) return false;
  if (d.length == null) return false;
  if (d.length < 8 || d.length % 8 !== 0) return false;
  return true;
}

// Deduplicate by PID code so the live-data path treats one signal per
// command. Many SAE PIDs pack multiple readings into one response (e.g.
// `01 14` carries both O2 sensor voltage AND its associated short-term
// fuel trim; `01 08` carries fuel trim bank 2 AND bank 4). Until we wire
// per-signal id keying through the full polling + decode stack, expose
// only the primary signal per code in the selection UI — the one whose
// startBit is 0 / unset.
//
// Tie-breaker when multiple candidates have startBit=0/null: prefer the
// one whose name doesn't start with "SHRTFT" / "LONGFT" / "associated"
// (OBDb tags the secondary readings in fuel-trim-pair commands that way).
export function dedupeByCode(signals: PidDescriptor[]): PidDescriptor[] {
  const byCode = new Map<string, PidDescriptor>();
  for (const s of signals) {
    if (!s.code) continue;
    const existing = byCode.get(s.code);
    if (!existing) {
      byCode.set(s.code, s);
      continue;
    }
    if (signalRank(s) < signalRank(existing)) {
      byCode.set(s.code, s);
    }
  }
  return Array.from(byCode.values());
}

function signalRank(s: PidDescriptor): number {
  const bix = s.decode?.startBit;
  // Primary = startBit null or 0. Lower rank = better candidate to keep.
  let r = bix == null || bix === 0 ? 0 : 100 + bix;
  // Penalize "associated/secondary" signals so primary readings win ties.
  const name = (s.name ?? "").toLowerCase();
  if (/associated|secondary|\(bank [34]\)/.test(name)) r += 1000;
  return r;
}

// ---------- Mode 01 bitmask intersection ----------

// Filter the catalog so that mode 01 PIDs only survive if they're in the
// `supportedMode01` set reported by the ECU's PID 00/20/40 bitmasks. Mode
// 22 (manufacturer-specific) PIDs are passed through unchanged — there's
// no support bitmask for them; the unsupported set fills in over time
// from poll failures.
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

// One-stop helper: filter to live-monitorable + dedupe by code. Used by
// both the selection screen and the polling-descriptor builder so they
// agree on what's visible / selectable / pollable.
export function liveMonitorableSignals(signals: PidDescriptor[]): PidDescriptor[] {
  return dedupeByCode(signals.filter(isLiveMonitorable));
}

// ---------- Presets (cross-vehicle) ----------

const PRESETS_KEY = "vulcan:pids:presets";

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
        Array.isArray(p.pidCodes),
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

export async function createPreset(name: string, pidCodes: string[]): Promise<PidPreset> {
  const preset: PidPreset = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    pidCodes,
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

// ---------- Convenience: build the "live PIDs to poll" descriptor list ----------

// Given the catalog, the user's selected codes, and the unsupported set,
// return the PidDescriptor[] to hand to obd2.startPolling(). Goes through
// the live-monitorable filter + dedupe so the polling driver and the
// selection UI agree on what's pollable.
export function buildSelectedDescriptors(
  catalog: PidCatalogResponse | null,
  selectedCodes: string[],
  unsupported: Set<string>,
  aiSelectedCodes?: Set<string>,
): PidDescriptor[] {
  if (!catalog) return [];
  const monitorable = liveMonitorableSignals(catalog.signals);
  const byCode = new Map<string, PidDescriptor>();
  for (const s of monitorable) {
    if (s.code) byCode.set(s.code, s);
  }
  const out: PidDescriptor[] = [];
  for (const code of selectedCodes) {
    const sig = byCode.get(code);
    if (!sig) continue;
    if (unsupported.has(code)) continue;
    if (aiSelectedCodes?.has(code)) {
      out.push({ ...sig, aiSelected: true });
    } else {
      out.push(sig);
    }
  }
  return out;
}
