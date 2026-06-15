// ============================================================================
// Node gate for the Stage-3 (Step 1) finding_options soft-validator.
//
// Side-effect-free import (server/findingOptions.js never boots the server), so
// this runs as a plain node check — same convention as verifyAssessPrompt.js.
//
// Run: node server/scripts/verifyFindingOptions.js   (exit 0 = pass, 1 = fail)
// ============================================================================

import {
  isValidFindingOptions,
  softValidateFindingOptions,
} from "../findingOptions.js";

let passed = 0;
let failed = 0;
const failures = [];
function check(name, cond) {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(name);
  }
}

// ---- isValidFindingOptions matrix ----
check("valid 2 outcomes", isValidFindingOptions({ outcomes: ["a", "b"] }) === true);
check("valid 4 outcomes", isValidFindingOptions({ outcomes: ["a", "b", "c", "d"] }) === true);
check("1 outcome → invalid", isValidFindingOptions({ outcomes: ["a"] }) === false);
check("5 outcomes → invalid", isValidFindingOptions({ outcomes: ["a", "b", "c", "d", "e"] }) === false);
check("0 outcomes → invalid", isValidFindingOptions({ outcomes: [] }) === false);
check("non-array → invalid", isValidFindingOptions({ outcomes: "a,b" }) === false);
check("non-string entry → invalid", isValidFindingOptions({ outcomes: ["a", 5] }) === false);
check("empty-string entry → invalid", isValidFindingOptions({ outcomes: ["a", "  "] }) === false);
check("null → invalid", isValidFindingOptions(null) === false);
check("missing outcomes → invalid", isValidFindingOptions({}) === false);

// ---- softValidateFindingOptions: drop malformed on a PHYSICAL_INSPECTION ----
const MISSING = Symbol("missing");
function inspection(fo) {
  const next_step = { action: "check", rationale: "why", type: "PHYSICAL_INSPECTION" };
  if (fo !== MISSING) next_step.finding_options = fo;
  return { next_step };
}

check(
  "valid finding_options preserved",
  softValidateFindingOptions(inspection({ outcomes: ["a", "b"] })).next_step.finding_options != null,
);
check(
  "malformed (1 outcome) dropped → plain inspection",
  softValidateFindingOptions(inspection({ outcomes: ["a"] })).next_step.finding_options === undefined,
);
check(
  "malformed (5 outcomes) dropped",
  softValidateFindingOptions(inspection({ outcomes: ["a", "b", "c", "d", "e"] })).next_step.finding_options === undefined,
);
check(
  "malformed (non-object) dropped",
  softValidateFindingOptions(inspection("garbage")).next_step.finding_options === undefined,
);
check(
  "empty-string entry dropped",
  softValidateFindingOptions(inspection({ outcomes: ["a", ""] })).next_step.finding_options === undefined,
);
check(
  "no finding_options → untouched (no crash)",
  softValidateFindingOptions(inspection(MISSING)).next_step.finding_options === undefined,
);

// ---- other next-step types are untouched ----
check(
  "DATA_CAPTURE next step untouched",
  softValidateFindingOptions({ next_step: { type: "DATA_CAPTURE", finding_options: { outcomes: ["a"] } } }).next_step.finding_options != null,
);
check(
  "QUESTION next step untouched",
  softValidateFindingOptions({ next_step: { type: "QUESTION", finding_options: { outcomes: ["a"] } } }).next_step.finding_options != null,
);

// ---- never throws on junk ----
{
  let threw = false;
  try {
    softValidateFindingOptions(null);
    softValidateFindingOptions(undefined);
    softValidateFindingOptions({});
    softValidateFindingOptions({ next_step: null });
    softValidateFindingOptions({ next_step: { type: "PHYSICAL_INSPECTION", finding_options: 42 } });
  } catch {
    threw = true;
  }
  check("never throws on junk input", threw === false);
}

if (failed === 0) {
  console.log(`PASS: finding-options validator — ALL ${passed} checks`);
  process.exit(0);
}
console.error(`FAIL: ${failed} of ${passed + failed} finding-options checks`);
for (const f of failures) console.error(`  - ${f}`);
process.exit(1);
