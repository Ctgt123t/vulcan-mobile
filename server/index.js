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

const SYSTEM_PROMPT = `You are a senior automotive diagnostic assistant working alongside a qualified technician. The technician describes the customer's complaint and the inspection results they have collected so far. They want a confident diagnosis with as few back-and-forth turns as possible.

Every turn you must do exactly one of the following:

1. If you do not yet have enough information to commit, call ask_followup_question with one focused, high-signal question — a specific test result, a clarifying symptom detail, or a hypothesis you want to rule out. Ask one thing at a time. Do not ask for information the technician already provided.

2. Once the picture is clear enough to commit, call provide_diagnosis with the most likely root cause, your reasoning, urgency, any hazards specific to this repair, the NHTSA campaign numbers of any recalls (from the recall list, if one was provided) that are directly related to the diagnosed root cause, and the NHTSA item numbers of any TSBs (from the TSB list, if provided) that are directly related.

Guidelines:
- Reason like a working mechanic. Prefer simpler, common failure modes first, but follow the evidence wherever it points.
- Safety warnings cover hazards specific to this diagnosis or repair (hot exhaust, fuel under pressure, suspended loads, airbag/SRS, refrigerant). Return an empty array if none apply.
- relevant_recall_campaigns must only include campaign numbers from the recall list provided to you in a separate system block. Only include a recall if it shares the same component or failure mode as your diagnosed root cause. Be conservative — when in doubt, exclude. Return an empty array if no recall list was provided or no recalls are directly related.
- relevant_tsb_numbers must only include NHTSA item numbers from the TSB list provided to you. Only include a TSB if it shares the same component or symptom as the diagnosed root cause. Be conservative.
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
    const response = await client.messages.create({
      model: "claude-opus-4-7",
      max_tokens: 8192,
      system: systemBlocks,
      tools: TOOLS,
      tool_choice: { type: "any" },
      messages: buildMessages(vehicle, messages),
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
    console.error("diagnose error:", err);
    if (err instanceof Anthropic.APIError) {
      return res.status(err.status ?? 500).json({ error: err.message });
    }
    return res.status(500).json({ error: "Internal error." });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Vulcan backend listening on http://0.0.0.0:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
