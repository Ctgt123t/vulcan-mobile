// ============================================================================
// Diagnostic case envelope — PURE CORE (Stage 2B).
//
// The "patient chart": a versioned, persistable record of a diagnostic session
// so a tech can pause, switch cars, and resume later. This file is the PURE
// half — types, the versioned-envelope migrator, index derivation, and prune
// selection. It has ZERO React Native / AsyncStorage dependencies (only
// type-only imports), so it runs in Node directly and the migration tester is
// a hard gate (same discipline as lib/dtcParser.ts). All storage I/O lives in
// lib/diagnosticCases.ts.
//
// LOAD-BEARING INVARIANTS (the versioned-envelope bet only pays off if these
// hold for a FUTURE app version reading TODAY's data):
//   - migrateCase NEVER throws. Malformed / truncated / unknown input → null.
//   - A FUTURE schemaVersion (newer than this app understands) → null, and the
//     storage layer leaves that body untouched on disk (never deletes). This is
//     the OTA-rollback survival property.
//   - The envelope carries NO live-connection data (no PidDescriptor[], no DTC
//     arrays, no FreezeFrame, no live snapshot inputs). It is CASE HISTORY —
//     what was known then — and is structurally incapable of feeding the
//     auto-assess gate. The absence of those fields from these types IS the
//     staleness guarantee (Stage 2B constraint 3).
// ============================================================================

import type { ChatMessage, VehicleInfo } from "./types";
import type {
  DiagnosticAssessment,
  DiagnosticSnapshot,
  Hypothesis,
  OperatingCondition,
  RequestedDataItem,
} from "./assessmentTypes";

export const CASE_SCHEMA_VERSION = 1 as const;

// Hard cap on stored cases. Past the cap, prune oldest CLOSED first; never an
// open case without explicit user consent (handled in the storage/UI layer).
export const CASE_CAP = 25;

// Storage keys. Per-case bodies live under their own key (so an auto-save
// rewrites one body, not all 25, and an unknown-version body is never clobbered
// by a whole-array write); a single index key holds the lightweight list.
export const CASE_INDEX_KEY = "vulcan:cases:index:v1";
export function caseBodyKey(id: string): string {
  return `vulcan:cases:case:${id}:v1`;
}
// Prefix used to discover all case bodies when rebuilding the index.
export const CASE_BODY_KEY_PREFIX = "vulcan:cases:case:";

export type CaseStatus = "open" | "closed";
export type CaseCloseReason = "fix_confirmed" | "closed_by_user";

// One assessment that ran in this case — RESULT + anchor only. Deliberately
// carries NO snapshot inputs (descriptors / DTC arrays / freeze frame / ring
// buffer): those are live-connection artifacts. Their absence from this type is
// the structural guarantee behind constraint 3 — a restored assessment cannot
// be replayed as if it were fresh live data.
export interface SavedAssessmentEntry {
  afterMessageIndex: number; // anchored-slot position in the thread
  result:
    | { status: "done"; assessment: DiagnosticAssessment }
    | { status: "error"; message: string };
  operatingCondition: OperatingCondition;
  completedAt: string; // ISO
}

export interface CaseVehicle {
  vehicle: VehicleInfo; // identity AS OF the case (history)
  vin: string | null; // resume-by-VIN INDEX, not the primary key
  source: "manual" | "vin-decoded" | "obd2-auto" | null;
}

// ---- Reserved 2C slots (typed now, empty in 2B) ----

// Evidence ledger: immutable record of captures taken. Shaped against the
// Stage 1 schema — a capture ANSWERS a RequestedDataItem[], and what was
// observed is a DiagnosticSnapshot (the exact object the 2C capture executor
// already holds when it sends the evidence-update call). History only: nothing
// in the resume / gate path reads it.
export interface EvidenceCaptureEntry {
  capturedAt: string;
  requested: RequestedDataItem[]; // next_step.requested_data that prompted it
  operatingCondition: OperatingCondition;
  observed: DiagnosticSnapshot; // the factual summary that was sent
  outcome: "completed" | "cancelled" | "timeout";
}

// Evolving case state. Mirrors Hypothesis from assessmentTypes so 2C's
// evidence-update results merge in without a retrofit.
export interface CaseStateSlot {
  hypotheses: Hypothesis[]; // last-known ranked differential
  ruledOut: { name: string; reason: string; at: string }[];
  stepsTaken: { action: string; result: string; at: string }[];
}

export interface DiagnosticCaseV1 {
  schemaVersion: 1;
  id: string; // generated primary key
  status: CaseStatus;
  closeReason: CaseCloseReason | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;

  vehicle: CaseVehicle;

  // Intake
  complaint: string; // maps to screen `symptom`
  mileage: string; // denormalized at intake (vehicle.mileage drifts)
  operatingCondition: OperatingCondition;

  // The thread — restored to the UI verbatim
  messages: ChatMessage[]; // assistant content = JSON AssistantTurn, as today
  assessments: SavedAssessmentEntry[];

  // Cross-links
  linkedRecordIds: string[]; // DiagnosticRecord ids (confirm/reject) from this case
  loggerSessionIds: string[]; // every logger session that touched this case

  // ---- 2C slots (empty arrays / null in 2B) ----
  evidenceLedger: EvidenceCaptureEntry[];
  caseState: CaseStateSlot | null;
}

// Union grows here at v2: `DiagnosticCaseV1 | DiagnosticCaseV2`. migrateCase
// always returns the CURRENT shape (older versions are up-migrated).
export type DiagnosticCase = DiagnosticCaseV1;

// Lightweight list/lookup row. Derivable from a body; the index is a cache that
// reconcileIndex() can rebuild, so a divergence self-heals.
export interface CaseIndexEntry {
  id: string;
  schemaVersion: number; // surfaced so the list can flag "needs app update"
  status: CaseStatus;
  // Distinguishes a confirmed-fix close (the confirmed-fix DB feed) from a
  // user close in the list chip, without loading the body. null while open or
  // for a legacy index entry written before this field existed.
  closeReason: CaseCloseReason | null;
  vin: string | null; // the VIN index for resume lookup
  vehicleLabel: string;
  complaintPreview: string;
  createdAt: string;
  updatedAt: string;
}

// ---- ID generation (same shape as records.makeRecordId) -------------------

export function makeCaseId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---- Small coercion helpers (defensive; never throw) ----------------------

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}
function strOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function arr<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}
function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

// A ChatMessage we are willing to restore: {role: user|assistant, content:string}.
// Anything that doesn't match is dropped (not fatal — a partial thread still
// renders and re-sends).
function sanitizeMessages(v: unknown): ChatMessage[] {
  return arr<unknown>(v)
    .filter(
      (m): m is ChatMessage =>
        isObj(m) &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string",
    )
    .map((m) => ({ role: m.role, content: m.content }));
}

function sanitizeVehicle(v: unknown): CaseVehicle {
  const o = isObj(v) ? v : {};
  const veh = isObj(o.vehicle) ? o.vehicle : {};
  const vehicle: VehicleInfo = {
    year: str(veh.year),
    make: str(veh.make),
    model: str(veh.model),
    series: typeof veh.series === "string" ? veh.series : undefined,
    trim: typeof veh.trim === "string" ? veh.trim : undefined,
    engineType: typeof veh.engineType === "string" ? veh.engineType : undefined,
    mileage: str(veh.mileage),
  };
  const source = o.source;
  return {
    vehicle,
    vin: strOrNull(o.vin),
    source:
      source === "manual" || source === "vin-decoded" || source === "obd2-auto"
        ? source
        : null,
  };
}

// ---- The migrator (the gate) ----------------------------------------------
//
// Tolerant by contract: returns the CURRENT-version envelope, or null. NEVER
// throws. The whole body is try/wrapped so even an unforeseen shape degrades to
// a skip rather than crashing a future app launch.
export function migrateCase(raw: unknown): DiagnosticCase | null {
  try {
    if (!isObj(raw)) return null;
    const v = raw.schemaVersion;
    if (typeof v !== "number") return null; // unversioned / unknown → skip
    if (v > CASE_SCHEMA_VERSION) return null; // FUTURE version → skip, never delete
    if (v < 1) return null; // nonsensical version
    if (v === 1) return validateV1(raw);
    // Unreachable today; future down-migration chains would slot in here.
    return null;
  } catch {
    return null;
  }
}

// v1 validator + forward-filler. Required core invariants: a usable id, a valid
// status, and a messages array. Everything else is defaulted so a body written
// by an earlier 2B build that lacked a later-added field still loads (in-version
// forward compatibility).
function validateV1(raw: Record<string, unknown>): DiagnosticCase | null {
  const id = raw.id;
  if (typeof id !== "string" || id.length === 0) return null;
  const status =
    raw.status === "open" || raw.status === "closed" ? raw.status : null;
  if (!status) return null;
  if (!Array.isArray(raw.messages)) return null;

  const closeReason =
    raw.closeReason === "fix_confirmed" || raw.closeReason === "closed_by_user"
      ? raw.closeReason
      : null;

  const oc = raw.operatingCondition;
  const operatingCondition: OperatingCondition =
    oc === "COLD_START" ||
    oc === "WARM_IDLE" ||
    oc === "LIGHT_LOAD" ||
    oc === "HEAVY_LOAD" ||
    oc === "UNDER_SYMPTOM_CONDITION" ||
    oc === "OTHER"
      ? oc
      : "WARM_IDLE";

  const now = new Date().toISOString();
  const createdAt = str(raw.createdAt, now);

  return {
    schemaVersion: 1,
    id,
    status,
    closeReason,
    createdAt,
    updatedAt: str(raw.updatedAt, createdAt),
    closedAt: strOrNull(raw.closedAt),
    vehicle: sanitizeVehicle(raw.vehicle),
    complaint: str(raw.complaint),
    mileage: str(raw.mileage),
    operatingCondition,
    messages: sanitizeMessages(raw.messages),
    // Assessments: keep only well-formed entries; a malformed slot is dropped,
    // not fatal.
    assessments: arr<unknown>(raw.assessments)
      .map(sanitizeAssessment)
      .filter((a): a is SavedAssessmentEntry => a !== null),
    linkedRecordIds: arr<unknown>(raw.linkedRecordIds).filter(
      (x): x is string => typeof x === "string",
    ),
    loggerSessionIds: arr<unknown>(raw.loggerSessionIds).filter(
      (x): x is string => typeof x === "string",
    ),
    // 2C slots — preserved if present (forward-compat), else empty.
    evidenceLedger: arr<EvidenceCaptureEntry>(raw.evidenceLedger),
    caseState: isObj(raw.caseState)
      ? (raw.caseState as unknown as CaseStateSlot)
      : null,
  };
}

function sanitizeAssessment(v: unknown): SavedAssessmentEntry | null {
  if (!isObj(v)) return null;
  const slot = v.result;
  if (!isObj(slot)) return null;
  let result: SavedAssessmentEntry["result"] | null = null;
  if (slot.status === "done" && isObj(slot.assessment)) {
    result = {
      status: "done",
      assessment: slot.assessment as unknown as DiagnosticAssessment,
    };
  } else if (slot.status === "error" && typeof slot.message === "string") {
    result = { status: "error", message: slot.message };
  }
  if (!result) return null;
  const oc = v.operatingCondition;
  const operatingCondition = (
    typeof oc === "string" ? oc : "WARM_IDLE"
  ) as OperatingCondition;
  return {
    afterMessageIndex:
      typeof v.afterMessageIndex === "number" && v.afterMessageIndex >= 0
        ? v.afterMessageIndex
        : 0,
    result,
    operatingCondition,
    completedAt: str(v.completedAt, new Date().toISOString()),
  };
}

// ---- Index derivation ------------------------------------------------------

export function vehicleLabel(cv: CaseVehicle): string {
  const name = [cv.vehicle.year, cv.vehicle.make, cv.vehicle.model]
    .filter((s) => s && s.length > 0)
    .join(" ");
  const tail = cv.vin ? `…${cv.vin.slice(-6)}` : "";
  if (name && tail) return `${name} · ${tail}`;
  return name || tail || "Unknown vehicle";
}

export function deriveIndexEntry(c: DiagnosticCase): CaseIndexEntry {
  return {
    id: c.id,
    schemaVersion: c.schemaVersion,
    status: c.status,
    closeReason: c.closeReason,
    vin: c.vehicle.vin,
    vehicleLabel: vehicleLabel(c.vehicle),
    complaintPreview: c.complaint.slice(0, 80),
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

// ---- Prune selection -------------------------------------------------------
//
// Pure decision (no I/O). Called before creating a NEW case. Returns the victim
// to delete (oldest CLOSED by updatedAt) or a blocked signal (all slots open)
// so the caller can show the all-25-open consent UX. Never selects an open
// case.
export interface PruneDecision {
  needed: boolean; // false → under cap, nothing to do
  victimId: string | null; // a closed case to delete, if needed and available
  blocked: boolean; // needed but every slot is open → caller must get consent
  openEntries: CaseIndexEntry[]; // the open cases (for the all-open UX)
}

export function selectPrune(
  index: CaseIndexEntry[],
  cap: number = CASE_CAP,
): PruneDecision {
  if (index.length < cap) {
    return { needed: false, victimId: null, blocked: false, openEntries: [] };
  }
  const closed = index
    .filter((e) => e.status === "closed")
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  if (closed.length > 0) {
    return {
      needed: true,
      victimId: closed[0].id,
      blocked: false,
      openEntries: [],
    };
  }
  return {
    needed: true,
    victimId: null,
    blocked: true,
    openEntries: index.filter((e) => e.status === "open"),
  };
}

// ---- Index reconciliation (self-heal) -------------------------------------
//
// Given the index entries actually present and the set of body-derived entries,
// return the corrected index: every real body represented exactly once, and no
// phantom rows for bodies that no longer exist. Newest-updated first (list
// order). Pure.
export function reconcileIndex(
  bodyEntries: CaseIndexEntry[],
): CaseIndexEntry[] {
  const byId = new Map<string, CaseIndexEntry>();
  for (const e of bodyEntries) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
}
