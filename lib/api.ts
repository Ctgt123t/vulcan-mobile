import type {
  AssistantTurn,
  ChatMessage,
  DiagnoseResponse,
  Recall,
  Tsb,
  VehicleInfo,
} from "./types";

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

function buildEngineType(displacementL: string, cyl: string): string {
  const parts: string[] = [];
  if (displacementL) {
    const n = Number(displacementL);
    if (Number.isFinite(n) && n > 0) parts.push(`${n.toFixed(1)}L`);
  }
  if (cyl) {
    const n = Number(cyl);
    if (Number.isFinite(n) && n > 0) parts.push(`${n}-cyl`);
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
    ),
  };
}

export async function diagnose(
  vehicle: VehicleInfo,
  messages: ChatMessage[],
  recalls: Recall[] = [],
  tsbs: Tsb[] = [],
): Promise<AssistantTurn> {
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

  return (json as DiagnoseResponse).turn;
}
