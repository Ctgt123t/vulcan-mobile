// ----------------------------------------------------------------------------
// verifyFuelRange.js — zero-cost node check for the #16 fuel-capacity fix.
//
// Before the fix, validateSpec's fuel_capacity branch tested
// /l|liter|litre/.test(u) FIRST — and "gal" contains the letter "l", so gallon
// values were forced into the litre range (10-230) and the dedicated /gal/
// (3-60) branch was unreachable. A sub-10-gallon tank (kei / sport bike-engine
// car) would be wrongly QUARANTINED despite a correct value + quote.
//
// This asserts gallon values now resolve to the gallon range. Imports the REAL
// validateSpec (the guarded extractor only runs main() when invoked directly,
// and a dummy SUPABASE_DB_URL keeps db.js's missing-config guard from exiting —
// the pg Pool is lazy, so no connection is attempted).
//
// Run: node scripts/verifyFuelRange.js
// ----------------------------------------------------------------------------

process.env.SUPABASE_DB_URL ||= "postgres://dummy:dummy@localhost:5432/dummy";

const { validateSpec } = await import("./extractFromPdf.js");

const Q = "fuel_capacity";
const base = { spec_type: Q, page: 451, verbatim_quote: "Fuel tank capacity ..." };

const cases = [
  // [label, spec, expectOk]
  ["9 US gal small tank now PASSES (the bug)", { ...base, value_numeric: 9, value_unit: "US gal" }, true],
  ["8.5 gal sub-10 tank PASSES",               { ...base, value_numeric: 8.5, value_unit: "gal" }, true],
  ["13.2 US gal typical tank PASSES",          { ...base, value_numeric: 13.2, value_unit: "US gal" }, true],
  ["26 gal large truck tank PASSES",           { ...base, value_numeric: 26, value_unit: "gallons" }, true],
  ["2 gal too-small still QUARANTINED",        { ...base, value_numeric: 2, value_unit: "gal" }, false],
  ["80 gal implausible still QUARANTINED",     { ...base, value_numeric: 80, value_unit: "gal" }, false],
  ["60 L litre tank PASSES (range intact)",    { ...base, value_numeric: 60, value_unit: "L" }, true],
  ["5 L too-small litre still QUARANTINED",    { ...base, value_numeric: 5, value_unit: "L" }, false],
];

let fails = 0;
for (const [label, spec, expectOk] of cases) {
  const res = validateSpec(spec);
  const pass = res.ok === expectOk;
  if (!pass) fails++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}  -> ok=${res.ok}${res.reason ? ` (${res.reason})` : ""}`);
}

console.log(fails === 0 ? `\nverifyFuelRange: ALL ${cases.length} PASSED` : `\nverifyFuelRange: ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
