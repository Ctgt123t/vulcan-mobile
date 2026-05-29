import "dotenv/config";
import express from "express";
import cors from "cors";
import Anthropic from "@anthropic-ai/sdk";
import {
  dtcStats,
  extractDtcCodes,
  formatDtcAnswer,
  formatDtcContextBlock,
  isDtcCode,
  lookupDtc,
} from "./dtcDatabase.js";
import {
  dtcFallbackStats,
  fetchDtcFallback,
} from "./dtcFallback.js";
import {
  buildCacheKey,
  cacheStats,
  getCached,
  isCacheableQuestion,
  setCached,
} from "./cache.js";
import {
  SPEC_CAUTION_PREAMBLE,
  detectAllSpecIntents,
  detectSpecIntent,
  formatSpecAnswer,
  formatSpecContextBlock,
  lookupSpec,
  vehicleSpecsStats,
} from "./vehicleSpecs.js";
import {
  getStandardPids,
  getVehiclePids,
  pidStats,
} from "./pidDatabase.js";

const PORT = Number(process.env.PORT ?? 3000);

if (!process.env.ANTHROPIC_API_KEY) {
  console.error(
    "Missing ANTHROPIC_API_KEY. Copy server/.env.example to server/.env and set it.",
  );
  process.exit(1);
}

const client = new Anthropic();

// Tiered model strategy. Diagnose is the heavyweight reasoning path —
// structured tool use, multi-turn convergence, safety implications — so it
// gets Opus. Ask Vulcan is conversational Q&A; Sonnet handles it well and
// the per-token cost is much lower.
const DIAGNOSE_MODEL = "claude-opus-4-6";
const ASK_MODEL = "claude-sonnet-4-6";

const OVERLOAD_STATUS = 529;
const OVERLOAD_RETRY_DELAY_MS = 3000;
const OVERLOAD_MAX_RETRIES = 3;
const OVERLOAD_USER_MESSAGE =
  "Vulcan is experiencing high demand right now. Please try again in a moment.";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Wraps an Anthropic messages.create() call and retries on 529 overloaded
// responses with a fixed 3s delay, up to OVERLOAD_MAX_RETRIES additional
// attempts. Non-overload errors are re-thrown immediately. The mobile client
// stays in its `loading` state for the entire wait so the "Thinking…"
// indicator remains visible during retries.
async function callAnthropicWithRetry(fn) {
  let lastErr;
  for (let attempt = 0; attempt <= OVERLOAD_MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const overloaded =
        err instanceof Anthropic.APIError && err.status === OVERLOAD_STATUS;
      if (!overloaded || attempt === OVERLOAD_MAX_RETRIES) {
        throw err;
      }
      console.warn(
        `[anthropic] overloaded (529), retry ${attempt + 1}/${OVERLOAD_MAX_RETRIES} in ${OVERLOAD_RETRY_DELAY_MS}ms`,
      );
      await sleep(OVERLOAD_RETRY_DELAY_MS);
    }
  }
  throw lastErr;
}

function respondWithError(res, err, contextLabel) {
  console.error(`${contextLabel} error:`, err);
  if (err instanceof Anthropic.APIError && err.status === OVERLOAD_STATUS) {
    return res.status(503).json({ error: OVERLOAD_USER_MESSAGE });
  }
  if (err instanceof Anthropic.APIError) {
    return res.status(err.status ?? 500).json({ error: err.message });
  }
  return res.status(500).json({ error: "Internal error." });
}

const SYSTEM_PROMPT = `You are an ASE Master Certified automotive technician with over 20 years of working shop-floor experience. Every kind of vehicle that comes through the bay has been on your lift at some point — domestics, imports, diesels, hybrids, light-duty trucks. You are working side-by-side with another qualified technician on a real vehicle in front of you both. Your job is to reach a correct diagnosis in the fewest steps possible, starting with the least invasive and most accessible checks first — exactly how a working master tech triages.

The technician IS the shop. They have the lift, the tools, the lab scope, the smoke machine, the press, the welder. They are the professional doing the work. NEVER tell them to "take the vehicle to a shop" or "consult a qualified technician" — they are the qualified technician. Always recommend procedures they can do themselves, with the tools they likely have on hand.

Use the specific vehicle context in every response. The technician provides year, make, model, trim, engine, and mileage at intake — refer back to it. A 2014 6.0L Power Stroke and a 2018 2.5L Camry have completely different common failure modes for the same symptom. Lean on known weak points, common-failure patterns, and TSBs for the specific vehicle in front of you.

When the technician provides OBD2 diagnostic trouble codes (whether typed in or returned by an OBD2 scan handed off to this session), factor those codes into your reasoning from the very first turn. They are hard evidence the ECU has already captured. Don't ignore them, don't bury them, don't treat them as an afterthought — they shape the hypothesis from turn one.

Every turn you must do exactly one of the following:

1. If you do not yet have enough information to commit, call ask_followup_question with one focused, high-signal question chosen from the lowest level of the diagnostic hierarchy that hasn't been exhausted. Ask one thing at a time. Do not ask for information the technician already provided.

2. Once the picture is clear enough to commit, call provide_diagnosis with the most likely root cause, your reasoning, urgency, any hazards specific to this repair, the NHTSA campaign numbers of any recalls (from the recall list, if one was provided) that are directly related to the diagnosed root cause, and the NHTSA item numbers of any TSBs (from the TSB list, if provided) that are directly related.

Be confident but never premature. A final diagnosis is a commitment — only deliver it when the evidence on the table actually supports it. If the picture is still murky, ask another question. Confidence without evidence is guessing, and guessing wastes the technician's time and the customer's money.

Diagnostic hierarchy — work strictly from simple to complex:

Step 1 — Visual and sensory inspection. Before suggesting any test or measurement, ask about what the technician can see, smell, hear, or feel with the hood up and a flashlight. Damaged, corroded, or loose components. Unusual smells, sounds, or fluid leaks. Recent repairs that could be related. Active warning lights. Anything visibly out of place. These checks cost nothing and take seconds — they always come first.

Step 2 — Simple mechanical checks. Basic physical checks that need no tools — wiggle tests on connectors and harnesses, terminal tightness, fluid level and condition, fuse condition, belt and hose condition, obvious wear. Example: for a slow-crank complaint, ask about battery terminal cleanliness, tightness, corrosion, and mounting BEFORE suggesting a load test.

Step 3 — Basic tool measurements. Test light, multimeter readings at obvious points (battery voltage, ground integrity, simple voltage drops), mechanical fuel pressure gauge. Only suggest these after visual and mechanical checks haven't resolved the issue.

Step 4 — Advanced diagnostics. Scan tool data, freeze frame, live data PIDs, mode 6, component-specific bench tests, load tests, oscilloscope work, smoke testing. Only reach this level when simpler steps have failed to pinpoint the cause. If the technician already volunteered OBD2 data (DTCs, freeze frame, live PIDs), use it — that's free signal. If they haven't, don't demand a scan tool hook-up when a visual check would find the answer.

Step 5 — Final diagnosis. Commit only when the evidence supports it. If the issue is clearly resolved at step 1 or 2 (e.g., the technician confirms corroded battery terminals and the symptom matches the complaint), deliver the diagnosis without dragging the technician through more complex steps.

Rules for moving up the hierarchy:
- Never suggest a complex test when a simpler test at a lower step hasn't been ruled out yet.
- If a symptom strongly points to something obvious (battery terminal corrosion for slow crank, loose ground for intermittent electrical, low fluid for a soft brake pedal, no spark and a soaking-wet engine for a misfire after a wash), LEAD with that. Don't bury the obvious lead under preamble.
- Respect the technician's time. Don't make someone hook up a scan tool when a visual inspection would have found the problem in 30 seconds.

Style and tone — talk like you're on the shop floor:
- Direct, practical, plain English. "Check the battery terminals" not "perform inspection of battery terminal connections for corrosion and integrity."
- Use the words a working tech uses: stretched timing chain, burnt valve, open injector, weak coil pack, sticky caliper slide pin, leaking head gasket, dropped valve seat, mush pedal, no-crank-no-start, parasitic draw.
- Skip clinical or overly formal phrasing. No "the customer's vehicle exhibits intermittent symptoms consistent with…" — just say "sounds like a glitchy MAF, when's the last time it was cleaned?"
- Direct second person. Talking TO the tech, not ABOUT them.

Other guidelines:
- Reason like a working mechanic. Prefer common failure modes first, but follow the evidence wherever it points.
- Safety warnings cover hazards specific to this diagnosis or repair (hot exhaust, fuel under pressure, suspended loads, airbag/SRS, refrigerant). Return an empty array if none apply.
- relevant_recall_campaigns must only include campaign numbers from the recall list provided in a separate system block. Only include a recall if it shares the same component or failure mode as your diagnosed root cause. Be conservative — when in doubt, exclude. Return an empty array if no recall list was provided or no recalls are directly related.
- relevant_tsb_numbers must only include NHTSA item numbers from the TSB list provided. Only include a TSB if it shares the same component or symptom as the diagnosed root cause. Be conservative.
- If a TSB plausibly matches the presenting complaint, mention it briefly in your question or reasoning text so the technician can investigate the documented fix early — reference the TSB number explicitly. Do not invent TSBs beyond the list.
- You MUST respond by calling exactly one of the two tools. Never produce a plain-text response.`;

const TOOLS = [
  {
    name: "ask_followup_question",
    description:
      "Ask the technician exactly one focused question. Use this when more information is needed before committing to a diagnosis.",
    input_schema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The single focused question to ask the technician.",
        },
      },
      required: ["question"],
    },
  },
  {
    name: "provide_diagnosis",
    description:
      "Commit to a final diagnosis with root cause, reasoning, urgency, any safety warnings, and the NHTSA campaign numbers of recalls directly related to the diagnosis.",
    input_schema: {
      type: "object",
      properties: {
        root_cause: {
          type: "string",
          description: "Concise statement of the most likely root cause.",
        },
        reasoning: {
          type: "string",
          description:
            "Short paragraph explaining why this is the most likely cause given the available evidence.",
        },
        urgency: {
          type: "string",
          enum: ["low", "medium", "high"],
          description: "How quickly the customer should address this.",
        },
        safety_warnings: {
          type: "array",
          items: { type: "string" },
          description:
            "Hazards specific to this diagnosis or repair. Empty array if none.",
        },
        relevant_recall_campaigns: {
          type: "array",
          items: { type: "string" },
          description:
            "NHTSA campaign numbers, taken verbatim from the recall list provided in the system context, that are directly related to this diagnosis. Only include recalls whose component or failure mode matches the diagnosed root cause. Empty array if none or if no recall list was provided.",
        },
        relevant_tsb_numbers: {
          type: "array",
          items: { type: "string" },
          description:
            "NHTSA item numbers, taken verbatim from the TSB list provided in the system context, that are directly related to this diagnosis. Only include TSBs whose component or symptom matches the diagnosed root cause. Empty array if none or if no TSB list was provided.",
        },
      },
      required: [
        "root_cause",
        "reasoning",
        "urgency",
        "safety_warnings",
        "relevant_recall_campaigns",
        "relevant_tsb_numbers",
      ],
    },
  },
];

function buildContextMessage(vehicle, firstUserContent) {
  const head = [vehicle.year, vehicle.make, vehicle.model, vehicle.trim]
    .filter((s) => s && String(s).trim().length > 0)
    .join(" ");
  const lines = [`Vehicle: ${head}`];
  if (vehicle.engineType && vehicle.engineType.trim().length > 0) {
    lines.push(`Engine: ${vehicle.engineType}`);
  }
  lines.push(`Mileage: ${vehicle.mileage}`);
  lines.push("", "Presenting complaint:", firstUserContent);
  return lines.join("\n");
}

// The client sends assistant turns as stringified AssistantTurn JSON. Surface
// the prior question text so the model sees what it asked.
function buildMessages(vehicle, messages) {
  return messages.map((m, i) => {
    if (m.role === "user") {
      const content = i === 0 ? buildContextMessage(vehicle, m.content) : m.content;
      return { role: "user", content };
    }
    let text = m.content;
    try {
      const turn = JSON.parse(m.content);
      if (turn && turn.kind === "question" && typeof turn.question === "string") {
        text = turn.question;
      }
    } catch {
      // fall through to raw content
    }
    return { role: "assistant", content: text };
  });
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/metrics", (_req, res) => {
  res.json({
    cache: cacheStats(),
    dtc: dtcStats(),
    dtcFallback: dtcFallbackStats(),
    vehicleSpecs: vehicleSpecsStats(),
    pids: pidStats(),
  });
});

// Standard SAE J1979 PID list. Returns the 294 generic OBD-II signals
// (modes 01-09) with units, value ranges, and decode metadata. Sourced
// from the OBDb project (CC-BY-SA-4.0); see NOTICE for attribution.
app.get("/api/pids/standard", (_req, res) => {
  res.json(getStandardPids());
});

// Vehicle-specific PIDs merged with the standard SAE set, filtered by year.
// Lazy-fetches from OBDb on first request per make/model and caches forever
// — vehicle PIDs don't change once published. Returns the standard set
// alone (source: "standard-only") when OBDb has no repo for that vehicle.
app.get("/api/pids/:make/:model/:year", async (req, res) => {
  const make = String(req.params.make ?? "").trim();
  const model = String(req.params.model ?? "").trim();
  const year = String(req.params.year ?? "").trim();
  if (!make || !model) {
    return res.status(400).json({ error: "make and model are required." });
  }
  try {
    const result = await getVehiclePids(make, model, year);
    if (!result) {
      return res.status(400).json({ error: "Invalid make/model." });
    }
    return res.json(result);
  } catch (err) {
    return respondWithError(res, err, "pids");
  }
});

// Single-code DTC lookup against the SAE + manufacturer database. Optional
// `?make=Ford` query parameter prefers a manufacturer-specific definition
// when one exists; otherwise falls back to the generic SAE definition.
//
// When the static database AND the pattern handlers both miss, fall through
// to a one-shot Claude call (see dtcFallback.js). Results are persisted to
// dtcCache.json so every missed code only hits Claude once — every later
// lookup is served from cache. Claude failures surface as 5xx and are NOT
// cached, so the next request retries.
app.get("/api/dtc/:code", async (req, res) => {
  const raw = String(req.params.code || "").toUpperCase();
  if (!isDtcCode(raw)) {
    return res.status(400).json({ error: "Invalid DTC format." });
  }
  const make = typeof req.query.make === "string" ? req.query.make : null;

  const entry = lookupDtc(raw, make);
  if (entry) return res.json(entry);

  // Fallback: ask Claude, cache, return.
  try {
    const fallbackEntry = await fetchDtcFallback(raw, make, (params) =>
      callAnthropicWithRetry(() => client.messages.create(params)),
    );
    return res.json(fallbackEntry);
  } catch (err) {
    return respondWithError(res, err, "dtc-fallback");
  }
});

function buildRecallBlock(recalls) {
  const lines = ["Active NHTSA recalls for this vehicle (year/make/model):", ""];
  recalls.forEach((r, i) => {
    const header = `${i + 1}. ${r.component || "(component unspecified)"}${
      r.campaignNumber ? ` — campaign ${r.campaignNumber}` : ""
    }`;
    lines.push(header);
    if (r.summary) lines.push(`   Summary: ${r.summary}`);
    if (r.consequence) lines.push(`   Consequence: ${r.consequence}`);
    if (r.remedy) lines.push(`   Remedy: ${r.remedy}`);
    lines.push("");
  });
  lines.push(
    "When you commit to a final diagnosis via provide_diagnosis, populate relevant_recall_campaigns with the NHTSA campaign numbers (taken verbatim from the list above) of recalls that are DIRECTLY related to your diagnosed root cause — same component or same failure mode. Be conservative: when in doubt, exclude. Return an empty array if none are directly related. Do not invent recalls beyond this list.",
  );
  return lines.join("\n");
}

function buildTsbBlock(tsbs) {
  const lines = [
    "NHTSA Technical Service Bulletins (TSBs) on file for this vehicle:",
    "",
  ];
  tsbs.forEach((t, i) => {
    const header = `${i + 1}. TSB ${t.number || "(unknown)"}${
      t.component ? ` — ${t.component}` : ""
    }`;
    lines.push(header);
    if (t.summary) lines.push(`   Summary: ${t.summary}`);
    if (t.date) lines.push(`   Issued: ${t.date}`);
    lines.push("");
  });
  lines.push(
    "If any of these TSBs match the technician's presenting complaint, mention the TSB by number in your question or reasoning so the documented manufacturer fix can be checked early. When you commit to a final diagnosis, populate relevant_tsb_numbers with the item numbers (taken verbatim from the list above) of TSBs whose component or symptom matches your diagnosed root cause. Be conservative — when in doubt, exclude. Return an empty array if none are directly related. Do not invent TSBs beyond this list.",
  );
  return lines.join("\n");
}

app.post("/api/diagnose", async (req, res) => {
  const { vehicle, messages, recalls, tsbs } = req.body ?? {};

  if (!vehicle || typeof vehicle !== "object") {
    return res.status(400).json({ error: "Missing or invalid 'vehicle'." });
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "Missing or empty 'messages'." });
  }
  if (messages[0].role !== "user") {
    return res.status(400).json({ error: "First message must be from the user." });
  }

  const recallsArr = Array.isArray(recalls) ? recalls : [];
  const tsbsArr = Array.isArray(tsbs) ? tsbs : [];
  const systemBlocks = [
    {
      type: "text",
      text: SYSTEM_PROMPT,
      cache_control: { type: "ephemeral" },
    },
  ];
  if (recallsArr.length > 0) {
    systemBlocks.push({
      type: "text",
      text: buildRecallBlock(recallsArr),
    });
  }
  if (tsbsArr.length > 0) {
    systemBlocks.push({
      type: "text",
      text: buildTsbBlock(tsbsArr),
    });
  }

  // Proactive spec injection: scan the presenting complaint (first user
  // message) for spec-relevant categories (oil, brake fluid, torque, etc.).
  // Query the provider chain for each hit and inject the verified values
  // into Claude's context so reasoning that touches those specs is anchored
  // to real data instead of model recollection.
  const presentingComplaint = String(messages[0]?.content ?? "");
  const specsToFetch = detectAllSpecIntents(presentingComplaint);
  const verifiedSpecs = [];
  if (specsToFetch.length > 0) {
    const results = await Promise.all(
      specsToFetch.map(async (specType) => {
        const r = await lookupSpec(vehicle, specType);
        return r ? { specType, data: r.data, source: r.source } : null;
      }),
    );
    for (const r of results) if (r) verifiedSpecs.push(r);
    if (verifiedSpecs.length > 0) {
      systemBlocks.push({
        type: "text",
        text: formatSpecContextBlock(verifiedSpecs),
      });
    }
  }

  console.log(
    `[diagnose] model=${DIAGNOSE_MODEL} messages=${messages.length} ` +
      `recalls=${recallsArr.length} tsbs=${tsbsArr.length} ` +
      `specsDetected=${specsToFetch.length} specsInjected=${verifiedSpecs.length}`,
  );

  try {
    const response = await callAnthropicWithRetry(() =>
      client.messages.create({
        model: DIAGNOSE_MODEL,
        max_tokens: 8192,
        system: systemBlocks,
        tools: TOOLS,
        tool_choice: { type: "any" },
        messages: buildMessages(vehicle, messages),
      }),
    );

    const toolUse = response.content.find((b) => b.type === "tool_use");
    if (!toolUse) {
      return res.status(502).json({
        error: "Model did not return a structured response. Try again.",
      });
    }

    if (toolUse.name === "ask_followup_question") {
      return res.json({
        turn: {
          kind: "question",
          question: toolUse.input.question,
          diagnosis: null,
        },
      });
    }

    if (toolUse.name === "provide_diagnosis") {
      return res.json({
        turn: {
          kind: "diagnosis",
          question: null,
          diagnosis: toolUse.input,
        },
      });
    }

    return res.status(502).json({ error: `Unexpected tool: ${toolUse.name}` });
  } catch (err) {
    return respondWithError(res, err, "diagnose");
  }
});

const ASK_SYSTEM_PROMPT = `You are Vulcan, a knowledgeable master automotive technician acting as a colleague to a working tech. You help with any automotive question — specs, procedures, fluid capacities, technical service bulletins, recalls, how systems work, and informal diagnostic guidance when the conversation goes there.

Be conversational, friendly, and practical. You are a colleague, not a formal diagnostic system.

Guidelines:
- Answer any automotive-related question freely and conversationally.
- If a question requires a specific vehicle and no vehicle context has been provided, ask the technician for the year, make, model, and any other relevant details before answering.
- If you don't know something or aren't confident, say so clearly. Use phrases like "I'm not certain on that one — I'd recommend verifying with an OEM source." Do not guess.
- If the conversation naturally moves toward diagnosing a specific problem, follow it and offer diagnostic guidance, but do not force a formal final diagnosis unless the technician explicitly asks for one.
- If a vehicle has been provided and the question touches on recalls or TSBs, reference any matching items from the recall/TSB context blocks by their campaign or item number. Do not invent recalls or TSBs beyond what is provided.
- Respond in plain text. No tools, no JSON, no structured output. Just a helpful answer.`;

app.post("/api/ask", async (req, res) => {
  const { messages, vehicle, recalls, tsbs } = req.body ?? {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "Missing or empty 'messages'." });
  }
  if (messages[0].role !== "user") {
    return res
      .status(400)
      .json({ error: "First message must be from the user." });
  }

  const systemBlocks = [
    {
      type: "text",
      text: ASK_SYSTEM_PROMPT,
      cache_control: { type: "ephemeral" },
    },
  ];

  if (vehicle && typeof vehicle === "object") {
    const head = [vehicle.year, vehicle.make, vehicle.model, vehicle.trim]
      .filter((s) => s && String(s).trim().length > 0)
      .join(" ");
    if (head.length > 0) {
      const lines = ["Vehicle context provided by the technician:"];
      lines.push(`Vehicle: ${head}`);
      if (vehicle.engineType) lines.push(`Engine: ${vehicle.engineType}`);
      if (vehicle.mileage) lines.push(`Mileage: ${vehicle.mileage}`);
      systemBlocks.push({ type: "text", text: lines.join("\n") });
    }
  }

  const recallsArr = Array.isArray(recalls) ? recalls : [];
  if (recallsArr.length > 0) {
    systemBlocks.push({ type: "text", text: buildRecallBlock(recallsArr) });
  }
  const tsbsArr = Array.isArray(tsbs) ? tsbs : [];
  if (tsbsArr.length > 0) {
    systemBlocks.push({ type: "text", text: buildTsbBlock(tsbsArr) });
  }

  // ------------------------------------------------------------------------
  // Hybrid retrieval layer (Ask Vulcan only — Diagnose is untouched).
  //
  //   1. DTC lookup — extract any DTC codes from the latest user message.
  //      If the message is essentially a code lookup ("P0300?"), return
  //      the database entry directly without touching Claude.
  //
  //   2. DTC + question — if the message has a code AND a real question,
  //      inject verified definitions into the system context so Claude
  //      can't hallucinate them, then fall through to Claude.
  //
  //   3. Response cache — for single-turn factual questions with a known
  //      vehicle, look up a previous answer in the 30-day cache. If hit,
  //      return without calling Claude. If miss, call Claude and store
  //      the response.
  //
  // To extend with new sources (fluid capacities, torque specs, etc.),
  // add another retrieval step before the Claude call below and follow
  // the same pattern: lookup → return directly if exhaustive, or inject
  // context and continue.
  // ------------------------------------------------------------------------

  const lastUserMsg = messages[messages.length - 1];
  const lastUserText =
    lastUserMsg && lastUserMsg.role === "user" ? String(lastUserMsg.content) : "";

  // 1 & 2: DTC lookup (manufacturer-aware when a vehicle make is available)
  const dtcCodes = extractDtcCodes(lastUserText);
  const dtcEntries = dtcCodes
    .map((c) => lookupDtc(c, vehicle?.make))
    .filter((e) => e !== null);

  if (dtcEntries.length > 0) {
    // Strip the DTC tokens to see what remains of the question. If the
    // remainder is essentially empty or just filler ("what is", "explain"),
    // we can answer entirely from the database.
    const stripped = lastUserText
      .replace(/\b([PBCU])([0-9A-F])([0-9A-F]{3})\b/gi, "")
      .replace(/\b(what|is|does|mean|the|code|explain|tell|me|about|a|an)\b/gi, "")
      .replace(/[?.!,]/g, "")
      .trim();

    if (stripped.length < 8) {
      const text = dtcEntries.map(formatDtcAnswer).join("\n\n---\n\n");
      console.log(
        `[retrieval] DTC direct-answer: ${dtcCodes.join(", ")} (no Claude call)`,
      );
      return res.json({ text });
    }

    // Mixed: DTC + real question. Inject verified definitions and continue.
    systemBlocks.push({
      type: "text",
      text: formatDtcContextBlock(dtcEntries),
    });
    console.log(
      `[retrieval] DTC context injected: ${dtcCodes.join(", ")} (Claude still called)`,
    );
  }

  // 3: Vehicle spec lookup (oil capacity, torque, maintenance schedule, etc.)
  // Spec questions need a vehicle context to be answerable. If a provider
  // hits, return the answer directly. If not, fall through to Claude but
  // prepend the anti-hallucination preamble so the model is explicit about
  // uncertainty instead of confidently guessing values.
  let specIntent = null;
  let specWentToClaude = false;
  if (vehicle && typeof vehicle === "object" && vehicle.year && vehicle.make && vehicle.model) {
    specIntent = detectSpecIntent(lastUserText);
    if (specIntent) {
      const specResult = await lookupSpec(vehicle, specIntent.specType);
      if (specResult) {
        const text = formatSpecAnswer(specIntent.specType, specResult, vehicle);
        console.log(
          `[retrieval] spec direct-answer: ${specIntent.specType} from ${specResult.source}${specResult.fromCache ? " (cached)" : ""} (no Claude call)`,
        );
        return res.json({ text });
      }
      // Provider miss — prepend the spec caution preamble before going to
      // Claude so it doesn't fabricate values.
      systemBlocks.unshift({ type: "text", text: SPEC_CAUTION_PREAMBLE });
      specWentToClaude = true;
      console.log(
        `[retrieval] spec MISS for ${specIntent.specType} — Claude with anti-hallucination preamble`,
      );
    }
  }

  // 4: Response cache (only single-turn factual questions with a vehicle).
  // Skip the cache for spec questions that fell through to Claude — the
  // cached answer would lock in a possibly-wrong guess. New spec questions
  // for that vehicle should always re-attempt the provider chain.
  const cacheEligible =
    messages.length === 1 &&
    vehicle &&
    typeof vehicle === "object" &&
    vehicle.year &&
    vehicle.make &&
    vehicle.model &&
    !specWentToClaude &&
    isCacheableQuestion(lastUserText);

  let cacheKey = null;
  if (cacheEligible) {
    cacheKey = buildCacheKey(vehicle, lastUserText);
    const hit = getCached(cacheKey);
    if (hit) {
      return res.json({ text: hit });
    }
  }

  console.log(
    `[ask] model=${ASK_MODEL} messages=${messages.length} ` +
      `recalls=${recallsArr.length} tsbs=${tsbsArr.length} ` +
      `hasVehicle=${vehicle ? "yes" : "no"}`,
  );

  try {
    const response = await callAnthropicWithRetry(() =>
      client.messages.create({
        model: ASK_MODEL,
        max_tokens: 2048,
        system: systemBlocks,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
      }),
    );

    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    if (cacheKey && text.length > 0) {
      setCached(cacheKey, vehicle, lastUserText, text);
    }

    return res.json({ text });
  } catch (err) {
    return respondWithError(res, err, "ask");
  }
});

app.listen(PORT, "0.0.0.0", () => {
  // Aggregate cache rollup — printed last so it stands out in deploy logs.
  // If counts are non-zero on first startup after a redeploy, the Railway
  // Volume (or CACHE_DIR) is wired correctly. If they reset to zero on
  // every deploy, the cache is on the ephemeral filesystem.
  const c = cacheStats();
  const dfb = dtcFallbackStats();
  const vs = vehicleSpecsStats();
  const p = pidStats();
  console.log(
    `[startup] cache rollup: ` +
      `askVulcan=${c.entries}entries/hits=${c.hits}/misses=${c.misses} | ` +
      `dtcFallback=${dfb.entries}entries/hits=${dfb.hits}/claudeCalls=${dfb.claudeCalls} | ` +
      `vehicleSpecs=${vs.entries}entries/hits=${vs.hits}/providerCalls=${vs.providerCalls} | ` +
      `pids=${p.cachedVehicles}vehicles/hits=${p.hits}/fetches=${p.fetches}`,
  );
  console.log(`Vulcan backend listening on http://0.0.0.0:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
