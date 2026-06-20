// ============================================================================
// Capture EXECUTOR — RN glue (Stage 2C-2).
//
// The thin, side-effecting layer between the Obd2Manager tick stream and the
// PURE detector (captureDetector.ts). It:
//   - resolves an assessment's requested_data against the connected vehicle,
//   - subscribes to obd2.onTick and feeds the detector,
//   - translates DetectorEvents into callbacks (CaptureCard state, a finished
//     EvidenceCaptureEntry, pause/resume/budget status),
//   - exposes cancel() (Stop watching) and stop() (unsubscribe).
//
// SCOPE: 2C-2 ends here — it PRODUCES an EvidenceCaptureEntry via onEvidence and
// drives the card. It does NOT make a Claude call (2C-3) and does NOT itself
// write to a specific case's ledger or render the thread (2C-4 wires onEvidence
// to the active case and binds onCard to the rendered CaptureCard). Keeping
// session/case coupling out of here is what lets the algorithm stay pure +
// fixture-tested.
// ============================================================================

import type { CaptureCardState } from "../components/assessment/CaptureCard";
import type { RequestedDataItem } from "./assessmentTypes";
import {
  CaptureDetector,
  type ConditionReadout,
  type DetectorEvent,
} from "./captureDetector";
import { buildEvidenceEntry, type EvidenceBuildContext } from "./captureEvidence";
import { collectUnavailable, resolvePlan, type ResolveContext, type ResolvedPlanItem } from "./captureResolver";
import type { EvidenceCaptureEntry } from "./diagnosticCasesCore";
import { obd2 } from "./obd2";

export interface CaptureCardUpdate {
  itemIndex: number;
  state: CaptureCardState;
  conditionLabel: string;
  signalIds: string[];
  conditions: ConditionReadout[]; // Fix 2: per-condition live readout for WAITING
  durationSeconds?: number;
  progress?: number;
}

export interface CaptureExecutorCallbacks {
  onCard: (update: CaptureCardUpdate) => void;
  onEvidence: (entry: EvidenceCaptureEntry) => void;
  onStatus?: (s: { type: "paused" | "resumed" | "budget_exhausted" }) => void;
}

export interface CaptureExecutorConfig {
  // The assessment's next_step.requested_data (each item's capture_plan).
  requestedData: RequestedDataItem[];
  // How to bind plan signal_ids to this vehicle's signals.
  resolveContext: ResolveContext;
  // Everything buildEvidenceEntry needs EXCEPT requested + unavailableSignals
  // (the executor fills those per-fire). Descriptors should cover the plan
  // signals so the observed snapshot summarizes them.
  evidenceContext: Omit<EvidenceBuildContext, "requested" | "unavailableSignals">;
  callbacks: CaptureExecutorCallbacks;
}

export class CaptureExecutor {
  private readonly detector: CaptureDetector;
  private readonly resolved: ResolvedPlanItem[];
  private readonly unavailable = collectUnavailable([]);
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly cfg: CaptureExecutorConfig) {
    this.resolved = resolvePlan(cfg.requestedData, cfg.resolveContext);
    const runnable = this.resolved.filter(
      (r): r is Extract<ResolvedPlanItem, { runnable: true }> => r.runnable,
    );
    this.detector = new CaptureDetector(runnable);
    this.unavailable = collectUnavailable(this.resolved);
  }

  // Items whose measured_target couldn't be bound — the caller surfaces these
  // in the UX ("can't watch X on this vehicle"). Distinct from a degraded item.
  getUnrunnable(): Extract<ResolvedPlanItem, { runnable: false }>[] {
    return this.resolved.filter(
      (r): r is Extract<ResolvedPlanItem, { runnable: false }> => !r.runnable,
    );
  }

  hasRunnableItems(): boolean {
    return this.resolved.some((r) => r.runnable);
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = obd2.onTick((t) => this.applyEvents(this.detector.ingestTick(t)));
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  // Abort an active watch/capture (Stop watching). Uses live data + wall-clock
  // for the synthetic tick the detector needs to finalize a cancelled window.
  cancel(itemIndex?: number): void {
    const t = { timestamp: Date.now(), values: obd2.getLiveData() };
    this.applyEvents(this.detector.cancel(t, itemIndex));
  }

  getBudgetRemaining(): number {
    return this.detector.getBudgetRemaining();
  }
  isPaused(): boolean {
    return this.detector.isPaused();
  }

  private applyEvents(events: DetectorEvent[]): void {
    const { onCard, onEvidence, onStatus } = this.cfg.callbacks;
    for (const ev of events) {
      switch (ev.type) {
        case "card":
          onCard({
            itemIndex: ev.itemIndex,
            state: ev.state,
            conditionLabel: ev.conditionLabel,
            signalIds: ev.signalIds,
            conditions: ev.conditions,
            durationSeconds: ev.durationSeconds,
            progress: ev.progress,
          });
          break;
        case "fire": {
          const requestedItem = this.cfg.requestedData[ev.window.itemIndex];
          const entry = buildEvidenceEntry(ev.window, {
            ...this.cfg.evidenceContext,
            requested: requestedItem ? [requestedItem] : [],
            unavailableSignals: this.unavailable,
          });
          onEvidence(entry);
          break;
        }
        case "budget_exhausted":
          onStatus?.({ type: "budget_exhausted" });
          break;
        case "paused":
          onStatus?.({ type: "paused" });
          break;
        case "resumed":
          onStatus?.({ type: "resumed" });
          break;
      }
    }
  }
}
