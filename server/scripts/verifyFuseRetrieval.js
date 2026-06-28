// ============================================================================
// Fuse-legend pure-logic gate (Fix 2). Tests the no-DB helpers in fuseLegend.js:
// quote parsing, fuse-number extraction, circuit synonym expansion, row shaping
// (dedup + sort), and circuit-keyword filtering (matched vs full-legend
// fallback). No DB import -> runs anywhere.
//
//   node server/scripts/verifyFuseRetrieval.js
// ============================================================================

import {
  expandCircuit,
  parseCircuitText,
  fuseNumber,
  shapeFuseRows,
  filterByCircuit,
} from "../fuseLegend.js";

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) passed++;
  else {
    failed++;
    console.error("  ✗ " + msg);
  }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log("\n=== parseCircuitText (strip leading number + amperage) ===");
ok(parseCircuitText("4 15A AUDIO NAVI") === "AUDIO NAVI", "4 15A AUDIO NAVI -> AUDIO NAVI");
ok(parseCircuitText("1 7.5A START1") === "START1", "decimal amp: 1 7.5A START1 -> START1");
ok(parseCircuitText("2 20A 12V SOCKET") === "12V SOCKET", "keeps 12V in circuit (only leading amp stripped)");
ok(parseCircuitText("24 15 A WIPER") === "WIPER", "spaced amp: 24 15 A WIPER -> WIPER");
ok(parseCircuitText("") === "", "empty -> empty");

console.log("\n=== fuseNumber ===");
ok(fuseNumber("fuse 24") === "24", "fuse 24 -> 24");
ok(fuseNumber("fuse 1") === "1", "fuse 1 -> 1");
ok(fuseNumber("FUSE 7") === "7", "case-insensitive");

console.log("\n=== expandCircuit (synonyms) ===");
ok(expandCircuit("wipers").includes("wip"), "wipers expands to include wip");
ok(expandCircuit("wipers").includes("wsw"), "wipers expands to include wsw");
ok(expandCircuit("cigarette").includes("cigar"), "cigarette -> cigar");
ok(expandCircuit("cigarette lighter").includes("12v"), "cigarette lighter -> 12v");
ok(expandCircuit("horn").includes("horn"), "horn -> horn");
ok(eq(expandCircuit(""), []), "empty keyword -> []");
ok(expandCircuit("zxqw").length === 1, "unknown keyword -> just itself (no group)");

console.log("\n=== shapeFuseRows (dedup + numeric sort) ===");
const raw = [
  { component: "fuse 10", value_text: "7.5A", verbatim_quote: "10 7.5A UNIT IG2-1" },
  { component: "fuse 2", value_text: "20A", verbatim_quote: "2 20A 12V SOCKET" },
  { component: "fuse 2", value_text: "20A", verbatim_quote: "2 20A 12V SOCKET" }, // dup
  { component: "fuse 4", value_text: "15A", verbatim_quote: "4 15A AUDIO NAVI" },
];
const shaped = shapeFuseRows(raw);
ok(shaped.length === 3, "dedup removes the duplicate (4 -> 3)");
ok(eq(shaped.map((r) => r.fuse_number), ["2", "4", "10"]), "numeric sort 2,4,10 (not lexical 10,2,4)");
ok(shaped[2].circuit_text === "UNIT IG2-1" && shaped[2].amperage === "7.5A", "row shape parsed correctly");
ok(shaped[0].verbatim_quote === "2 20A 12V SOCKET", "verbatim preserved verbatim");

console.log("\n=== shapeFuseRow — circuit-name style (CR-V) ===");
const cn = shapeFuseRows([
  { component: "Engine Compartment Fuse - Front Wiper Motor", value_text: "30 A", verbatim_quote: "Front Wiper Motor 30 A" },
  { component: "Engine Compartment Fuse - Fuse Box 1", value_text: "60 A", verbatim_quote: "Fuse Box 1 60 A" },
]);
ok(cn[0].fuse_number === "" && cn[1].fuse_number === "", "circuit-name rows w/o leading verbatim number get NO fuse_number (no digit grabbed from 'Fuse Box 1')");
ok(cn.find((r) => r.circuit_text === "Front Wiper Motor") != null, "prefix stripped -> circuit_text 'Front Wiper Motor'");
// CR-V horn style: position lives at the START of the verbatim ("24 Horn 10 A").
const horn = shapeFuseRows([
  { component: "Engine Compartment Fuse 24 - Horn", value_text: "10 A", verbatim_quote: "24 Horn 10 A" },
])[0];
ok(horn.fuse_number === "24", "leading verbatim number -> fuse_number 24");
ok(horn.circuit_text === "Horn", "'Fuse 24 -' prefix stripped -> circuit_text 'Horn'");
const cnW = filterByCircuit(cn, "wipers");
ok(cnW.matched === true && cnW.rows.length === 1 && cnW.rows[0].circuit_text === "Front Wiper Motor", "circuit-name: 'wipers' matches via verbatim/circuit");

console.log("\n=== filterByCircuit ===");
const legend = shapeFuseRows([
  { component: "fuse 1", value_text: "10A", verbatim_quote: "1 10A HORN" },
  { component: "fuse 2", value_text: "15A", verbatim_quote: "2 15A FRONT WIPER" },
  { component: "fuse 3", value_text: "20A", verbatim_quote: "3 20A CIGAR LIGHTER" },
]);
const w = filterByCircuit(legend, "wipers");
ok(w.matched === true && w.rows.length === 1 && w.rows[0].fuse_number === "2", "wipers -> matched fuse 2 only");
const c = filterByCircuit(legend, "cigarette lighter");
ok(c.matched === true && c.rows[0].fuse_number === "3", "cigarette lighter -> matched fuse 3");
const none = filterByCircuit(legend, "spaceship");
ok(none.matched === false && none.rows.length === 3, "no-match keyword -> full legend, matched=false");
const blank = filterByCircuit(legend, "");
ok(blank.matched === false && blank.rows.length === 3, "no keyword -> full legend, matched=false");

console.log("\n================================================");
if (failed === 0) console.log(`[fuse-retrieval-test] ALL ${passed} PASSED`);
else {
  console.log(`[fuse-retrieval-test] ${failed} FAILED, ${passed} passed`);
  process.exit(1);
}
