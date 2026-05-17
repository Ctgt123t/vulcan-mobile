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

2. Once the picture is clear enough to commit, call provide_diagnosis with the most likely root cause, your reasoning, urgency, estimated cost range, an ordered repair procedure, and any hazards specific to this repair.

Guidelines:
- Reason like a working mechanic. Prefer simpler, common failure modes first, but follow the evidence wherever it points.
- Cost estimates should be realistic USD ranges reflecting typical independent shop labor and parts unless context suggests otherwise.
- Safety warnings cover hazards specific to this diagnosis or repair (hot exhaust, fuel under pressure, suspended loads, airbag/SRS, refrigerant). Return an empty array if none apply.
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
      "Commit to a final diagnosis with root cause, reasoning, urgency, cost estimate, ordered repair procedure, and any safety warnings.",
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
        estimated_cost_range: {
          type: "object",
          properties: {
            min: { type: "number" },
            max: { type: "number" },
            currency: {
              type: "string",
              description: "Three-letter ISO currency code, e.g. USD.",
            },
          },
          required: ["min", "max", "currency"],
        },
        repair_procedure: {
          type: "array",
          items: { type: "string" },
          description: "Ordered list of repair steps in plain language.",
        },
        safety_warnings: {
          type: "array",
          items: { type: "string" },
          description:
            "Hazards specific to this diagnosis or repair. Empty array if none.",
        },
      },
      required: [
        "root_cause",
        "reasoning",
        "urgency",
        "estimated_cost_range",
        "repair_procedure",
        "safety_warnings",
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

app.post("/api/diagnose", async (req, res) => {
  const { vehicle, messages } = req.body ?? {};

  if (!vehicle || typeof vehicle !== "object") {
    return res.status(400).json({ error: "Missing or invalid 'vehicle'." });
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "Missing or empty 'messages'." });
  }
  if (messages[0].role !== "user") {
    return res.status(400).json({ error: "First message must be from the user." });
  }

  try {
    const response = await client.messages.create({
      model: "claude-opus-4-7",
      max_tokens: 8192,
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
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
