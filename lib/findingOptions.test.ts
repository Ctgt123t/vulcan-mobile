// ============================================================================
// Physical-inspection outcome options — NODE TEST GATE (Stage 3, Step 1).
//
// Proves the pure reader/formatter that decides whether a turn renders finding
// buttons and how a tapped finding is serialized back. Mirrors the server's
// softValidateFindingOptions matrix so "malformed ⇒ no buttons" holds on both
// sides. Same discipline / harness as turnHistory.test.ts.
//
// Run from project root:
//   npx ts-node --skipProject --compiler-options "{\"module\":\"CommonJS\",\"moduleResolution\":\"node\",\"esModuleInterop\":true}" --transpile-only lib/findingOptions.test.ts
// ============================================================================

import type { NextStep } from "./assessmentTypes";
import {
  formatInspectionResult,
  hasFindingOptions,
  readFindingOptions,
} from "./findingOptions";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(cond: boolean, msg: string) {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(msg);
    console.log(`  FAIL: ${msg}`);
  }
}
function eq(actual: unknown, expected: unknown, msg: string) {
  ok(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${msg} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`,
  );
}
function section(name: string) {
  console.log(`\n=== ${name} ===`);
}

// Build a PHYSICAL_INSPECTION next step with the given (possibly junk)
// finding_options.outcomes. Pass `MISSING` to omit finding_options entirely.
const MISSING = Symbol("missing");
function inspection(outcomes: unknown): NextStep {
  const ns: Record<string, unknown> = {
    action: "Check the EVAP purge valve",
    rationale: "Distinguishes stuck-open from stuck-closed.",
    type: "PHYSICAL_INSPECTION",
  };
  if (outcomes !== MISSING) ns.finding_options = { outcomes };
  return ns as unknown as NextStep;
}

// ---------------------------------------------------------------------------
section("readFindingOptions — well-formed cases");
eq(readFindingOptions(inspection(["A", "B"])), ["A", "B"], "2 outcomes pass");
eq(
  readFindingOptions(inspection(["A", "B", "C"])),
  ["A", "B", "C"],
  "3 outcomes pass",
);
eq(
  readFindingOptions(inspection(["A", "B", "C", "D"])),
  ["A", "B", "C", "D"],
  "4 outcomes pass",
);
eq(
  readFindingOptions(inspection(["  Stuck open  ", " OK "])),
  ["Stuck open", "OK"],
  "outcomes are trimmed",
);
eq(
  readFindingOptions(inspection(["A", "", "  ", "B"])),
  ["A", "B"],
  "empty / whitespace outcomes are filtered (2 remain → pass)",
);
eq(
  readFindingOptions(inspection(["A", 5, "B"])),
  ["A", "B"],
  "non-string entries filtered (2 remain → pass)",
);

// ---------------------------------------------------------------------------
section("readFindingOptions — fail-soft cases (→ null, plain text)");
ok(readFindingOptions(inspection(["only-one"])) === null, "1 outcome → null");
ok(
  readFindingOptions(inspection(["A", "B", "C", "D", "E"])) === null,
  "5 outcomes → null",
);
ok(readFindingOptions(inspection([])) === null, "0 outcomes → null");
ok(readFindingOptions(inspection("A,B")) === null, "non-array outcomes → null");
ok(
  readFindingOptions(inspection(["A", 5])) === null,
  "1 valid + 1 junk → null (only 1 survives)",
);
ok(readFindingOptions(inspection(MISSING)) === null, "no finding_options → null");
ok(readFindingOptions(null) === null, "null next step → null");
ok(readFindingOptions(undefined) === null, "undefined next step → null");

// Wrong next-step type never renders buttons (the structural guarantee).
ok(
  readFindingOptions({
    action: "a",
    rationale: "r",
    type: "QUESTION",
    finding_options: { outcomes: ["A", "B"] },
  } as unknown as NextStep) === null,
  "QUESTION type with options → null (open question ⇒ no buttons)",
);
ok(
  readFindingOptions({
    action: "a",
    rationale: "r",
    type: "DATA_CAPTURE",
    finding_options: { outcomes: ["A", "B"] },
  } as unknown as NextStep) === null,
  "DATA_CAPTURE type with options → null",
);

// ---------------------------------------------------------------------------
section("hasFindingOptions mirrors readFindingOptions !== null");
ok(hasFindingOptions(inspection(["A", "B"])) === true, "well-formed → true");
ok(hasFindingOptions(inspection(["A"])) === false, "malformed → false");
ok(hasFindingOptions(inspection(MISSING)) === false, "missing → false");

// ---------------------------------------------------------------------------
section("formatInspectionResult — recognizable prefix, one source of truth");
eq(
  formatInspectionResult({ outcome: "Stuck open" }),
  "Inspection result: Stuck open",
  "outcome",
);
eq(
  formatInspectionResult({ outcome: "  Stuck open  " }),
  "Inspection result: Stuck open",
  "outcome trimmed",
);
eq(
  formatInspectionResult({ note: "cracked hose at the elbow" }),
  "Inspection result: cracked hose at the elbow",
  "free-text note",
);
eq(
  formatInspectionResult({ couldntCheck: true }),
  "Inspection result: couldn't check",
  "couldn't check",
);

// ---------------------------------------------------------------------------
console.log(`\n${"=".repeat(48)}`);
if (failed === 0) {
  console.log(`[finding-options-test] ALL ${passed} PASSED`);
} else {
  console.log(`[finding-options-test] ${failed} FAILED, ${passed} passed`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
