export interface VehicleInfo {
  year: string;
  make: string;
  model: string;
  // NHTSA returns light-duty truck class ("1500"/"2500") in a separate Series
  // field while Model holds only the nameplate ("Sierra"). We carry it raw and
  // fold it into the model ONLY for the Vehicle Finder spec resolve (see
  // server/specProviders/vehicleFinder.js combineModelSeries). The model field
  // itself stays clean ("Sierra") so OBDb PID and NHTSA recall lookups — which
  // key off make/model — don't regress.
  series?: string;
  trim?: string;
  engineType?: string;
  mileage: string;
}

// A photo a technician attached to a user turn (Photo Evidence, Step 1).
// `uri` is a durable local file (expo-file-system documentDirectory) used for
// the thumbnail + resume; it may dangle after a reinstall/OS purge (render a
// placeholder, never crash). `base64` is TRANSIENT — attached only to the
// OUTGOING copy of the turn the photo is sent on (the attach turn), never
// persisted to the case envelope and never re-sent on later turns. That is the
// lean cost-in-history rule: the image bytes ride once; later turns carry the
// brain's own textual read (see lib/photoEvidence.ts + server buildMessages).
export interface ImageAttachment {
  uri: string;
  mediaType: "image/jpeg";
  width?: number;
  height?: number;
  base64?: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  image?: ImageAttachment;
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
