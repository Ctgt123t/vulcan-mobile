import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ----------------------------------------------------------------------------
// Claude fallback for DTC codes that aren't in the static database.
//
// Flow (driven by the /api/dtc/:code endpoint):
//   1. Static DB / pattern handlers miss → return null from lookupDtc
//   2. Endpoint asks this module: do we have a cached Claude answer?
//   3. If yes → return immediately, no Claude call
//   4. If no → call Claude with a structured-output tool, cache the result,
//      return it
//
// Cache is persisted to dtcCache.json (gitignored) so it survives within a
// running container. Railway redeploys do reset filesystem unless a Volume
// is mounted — fine for now since the universe of "real" missing codes a
// shop will hit is small. Mount a Volume later if persistence matters.
//
// Each fallback hit is also written to memory so concurrent in-flight
// requests for the same code don't duplicate the Claude call.
// ----------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CACHE_PATH = path.join(__dirname, "dtcCache.json");

let cache = {
  entries: {},
  hits: 0,
  misses: 0,
  writes: 0,
  claudeCalls: 0,
  claudeErrors: 0,
};

try {
  if (fs.existsSync(CACHE_PATH)) {
    const raw = fs.readFileSync(CACHE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    cache = {
      entries: parsed.entries ?? {},
      hits: parsed.hits ?? 0,
      misses: parsed.misses ?? 0,
      writes: parsed.writes ?? 0,
      claudeCalls: parsed.claudeCalls ?? 0,
      claudeErrors: parsed.claudeErrors ?? 0,
    };
    console.log(
      `[dtc-fallback] loaded ${Object.keys(cache.entries).length} cached Claude definitions`,
    );
  }
} catch (err) {
  console.warn(
    "[dtc-fallback] failed to load dtcCache.json, starting fresh:",
    err.message,
  );
}

function persist() {
  try {
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
  } catch (err) {
    console.warn("[dtc-fallback] failed to write dtcCache.json:", err.message);
  }
}

function cacheKey(code, make) {
  return `${code}::${(make || "GENERIC").toUpperCase()}`;
}

export function getCachedFallback(code, make) {
  const key = cacheKey(code, make);
  return cache.entries[key] || null;
}

export function dtcFallbackStats() {
  return {
    entries: Object.keys(cache.entries).length,
    hits: cache.hits,
    misses: cache.misses,
    writes: cache.writes,
    claudeCalls: cache.claudeCalls,
    claudeErrors: cache.claudeErrors,
  };
}

// In-flight dedupe: two concurrent requests for the same code share a single
// Claude call.
const inFlight = new Map();

// ---- Claude tool / prompt ---------------------------------------------------

const FALLBACK_MODEL = "claude-sonnet-4-6";

const SYSTEM_PROMPT = `You are an ASE Master Certified automotive technician with deep familiarity with OBD-II diagnostic trouble codes — generic SAE J2012 codes and manufacturer-specific codes across all major brands. You are answering a fellow technician's lookup for a specific DTC.

Return ONE tool call that fills the provide_dtc_definition schema. Be honest about uncertainty: if a code is obscure or you are not confident in a specific definition, say so in detailedDescription — do NOT invent confident-sounding specifics. Prefer "this code likely refers to…" or "limited published information; based on the code's category…" framing in those cases rather than fabricating part numbers, pin counts, or test procedures.

Field guidance:
- shortDescription: one-line label, similar to OEM scan-tool text (e.g. "Knock Sensor 1 Circuit Range/Performance Bank 1").
- detailedDescription: 1-3 sentences explaining what the PCM detected and the typical conditions that set the code.
- system: short label like "Powertrain", "Ignition", "Chassis - ABS", "Body - Restraints", "Network Communication", "Variable Valve Timing", etc.
- commonCauses: 3-6 plausible causes ordered from most-common / easiest-to-check to least-common / harder-to-rule-out. Each as a short bullet. Empty array only if you genuinely cannot suggest any.
- urgency: "low" for monitor-and-revisit, "medium" for "address soon", "high" for "do not drive until resolved" or "active safety risk".`;

const TOOL = {
  name: "provide_dtc_definition",
  description:
    "Provide a structured definition for the requested DTC code. Always return exactly one tool call with all fields populated.",
  input_schema: {
    type: "object",
    properties: {
      shortDescription: {
        type: "string",
        description:
          "One-line scan-tool-style label for the code (no leading code text).",
      },
      detailedDescription: {
        type: "string",
        description:
          "1-3 sentence explanation of what the PCM detected and typical set conditions. Acknowledge uncertainty for obscure codes.",
      },
      system: {
        type: "string",
        description:
          'Short system label, e.g. "Powertrain", "Ignition", "Chassis - ABS".',
      },
      commonCauses: {
        type: "array",
        items: { type: "string" },
        description:
          "3-6 plausible causes, ordered easiest-to-check first. Empty array only if you genuinely have no leads.",
      },
      urgency: {
        type: "string",
        enum: ["low", "medium", "high"],
        description:
          'Severity. "high" only for active safety risk or do-not-drive scenarios.',
      },
    },
    required: [
      "shortDescription",
      "detailedDescription",
      "system",
      "commonCauses",
      "urgency",
    ],
  },
};

// ---- Public entry point -----------------------------------------------------

// Returns a DtcDefinition matching the static-DB shape, or throws on Claude
// failure (caller surfaces a 5xx). callClaude(params) must run the Anthropic
// messages.create() call and apply whatever retry policy the host server uses
// — this module stays decoupled from the Anthropic SDK setup.
export async function fetchDtcFallback(code, make, callClaude) {
  const key = cacheKey(code, make);

  // Cache hit
  const cached = cache.entries[key];
  if (cached) {
    cache.hits++;
    persist();
    console.log(
      `[dtc-fallback] HIT ${key} (totalHits=${cache.hits})`,
    );
    return cached.entry;
  }

  // In-flight dedupe — if another request is already asking Claude for the
  // same key, await that one instead of issuing a second call.
  if (inFlight.has(key)) {
    return inFlight.get(key);
  }

  const promise = (async () => {
    cache.misses++;
    cache.claudeCalls++;
    console.log(
      `[dtc-fallback] MISS ${key} — calling Claude (model=${FALLBACK_MODEL})`,
    );

    const userText = make
      ? `Look up DTC code: ${code}\nVehicle make: ${make}\n\nProvide a definition tailored to this manufacturer if you know one; otherwise give the generic SAE interpretation.`
      : `Look up DTC code: ${code}\n\nProvide the SAE / generic definition.`;

    let response;
    try {
      response = await callClaude({
        model: FALLBACK_MODEL,
        max_tokens: 1024,
        system: [
          {
            type: "text",
            text: SYSTEM_PROMPT,
            cache_control: { type: "ephemeral" },
          },
        ],
        tools: [TOOL],
        tool_choice: { type: "tool", name: "provide_dtc_definition" },
        messages: [{ role: "user", content: userText }],
      });
    } catch (err) {
      cache.claudeErrors++;
      persist();
      throw err;
    }

    const toolUse = response.content.find((b) => b.type === "tool_use");
    if (!toolUse || toolUse.name !== "provide_dtc_definition") {
      cache.claudeErrors++;
      persist();
      throw new Error("Claude did not return the expected tool call.");
    }

    const def = toolUse.input;
    const entry = {
      code,
      shortDescription: String(def.shortDescription || "").trim(),
      detailedDescription: String(def.detailedDescription || "").trim(),
      system: String(def.system || "Unknown").trim(),
      commonCauses: Array.isArray(def.commonCauses)
        ? def.commonCauses.map((s) => String(s).trim()).filter(Boolean)
        : [],
      urgency: ["low", "medium", "high"].includes(def.urgency)
        ? def.urgency
        : "medium",
    };

    cache.entries[key] = {
      entry,
      make: make || null,
      source: "claude",
      model: FALLBACK_MODEL,
      createdAt: new Date().toISOString(),
    };
    cache.writes++;
    persist();
    console.log(
      `[dtc-fallback] STORE ${key} (totalEntries=${Object.keys(cache.entries).length})`,
    );
    return entry;
  })();

  inFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(key);
  }
}
