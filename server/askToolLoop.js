// ----------------------------------------------------------------------------
// Ask Vulcan agentic tool loop.
//
// The execute-then-continue subsystem behind /api/ask. Ask Vulcan's spec-intent
// routing moved from a brittle adjacency regex (detectSpecIntent) to TOOL USE:
// Claude understands intent the regex can't ("oil change specs", "what oil does
// it take") and calls spec_lookup, which pulls STRICT-STORE verified rows via
// the SAME lookupSpec the regex fast-path uses — one source of truth, no
// divergence. The regex is demoted to a zero-Claude latency shortcut (handled
// in index.js); correctness no longer rides on it.
//
// This also establishes the reusable tool-loop pattern Stage 2 (Claude-directed
// live monitoring) needs. Adding a future tool is "register one entry" — append
// a definition to ASK_TOOLS and a handler to ASK_TOOL_HANDLERS; the loop itself
// does not change. No speculative tools are built here — spec_lookup only.
//
// TESTABILITY: the loop takes injected `createMessage` and `logCost` callbacks
// (no direct Anthropic SDK / cost-logger coupling) so it can be unit-tested with
// stubs — see scripts/askToolLoopTest.js.
// ----------------------------------------------------------------------------

import { lookupSpec, formatSpecContextBlock } from "./vehicleSpecs.js";

// Iteration cap on the tool loop. Env-configurable so the forced-text fallback
// path (cap reached while Claude still wants a tool) can be exercised against
// real Claude by booting with ASK_TOOL_MAX_ITERATIONS=1 — see the integration
// test. Default 3 leaves headroom for a future multi-tool question; spec_lookup
// realistically needs a single round-trip.
export const MAX_ASK_TOOL_ITERATIONS =
  Number(process.env.ASK_TOOL_MAX_ITERATIONS) || 3;

const ASK_MAX_TOKENS = 2048;

// App spec-intent vocabulary (vehicleSpecs.SPEC_TYPES values). spec_lookup only
// accepts these — the vehicle is injected server-side from request context, NOT
// a tool parameter, which keeps the parked vehicle-normalization problem parked
// and stops Claude inventing/restating a vehicle.
export const SPEC_TYPE_ENUM = [
  "oil",
  "coolant",
  "transmissionFluid",
  "brakeFluid",
  "powerSteeringFluid",
  "torque",
  "battery",
  "maintenanceInterval",
];

export const SPEC_LOOKUP_TOOL_NAME = "spec_lookup";

export const specLookupTool = {
  name: SPEC_LOOKUP_TOOL_NAME,
  description:
    "Retrieve VERIFIED factory specifications for the technician's current vehicle from Vulcan's provenance-tracked spec database. Call this whenever the technician asks for a numeric or factory specification — oil capacity/type/viscosity, coolant, transmission/brake/power-steering fluid, a torque value, battery group, or a maintenance interval — INCLUDING indirect phrasings like \"what oil does it take\", \"oil change specs\", or \"how much oil for a change\". The vehicle is supplied automatically; you only choose which spec_types to look up. If the database has a verified value it is returned for you to state directly as confirmed. If it does not, you get an explicit no-record result — then give the commonly-known figure as a likely value the technician must confirm against the OEM source, never as a confirmed factory number.",
  input_schema: {
    type: "object",
    properties: {
      spec_types: {
        type: "array",
        items: { type: "string", enum: SPEC_TYPE_ENUM },
        description:
          "One or more spec categories to look up for the current vehicle. Include every category the question touches.",
      },
    },
    required: ["spec_types"],
  },
};

// ---- spec_lookup handler ---------------------------------------------------
//
// Returns { text } — the tool_result content Claude reasons over next turn.
// HIT: verified rows rendered via the shared formatSpecContextBlock ("use these
// exactly"). MISS / NO-VEHICLE: an explicit no-record result whose TEXT CARRIES
// THE HEDGE (the "verify against OEM" framing), so the tool result — together
// with the APP_CONTEXT spec rule — is what makes a spec miss hedge, replacing
// the old injected SPEC_CAUTION_PREAMBLE.
export async function handleSpecLookup(input, ctx) {
  const vehicle = ctx?.vehicle;
  const requested = Array.isArray(input?.spec_types) ? input.spec_types : [];
  const types = [...new Set(requested)].filter((t) => SPEC_TYPE_ENUM.includes(t));

  if (types.length === 0) {
    return {
      text:
        "No valid spec category was requested. Valid categories: " +
        SPEC_TYPE_ENUM.join(", ") +
        ".",
    };
  }

  const hasVehicle =
    vehicle &&
    typeof vehicle === "object" &&
    vehicle.year &&
    vehicle.make &&
    vehicle.model;

  if (!hasVehicle) {
    // No vehicle to query against — the DB can't help. Ask for it, or hedge.
    return {
      text:
        "No vehicle (year, make, model) is set in this conversation, so the " +
        "Vulcan spec database can't be queried. Ask the technician for the year, " +
        "make, and model. If you give a commonly-known figure in the meantime, " +
        "frame it as a likely value to confirm against the OEM service manual or " +
        "the cap/label — never as a confirmed factory spec.",
    };
  }

  // Same lookupSpec the regex fast-path uses — one source of truth. lookupSpec
  // is airtight fail-soft (never throws; a DB outage or query error degrades to
  // a clean miss), so a DB-down and a genuine no-record are indistinguishable
  // here and both hedge.
  const hits = [];
  for (const specType of types) {
    const r = await lookupSpec(vehicle, specType);
    if (r && r.data) hits.push({ specType, data: r.data });
  }

  // Surface to the endpoint whether any DB component facts (the oil-filter
  // fold riders) actually reached this answer — the componentFact demand log
  // in /api/ask skips logging a miss when they did.
  if (hits.some((h) => h.data.componentFacts && h.data.componentFacts.length > 0)) {
    ctx.componentFactsServed = true;
  }

  const label = `${vehicle.year} ${vehicle.make} ${vehicle.model}`;

  if (hits.length === 0) {
    return {
      text:
        `No verified record in the Vulcan spec database for the ${label} for: ` +
        `${types.join(", ")}. Do not present a number as a confirmed factory ` +
        `spec. If you know the commonly-accepted figure, give it as a likely ` +
        `value and tell the technician to confirm it against the OEM service ` +
        `manual or the cap/label (e.g. "typically around X — verify against the ` +
        `manual"). If you don't have a reliable ballpark, say so plainly and ` +
        `point them to the OEM source.`,
    };
  }

  // formatSpecContextBlock renders the DB-shaped rows with the "use these values
  // exactly — do not substitute your own recollection" framing.
  return { text: formatSpecContextBlock(hits) };
}

export const ASK_TOOLS = [specLookupTool];
export const ASK_TOOL_HANDLERS = { [SPEC_LOOKUP_TOOL_NAME]: handleSpecLookup };

// ---- Cost accumulation -----------------------------------------------------
//
// A tool-firing turn makes >1 messages.create call. The endpoint returns ONE
// cost object (the mobile ApiCostData shape: { model, tokens, cost }), so we sum
// every call's cost into a single accumulator with that exact shape. Each
// underlying call is still logged individually into the server aggregate by
// logCost — only the value RETURNED to the client is summed.

function r6(n) {
  return Math.round(n * 1_000_000) / 1_000_000;
}

export function emptyCost(model) {
  return {
    model,
    tokens: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 },
    cost: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, total: 0 },
  };
}

export function addCost(acc, costData) {
  if (!costData) return acc; // unknown model etc. — logCost already warned
  acc.tokens.input += costData.tokens.input;
  acc.tokens.cacheWrite += costData.tokens.cacheWrite;
  acc.tokens.cacheRead += costData.tokens.cacheRead;
  acc.tokens.output += costData.tokens.output;
  acc.cost.input = r6(acc.cost.input + costData.cost.input);
  acc.cost.cacheWrite = r6(acc.cost.cacheWrite + costData.cost.cacheWrite);
  acc.cost.cacheRead = r6(acc.cost.cacheRead + costData.cost.cacheRead);
  acc.cost.output = r6(acc.cost.output + costData.cost.output);
  acc.cost.total = r6(acc.cost.total + costData.cost.total);
  return acc;
}

function extractText(response) {
  return (response?.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

// ---- The loop --------------------------------------------------------------
//
// Returns { text, cost, toolInvoked, iterations }.
//
//   createMessage(params) -> Promise<response>   (caller wraps model/retry)
//   logCost(usage)        -> costData | null      (caller binds model/callType)
//   handlers              -> { [toolName]: async (input, ctx) => { text, isError? } }
//   ctx                   -> { vehicle, toolInvoked: false }  (mutated in place)
//
// Termination is guaranteed: up to `maxIterations` tool-capable calls, then — if
// Claude is STILL requesting a tool — ONE final call with tool_choice "none" so
// the model must answer in prose. That forced answer still sees the full system
// context (APP_CONTEXT), so it inherits the spec hedge rule and will not assert
// an unverified spec as gospel.
export async function runAskToolLoop({
  createMessage,
  logCost,
  model,
  systemBlocks,
  messages,
  tools,
  handlers,
  ctx,
  maxIterations = MAX_ASK_TOOL_ITERATIONS,
  maxTokens = ASK_MAX_TOKENS,
}) {
  const convo = messages.map((m) => ({ role: m.role, content: m.content }));
  const cost = emptyCost(model);
  let iterations = 0;

  for (let i = 0; i < maxIterations; i++) {
    iterations++;
    const response = await createMessage({
      model,
      max_tokens: maxTokens,
      system: systemBlocks,
      messages: convo,
      tools,
    });
    addCost(cost, logCost(response.usage));

    if (response.stop_reason !== "tool_use") {
      return { text: extractText(response), cost, toolInvoked: ctx.toolInvoked, iterations };
    }

    // Claude requested at least one tool. Append the assistant turn verbatim
    // (tool_use blocks and any text), dispatch each tool_use, append the
    // tool_results, and loop.
    ctx.toolInvoked = true;
    convo.push({ role: "assistant", content: response.content });

    const toolResults = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      const handler = handlers[block.name];
      let result;
      try {
        if (!handler) {
          result = { text: `Unknown tool "${block.name}".`, isError: true };
        } else {
          result = await handler(block.input, ctx);
        }
      } catch (err) {
        // Handlers should be fail-soft, but guard anyway: surface the failure as
        // an error tool_result so the loop continues to a graceful answer
        // instead of throwing out to a 500.
        result = { text: `Tool "${block.name}" failed: ${err.message}`, isError: true };
      }
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: result.text,
        ...(result.isError ? { is_error: true } : {}),
      });
    }
    convo.push({ role: "user", content: toolResults });
  }

  // Cap reached and Claude still wants a tool. Force a text-only answer (tools
  // withheld via tool_choice "none") so the request can't loop forever. Cost is
  // still summed.
  iterations++;
  const finalResponse = await createMessage({
    model,
    max_tokens: maxTokens,
    system: systemBlocks,
    messages: convo,
    tools,
    tool_choice: { type: "none" },
  });
  addCost(cost, logCost(finalResponse.usage));
  return {
    text: extractText(finalResponse),
    cost,
    toolInvoked: ctx.toolInvoked,
    iterations,
  };
}
