// ----------------------------------------------------------------------------
// Deterministic unit test for the unified-turn retrieval loop (merge-plan
// Phase 5). NO Anthropic API, NO database — createMessage / logCost / handlers
// are stubbed, proving the loop MECHANICS in isolation and for free:
//   - a move tool on the first call returns immediately (1 call, no retrieval)
//   - a retrieval call dispatches its handler, appends the tool_result, and
//     re-calls; the eventual move tool is returned with retrievalInvoked=true
//   - the retrieval-round cap triggers ONE forced-move final call that carries
//     ONLY the move tools (tool_choice stays "any")
//   - a response carrying BOTH a move and a retrieval commits the MOVE and does
//     NOT execute the retrieval handler
//   - an unknown retrieval tool / a throwing handler become is_error
//     tool_results and the loop continues (no 500)
//   - cost sums across every call
//   - no tool_use at all returns toolUse:null (the endpoint 502s, as today)
//
// Behavioral proof (the real brain retrieves then commits one move; spec
// routing; spoken_summary honesty) lives in the deployed-call validation
// (the SB3 method) — this file is the mechanics gate.
//
// Run:  npm run test:turn-loop      (from server/)
// ----------------------------------------------------------------------------

process.env.SUPABASE_DB_URL =
  process.env.SUPABASE_DB_URL || "postgres://unit-test-no-connect/none";

const { runTurnToolLoop } = await import("../askToolLoop.js");

// ---- tiny assertion harness ------------------------------------------------

let passed = 0;
let failed = 0;
function check(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL  ${msg}`);
  }
}

// ---- response builders (mimic the Anthropic SDK message shape) --------------

function fakeUsage() {
  return {
    input_tokens: 10,
    output_tokens: 5,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
}
function toolResponse(...calls) {
  return {
    stop_reason: "tool_use",
    content: calls.map(([name, input], i) => ({
      type: "tool_use",
      id: `tu_${name}_${i}`,
      name,
      input,
    })),
    usage: fakeUsage(),
  };
}

const FIXED_COST = {
  model: "fake-model",
  tokens: { input: 10, cacheWrite: 0, cacheRead: 0, output: 5 },
  cost: { input: 0.1, cacheWrite: 0, cacheRead: 0, output: 0.2, total: 0.3 },
};
function fakeLogCost() {
  return { ...FIXED_COST, tokens: { ...FIXED_COST.tokens }, cost: { ...FIXED_COST.cost } };
}

// Minimal move/retrieval tool defs — the loop only reads `name`.
const MOVE_TOOLS = [
  { name: "ask_followup_question" },
  { name: "emit_diagnostic_assessment" },
  { name: "provide_diagnosis" },
];
const RETRIEVAL_TOOLS = [{ name: "spec_lookup" }, { name: "diagram_lookup" }];

const BASE_MESSAGES = [{ role: "user", content: "P0171 on a 2018 F-150" }];

function makeRunner(script) {
  // script: array of responses returned call-by-call; records each call's params.
  const calls = [];
  let i = 0;
  return {
    calls,
    createMessage: async (params) => {
      calls.push(params);
      const r = script[i];
      i++;
      if (!r) throw new Error("script exhausted");
      return r;
    },
  };
}

// ---- 1. Move tool on the first call — identical to today (1 call) -----------

console.log("\n[1] move tool on first call");
{
  const { calls, createMessage } = makeRunner([
    toolResponse(["emit_diagnostic_assessment", { stance: "AUTOPILOT" }]),
  ]);
  const specCalls = [];
  const res = await runTurnToolLoop({
    createMessage,
    logCost: fakeLogCost,
    model: "fake-model",
    maxTokens: 8192,
    systemBlocks: [],
    messages: BASE_MESSAGES,
    moveTools: MOVE_TOOLS,
    retrievalTools: RETRIEVAL_TOOLS,
    handlers: { spec_lookup: async (input) => (specCalls.push(input), { text: "rows" }) },
    ctx: { vehicle: null, toolInvoked: false },
  });
  check(res.toolUse?.name === "emit_diagnostic_assessment", "returns the move tool");
  check(res.toolUse?.input?.stance === "AUTOPILOT", "returns the move input verbatim");
  check(res.iterations === 1, `exactly one call (got ${res.iterations})`);
  check(res.retrievalInvoked === false, "retrievalInvoked=false");
  check(specCalls.length === 0, "no handler ran");
  check(Math.abs(res.cost.cost.total - 0.3) < 1e-9, `cost summed once (got ${res.cost.cost.total})`);
  check(calls[0].tools.length === 5, "first call offers move + retrieval tools");
  check(calls[0].tool_choice?.type === "any", 'tool_choice "any"');
}

// ---- 2. Retrieval then move --------------------------------------------------

console.log("\n[2] retrieval then move");
{
  const { calls, createMessage } = makeRunner([
    toolResponse(["spec_lookup", { spec_types: ["oil"] }]),
    toolResponse(["ask_followup_question", { question: "When did it start?" }]),
  ]);
  const seen = [];
  const res = await runTurnToolLoop({
    createMessage,
    logCost: fakeLogCost,
    model: "fake-model",
    maxTokens: 8192,
    systemBlocks: [],
    messages: BASE_MESSAGES,
    moveTools: MOVE_TOOLS,
    retrievalTools: RETRIEVAL_TOOLS,
    handlers: {
      spec_lookup: async (input, ctx) => {
        seen.push(input);
        ctx.componentFactsServed = true;
        return { text: "VERIFIED oil rows" };
      },
    },
    ctx: { vehicle: { year: "2018" }, toolInvoked: false },
  });
  check(res.toolUse?.name === "ask_followup_question", "eventual move returned");
  check(res.iterations === 2, `two calls (got ${res.iterations})`);
  check(res.retrievalInvoked === true, "retrievalInvoked=true");
  check(seen.length === 1 && seen[0].spec_types[0] === "oil", "handler got the tool input");
  check(Math.abs(res.cost.cost.total - 0.6) < 1e-9, `cost summed across calls (got ${res.cost.cost.total})`);
  const convo2 = calls[1].messages;
  check(convo2.length === 3, `second call sees appended turns (got ${convo2.length})`);
  check(
    convo2[1].role === "assistant" && convo2[2].role === "user" &&
      Array.isArray(convo2[2].content) && convo2[2].content[0].type === "tool_result" &&
      convo2[2].content[0].content === "VERIFIED oil rows",
    "tool_result fed back verbatim",
  );
}

// ---- 3. Cap: two retrieval rounds, then a FORCED-MOVE call -------------------

console.log("\n[3] retrieval cap -> forced-move final call");
{
  const { calls, createMessage } = makeRunner([
    toolResponse(["spec_lookup", { spec_types: ["oil"] }]),
    toolResponse(["diagram_lookup", { diagram_type: "fuse" }]),
    toolResponse(["provide_diagnosis", { root_cause: "vacuum leak" }]),
  ]);
  const res = await runTurnToolLoop({
    createMessage,
    logCost: fakeLogCost,
    model: "fake-model",
    maxTokens: 8192,
    systemBlocks: [],
    messages: BASE_MESSAGES,
    moveTools: MOVE_TOOLS,
    retrievalTools: RETRIEVAL_TOOLS,
    handlers: {
      spec_lookup: async () => ({ text: "rows" }),
      diagram_lookup: async (input, ctx) => {
        ctx.diagrams = { type: "fuse", images: [] };
        return { text: "displayed" };
      },
    },
    ctx: { vehicle: null, toolInvoked: false },
    maxRetrievalRounds: 2,
  });
  check(res.toolUse?.name === "provide_diagnosis", "move returned after cap");
  check(res.iterations === 3, `three calls (got ${res.iterations})`);
  const finalCall = calls[2];
  check(
    finalCall.tools.length === 3 && finalCall.tools.every((t) => MOVE_TOOLS.some((m) => m.name === t.name)),
    "forced final call carries ONLY the move tools",
  );
  check(finalCall.tool_choice?.type === "any", 'forced final call keeps tool_choice "any"');
  check(Math.abs(res.cost.cost.total - 0.9) < 1e-9, `cost summed across 3 calls (got ${res.cost.cost.total})`);
}

// ---- 4. Move + retrieval in ONE response: move wins, handler NOT run ---------

console.log("\n[4] move + retrieval in one response");
{
  const { createMessage } = makeRunner([
    toolResponse(
      ["spec_lookup", { spec_types: ["oil"] }],
      ["emit_diagnostic_assessment", { stance: "GUIDED" }],
    ),
  ]);
  let handlerRan = false;
  const res = await runTurnToolLoop({
    createMessage,
    logCost: fakeLogCost,
    model: "fake-model",
    maxTokens: 8192,
    systemBlocks: [],
    messages: BASE_MESSAGES,
    moveTools: MOVE_TOOLS,
    retrievalTools: RETRIEVAL_TOOLS,
    handlers: { spec_lookup: async () => ((handlerRan = true), { text: "rows" }) },
    ctx: { vehicle: null, toolInvoked: false },
  });
  check(res.toolUse?.name === "emit_diagnostic_assessment", "move wins");
  check(handlerRan === false, "stray retrieval NOT executed");
  check(res.iterations === 1, "one call");
}

// ---- 5. Unknown tool + throwing handler -> is_error, loop continues ----------

console.log("\n[5] unknown tool / throwing handler are fail-soft");
{
  const { calls, createMessage } = makeRunner([
    toolResponse(["mystery_tool", {}], ["spec_lookup", { spec_types: ["oil"] }]),
    toolResponse(["ask_followup_question", { question: "ok?" }]),
  ]);
  const res = await runTurnToolLoop({
    createMessage,
    logCost: fakeLogCost,
    model: "fake-model",
    maxTokens: 8192,
    systemBlocks: [],
    messages: BASE_MESSAGES,
    moveTools: MOVE_TOOLS,
    retrievalTools: RETRIEVAL_TOOLS,
    handlers: {
      spec_lookup: async () => {
        throw new Error("db exploded");
      },
    },
    ctx: { vehicle: null, toolInvoked: false },
  });
  check(res.toolUse?.name === "ask_followup_question", "loop survived to the move");
  const results = calls[1].messages[2].content;
  check(
    results.length === 2 && results.every((r) => r.is_error === true),
    "unknown tool AND throwing handler both fed back as is_error",
  );
}

// ---- 6. No tool_use at all -> toolUse:null (endpoint 502s) -------------------

console.log("\n[6] no tool_use -> toolUse null");
{
  const { createMessage } = makeRunner([
    { stop_reason: "end_turn", content: [{ type: "text", text: "hi" }], usage: fakeUsage() },
  ]);
  const res = await runTurnToolLoop({
    createMessage,
    logCost: fakeLogCost,
    model: "fake-model",
    maxTokens: 8192,
    systemBlocks: [],
    messages: BASE_MESSAGES,
    moveTools: MOVE_TOOLS,
    retrievalTools: RETRIEVAL_TOOLS,
    handlers: {},
    ctx: { vehicle: null, toolInvoked: false },
  });
  check(res.toolUse === null, "toolUse is null");
  check(res.iterations === 1, "stopped after the empty response");
}

// ---- summary -----------------------------------------------------------------

console.log(`\nturnToolLoopTest: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
