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
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
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

// ---- Trim-before-extract (the cost lever) ---------------------------------
// The first-slice test proved every spec lives in the maintenance / specs /
// capacities sections (the back half of the Sierra manual); pages 1-300 cost
// ~$3 and produced ZERO specs. So rather than feed the whole manual, we locate
// the spec-bearing pages LOCALLY (pdfjs-dist text extraction — zero API cost),
// score each page against a spec-signal dictionary, expand each hot page by a
// margin, merge into bands, and feed ONLY those pages to Claude. Target:
// ~85-90% cost cut for ~100% of specs.
//
// Escape hatch: EXTRACT_FULL=1 or a `--full` arg forces whole-document
// extraction (for A/B validation of the trimmed run against the full run).
const FORCE_FULL =
  process.env.EXTRACT_FULL === "1" || process.argv.includes("--full");

// Tunables — named, not buried magic numbers; we tune these against the re-run.
// Default threshold deliberately favours OVER-inclusion: on the Sierra manual
// real spec pages are scattered across scores 5-22 (e.g. the Technical Data
// "Capacities" table scores only 5; the oil-spec and brake-fluid pages score 7),
// so a high threshold would silently drop specs. 6 keeps the clustered spec
// pages (isolated score-5 *prose* is dropped; score-5 *spec* pages sit next to
// score>=6 anchors and are rescued by the margin). Raise toward 8 only after the
// answer-key re-run confirms which bands actually produced specs.
const PAGE_SCORE_THRESHOLD = 6; // min keyword score for a page to count as "hot"
const BAND_MARGIN_PAGES = 5;    // pages added on EACH side of every hot page (over-include)
const MIN_SELECTED_PAGES = 20;  // sanity floor: fewer selected than this distrusts the trim

// Spec-signal dictionary — the same vocabulary the extractor targets. A page's
// score is the sum of the weights of the distinct signals it contains (case-
// insensitive substring match). Strong, unambiguous spec markers outweigh
// generic ones so a single specs/maintenance heading clears the threshold while
// an incidental "battery" mention in a prose page does not.
const SPEC_SIGNALS = [
  // strong section headings + unambiguous unit/standard markers
  ["capacities and specifications", 4], ["maintenance schedule", 4],
  ["recommended fluids", 3], ["capacity", 2], ["specification", 2],
  ["lb-ft", 2], ["ft-lb", 2], ["lb ft", 2], ["ft lb", 2], ["n·m", 2],
  ["viscosity", 2], ["dexos", 2], ["dex-cool", 2], ["dexron", 2],
  ["gawr", 2], ["gvwr", 2], ["r-134a", 2], ["spark plug gap", 2],
  // generic spec vocabulary
  ["torque", 1], ["coolant", 1], ["refrigerant", 1], ["lubricant", 1],
  ["fluid", 1], ["sae ", 1], ["quart", 1], ["liter", 1], ["litre", 1],
  ["psi", 1], ["kpa", 1], [" rpm", 1], ["transfer case", 1],
  ["differential", 1], [" axle", 1], ["fuel tank", 1], ["dot 3", 1],
  ["brake fluid", 1], ["tire pressure", 1], ["idle speed", 1],
];

const DEFAULT_PDF = path.join(
  __dirname,
  "..",
  "extraction_test",
  "2011-sierra-owner-manual.pdf.pdf", // actual on-disk name (double extension)
);
const PDF_PATH = process.argv[2]
  ? path.resolve(process.argv[2])
  : DEFAULT_PDF;

// Controlled vocab — must match the spec_type CHECK constraint, now widened by
// 0002_widen_specs_and_audit_columns.sql. Keep these in lock-step with the SQL.
const SPEC_TYPES = [
  "oil_capacity", "oil_viscosity", "oil_type",
  "coolant_capacity", "coolant_type",
  "transmission_fluid_type", "transmission_fluid_capacity",
  "brake_fluid_type", "power_steering_fluid_type",
  "torque", "tire_pressure", "spark_plug_gap",
  "battery_group", "maintenance_interval",
  "refrigerant_type", "refrigerant_capacity",
  // Batch A additions (0002) — plain key/value specs that previously fell into `other`.
  "fuel_capacity",
  "axle_fluid_type", "axle_fluid_capacity",
  "transfer_case_fluid_type", "transfer_case_fluid_capacity",
  "gvwr", "gawr", "idle_speed",
  "other",
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
- Use the spec_type that best matches. Prefer a specific type over "other" whenever one fits — the vocabulary now includes fuel_capacity, axle_fluid_type, axle_fluid_capacity, transfer_case_fluid_type, transfer_case_fluid_capacity, gvwr, gawr, and idle_speed (fast-idle / curb-idle RPM), in addition to the oil/coolant/transmission/brake/torque/tire/spark-plug/battery/maintenance/refrigerant types.
- Only use "other" when NOTHING fits. When you do, value_text is REQUIRED and must be a short descriptive label of WHAT the value is (e.g. "front GAWR", "fast-idle RPM", "wheel-nut starting torque") — never leave it empty. A bare "340 kg" with no subject is useless and will be rejected.
- Numeric specs: provide value_numeric + value_unit. Textual specs (fluid types, viscosities/grades): provide value_text.
- Weights (gvwr, gawr): report value_numeric in whichever unit the document prints (kg or lb) and set value_unit to match — do NOT convert it yourself; the pipeline canonicalizes weights downstream.
- qualifier captures conditions like "with filter", "severe service", "cold", or "front"/"rear" for per-axle ratings.

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
          // When spec_type is "other", value_text is REQUIRED — it carries the
          // descriptive label of what the value is (the value itself lives in
          // value_numeric/value_unit for numeric others). Enforced redundantly
          // in the validation gate and by the spec_other_requires_label CHECK.
          allOf: [
            {
              if: { properties: { spec_type: { const: "other" } } },
              then: { required: ["value_text"] },
            },
          ],
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
// Small driveline-fluid volumes (axle / transfer case) also show up in pints,
// ounces, and millilitres — a superset of CAP_UNITS.
const FLUID_SMALL_UNITS = [...CAP_UNITS, "pt", "pint", "pints", "oz", "ounce", "ounces", "ml", "milliliter", "milliliters"];
const PRESS_UNITS = ["psi", "kpa", "bar"];
const TORQUE_UNITS = ["ft-lb", "ft-lbs", "ftlb", "lb-ft", "lbft", "ft·lb", "nm", "n·m", "n-m"];
const GAP_UNITS = ["in", "inch", "inches", "\"", "mm"];
const INTERVAL_UNITS = ["mi", "mile", "miles", "km", "kilometer", "kilometers", "mo", "month", "months", "yr", "year", "years"];
const WEIGHT_UNITS = ["kg", "kgs", "kilogram", "kilograms", "lb", "lbs", "pound", "pounds"];
const RPM_UNITS = ["rpm", "r/min", "min-1"];

const NUMERIC_TYPES = new Set([
  "oil_capacity", "coolant_capacity", "transmission_fluid_capacity",
  "refrigerant_capacity", "torque", "tire_pressure", "spark_plug_gap",
  "maintenance_interval",
  // Batch A numeric additions.
  "fuel_capacity", "axle_fluid_capacity", "transfer_case_fluid_capacity",
  "gvwr", "gawr", "idle_speed",
]);

// Weights are canonicalized to a single unit so one manual can't store lb while
// another stores kg for the same spec_type. CANONICAL WEIGHT UNIT = kg (SI);
// the display layer converts back to lb if it ever wants to. Conversion happens
// here at normalize time, BEFORE validation (which then checks the kg range).
const WEIGHT_TYPES = new Set(["gvwr", "gawr"]);
const LB_TO_KG = 0.45359237;

function norm(u) {
  return String(u ?? "").trim().toLowerCase();
}

// Mutates and returns the spec with weights canonicalized to kg. No-op for
// non-weight specs. Called immediately before validateSpec.
function normalizeSpec(s) {
  if (WEIGHT_TYPES.has(s.spec_type) && typeof s.value_numeric === "number") {
    const u = norm(s.value_unit);
    if (["lb", "lbs", "pound", "pounds"].includes(u)) {
      s.value_numeric = Math.round(s.value_numeric * LB_TO_KG);
      s.value_unit = "kg";
    } else if (["kg", "kgs", "kilogram", "kilograms"].includes(u)) {
      s.value_unit = "kg";
    }
  }
  return s;
}

// Returns { ok: true } or { ok: false, reason }.
function validateSpec(s) {
  if (!s.verbatim_quote || String(s.verbatim_quote).trim().length < 3) {
    return { ok: false, reason: "no verbatim_quote (hard gate)" };
  }
  // page is a NOT NULL audit column — a missing/invalid page would abort the
  // whole store transaction at INSERT, so quarantine it here instead.
  if (!(typeof s.page === "number" && Number.isFinite(s.page) && s.page >= 1)) {
    return { ok: false, reason: "missing/invalid page (NOT NULL audit column)" };
  }
  if (!SPEC_TYPES.includes(s.spec_type)) {
    return { ok: false, reason: `spec_type "${s.spec_type}" not in controlled vocab` };
  }

  const hasNum = typeof s.value_numeric === "number" && !Number.isNaN(s.value_numeric);
  const hasText = s.value_text && String(s.value_text).trim().length > 0;

  if (!hasNum && !hasText) {
    return { ok: false, reason: "neither value_numeric nor value_text present" };
  }

  // `other` must carry a descriptive label in value_text (mirrors the
  // spec_other_requires_label DB CHECK and the tool-schema conditional).
  if (s.spec_type === "other" && !hasText) {
    return { ok: false, reason: "`other` spec missing required descriptive label (value_text)" };
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
      case "fuel_capacity": {
        if (!CAP_UNITS.includes(u)) { ok = false; why = `unit "${u}" not a capacity unit`; break; }
        if (/l|liter|litre/.test(u)) { if (v < 10 || v > 230) { ok = false; why = `fuel capacity ${v}${u} out of range`; } }
        else if (/gal/.test(u)) { if (v < 3 || v > 60) { ok = false; why = `fuel capacity ${v}${u} out of range`; } }
        else if (v < 10 || v > 250) { ok = false; why = `fuel capacity ${v}${u} out of range`; } // qt
        break;
      }
      case "axle_fluid_capacity":
      case "transfer_case_fluid_capacity": {
        if (!FLUID_SMALL_UNITS.includes(u)) { ok = false; why = `unit "${u}" not a fluid-capacity unit`; break; }
        // small driveline volumes (~fraction of a quart up to a few quarts), wide across units
        if (/oz|ounce/.test(u)) { if (v < 4 || v > 400) { ok = false; why = `fluid ${v}${u} out of range`; } }
        else if (/ml|milli/.test(u)) { if (v < 100 || v > 12000) { ok = false; why = `fluid ${v}${u} out of range`; } }
        else if (/pt|pint/.test(u)) { if (v < 0.4 || v > 12) { ok = false; why = `fluid ${v}${u} out of range`; } }
        else { if (v < 0.2 || v > 12) { ok = false; why = `fluid ${v}${u} out of range`; } } // qt/l/gal
        break;
      }
      case "gvwr": {
        // canonicalized to kg by normalizeSpec before we get here
        if (u !== "kg") { ok = false; why = `gvwr unit "${u}" not canonical kg (normalize failed)`; break; }
        if (v < 1000 || v > 20000) { ok = false; why = `gvwr ${v}kg out of range`; }
        break;
      }
      case "gawr": {
        if (u !== "kg") { ok = false; why = `gawr unit "${u}" not canonical kg (normalize failed)`; break; }
        if (v < 500 || v > 12000) { ok = false; why = `gawr ${v}kg out of range`; }
        break;
      }
      case "idle_speed": {
        if (!RPM_UNITS.includes(u)) { ok = false; why = `unit "${u}" not an rpm unit`; break; }
        if (v < 300 || v > 3000) { ok = false; why = `idle speed ${v}${u} out of range`; }
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
  if (!(typeof f.page === "number" && Number.isFinite(f.page) && f.page >= 1)) {
    return { ok: false, reason: "missing/invalid page (NOT NULL audit column)" };
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

// Build a base64 PDF containing exactly the given 0-indexed pages of srcDoc
// (in the order supplied). Works for both contiguous ranges and the sparse
// page sets the trimmer produces.
async function chunkToB64(srcDoc, idx) {
  const chunk = await PDFDocument.create();
  const copied = await chunk.copyPages(srcDoc, idx);
  for (const p of copied) chunk.addPage(p);
  const bytes = await chunk.save();
  return Buffer.from(bytes).toString("base64");
}

// ---- Trim: locate the spec-bearing pages (local, zero API cost) -----------
// Extracts every page's text with pdfjs-dist, scores it against SPEC_SIGNALS,
// expands each hot page by ±BAND_MARGIN_PAGES, and merges into bands. Returns
// { pages: sorted 0-indexed page list (or null), bands, scoredHot, reason }.
async function selectSpecPages(pdfBytes, pageCount) {
  const data = new Uint8Array(pdfBytes);
  const doc = await getDocument({ data, useSystemFonts: true }).promise;
  const hot = [];
  try {
    for (let i = 0; i < doc.numPages; i++) {
      const page = await doc.getPage(i + 1);
      const tc = await page.getTextContent();
      const text = tc.items.map((t) => t.str).join(" ").toLowerCase();
      let score = 0;
      for (const [needle, w] of SPEC_SIGNALS) {
        if (text.includes(needle)) score += w;
      }
      if (score >= PAGE_SCORE_THRESHOLD) hot.push(i); // 0-indexed
    }
  } finally {
    await doc.destroy();
  }

  if (hot.length === 0) {
    return { pages: null, bands: [], scoredHot: 0, reason: "no hot pages found (image-only PDF?)" };
  }

  // Expand each hot page by the margin, clamp to the document, dedupe via a set.
  const marked = new Set();
  for (const p of hot) {
    for (let d = -BAND_MARGIN_PAGES; d <= BAND_MARGIN_PAGES; d++) {
      const q = p + d;
      if (q >= 0 && q < pageCount) marked.add(q);
    }
  }
  const pages = Array.from(marked).sort((a, b) => a - b);

  // Collapse into contiguous [start, end] bands for human-readable logging.
  const bands = [];
  let bandStart = pages[0];
  let prev = pages[0];
  for (let k = 1; k < pages.length; k++) {
    if (pages[k] === prev + 1) { prev = pages[k]; continue; }
    bands.push([bandStart, prev]);
    bandStart = pages[k];
    prev = pages[k];
  }
  bands.push([bandStart, prev]);

  return { pages, bands, scoredHot: hot.length, reason: null };
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

  // --- Select pages (trim-before-extract) --------------------------------
  const srcDoc = await PDFDocument.load(pdfBytes);
  const pageCount = srcDoc.getPageCount();

  let selectedPages; // sorted array of 0-indexed pages to feed Claude
  let selectionNote;
  if (FORCE_FULL) {
    selectedPages = Array.from({ length: pageCount }, (_, i) => i);
    selectionNote = `--full / EXTRACT_FULL set — feeding all ${pageCount} pages`;
  } else {
    const sel = await selectSpecPages(pdfBytes, pageCount);
    if (sel.pages && sel.pages.length >= MIN_SELECTED_PAGES) {
      selectedPages = sel.pages;
      const bandStr = sel.bands.map(([a, b]) => `${a + 1}-${b + 1}`).join(", ");
      selectionNote =
        `trim: ${sel.scoredHot} hot pages -> ${sel.pages.length}/${pageCount} selected ` +
        `(±${BAND_MARGIN_PAGES}-page margin); bands: ${bandStr}`;
    } else {
      // FAIL-SAFE FLOOR — the trim looks untrustworthy (no hot pages, or fewer
      // than the sanity floor). Fall back to the back half rather than risk a
      // silent spec drop: the first-slice test proved every spec lives there.
      const half = Math.floor(pageCount / 2);
      selectedPages = Array.from({ length: pageCount - half }, (_, i) => half + i);
      const why = sel.pages
        ? `only ${sel.pages.length} selected (< floor ${MIN_SELECTED_PAGES})`
        : sel.reason;
      selectionNote = `FAIL-SAFE FALLBACK to back half (pages ${half + 1}-${pageCount}) — ${why}`;
      console.warn(`[extract] WARNING: ${selectionNote}`);
    }
  }
  console.log(`[extract] page selection — ${selectionNote}`);

  // --- Chunk the selected pages into <=MAX_PAGES_PER_CHUNK groups ---------
  // Each chunk is an array of 0-indexed pages (may span band gaps — fine, the
  // per-item page number Claude reports is what we store as provenance).
  const chunks = [];
  for (let i = 0; i < selectedPages.length; i += MAX_PAGES_PER_CHUNK) {
    chunks.push(selectedPages.slice(i, i + MAX_PAGES_PER_CHUNK));
  }
  console.log(
    `[extract] ${selectedPages.length} selected pages -> ${chunks.length} chunk(s) of <=${MAX_PAGES_PER_CHUNK} pages`,
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
    const idx = chunks[ci];
    const first = idx[0] + 1;
    const last = idx[idx.length - 1] + 1;
    const note =
      `This is a ${idx.length}-page selection (spanning roughly manual pages ` +
      `${first}-${last}) from a ${pageCount}-page 2011 GMC Sierra owner's manual.`;
    console.log(`[extract] chunk ${ci + 1}/${chunks.length} (${idx.length} pages, ~${first}-${last}) -> ${MODEL} ...`);
    const b64 = await chunkToB64(srcDoc, idx);
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
    normalizeSpec(s); // canonicalize weights to kg before validating/storing
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
           (vehicle_variant_id, spec_type, value_numeric, value_unit, value_text, qualifier, confidence, source_id, page, verbatim_quote)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          variantId,
          s.spec_type,
          typeof s.value_numeric === "number" ? s.value_numeric : null,
          s.value_unit ?? null,
          s.value_text ?? null,
          s.qualifier ?? null,
          typeof s.confidence === "number" ? s.confidence : null,
          sourceId,
          Math.round(Number(s.page)),
          String(s.verbatim_quote),
        ],
      );
    }
    for (const f of passedFacts) {
      const variantId = await resolveVariant(db, f.engine);
      await db.query(
        `insert into component_fact
           (vehicle_variant_id, component, fact_type, value_text, source_id, page, verbatim_quote)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [variantId, f.component, f.fact_type, f.value_text, sourceId, Math.round(Number(f.page)), String(f.verbatim_quote)],
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
            s.page, s.verbatim_quote, vv.engine_descriptor, src.title
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
  console.log(`Pages fed to Claude: ${selectedPages.length}/${pageCount}  (${selectionNote})`);
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
    // Show the audit trail (page + a snippet of the verbatim quote) so the
    // re-run visibly confirms the NOT NULL columns populate on every row.
    const quote = String(r.verbatim_quote ?? "").replace(/\s+/g, " ").slice(0, 50);
    console.log(`  ${r.spec_type.padEnd(28)} ${val}${q}${eng}  · p.${r.page} "${quote}${quote.length >= 50 ? "…" : ""}"`);
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
