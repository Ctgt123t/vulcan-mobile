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
  detectAllSpecIntents,
  detectSpecIntent,
  formatSpecAnswer,
  formatSpecContextBlock,
  isComponentShapedQuestion,
  isSpecShapedQuestion,
  lookupSpec,
  recordComponentFactMiss,
  recordNoVehicleSpecFallthrough,
  vehicleSpecsStats,
} from "./vehicleSpecs.js";
import {
  getStandardPids,
  getVehiclePids,
  pidStats,
} from "./pidDatabase.js";
import { logApiCost, getCostSummary, costStats } from "./costLogger.js";
import {
  ASK_TOOLS,
  ASK_TOOL_HANDLERS,
  runAskToolLoop,
} from "./askToolLoop.js";
import { initDb } from "./db.js";
import {
  ASSESS_BODY,
  EVIDENCE_UPDATE_BODY,
  UNIFIED_BODY,
  buildSystemPrompt,
} from "./assessPrompt.js";

const PORT = Number(process.env.PORT ?? 3000);

if (!process.env.ANTHROPIC_API_KEY) {
  console.error(
    "Missing ANTHROPIC_API_KEY. Copy server/.env.example to server/.env and set it.",
  );
  process.exit(1);
}

const client = new Anthropic();

// Model strategy. Diagnose is the heavyweight reasoning path — structured tool
// use, multi-turn convergence, safety implications — so it gets Opus. Ask Vulcan
// ALSO runs Opus: it was switched off Sonnet because Sonnet fabricated free-form
// mechanical facts (e.g. wrong oil-filter location/type) that no spec rule
// governs. Sonnet still runs only the background DTC-fallback path (dtcFallback.js).
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

Factory specifications and component identity — applies in every mode. Use your mechanical knowledge freely and confidently: diagnostic reasoning, how systems work, procedures, and general component knowledge are yours to give — that is your value. For numeric factory specs (fluid capacity, torque, viscosity or fluid type, pressure, sensor voltage or range, idle/target RPM, plug or clearance gap, service interval, fill spec) AND for vehicle-specific component identity facts recalled from memory — which filter type (cartridge vs spin-on) a given year/make/model uses, OEM or cross-reference part numbers, and where a component is physically located on that specific vehicle — the rule is label, not silence. If you have a commonly-known value from general knowledge, give it — but lead with it as a likely answer to confirm, never as gospel: e.g. "typically 0W-20, about 4.4 quarts with filter — confirm against the cap or service manual," or "typically a spin-on filter on that engine family, commonly listed as 15208AA170 — confirm against the parts catalog before ordering." A working tech wants the likely answer plus the reminder to verify, not a refusal. What you must NOT do is state an unverified number, part number, filter type, or vehicle-specific component location as a precise, authoritative factory fact with no qualifier — a confident exact torque or capacity that turns out wrong can make a technician condemn a good part or torque something to failure, and a confidently wrong part number or filter type sends them to the parts counter for the wrong part. The line is framing: a likely value with a verify note is good; a bare exact figure asserted as confirmed is not. If a spec or component fact is obscure or you are genuinely unsure of even a ballpark, say so and point to the OEM source rather than inventing one. When an exact value HAS been injected into this conversation as verified data, state it directly as confirmed — no hedge needed. If a mode's own instructions set a stricter spec rule (for example, a structured diagnostic assessment that must route any unverified spec to a dedicated field instead of stating it), that stricter rule governs that mode.

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

  // 3: Vehicle spec routing (oil capacity, torque, maintenance schedule, etc.)
  //
  // Spec intent now routes via TOOL USE (spec_lookup) inside the Claude call
  // below — Claude understands phrasings the adjacency regex can't ("oil change
  // specs", "what oil does it take"). detectSpecIntent is still run here as a
  // zero-Claude latency fast-path for obvious hits (see the hybrid-seam comment
  // below); it is no longer the correctness gate.
  const specIntent = detectSpecIntent(lastUserText);
  // Inbound-request visibility: capture the structured vehicle (exact values +
  // JS types) and the intent result on EVERY ask, before any branching/early
  // return, so spec routing is diagnosable from logs instead of inferred. This
  // exact gap caused two misdiagnoses (the "oil change specs" investigation):
  // detectSpecIntent missing a phrasing, and a vehicle present-but-unstructured.
  {
    const v = vehicle && typeof vehicle === "object" ? vehicle : null;
    const vDbg = v
      ? `year=${JSON.stringify(v.year)}:${typeof v.year} ` +
        `make=${JSON.stringify(v.make)}:${typeof v.make} ` +
        `model=${JSON.stringify(v.model)}:${typeof v.model} ` +
        `series=${JSON.stringify(v.series)} engineType=${JSON.stringify(v.engineType)}`
      : `vehicle=${JSON.stringify(vehicle)}`;
    console.log(
      `[ask] inbound vehicle: ${vDbg} | specIntent=${specIntent ? specIntent.specType : "none"}`,
    );
  }
  // Hybrid seam — the regex (detectSpecIntent) is now a LATENCY SHORTCUT, not the
  // correctness gate:
  //   - regex fires AND a structured vehicle is present → probe the DB directly;
  //     a HIT returns a formatted card with NO Claude call (the unchanged fast
  //     path).
  //   - everything else (no intent, regex-hit + DB-miss, or no vehicle) flows to
  //     the tool-enabled Claude call below, where Claude judges intent and may
  //     call spec_lookup against the IDENTICAL lookupSpec. Both doors → one
  //     source of truth, no divergence.
  //
  // HEDGE CONSOLIDATION (complete): the hedge now lives in TWO places only — the
  // spec_lookup tool-miss result text ("no verified record… give a likely value
  // to confirm against the OEM source") and the APP_CONTEXT factory-spec rule.
  // The old injected SPEC_CAUTION_PREAMBLE is retired: all three paths it covered
  // (tool miss, regex fast-path miss, no-vehicle ask) were proven to hedge via
  // APP_CONTEXT + tool text alone (deployed Layer B proof) before it was removed.
  if (specIntent) {
    const hasVehicle =
      vehicle &&
      typeof vehicle === "object" &&
      vehicle.year &&
      vehicle.make &&
      vehicle.model;

    if (hasVehicle) {
      const specResult = await lookupSpec(vehicle, specIntent.specType);
      if (specResult) {
        const text = formatSpecAnswer(specIntent.specType, specResult, vehicle);
        console.log(
          `[retrieval] spec fast-path HIT: ${specIntent.specType} from ${specResult.source}${specResult.fromCache ? " (cached)" : ""} (no Claude call)`,
        );
        return res.json({ text, cost: null });
      }
      // Regex-hit + DB-miss: fall through to the tool path. Claude's spec_lookup
      // re-queries the same type (one extra cheap, fail-soft DB read) — a
      // deliberate accept over threading memoization state through the request.
      // The tool-miss result text + APP_CONTEXT carry the hedge.
      console.log(
        `[retrieval] spec fast-path MISS for ${specIntent.specType} — tool path`,
      );
    } else {
      // No structured vehicle to look up against. Keep the no-vehicle count
      // visible at /metrics; the tool path (no-vehicle miss text) + APP_CONTEXT
      // hedge this case.
      recordNoVehicleSpecFallthrough();
      console.log(
        `[retrieval] spec MISS (no vehicle context) for ${specIntent.specType} — tool path`,
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
  // isSpecShapedQuestion subsumes detectSpecIntent (it returns true for anything
  // detectSpecIntent matches, then widens), so a spec-intent question is already
  // excluded from the cache here — no separate spec flag needed. The tool-invoked
  // write guard below is the second half: it catches a question that slipped this
  // detector yet caused Claude to call a tool (live data must not be cached).
  const cacheEligible =
    messages.length === 1 &&
    vehicle &&
    typeof vehicle === "object" &&
    vehicle.year &&
    vehicle.make &&
    vehicle.model &&
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
      `hasVehicle=${vehicle ? "yes" : "no"} specIntent=${specIntent ? specIntent.specType : "none"}`,
  );

  try {
    const loopSessionId = typeof sessionId === "string" ? sessionId : null;
    // Hoisted so the componentFact demand log below can read the
    // componentFactsServed flag the spec_lookup handler may set.
    const loopCtx = { vehicle, toolInvoked: false };
    // Agentic tool loop: spec_lookup is registered, so Claude calls it on spec
    // questions the regex missed and reasons over the verified rows in the same
    // turn. The loop sums cost across every call and reports whether a tool fired.
    const { text, cost: costSummary, toolInvoked, iterations } = await runAskToolLoop({
      createMessage: (params) =>
        callAnthropicWithRetry(() => client.messages.create(params)),
      logCost: (usage) =>
        logApiCost(usage, ASK_MODEL, {
          sessionId: loopSessionId,
          callType: "ask-vulcan",
        }),
      model: ASK_MODEL,
      systemBlocks,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      tools: ASK_TOOLS,
      handlers: ASK_TOOL_HANDLERS,
      ctx: loopCtx,
    });

    // Component-identity demand log. Component questions never route through
    // lookupSpec (no component entry in the spec_lookup enum), so without
    // this the spec_miss extraction queue is blind to component demand. Log
    // a "componentFact" miss when a component-shaped question got no
    // DB-backed component facts in its answer. Fire-and-forget, fail-soft —
    // must never delay or affect the response.
    if (
      isComponentShapedQuestion(lastUserText) &&
      vehicle &&
      typeof vehicle === "object" &&
      vehicle.year &&
      vehicle.make &&
      vehicle.model &&
      !loopCtx.componentFactsServed
    ) {
      console.log(
        `[ask] componentFact demand logged for ${vehicle.year} ${vehicle.make} ${vehicle.model}`,
      );
      recordComponentFactMiss(vehicle);
    }

    // Cache write: only NON-tool responses. A tool-firing answer serves live
    // spec data that must never be frozen for 30 days (same reason
    // isSpecShapedQuestion is excluded from cacheEligible); this is the
    // second half of the cache guard, catching a tool firing on a question
    // that slipped the spec-shaped detector.
    if (toolInvoked) {
      console.log(
        `[ask] tool fired (iterations=${iterations}) — response NOT cached (live data)`,
      );
    }
    if (cacheKey && !toolInvoked && text.length > 0) {
      setCached(cacheKey, vehicle, lastUserText, text);
    }

    // Summed across all loop calls; null only if no cost was computed at all.
    // (costSummary has the ApiCostData shape { model, tokens, cost }, so the
    // grand total is costSummary.cost.total — not costSummary.total.)
    return res.json({
      text,
      cost: costSummary.cost.total > 0 ? costSummary : null,
    });
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
                capture_plan: {
                  type: "object",
                  description:
                    "Executable monitoring plan. Provide this whenever type is DATA_CAPTURE. Express EVERY condition as numeric ranges in the SAME unit the snapshot reports that signal in (raw OBDb units — degC not degF, kPa not psi, km/h not mph, % for fuel trims). A range here is your chosen capture trigger / observation window — it is NOT a factory specification; never phrase a range as the correct or expected value. If a condition cannot be expressed as numbers, it is not a DATA_CAPTURE (use PHYSICAL_INSPECTION instead).",
                  properties: {
                    context_gate: {
                      type: "array",
                      description:
                        "The situation that must hold for the capture to arm — the 'when'. Every entry must hold simultaneously (logical AND). Use an empty array only if the target should be captured under any condition.",
                      items: {
                        type: "object",
                        properties: {
                          signal_id: {
                            type: "string",
                            description:
                              "OBDb signal id exactly as it appears in the snapshot (e.g. RPM, ECT, VSS).",
                          },
                          range: {
                            type: "object",
                            description:
                              "Inclusive numeric band in the signal's raw OBDb unit. Use null for an unbounded side (e.g. '>= 80 degC' is {min:80, max:null}).",
                            properties: {
                              min: {
                                type: ["number", "null"],
                                description:
                                  "Inclusive lower bound in the signal's snapshot unit; null = unbounded below.",
                              },
                              max: {
                                type: ["number", "null"],
                                description:
                                  "Inclusive upper bound in the signal's snapshot unit; null = unbounded above.",
                              },
                              unit: {
                                type: "string",
                                description:
                                  "The raw OBDb unit the bounds are in (e.g. %, rpm, degC, kPa, km/h). Must match the snapshot's unit for this signal.",
                              },
                            },
                            required: ["min", "max", "unit"],
                          },
                        },
                        required: ["signal_id", "range"],
                      },
                    },
                    measured_target: {
                      type: "object",
                      description:
                        "The single signal + threshold band that IS the actual evidence you want to capture — the 'what'.",
                      properties: {
                        signal_id: {
                          type: "string",
                          description:
                            "OBDb signal id exactly as it appears in the snapshot (e.g. SHRTFT11, MAF).",
                        },
                        range: {
                          type: "object",
                          description:
                            "Inclusive numeric band in the signal's raw OBDb unit that defines the evidence event (e.g. STFT sustained >= +10% is {min:10, max:null, unit:'%'}).",
                          properties: {
                            min: {
                              type: ["number", "null"],
                              description:
                                "Inclusive lower bound in the signal's snapshot unit; null = unbounded below.",
                            },
                            max: {
                              type: ["number", "null"],
                              description:
                                "Inclusive upper bound in the signal's snapshot unit; null = unbounded above.",
                            },
                            unit: {
                              type: "string",
                              description:
                                "The raw OBDb unit the bounds are in. Must match the snapshot's unit for this signal.",
                            },
                          },
                          required: ["min", "max", "unit"],
                        },
                      },
                      required: ["signal_id", "range"],
                    },
                    sustained_seconds: {
                      type: "number",
                      description:
                        "The gate AND target must hold continuously for this many seconds before the capture counts (noise + cost safeguard).",
                    },
                    capture_window_seconds: {
                      type: "number",
                      description:
                        "How many seconds of live data to package once the plan fires.",
                    },
                  },
                  required: [
                    "context_gate",
                    "measured_target",
                    "sustained_seconds",
                    "capture_window_seconds",
                  ],
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

// ---- Soft-validator for the 2C-1 monitoring plan -------------------------
//
// JSON schema can't make capture_plan conditionally-required ("required iff
// type === DATA_CAPTURE"), so we enforce its SHAPE here, fail-soft. A
// missing/malformed plan is DROPPED (never thrown), leaving the Stage-1 prose
// fields (operating_condition) intact so the client cleanly falls back to
// rendering text. This matches the codebase's fail-soft discipline (a model
// quirk degrades the feature, it never 500s the assess path).
function isValidRange(r) {
  return (
    r != null &&
    typeof r === "object" &&
    (r.min === null || typeof r.min === "number") &&
    (r.max === null || typeof r.max === "number") &&
    typeof r.unit === "string" &&
    r.unit.length > 0
  );
}

function isValidSignalCondition(c) {
  return (
    c != null &&
    typeof c === "object" &&
    typeof c.signal_id === "string" &&
    c.signal_id.length > 0 &&
    isValidRange(c.range)
  );
}

// Returns the plan if well-formed, else null. Never throws.
function validateCapturePlan(plan) {
  if (plan == null || typeof plan !== "object") return null;
  if (!Array.isArray(plan.context_gate)) return null;
  if (!plan.context_gate.every(isValidSignalCondition)) return null;
  if (!isValidSignalCondition(plan.measured_target)) return null;
  if (typeof plan.sustained_seconds !== "number") return null;
  if (typeof plan.capture_window_seconds !== "number") return null;
  return plan;
}

// Soft-validate (and prune) the monitoring plan(s) on a DATA_CAPTURE assessment.
// Mutates the assessment in place and returns it. Never throws.
function softValidateAssessmentPlan(assessment) {
  try {
    const ns = assessment?.next_step;
    if (!ns || ns.type !== "DATA_CAPTURE") return assessment;
    if (!Array.isArray(ns.requested_data)) return assessment;
    for (const item of ns.requested_data) {
      if (item == null || typeof item !== "object") continue;
      const sigLabel = typeof item.signal_id === "string" ? item.signal_id : "?";
      if (item.capture_plan == null) {
        console.warn(
          `[assess] DATA_CAPTURE item signal_id=${sigLabel} has no capture_plan; falling back to Stage-1 prose.`,
        );
        continue;
      }
      if (!validateCapturePlan(item.capture_plan)) {
        console.warn(
          `[assess] DATA_CAPTURE item signal_id=${sigLabel} had a malformed capture_plan; dropping it, falling back to Stage-1 prose.`,
        );
        delete item.capture_plan;
      }
    }
  } catch (e) {
    console.warn(
      `[assess] soft-validate of capture_plan failed: ${e?.message ?? e}`,
    );
  }
  return assessment;
}

// Stage-1 and evidence-update system prompts are composed from the shared spine
// in assessPrompt.js. ASSESS_SYSTEM_PROMPT is byte-for-byte identical to the
// pre-2C-3 literal (proven by server/scripts/verifyAssessPrompt.js).
const ASSESS_SYSTEM_PROMPT = buildSystemPrompt(APP_CONTEXT, ASSESS_BODY);
const EVIDENCE_UPDATE_SYSTEM_PROMPT = buildSystemPrompt(APP_CONTEXT, EVIDENCE_UPDATE_BODY);
// SB3: the unified diagnostic turn (one brain, one move). Reuses the three
// existing tool schemas verbatim — the brain picks exactly one via tool_choice
// "any"; the spec discipline follows the tool (strict on emit_diagnostic_
// assessment's SAFETY section, relaxed on the conversational tools).
const UNIFIED_SYSTEM_PROMPT = buildSystemPrompt(APP_CONTEXT, UNIFIED_BODY);
const UNIFIED_TURN_TOOLS = [
  TOOLS.find((t) => t.name === "ask_followup_question"),
  ASSESS_TOOL,
  TOOLS.find((t) => t.name === "provide_diagnosis"),
];

// Shared assessment runner (Stage 2C-3 refactor). Both /api/assess (Stage 1)
// and /api/evidence-update use this: it assembles the verified-data system
// blocks (recall/TSB, DTC enrichment, spec injection, then any endpoint-specific
// extraContextBlocks, then the snapshot/observed data block LAST), runs the
// forced emit_diagnostic_assessment call, logs cost under the given callType,
// soft-validates the monitoring plan, and returns a discriminated result.
//
// Stage-1 behavior is preserved exactly: /api/assess passes extraContextBlocks=[]
// so the block order/text and the user message are byte-identical to pre-2C-3.
// Assemble the verified-data system blocks shared by the structured-assessment
// path (/api/assess), the evidence-update path, and the unified diagnostic turn
// (/api/diagnose-turn, SB3): the cached system prompt, recall/TSB blocks, DTC
// enrichment (from the snapshot codes), fail-soft spec injection (lookupSpec
// never throws), any endpoint-specific extraContextBlocks, then the
// snapshot/observed data block LAST. Logs a one-line summary under logLabel.
// Extracted from runStructuredAssessment (SB3-1) so the unified turn reuses the
// IDENTICAL context assembly; /api/assess behavior is unchanged.
async function buildAssessmentContextBlocks({
  systemPrompt,
  vehicle,
  snapshot,
  recallsArr,
  tsbsArr,
  complaintText,
  extraDtcCodes = [],
  extraContextBlocks = [],
  logLabel,
}) {
  const systemBlocks = [
    {
      type: "text",
      text: systemPrompt,
      cache_control: { type: "ephemeral" },
    },
  ];

  if (recallsArr.length > 0) {
    systemBlocks.push({ type: "text", text: buildRecallBlock(recallsArr) });
  }
  if (tsbsArr.length > 0) {
    systemBlocks.push({ type: "text", text: buildTsbBlock(tsbsArr) });
  }

  // DTC enrichment: codes from the snapshot when connected (confirmed by the
  // scan), PLUS any codes from the complaint text not already present (the
  // disconnected / typed-in path — extraDtcCodes). Snapshot codes keep their
  // exact order/duplicates so /api/assess output is unchanged.
  const snapshotDtcs = snapshot
    ? [
        ...(Array.isArray(snapshot.dtcs) ? snapshot.dtcs : []),
        ...(Array.isArray(snapshot.pendingDtcs) ? snapshot.pendingDtcs : []),
        ...(Array.isArray(snapshot.permanentDtcs) ? snapshot.permanentDtcs : []),
      ]
    : [];
  const allDtcCodes = [
    ...snapshotDtcs,
    ...extraDtcCodes.filter((c) => !snapshotDtcs.includes(c)),
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
  // lookupSpec is fail-soft (never throws) — a DB blip degrades to a clean miss.
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

  // Endpoint-specific context (e.g. prior assessment + captured evidence for the
  // evidence-update flow) goes BEFORE the data block. Empty for Stage 1.
  for (const b of extraContextBlocks) systemBlocks.push(b);

  // Formatted snapshot/observed block (the OBD2 data Claude reasons on) — LAST.
  // Omitted when there's no snapshot (the unified turn while disconnected).
  if (snapshot) {
    systemBlocks.push({
      type: "text",
      text: formatSnapshotBlock(snapshot),
    });
  }

  const mismatchCount = enrichedDtcEntries.filter((e) => e.configMismatch).length;
  console.log(
    `[${logLabel}] model=${DIAGNOSE_MODEL} ` +
      `dtcs=${allDtcCodes.length} enriched=${enrichedDtcEntries.length} mismatches=${mismatchCount} ` +
      `signals=${snapshot ? (snapshot.signals ?? []).length : 0} absent=${snapshot ? (snapshot.absentSignalNames ?? []).length : 0} ` +
      `recalls=${recallsArr.length} tsbs=${tsbsArr.length} ` +
      `specsDetected=${specsToFetch.length} specsInjected=${verifiedSpecs.length} ` +
      `extraBlocks=${extraContextBlocks.length}`,
  );

  return systemBlocks;
}

async function runStructuredAssessment({
  systemPrompt,
  vehicle,
  snapshot,
  recallsArr,
  tsbsArr,
  complaintText,
  extraContextBlocks = [],
  userMessage,
  callType,
  logLabel,
  sessionId,
}) {
  const systemBlocks = await buildAssessmentContextBlocks({
    systemPrompt,
    vehicle,
    snapshot,
    recallsArr,
    tsbsArr,
    complaintText,
    extraContextBlocks,
    logLabel,
  });

  const response = await callAnthropicWithRetry(() =>
    client.messages.create({
      model: DIAGNOSE_MODEL,
      max_tokens: 4096,
      system: systemBlocks,
      tools: [ASSESS_TOOL],
      tool_choice: { type: "tool", name: "emit_diagnostic_assessment" },
      messages: [{ role: "user", content: userMessage }],
    }),
  );

  const costData = logApiCost(response.usage, DIAGNOSE_MODEL, {
    sessionId: typeof sessionId === "string" ? sessionId : null,
    callType,
  });

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.name !== "emit_diagnostic_assessment") {
    return {
      ok: false,
      status: 502,
      error: "Model did not return a structured assessment. Try again.",
      cost: costData ?? null,
    };
  }

  // Soft-validate the 2C-1 monitoring plan: drop any missing/malformed
  // capture_plan (fail-soft → Stage-1 prose fallback), never throw.
  const assessment = softValidateAssessmentPlan(toolUse.input);
  return { ok: true, assessment, cost: costData ?? null };
}

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

  try {
    const result = await runStructuredAssessment({
      systemPrompt: ASSESS_SYSTEM_PROMPT,
      vehicle,
      snapshot,
      recallsArr,
      tsbsArr,
      complaintText,
      extraContextBlocks: [],
      userMessage: userLines.join("\n"),
      callType: "assessment",
      logLabel: "assess",
      sessionId,
    });
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }
    return res.json({ assessment: result.assessment, cost: result.cost });
  } catch (err) {
    return respondWithError(res, err, "assess");
  }
});

// ============================================================================
// /api/evidence-update — Stage 2C-3 evidence-update (the iterative loop's call)
//
// Takes the PRIOR assessment + the phone's summarized captured-evidence window
// (the 2C-2 EvidenceCaptureEntry: observed snapshot + trigger + unavailable
// signals) and returns an EVOLVED assessment (the SAME emit_diagnostic_assessment
// schema), reasoning over the new evidence in light of the hypothesis the prior
// next-step was testing. Single-shot forced-tool (NOT a tool loop) — the
// evidence is already captured + summarized, so there is nothing to request
// mid-turn. The phone writes the evolved assessment into caseState and preserves
// the prior in history (server stays stateless). See assessPrompt.js.
// ============================================================================

function formatPriorAssessmentBlock(prior) {
  const a = prior && typeof prior === "object" ? prior : {};
  const lines = [
    "=== PRIOR ASSESSMENT (your last conclusion + the test you ordered) ===",
    "",
    "This is the assessment YOU produced last time, and the data capture you ordered to test it. Interpret the new evidence below in light of this.",
    "",
  ];
  if (a.stance) lines.push(`Prior stance: ${a.stance}${a.stance_reason ? ` — ${a.stance_reason}` : ""}`, "");
  const hyps = Array.isArray(a.hypotheses) ? a.hypotheses : [];
  if (hyps.length > 0) {
    lines.push("Prior hypotheses (ranked):");
    hyps.forEach((h, i) => {
      if (!h || typeof h !== "object") return;
      lines.push(`  ${i + 1}. ${h.name ?? "(unnamed)"} [${h.confidence ?? "?"}]`);
      const sup = Array.isArray(h.supporting_evidence) ? h.supporting_evidence : [];
      const con = Array.isArray(h.contradicting_evidence) ? h.contradicting_evidence : [];
      for (const s of sup) lines.push(`       + ${s}`);
      for (const c of con) lines.push(`       - ${c}`);
    });
    lines.push("");
  }
  const ns = a.next_step && typeof a.next_step === "object" ? a.next_step : null;
  if (ns) {
    lines.push(
      "The test you ordered (your prior next step):",
      `  Type: ${ns.type ?? "?"}`,
      `  Action: ${ns.action ?? "(none)"}`,
    );
    if (ns.rationale) lines.push(`  Rationale: ${ns.rationale}`);
    lines.push("");
  }
  if (typeof a.data_ceiling_note === "string" && a.data_ceiling_note.trim().length > 0) {
    lines.push(`Prior data-ceiling note: ${a.data_ceiling_note}`, "");
  }
  const specs = Array.isArray(a.unverified_specs_needed) ? a.unverified_specs_needed : [];
  if (specs.length > 0) {
    lines.push("Factory values you previously flagged as needed (still unverified unless injected above):");
    for (const s of specs) {
      if (s && typeof s === "object") lines.push(`  - ${s.parameter ?? "(unnamed)"}${s.purpose ? ` — ${s.purpose}` : ""}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function formatEvidenceBlock(evidence) {
  const e = evidence && typeof evidence === "object" ? evidence : {};
  const lines = [
    "=== CAPTURED EVIDENCE (the result of the test you ordered) ===",
    "",
    "The phone watched the live data stream locally and captured this window when your condition was met. The averaged signal readings are in the LIVE DATA SNAPSHOT block below; this block is the trigger context — WHY and WHEN it fired.",
    "",
    `Capture outcome: ${e.outcome ?? "unknown"}`,
  ];

  // Which requested item fired + the plan that was asked for.
  const requested = Array.isArray(e.requested) ? e.requested : [];
  const trig = e.trigger && typeof e.trigger === "object" ? e.trigger : null;
  if (requested.length > 0) {
    const item = requested[0];
    if (item && typeof item === "object") {
      lines.push(
        "",
        "The capture you requested:",
        `  Signal: ${item.signal_id ?? "?"}`,
        `  Condition: ${item.operating_condition ?? "(unspecified)"}`,
      );
    }
  }

  if (trig) {
    lines.push("", "Trigger context at the moment the capture fired:");
    if (trig.targetSignalId != null) {
      lines.push(
        `  Measured target ${trig.targetSignalId} = ${trig.targetValueAtFire ?? "n/a"} at fire time`,
      );
    }
    const gates = Array.isArray(trig.gateValuesAtFire) ? trig.gateValuesAtFire : [];
    for (const g of gates) {
      if (!g || typeof g !== "object") continue;
      const r = g.range && typeof g.range === "object" ? g.range : {};
      const band =
        r.min != null && r.max != null
          ? `${r.min}-${r.max}${r.unit ?? ""}`
          : r.min != null
            ? `>= ${r.min}${r.unit ?? ""}`
            : r.max != null
              ? `<= ${r.max}${r.unit ?? ""}`
              : "(any)";
      lines.push(`  Gate ${g.signal_id ?? "?"} = ${g.value ?? "n/a"} (window: ${band})`);
    }
    if (typeof trig.sustainedHeldMs === "number") {
      lines.push(`  The condition held for ${(trig.sustainedHeldMs / 1000).toFixed(1)} seconds before the window was captured.`);
    }
  }

  // Signals the phone could not watch on this vehicle (honest gaps).
  const unavailable = Array.isArray(e.unavailableSignals) ? e.unavailableSignals : [];
  if (unavailable.length > 0) {
    lines.push(
      "",
      "Signals you asked to watch that the vehicle could NOT provide (treat as gaps — do not assume they read normal):",
    );
    for (const u of unavailable) {
      if (u && typeof u === "object") lines.push(`  - ${u.signal_id ?? "?"} (${u.reason ?? "unavailable"})`);
    }
  }

  return lines.join("\n");
}

app.post("/api/evidence-update", async (req, res) => {
  const {
    vehicle,
    vin,
    mileage,
    complaint,
    priorAssessment,
    evidence,
    recalls,
    tsbs,
    sessionId,
    caseId,
  } = req.body ?? {};

  if (!vehicle || typeof vehicle !== "object") {
    return res.status(400).json({ error: "Missing or invalid 'vehicle'." });
  }
  if (!priorAssessment || typeof priorAssessment !== "object") {
    return res.status(400).json({ error: "Missing or invalid 'priorAssessment'." });
  }
  if (!evidence || typeof evidence !== "object" || !evidence.observed || typeof evidence.observed !== "object") {
    return res.status(400).json({ error: "Missing or invalid 'evidence' (needs an 'observed' snapshot)." });
  }

  const snapshot = evidence.observed; // the summarized captured window (a DiagnosticSnapshot)
  const recallsArr = Array.isArray(recalls) ? recalls : [];
  const tsbsArr = Array.isArray(tsbs) ? tsbs : [];
  const complaintText = typeof complaint === "string" ? complaint.trim() : "";
  const mileageText =
    typeof mileage === "string" && mileage.trim().length > 0
      ? mileage.trim()
      : vehicle.mileage ?? "Not provided";

  const extraContextBlocks = [
    { type: "text", text: formatPriorAssessmentBlock(priorAssessment) },
    { type: "text", text: formatEvidenceBlock(evidence) },
  ];

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
    userLines.push("", `Original presenting complaint: ${complaintText}`);
  } else {
    userLines.push("", "Original presenting complaint: (none provided)");
  }
  userLines.push(
    "",
    "You previously assessed this vehicle and ordered a data capture (see PRIOR ASSESSMENT and CAPTURED EVIDENCE above). Re-assess holistically: interpret the new evidence in light of the hypothesis your prior next-step was testing, then emit a complete fresh assessment. It replaces your prior assessment as the current picture; the app preserves the prior in the case history.",
  );

  if (caseId) console.log(`[evidence-update] caseId=${caseId}`);

  try {
    const result = await runStructuredAssessment({
      systemPrompt: EVIDENCE_UPDATE_SYSTEM_PROMPT,
      vehicle,
      snapshot,
      recallsArr,
      tsbsArr,
      complaintText,
      extraContextBlocks,
      userMessage: userLines.join("\n"),
      callType: "evidence-update",
      logLabel: "evidence-update",
      sessionId,
    });
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }
    return res.json({ assessment: result.assessment, cost: result.cost });
  } catch (err) {
    return respondWithError(res, err, "evidence-update");
  }
});

// ============================================================================
// /api/diagnose-turn — Stage 2C-4 SB3: the UNIFIED diagnostic brain.
//
// One brain, one move per turn. The brain commits to exactly one tool:
//   - ask_followup_question  → a conversational question / physical-check direction
//   - emit_diagnostic_assessment → a structured differential + next_step; a
//     DATA_CAPTURE next_step (with capture_plan) is the "request a live capture"
//     move (reuses the 2C-1 schema + the 2C-4 executor + /api/evidence-update,
//     which takes this assessment as its priorAssessment)
//   - provide_diagnosis     → a committed final diagnosis (conclude)
// Decision rule + per-tool spec discipline live in UNIFIED_SYSTEM_PROMPT. Context
// is assembled by the SHARED buildAssessmentContextBlocks (snapshot when
// connected; complaint-text DTCs when not). ADDITIVE — /api/assess and
// /api/diagnose are unchanged; this is validated by crafted deployed calls
// before any mobile wiring. The phone-consumed `turn` shape is added compile-
// time-only to lib/assessmentTypes.ts; its OTA rides with the mobile sub-batch.
// ============================================================================
app.post("/api/diagnose-turn", async (req, res) => {
  const {
    vehicle,
    vin,
    mileage,
    complaint,
    messages,
    snapshot,
    connected,
    recalls,
    tsbs,
    sessionId,
  } = req.body ?? {};

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
  // Connected = the app-level signal AND a usable snapshot is present. Only then
  // does the brain have a capture path / live snapshot to reason over.
  const hasSnapshot = !!snapshot && typeof snapshot === "object";
  const isConnected = connected === true && hasSnapshot;
  const presentingComplaint = String(messages[0]?.content ?? "");
  const complaintText =
    typeof complaint === "string" && complaint.trim().length > 0
      ? complaint.trim()
      : presentingComplaint;
  // DTCs the brain should know about when disconnected (no snapshot) come from
  // the complaint text, exactly like /api/diagnose.
  const extraDtcCodes = extractDtcCodes(presentingComplaint);

  const systemBlocks = await buildAssessmentContextBlocks({
    systemPrompt: UNIFIED_SYSTEM_PROMPT,
    vehicle,
    snapshot: isConnected ? snapshot : null,
    recallsArr,
    tsbsArr,
    complaintText,
    extraDtcCodes,
    extraContextBlocks: [],
    logLabel: "diagnose-turn",
  });

  try {
    const response = await callAnthropicWithRetry(() =>
      client.messages.create({
        model: DIAGNOSE_MODEL,
        max_tokens: 8192,
        system: systemBlocks,
        tools: UNIFIED_TURN_TOOLS,
        tool_choice: { type: "any" },
        messages: buildMessages(vehicle, messages),
      }),
    );

    const costData = logApiCost(response.usage, DIAGNOSE_MODEL, {
      sessionId: typeof sessionId === "string" ? sessionId : null,
      callType: "diagnose-turn",
    });

    const toolUse = response.content.find((b) => b.type === "tool_use");
    if (!toolUse) {
      return res.status(502).json({
        error: "Model did not return a turn. Try again.",
      });
    }

    if (toolUse.name === "ask_followup_question") {
      return res.json({
        turn: { kind: "question", question: toolUse.input.question },
        cost: costData ?? null,
      });
    }
    if (toolUse.name === "emit_diagnostic_assessment") {
      // Soft-validate the 2C-1 monitoring plan (fail-soft → Stage-1 prose), same
      // as /api/assess. A DATA_CAPTURE next_step here IS the "request a capture"
      // move; the phone runs it and this assessment becomes the evidence-update
      // priorAssessment.
      const assessment = softValidateAssessmentPlan(toolUse.input);
      return res.json({
        turn: { kind: "assessment", assessment },
        cost: costData ?? null,
      });
    }
    if (toolUse.name === "provide_diagnosis") {
      return res.json({
        turn: { kind: "diagnosis", diagnosis: toolUse.input },
        cost: costData ?? null,
      });
    }

    return res.status(502).json({ error: `Unexpected tool: ${toolUse.name}` });
  } catch (err) {
    return respondWithError(res, err, "diagnose-turn");
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

  // Probe the Supabase data-layer connection (fire-and-forget so it never
  // delays the health check). Logs "[db] connected" on success or a loud
  // "[db] ERROR" on failure — it does not crash the server, since the data
  // layer has no live consumers yet (foundation only).
  initDb();
});
