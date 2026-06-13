// ============================================================================
// Byte-equality guard for the Stage-1 assessment prompt (Stage 2C-3).
//
// The 2C-3 refactor split ASSESS_SYSTEM_PROMPT into shared sections so
// /api/assess and /api/evidence-update can share the spine. Stage 1 is
// proven-on-a-real-car, so the Stage-1 prompt body MUST stay byte-for-byte
// identical. This asserts the composed ASSESS_BODY equals the frozen snapshot
// captured from the pre-refactor prompt (assessBody.snapshot.txt).
//
// Run: node server/scripts/verifyAssessPrompt.js   (exit 0 = pass, 1 = drift)
// Re-snapshot intentionally only when a Stage-1 prompt change is deliberate.
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ASSESS_BODY } from "../assessPrompt.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const snapshot = fs.readFileSync(path.join(dir, "assessBody.snapshot.txt"), "utf8");

if (ASSESS_BODY === snapshot) {
  console.log(`PASS: ASSESS_BODY byte-identical to snapshot (${ASSESS_BODY.length} chars)`);
  process.exit(0);
}

console.error("FAIL: ASSESS_BODY drifted from the Stage-1 snapshot.");
console.error(`  composed length=${ASSESS_BODY.length} snapshot length=${snapshot.length}`);
const n = Math.min(ASSESS_BODY.length, snapshot.length);
let i = 0;
while (i < n && ASSESS_BODY[i] === snapshot[i]) i++;
console.error(`  first difference at index ${i}:`);
console.error(`    composed: ${JSON.stringify(ASSESS_BODY.slice(Math.max(0, i - 30), i + 30))}`);
console.error(`    snapshot: ${JSON.stringify(snapshot.slice(Math.max(0, i - 30), i + 30))}`);
process.exit(1);
