// ============================================================================
// Capture-plan signal RESOLVER — PURE CORE (Stage 2C-2).
//
// Maps the bare `signal_id`s in a 2C-1 capture_plan onto the vehicle's actual
// signals (signalKey = `${code}@${id}`) so the detector (captureDetector.ts)
// can read live values and the executor can poll/validate. This file has ZERO
// React Native / Expo / AsyncStorage dependencies (type-only imports), so it
// runs in Node directly and captureDetector.test.ts is a hard gate — same
// discipline as lib/dtcParser.ts.
//
// WHY THIS EXISTS (the 2C-1 carry-forward): Claude emits signal_ids that may
//   - differ from the catalog id (it emitted "SHRTFT11" for a snapshot that
//     said "STFT_B1" in 2C-1 live testing), and
//   - be non-globally-unique (SHRTFT11 lives at BOTH 01 14 and 01 15).
// The resolver is canonical-aware and NEVER guesses a command: an id it can't
// confidently bind is reported UNAVAILABLE so 2C-3/Claude can adapt ("the phone
// is honest about what it can't carry").
//
// ID-EQUIVALENCE: the base mechanism is the same case-insensitive bare-id match
// used by pidCatalog.resolveIdsToKeys (exact `id`, first-match). We EXTEND it
// here (flagged, not a silent parallel mechanism) with two more tiers: a
// separator/case normalization, then a small explicit SAE alias-rewrite table.
// Exact match is the primary path; the extra tiers are a best-effort safety net
// for when Claude doesn't echo the snapshot id verbatim.
// ============================================================================

import type { PidDescriptor } from "./obd2";
import type { CapturePlan, NumericRange, RequestedDataItem, SignalCondition } from "./assessmentTypes";

// Globally-unique signal key, identical to obd2.signalKeyOf. Inlined (not
// imported) so this stays a PURE module: a value import from ./obd2 would pull
// in the React Native transport stack and break the node test runner (same
// type-only discipline diagnosticCasesCore.ts follows).
function keyOf(d: { code: string; id: string; signalKey?: string }): string {
  return d.signalKey ?? `${d.code}@${d.id}`;
}

// ---- Inputs the resolver needs about the connected vehicle ----------------

export interface ResolveContext {
  // The annotated OBDb catalog for this vehicle (each signal already carries a
  // signalKey via pidCatalog.annotateCommandWidths). Plain catalog also fine —
  // we recompute the key defensively.
  catalog: PidDescriptor[];
  // signalKeys currently in the live polling selection. The preference anchor:
  // an ambiguous id resolves to the command already being polled.
  selectedKeys: Set<string>;
  // Mode-01 PID numbers the ECU reported as supported (authoritative for mode
  // 01). EMPTY set = "unknown" (bitmask not queried) → we do NOT use it to
  // exclude, so a no-bitmask state can't nuke every resolution.
  supportedMode01: Set<number>;
  // signalKeys the polling driver marked unsupported after repeated misses.
  unsupportedKeys: Set<string>;
}

// ---- Output shapes --------------------------------------------------------

export type UnavailableReason = "no_match" | "unsupported" | "ambiguous";

export type SignalAvailability =
  | {
      status: "resolved";
      signalKey: string;
      command: { mode: string; pid: string };
      catalogId: string; // the catalog's id (may differ from requestedId)
    }
  | { status: "unavailable"; reason: UnavailableReason };

export interface ResolvedSignal {
  requestedId: string; // the id Claude emitted
  range: NumericRange;
  availability: SignalAvailability;
}

export type ResolvedPlanItem =
  | {
      runnable: true;
      itemIndex: number;
      sustainedSeconds: number;
      captureWindowSeconds: number;
      target: ResolvedSignal; // availability.status === "resolved"
      gate: ResolvedSignal[]; // resolved gate signals only
      degraded: ResolvedSignal[]; // gate signals that couldn't be resolved (runs without them)
    }
  | {
      runnable: false;
      itemIndex: number;
      reason: "target_unavailable";
      targetSignalId: string;
      detail: SignalAvailability; // why the target couldn't bind
    };

// ---- ID normalization + alias table (the flagged extension) ---------------

// Tier-2: strip everything but A-Z0-9 and uppercase, so "shrtft_1" === "SHRTFT1".
export function normalizeId(id: string): string {
  return id.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// Tier-3: a SMALL, explicit, best-effort rewrite table for the common colloquial
// vs OBDb-canonical divergences. Applied to the NORMALIZED requested id; the
// result is compared against normalized catalog ids. Deliberately tiny — exact
// match is the real path; widen only when a real miss is observed in testing.
const ALIAS_REWRITES: [RegExp, string][] = [
  [/^STFT/, "SHRTFT"], // short-term fuel trim:  STFT1 -> SHRTFT1
  [/^LTFT/, "LONGFT"], //  long-term fuel trim:  LTFT1 -> LONGFT1
  [/^FUELSYS/, "FUELSTAT"],
  [/B([1-9])$/, "$1"], // bank suffix: ...B1 -> ...1  (after the prefix rewrites)
];

function aliasNormalize(id: string): string {
  let s = normalizeId(id);
  for (const [re, rep] of ALIAS_REWRITES) s = s.replace(re, rep);
  return s;
}

// ---- Candidate matching ---------------------------------------------------

interface Candidate {
  descriptor: PidDescriptor;
  signalKey: string;
}

// Find catalog descriptors matching `requestedId` at the BEST available tier
// (exact > normalized > alias). We never mix tiers: if any exact match exists,
// only exact matches are candidates, etc. This keeps a confident exact hit from
// being diluted by loose alias hits.
function findCandidates(requestedId: string, catalog: PidDescriptor[]): Candidate[] {
  const reqExact = requestedId.toLowerCase();
  const reqNorm = normalizeId(requestedId);
  const reqAlias = aliasNormalize(requestedId);

  const exact: Candidate[] = [];
  const norm: Candidate[] = [];
  const alias: Candidate[] = [];

  for (const d of catalog) {
    if (!d.id) continue;
    const key = keyOf(d);
    const cand: Candidate = { descriptor: d, signalKey: key };
    if (d.id.toLowerCase() === reqExact) {
      exact.push(cand);
      continue;
    }
    const dNorm = normalizeId(d.id);
    if (dNorm === reqNorm) {
      norm.push(cand);
      continue;
    }
    if (dNorm === reqAlias) alias.push(cand);
  }

  if (exact.length > 0) return exact;
  if (norm.length > 0) return norm;
  return alias;
}

function isCandidateAvailable(c: Candidate, ctx: ResolveContext): boolean {
  if (ctx.unsupportedKeys.has(c.signalKey)) return false;
  // Mode 01 has an authoritative support bitmask; only apply it when known.
  if (c.descriptor.command.mode === "01" && ctx.supportedMode01.size > 0) {
    const pidByte = parseInt(c.descriptor.command.pid, 16);
    if (!Number.isNaN(pidByte) && !ctx.supportedMode01.has(pidByte)) return false;
  }
  // Mode 22 (and others) have no bitmask — they pass and are lazy-marked
  // unsupported by the polling driver (already reflected in unsupportedKeys).
  return true;
}

function commandOf(c: Candidate): { mode: string; pid: string } {
  return { mode: c.descriptor.command.mode, pid: c.descriptor.command.pid };
}

// Deterministic ordering so multi-match resolution is stable across runs.
function byCode(a: Candidate, b: Candidate): number {
  return a.signalKey.localeCompare(b.signalKey);
}

// The core: bind one requested id to a single command, or report why not.
// Rule: prefer the command already selected; else the single available match;
// else multiple available → ambiguous (never guess); else explain no_match vs
// unsupported.
export function resolveSignalId(
  requestedId: string,
  ctx: ResolveContext,
): SignalAvailability {
  const candidates = findCandidates(requestedId, ctx.catalog).sort(byCode);
  if (candidates.length === 0) return { status: "unavailable", reason: "no_match" };

  const available = candidates.filter((c) => isCandidateAvailable(c, ctx));
  if (available.length === 0) {
    // Matched the catalog but nothing is pollable → unsupported (distinct from
    // a name that matches nothing at all).
    return { status: "unavailable", reason: "unsupported" };
  }

  // Prefer a command already in the live selection (anchors ambiguous ids).
  const selected = available.filter((c) => ctx.selectedKeys.has(c.signalKey));
  const pick = selected.length > 0 ? selected[0] : available.length === 1 ? available[0] : null;

  if (!pick) {
    // Multiple available, none selected — do NOT guess a command.
    return { status: "unavailable", reason: "ambiguous" };
  }
  return {
    status: "resolved",
    signalKey: pick.signalKey,
    command: commandOf(pick),
    catalogId: pick.descriptor.id,
  };
}

function resolveCondition(cond: SignalCondition, ctx: ResolveContext): ResolvedSignal {
  return {
    requestedId: cond.signal_id,
    range: cond.range,
    availability: resolveSignalId(cond.signal_id, ctx),
  };
}

// ---- Plan-item + plan resolution ------------------------------------------

// Resolve one requested_data item's capture_plan. Returns null if the item
// carries no capture_plan (Stage-1 prose-only item — not executable).
export function resolvePlanItem(
  item: RequestedDataItem,
  itemIndex: number,
  ctx: ResolveContext,
): ResolvedPlanItem | null {
  const plan: CapturePlan | undefined = item.capture_plan;
  if (!plan) return null;

  const target = resolveCondition(plan.measured_target, ctx);
  if (target.availability.status !== "resolved") {
    // No measured target → the item cannot run at all (distinct from a
    // degraded-but-runnable item missing only a gate signal).
    return {
      runnable: false,
      itemIndex,
      reason: "target_unavailable",
      targetSignalId: plan.measured_target.signal_id,
      detail: target.availability,
    };
  }

  const gateResolved: ResolvedSignal[] = [];
  const degraded: ResolvedSignal[] = [];
  for (const g of plan.context_gate) {
    const r = resolveCondition(g, ctx);
    if (r.availability.status === "resolved") gateResolved.push(r);
    else degraded.push(r);
  }

  return {
    runnable: true,
    itemIndex,
    sustainedSeconds: plan.sustained_seconds,
    captureWindowSeconds: plan.capture_window_seconds,
    target,
    gate: gateResolved,
    degraded,
  };
}

// Resolve every executable item in an assessment's requested_data.
export function resolvePlan(
  requestedData: RequestedDataItem[] | undefined,
  ctx: ResolveContext,
): ResolvedPlanItem[] {
  if (!requestedData) return [];
  const out: ResolvedPlanItem[] = [];
  requestedData.forEach((item, i) => {
    const r = resolvePlanItem(item, i, ctx);
    if (r) out.push(r);
  });
  return out;
}

// Convenience: collect every unavailable signal across a resolved plan, for the
// evidence object's `unavailableSignals` (the honest "couldn't carry" report).
export function collectUnavailable(
  items: ResolvedPlanItem[],
): { signal_id: string; reason: UnavailableReason }[] {
  const out: { signal_id: string; reason: UnavailableReason }[] = [];
  const seen = new Set<string>();
  const add = (signal_id: string, reason: UnavailableReason) => {
    const k = `${signal_id}:${reason}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ signal_id, reason });
  };
  for (const it of items) {
    if (!it.runnable) {
      if (it.detail.status === "unavailable") add(it.targetSignalId, it.detail.reason);
      continue;
    }
    for (const d of it.degraded) {
      if (d.availability.status === "unavailable") add(d.requestedId, d.availability.reason);
    }
  }
  return out;
}
