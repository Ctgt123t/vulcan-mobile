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

export interface DiagnoseRequest {
  vehicle: VehicleInfo;
  messages: ChatMessage[];
  recalls?: Recall[];
}

export interface DiagnoseResponse {
  turn: AssistantTurn;
}
