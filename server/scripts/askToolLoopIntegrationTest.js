// ----------------------------------------------------------------------------
// Layer B — real-Claude + real-DB integration test for /api/ask tool routing.
//
// This makes REAL Anthropic calls (costs a little money) and queries the live
// Supabase spec DB. It proves the BEHAVIOR the unit test can't:
//   - Claude calls spec_lookup on phrasings the regex misses ("oil change
//     specs") and states the VERIFIED value directly, no hedge
//   - a vehicle with no DB record → tool miss → the answer HEDGES
//   - the regex fast-path still returns a card with cost == null (zero Claude)
//   - a no-vehicle spec ask hedges
//   - a non-spec question answers normally
//
// External signal used to tell the paths apart (we only get {text, cost} back):
//   - cost === null  → NO Claude call happened → the regex fast-path served it.
//   - cost !== null  → Claude was called. Combined with a missed-by-regex
//     phrasing, a correct value in the text proves the TOOL path handled it.
//
// PREREQUISITES
//   1. Server running locally against the real DB + ANTHROPIC_API_KEY:
//        (cmd, from server\)  npm start
//   2. The 2020 Ford F-150 oil rows must exist in the spec DB (the known case).
//   3. BASE_URL env if not http://localhost:3000.
//
// RUN — two passes (from server\, cmd):
//   A) normal path (cap default 3):
//        npm run test:ask-loop:integration
//   B) FORCED-CAP path — proves the forced text-only final answer still hedges
//      via APP_CONTEXT (decision #3). Boot a second server instance with the cap
//      at 1 so every tool-firing question hits the forced final, then run again:
//        set ASK_TOOL_MAX_ITERATIONS=1&& npm start            (server window)
//        npm run test:ask-loop:integration                    (test window)
//      Under cap=1, the hit case must still state the value and the miss/
//      no-vehicle cases must still hedge — all via the forced final call.
//
// The three-path hedge proof that gates deleting SPEC_CAUTION_PREAMBLE:
//   (a) tool miss            → case "miss hedges"
//   (b) regex fast-path miss → case "fast-path miss hedges" (in-context phrasing
//        that detectSpecIntent fires on but the DB misses — uses a no-data vehicle)
//   (c) no-vehicle ask       → case "no-vehicle hedges"
// All three must PASS with the preamble removed before deletion. This script is
// run once WITH the preamble (baseline) and once after removing it (proof).
// ----------------------------------------------------------------------------

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const IN_DB_VEHICLE = { year: 2020, make: "Ford", model: "F-150" };
// A vehicle the DB will not have (drives the honest miss/hedge path).
const NO_DATA_VEHICLE = { year: 1998, make: "Yugo", model: "Koral" };

let passed = 0;
let failed = 0;
function check(cond, msg, detail) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL  ${msg}`);
    if (detail) console.error(`        ${detail}`);
  }
}

async function ask(question, vehicle) {
  const body = { messages: [{ role: "user", content: question }] };
  if (vehicle) body.vehicle = vehicle;
  const res = await fetch(`${BASE_URL}/api/ask`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`/api/ask ${res.status}: ${errText}`);
  }
  return res.json();
}

// Heuristics over free-form Claude text.
function statesOilValue(t) {
  return (
    /\b\d+(\.\d+)?\s*(qt|quarts?|l|liters?)\b/i.test(t) || // capacity
    /\b\d+w-?\d+\b/i.test(t) // viscosity, e.g. 5W-30 / 0w20
  );
}
// A genuine "go verify this, I don't have it confirmed" hedge. Deliberately
// does NOT match bare "confirmed"/"confirm" — a tool-HIT answer states data AS
// confirmed ("confirmed specs from the owner's manual"), which is the opposite
// of a hedge. We require an explicit verify INSTRUCTION or a no-confirmed-data
// admission, paired with a pointer to where to confirm.
function hedges(t) {
  const verifyInstruction =
    /\bverify\b|confirm (it|this|that|against|with)|check (it|the|against|with|whatever)|cross[- ]?reference/i.test(t);
  const admitsUnconfirmed =
    /(don'?t have|do not have|no verified|not (confirmed|certain|sure)|ballpark|likely (value|figure)|typically (around|about))/i.test(t);
  const pointsToSource =
    /(service manual|owner'?s manual|workshop manual|documentation|oem|cap|label|spec sheet|dealer)/i.test(t);
  return (verifyInstruction || admitsUnconfirmed) && pointsToSource;
}
// Tool-HIT proof: the verified rows reached the answer (attribution to the
// manual / verified data), and it does not wholesale-disclaim having the data.
function citesVerifiedSource(t) {
  return /(owner'?s manual|verified data|confirmed|from the manual)/i.test(t);
}
function wholesaleDisclaims(t) {
  return /(i (don'?t|do not) have|no verified (specs|data)).{0,40}(any|the|this)?\s*(data|figure|spec|info)/i.test(t);
}

function show(label, r) {
  const costNote = r.cost ? `cost=$${r.cost.cost.total}` : "cost=null";
  console.log(`    [${label}] ${costNote}\n      ${r.text.replace(/\n/g, "\n      ")}`);
}

console.log(`\n[ask-loop integration] target ${BASE_URL}\n`);

try {
  // --- Fast-path unchanged: regex fires + DB hit → card, NO Claude call ------
  {
    console.log("[fast-path] 'oil capacity' on in-DB 2020 F-150");
    const r = await ask("What is the engine oil capacity?", IN_DB_VEHICLE);
    show("fast-path", r);
    check(r.cost === null, "fast-path made NO Claude call (cost === null)", `cost=${JSON.stringify(r.cost)}`);
    check(statesOilValue(r.text), "fast-path card states a value");
    check(/source/i.test(r.text), "fast-path card has a source footer");
  }

  // --- Tool path: regex MISSES the phrasing, DB has data → states value ------
  for (const q of [
    "what are the oil change specs?",
    "how much should I put in when I do an oil change?",
  ]) {
    console.log(`\n[tool-hit] '${q}' on in-DB 2020 F-150`);
    const r = await ask(q, IN_DB_VEHICLE);
    show("tool-hit", r);
    check(r.cost !== null, "Claude was called (cost !== null) — regex did not short-circuit", `cost=${JSON.stringify(r.cost)}`);
    check(statesOilValue(r.text), "tool-hit states the verified value directly");
    check(citesVerifiedSource(r.text), "tool-hit cites verified data / the manual (tool rows reached the answer)");
    check(!wholesaleDisclaims(r.text), "tool-hit does NOT wholesale-disclaim having the data");
  }

  // --- (a) tool miss hedges: spec question, vehicle absent from DB -----------
  {
    console.log("\n[miss-hedge] oil specs on a vehicle with no DB record");
    const r = await ask("what are the oil change specs?", NO_DATA_VEHICLE);
    show("miss-hedge", r);
    check(r.cost !== null, "Claude was called");
    check(hedges(r.text), "tool MISS hedges (verify against OEM)");
  }

  // --- (b) regex fast-path miss hedges: detectSpecIntent fires, DB misses ----
  {
    console.log("\n[fastpath-miss-hedge] 'oil capacity' on a no-DB vehicle (regex fires, DB miss)");
    const r = await ask("What is the oil capacity?", NO_DATA_VEHICLE);
    show("fastpath-miss-hedge", r);
    check(r.cost !== null, "regex-hit + DB-miss fell through to Claude (cost !== null)");
    check(hedges(r.text), "regex fast-path miss hedges");
  }

  // --- (c) no-vehicle ask hedges ---------------------------------------------
  {
    console.log("\n[no-vehicle-hedge] spec question with no vehicle set");
    const r = await ask("how many quarts of oil for an oil change?", null);
    show("no-vehicle-hedge", r);
    check(hedges(r.text) || /year.*make.*model|make.*model.*year|what vehicle/i.test(r.text), "no-vehicle ask hedges or asks for the vehicle");
  }

  // --- Non-spec: normal answer, no tool needed -------------------------------
  {
    console.log("\n[non-spec] 'how does an EGR valve work' (should NOT need the tool)");
    const r = await ask("How does an EGR valve work?", IN_DB_VEHICLE);
    show("non-spec", r);
    check(r.text.length > 40, "non-spec returns a substantive answer");
    console.log("    NOTE: confirm in server logs there is NO '[ask] tool fired' line for this one.");
  }
} catch (err) {
  console.error(`\n[ask-loop integration] ERROR: ${err.message}`);
  console.error("Is the server running? (npm start, from server\\)");
  process.exit(2);
}

console.log(`\n[ask-loop integration] ${passed} passed, ${failed} failed`);
console.log(
  "Reminder: run a second pass with ASK_TOOL_MAX_ITERATIONS=1 to prove the forced-cap final answer hedges/states-values via APP_CONTEXT.",
);
process.exit(failed === 0 ? 0 : 1);
