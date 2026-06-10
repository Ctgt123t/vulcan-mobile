// ----------------------------------------------------------------------------
// Layer A — deterministic unit test for the Ask Vulcan tool loop.
//
// NO Anthropic API, NO database. createMessage / logCost / handlers are all
// stubbed, so this proves the loop MECHANICS in isolation and for free:
//   - dispatch finds the registered handler and feeds it the tool input
//   - the loop terminates when stop_reason != "tool_use"
//   - the iteration cap triggers ONE forced text-only final call (tool_choice
//     "none") and then terminates
//   - cost sums correctly across every call
//   - an unknown tool name and a throwing handler both become is_error
//     tool_results and the loop continues (no 500)
//   - the two DB-free branches of the real handleSpecLookup (empty types,
//     no vehicle) return the expected text
//
// Behavioral proof (Claude actually calls the tool; hits state values; misses
// hedge; fast-path unchanged; forced-cap answer still hedges) lives in the
// real-Claude integration test, askToolLoopIntegrationTest.js.
//
// Run:  npm run test:ask-loop      (from server/)
// ----------------------------------------------------------------------------

// db.js process.exit(1)s on a missing SUPABASE_DB_URL at import; askToolLoop.js
// imports vehicleSpecs -> supabaseSpecs -> db transitively. Set a dummy URL so
// the import succeeds — the pg Pool is lazy and never connects here (layer A
// uses fake handlers and never reaches a real lookupSpec/query).
process.env.SUPABASE_DB_URL =
  process.env.SUPABASE_DB_URL || "postgres://unit-test-no-connect/none";

const {
  runAskToolLoop,
  emptyCost,
  addCost,
  handleSpecLookup,
} = await import("../askToolLoop.js");

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

// ---- response builders (mimic the Anthropic SDK message shape) -------------

let usageCounter = 0;
function fakeUsage() {
  usageCounter++;
  return {
    input_tokens: 10,
    output_tokens: 5,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
}
function textResponse(text) {
  return { stop_reason: "end_turn", content: [{ type: "text", text }], usage: fakeUsage() };
}
function toolResponse(name, input, id = "tu_" + Math.random().toString(36).slice(2, 8)) {
  return {
    stop_reason: "tool_use",
    content: [{ type: "tool_use", id, name, input }],
    usage: fakeUsage(),
  };
}

// Fixed per-call cost so summing is checkable: total 0.3 per call.
const FIXED_COST = {
  model: "fake-model",
  tokens: { input: 10, cacheWrite: 0, cacheRead: 0, output: 5 },
  cost: { input: 0.1, cacheWrite: 0, cacheRead: 0, output: 0.2, total: 0.3 },
};
function fakeLogCost() {
  return FIXED_COST;
}

// Builds a createMessage stub from a scripted list of responses; when the script
// is exhausted (or when tools are withheld via tool_choice "none") it returns a
// terminal text response. Records every params object it was called with.
function scriptedCreateMessage(script, finalText = "FINAL_FORCED_ANSWER") {
  const calls = [];
  let i = 0;
  const fn = async (params) => {
    calls.push(params);
    if (params.tool_choice && params.tool_choice.type === "none") {
      return textResponse(finalText);
    }
    const next = script[i++];
    return next || textResponse(finalText);
  };
  fn.calls = calls;
  return fn;
}

const baseArgs = {
  logCost: fakeLogCost,
  model: "fake-model",
  systemBlocks: [{ type: "text", text: "SYS" }],
  messages: [{ role: "user", content: "hi" }],
  tools: [{ name: "demo_tool" }],
};

// ---- Test 1: no tool call → single call, terminates ------------------------

await (async () => {
  console.log("\n[1] no-tool single response");
  const createMessage = scriptedCreateMessage([textResponse("plain answer")]);
  const out = await runAskToolLoop({
    ...baseArgs,
    createMessage,
    handlers: {},
    ctx: { vehicle: null, toolInvoked: false },
  });
  check(out.text === "plain answer", "returns the model text");
  check(out.toolInvoked === false, "toolInvoked is false");
  check(out.iterations === 1, "exactly one iteration");
  check(Math.abs(out.cost.cost.total - 0.3) < 1e-9, "cost summed for 1 call (0.3)");
  check(createMessage.calls.length === 1, "createMessage called once");
  check(!("tool_choice" in createMessage.calls[0]), "no tool_choice forced on a normal call");
})();

// ---- Test 2: tool call then text → dispatch + continue ---------------------

await (async () => {
  console.log("\n[2] tool_use then text");
  let handlerInput = null;
  const handlers = {
    demo_tool: async (input, ctx) => {
      handlerInput = input;
      check(ctx && ctx.toolInvoked === true, "ctx.toolInvoked set true before handler runs");
      return { text: "TOOL_OUTPUT" };
    },
  };
  const createMessage = scriptedCreateMessage([
    toolResponse("demo_tool", { spec_types: ["oil"] }),
    textResponse("answer using tool data"),
  ]);
  const out = await runAskToolLoop({
    ...baseArgs,
    createMessage,
    handlers,
    ctx: { vehicle: { year: 2020, make: "Ford", model: "F-150" }, toolInvoked: false },
  });
  check(out.text === "answer using tool data", "returns the post-tool text");
  check(out.toolInvoked === true, "toolInvoked is true");
  check(out.iterations === 2, "two iterations (tool + text)");
  check(Math.abs(out.cost.cost.total - 0.6) < 1e-9, "cost summed for 2 calls (0.6)");
  check(handlerInput && handlerInput.spec_types[0] === "oil", "handler received the tool input");
  // The 2nd call's messages must include the assistant tool_use turn + a user
  // tool_result turn.
  const secondMsgs = createMessage.calls[1].messages;
  const lastTurn = secondMsgs[secondMsgs.length - 1];
  const tr = Array.isArray(lastTurn.content) ? lastTurn.content[0] : null;
  check(tr && tr.type === "tool_result" && tr.content === "TOOL_OUTPUT", "tool_result fed back to Claude");
})();

// ---- Test 3: iteration cap → forced text-only final call -------------------

await (async () => {
  console.log("\n[3] cap reached → forced final (tool_choice none)");
  const handlers = { demo_tool: async () => ({ text: "loop forever" }) };
  // Script returns tool_use indefinitely; only the tool_choice:none forced call
  // yields text.
  const createMessage = scriptedCreateMessage(
    [
      toolResponse("demo_tool", { spec_types: ["oil"] }),
      toolResponse("demo_tool", { spec_types: ["oil"] }),
      toolResponse("demo_tool", { spec_types: ["oil"] }),
    ],
    "FORCED_TEXT",
  );
  const out = await runAskToolLoop({
    ...baseArgs,
    createMessage,
    handlers,
    ctx: { vehicle: { year: 2020, make: "Ford", model: "F-150" }, toolInvoked: false },
    maxIterations: 2,
  });
  check(out.text === "FORCED_TEXT", "forced final produced text");
  check(out.toolInvoked === true, "toolInvoked is true");
  check(out.iterations === 3, "2 tool-capable iterations + 1 forced = 3");
  check(Math.abs(out.cost.cost.total - 0.9) < 1e-9, "cost summed for 3 calls (0.9)");
  const forced = createMessage.calls[createMessage.calls.length - 1];
  check(forced.tool_choice && forced.tool_choice.type === "none", "final call withholds tools (tool_choice none)");
})();

// ---- Test 4: unknown tool name → is_error, loop continues ------------------

await (async () => {
  console.log("\n[4] unknown tool name");
  const createMessage = scriptedCreateMessage([
    toolResponse("does_not_exist", {}),
    textResponse("recovered"),
  ]);
  const out = await runAskToolLoop({
    ...baseArgs,
    createMessage,
    handlers: {}, // nothing registered
    ctx: { vehicle: null, toolInvoked: false },
  });
  check(out.text === "recovered", "loop recovers and returns text (no throw)");
  const secondMsgs = createMessage.calls[1].messages;
  const tr = secondMsgs[secondMsgs.length - 1].content[0];
  check(tr.is_error === true, "unknown tool produced an is_error tool_result");
})();

// ---- Test 5: handler throws → is_error, loop continues ---------------------

await (async () => {
  console.log("\n[5] handler throws");
  const handlers = {
    demo_tool: async () => {
      throw new Error("boom");
    },
  };
  const createMessage = scriptedCreateMessage([
    toolResponse("demo_tool", {}),
    textResponse("survived"),
  ]);
  let threw = false;
  let out;
  try {
    out = await runAskToolLoop({
      ...baseArgs,
      createMessage,
      handlers,
      ctx: { vehicle: null, toolInvoked: false },
    });
  } catch {
    threw = true;
  }
  check(!threw, "loop did not throw out to a 500");
  check(out && out.text === "survived", "loop continued to a final answer");
  const tr = createMessage.calls[1].messages.slice(-1)[0].content[0];
  check(tr.is_error === true && /boom/.test(tr.content), "handler error surfaced as is_error tool_result");
})();

// ---- Test 6: addCost / emptyCost arithmetic --------------------------------

await (async () => {
  console.log("\n[6] cost accumulator");
  const acc = emptyCost("m");
  addCost(acc, FIXED_COST);
  addCost(acc, FIXED_COST);
  addCost(acc, null); // null is a no-op (unknown model)
  check(acc.tokens.input === 20 && acc.tokens.output === 10, "tokens summed; null ignored");
  check(Math.abs(acc.cost.total - 0.6) < 1e-9, "cost.total summed across 2 entries");
})();

// ---- Test 7: handleSpecLookup DB-free branches -----------------------------

await (async () => {
  console.log("\n[7] handleSpecLookup no-DB branches");
  const empty = await handleSpecLookup({ spec_types: [] }, { vehicle: { year: 2020, make: "Ford", model: "F-150" } });
  check(/no valid spec category/i.test(empty.text), "empty spec_types → 'no valid category'");

  const noVeh = await handleSpecLookup({ spec_types: ["oil"] }, { vehicle: null });
  check(/no vehicle/i.test(noVeh.text), "no vehicle → asks for year/make/model");
  check(/verify|confirm/i.test(noVeh.text) && /OEM|service manual|cap/i.test(noVeh.text), "no-vehicle text carries the hedge");

  const badType = await handleSpecLookup({ spec_types: ["banana"] }, { vehicle: { year: 2020, make: "Ford", model: "F-150" } });
  check(/no valid spec category/i.test(badType.text), "unknown spec_type filtered out → 'no valid category'");
})();

// ---- summary ---------------------------------------------------------------

console.log(`\n[ask-loop test] ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
