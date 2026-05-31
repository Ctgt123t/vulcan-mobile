// ============================================================================
// Diagnostic engine types — Stage 1 (single-shot assessment)
//
// The phone captures a factual snapshot of live OBD2 data and sends it to the
// backend. Claude reasons on the summary and returns a structured differential.
// The data model is designed to extend toward Stage 2 (iterative evidence loop)
// and Stage 3 (adaptive stance switching) without structural changes here.
// ============================================================================

// Operating condition declared by the technician before triggering assessment.
// This is intentionally a human declaration, not a phone inference — the tech
// knows the relevant condition (e.g. "symptom only happens at highway speed")
// and should be in that condition when they trigger the assessment.
export type OperatingCondition =
  | "COLD_START"
  | "WARM_IDLE"
  | "LIGHT_LOAD"
  | "HEAVY_LOAD"
  | "UNDER_SYMPTOM_CONDITION"
  | "OTHER";

export const OPERATING_CONDITION_LABELS: Record<OperatingCondition, string> = {
  COLD_START: "Cold Start",
  WARM_IDLE: "Warm Idle",
  LIGHT_LOAD: "Light Load",
  HEAVY_LOAD: "Heavy Load",
  UNDER_SYMPTOM_CONDITION: "Under Symptom Condition",
  OTHER: "Other / Not Sure",
};

// A single averaged signal reading from the 5-second capture window.
// averageValue/minSample/maxSample are in the signal's OBDb units (raw decoded
// units — celsius, km/h, kPa, %, rpm, etc.). encodingMin/encodingMax are the
// physical encoding range from the PidDescriptor (useful for detecting a value
// pegged at the rail), NOT expected diagnostic ranges.
export interface SnapshotSignal {
  name: string;
  signalId: string;
  averageValue: number;
  minSample: number;
  maxSample: number;
  unit: string | null;
  encodingMin: number;
  encodingMax: number | null;
  category: string;
  sampleCount: number;
}

// Complete factual snapshot sent to the server with an assessment request.
// The phone produces objective facts only — no diagnostic interpretation.
export interface DiagnosticSnapshot {
  capturedAt: number; // Unix timestamp (ms)
  durationMs: number; // actual window covered by the ring buffer entries used
  operatingCondition: OperatingCondition;
  signals: SnapshotSignal[];
  absentSignalNames: string[]; // selected PIDs that returned no value in the window
  dtcs: string[]; // stored codes from the last DTC scan
  pendingDtcs: string[]; // pending codes from the last DTC scan
  freezeFrame: {
    dtc: string | null;
    rpm: number | null;
    speedKph: number | null;
    coolantC: number | null;
    fuelPressure: number | null;
  } | null;
}

// ---- Assessment output (returned from server) ----

// Stage 1 excludes CONFIRMED to enforce the confirmation gate rule:
// no hypothesis reaches CONFIRMED without a verifying test in the evidence.
// CONFIRMED will be added back in Stage 3 when the iterative loop provides
// the verification path.
export type ConfidenceLevel = "POSSIBLE" | "LIKELY" | "STRONGLY_SUPPORTED";

// AUTOPILOT: Claude drives, fault lives in the data (sensors, fuel trims,
// misfires, electrical). GUIDED: tech is the hands, Claude directs a physical
// inspection (mechanical noise, wear, leaks, visual damage).
export type Stance = "AUTOPILOT" | "GUIDED";

// Stage 2 hook: when next_step.type === DATA_CAPTURE, requested_data lists the
// specific signals and conditions Claude wants captured. Stage 1 displays this
// to the tech; Stage 2 will auto-execute it via the monitoring loop.
export type NextStepType = "DATA_CAPTURE" | "PHYSICAL_INSPECTION" | "QUESTION";

export interface RequestedDataItem {
  signal_id: string;
  operating_condition: string;
  duration_seconds: number;
}

export interface Hypothesis {
  name: string;
  confidence: ConfidenceLevel;
  supporting_evidence: string[];
  contradicting_evidence: string[];
}

export interface NextStep {
  action: string;
  rationale: string;
  type: NextStepType;
  requested_data?: RequestedDataItem[]; // populated when type === DATA_CAPTURE
}

export interface UnverifiedSpec {
  parameter: string;
  purpose: string;
}

export interface DiagnosticAssessment {
  presenting_complaint: string;
  stance: Stance;
  stance_reason: string;
  hypotheses: Hypothesis[]; // ranked, max 5
  next_step: NextStep;
  data_ceiling_note: string; // empty string = no ceiling noted
  unverified_specs_needed: UnverifiedSpec[];
}
