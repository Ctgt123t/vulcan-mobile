import AsyncStorage from "@react-native-async-storage/async-storage";
import type { TransportKind } from "./obd2";

// Persists a single previously-connected OBD2 adapter so the next session can
// reconnect without re-scanning. Only one adapter at a time — keep it simple.

export interface SavedAdapter {
  deviceId: string;
  name: string;
  transport: TransportKind;
  lastConnectedAt: number;
}

const KEY = "vulcan:obd2:savedAdapter:v1";

export async function loadSavedAdapter(): Promise<SavedAdapter | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SavedAdapter;
    if (
      !parsed ||
      typeof parsed.deviceId !== "string" ||
      typeof parsed.name !== "string" ||
      (parsed.transport !== "ble" && parsed.transport !== "classic")
    ) {
      return null;
    }
    return parsed;
  } catch (err) {
    console.warn("[savedAdapter] load failed:", err);
    return null;
  }
}

export async function saveAdapter(
  adapter: Omit<SavedAdapter, "lastConnectedAt">,
): Promise<void> {
  const record: SavedAdapter = {
    ...adapter,
    lastConnectedAt: Date.now(),
  };
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(record));
  } catch (err) {
    console.warn("[savedAdapter] save failed:", err);
  }
}

export async function clearSavedAdapter(): Promise<void> {
  try {
    await AsyncStorage.removeItem(KEY);
  } catch (err) {
    console.warn("[savedAdapter] clear failed:", err);
  }
}
