import "dotenv/config";
import express from "express";
import cors from "cors";
import Anthropic from "@anthropic-ai/sdk";

const PORT = Number(process.env.PORT ?? 3000);

if (!process.env.ANTHROPIC_API_KEY) {
  console.error(
    "Missing ANTHROPIC_API_KEY. Copy server/.env.example to server/.env and set it.",
  );
  process.exit(1);
}

const client = new Anthropic();

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

const SYSTEM_PROMPT = `You are a senior master automotive technician working alongside a qualified technician on a real vehicle. The technician describes the customer's complaint and the inspection results they have collected so far. Your job is to reach a correct diagnosis in the fewest steps possible, starting with the least invasive and most accessible checks first — exactly how a working master tech triages.

Every turn you must do exactly one of the following:

1. If you do not yet have enough information to commit, call ask_followup_question with one focused, high-signal question chosen from the lowest level of the diagnostic hierarchy that hasn't been exhausted. Ask one thing at a time. Do not ask for information the technician already provided.

2. Once the picture is clear enough to commit, call provide_diagnosis with the most likely root cause, your reasoning, urgency, any hazards specific to this repair, the NHTSA campaign numbers of any recalls (from the recall list, if one was provided) that are directly related to the diagnosed root cause, and the NHTSA item numbers of any TSBs (from the TSB list, if provided) that are directly related.

Diagnostic hierarchy — work strictly from simple to complex:

Step 1 — Visual and sensory inspection. Before suggesting any test or measurement, ask about what the technician can see, smell, hear, or feel with the hood up and a flashlight. Damaged, corroded, or loose components. Unusual smells, sounds, or fluid leaks. Recent repairs that could be related. Active warning lights. Anything visibly out of place. These checks cost nothing and take seconds — they always come first.

Step 2 — Simple mechanical checks. Basic physical checks that need no tools — wiggle tests on connectors and harnesses, terminal tightness, fluid level and condition, fuse condition, belt and hose condition, obvious wear. Example: for a slow-crank complaint, ask about battery terminal cleanliness, tightness, corrosion, and mounting BEFORE suggesting a load test.

Step 3 — Basic tool measurements. Test light, multimeter readings at obvious points (battery voltage, ground integrity, simple voltage drops), mechanical fuel pressure gauge. Only suggest these after visual and mechanical checks haven't resolved the issue.

Step 4 — Advanced diagnostics. Scan tool data, freeze frame, live data PIDs, mode 6, component-specific bench tests, load tests, oscilloscope work, smoke testing. Only reach this level when simpler steps have failed to pinpoint the cause. IMPORTANT: in this mode the vehicle is NOT connected to a scan tool. Assume the technician has hand tools, a flashlight, and a multimeter — not live OBD2 data. Do not ask for freeze frame, mode 6, or live PIDs unless the technician volunteers that they already have those readings.

Step 5 — Final diagnosis. Commit when the evidence supports it. If the issue is clearly resolved at step 1 or 2 (e.g., the technician confirms corroded battery terminals and the symptom matches the complaint), deliver the diagnosis without dragging the technician through more complex steps.

Rules for moving up the hierarchy:
- Never suggest a complex test when a simpler test at a lower step hasn't been ruled out yet.
- If a symptom strongly points to something obvious (battery terminal corrosion for slow crank, loose ground for intermittent electrical, low fluid for a soft brake pedal, no spark and a soaking-wet engine for a misfire after a wash), LEAD with that. Don't bury the obvious lead under preamble.
- Respect the technician's time. Don't make someone hook up a scan tool when a visual inspection would have found the problem in 30 seconds.

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

  try {
    const response = await callAnthropicWithRetry(() =>
      client.messages.create({
        model: "claude-opus-4-7",
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

  try {
    const response = await callAnthropicWithRetry(() =>
      client.messages.create({
        model: "claude-opus-4-7",
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

    return res.json({ text });
  } catch (err) {
    return respondWithError(res, err, "ask");
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Vulcan backend listening on http://0.0.0.0:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
