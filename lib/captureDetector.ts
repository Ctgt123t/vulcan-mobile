// ============================================================================
// Capture DETECTOR + EXECUTOR core — PURE (Stage 2C-2).
//
// The phone's local brain for a 2C-1 capture_plan: it watches the live PID
// stream, detects when a plan item's condition is held (noise-tolerant), runs
// the four cost safeguards, captures a forward window, and emits events that
// drive the CaptureCard. It makes NO Claude call (that is 2C-3).
//
// PURE module — same discipline as captureResolver.ts / dtcParser.ts:
//   - ZERO React Native / Expo / AsyncStorage deps (type-only imports).
//   - NO timers and NO Date.now() inside: every tick carries its own wall-clock
//     `timestamp`. The RN executor (captureExecutor.ts) owns the clock and the
//     subscription to Obd2Manager ticks; this module only decides.
// This is what makes the whole detection algorithm fixture-testable at zero API
// cost (captureDetector.test.ts is the gate).
//
// RULING from review: per-item captures are INDEPENDENT — a multi-item plan is
// NOT consolidated into one fire. Two items often describe two different driving
// situations; collapsing them would capture the second item's data in the wrong
// context. Each item holds/fires/cools down on its own; the per-session budget
// bounds total cost.
// ============================================================================

import type { LiveValues, RingBufferEntry } from "./obd2";
import type { CapturePlan, NumericRange } from "./assessmentTypes";
import type { ResolvedPlanItem, ResolvedSignal } from "./captureResolver";

// ---- Tunable constants (named + grouped so real-car tuning is one edit) ----

// Hold dropout tolerance: a brief out-of-range / missed-read spell SHORTER than
// this does NOT reset the sustained-hold timer; a sustained departure does.
// 1000ms ≈ 4 ticks at the 250ms poll cadence — deliberately the same magnitude
// as Obd2Manager.MAX_CONSECUTIVE_MISSES (4), but expressed in wall-clock so it
// behaves identically on a slow non-CAN vehicle polling 1 PID/tick. This is the
// value most likely to need real-car tuning.
export const HOLD_DROPOUT_TOLERANCE_MS = 1000;

// Stale-in-band guard: a signal value older than this is treated as MISSING for
// in-range purposes, so a frozen-but-in-band reading can't falsely sustain a
// hold. ~2 fast ticks; the dropout tolerance above then still rides out a
// single stale frame.
export const STALE_VALUE_MS = 600;

// Safeguard 2 — per-item cooldown after a fire (placeholder, tune after testing).
export const CAPTURE_COOLDOWN_MS = 180_000; // 3 min

// Safeguard 3 — hard cap on fires per monitoring session (placeholder).
export const SESSION_FIRE_BUDGET = 5;

// Safeguard 4 — pause monitoring after this long with no FRESH reads.
//
// NOTE (2C-2 design correction, flagged in review): activity is defined as
// FRESH DATA ARRIVING, not VALUES CHANGING. A value-change definition would
// pause a legitimately steady-state capture (e.g. a "sustained warm idle" plan
// where RPM/ECT/trims are flat by design) right while waiting for the very
// condition the plan targets. Fresh-read detection still pauses on engine-off /
// adapter-idle (reads stop → timestamps freeze) without sabotaging steady
// captures. A signal is "fresh" this tick if its value timestamp advanced.
export const INACTIVITY_PAUSE_MS = 120_000; // 2 min

// ---- Tick + event types ----------------------------------------------------

export interface MonitorTick {
  timestamp: number; // wall-clock ms (Obd2Manager stamps this)
  values: LiveValues; // keyed by signalKey, same object the ring buffer stores
}

export type CardState = "waiting" | "capturing" | "complete";

// A single captured window, emitted on a "fire" → finalize. The RN executor
// turns `window` into a DiagnosticSnapshot (via buildDiagnosticSnapshot) and
// assembles the EvidenceCaptureEntry; this pure module hands over raw data.
export interface CapturedWindow {
  itemIndex: number;
  outcome: "completed" | "cancelled" | "timeout";
  window: RingBufferEntry[]; // forward-captured ticks over capture_window_seconds
  signalKeys: string[]; // every resolvable plan signal (gate + target)
  trigger: {
    firedAt: number;
    targetSignalId: string;
    targetSignalKey: string;
    targetValueAtFire: number | null;
    gateValuesAtFire: { signal_id: string; signalKey: string; value: number | null; range: NumericRange }[];
    sustainedHeldMs: number;
  };
}

// Per-condition live readout (Fix 2 — WAITING legibility). For each gate + the
// target: the current live value, its target range, and whether it's in-band
// right now. Computed from the same readValue + inRange the hold uses, so it's a
// free readout of the comparison already happening every tick. `current` is null
// when the signal is missing/stale.
export interface ConditionReadout {
  label: string; // the requested signal id (e.g. "ECT", "RPM")
  current: number | null;
  range: NumericRange;
  met: boolean;
}

export type DetectorEvent =
  | { type: "card"; itemIndex: number; state: CardState; conditionLabel: string; signalIds: string[]; recordedSignalIds: string[]; conditions: ConditionReadout[]; durationSeconds?: number; progress?: number }
  | { type: "fire"; window: CapturedWindow }
  | { type: "budget_exhausted" }
  | { type: "paused" }
  | { type: "resumed" };

// ---- Range / value helpers (pure) -----------------------------------------

export function inRange(value: number, range: NumericRange): boolean {
  if (range.min != null && value < range.min) return false;
  if (range.max != null && value > range.max) return false;
  return true;
}

// Read a resolved signal's current value from a tick, honoring the stale guard.
// Returns { present, value }: present=false means missing OR stale (treated as
// out-of-range for the hold, but tolerated by the dropout window).
function readValue(
  sig: ResolvedSignal,
  tick: MonitorTick,
): { present: boolean; value: number | null } {
  if (sig.availability.status !== "resolved") return { present: false, value: null };
  const lv = tick.values[sig.availability.signalKey];
  if (!lv || lv.value == null) return { present: false, value: null };
  if (tick.timestamp - lv.timestamp > STALE_VALUE_MS) return { present: false, value: null };
  return { present: true, value: lv.value };
}

// A measured target with a BOUNDED range (either bound set) is a deliberate
// "wait until the signal enters this band" event capture, so it arms the hold
// just like a context gate. A measured target with an OPEN range
// ({min:null,max:null}) is record-only: it never gates the start (we record
// whatever it reads once the gate holds). This is the fix for the warm-idle
// stall — a baseline measurement must not block its own capture.
function isBoundedRange(r: NumericRange): boolean {
  return r.min != null || r.max != null;
}

// The conditions that must HOLD for the capture to arm: every context gate, plus
// any measured target carrying a bounded range. Open-range targets are excluded
// (record-only). Order: gates first, then bounded targets.
function armingConditions(item: RunnableItem): ResolvedSignal[] {
  return [...item.gate, ...item.targets.filter((t) => isBoundedRange(t.range))];
}

function conditionSatisfied(item: RunnableItem, tick: MonitorTick): boolean {
  for (const c of armingConditions(item)) {
    const v = readValue(c, tick);
    if (!v.present || v.value == null || !inRange(v.value, c.range)) return false;
  }
  return true;
}

// ---- Per-item runtime state ------------------------------------------------

export type RunnableItem = Extract<ResolvedPlanItem, { runnable: true }>;

interface ItemState {
  item: RunnableItem;
  holdStartMs: number | null; // when the condition first became satisfied
  lastInRangeMs: number | null; // last satisfied tick (dropout tolerance anchor)
  cooldownUntilMs: number; // safeguard 2
  capturing: { startedAt: number; window: RingBufferEntry[]; trigger: CapturedWindow["trigger"] } | null;
  lastCardState: CardState | null;
  // Signature of the last emitted condition readout — so a WAITING card can
  // refresh its live values (ECT 74→75→…→80) instead of being suppressed, but
  // an unchanged readout (idle) still doesn't spam the UI.
  lastConditionsSig: string | null;
}

// The "Watching for" arming string — the ARMING conditions only (gates + any
// bounded measured targets). Record-only (open-range) targets are NOT shown here;
// they are surfaced separately via recordedSignalIds (the "Recording: …" line).
function conditionLabel(item: RunnableItem): string {
  return armingConditions(item)
    .map((s) => rangeLabel(s))
    .join(" AND ");
}
function rangeLabel(s: ResolvedSignal): string {
  return rangeLabelRaw(s.requestedId, s.range);
}
function rangeLabelRaw(id: string, r: NumericRange): string {
  const u = r.unit ?? "";
  if (r.min != null && r.max != null) return `${id} ${r.min}-${r.max}${u}`;
  if (r.min != null) return `${id} ≥ ${r.min}${u}`;
  if (r.max != null) return `${id} ≤ ${r.max}${u}`;
  return `${id}`;
}
function planSignalKeys(item: RunnableItem): string[] {
  const keys: string[] = [];
  for (const t of item.targets) if (t.availability.status === "resolved") keys.push(t.availability.signalKey);
  for (const g of item.gate) if (g.availability.status === "resolved") keys.push(g.availability.signalKey);
  return Array.from(new Set(keys));
}
function planSignalIds(item: RunnableItem): string[] {
  return Array.from(new Set([...item.targets.map((t) => t.requestedId), ...item.gate.map((g) => g.requestedId)]));
}
// The signals this capture RECORDS (all measured targets, open or bounded) — for
// the card's "Recording: …" surface. Distinct from the arming conditions.
function recordedSignalIds(item: RunnableItem): string[] {
  return Array.from(new Set(item.targets.map((t) => t.requestedId)));
}

// Public helpers so the UI can SEED the initial card with the exact same
// gate-only label + recorded-signals the detector will emit on its first tick —
// no visible "changed once on its own" flip from prose to the numeric label.
export function describeArmingCondition(item: RunnableItem): string {
  return conditionLabel(item);
}
export function listRecordedSignalIds(item: RunnableItem): string[] {
  return recordedSignalIds(item);
}

// Same gate-only arming label, computed from a RAW (un-resolved) capture_plan, so
// the UI can show an immediate placeholder before the catalog resolves that is
// byte-identical to the detector's first emitted label (no prose→numeric flip).
// Resolution binds ids to PIDs but never changes the gate ranges, so this matches.
export function describeArmingConditionFromPlan(plan: CapturePlan): string {
  const targets = plan.measured_targets && plan.measured_targets.length > 0 ? plan.measured_targets : [plan.measured_target];
  const bounded = targets.filter((t) => t.range && isBoundedRange(t.range));
  return [...plan.context_gate, ...bounded].map((c) => rangeLabelRaw(c.signal_id, c.range)).join(" AND ");
}
export function listRecordedSignalIdsFromPlan(plan: CapturePlan): string[] {
  const targets = plan.measured_targets && plan.measured_targets.length > 0 ? plan.measured_targets : [plan.measured_target];
  return Array.from(new Set(targets.map((t) => t.signal_id)));
}

// Per-condition live readout for the card (Fix 2). Shows the ARMING conditions
// (gates + bounded targets) so a warm-up wait reads as "almost there"; open
// record-only targets are not arming conditions and are not shown here. `met`
// requires a present, non-stale, in-band value.
function conditionReadouts(item: RunnableItem, tick: MonitorTick): ConditionReadout[] {
  const one = (sig: ResolvedSignal): ConditionReadout => {
    const r = readValue(sig, tick);
    const met = r.present && r.value != null && inRange(r.value, sig.range);
    return { label: sig.requestedId, current: r.value, range: sig.range, met };
  };
  return armingConditions(item).map(one);
}

// ===========================================================================
// The detector
// ===========================================================================

export class CaptureDetector {
  private readonly states: ItemState[];
  private budgetRemaining = SESSION_FIRE_BUDGET;
  private budgetExhaustedEmitted = false;

  // Activity / auto-pause tracking. Keyed on FRESH reads (value timestamp
  // advancing), not value change — see INACTIVITY_PAUSE_MS note.
  private paused = false;
  private lastActivityMs: number | null = null;
  private prevSeenTs: Record<string, number> = {};

  constructor(runnableItems: RunnableItem[]) {
    this.states = runnableItems.map((item) => ({
      item,
      holdStartMs: null,
      lastInRangeMs: null,
      cooldownUntilMs: 0,
      capturing: null,
      lastCardState: null,
      lastConditionsSig: null,
    }));
  }

  // Feed one poll tick; returns the events the executor should apply.
  ingestTick(tick: MonitorTick): DetectorEvent[] {
    const events: DetectorEvent[] = [];

    // --- Safeguard 4: auto-pause on inactivity (evaluated first) ---
    this.updateActivity(tick, events);
    // While paused we still finalize an in-flight capture (don't strand a
    // capturing card), but we do not start new holds/captures.

    for (const st of this.states) {
      if (st.capturing) {
        this.advanceCapture(st, tick, events);
        continue;
      }
      if (this.paused) {
        // hold tracking is suspended while paused
        st.holdStartMs = null;
        st.lastInRangeMs = null;
        this.emitCard(st, "waiting", tick, events);
        continue;
      }
      this.trackHold(st, tick, events);
    }

    return events;
  }

  // Abort whatever is active for a given item (Stop watching), or all if no
  // index given. Emits a cancelled fire for any in-flight capture.
  cancel(tick: MonitorTick, itemIndex?: number): DetectorEvent[] {
    const events: DetectorEvent[] = [];
    for (const st of this.states) {
      if (itemIndex != null && st.item.itemIndex !== itemIndex) continue;
      if (st.capturing) {
        events.push({ type: "fire", window: this.finalize(st, "cancelled") });
      }
      st.holdStartMs = null;
      st.lastInRangeMs = null;
      st.capturing = null;
    }
    return events;
  }

  getBudgetRemaining(): number {
    return this.budgetRemaining;
  }
  isPaused(): boolean {
    return this.paused;
  }

  // ---- internals ----------------------------------------------------------

  private trackHold(st: ItemState, tick: MonitorTick, events: DetectorEvent[]): void {
    const satisfied = conditionSatisfied(st.item, tick);

    if (satisfied) {
      if (st.holdStartMs == null) st.holdStartMs = tick.timestamp;
      st.lastInRangeMs = tick.timestamp;
    } else if (st.holdStartMs != null) {
      // Noise tolerance: only reset if the departure has persisted past the
      // tolerance window since the last satisfied tick.
      const since = st.lastInRangeMs != null ? tick.timestamp - st.lastInRangeMs : Infinity;
      if (since > HOLD_DROPOUT_TOLERANCE_MS) {
        st.holdStartMs = null;
        st.lastInRangeMs = null;
      }
    }

    // Hold satisfied? (G1)
    if (st.holdStartMs != null) {
      const held = tick.timestamp - st.holdStartMs;
      if (held >= st.item.sustainedSeconds * 1000) {
        if (this.canFire(st, tick, events)) {
          this.beginCapture(st, tick, held, events);
          return;
        }
      }
    }
    this.emitCard(st, "waiting", tick, events);
  }

  // G2 cooldown + G3 budget (G4 pause handled in ingestTick before trackHold).
  private canFire(st: ItemState, tick: MonitorTick, events: DetectorEvent[]): boolean {
    if (tick.timestamp < st.cooldownUntilMs) return false; // G2
    if (this.budgetRemaining <= 0) {
      // G3 — keep monitoring, stop firing, announce once.
      if (!this.budgetExhaustedEmitted) {
        events.push({ type: "budget_exhausted" });
        this.budgetExhaustedEmitted = true;
      }
      return false;
    }
    return true;
  }

  private beginCapture(st: ItemState, tick: MonitorTick, heldMs: number, events: DetectorEvent[]): void {
    this.budgetRemaining -= 1;
    st.cooldownUntilMs = tick.timestamp + CAPTURE_COOLDOWN_MS;

    const gateValuesAtFire = st.item.gate.map((g) => ({
      signal_id: g.requestedId,
      signalKey: g.availability.status === "resolved" ? g.availability.signalKey : "",
      value: readValue(g, tick).value,
      range: g.range,
    }));
    // Trigger stays single-valued = the PRIMARY recorded target (targets[0]); the
    // full multi-signal evidence lives in the captured window / observed snapshot.
    const primary = st.item.targets[0];
    const trigger: CapturedWindow["trigger"] = {
      firedAt: tick.timestamp,
      targetSignalId: primary.requestedId,
      targetSignalKey: primary.availability.status === "resolved" ? primary.availability.signalKey : "",
      targetValueAtFire: readValue(primary, tick).value,
      gateValuesAtFire,
      sustainedHeldMs: heldMs,
    };
    st.capturing = { startedAt: tick.timestamp, window: [{ timestamp: tick.timestamp, values: tick.values }], trigger };
    this.emitCard(st, "capturing", tick, events, 0);
  }

  private advanceCapture(st: ItemState, tick: MonitorTick, events: DetectorEvent[]): void {
    const cap = st.capturing!;
    cap.window.push({ timestamp: tick.timestamp, values: tick.values });
    const windowMs = st.item.captureWindowSeconds * 1000;
    const elapsed = tick.timestamp - cap.startedAt;
    if (elapsed >= windowMs) {
      events.push({ type: "fire", window: this.finalize(st, "completed") });
      // After a capture, reset the hold so it must re-satisfy (and re-clear the
      // cooldown) before firing again.
      st.holdStartMs = null;
      st.lastInRangeMs = null;
      this.emitCard(st, "waiting", tick, events);
      return;
    }
    this.emitCard(st, "capturing", tick, events, Math.min(1, elapsed / windowMs));
  }

  private finalize(st: ItemState, outcome: CapturedWindow["outcome"]): CapturedWindow {
    const cap = st.capturing!;
    st.capturing = null;
    return {
      itemIndex: st.item.itemIndex,
      outcome,
      window: cap.window,
      signalKeys: planSignalKeys(st.item),
      trigger: cap.trigger,
    };
  }

  private emitCard(st: ItemState, state: CardState, tick: MonitorTick, events: DetectorEvent[], progress?: number): void {
    const conditions = conditionReadouts(st.item, tick);
    const sig = conditions.map((c) => `${c.current}/${c.met}`).join("|");
    // Coalesce: skip a repeat WAITING card only when the live readout is ALSO
    // unchanged — so values refresh during warm-up (ECT 74→…→80), while a truly
    // idle/steady stream still doesn't spam the UI every 250ms.
    if (
      state === "waiting" &&
      st.lastCardState === "waiting" &&
      st.lastConditionsSig === sig
    ) {
      return;
    }
    st.lastCardState = state;
    st.lastConditionsSig = sig;
    events.push({
      type: "card",
      itemIndex: st.item.itemIndex,
      state,
      conditionLabel: conditionLabel(st.item),
      signalIds: planSignalIds(st.item),
      recordedSignalIds: recordedSignalIds(st.item),
      conditions,
      durationSeconds: st.item.captureWindowSeconds,
      progress,
    });
  }

  // --- Safeguard 4 helpers ---
  private updateActivity(tick: MonitorTick, events: DetectorEvent[]): void {
    const fresh = this.anyFreshRead(tick);
    if (fresh || this.lastActivityMs == null) this.lastActivityMs = tick.timestamp;

    const idleFor = tick.timestamp - this.lastActivityMs;
    if (!this.paused && idleFor >= INACTIVITY_PAUSE_MS) {
      this.paused = true;
      events.push({ type: "paused" });
    } else if (this.paused && fresh) {
      this.paused = false;
      this.lastActivityMs = tick.timestamp;
      events.push({ type: "resumed" });
    }
  }

  // Active if ANY value produced a fresh read this tick — i.e. its value
  // timestamp advanced since we last saw it. This is independent of whether the
  // value CHANGED, so a steady-state condition stays active while the adapter
  // keeps answering, and only a true data stall (engine off / adapter idle)
  // counts as inactivity.
  private anyFreshRead(tick: MonitorTick): boolean {
    let fresh = false;
    for (const key of Object.keys(tick.values)) {
      const lv = tick.values[key];
      if (!lv || lv.value == null) continue;
      const prevTs = this.prevSeenTs[key];
      if (prevTs == null || lv.timestamp > prevTs) fresh = true;
      this.prevSeenTs[key] = lv.timestamp;
    }
    return fresh;
  }
}
