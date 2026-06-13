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
import type { NumericRange } from "./assessmentTypes";
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

export type DetectorEvent =
  | { type: "card"; itemIndex: number; state: CardState; conditionLabel: string; signalIds: string[]; durationSeconds?: number; progress?: number }
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

function conditionSatisfied(item: RunnableItem, tick: MonitorTick): boolean {
  const t = readValue(item.target, tick);
  if (!t.present || t.value == null || !inRange(t.value, item.target.range)) return false;
  for (const g of item.gate) {
    const v = readValue(g, tick);
    if (!v.present || v.value == null || !inRange(v.value, g.range)) return false;
  }
  return true;
}

// ---- Per-item runtime state ------------------------------------------------

type RunnableItem = Extract<ResolvedPlanItem, { runnable: true }>;

interface ItemState {
  item: RunnableItem;
  holdStartMs: number | null; // when the condition first became satisfied
  lastInRangeMs: number | null; // last satisfied tick (dropout tolerance anchor)
  cooldownUntilMs: number; // safeguard 2
  capturing: { startedAt: number; window: RingBufferEntry[]; trigger: CapturedWindow["trigger"] } | null;
  lastCardState: CardState | null;
}

function conditionLabel(item: RunnableItem): string {
  const parts = item.gate.map((g) => rangeLabel(g));
  parts.push(rangeLabel(item.target));
  return parts.join(" AND ");
}
function rangeLabel(s: ResolvedSignal): string {
  const r = s.range;
  const u = r.unit ?? "";
  if (r.min != null && r.max != null) return `${s.requestedId} ${r.min}-${r.max}${u}`;
  if (r.min != null) return `${s.requestedId} ≥ ${r.min}${u}`;
  if (r.max != null) return `${s.requestedId} ≤ ${r.max}${u}`;
  return `${s.requestedId}`;
}
function planSignalKeys(item: RunnableItem): string[] {
  const keys: string[] = [];
  if (item.target.availability.status === "resolved") keys.push(item.target.availability.signalKey);
  for (const g of item.gate) if (g.availability.status === "resolved") keys.push(g.availability.signalKey);
  return Array.from(new Set(keys));
}
function planSignalIds(item: RunnableItem): string[] {
  return Array.from(new Set([item.target.requestedId, ...item.gate.map((g) => g.requestedId)]));
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
        this.emitCard(st, "waiting", events);
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
    this.emitCard(st, "waiting", events);
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
    const trigger: CapturedWindow["trigger"] = {
      firedAt: tick.timestamp,
      targetSignalId: st.item.target.requestedId,
      targetSignalKey: st.item.target.availability.status === "resolved" ? st.item.target.availability.signalKey : "",
      targetValueAtFire: readValue(st.item.target, tick).value,
      gateValuesAtFire,
      sustainedHeldMs: heldMs,
    };
    st.capturing = { startedAt: tick.timestamp, window: [{ timestamp: tick.timestamp, values: tick.values }], trigger };
    this.emitCard(st, "capturing", events, 0);
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
      this.emitCard(st, "waiting", events);
      return;
    }
    this.emitCard(st, "capturing", events, Math.min(1, elapsed / windowMs));
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

  private emitCard(st: ItemState, state: CardState, events: DetectorEvent[], progress?: number): void {
    // Coalesce: only emit a card event on a state change or while capturing
    // (progress updates). Avoids spamming the UI every 250ms in "waiting".
    if (state === "waiting" && st.lastCardState === "waiting") return;
    st.lastCardState = state;
    events.push({
      type: "card",
      itemIndex: st.item.itemIndex,
      state,
      conditionLabel: conditionLabel(st.item),
      signalIds: planSignalIds(st.item),
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
