// ============================================================================
// Physical-inspection outcome options — PURE helper (Stage 3, Step 1).
//
// The mobile-side reader/formatter for the brain-authored finding_options block
// (see lib/assessmentTypes.ts → FindingOptions). PURE (type-only imports), so it
// is node-testable and lib/findingOptions.test.ts is a hard gate — same
// discipline as dtcParser.ts / turnHistory.ts.
//
// Two jobs:
//   1. readFindingOptions — defensively read + sanitize the outcomes off a next
//      step, returning the clean list or null (fail soft). Mirrors the server's
//      softValidateFindingOptions so a malformed block renders no buttons on
//      either side (the assessment falls back to plain text).
//   2. formatInspectionResult — compose the recognizable user-message string a
//      tapped finding sends back through the EXISTING turn loop. The single place
//      the "Inspection result: …" prefix lives.
// ============================================================================

import type { NextStep } from "./assessmentTypes";

export const MIN_FINDING_OUTCOMES = 2;
export const MAX_FINDING_OUTCOMES = 4;

// The always-present, client-synthesized escape label (the model never authors
// it — so it can never be missing or malformed).
export const COULDNT_CHECK_LABEL = "Couldn't check";

// Stable prefix so a tapped finding is recognizable in the thread + in the
// serialized history the brain reads back.
export const INSPECTION_RESULT_PREFIX = "Inspection result:";

// Read + sanitize the brain's outcomes off a next step. Returns 2–4 trimmed,
// non-empty outcome strings, or null when this isn't a well-formed
// physical-inspection-with-options step (→ render plain text, no buttons).
export function readFindingOptions(
  nextStep: NextStep | null | undefined,
): string[] | null {
  if (!nextStep || nextStep.type !== "PHYSICAL_INSPECTION") return null;
  const fo = nextStep.finding_options;
  if (!fo || typeof fo !== "object") return null;
  const raw = (fo as { outcomes?: unknown }).outcomes;
  if (!Array.isArray(raw)) return null;
  const clean = raw
    .filter((o): o is string => typeof o === "string")
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
  if (
    clean.length < MIN_FINDING_OUTCOMES ||
    clean.length > MAX_FINDING_OUTCOMES
  ) {
    return null;
  }
  return clean;
}

// True iff this next step should render the finding-outcome card (well-formed
// options present). The "latest card / not-yet-answered / single-focus" gating
// is UI state and lives in the screen, not here.
export function hasFindingOptions(
  nextStep: NextStep | null | undefined,
): boolean {
  return readFindingOptions(nextStep) !== null;
}

// Compose the user-message string a tapped finding sends back. Discriminated
// input so each path is explicit, and the prefix wording lives in ONE place.
export type FindingSelection =
  | { outcome: string }
  | { couldntCheck: true }
  | { note: string };

export function formatInspectionResult(sel: FindingSelection): string {
  if ("outcome" in sel) {
    return `${INSPECTION_RESULT_PREFIX} ${sel.outcome.trim()}`;
  }
  if ("note" in sel) {
    return `${INSPECTION_RESULT_PREFIX} ${sel.note.trim()}`;
  }
  return `${INSPECTION_RESULT_PREFIX} couldn't check`;
}
