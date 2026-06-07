// ----------------------------------------------------------------------------
// Extraction-engine vertical slice (PROOF OF CONCEPT).
//
// Proves end-to-end: a source PDF -> a `source` provenance row -> Claude
// extracts structured specs + component facts via forced tool use -> validate
// -> store in spec / component_fact with the source_id FK -> read back.
//
// Scope (deliberately contained):
//   - Specs + component facts only, into the EXISTING 0001_init.sql schema.
//   - Does NOT expand the schema, touch the app's live spec path, or touch any
//     JSON cache. Manual-run only (`node scripts/extractFromPdf.js [pdfPath]`).
//     Not wired into any endpoint.
//
// Core rule (enforced by prompt + a hard validation gate): Claude extracts
// ONLY what the document literally states. Every item must carry a verbatim
// quote + page; no quote -> quarantined, never stored. Nothing is supplied
// from model memory.
//
// Model: claude-opus-4-6 (project standard; priced in costConfig.js so the
// existing logApiCost gives the input/output/cache cost split for free).
// ----------------------------------------------------------------------------

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { PDFDocument } from "pdf-lib";
import { pool } from "../db.js";
import { logApiCost } from "../costLogger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODEL = "claude-opus-4-6";

// This manual is 594 pages / ~1.185M tokens — it EXCEEDS Opus 4.6's 1M context
// window, so it cannot be sent whole. We split into page-range chunks that each
// fit (~150 pages ≈ ~300K tokens), extract per chunk, then merge. Summed chunk
// cost approximates the cost of processing the whole document.
const MAX_PAGES_PER_CHUNK = 150;
const CONTEXT_LIMIT = 1_000_000;

const DEFAULT_PDF = path.join(
  __dirname,
  "..",
  "extraction_test",
  "2011-sierra-owner-manual.pdf.pdf", // actual on-disk name (double extension)
);
const PDF_PATH = process.argv[2]
  ? path.resolve(process.argv[2])
  : DEFAULT_PDF;

// Controlled vocab — must match the CHECK constraint in 0001_init.sql.
const SPEC_TYPES = [
  "oil_capacity", "oil_viscosity", "oil_type",
  "coolant_capacity", "coolant_type",
  "transmission_fluid_type", "transmission_fluid_capacity",
  "brake_fluid_type", "power_steering_fluid_type",
  "torque", "tire_pressure", "spark_plug_gap",
  "battery_group", "maintenance_interval",
  "refrigerant_type", "refrigerant_capacity", "other",
];

const SYSTEM_PROMPT = `You are a precise automotive data-extraction engine. You are given the official owner's manual PDF for a 2011 GMC Sierra.

Extract factory specifications and component facts that are EXPLICITLY STATED in this document.

ABSOLUTE RULE — extract only what the document says:
- For every item you MUST copy a verbatim_quote exactly from the page where it appears, plus the page number.
- If a value is not stated in the document, OMIT it. Never supply a value from your own knowledge or training. Do not infer, calculate, average, or fill gaps.
- A spec you cannot quote verbatim from the document does not exist for this task.

Engine association:
- Many specs differ by engine (e.g. oil capacity). When the document ties a value to a specific engine, put that engine string (as written, e.g. "5.3L V8") in the engine field.
- Leave engine empty only for values that apply to the whole vehicle.

Spec typing:
- Use the spec_type that best matches. If none fits, use "other" and describe it in value_text.
- Numeric specs: provide value_numeric + value_unit. Textual specs (fluid types, viscosities/grades): provide value_text.
- qualifier captures conditions like "with filter", "severe service", "cold".

Also populate other_data_types_present with the CATEGORIES of other extractable data you observed in this manual but did NOT extract (e.g. fuse assignments, bulb part numbers, warning-light meanings) — names only, for planning. Do not extract those.`;

const TOOL = {
  name: "emit_extracted_specs",
  description:
    "Emit the specifications and component facts extracted verbatim from the document.",
  input_schema: {
    type: "object",
    properties: {
      specs: {
        type: "array",
        items: {
          type: "object",
          properties: {
            spec_type: { type: "string", enum: SPEC_TYPES },
            value_numeric: { type: "number" },
            value_unit: { type: "string" },
            value_text: { type: "string" },
            qualifier: { type: "string" },
            engine: { type: "string", description: "Engine this spec applies to, as written; empty if vehicle-wide." },
            confidence: { type: "number", description: "0-1 confidence the value was read correctly." },
            page: { type: "integer", description: "PDF page where the value appears." },
            verbatim_quote: { type: "string", description: "Exact text copied from the document proving this value." },
          },
          required: ["spec_type", "page", "verbatim_quote"],
        },
      },
      component_facts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            component: { type: "string" },
            fact_type: { type: "string" },
            value_text: { type: "string" },
            engine: { type: "string" },
            page: { type: "integer" },
            verbatim_quote: { type: "string" },
          },
          required: ["component", "fact_type", "value_text", "page", "verbatim_quote"],
        },
      },
      other_data_types_present: {
        type: "array",
        items: { type: "string" },
        description: "Categories of other extractable data seen but not extracted.",
      },
    },
    required: ["specs", "component_facts", "other_data_types_present"],
  },
};

// ---- Validation gate ------------------------------------------------------

const CAP_UNITS = ["qt", "qts", "quart", "quarts", "l", "liter", "liters", "litre", "litres", "gal", "gallon", "gallons"];
const PRESS_UNITS = ["psi", "kpa", "bar"];
const TORQUE_UNITS = ["ft-lb", "ft-lbs", "ftlb", "lb-ft", "lbft", "ft·lb", "nm", "n·m", "n-m"];
const GAP_UNITS = ["in", "inch", "inches", "\"", "mm"];
const INTERVAL_UNITS = ["mi", "mile", "miles", "km", "kilometer", "kilometers", "mo", "month", "months", "yr", "year", "years"];

const NUMERIC_TYPES = new Set([
  "oil_capacity", "coolant_capacity", "transmission_fluid_capacity",
  "refrigerant_capacity", "torque", "tire_pressure", "spark_plug_gap",
  "maintenance_interval",
]);

function norm(u) {
  return String(u ?? "").trim().toLowerCase();
}

// Returns { ok: true } or { ok: false, reason }.
function validateSpec(s) {
  if (!s.verbatim_quote || String(s.verbatim_quote).trim().length < 3) {
    return { ok: false, reason: "no verbatim_quote (hard gate)" };
  }
  if (!SPEC_TYPES.includes(s.spec_type)) {
    return { ok: false, reason: `spec_type "${s.spec_type}" not in controlled vocab` };
  }

  const hasNum = typeof s.value_numeric === "number" && !Number.isNaN(s.value_numeric);
  const hasText = s.value_text && String(s.value_text).trim().length > 0;

  if (!hasNum && !hasText) {
    return { ok: false, reason: "neither value_numeric nor value_text present" };
  }

  if (NUMERIC_TYPES.has(s.spec_type) && hasNum) {
    const u = norm(s.value_unit);
    if (!u) return { ok: false, reason: "numeric spec missing value_unit" };

    const v = s.value_numeric;
    let ok = true;
    let why = "";

    switch (s.spec_type) {
      case "oil_capacity":
      case "coolant_capacity":
      case "transmission_fluid_capacity": {
        if (!CAP_UNITS.includes(u)) { ok = false; why = `unit "${u}" not a capacity unit`; break; }
        const max = /l|liter|litre/.test(u) ? 25 : 25;
        if (v < 1 || v > max) { ok = false; why = `capacity ${v}${u} out of plausible range`; }
        break;
      }
      case "refrigerant_capacity": {
        // lb / oz / g — wide, lenient range across units.
        if (v <= 0 || v > 2000) { ok = false; why = `refrigerant amount ${v}${u} implausible`; }
        break;
      }
      case "torque": {
        if (!TORQUE_UNITS.includes(u)) { ok = false; why = `unit "${u}" not a torque unit`; break; }
        if (v < 3 || v > 800) { ok = false; why = `torque ${v}${u} out of plausible range`; }
        break;
      }
      case "tire_pressure": {
        if (!PRESS_UNITS.includes(u)) { ok = false; why = `unit "${u}" not a pressure unit`; break; }
        if (u === "kpa") { if (v < 100 || v > 700) { ok = false; why = `tire pressure ${v}kPa out of range`; } }
        else if (u === "bar") { if (v < 1 || v > 7) { ok = false; why = `tire pressure ${v}bar out of range`; } }
        else if (v < 15 || v > 90) { ok = false; why = `tire pressure ${v}psi out of range`; }
        break;
      }
      case "spark_plug_gap": {
        if (!GAP_UNITS.includes(u)) { ok = false; why = `unit "${u}" not a gap unit`; break; }
        if (u === "mm") { if (v < 0.3 || v > 2.5) { ok = false; why = `gap ${v}mm out of range`; } }
        else if (v < 0.01 || v > 0.1) { ok = false; why = `gap ${v}in out of range`; }
        break;
      }
      case "maintenance_interval": {
        if (!INTERVAL_UNITS.includes(u)) { ok = false; why = `unit "${u}" not an interval unit`; break; }
        if (v < 1 || v > 300000) { ok = false; why = `interval ${v}${u} out of range`; }
        break;
      }
    }
    if (!ok) return { ok: false, reason: why };
  }

  return { ok: true };
}

function validateComponentFact(f) {
  if (!f.verbatim_quote || String(f.verbatim_quote).trim().length < 3) {
    return { ok: false, reason: "no verbatim_quote (hard gate)" };
  }
  if (!f.component || !f.fact_type || !f.value_text) {
    return { ok: false, reason: "missing component / fact_type / value_text" };
  }
  return { ok: true };
}

// ---- DB helpers -----------------------------------------------------------

async function resolveVariant(client, engine) {
  const r = await client.query(
    `insert into vehicle_variant
       (year, make, model, series_trim, engine_code, engine_descriptor, drivetrain, market)
     values ($1, $2, $3, '', '', $4, '', '')
     on conflict on constraint vehicle_variant_unique_config
       do update set make = excluded.make
     returning id`,
    [2011, "GMC", "Sierra", String(engine ?? "").trim()],
  );
  return r.rows[0].id;
}

// ---- Extraction (one Claude call over a base64 PDF chunk) -----------------

async function extractChunk(client, pdfB64, pageNote) {
  const userContent = [
    { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfB64 } },
    {
      type: "text",
      text:
        `${pageNote} Extract every factory specification and component fact you can quote ` +
        `verbatim from these pages. Report absolute manual page numbers. Call ` +
        `emit_extracted_specs exactly once.`,
    },
  ];
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 32000,
    system: SYSTEM_PROMPT,
    tools: [TOOL],
    tool_choice: { type: "tool", name: "emit_extracted_specs" },
    messages: [{ role: "user", content: userContent }],
  });
  const final = await stream.finalMessage();
  const costData = logApiCost(final.usage, MODEL, { callType: "extraction" });
  const toolBlock = final.content.find((b) => b.type === "tool_use");
  return { out: toolBlock ? toolBlock.input : null, costData, stopReason: final.stop_reason };
}

// Build a base64 PDF containing pages [start, end) (0-indexed) of srcDoc.
async function chunkToB64(srcDoc, start, end) {
  const chunk = await PDFDocument.create();
  const idx = [];
  for (let i = start; i < end; i++) idx.push(i);
  const copied = await chunk.copyPages(srcDoc, idx);
  for (const p of copied) chunk.addPage(p);
  const bytes = await chunk.save();
  return Buffer.from(bytes).toString("base64");
}

// ---- Main -----------------------------------------------------------------

async function main() {
  if (!fs.existsSync(PDF_PATH)) {
    console.error(`[extract] PDF not found at ${PDF_PATH}`);
    process.exit(1);
  }

  const bytes = fs.statSync(PDF_PATH).size;
  console.log(`[extract] PDF: ${path.basename(PDF_PATH)} (${(bytes / 1024 / 1024).toFixed(2)} MB)`);
  if (bytes > 30 * 1024 * 1024) {
    console.error("[extract] PDF exceeds ~30MB — base64 may overflow the 32MB request limit; use the Files API.");
    process.exit(1);
  }

  const pdfBytes = fs.readFileSync(PDF_PATH);
  const client = new Anthropic();

  // --- Pre-flight: token count of the WHOLE document (headline finding) --
  let preflightTokens = null;
  try {
    const tc = await client.messages.countTokens({
      model: MODEL,
      system: SYSTEM_PROMPT,
      tools: [TOOL],
      messages: [{
        role: "user",
        content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBytes.toString("base64") } },
          { type: "text", text: "count" },
        ],
      }],
    });
    preflightTokens = tc.input_tokens;
    console.log(`[extract] whole-document token size: ${preflightTokens.toLocaleString()} input tokens`);
  } catch (err) {
    console.warn(`[extract] token-count pre-flight failed (continuing): ${err.message}`);
  }

  // --- Decide chunking ---------------------------------------------------
  const srcDoc = await PDFDocument.load(pdfBytes);
  const pageCount = srcDoc.getPageCount();
  const wholeFits = preflightTokens != null && preflightTokens <= CONTEXT_LIMIT * 0.95;
  const chunks = [];
  if (wholeFits) {
    chunks.push([0, pageCount]);
  } else {
    for (let s = 0; s < pageCount; s += MAX_PAGES_PER_CHUNK) {
      chunks.push([s, Math.min(s + MAX_PAGES_PER_CHUNK, pageCount)]);
    }
  }
  console.log(
    `[extract] ${pageCount} pages -> ${chunks.length} chunk(s)` +
      (wholeFits ? " (fits whole)" : ` of <=${MAX_PAGES_PER_CHUNK} pages (exceeds 1M context — splitting)`),
  );

  // --- Extract each chunk, merge ----------------------------------------
  const rawSpecs = [];
  const rawFacts = [];
  const discoverySet = new Set();
  const totals = {
    tokens: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 },
    cost: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, total: 0 },
  };
  let anyTruncated = false;

  for (let ci = 0; ci < chunks.length; ci++) {
    const [start, end] = chunks[ci];
    const note = `This is pages ${start + 1}-${end} of a ${pageCount}-page 2011 GMC Sierra owner's manual.`;
    console.log(`[extract] chunk ${ci + 1}/${chunks.length} (pages ${start + 1}-${end}) -> ${MODEL} ...`);
    const b64 = wholeFits ? pdfBytes.toString("base64") : await chunkToB64(srcDoc, start, end);
    const { out, costData, stopReason } = await extractChunk(client, b64, note);
    if (stopReason === "max_tokens") {
      anyTruncated = true;
      console.warn(`[extract] chunk ${ci + 1}: stop_reason=max_tokens (possible truncation)`);
    }
    if (costData) {
      for (const k of ["input", "cacheWrite", "cacheRead", "output"]) {
        totals.tokens[k] += costData.tokens[k];
        totals.cost[k] += costData.cost[k];
      }
      totals.cost.total += costData.cost.total;
    }
    if (!out) { console.warn(`[extract] chunk ${ci + 1}: no tool_use returned, skipping`); continue; }
    for (const s of out.specs || []) rawSpecs.push(s);
    for (const f of out.component_facts || []) rawFacts.push(f);
    for (const d of out.other_data_types_present || []) discoverySet.add(String(d).trim());
    console.log(`[extract] chunk ${ci + 1}: ${(out.specs || []).length} specs, ${(out.component_facts || []).length} facts`);
  }

  // Dedupe specs repeated across chunk boundaries.
  const seen = new Set();
  const specs = [];
  for (const s of rawSpecs) {
    const key = [
      s.spec_type, s.value_numeric,
      (s.value_unit || "").toLowerCase(), (s.value_text || "").toLowerCase(),
      (s.qualifier || "").toLowerCase(), (s.engine || "").toLowerCase(),
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    specs.push(s);
  }
  const facts = rawFacts;
  const discovery = Array.from(discoverySet);

  console.log(`[extract] merged: ${specs.length} unique specs (${rawSpecs.length} raw), ${facts.length} facts`);

  // --- Validate ----------------------------------------------------------
  const passedSpecs = [];
  const quarantinedSpecs = [];
  for (const s of specs) {
    const v = validateSpec(s);
    (v.ok ? passedSpecs : quarantinedSpecs).push({ ...s, _reason: v.reason });
  }
  const passedFacts = [];
  const quarantinedFacts = [];
  for (const f of facts) {
    const v = validateComponentFact(f);
    (v.ok ? passedFacts : quarantinedFacts).push({ ...f, _reason: v.reason });
  }

  // --- Store (transaction; provenance FK on every row) -------------------
  const db = await pool.connect();
  let sourceId;
  try {
    await db.query("begin");
    const src = await db.query(
      `insert into source (source_type, title, url_or_ref, publisher, retrieved_at, license, trust_tier)
       values ('oem_owner_manual', $1, $2, 'General Motors', now(), $3, 1)
       returning id`,
      [
        "2011 GMC Sierra Owner Manual",
        "server/extraction_test/2011-sierra-owner-manual.pdf",
        "Proprietary (GM) — used for internal extraction PoC",
      ],
    );
    sourceId = src.rows[0].id;

    for (const s of passedSpecs) {
      const variantId = await resolveVariant(db, s.engine);
      await db.query(
        `insert into spec
           (vehicle_variant_id, spec_type, value_numeric, value_unit, value_text, qualifier, confidence, source_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          variantId,
          s.spec_type,
          typeof s.value_numeric === "number" ? s.value_numeric : null,
          s.value_unit ?? null,
          s.value_text ?? null,
          s.qualifier ?? null,
          typeof s.confidence === "number" ? s.confidence : null,
          sourceId,
        ],
      );
    }
    for (const f of passedFacts) {
      const variantId = await resolveVariant(db, f.engine);
      await db.query(
        `insert into component_fact
           (vehicle_variant_id, component, fact_type, value_text, source_id)
         values ($1,$2,$3,$4,$5)`,
        [variantId, f.component, f.fact_type, f.value_text, sourceId],
      );
    }
    await db.query("commit");
  } catch (err) {
    await db.query("rollback");
    console.error("[extract] DB write failed, rolled back:", err.message);
    db.release();
    await pool.end();
    process.exit(1);
  }
  db.release();

  // --- Read back ---------------------------------------------------------
  const back = await pool.query(
    `select s.id, s.spec_type, s.value_numeric, s.value_unit, s.value_text, s.qualifier,
            vv.engine_descriptor, src.title
       from spec s
       join vehicle_variant vv on vv.id = s.vehicle_variant_id
       join source src on src.id = s.source_id
      where s.source_id = $1
      order by s.spec_type, vv.engine_descriptor`,
    [sourceId],
  );
  const backFacts = await pool.query(
    `select count(*)::int as n from component_fact where source_id = $1`,
    [sourceId],
  );

  // ---- REPORT -----------------------------------------------------------
  const line = "=".repeat(72);
  console.log("\n" + line);
  console.log("EXTRACTION RESULT");
  console.log(line);
  console.log(`source_id (provenance): ${sourceId}`);
  console.log(`PDF size: ${(bytes / 1024 / 1024).toFixed(2)} MB, ${pageCount} pages`);
  if (preflightTokens != null) {
    console.log(`Whole-document token size: ${preflightTokens.toLocaleString()} tokens` +
      (preflightTokens > CONTEXT_LIMIT ? `  *** EXCEEDS Opus 4.6's 1M context window — cannot be sent whole ***` : ""));
  }
  console.log(`Chunks processed: ${chunks.length} (<=${MAX_PAGES_PER_CHUNK} pages each)` +
    (anyTruncated ? "  [WARNING: a chunk hit max_tokens — output may be truncated]" : ""));

  console.log("\n--- COST SPLIT (claude-opus-4-6, summed across chunks) ---");
  const t = totals.tokens, c = totals.cost;
  console.log(`  input (document):  ${t.input.toLocaleString().padStart(10)} tok   $${c.input.toFixed(4)}`);
  console.log(`  cache write:       ${t.cacheWrite.toLocaleString().padStart(10)} tok   $${c.cacheWrite.toFixed(4)}`);
  console.log(`  cache read:        ${t.cacheRead.toLocaleString().padStart(10)} tok   $${c.cacheRead.toFixed(4)}`);
  console.log(`  output (extracted):${t.output.toLocaleString().padStart(10)} tok   $${c.output.toFixed(4)}`);
  console.log(`  ----`);
  console.log(`  TOTAL: $${c.total.toFixed(4)}`);

  console.log(`\n--- ACCURACY: STORED SPECS (${back.rowCount}) — verify against answer key ---`);
  for (const r of back.rows) {
    const val = r.value_numeric != null
      ? `${r.value_numeric}${r.value_unit ? " " + r.value_unit : ""}`
      : (r.value_text ?? "");
    const eng = r.engine_descriptor ? ` [${r.engine_descriptor}]` : "";
    const q = r.qualifier ? ` (${r.qualifier})` : "";
    console.log(`  ${r.spec_type.padEnd(28)} ${val}${q}${eng}`);
  }
  console.log(`\n  component_facts stored: ${backFacts.rows[0].n}`);

  if (quarantinedSpecs.length || quarantinedFacts.length) {
    console.log(`\n--- QUARANTINED (not stored): ${quarantinedSpecs.length} specs, ${quarantinedFacts.length} facts ---`);
    for (const s of quarantinedSpecs) {
      console.log(`  [spec] ${s.spec_type}=${s.value_numeric ?? s.value_text ?? "?"} — ${s._reason}`);
    }
    for (const f of quarantinedFacts) {
      console.log(`  [fact] ${f.component}/${f.fact_type} — ${f._reason}`);
    }
  } else {
    console.log("\n--- QUARANTINED: none ---");
  }

  console.log(`\n--- DISCOVERY: other extractable data types present (NOT extracted/stored) ---`);
  if (discovery.length) {
    for (const d of discovery) console.log(`  - ${d}`);
  } else {
    console.log("  (none reported)");
  }
  console.log(line + "\n");

  await pool.end();
}

main().catch((err) => {
  console.error("[extract] error:", err.message);
  process.exit(1);
});
