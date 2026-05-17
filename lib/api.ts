import type {
  AssistantTurn,
  ChatMessage,
  DiagnoseResponse,
  VehicleInfo,
} from "./types";

const BASE_URL = (process.env.EXPO_PUBLIC_API_BASE_URL ?? "").replace(
  /\/+$/,
  "",
);

export class DiagnoseError extends Error {}

export async function diagnose(
  vehicle: VehicleInfo,
  messages: ChatMessage[],
): Promise<AssistantTurn> {
  if (!BASE_URL || BASE_URL.length === 0) {
    throw new DiagnoseError(
      "EXPO_PUBLIC_API_BASE_URL is not set. See DEV_SETUP.md.",
    );
  }

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/api/diagnose`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "ngrok-skip-browser-warning": "true",
      },
      body: JSON.stringify({ vehicle, messages }),
    });
  } catch {
    throw new DiagnoseError(
      "Network error. Check your connection and try again.",
    );
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new DiagnoseError(`Invalid response from server (${res.status}).`);
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
