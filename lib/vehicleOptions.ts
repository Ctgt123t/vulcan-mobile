// ============================================================================
// Data layer for the structured make/model/year pickers (#14). Fed entirely
// from self-hosted endpoints (vpic-backed) — no live-NHTSA dependency.
//
// FAIL-SOFT is the contract: every fetch returns [] on error/timeout/DB-down so
// the picker degrades to plain free-text entry and NEVER blocks intake. An 8s
// AbortController timeout means a hung request can't freeze the field.
// ============================================================================

const BASE_URL = (process.env.EXPO_PUBLIC_API_BASE_URL ?? "").replace(/\/+$/, "");
const TIMEOUT_MS = 8000;

async function getJson<T>(path: string): Promise<T | null> {
  if (!BASE_URL) return null;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: "GET",
      headers: { "ngrok-skip-browser-warning": "true" },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

// Makes: no query -> the curated common-makes list; query -> server ilike search
// over vpic.make. Always fail-soft to [].
export async function fetchMakes(query: string): Promise<string[]> {
  const q = query.trim();
  const path = q ? `/api/makes?q=${encodeURIComponent(q)}` : "/api/makes";
  const json = await getJson<{ makes?: { name?: string }[] }>(path);
  if (!json || !Array.isArray(json.makes)) return [];
  return json.makes
    .map((m) => m?.name)
    .filter((n): n is string => typeof n === "string" && n.length > 0);
}

// Models for a make (universal vpic.make_model list). Empty make -> []. The
// caller type-ahead-filters the returned list client-side.
export async function fetchModels(make: string): Promise<string[]> {
  const m = make.trim();
  if (!m) return [];
  const json = await getJson<{ models?: string[] }>(
    `/api/models?make=${encodeURIComponent(m)}`,
  );
  if (!json || !Array.isArray(json.models)) return [];
  return json.models.filter(
    (n): n is string => typeof n === "string" && n.length > 0,
  );
}

// ---- Pure helpers (unit-tested in vehicleOptions.test.ts) -------------------

// Newest-first model-year strings, 1981 (17-char VIN standardization) through
// next model year. Static + client-side — no endpoint.
export function yearOptions(now: Date = new Date()): string[] {
  const max = now.getFullYear() + 1;
  const out: string[] = [];
  for (let y = max; y >= 1981; y--) out.push(String(y));
  return out;
}

// Case-insensitive PREFIX filter; an empty query returns the list unchanged.
// Prefix (not substring) so a tech typing "fo"/"civ" gets Ford/Civic without
// scrolling past unrelated entries (FOFO, or a model that merely contains the
// letters). The trade-off: you match from the start of the name.
export function filterOptions(options: string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return options;
  return options.filter((o) => o.toLowerCase().startsWith(q));
}
