import AsyncStorage from "@react-native-async-storage/async-storage";
import type {
  ChatMessage,
  FinalDiagnosis,
  InspectionItems,
  Tsb,
  VehicleInfo,
} from "./types";

export type RecordOutcome = "confirmed" | "incorrect";

export interface DiagnosticRecord {
  type: "diagnosis";
  id: string;
  date: string;
  vehicle: VehicleInfo;
  vin?: string;
  symptom: string;
  conversation: ChatMessage[];
  diagnosis: FinalDiagnosis;
  outcome: RecordOutcome;
}

export interface InspectionRecord {
  type: "inspection";
  id: string;
  date: string;
  vehicle: VehicleInfo;
  vin?: string;
  mileage: string;
  items: InspectionItems;
  tsbs?: Tsb[];
}

export type SavedRecord = DiagnosticRecord | InspectionRecord;

const KEY = "vulcan:records:v1";

export function makeRecordId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Older records were saved without a `type` field — treat them as diagnoses
// so the existing on-device data keeps rendering after the new union shape.
function migrate(raw: unknown): SavedRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<SavedRecord> & { type?: string };
  if (r.type === "inspection") return r as InspectionRecord;
  if (r.type === "diagnosis") return r as DiagnosticRecord;
  if ("diagnosis" in r && "conversation" in r) {
    return { ...(r as DiagnosticRecord), type: "diagnosis" };
  }
  return null;
}

export async function loadRecords(): Promise<SavedRecord[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(migrate)
      .filter((r): r is SavedRecord => r !== null);
  } catch (err) {
    console.warn("[records] load failed:", err);
    return [];
  }
}

export async function saveRecord(record: SavedRecord): Promise<void> {
  const existing = await loadRecords();
  const next = [record, ...existing];
  await AsyncStorage.setItem(KEY, JSON.stringify(next));
}

export async function clearRecords(): Promise<void> {
  await AsyncStorage.removeItem(KEY);
}
