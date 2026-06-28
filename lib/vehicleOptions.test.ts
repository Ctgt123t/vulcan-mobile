// ============================================================================
// vehicleOptions pure-helper gate — same harness/discipline as vin.test.ts.
// Covers filterOptions (the type-ahead filter) and yearOptions (the year range).
//
// Run from project root:
//   npx ts-node --skipProject --compiler-options "{\"module\":\"CommonJS\",\"moduleResolution\":\"node\",\"esModuleInterop\":true}" --transpile-only lib/vehicleOptions.test.ts
// ============================================================================

import { filterOptions, yearOptions } from "./vehicleOptions";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(cond: boolean, msg: string) {
  if (cond) passed++;
  else {
    failed++;
    failures.push(msg);
    console.error("  ✗ " + msg);
  }
}
function eqArr(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

console.log("\n=== filterOptions ===");
const makes = ["Ford", "Honda", "Hyundai", "Mercedes-Benz", "Mini"];
ok(eqArr(filterOptions(makes, ""), makes), "empty query returns all (unchanged)");
ok(eqArr(filterOptions(makes, "  "), makes), "whitespace-only query returns all");
ok(eqArr(filterOptions(makes, "hon"), ["Honda"]), "prefix match (hon -> Honda)");
ok(eqArr(filterOptions(makes, "H"), ["Honda", "Hyundai"]), "single-char prefix matches multiple");
ok(eqArr(filterOptions(makes, "mer"), ["Mercedes-Benz"]), "prefix match (mer -> Mercedes-Benz)");
ok(eqArr(filterOptions(makes, "benz"), []), "PREFIX does NOT match mid-string (benz -> none)");
ok(eqArr(filterOptions(["Fiat", "Ford", "Honda"], "fo"), ["Ford"]), "fo -> Ford only (the reported bug)");
ok(eqArr(filterOptions(makes, "zzz"), []), "no match -> empty");
ok(eqArr(filterOptions(makes, "MINI"), ["Mini"]), "query case ignored (MINI -> Mini)");
ok(eqArr(filterOptions([], "x"), []), "empty options -> empty");
// non-mutating
const ref = ["B", "A"];
filterOptions(ref, "a");
ok(eqArr(ref, ["B", "A"]), "does not mutate or reorder the input");

console.log("\n=== yearOptions ===");
const fixed = new Date("2026-06-28T00:00:00Z");
const ys = yearOptions(fixed);
ok(ys[0] === "2027", "newest first = currentYear+1 (2027)");
ok(ys[ys.length - 1] === "1981", "oldest = 1981");
ok(ys.length === 2027 - 1981 + 1, "contiguous count (47)");
ok(ys.every((y, i) => i === 0 || Number(ys[i - 1]) === Number(y) + 1), "strictly descending by 1");
ok(new Set(ys).size === ys.length, "no duplicate years");

console.log("\n================================================");
if (failed === 0) console.log(`[vehicle-options-test] ALL ${passed} PASSED`);
else {
  console.log(`[vehicle-options-test] ${failed} FAILED, ${passed} passed`);
  process.exit(1);
}
