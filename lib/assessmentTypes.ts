// ============================================================================
// Diagnostic engine types — Stage 1 (single-shot assessment)
//
// The phone captures a factual snapshot of live OBD2 data and sends it to the
// backend. Claude reasons on the summary and returns a structured differential.
// The data model is designed to extend toward Stage 2 (iterative evidence loop)
// and Stage 3 (adaptive stance switching) without structural changes here.
// ============================================================================

import type { DiagramLookupResult, FinalDiagnosis } from "./types";

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
  dtcs: string[]; // stored codes (Mode 03)
  pendingDtcs: string[]; // pending codes (Mode 07)
  permanentDtcs: string[]; // permanent / confirmed codes (Mode 0A — survive code clear)
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
// PULL_CODES: Claude-requested mid-session re-read of the vehicle's trouble
// codes (Mode 03/07/0A). No payload — just the type + action/rationale; the app
// runs scanDtcs() on the connected vehicle and injects the fresh codes as the
// next user turn (the on-demand pattern, like a capture/finding result).
export type NextStepType =
  | "DATA_CAPTURE"
  | "PHYSICAL_INSPECTION"
  | "QUESTION"
  | "PULL_CODES";

// ---- Stage 2C-1: executable monitoring plan ----
//
// The monitoring plan is NOT a new tool or endpoint — it is the EXISTING
// requested_data, ENRICHED to be machine-executable (Stage 2C-1). Each
// DATA_CAPTURE request carries a CapturePlan so the phone (2C-2) can detect the
// condition locally (zero API cost) and capture the evidence window.
//
// SAFETY NOTE (load-bearing): a `range` here is Claude's chosen OBSERVATION
// WINDOW / capture trigger — an instruction to the phone about WHEN to look and
// WHAT counts as the evidence event. It is NOT a claimed factory specification.
// A needed factory value (the correct/expected value used to INTERPRET a
// capture) still routes to DiagnosticAssessment.unverified_specs_needed — there
// is deliberately no schema slot to assert one here. See ASSESS_SYSTEM_PROMPT.

// A numeric band the phone can check against the live stream. Bounds are
// INCLUSIVE; null = unbounded on that side, so ">= +10%" is {min:10,max:null}
// and "600-900 rpm" is {min:600,max:900}. `unit` is the RAW OBDb unit the
// snapshot reports the signal in (degC, kPa, %, rpm, km/h) — NOT a display unit
// (never degF/psi/mph). The phone compares in raw units.
export interface NumericRange {
  min: number | null;
  max: number | null;
  unit: string;
}

// A signal the plan references, named by its concrete OBDb signal id exactly as
// it appears in the snapshot. The phone resolves signal_id -> PID/command and
// validates it against the vehicle's supported-PID set in 2C-2 (2C-2 concern:
// the OBDb id is not globally unique — e.g. SHRTFT11 lives at both 01 14 and
// 01 15 — so the phone must prefer the command in the captured/selected set and
// report what it can't resolve rather than guessing).
export interface SignalCondition {
  signal_id: string;
  range: NumericRange;
}

// The executable form of a DATA_CAPTURE request. Present ONLY on DATA_CAPTURE
// next steps; absent everywhere else (optional on RequestedDataItem). Consumed
// by 2C-2 (detector/executor) and stored verbatim in the 2B evidenceLedger
// (EvidenceCaptureEntry.requested is RequestedDataItem[], so this rides along
// with no retrofit).
export interface CapturePlan {
  // The "when": every condition must hold SIMULTANEOUSLY (logical AND).
  // [] means "no gate — capture whenever the target is observed".
  context_gate: SignalCondition[];
  // The "what" (legacy single-target form): one signal + band. Still REQUIRED in
  // the server tool schema and still emitted by the brain, so the byte-frozen
  // MONITORING_SECTION that names it stays honest and old/new clients interoperate
  // (see CLAUDE.md → multi-signal capture). When `measured_targets` is present and
  // non-empty, IT is the source of truth and this field is the primary (= [0]).
  measured_target: SignalCondition;
  // The "what" (multi-signal form, additive): the full list of signals to RECORD
  // at this one operating condition. The detector arms on `context_gate` (plus any
  // measured target carrying a BOUNDED range — the deliberate "wait for this
  // event" capture) and then records every target in the window.
  //   - DEFAULT for a baseline measurement: emit an OPEN range {min:null,max:null}
  //     — record-only, never gates the start (record whatever the signal reads).
  //   - BOUNDED range: reserved for a "wait until the signal enters this band"
  //     event capture; it becomes an additional arming condition.
  // The phone reads `measured_targets ?? [measured_target]`, so this is fully
  // back-compatible with plans that only carry the legacy single target.
  measured_targets?: SignalCondition[];
  // Cost safeguard: the arming conditions must hold continuously this long.
  sustained_seconds: number;
  // How many seconds of data to package once the plan fires.
  capture_window_seconds: number;
}

export interface RequestedDataItem {
  signal_id: string; // Stage 1 display (= measured_target.signal_id by convention)
  operating_condition: string; // Stage 1 prose (human rendering of context_gate)
  duration_seconds: number; // Stage 1 display (= capture_window_seconds by convention)
  capture_plan?: CapturePlan; // 2C-1: the executable monitoring plan
}

export interface Hypothesis {
  name: string;
  confidence: ConfidenceLevel;
  supporting_evidence: string[];
  contradicting_evidence: string[];
}

// ---- Stage 3 Step 1: brain-authored physical-inspection outcome options ----
//
// Present ONLY on a PHYSICAL_INSPECTION next step (absent everywhere else;
// additive + optional — same forward-compat handling as capture_plan). The brain
// authors 2–4 bounded, mutually-exclusive POSITIVE outcomes for the one directed
// inspection; the phone renders them as glove-friendly tap buttons and ALWAYS
// adds a "couldn't check" option + a free-text escape itself (the model never
// authors those, so they can't be missing or malformed). A missing/malformed
// block fails soft to a plain typed reply — the server drops it
// (softValidateFindingOptions) and the client re-reads defensively
// (readFindingOptions). Open/qualitative questions never carry this: they go
// through ask_followup_question with no options, so "open question ⇒ no buttons"
// is STRUCTURAL (decided by which tool the brain picks), not a UI guess.
export interface FindingOptions {
  outcomes: string[]; // 2–4 brain-authored bounded outcomes
}

export interface NextStep {
  action: string;
  rationale: string;
  type: NextStepType;
  requested_data?: RequestedDataItem[]; // populated when type === DATA_CAPTURE
  finding_options?: FindingOptions; // populated when type === PHYSICAL_INSPECTION
}

export interface UnverifiedSpec {
  parameter: string;
  purpose: string;
}

// The curated 2–3 most decisive factors behind the leading hypothesis — the
// few a skeptic needs to judge the AI's direction, surfaced in the "Why this
// step" drawer. Distinct from a hypothesis's full supporting/contradicting
// lists (those stay complete). Optional + additive: the unified turn may emit
// it; /api/assess never does; older saved cases won't have it (render falls
// back to the leading-hypothesis evidence / rationale).
export interface DecisiveReason {
  point: string; // one short plain sentence
  supports: boolean; // true = supports the leading hypothesis; false = doubt/caveat
}

// ---- API cost data (returned by /api/assess alongside the assessment) ----

export interface ApiTokenCounts {
  input: number;      // uncached input tokens
  cacheWrite: number; // tokens written to 5-min ephemeral cache
  cacheRead: number;  // tokens served from cache (cheaper)
  output: number;
}

export interface ApiCostBreakdown {
  input: number;      // USD
  cacheWrite: number; // USD
  cacheRead: number;  // USD
  output: number;     // USD
  total: number;      // USD — sum of all four
}

// Full cost data for one Claude API call, as returned by the server.
export interface ApiCostData {
  model: string;
  tokens: ApiTokenCounts;
  cost: ApiCostBreakdown;
}

export interface DiagnosticAssessment {
  presenting_complaint: string;
  stance: Stance;
  stance_reason: string;
  hypotheses: Hypothesis[]; // ranked, max 5
  next_step: NextStep;
  data_ceiling_note: string; // empty string = no ceiling noted
  unverified_specs_needed: UnverifiedSpec[];
  decisive_reasons?: DecisiveReason[]; // optional, max 3 — unified turn only
  // A+ voice (2026-07-02): natural colleague-style prose narrating this
  // assessment — rendered as the assistant chat bubble, with the structured
  // card folded behind a details disclosure. OPTIONAL + additive (server
  // drops a malformed value fail-soft; /api/assess's frozen prompt never asks
  // for it; older saved cases lack it) — absent ⇒ the card renders as before.
  // SAFETY: narration only — it must never exceed the structured fields (the
  // confidence enum stays the ceiling; unverified numbers stay in
  // unverified_specs_needed). Bound by the UNIFIED_VOICE_SECTION prompt + the
  // schema description + a server-side log-only tripwire.
  spoken_summary?: string;
  // Post-diagnosis advisory (NOT evidence): populated by the unified brain ONLY
  // when this assessment IS the conclusion, so a conclusion reached via the
  // assessment path can still surface relevant recalls/TSBs (parity with
  // provide_diagnosis). Empty/absent on every non-concluding turn. Rides the
  // saved envelope wholesale like decisive_reasons (no schemaVersion bump).
  relevant_recall_campaigns?: string[];
  relevant_tsb_numbers?: string[];
}

// ---- Stage 2C-3: evidence-update endpoint contract ----
//
// The /api/evidence-update response. The server returns a fresh EVOLVED
// assessment (same DiagnosticAssessment schema) that REPLACES the case's current
// caseState; the phone preserves the prior in history (server is stateless).
// Shaped so the phone-side write is trivial: caseState.hypotheses =
// response.assessment.hypotheses. The REQUEST the phone sends is { vehicle, vin?,
// mileage?, complaint?, priorAssessment: DiagnosticAssessment, evidence:
// EvidenceCaptureEntry (from diagnosticCasesCore), recalls?, tsbs?, sessionId?,
// caseId? } — assembled in 2C-4 (no named type here to avoid a circular import
// with diagnosticCasesCore, which already imports from this module).
//
// FLAGGED (2C-3): this type is compile-time only and unused until 2C-4 wires the
// phone call; committed now for contract congruence, its OTA rides with 2C-4
// (same handling as 2C-1's capture_plan type — no empty type-only OTA now).
export interface EvidenceUpdateResponse {
  assessment: DiagnosticAssessment;
  cost: ApiCostData | null;
}

// ---- Stage 2C-4 SB3: unified diagnostic turn (/api/diagnose-turn) ----
//
// The unified brain commits to exactly ONE move per turn. The discriminated turn
// the server returns:
//   - "question"   → ask_followup_question (conversational ask / physical-check)
//   - "assessment" → emit_diagnostic_assessment (structured differential; a
//                    next_step.type === "DATA_CAPTURE" is the request-a-capture
//                    move, consumed by the existing 2C-4 capture executor; the
//                    assessment becomes the /api/evidence-update priorAssessment)
//   - "diagnosis"  → provide_diagnosis (committed final answer)
// The phone renders each kind in the /diagnose thread (SB4 wiring).
//
// FLAGGED (SB3): compile-time only — no phone code reads it until the mobile
// sub-batch (SB4) switches the app onto /api/diagnose-turn. Committed now for
// contract congruence; its OTA rides with SB4 (same handling as 2C-1's
// capture_plan + 2C-3's EvidenceUpdateResponse types). The request the phone
// will send: { vehicle, vin?, mileage?, complaint?, messages: ChatMessage[],
// snapshot?: DiagnosticSnapshot (when connected), connected: boolean, recalls?,
// tsbs?, sessionId? }.
export type DiagnoseTurn =
  | { kind: "question"; question: string }
  | { kind: "assessment"; assessment: DiagnosticAssessment }
  | { kind: "diagnosis"; diagnosis: FinalDiagnosis };

export interface DiagnoseTurnResponse {
  turn: DiagnoseTurn;
  cost: ApiCostData | null;
  // Merge-plan Phase 5: real diagram results the diagram_lookup tool surfaced
  // during this turn's retrieval loop. Present ONLY on conversational turns
  // (question / diagnosis — the server drops-with-log on an assessment move).
  // In-memory only on the client (never persisted — Brave ToS), same as Ask.
  diagrams?: DiagramLookupResult | null;
}
