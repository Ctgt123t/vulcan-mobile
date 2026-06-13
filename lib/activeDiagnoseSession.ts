// Module flag: is a diagnose CHAT session currently active? Set by the diagnose
// screen whenever its phase is "chat" (an in-progress diagnosis), cleared on
// intake/unmount. Read by the VIN-match auto-prompt (CaseResumePrompt) so it
// never interrupts a mid-thread diagnosis to offer a resume. Deliberately a
// plain module variable, not context — the prompt lives outside the screen and
// only needs a synchronous read, and this must not trigger re-renders.

let active = false;

export function setDiagnoseSessionActive(value: boolean): void {
  active = value;
}

export function isDiagnoseSessionActive(): boolean {
  return active;
}
