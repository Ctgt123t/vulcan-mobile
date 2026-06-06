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
import { detectConfigMismatch } from "./dtcMismatch.js";
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
  isSpecShapedQuestion,
  lookupSpec,
  recordNoVehicleSpecFallthrough,
  vehicleSpecsStats,
} from "./vehicleSpecs.js";
import {
  getStandardPids,
  getVehiclePids,
  pidStats,
} from "./pidDatabase.js";
import { logApiCost, getCostSummary, costStats } from "./costLogger.js";

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
const ASK_MODEL = "claude-opus-4-6";

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

const APP_CONTEXT = `You are Vulcan, an AI diagnostic assistant built into a mobile app for professional automotive technicians. You are not a generic chatbot — you are an integrated part of a diagnostic tool with the following capabilities that you should be aware of:

The app connects directly to vehicles via an OBD2 Bluetooth adapter (BLE or Bluetooth Classic). When DTCs or live data are present in the conversation, they were pulled directly through the Vulcan app's own OBD2 connection — do NOT ask the technician what scan tool they used, because Vulcan IS the scan tool that retrieved them.

The app automatically retrieves and decodes the vehicle's VIN when an adapter is connected, and pulls verified vehicle specifications, recalls, TSBs, and vehicle-specific sensor parameters.

The app has four modes: Ask Vulcan (open automotive Q&A), Diagnose (structured diagnosis), OBD2 Scan (live data and code reading), and Inspection Report.

When DTC codes appear in the conversation, they came from a real scan the technician just performed in-app on the connected vehicle. Treat them as confirmed present codes, not hypothetical.

You have access to live sensor data and verified specs when an OBD2 adapter is connected.

Speak and reason as an integrated diagnostic tool that already has access to the vehicle's data, not as an external advisor asking the technician to gather information you already have.

Factory specifications — applies in every mode. Use your mechanical knowledge freely and confidently: diagnostic reasoning, where components are located, how systems work, and procedures are yours to give — that is your value. For numeric factory specs (fluid capacity, torque, viscosity or fluid type, pressure, sensor voltage or range, idle/target RPM, plug or clearance gap, service interval, fill spec) the rule is label, not silence. If you have a commonly-known value from general knowledge, give it — but lead with it as a likely figure to confirm, never as gospel: e.g. "typically 0W-20, about 4.4 quarts with filter — confirm against the cap or service manual." A working tech wants the likely answer plus the reminder to verify, not a refusal. What you must NOT do is state an unverified number as a precise, authoritative factory figure with no qualifier — a confident exact torque or capacity that turns out wrong can make a technician condemn a good part or torque something to failure. The line is framing: a likely value with a verify note is good; a bare exact figure asserted as confirmed is not. If a spec is obscure or you are genuinely unsure of even a ballpark, say so and point to the OEM source rather than inventing one. When an exact value HAS been injected into this conversation as verified data, state it directly as confirmed — no hedge needed. If a mode's own instructions set a stricter spec rule (for example, a structured diagnostic assessment that must route any unverified spec to a dedicated field instead of stating it), that stricter rule governs that mode.

Internal consistency — applies when you state specific mechanical facts tied to data you cite. If you reference a concrete data point (a part number, a spec, a DTC, or verified data injected into this conversation), your description must square with it. A spin-on filter's part number and a "cartridge-type" description in the same answer can't both be right — if you catch that kind of conflict, reconcile it before answering, or say plainly you're not certain on that specific detail and point the tech to verify. This is a narrow self-consistency check, NOT blanket second-guessing: keep answering ordinary questions with the same confidence as before, and don't hedge on things you know well. The goal is to catch a claim that fights its own cited evidence — not to add doubt to a confident, correct answer.`;

const SYSTEM_PROMPT = `${APP_CONTEXT}

You are an ASE Master Certified automotive technician with over 20 years of working shop-floor experience. Every kind of vehicle that comes through the bay has been on your lift at some point — domestics, imports, diesels, hybrids, light-duty trucks. You are working side-by-side with another qualified technician on a real vehicle in front of you both. Your job is to reach a correct diagnosis in the fewest steps possible, starting with the least invasive and most accessible checks first — exactly how a working master tech triages.

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
  const engineType =
    typeof req.query.engineType === "string" ? req.query.engineType : null;
  // Vehicle context used only for the mismatch detector — no caching by this.
  const vehicleForMismatch = make || engineType ? { make, engineType } : null;

  const dbEntry = lookupDtc(raw, make);
  if (dbEntry) {
    const mismatch = detectConfigMismatch(dbEntry, vehicleForMismatch);
    return res.json(mismatch ? { ...dbEntry, configMismatch: mismatch } : dbEntry);
  }

  // Fallback: ask Claude, cache, return.
  try {
    const fallbackEntry = await fetchDtcFallback(raw, make, (params) =>
      callAnthropicWithRetry(() => client.messages.create(params)),
    );
    const mismatch = detectConfigMismatch(fallbackEntry, vehicleForMismatch);
    return res.json(
      mismatch ? { ...fallbackEntry, configMismatch: mismatch } : fallbackEntry,
    );
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
  const { vehicle, messages, recalls, tsbs, sessionId } = req.body ?? {};

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

  const presentingComplaint = String(messages[0]?.content ?? "");

  // DTC enrichment: any DTC codes appearing in the presenting complaint
  // (typically dropped in by the OBD2 → Diagnose handoff) get a server-
  // side lookup against the verified database — manufacturer-aware when
  // we have vehicle.make — plus config-mismatch detection. The structured
  // definitions are injected into Claude's context so reasoning anchors
  // on the verified description, not on training-data recall, and any
  // mismatch flag (e.g. turbo code on NA engine) is surfaced explicitly.
  const dtcCodes = extractDtcCodes(presentingComplaint);
  const enrichedDtcEntries = [];
  for (const code of dtcCodes) {
    const entry = lookupDtc(code, vehicle?.make);
    if (!entry) continue;
    const mismatch = detectConfigMismatch(entry, vehicle);
    enrichedDtcEntries.push(mismatch ? { ...entry, configMismatch: mismatch } : entry);
  }
  if (enrichedDtcEntries.length > 0) {
    systemBlocks.push({
      type: "text",
      text: formatDtcContextBlock(enrichedDtcEntries),
    });
  }

  // Proactive spec injection: scan the presenting complaint (first user
  // message) for spec-relevant categories (oil, brake fluid, torque, etc.).
  // Query the provider chain for each hit and inject the verified values
  // into Claude's context so reasoning that touches those specs is anchored
  // to real data instead of model recollection.
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

  const mismatchCount = enrichedDtcEntries.filter((e) => e.configMismatch).length;
  console.log(
    `[diagnose] model=${DIAGNOSE_MODEL} messages=${messages.length} ` +
      `recalls=${recallsArr.length} tsbs=${tsbsArr.length} ` +
      `dtcsInjected=${enrichedDtcEntries.length} mismatches=${mismatchCount} ` +
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

    const costData = logApiCost(response.usage, DIAGNOSE_MODEL, {
      sessionId: typeof sessionId === "string" ? sessionId : null,
      callType: "diagnose",
    });

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
        cost: costData ?? null,
      });
    }

    if (toolUse.name === "provide_diagnosis") {
      return res.json({
        turn: {
          kind: "diagnosis",
          question: null,
          diagnosis: toolUse.input,
        },
        cost: costData ?? null,
      });
    }

    return res.status(502).json({ error: `Unexpected tool: ${toolUse.name}` });
  } catch (err) {
    return respondWithError(res, err, "diagnose");
  }
});

const ASK_SYSTEM_PROMPT = `${APP_CONTEXT}

You are a knowledgeable master automotive technician acting as a colleague to a working tech. You help with any automotive question — specs, procedures, fluid capacities, technical service bulletins, recalls, how systems work, and informal diagnostic guidance when the conversation goes there.

Be conversational, friendly, and practical. You are a colleague, not a formal diagnostic system.

Guidelines:
- Answer any automotive-related question freely and conversationally.
- If a question requires a specific vehicle and no vehicle context has been provided, ask the technician for the year, make, model, and any other relevant details before answering.
- Talk freely and confidently about diagnosis, how systems work, where parts are, and how to do the job — that's what a good colleague brings. But a good colleague doesn't rattle off exact factory numbers from memory: when the answer is a specific spec (capacity, torque, viscosity, pressure, gap, voltage, or interval) and you weren't handed a verified value, say so straight and point to the OEM source rather than guessing — e.g. "I don't have the confirmed figure on that one — check it against the service manual." Hedge on the hard numbers, not on the conversation.
- If the conversation naturally moves toward diagnosing a specific problem, follow it and offer diagnostic guidance, but do not force a formal final diagnosis unless the technician explicitly asks for one.
- If a vehicle has been provided and the question touches on recalls or TSBs, reference any matching items from the recall/TSB context blocks by their campaign or item number. Do not invent recalls or TSBs beyond what is provided.
- Respond in plain text. No tools, no JSON, no structured output. Just a helpful answer.`;

app.post("/api/ask", async (req, res) => {
  const { messages, vehicle, recalls, tsbs, sessionId } = req.body ?? {};

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
      return res.json({ text, cost: null });
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
  //
  // Detect spec intent FIRST, independent of whether a structured vehicle is
  // present. The anti-hallucination guardrail must cover the open-ended Ask
  // Vulcan case too: a spec question with no year/make/model in context can't
  // be verified against a provider, and previously went straight to Claude
  // with NO guardrail — producing confidently-wrong figures. Now any spec
  // question that can't be answered from a verified provider gets the caution
  // preamble so Claude admits uncertainty and points to how to confirm.
  const specIntent = detectSpecIntent(lastUserText);
  let specWentToClaude = false;
  if (specIntent) {
    const hasVehicle =
      vehicle &&
      typeof vehicle === "object" &&
      vehicle.year &&
      vehicle.make &&
      vehicle.model;

    if (hasVehicle) {
      // Vehicle present — try the provider chain. Hit → verified answer,
      // no Claude call (unchanged). Miss → guardrail + fall through.
      const specResult = await lookupSpec(vehicle, specIntent.specType);
      if (specResult) {
        const text = formatSpecAnswer(specIntent.specType, specResult, vehicle);
        console.log(
          `[retrieval] spec direct-answer: ${specIntent.specType} from ${specResult.source}${specResult.fromCache ? " (cached)" : ""} (no Claude call)`,
        );
        return res.json({ text, cost: null });
      }
      systemBlocks.unshift({ type: "text", text: SPEC_CAUTION_PREAMBLE });
      specWentToClaude = true;
      console.log(
        `[retrieval] spec MISS for ${specIntent.specType} — Claude with anti-hallucination preamble`,
      );
    } else {
      // No structured vehicle to look up against — can't verify any figure,
      // so apply the guardrail so Claude says it lacks a confirmed value and
      // tells the user how to verify, rather than guessing. Previously this
      // path was unguarded AND counted nowhere — record it so the true
      // Claude-spec-answer rate is visible at /metrics.
      systemBlocks.unshift({ type: "text", text: SPEC_CAUTION_PREAMBLE });
      specWentToClaude = true;
      recordNoVehicleSpecFallthrough();
      console.log(
        `[retrieval] spec MISS (no vehicle context) for ${specIntent.specType} — Claude with anti-hallucination preamble`,
      );
    }
  }

  // 4: Response cache (only single-turn NON-SPEC factual questions with a
  // vehicle). Spec-shaped questions are NEVER cached — they must be generated
  // live and spec-guarded every time, because a cached spec answer survives
  // prompt/model changes and freezes a possibly-stale figure for 30 days
  // (the 2026-06 stale-cache bug: "oil change specs" slipped detectSpecIntent
  // but matched the old cacheable-question heuristic, so a pre-fix answer was
  // served long after the guardrail/model shipped). isSpecShapedQuestion is a
  // deliberately broad detector for exactly this exclusion — when in doubt it
  // treats the question as a spec and skips the cache. This single gate sets
  // cacheKey, which controls BOTH the read below and the write later, so a
  // spec question is neither served from nor written to the cache.
  const cacheEligible =
    messages.length === 1 &&
    vehicle &&
    typeof vehicle === "object" &&
    vehicle.year &&
    vehicle.make &&
    vehicle.model &&
    !specWentToClaude &&
    !isSpecShapedQuestion(lastUserText) &&
    isCacheableQuestion(lastUserText);

  let cacheKey = null;
  if (cacheEligible) {
    cacheKey = buildCacheKey(vehicle, lastUserText, ASK_MODEL);
    const hit = getCached(cacheKey);
    if (hit) {
      return res.json({ text: hit, cost: null });
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

    const costData = logApiCost(response.usage, ASK_MODEL, {
      sessionId: typeof sessionId === "string" ? sessionId : null,
      callType: "ask-vulcan",
    });

    if (cacheKey && text.length > 0) {
      setCached(cacheKey, vehicle, lastUserText, text);
    }

    return res.json({ text, cost: costData ?? null });
  } catch (err) {
    return respondWithError(res, err, "ask");
  }
});

// ============================================================================
// /api/assess — Single-shot structured diagnostic assessment (Stage 1)
//
// Takes a factual OBD2 data snapshot + vehicle context and returns a
// structured differential diagnosis via the emit_diagnostic_assessment tool.
// Reuses the same DTC enrichment, spec injection, and recall/TSB pipelines
// as /api/diagnose. Separate endpoint because the call is single-shot
// (no conversation history), uses a different tool, and different prompt.
//
// Stage 2 will extend this endpoint with iterative evidence-update calls.
// ============================================================================

const OPERATING_CONDITION_LABELS = {
  COLD_START: "Cold Start (engine recently started, not yet at operating temp)",
  WARM_IDLE: "Warm Idle (engine fully warm, idling in park/neutral)",
  LIGHT_LOAD: "Light Load (light throttle, normal cruise)",
  HEAVY_LOAD: "Heavy Load (hard acceleration, towing, high throttle demand)",
  UNDER_SYMPTOM_CONDITION: "Under Symptom Condition (actively reproducing the fault)",
  OTHER: "Other / Not Sure",
};

function formatOperatingCondition(cond) {
  return OPERATING_CONDITION_LABELS[cond] ?? cond ?? "Not specified";
}

function formatSnapshotBlock(snapshot) {
  const lines = [
    "=== LIVE DATA SNAPSHOT ===",
    `Operating condition (declared by technician): ${formatOperatingCondition(snapshot.operatingCondition)}`,
    `Capture window: ${((snapshot.durationMs ?? 0) / 1000).toFixed(1)} seconds`,
    "",
  ];

  if (snapshot.signals && snapshot.signals.length > 0) {
    lines.push("CURRENT LIVE READINGS (averaged over capture window):");
    for (const s of snapshot.signals) {
      const avg = `${s.averageValue} ${s.unit ?? ""}`.trim();
      const range =
        s.minSample !== s.maxSample
          ? ` | range across window: ${s.minSample}–${s.maxSample} ${s.unit ?? ""}`.trim()
          : " | stable";
      const encMax =
        s.encodingMax != null
          ? ` [encoding range: ${s.encodingMin}–${s.encodingMax} ${s.unit ?? ""}]`.trim()
          : "";
      lines.push(`  ${s.name} (${s.category}): ${avg}${range}${encMax} — ${s.sampleCount} samples`);
    }
  } else {
    lines.push("No live signal data was captured (no PIDs were selected or none responded).");
  }

  if (snapshot.absentSignalNames && snapshot.absentSignalNames.length > 0) {
    lines.push("");
    lines.push("SIGNALS SELECTED BUT NOT AVAILABLE IN THIS SESSION:");
    for (const name of snapshot.absentSignalNames) {
      lines.push(`  - ${name}`);
    }
  }

  const storedDtcs = snapshot.dtcs ?? [];
  const pendingDtcs = snapshot.pendingDtcs ?? [];
  const permanentDtcs = snapshot.permanentDtcs ?? [];
  const hasCodes = storedDtcs.length > 0 || pendingDtcs.length > 0 || permanentDtcs.length > 0;

  if (hasCodes) {
    lines.push("");
    lines.push("PRESENT DTCs (verified definitions injected separately above):");
    if (storedDtcs.length > 0) lines.push(`  Stored (Mode 03): ${storedDtcs.join(", ")}`);
    if (permanentDtcs.length > 0) {
      lines.push(`  Permanent (Mode 0A): ${permanentDtcs.join(", ")}`);
      lines.push(`    Note: permanent codes survived a code-clear and require a completed drive cycle to extinguish. They are confirmed-fault evidence even if no stored code is present.`);
    }
    if (pendingDtcs.length > 0) lines.push(`  Pending (Mode 07): ${pendingDtcs.join(", ")}`);
  } else {
    lines.push("");
    lines.push("PRESENT DTCs: None stored, pending, or permanent.");
  }

  if (snapshot.freezeFrame) {
    const ff = snapshot.freezeFrame;
    const hasData =
      ff.dtc || ff.rpm != null || ff.speedKph != null || ff.coolantC != null || ff.fuelPressure != null;
    if (hasData) {
      lines.push("");
      lines.push(
        "FREEZE FRAME DATA (HISTORICAL — the operating condition when the DTC stored, NOT the current state):",
      );
      lines.push(
        "  IMPORTANT: This is from a past moment (possibly days or weeks ago). Reason about how it compares to the current live readings above.",
      );
      if (ff.dtc) lines.push(`  Associated DTC: ${ff.dtc}`);
      if (ff.rpm != null) lines.push(`  RPM: ${Math.round(ff.rpm)} rpm`);
      if (ff.speedKph != null) lines.push(`  Speed: ${ff.speedKph} km/h`);
      if (ff.coolantC != null) lines.push(`  Coolant temp: ${ff.coolantC} °C`);
      if (ff.fuelPressure != null) lines.push(`  Fuel pressure: ${ff.fuelPressure} kPa`);
    } else {
      lines.push("");
      lines.push("FREEZE FRAME DATA: Not available for stored DTCs.");
    }
  } else if ((snapshot.dtcs ?? []).length > 0) {
    lines.push("");
    lines.push("FREEZE FRAME DATA: Not available.");
  }

  return lines.join("\n");
}

const ASSESS_TOOL = {
  name: "emit_diagnostic_assessment",
  description:
    "Output a structured diagnostic assessment based on the provided vehicle data, DTCs, and live OBD2 snapshot. Call this exactly once.",
  input_schema: {
    type: "object",
    properties: {
      presenting_complaint: {
        type: "string",
        description:
          "The technician's presenting complaint. If none was provided, characterize the fault picture from the DTCs and data in one concise sentence.",
      },
      stance: {
        type: "string",
        enum: ["AUTOPILOT", "GUIDED"],
        description:
          "AUTOPILOT: fault likely lives in the data — sensor rationality, fuel trims, misfires, electrical. Data-directed investigation. GUIDED: fault likely requires the technician's physical senses — mechanical noise, wear, visual damage, leaks. Technician-directed inspection.",
      },
      stance_reason: {
        type: "string",
        description: "One sentence explaining why this stance was chosen for this specific case.",
      },
      hypotheses: {
        type: "array",
        description:
          "Ranked list of diagnostic hypotheses, most likely first. Maximum 5. Cut any hypothesis that lacks specific citable support from the provided data.",
        maxItems: 5,
        items: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Concise hypothesis name (e.g., 'Vacuum leak — intake manifold area').",
            },
            confidence: {
              type: "string",
              enum: ["POSSIBLE", "LIKELY", "STRONGLY_SUPPORTED"],
            },
            supporting_evidence: {
              type: "array",
              items: { type: "string" },
              description:
                "Specific observations from the provided data that support this hypothesis. Each item must reference actual data values — not generic code definitions.",
            },
            contradicting_evidence: {
              type: "array",
              items: { type: "string" },
              description:
                "Specific observations from the provided data that weaken or argue against this hypothesis.",
            },
          },
          required: ["name", "confidence", "supporting_evidence", "contradicting_evidence"],
        },
      },
      next_step: {
        type: "object",
        description: "The single highest-value next action — exactly one, not a checklist.",
        properties: {
          action: {
            type: "string",
            description: "What to do — specific and actionable.",
          },
          rationale: {
            type: "string",
            description:
              "Why this step — which hypothesis it confirms or eliminates, and why it is the cheapest action that most changes the ranking.",
          },
          type: {
            type: "string",
            enum: ["DATA_CAPTURE", "PHYSICAL_INSPECTION", "QUESTION"],
          },
          requested_data: {
            type: "array",
            description:
              "Populated when type is DATA_CAPTURE. Specifies which signals to capture and under what conditions.",
            items: {
              type: "object",
              properties: {
                signal_id: {
                  type: "string",
                  description: "OBD2 signal identifier (e.g., STFT1, RPM, ECT, MAF).",
                },
                operating_condition: {
                  type: "string",
                  description:
                    "The specific operating condition under which to capture this signal (e.g., 'warm idle, 650-750 RPM, fully warm coolant').",
                },
                duration_seconds: {
                  type: "number",
                  description: "How many seconds of data to capture.",
                },
              },
              required: ["signal_id", "operating_condition", "duration_seconds"],
            },
          },
        },
        required: ["action", "rationale", "type"],
      },
      data_ceiling_note: {
        type: "string",
        description:
          "If the OBD2 data genuinely cannot distinguish between the leading hypotheses, explain plainly here. Empty string if the data is sufficient to meaningfully differentiate.",
      },
      unverified_specs_needed: {
        type: "array",
        description:
          "Specific factory values you needed for your reasoning but were not provided in the verified data blocks. List them here rather than stating unverified numbers.",
        items: {
          type: "object",
          properties: {
            parameter: {
              type: "string",
              description:
                "The specific factory spec needed (e.g., 'Expected MAF g/s at warm idle for 2018 Ford F-150 3.5L EcoBoost').",
            },
            purpose: {
              type: "string",
              description:
                "Why you need this value — what hypothesis it would confirm or eliminate.",
            },
          },
          required: ["parameter", "purpose"],
        },
      },
    },
    required: [
      "presenting_complaint",
      "stance",
      "stance_reason",
      "hypotheses",
      "next_step",
      "data_ceiling_note",
      "unverified_specs_needed",
    ],
  },
};

const ASSESS_SYSTEM_PROMPT = `${APP_CONTEXT}

DIAGNOSTIC ASSESSMENT — SINGLE-SHOT STRUCTURED ANALYSIS

You are performing a one-shot differential diagnosis based on real OBD2 data captured directly from the vehicle by the Vulcan app. You are NOT conducting a conversation — you are producing a structured differential, exactly as a master technician would review a complete data set before calling a diagnosis.

=== WHAT YOU HAVE ===

The following have been verified by the Vulcan backend and injected into this context. Treat them as ground truth:
- Vehicle identity, engine configuration, and mileage
- Technician-declared operating condition at the time of capture
- A 5-second averaged live OBD2 snapshot with per-signal min/max ranges across the window
- Stored and pending DTC codes with their verified manufacturer-specific definitions
- Freeze frame data (if available) — the operating condition when the DTCs stored (HISTORICAL)
- Active NHTSA recall campaigns for this vehicle
- NHTSA Technical Service Bulletins on file for this vehicle
- Verified factory specs (if available for this vehicle and complaint)
- The technician's presenting complaint (may be blank)

=== REASONING INSTRUCTIONS ===

1. FORM A DIFFERENTIAL. Rank up to 5 hypotheses by how well the actual provided data supports each one. Cut any hypothesis that lacks specific citable support from the data. Don't pad the list with generic possibilities the data cannot speak to.

2. CITE SPECIFIC EVIDENCE. For each hypothesis: supporting_evidence must reference specific values from the provided data. "STFT1 averaged +18% at warm idle with LTFT1 also positive at +12%, consistent with unmetered air rather than a sensor drift" is evidence. "P0171 indicates a lean condition" is a code definition, not evidence from this vehicle's data.

3. CITE CONTRADICTING EVIDENCE. For each hypothesis: contradicting_evidence must name specific observations that argue against it. Contradicting evidence is as important as supporting evidence — it shows honest reasoning rather than confirmation bias.

4. STATE YOUR STANCE.
   - AUTOPILOT: The fault likely lives in the sensor data — fuel trims, misfire counts, sensor rationality, electrical readings, ECU-detectable malfunctions. You drive the investigation with data-directed next steps.
   - GUIDED: The fault likely requires the technician's physical senses — mechanical noise, wear patterns, visual damage, leak location. You direct the technician's hands.
   Give one plain-English sentence for why this stance fits this specific case.

5. ONE NEXT STEP. The single cheapest action that most changes the hypothesis ranking. Not a checklist — exactly one.
   - DATA_CAPTURE: Specific OBD2 signals under specific operating conditions. List each signal ID, the exact conditions, and duration in requested_data.
   - PHYSICAL_INSPECTION: A specific, actionable check. Name the exact component and the exact test.
   - QUESTION: The single highest-diagnostic-value piece of information you're missing that would most change the ranking.

6. CONFIDENCE LADDER — use it honestly:
   - POSSIBLE: Plausible given the data, but direct support is limited. One test could rule it out.
   - LIKELY: Multiple consistent data points converge on it. Would be surprised if wrong, but not certain.
   - STRONGLY_SUPPORTED: Strong convergent evidence from several independent indicators. Difficult to explain otherwise.
   No hypothesis in a single-shot assessment may be marked higher than STRONGLY_SUPPORTED.

7. DATA CEILING. If the generic OBD2 data genuinely cannot distinguish between the leading hypotheses, say so plainly in data_ceiling_note. Honesty about the data's limits is more valuable than a forced conclusion. Leave it empty if the data is sufficient to differentiate.

=== CRITICAL SAFETY DISCIPLINE — NON-NEGOTIABLE ===

You may freely apply diagnostic logic, pattern recognition, and mechanistic reasoning from your training. That is your core value as a master technician.

You must NOT state any specific numeric factory specification — exact torque values, exact pressures, fluid capacities, precise expected sensor voltages, target idle RPM ranges, expected MAF values — unless that exact value was explicitly provided in the verified data blocks injected into this context.

If you need such a value and it was not provided: add it to unverified_specs_needed with the parameter name and why you need it. Recommend the technician confirm against the OEM service manual.

A confidently-stated wrong factory number can cause a technician to condemn a good part or miss the real fault. This is the worst failure mode. When uncertain about a specific numeric value: flag it as unverified, don't state it.

=== FREEZE FRAME vs. LIVE DATA ===

Freeze frame data reflects the operating condition when the DTC was stored — HISTORICAL, possibly days or weeks ago.
Live data reflects the vehicle's state at the moment the technician triggered this assessment.

When reasoning across both:
- A fault condition present in freeze frame but absent in live data: suggests intermittent — was active when code stored, not currently active.
- A condition consistent across both contexts: suggests a persistent, currently-active fault.
Always state explicitly when you are reasoning about the relationship between the two temporal contexts.

=== OUTPUT ===

Call emit_diagnostic_assessment exactly once with your complete structured assessment. Do not produce any plain-text response.`;

app.post("/api/assess", async (req, res) => {
  const { vehicle, vin, mileage, complaint, snapshot, recalls, tsbs, sessionId } =
    req.body ?? {};

  if (!vehicle || typeof vehicle !== "object") {
    return res.status(400).json({ error: "Missing or invalid 'vehicle'." });
  }
  if (!snapshot || typeof snapshot !== "object") {
    return res.status(400).json({ error: "Missing or invalid 'snapshot'." });
  }

  const recallsArr = Array.isArray(recalls) ? recalls : [];
  const tsbsArr = Array.isArray(tsbs) ? tsbs : [];
  const complaintText = typeof complaint === "string" ? complaint.trim() : "";
  const mileageText =
    typeof mileage === "string" && mileage.trim().length > 0
      ? mileage.trim()
      : vehicle.mileage ?? "Not provided";

  // Build system context blocks in the same layered pattern as /api/diagnose.
  const systemBlocks = [
    {
      type: "text",
      text: ASSESS_SYSTEM_PROMPT,
      cache_control: { type: "ephemeral" },
    },
  ];

  if (recallsArr.length > 0) {
    systemBlocks.push({ type: "text", text: buildRecallBlock(recallsArr) });
  }
  if (tsbsArr.length > 0) {
    systemBlocks.push({ type: "text", text: buildTsbBlock(tsbsArr) });
  }

  // DTC enrichment: look up all stored, pending, and permanent codes directly
  // from the snapshot (confirmed by the scan, not typed in by the tech).
  const allDtcCodes = [
    ...(Array.isArray(snapshot.dtcs) ? snapshot.dtcs : []),
    ...(Array.isArray(snapshot.pendingDtcs) ? snapshot.pendingDtcs : []),
    ...(Array.isArray(snapshot.permanentDtcs) ? snapshot.permanentDtcs : []),
  ];
  const enrichedDtcEntries = [];
  for (const code of allDtcCodes) {
    const entry = lookupDtc(code, vehicle?.make);
    if (!entry) continue;
    const mismatch = detectConfigMismatch(entry, vehicle);
    enrichedDtcEntries.push(mismatch ? { ...entry, configMismatch: mismatch } : entry);
  }
  if (enrichedDtcEntries.length > 0) {
    systemBlocks.push({
      type: "text",
      text: formatDtcContextBlock(enrichedDtcEntries),
    });
  }

  // Spec injection: detect from the complaint text, same as /api/diagnose.
  const specsToFetch = complaintText.length > 0 ? detectAllSpecIntents(complaintText) : [];
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

  // Formatted snapshot block (the live OBD2 data Claude will reason on).
  systemBlocks.push({
    type: "text",
    text: formatSnapshotBlock(snapshot),
  });

  // Build the single user message: vehicle context + complaint + assessment request.
  const vehicleHead = [vehicle.year, vehicle.make, vehicle.model, vehicle.trim]
    .filter((s) => s && String(s).trim().length > 0)
    .join(" ");
  const userLines = [`Vehicle: ${vehicleHead}`];
  if (vehicle.engineType && vehicle.engineType.trim().length > 0) {
    userLines.push(`Engine: ${vehicle.engineType}`);
  }
  userLines.push(`Mileage: ${mileageText}`);
  if (vin && typeof vin === "string" && vin.trim().length > 0) {
    userLines.push(`VIN: ${vin.trim()}`);
  }
  if (complaintText.length > 0) {
    userLines.push("", `Presenting complaint: ${complaintText}`);
  } else {
    userLines.push("", "Presenting complaint: (none provided — assess based on DTCs and live data)");
  }
  userLines.push("", "Please perform a structured diagnostic assessment of this vehicle based on all the verified data above.");

  const mismatchCount = enrichedDtcEntries.filter((e) => e.configMismatch).length;
  console.log(
    `[assess] model=${DIAGNOSE_MODEL} ` +
      `dtcs=${allDtcCodes.length} enriched=${enrichedDtcEntries.length} mismatches=${mismatchCount} ` +
      `signals=${(snapshot.signals ?? []).length} absent=${(snapshot.absentSignalNames ?? []).length} ` +
      `recalls=${recallsArr.length} tsbs=${tsbsArr.length} ` +
      `specsDetected=${specsToFetch.length} specsInjected=${verifiedSpecs.length}`,
  );

  try {
    const response = await callAnthropicWithRetry(() =>
      client.messages.create({
        model: DIAGNOSE_MODEL,
        max_tokens: 4096,
        system: systemBlocks,
        tools: [ASSESS_TOOL],
        tool_choice: { type: "tool", name: "emit_diagnostic_assessment" },
        messages: [{ role: "user", content: userLines.join("\n") }],
      }),
    );

    const costData = logApiCost(response.usage, DIAGNOSE_MODEL, {
      sessionId: typeof sessionId === "string" ? sessionId : null,
      callType: "assessment",
    });

    const toolUse = response.content.find((b) => b.type === "tool_use");
    if (!toolUse || toolUse.name !== "emit_diagnostic_assessment") {
      return res.status(502).json({
        error: "Model did not return a structured assessment. Try again.",
      });
    }

    // Return cost alongside the assessment so the app can log it per-session.
    return res.json({ assessment: toolUse.input, cost: costData ?? null });
  } catch (err) {
    return respondWithError(res, err, "assess");
  }
});

// Cost summary — per-session and aggregate breakdown.
// curl https://<railway-url>/api/costs/summary | jq .
app.get("/api/costs/summary", (_req, res) => {
  res.json(getCostSummary());
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
  const cs = costStats();
  console.log(
    `[startup] cache rollup: ` +
      `askVulcan=${c.entries}entries/hits=${c.hits}/misses=${c.misses} | ` +
      `dtcFallback=${dfb.entries}entries/hits=${dfb.hits}/claudeCalls=${dfb.claudeCalls} | ` +
      `vehicleSpecs=${vs.entries}entries/hits=${vs.hits}/providerCalls=${vs.providerCalls} | ` +
      `pids=${p.cachedVehicles}vehicles/hits=${p.hits}/fetches=${p.fetches}`,
  );
  console.log(
    `[startup] api cost: today=$${cs.todayCost.toFixed(4)} ` +
      `(${cs.todayCalls} calls, ${cs.todaySessions} sessions) | ` +
      `allTime=$${cs.allTimeCost.toFixed(4)} (${cs.allTimeCalls} calls)`,
  );
  console.log(`Vulcan backend listening on http://0.0.0.0:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
