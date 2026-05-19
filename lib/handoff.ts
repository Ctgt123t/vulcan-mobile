import AsyncStorage from "@react-native-async-storage/async-storage";
import type { ChatMessage, Recall, Tsb, VehicleInfo } from "./types";

// Carries conversation context across the Ask Vulcan ↔ Diagnose boundary so
// switching modes mid-conversation doesn't drop the technician's progress.

export type Handoff =
  | {
      type: "to_diagnose";
      vehicle?: VehicleInfo;
      vin?: string;
      symptom: string;
      recalls?: Recall[];
      tsbs?: Tsb[];
    }
  | {
      type: "to_ask";
      vehicle?: VehicleInfo;
      vin?: string;
      messages: ChatMessage[];
      recalls?: Recall[];
      tsbs?: Tsb[];
    };

const KEY = "vulcan:handoff:v1";

export async function setHandoff(h: Handoff): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(h));
  } catch (err) {
    console.warn("[handoff] set failed:", err);
  }
}

// Reads the handoff and clears it ONLY if the type matches what the caller
// expects. This protects against the receiving screen pre-empting a handoff
// intended for a different mode (e.g. user navigates Diagnose → home →
// Inspection before Ask Vulcan's pending handoff is consumed).
export async function consumeHandoff(
  expectedType: Handoff["type"],
): Promise<Handoff | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Handoff;
    if (parsed.type !== expectedType) return null;
    await AsyncStorage.removeItem(KEY);
    return parsed;
  } catch (err) {
    console.warn("[handoff] consume failed:", err);
    return null;
  }
}
