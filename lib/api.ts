import type {
  AssistantTurn,
  ChatMessage,
  DiagnoseResponse,
  DiagramLookupResult,
  DtcDefinition,
  Recall,
  Tsb,
  VehicleInfo,
} from "./types";
import type {
  ApiCostData,
  DiagnoseTurnResponse,
  DiagnosticAssessment,
  DiagnosticSnapshot,
  EvidenceUpdateResponse,
} from "./assessmentTypes";
import type { EvidenceCaptureEntry } from "./diagnosticCasesCore";

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
  // Raw NHTSA Series ("1500"/"2500"/""/free-text). Used downstream only to
  // disambiguate the Vehicle Finder spec resolve; see VehicleInfo.series.
  series: string;
  trim: string;
  engineType: string;
}

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/i;

export function isLikelyVin(value: string): boolean {
  return VIN_RE.test(value.trim());
}

export async function decodeVin(vin: string): Promise<VinDecoded> {
  const clean = vin.trim().toUpperCase();
  if (!isLikelyVin(clean)) {
    throw new VinDecodeError(
      "That doesn't look like a 17-character VIN. Check for typos.",
    );
  }
  if (!BASE_URL || BASE_URL.length === 0) {
    throw new VinDecodeError(
      "Backend URL is not configured. Set EXPO_PUBLIC_API_BASE_URL and restart Expo.",
    );
  }

  // Decode through Vulcan's own backend (self-hosted vPIC), NOT the public NHTSA
  // API (which was unreliable and had no timeout). The server returns the
  // finished VinDecoded shape — it owns the spVinDecode pivot and the engineType
  // composition — so this is a URL swap + parse. 15s timeout (matches
  // fetchDtcDefinition) so a dropped connection degrades to a clean error
  // instead of spinning forever.
  const url = `${BASE_URL}/api/decode-vin/${clean}`;
  const headers: Record<string, string> = {
    "ngrok-skip-browser-warning": "true",
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15_000);

  let res: Response;
  try {
    res = await fetch(url, { method: "GET", headers, signal: controller.signal });
  } catch (err) {
    clearTimeout(timeoutId);
    if ((err as Error).name === "AbortError") {
      throw new VinDecodeError(
        "VIN decode timed out. Check your connection and try again.",
      );
    }
    throw new VinDecodeError(
      "Couldn't reach the decode service. Check your connection and try again.",
    );
  }
  clearTimeout(timeoutId);

  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new VinDecodeError(`Couldn't read the decode response (${res.status}).`);
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new VinDecodeError(
      `Decode service returned an unexpected response (${res.status}).`,
    );
  }

  if (!res.ok) {
    // 400 (bad VIN), 422 (no usable vehicle -> ErrorText), and 503 (decode DB
    // down) all arrive here carrying the server's { error } message. The screens
    // surface it inline; VehicleContext's fail-soft keeps the raw VIN and never
    // mislabels the session with the previous vehicle.
    const msg =
      json && typeof json === "object" && "error" in json
        ? String((json as { error: unknown }).error)
        : `VIN decode failed (${res.status}).`;
    throw new VinDecodeError(msg);
  }

  // Fields arrive already finished (make/model/trim title-cased, series raw,
  // engineType composed) — just read them through, preserving the shape.
  const d = json as Partial<VinDecoded>;
  return {
    year: (d.year ?? "").trim(),
    make: d.make ?? "",
    model: d.model ?? "",
    series: d.series ?? "",
    trim: d.trim ?? "",
    engineType: d.engineType ?? "",
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
): Promise<{ text: string; cost: ApiCostData | null; diagrams: DiagramLookupResult | null }> {
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

  const resp = json as {
    text: string;
    cost?: ApiCostData | null;
    diagrams?: DiagramLookupResult | null;
  };
  return { text: resp.text ?? "", cost: resp.cost ?? null, diagrams: resp.diagrams ?? null };
}

// Direct diagram lookup (the mid-diagnosis "Find a diagram" affordance hits this
// straight, NOT through the diagnosis brain). Fail-soft on the client too: any
// error degrades to a links-only result with a prebuilt web-search URL so the
// UI never dead-ends.
export async function diagramLookup(
  vehicle: VehicleInfo,
  type: "fuse" | "wiring" | "component",
): Promise<DiagramLookupResult> {
  const fallback: DiagramLookupResult = {
    type,
    images: [],
    webSearchUrl: `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(
      `${vehicle.year} ${vehicle.make} ${vehicle.model} ${type} diagram`,
    )}`,
    attribution: "Powered by Brave",
    supported: type === "fuse" || type === "component",
  };
  if (!BASE_URL || BASE_URL.length === 0) return fallback;
  try {
    const res = await fetch(`${BASE_URL}/api/diagram-lookup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "ngrok-skip-browser-warning": "true" },
      body: JSON.stringify({ vehicle, type }),
    });
    if (!res.ok) return fallback;
    const json = (await res.json()) as DiagramLookupResult;
    return json && Array.isArray(json.images) ? json : fallback;
  } catch {
    return fallback;
  }
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

export class EvidenceUpdateError extends Error {}

// Stage 2C-4: the evidence-loop call. Sends the prior assessment + the phone's
// summarized captured-evidence window (the 2C-2 EvidenceCaptureEntry, passed
// through UNRESHAPED) to /api/evidence-update (2C-3) and returns the EVOLVED
// assessment. Single-shot; the phone writes the result into the case chart.
// Mirrors assess() exactly (same error/parse discipline). First caller of the
// 2C-3 EvidenceUpdateResponse type — its OTA rides with this build.
export async function evidenceUpdate(
  vehicle: VehicleInfo,
  vin: string | null,
  mileage: string,
  complaint: string,
  priorAssessment: DiagnosticAssessment,
  evidence: EvidenceCaptureEntry,
  recalls: Recall[] = [],
  tsbs: Tsb[] = [],
  sessionId?: string | null,
  caseId?: string | null,
): Promise<EvidenceUpdateResponse> {
  if (!BASE_URL || BASE_URL.length === 0) {
    throw new EvidenceUpdateError(
      "Backend URL is not configured. Set EXPO_PUBLIC_API_BASE_URL and restart Expo.",
    );
  }

  const url = `${BASE_URL}/api/evidence-update`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "ngrok-skip-browser-warning": "true",
  };
  const bodyStr = JSON.stringify({
    vehicle,
    vin,
    mileage,
    complaint,
    priorAssessment,
    evidence,
    recalls,
    tsbs,
    sessionId: sessionId ?? null,
    caseId: caseId ?? null,
  });

  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers, body: bodyStr });
  } catch {
    throw new EvidenceUpdateError(
      "Network error. Check your connection and try again.",
    );
  }

  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new EvidenceUpdateError(
      `Couldn't read server response (${res.status}).`,
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new EvidenceUpdateError(
      `Server returned an unexpected response (${res.status}).`,
    );
  }

  if (!res.ok) {
    const msg =
      json && typeof json === "object" && "error" in json
        ? String((json as { error: unknown }).error)
        : `Request failed (${res.status}).`;
    throw new EvidenceUpdateError(msg);
  }

  const result = json as {
    assessment: DiagnosticAssessment;
    cost?: ApiCostData | null;
  };
  return {
    assessment: result.assessment,
    cost: result.cost ?? null,
  };
}

export class DiagnoseTurnError extends Error {}

// Stage 2C-4 SB4: the UNIFIED diagnostic turn. One call per turn to the SB3
// /api/diagnose-turn brain, which commits to exactly one move and returns a
// discriminated turn (question | assessment | diagnosis). Replaces the parallel
// assess + diagnose double-fire for the /diagnose thread. `messages` is the
// serialized case narrative (buildTurnHistory on the phone); `snapshot` +
// `connected` are sent only when a vehicle is connected AND the 2B
// different-vehicle guard passes. Mirrors diagnose()/assess() error+parse
// discipline; truncates the history like diagnose() does.
export async function diagnoseTurn(params: {
  vehicle: VehicleInfo;
  vin: string | null;
  mileage: string;
  complaint: string;
  messages: ChatMessage[];
  snapshot: DiagnosticSnapshot | null;
  connected: boolean;
  recalls?: Recall[];
  tsbs?: Tsb[];
  sessionId?: string | null;
  caseId?: string | null;
}): Promise<DiagnoseTurnResponse> {
  if (!BASE_URL || BASE_URL.length === 0) {
    throw new DiagnoseTurnError(
      "Backend URL is not configured. Set EXPO_PUBLIC_API_BASE_URL and restart Expo.",
    );
  }

  const url = `${BASE_URL}/api/diagnose-turn`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "ngrok-skip-browser-warning": "true",
  };
  const bodyStr = JSON.stringify({
    vehicle: params.vehicle,
    vin: params.vin,
    mileage: params.mileage,
    complaint: params.complaint,
    messages: truncateForApi(params.messages),
    snapshot: params.snapshot,
    connected: params.connected,
    recalls: params.recalls ?? [],
    tsbs: params.tsbs ?? [],
    sessionId: params.sessionId ?? null,
    // Merge-plan Phase 2 (metering): attributes this call's cost to the
    // diagnosis credit's key (mirrors evidenceUpdate's existing caseId).
    caseId: params.caseId ?? null,
  });

  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers, body: bodyStr });
  } catch {
    throw new DiagnoseTurnError(
      "Network error. Check your connection and try again.",
    );
  }

  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new DiagnoseTurnError(`Couldn't read server response (${res.status}).`);
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new DiagnoseTurnError(
      `Server returned an unexpected response (${res.status}).`,
    );
  }

  if (!res.ok) {
    const msg =
      json && typeof json === "object" && "error" in json
        ? String((json as { error: unknown }).error)
        : `Request failed (${res.status}).`;
    throw new DiagnoseTurnError(msg);
  }

  const resp = json as DiagnoseTurnResponse;
  return { turn: resp.turn, cost: resp.cost ?? null };
}

// Merge-plan Phase 2 (metering): mark the escalation event — one flat
// "diagnosis credit" minted per case at intake submit. FIRE-AND-FORGET and
// FAIL-SOFT BY CONTRACT: usage capture must never block or break a diagnosis,
// so this never throws and never rejects (missing BASE_URL / network error /
// non-200 all swallow silently — the server end is idempotent by caseId, so
// a lost event under-counts rather than corrupts).
export function recordDiagnosisStart(params: {
  caseId: string | null;
  sessionId?: string | null;
  vehicle?: { year: string; make: string; model: string };
  source?: "direct" | "ask" | "obd2";
}): void {
  if (!BASE_URL || BASE_URL.length === 0) return;
  fetch(`${BASE_URL}/api/usage/diagnosis-start`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "ngrok-skip-browser-warning": "true",
    },
    body: JSON.stringify({
      caseId: params.caseId,
      sessionId: params.sessionId ?? null,
      vehicle: params.vehicle ?? null,
      source: params.source ?? "direct",
    }),
  }).catch(() => {});
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
