// ----------------------------------------------------------------------------
// verifyBatchCRanges.js — zero-cost node check for the Batch C validator
// additions (towing_capacity, displacement, def_capacity numeric ranges, plus
// the text-typed fuel_octane / compression_ratio / def_type pass-through).
//
// Imports the REAL validateSpec (the guarded extractor only runs main() when
// invoked directly; a dummy SUPABASE_DB_URL keeps db.js's missing-config guard
// from exiting — the pg Pool is lazy, so no connection is attempted).
//
// Run: node scripts/verifyBatchCRanges.js
// ----------------------------------------------------------------------------

process.env.SUPABASE_DB_URL ||= "postgres://dummy:dummy@localhost:5432/dummy";

const { validateSpec } = await import("./extractFromPdf.js");

const base = { page: 401, verbatim_quote: "...as printed in the manual..." };
const S = (o) => ({ ...base, ...o });

const cases = [
  // --- towing_capacity (weight, printed unit kept) ---
  ["towing 11200 lb PASSES",            S({ spec_type: "towing_capacity", value_numeric: 11200, value_unit: "lb" }), true],
  ["towing 1588 kg PASSES",             S({ spec_type: "towing_capacity", value_numeric: 1588, value_unit: "kg" }), true],
  ["towing 90 lb too-small QUARANTINE", S({ spec_type: "towing_capacity", value_numeric: 90, value_unit: "lb" }), false],
  ["towing 50000 lb implausible QUAR",  S({ spec_type: "towing_capacity", value_numeric: 50000, value_unit: "lb" }), false],
  ["towing 11200 (no unit) QUARANTINE", S({ spec_type: "towing_capacity", value_numeric: 11200 }), false],

  // --- displacement ---
  ["displacement 3.5 L PASSES",         S({ spec_type: "displacement", value_numeric: 3.5, value_unit: "L" }), true],
  ["displacement 5.0 L PASSES",         S({ spec_type: "displacement", value_numeric: 5.0, value_unit: "L" }), true],
  ["displacement 1998 cc PASSES",       S({ spec_type: "displacement", value_numeric: 1998, value_unit: "cc" }), true],
  ["displacement 302 cu in PASSES",     S({ spec_type: "displacement", value_numeric: 302, value_unit: "cu in" }), true],
  ["displacement 25 L implausible QUAR",S({ spec_type: "displacement", value_numeric: 25, value_unit: "L" }), false],

  // --- def_capacity ---
  ["DEF 5.5 gal PASSES",                S({ spec_type: "def_capacity", value_numeric: 5.5, value_unit: "gal" }), true],
  ["DEF 21 L PASSES",                   S({ spec_type: "def_capacity", value_numeric: 21, value_unit: "L" }), true],
  ["DEF 200 gal implausible QUAR",      S({ spec_type: "def_capacity", value_numeric: 200, value_unit: "gal" }), false],

  // --- text-typed Batch C (value_text only; no numeric/unit) ---
  ["fuel_octane '87 octane' PASSES",    S({ spec_type: "fuel_octane", value_text: "87 octane (regular unleaded)" }), true],
  ["fuel_octane numeric 87 PASSES",     S({ spec_type: "fuel_octane", value_numeric: 87 }), true],
  ["compression_ratio '10.5:1' PASSES", S({ spec_type: "compression_ratio", value_text: "10.5:1" }), true],
  ["def_type 'DEF / ISO 22241' PASSES", S({ spec_type: "def_type", value_text: "Diesel Exhaust Fluid (ISO 22241)" }), true],
  ["fuel_octane empty QUARANTINE",      S({ spec_type: "fuel_octane" }), false],

  // --- core-rule guards still hold ---
  ["towing without quote QUARANTINE",   { spec_type: "towing_capacity", value_numeric: 11200, value_unit: "lb", page: 401, verbatim_quote: "" }, false],
];

let fails = 0;
for (const [label, spec, expectOk] of cases) {
  const res = validateSpec(spec);
  const pass = res.ok === expectOk;
  if (!pass) fails++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}  -> ok=${res.ok}${res.reason ? ` (${res.reason})` : ""}`);
}
console.log(fails === 0 ? `\nverifyBatchCRanges: ALL ${cases.length} PASSED` : `\nverifyBatchCRanges: ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
