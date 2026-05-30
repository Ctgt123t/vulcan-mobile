export interface VehicleInfo {
  year: string;
  make: string;
  model: string;
  trim?: string;
  engineType?: string;
  mileage: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface FinalDiagnosis {
  root_cause: string;
  reasoning: string;
  urgency: "low" | "medium" | "high";
  safety_warnings: string[];
  relevant_recall_campaigns: string[];
  relevant_tsb_numbers: string[];
}

export type AssistantTurn =
  | { kind: "question"; question: string; diagnosis: null }
  | { kind: "diagnosis"; question: null; diagnosis: FinalDiagnosis };

export interface Recall {
  campaignNumber: string;
  component: string;
  summary: string;
  consequence: string;
  remedy: string;
  reportReceivedDate?: string;
}

export interface Tsb {
  number: string;
  component: string;
  summary: string;
  date?: string;
}

export interface DtcConfigMismatch {
  id: string;
  message: string;
  severity?: "low" | "medium" | "high" | null;
}

export interface DtcDefinition {
  code: string;
  shortDescription: string;
  detailedDescription: string;
  system: string;
  commonCauses: string[];
  urgency: "low" | "medium" | "high";
  // Present when the server detected a mismatch between this code's system
  // (e.g. forced induction) and the vehicle's decoded configuration.
  configMismatch?: DtcConfigMismatch;
}

export interface DiagnoseRequest {
  vehicle: VehicleInfo;
  messages: ChatMessage[];
  recalls?: Recall[];
}

export type ItemStatus = "good" | "attention" | "urgent" | null;

export interface InspectionItem {
  status: ItemStatus;
  notes: string;
  photoUri?: string;
}

export type InspectionItems = Record<string, InspectionItem>;

export interface DiagnoseResponse {
  turn: AssistantTurn;
}
