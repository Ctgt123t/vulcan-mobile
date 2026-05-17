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

export interface CostRange {
  min: number;
  max: number;
  currency: string;
}

export interface FinalDiagnosis {
  root_cause: string;
  reasoning: string;
  urgency: "low" | "medium" | "high";
  estimated_cost_range: CostRange;
  repair_procedure: string[];
  safety_warnings: string[];
}

export type AssistantTurn =
  | { kind: "question"; question: string; diagnosis: null }
  | { kind: "diagnosis"; question: null; diagnosis: FinalDiagnosis };

export interface DiagnoseRequest {
  vehicle: VehicleInfo;
  messages: ChatMessage[];
}

export interface DiagnoseResponse {
  turn: AssistantTurn;
}
