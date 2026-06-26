// ----------------------------------------------------------------------------
// verifyCanonicalize.js — zero-cost node gate for the §5.B / #4 resolver.
//
// Asserts free-text make/model spellings resolve to the canonical NHTSA spelling
// stored rows are keyed under, and that an unresolvable input FAILS SAFE (passes
// through unchanged — never an invented canonical that would silently mis-join).
// Uses the in-code alias seed only (no DB needed), so it runs anywhere.
//
// Run: node scripts/verifyCanonicalize.js
// ----------------------------------------------------------------------------

// canonicalVehicle.js imports db.js (whose missing-config guard exits). A dummy
// URL keeps it from exiting (the pg Pool is lazy — no connection); this gate
// uses the in-code alias seed only, no DB. Dynamic import AFTER setting env
// because static imports are hoisted above statements.
process.env.SUPABASE_DB_URL ||= "postgres://dummy:dummy@localhost:5432/dummy";
const { canonicalizeMake, normalizeModel, canonicalizeVehicle } = await import("../canonicalVehicle.js");

const makeCases = [
  // [input, expected]
  ["Chevy", "Chevrolet"],
  ["chevy", "Chevrolet"],
  ["  CHEVY ", "Chevrolet"],
  ["VW", "Volkswagen"],
  ["volkswagon", "Volkswagen"],     // common misspelling
  ["Mercedes", "Mercedes-Benz"],
  ["mercedes benz", "Mercedes-Benz"],
  ["benz", "Mercedes-Benz"],
  ["GMC", "GMC"],                   // already canonical -> passthrough
  ["Ford", "Ford"],
  ["Subaru", "Subaru"],
  ["Zorblax Motors", "Zorblax Motors"], // unknown -> FAIL-SAFE passthrough (cleaned)
  ["", ""],
];

const modelCases = [
  ["F150", "F-150"],
  ["f-150", "F-150"],
  ["F350", "F-350"],
  ["crv", "CR-V"],
  ["Sierra", "Sierra"],             // unknown -> passthrough
  ["  Impreza ", "Impreza"],
];

let fails = 0;
const check = (label, got, want) => {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}: "${got}"${ok ? "" : ` (expected "${want}")`}`);
};

console.log("--- make ---");
for (const [inp, want] of makeCases) check(`make("${inp}")`, canonicalizeMake(inp), want);
console.log("--- model ---");
for (const [inp, want] of modelCases) check(`model("${inp}")`, normalizeModel(inp), want);

console.log("--- vehicle (join consistency: free-text vs canonical resolve identically) ---");
const a = canonicalizeVehicle({ year: 2011, make: "Chevy", model: "Silverado" });
const b = canonicalizeVehicle({ year: 2011, make: "Chevrolet", model: "Silverado" });
check("free-text make joins canonical (make)", a.make, b.make);
check("free-text make joins canonical (model)", a.model, b.model);

// Fail-safe: an unaliased mismatch stays an honest miss (NOT forced to match).
const c1 = canonicalizeMake("Chevorlet"); // typo, not in alias map
check("typo NOT silently canonicalized (fail-safe)", c1, "Chevorlet");

console.log(fails === 0 ? `\nverifyCanonicalize: ALL ${makeCases.length + modelCases.length + 3} PASSED` : `\nverifyCanonicalize: ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
