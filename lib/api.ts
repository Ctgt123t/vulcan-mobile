import type {
  AssistantTurn,
  ChatMessage,
  DiagnoseResponse,
  DtcDefinition,
  Recall,
  Tsb,
  VehicleInfo,
} from "./types";
import type { ApiCostData, DiagnosticAssessment, DiagnosticSnapshot } from "./assessmentTypes";

const BASE_URL = (process.env.EXPO_PUBLIC_API_BASE_URL ?? "").replace(
  /\/+$/,
  "",
);

// Cap the conversation length we send to Claude. The first message carries the
// vehicle context built server-side, so we always keep it; the trailing window
// must start with an assistant turn to preserve user/assistant alternation.
const HISTORY_LIMIT = 20;

function truncateForApi(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length <= HISTORY_LIMIT) return messages;
  const first = messages[0];
  let tail = messages.slice(-(HISTORY_LIMIT - 1));
  while (tail.length > 0 && tail[0].role === "user") {
    tail = tail.slice(1);
  }
  return [first, ...tail];
}

export class DiagnoseError extends Error {}
export class VinDecodeError extends Error {}

export interface VinDecoded {
  year: string;
  make: string;
  model: string;
  trim: string;
  engineType: string;
}

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/i;

export function isLikelyVin(value: string): boolean {
  return VIN_RE.test(value.trim());
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .trim();
}

// NHTSA's value for the Turbo / Other fields can be "Yes" / "No" / null /
// rarely a model name. Treat anything that doesn't look like a clear "no"
// or empty as a positive signal.
function nhtsaIsYes(value: string | undefined | null): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  if (v === "" || v === "no" || v === "false" || v === "0" || v === "not applicable") {
    return false;
  }
  return true;
}

function buildEngineType(
  displacementL: string,
  cyl: string,
  turbo: string | undefined,
  fuelType: string | undefined,
  otherEngineInfo: string | undefined,
): string {
  const parts: string[] = [];
  if (displacementL) {
    const n = Number(displacementL);
    if (Number.isFinite(n) && n > 0) parts.push(`${n.toFixed(1)}L`);
  }
  if (cyl) {
    const n = Number(cyl);
    if (Number.isFinite(n) && n > 0) parts.push(`${n}-cyl`);
  }
  // Surface forced-induction explicitly so the server-side config-mismatch
  // detector can do keyword matching on engineType (it's how we catch e.g.
  // turbo DTCs reported on a naturally-aspirated engine). NHTSA exposes a
  // Turbo field directly; if it's a "yes" we tag the string. Diesel comes
  // from FuelTypePrimary so the diesel-on-gas mismatch rule works the same
  // way without extra plumbing.
  if (nhtsaIsYes(turbo)) parts.push("Turbocharged");
  if (fuelType && /diesel/i.test(fuelType)) parts.push("Diesel");
  // OtherEngineInfo sometimes carries free-text qualifiers like "EcoBoost"
  // or "Supercharged" that aren't surfaced through the dedicated fields.
  if (otherEngineInfo && /ecoboost|supercharg|biturbo|twinturbo/i.test(otherEngineInfo)) {
    parts.push(otherEngineInfo.trim());
  }
  return parts.join(" ");
}

export async function decodeVin(vin: string): Promise<VinDecoded> {
  const clean = vin.trim().toUpperCase();
  if (!isLikelyVin(clean)) {
    throw new VinDecodeError(
      "That doesn't look like a 17-character VIN. Check for typos.",
    );
  }
  const url = `https://vpic.nhtsa.dot.gov/api/vehicles/decodevinvalues/${clean}?format=json`;

  let res: Response;
  try {
    res = await fetch(url, { method: "GET" });
  } catch {
    throw new VinDecodeError(
      "Couldn't reach NHTSA. Check your connection and try again.",
    );
  }

  if (!res.ok) {
    throw new VinDecodeError(`NHTSA returned ${res.status}.`);
  }

  type NhtsaRow = {
    ModelYear?: string;
    Make?: string;
    Model?: string;
    Trim?: string;
    Trim2?: string;
    EngineCylinders?: string;
    DisplacementL?: string;
    Turbo?: string;
    FuelTypePrimary?: string;
    OtherEngineInfo?: string;
    ErrorCode?: string;
    ErrorText?: string;
  };

  let payload: { Results?: NhtsaRow[] };
  try {
    payload = await res.json();
  } catch {
    throw new VinDecodeError("NHTSA returned an unreadable response.");
  }

  const row = payload.Results?.[0];
  if (!row) {
    throw new VinDecodeError("NHTSA returned no results for that VIN.");
  }

  if (!row.Make && !row.Model && !row.ModelYear) {
    const err = (row.ErrorText ?? "Could not decode VIN.").split(";")[0];
    throw new VinDecodeError(err);
  }

  return {
    year: (row.ModelYear ?? "").trim(),
    make: row.Make ? titleCase(row.Make) : "",
    model: row.Model ? titleCase(row.Model) : "",
    trim: row.Trim ? titleCase(row.Trim) : row.Trim2 ? titleCase(row.Trim2) : "",
    engineType: buildEngineType(
      row.DisplacementL ?? "",
      row.EngineCylinders ?? "",
      row.Turbo,
      row.FuelTypePrimary,
      row.OtherEngineInfo,
    ),
  };
}

export async function diagnose(
  vehicle: VehicleInfo,
  messages: ChatMessage[],
  recalls: Recall[] = [],
  tsbs: Tsb[] = [],
  sessionId?: string | null,
): Promise<{ turn: AssistantTurn; cost: ApiCostData | null }> {
  if (!BASE_URL || BASE_URL.length === 0) {
    throw new DiagnoseError(
      "Backend URL is not configured. Set EXPO_PUBLIC_API_BASE_URL and restart Expo.",
    );
  }

  const url = `${BASE_URL}/api/diagnose`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "ngrok-skip-browser-warning": "true",
  };
  const bodyStr = JSON.stringify({
    vehicle,
    messages: truncateForApi(messages),
    recalls,
    tsbs,
    sessionId: sessionId ?? null,
  });

  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers, body: bodyStr });
  } catch {
    throw new DiagnoseError(
      "Network error. Check your connection and try again.",
    );
  }

  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new DiagnoseError(`Couldn't read server response (${res.status}).`);
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new DiagnoseError(
      `Server returned an unexpected response (${res.status}).`,
    );
  }

  if (!res.ok) {
    const msg =
      json && typeof json === "object" && "error" in json
        ? String((json as { error: unknown }).error)
        : `Request failed (${res.status}).`;
    throw new DiagnoseError(msg);
  }

  const resp = json as DiagnoseResponse & { cost?: ApiCostData | null };
  return { turn: resp.turn, cost: resp.cost ?? null };
}

export async function ask(
  messages: ChatMessage[],
  vehicle?: VehicleInfo,
  recalls: Recall[] = [],
  tsbs: Tsb[] = [],
  sessionId?: string | null,
): Promise<{ text: string; cost: ApiCostData | null }> {
  if (!BASE_URL || BASE_URL.length === 0) {
    throw new DiagnoseError(
      "Backend URL is not configured. Set EXPO_PUBLIC_API_BASE_URL and restart Expo.",
    );
  }

  const url = `${BASE_URL}/api/ask`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "ngrok-skip-browser-warning": "true",
  };
  const bodyStr = JSON.stringify({
    messages: truncateForApi(messages),
    vehicle,
    recalls,
    tsbs,
    sessionId: sessionId ?? null,
  });

  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers, body: bodyStr });
  } catch {
    throw new DiagnoseError(
      "Network error. Check your connection and try again.",
    );
  }

  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new DiagnoseError(`Couldn't read server response (${res.status}).`);
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new DiagnoseError(
      `Server returned an unexpected response (${res.status}).`,
    );
  }

  if (!res.ok) {
    const msg =
      json && typeof json === "object" && "error" in json
        ? String((json as { error: unknown }).error)
        : `Request failed (${res.status}).`;
    throw new DiagnoseError(msg);
  }

  const resp = json as { text: string; cost?: ApiCostData | null };
  return { text: resp.text ?? "", cost: resp.cost ?? null };
}

export class AssessError extends Error {}

export interface AssessResult {
  assessment: DiagnosticAssessment;
  cost: ApiCostData | null;
}

export async function assess(
  vehicle: VehicleInfo,
  vin: string | null,
  mileage: string,
  complaint: string,
  snapshot: DiagnosticSnapshot,
  recalls: Recall[] = [],
  tsbs: Tsb[] = [],
  sessionId?: string | null,
): Promise<AssessResult> {
  if (!BASE_URL || BASE_URL.length === 0) {
    throw new AssessError(
      "Backend URL is not configured. Set EXPO_PUBLIC_API_BASE_URL and restart Expo.",
    );
  }

  const url = `${BASE_URL}/api/assess`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "ngrok-skip-browser-warning": "true",
  };
  const bodyStr = JSON.stringify({
    vehicle,
    vin,
    mileage,
    complaint,
    snapshot,
    recalls,
    tsbs,
    sessionId: sessionId ?? null,
  });

  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers, body: bodyStr });
  } catch {
    throw new AssessError(
      "Network error. Check your connection and try again.",
    );
  }

  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new AssessError(`Couldn't read server response (${res.status}).`);
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new AssessError(
      `Server returned an unexpected response (${res.status}).`,
    );
  }

  if (!res.ok) {
    const msg =
      json && typeof json === "object" && "error" in json
        ? String((json as { error: unknown }).error)
        : `Request failed (${res.status}).`;
    throw new AssessError(msg);
  }

  const result = json as { assessment: DiagnosticAssessment; cost?: ApiCostData | null };
  return {
    assessment: result.assessment,
    cost: result.cost ?? null,
  };
}

// Looks up a DTC against the backend's SAE + manufacturer-specific database
// (plus pattern handlers for cylinder-specific codes). When `make` is
// provided the backend prefers a manufacturer-specific definition and falls
// back to the generic SAE entry. Returns the entry if found, null on 404.
// All other failures throw — callers may want to distinguish "not in
// database" (legitimate miss, fall back to Claude) from "couldn't reach
// the backend".
export async function fetchDtcDefinition(
  code: string,
  make?: string | null,
  engineType?: string | null,
): Promise<DtcDefinition | null> {
  if (!BASE_URL || BASE_URL.length === 0) {
    throw new DiagnoseError(
      "Backend URL is not configured. Set EXPO_PUBLIC_API_BASE_URL and restart Expo.",
    );
  }
  const clean = code.trim().toUpperCase();
  const params: string[] = [];
  if (make && make.trim().length > 0) {
    params.push(`make=${encodeURIComponent(make.trim())}`);
  }
  if (engineType && engineType.trim().length > 0) {
    params.push(`engineType=${encodeURIComponent(engineType.trim())}`);
  }
  const query = params.length > 0 ? `?${params.join("&")}` : "";
  const url = `${BASE_URL}/api/dtc/${encodeURIComponent(clean)}${query}`;
  const headers: Record<string, string> = {
    "ngrok-skip-browser-warning": "true",
  };

  // 15-second timeout so a slow Claude fallback (uncached code) degrades to
  // the error state rather than spinning indefinitely.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15_000);

  let res: Response;
  try {
    res = await fetch(url, { method: "GET", headers, signal: controller.signal });
  } catch (err) {
    clearTimeout(timeoutId);
    if ((err as Error).name === "AbortError") {
      throw new DiagnoseError("Definition lookup timed out. Try again.");
    }
    throw new DiagnoseError(
      "Network error. Check your connection and try again.",
    );
  }
  clearTimeout(timeoutId);

  if (res.status === 404) return null;
  if (!res.ok) {
    throw new DiagnoseError(`DTC lookup failed (${res.status}).`);
  }

  try {
    return (await res.json()) as DtcDefinition;
  } catch {
    throw new DiagnoseError("Server returned an unexpected response.");
  }
}
