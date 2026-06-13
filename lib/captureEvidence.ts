// ============================================================================
// Captured-window → EvidenceCaptureEntry converter (Stage 2C-2).
//
// The pure detector (captureDetector.ts) emits a CapturedWindow of raw ticks +
// trigger context. This module turns that into the 2B EvidenceCaptureEntry the
// ledger stores and 2C-3 will send to Claude — extending the slot, not
// retrofitting it (the additive trigger / unavailableSignals fields ride along,
// and the migrator passes optional fields through unchanged).
//
// Stays node-runnable: type-only imports from obd2, and buildDiagnosticSnapshot
// is now pure (signalKeyOf inlined there). The RN executor (captureExecutor.ts)
// supplies the descriptors / DTCs / freeze frame.
// ============================================================================

import type { FreezeFrame, PidDescriptor } from "./obd2";
import type { OperatingCondition, RequestedDataItem } from "./assessmentTypes";
import type { EvidenceCaptureEntry } from "./diagnosticCasesCore";
import type { CapturedWindow } from "./captureDetector";
import type { UnavailableReason } from "./captureResolver";
import { buildDiagnosticSnapshot } from "./diagnosticSnapshot";

export interface EvidenceBuildContext {
  // The requested_data item(s) this capture answers (the firing item; usually
  // length 1 since captures are per-item).
  requested: RequestedDataItem[];
  // Descriptors for the plan signals, so buildDiagnosticSnapshot can summarize
  // the window (present signals + in-window-absent signals).
  descriptors: PidDescriptor[];
  operatingCondition: OperatingCondition;
  dtcs: string[];
  pendingDtcs: string[];
  permanentDtcs: string[];
  freezeFrame: FreezeFrame | null;
  // Plan signals the resolver could not bind on this vehicle.
  unavailableSignals?: { signal_id: string; reason: UnavailableReason }[];
}

export function buildEvidenceEntry(
  cw: CapturedWindow,
  c: EvidenceBuildContext,
): EvidenceCaptureEntry {
  const observed = buildDiagnosticSnapshot(
    cw.window,
    c.descriptors,
    c.operatingCondition,
    c.dtcs,
    c.pendingDtcs,
    c.permanentDtcs,
    c.freezeFrame,
  );
  const firedAtIso = new Date(cw.trigger.firedAt).toISOString();
  return {
    capturedAt: firedAtIso,
    requested: c.requested,
    operatingCondition: c.operatingCondition,
    observed,
    outcome: cw.outcome,
    trigger: {
      firedAt: firedAtIso,
      firedItemIndex: cw.itemIndex,
      targetSignalId: cw.trigger.targetSignalId,
      targetValueAtFire: cw.trigger.targetValueAtFire,
      gateValuesAtFire: cw.trigger.gateValuesAtFire.map((g) => ({
        signal_id: g.signal_id,
        value: g.value,
        range: g.range,
      })),
      sustainedHeldMs: cw.trigger.sustainedHeldMs,
    },
    unavailableSignals: c.unavailableSignals,
  };
}
