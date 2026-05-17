import type {
  AssistantTurn,
  ChatMessage,
  DiagnoseResponse,
  VehicleInfo,
} from "./types";

const RAW_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL ?? "";
const BASE_URL = RAW_BASE_URL.replace(/\/+$/, "");

console.log(
  "[api] EXPO_PUBLIC_API_BASE_URL (raw) =",
  JSON.stringify(RAW_BASE_URL),
);
console.log("[api] BASE_URL (normalized) =", JSON.stringify(BASE_URL));
if (BASE_URL && !/^https?:\/\//i.test(BASE_URL)) {
  console.warn(
    "[api] BASE_URL is missing the 'http://' or 'https://' scheme — fetch will throw.",
  );
}

export class DiagnoseError extends Error {}

export type HealthResult = {
  ok: boolean;
  status: number;
  body: string;
  url: string;
  error?: string;
};

export async function healthCheck(): Promise<HealthResult> {
  const url = `${BASE_URL}/health`;
  console.log("[health] GET", url);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { "ngrok-skip-browser-warning": "true" },
    });
    const body = await res.text();
    console.log("[health] status =", res.status, res.statusText);
    console.log("[health] body =", body);
    return { ok: res.ok, status: res.status, body, url };
  } catch (err) {
    const e = err as Error;
    console.log("[health] fetch threw:", e.name, "-", e.message);
    return {
      ok: false,
      status: 0,
      body: "",
      url,
      error: `${e.name}: ${e.message}`,
    };
  }
}

export async function diagnose(
  vehicle: VehicleInfo,
  messages: ChatMessage[],
): Promise<AssistantTurn> {
  if (!BASE_URL || BASE_URL.length === 0) {
    throw new DiagnoseError(
      "EXPO_PUBLIC_API_BASE_URL is not set. See DEV_SETUP.md.",
    );
  }

  const url = `${BASE_URL}/api/diagnose`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "ngrok-skip-browser-warning": "true",
  };
  const bodyStr = JSON.stringify({ vehicle, messages });

  console.log("[diagnose] POST", url);
  console.log("[diagnose] headers =", headers);
  console.log("[diagnose] body bytes =", bodyStr.length);

  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers, body: bodyStr });
  } catch (err) {
    const e = err as Error;
    console.log("[diagnose] fetch threw:", e.name, "-", e.message);
    throw new DiagnoseError(
      `Network error (${e.name}: ${e.message}). URL: ${url}`,
    );
  }

  console.log("[diagnose] status =", res.status, res.statusText);

  let raw: string;
  try {
    raw = await res.text();
  } catch (err) {
    const e = err as Error;
    console.log("[diagnose] read body threw:", e.message);
    throw new DiagnoseError(`Could not read response body (${res.status}).`);
  }
  console.log(
    "[diagnose] body =",
    raw.length > 500 ? `${raw.slice(0, 500)}… (${raw.length} bytes)` : raw,
  );

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new DiagnoseError(
      `Invalid JSON from server (${res.status}). First bytes: ${raw.slice(0, 120)}`,
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
