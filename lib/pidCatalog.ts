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
// return the PidDescriptor[] to hand to obd2.startPolling().
export function buildSelectedDescriptors(
  catalog: PidCatalogResponse | null,
  selectedCodes: string[],
  unsupported: Set<string>,
  aiSelectedCodes?: Set<string>,
): PidDescriptor[] {
  if (!catalog) return [];
  const byCode = new Map<string, PidDescriptor>();
  for (const s of catalog.signals) {
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
