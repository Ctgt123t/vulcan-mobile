// ============================================================================
// Physical-inspection outcome options — soft-validator (Stage 3, Step 1).
//
// Side-effect-free (no client, no env, no server boot), so
// server/scripts/verifyFindingOptions.js can import it as a node test — same
// discipline as assessPrompt.js. Mirrors softValidateAssessmentPlan's
// philosophy: JSON schema can't make finding_options conditionally-shaped, so we
// enforce its shape here, fail-soft. A missing / malformed block is DROPPED
// (deleted, never thrown), leaving a plain PHYSICAL_INSPECTION (text + typed
// reply) so the client falls back cleanly. The model authors ONLY the 2–4
// positive outcomes; the phone adds "couldn't check" + a free-text escape itself.
// ============================================================================

export const MIN_FINDING_OUTCOMES = 2;
export const MAX_FINDING_OUTCOMES = 4;

// Well-formed iff: an array of 2–4 entries, each a non-empty (trimmed) string.
// Strict (any bad entry fails the whole block), mirroring validateCapturePlan,
// so the fallback is a clean "plain text", never a half-rendered button row.
export function isValidFindingOptions(fo) {
  if (fo == null || typeof fo !== "object") return false;
  const outcomes = fo.outcomes;
  if (!Array.isArray(outcomes)) return false;
  if (
    outcomes.length < MIN_FINDING_OUTCOMES ||
    outcomes.length > MAX_FINDING_OUTCOMES
  ) {
    return false;
  }
  return outcomes.every((o) => typeof o === "string" && o.trim().length > 0);
}

// Soft-validate the finding_options on a PHYSICAL_INSPECTION assessment. Mutates
// the assessment in place and returns it. Never throws. A non-inspection step is
// untouched; a malformed block is deleted (→ plain inspection, typed reply).
export function softValidateFindingOptions(assessment) {
  try {
    const ns = assessment?.next_step;
    if (!ns || ns.type !== "PHYSICAL_INSPECTION") return assessment;
    if (ns.finding_options == null) return assessment;
    if (!isValidFindingOptions(ns.finding_options)) {
      console.warn(
        "[diagnose-turn] PHYSICAL_INSPECTION had a malformed finding_options; dropping it, falling back to a plain inspection.",
      );
      delete ns.finding_options;
    }
  } catch (e) {
    console.warn(
      `[diagnose-turn] soft-validate of finding_options failed: ${e?.message ?? e}`,
    );
  }
  return assessment;
}
