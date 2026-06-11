import type { FreezeFrame, PidDescriptor } from "./obd2";

// In-memory handoff from the OBD2 screen into the diagnostic mode. The OBD2
// screen sets this on every "Escalate to Diagnosis" tap; the diagnostic
// screen reads it two ways:
//   - getObd2DiagnoseHandoff() — render-time read of the latest scan context
//     (feeds the auto-assessment gate, badges, and snapshot builder).
//   - consumeObd2DiagnoseEscalation() — one-shot read of a pending
//     escalation (feeds the complaint prefill). Consume-once so a Diagnose
//     screen mounted later from the home tile doesn't re-prefill from an
//     old escalation.
// Deliberately NOT persisted: the payload is only meaningful with a live
// adapter connection and a warm ring buffer, so surviving an app restart
// would arm the assessment path with stale data. (The AsyncStorage-based
// lib/handoff.ts channel remains the right tool for the Ask ↔ Diagnose
// handoffs, where surviving a restart is correct.)

export interface Obd2DiagnoseHandoff {
  selectedDescriptors: PidDescriptor[];
  dtcs: string[];
  pendingDtcs: string[];
  permanentDtcs: string[];
  freezeFrame: FreezeFrame | null;
}

let store: Obd2DiagnoseHandoff = {
  selectedDescriptors: [],
  dtcs: [],
  pendingDtcs: [],
  permanentDtcs: [],
  freezeFrame: null,
};

let escalationPending = false;

export function setObd2DiagnoseHandoff(h: Obd2DiagnoseHandoff): void {
  store = h;
  escalationPending = true;
}

export function getObd2DiagnoseHandoff(): Obd2DiagnoseHandoff {
  return store;
}

export function consumeObd2DiagnoseEscalation(): Obd2DiagnoseHandoff | null {
  if (!escalationPending) return null;
  escalationPending = false;
  return store;
}

// Mirrors a code clear on the OBD2 screen so an assessment can never reason
// over codes that no longer exist on the vehicle. Permanent codes survive a
// clear by definition (they only drop after a completed drive cycle), so
// they stay — exactly matching the OBD2 screen's own state handling.
export function clearObd2DiagnoseHandoffCodes(): void {
  store = {
    ...store,
    dtcs: [],
    pendingDtcs: [],
    freezeFrame: null,
  };
}
