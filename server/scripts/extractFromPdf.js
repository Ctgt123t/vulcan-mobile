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
import { fileURLToPath, pathToFileURL } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { pool } from "../db.js";
import { logApiCost } from "../costLogger.js";
import {
  PAGE_SCORE_THRESHOLD,
  BAND_MARGIN_PAGES,
  MIN_SELECTED_PAGES,
  scorePageText,
} from "./trimScan.js";
import { canonicalizeMake, normalizeModel } from "../canonicalVehicle.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODEL = "claude-opus-4-6";

// This manual is 594 pages / ~1.185M tokens — it EXCEEDS Opus 4.6's 1M context
// window, so it cannot be sent whole. We split into page-range chunks that each
// fit (~150 pages ≈ ~300K tokens), extract per chunk, then merge. Summed chunk
// cost approximates the cost of processing the whole document.
const MAX_PAGES_PER_CHUNK = 150;
const CONTEXT_LIMIT = 1_000_000;

// #7b — request-size guard. The Anthropic request limit is ~32MB, and the
// base64 PDF document is the bulk of it. pdf-lib's copyPages materializes the
// document-wide SHARED resource pool (fonts/images inherited via the page tree)
// into EVERY chunk, so a chunk's size barely scales with its page count — a
// 5-page slice of the 33MB Honda manual is ~31.6MB raw (~42MB base64) just like
// a 150-page slice, and it tripped the 32MB rejection. Almost all of that bloat
// is embedded photos/diagrams (Honda: 14.6MB of image XObjects), which are NOT
// spec data: the verbatim-quote gate only stores values quotable from the text,
// spec tables are vector text (not scanned images), and Anthropic rasterizes
// the page for vision from the remaining vector content regardless. So when a
// chunk would exceed the soft limit we neutralize its image XObjects (the
// indirect objects stay valid — no dangling /Do refs — their bytes just
// collapse), which brings a Honda chunk to ~17MB raw / ~22.7MB base64. The
// strip is CONDITIONAL: normal manuals stay byte-for-byte untouched (full
// fidelity); only an oversized image-heavy chunk gets stripped.
const CHUNK_B64_SOFT_LIMIT = 30 * 1024 * 1024; // leave headroom under the ~32MB request cap

// ---- Trim-before-extract (the cost lever) ---------------------------------
// The first-slice test proved every spec lives in the maintenance / specs /
// capacities sections; the front of an owner's manual (operating/infotainment)
// costs input tokens and produces ZERO specs. So rather than feed the whole
// manual, we locate the spec-bearing pages LOCALLY (pdfjs-dist text extraction
// — zero API cost), score each page against the spec-signal scoring, expand
// each hot page by a margin, merge into bands, and feed ONLY those pages.
//
// The scoring itself lives in the shared, manufacturer-agnostic ./trimScan.js
// (also used by the zero-cost scripts/trimPreflight.js, so the two can never
// drift). #7a FIX: the scoring used to be fitted to GM vocabulary and silently
// under-selected on non-GM manuals; trimScan.js now drives off generic spec
// vocabulary + structural measurement patterns. See that file's header.
//
// Escape hatch: EXTRACT_FULL=1 or a `--full` arg forces whole-document
// extraction (for A/B validation of the trimmed run against the full run).
const FORCE_FULL =
  process.env.EXTRACT_FULL === "1" || process.argv.includes("--full");

const DEFAULT_PDF = path.join(
  __dirname,
  "..",
  "extraction_test",
  "2011-sierra-owner-manual.pdf.pdf", // actual on-disk name (double extension)
);
// First NON-flag CLI arg is the PDF path (so `--full` is not mistaken for it).
const argPdf = process.argv.slice(2).find((a) => !a.startsWith("--"));
const PDF_PATH = argPdf ? path.resolve(argPdf) : DEFAULT_PDF;

// ---- Vehicle identity + source metadata (parameterized) -------------------
// The vehicle a manual is for, and its provenance, are per-run inputs — NOT the
// extraction logic. Pass via --key=value flags; defaults reproduce the original
// 2011 Sierra PoC run so `npm run extract:pdf` (no args) is unchanged. The
// identity here is what every spec/component_fact gets filed under, so a wrong
// value would mis-file a whole vehicle — the verifyIdentity() guard below
// cross-checks it against the PDF's own title page before any rows are written.
function argVal(name, fallback) {
  const pref = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(pref));
  return hit ? hit.slice(pref.length) : fallback;
}
// §5.B — store rows under the CANONICAL NHTSA make/model spelling, not the
// operator's free-text (or the manual's title-page) spelling, so a later lookup
// joins. Canonicalization is fail-safe (an unaliased name passes through). The
// in-code alias seed is available synchronously here (no DB needed for the
// known aliases); DB-added aliases would only matter to the lookup side.
const VEHICLE = {
  year: Number(argVal("year", 2011)),
  make: canonicalizeMake(argVal("make", "GMC")),
  model: normalizeModel(argVal("model", "Sierra")),
};
const VEHICLE_LABEL = `${VEHICLE.year} ${VEHICLE.make} ${VEHICLE.model}`;
const SOURCE_META = {
  title: argVal("title", `${VEHICLE_LABEL} Owner Manual`),
  publisher: argVal("publisher", "General Motors"),
  url: argVal("url", "server/extraction_test/2011-sierra-owner-manual.pdf"),
};

// Controlled vocab — must match the spec_type CHECK constraint, widened by
// 0002_widen_specs_and_audit_columns.sql + 0003_batch_c_spec_types.sql. Keep
// these in lock-step with the SQL.
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
  // Batch C additions (0003) — richer manual data that previously fell into `other`.
  "towing_capacity", "fuel_octane", "compression_ratio",
  "displacement", "def_type", "def_capacity",
  // Batch D additions (0005) — numeric `other`-bucket families (also re-keyed in place).
  "gcwr", "dimension", "ac_compressor_oil_capacity",
  "washer_fluid_capacity", "trailer_tongue_weight",
  // Batch E additions (0006) — remaining numeric `other`-bucket families (also re-keyed in place).
  "cargo_load_limit", "vehicle_capacity_weight",
  "oil_low_to_full", "low_fuel_warning_level",
  // Phase 2 additions (0007) — parsed textual families that land in spec (value in value_text).
  "firing_order", "fuel_type", "adjustment_spec",
  "other",
];

const SYSTEM_PROMPT = `You are a precise automotive data-extraction engine. You are given the official owner's manual PDF for a ${VEHICLE_LABEL}.

Extract factory specifications and component facts that are EXPLICITLY STATED in this document.

ABSOLUTE RULE — extract only what the document says:
- For every item you MUST copy a verbatim_quote exactly from the page where it appears, plus the page number.
- If a value is not stated in the document, OMIT it. Never supply a value from your own knowledge or training. Do not infer, calculate, average, or fill gaps.
- A spec you cannot quote verbatim from the document does not exist for this task.

Engine association:
- Many specs differ by engine (e.g. oil capacity). When the document ties a value to a specific engine, put that engine string (as written, e.g. "5.3L V8") in the engine field.
- Leave engine empty only for values that apply to the whole vehicle.

Spec typing:
- Use the spec_type that best matches. Prefer a specific type over "other" whenever one fits — the vocabulary includes fuel_capacity, axle_fluid_type, axle_fluid_capacity, transfer_case_fluid_type, transfer_case_fluid_capacity, gvwr, gawr, idle_speed (fast-idle / curb-idle RPM), towing_capacity (max trailer / towing weight rating), fuel_octane (required fuel grade / octane), compression_ratio, displacement (engine displacement), def_type and def_capacity (diesel exhaust fluid / AdBlue), gcwr (gross combined weight rating), dimension (a vehicle dimension — wheelbase, overall length/width/height, track, tread, or ground clearance; put WHICH dimension in value_text), ac_compressor_oil_capacity (A/C compressor / refrigerant oil amount), washer_fluid_capacity (windshield-washer reservoir), trailer_tongue_weight (max trailer tongue / nose weight), cargo_load_limit (a roof-rack / cargo / tie-down / bed load-weight limit; put WHICH point in value_text), vehicle_capacity_weight (door-sticker payload / vehicle capacity weight), oil_low_to_full (engine-oil add quantity from the dipstick low mark to full), low_fuel_warning_level (fuel remaining when the low-fuel light comes on), firing_order (cylinder firing sequence, e.g. "1-3-4-2" — put the sequence in value_text), fuel_type (fuel requirement, e.g. "Unleaded gasoline only" — value_text), adjustment_spec (a pedal/clutch free-play or clearance measurement — the measurement in value_text, WHICH adjustment in qualifier), in addition to the oil/coolant/transmission/brake/torque/tire/spark-plug/battery/maintenance/refrigerant types.
- Only use "other" when NOTHING fits. When you do, value_text is REQUIRED and must be a short descriptive label of WHAT the value is (e.g. "front GAWR", "fast-idle RPM", "wheel-nut starting torque") — never leave it empty. A bare "340 kg" with no subject is useless and will be rejected.
- Numeric specs (capacities, weights, towing, displacement, def_capacity, gcwr, dimension, trailer_tongue_weight, washer_fluid_capacity, ac_compressor_oil_capacity, cargo_load_limit, vehicle_capacity_weight, oil_low_to_full, low_fuel_warning_level): provide value_numeric + value_unit. Textual specs (fluid types, viscosities/grades, fuel_octane, compression_ratio like "10.5:1", def_type): provide value_text.
- Weights (gvwr, gawr, gcwr): report value_numeric in whichever unit the document prints (kg or lb) and set value_unit to match — do NOT convert it yourself; the pipeline canonicalizes weights downstream. towing_capacity, trailer_tongue_weight, cargo_load_limit, and vehicle_capacity_weight: same — report the printed unit (lb or kg), do not convert.
- qualifier captures conditions like "with filter", "severe service", "cold", or "front"/"rear" for per-axle ratings, or the engine/configuration a towing rating applies to.

Component facts — fuses and bulbs (put these in component_facts, NOT specs):
- FUSE assignment tables (a fuse number/identifier mapped to its amperage and/or the circuit it protects): emit one component_fact per fact, with component set to the fuse identifier as printed (e.g. "fuse F12" / "fuse #27"), fact_type "amperage" or "circuit", and value_text the printed value (e.g. "15 A", "Headlamps"). Only the TEXT/TABLE form — do NOT try to read a fuse-box layout DIAGRAM.
- BULB tables (a lamp location mapped to its bulb type / number / wattage): emit one component_fact per location, component the location as printed (e.g. "low beam headlight", "rear turn signal"), fact_type "bulb_type", value_text the printed bulb spec (e.g. "H11", "9005", "55 W"). If the manual only says "LED — see dealer" with no bulb number, OMIT it (nothing to quote).
- The verbatim_quote + page rule applies to fuses and bulbs exactly as to specs: no quotable text in the document → do not emit it.

Also populate other_data_types_present with the CATEGORIES of other extractable data you observed in this manual but did NOT extract (e.g. warning-light meanings, fuse-box layout diagrams) — names only, for planning. Do not extract those.`;

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
const TORQUE_UNITS = ["ft-lb", "ft-lbs", "ftlb", "lb-ft", "lbft", "ft·lb", "nm", "n·m", "n-m", "lbf-ft", "ft-lbf"];
const GAP_UNITS = ["in", "inch", "inches", "\"", "mm"];
const INTERVAL_UNITS = ["mi", "mile", "miles", "km", "kilometer", "kilometers", "mo", "month", "months", "yr", "year", "years"];
const WEIGHT_UNITS = ["kg", "kgs", "kilogram", "kilograms", "lb", "lbs", "pound", "pounds"];
const RPM_UNITS = ["rpm", "r/min", "min-1"];
// Engine displacement (Batch C). After normUnitForMatch, "cu. in." -> "cu-in",
// "cm³"/"cm3" stay, "L"/liter stay. Owner manuals print displacement mostly as
// "L" (e.g. 3.5L); cc / cu-in are included for completeness.
const DISPLACEMENT_UNITS = ["l", "liter", "liters", "litre", "litres", "cc", "ccm", "cm3", "cm³", "cu-in", "cuin", "ci", "cid", "cubic-inch", "cubic-inches"];
// Batch D — vehicle dimension length units (wheelbase/length/width/height/tread/track/clearance).
// (After normUnitForMatch: "in", "mm", "cm", "m", or the inch glyph ".)
const LENGTH_UNITS = ["in", "inch", "inches", "\"", "mm", "cm", "m"];

const NUMERIC_TYPES = new Set([
  "oil_capacity", "coolant_capacity", "transmission_fluid_capacity",
  "refrigerant_capacity", "torque", "tire_pressure", "spark_plug_gap",
  "maintenance_interval",
  // Batch A numeric additions.
  "fuel_capacity", "axle_fluid_capacity", "transfer_case_fluid_capacity",
  "gvwr", "gawr", "idle_speed",
  // Batch C numeric additions (towing weight, engine displacement, DEF tank).
  "towing_capacity", "displacement", "def_capacity",
  // Batch D numeric additions (gcwr, dimensions, A/C compressor oil, washer fluid, tongue weight).
  "gcwr", "dimension", "ac_compressor_oil_capacity",
  "washer_fluid_capacity", "trailer_tongue_weight",
  // Batch E numeric additions (cargo/accessory load, payload, oil low-to-full, low-fuel warning).
  "cargo_load_limit", "vehicle_capacity_weight",
  "oil_low_to_full", "low_fuel_warning_level",
]);

// Weights are canonicalized to a single unit so one manual can't store lb while
// another stores kg for the same spec_type. CANONICAL WEIGHT UNIT = kg (SI);
// the display layer converts back to lb if it ever wants to. Conversion happens
// here at normalize time, BEFORE validation (which then checks the kg range).
// gcwr joins gvwr/gawr as a canonicalized-to-kg weight. trailer_tongue_weight is deliberately
// NOT here — like towing_capacity it keeps the printed unit (lb or kg) and validates per-unit.
const WEIGHT_TYPES = new Set(["gvwr", "gawr", "gcwr"]);
const LB_TO_KG = 0.45359237;

function norm(u) {
  return String(u ?? "").trim().toLowerCase();
}

// Unit-spelling normalizer for validation MATCHING only — the stored
// value_unit keeps the manual's exact spelling (display fidelity). Handles
// the cross-manufacturer spelling variation of deferred item #9: GM prints
// "qt", Subaru "US qt" / "Imp qt" / "lbf·ft", Ford "lb.ft". Strips a
// US/Imperial prefix and canonicalizes ·/./space separators to "-" so the
// unit whitelists match on the unit itself, not the typography. Found live:
// the 2023 Impreza run quarantined ALL ten capacity/torque specs (correct
// values, perfect quotes) purely on "US qt"/"US gal"/"lbf·ft" spellings.
function normUnitForMatch(u) {
  let s = norm(u);
  s = s.replace(/^u\.?s\.?\s+/, "").replace(/^imp(erial)?\.?\s+/, "");
  s = s.replace(/[·.\s]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return s;
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
    const u = normUnitForMatch(s.value_unit);
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
        // #16 FIX — test /gal/ BEFORE the litre regex. "gal" contains the
        // letter "l", so /l|liter|litre/ matched gallon values and forced them
        // into the litre range (10-230), making the dedicated gallon branch
        // unreachable — a sub-10-gallon tank (kei/sport) would be wrongly
        // quarantined. Gallon now resolves first to its own 3-60 range.
        if (/gal/.test(u)) { if (v < 3 || v > 60) { ok = false; why = `fuel capacity ${v}${u} out of range`; } }
        else if (/l|liter|litre/.test(u)) { if (v < 10 || v > 230) { ok = false; why = `fuel capacity ${v}${u} out of range`; } }
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
      // ---- Batch C numeric types ----
      case "towing_capacity": {
        // A weight; NOT canonicalized (left in the printed unit, per the prompt).
        if (!WEIGHT_UNITS.includes(u)) { ok = false; why = `unit "${u}" not a weight unit`; break; }
        if (/kg|kilogram/.test(u)) { if (v < 100 || v > 18000) { ok = false; why = `towing ${v}${u} out of range`; } }
        else { if (v < 200 || v > 40000) { ok = false; why = `towing ${v}${u} out of range`; } } // lb
        break;
      }
      case "displacement": {
        if (!DISPLACEMENT_UNITS.includes(u)) { ok = false; why = `unit "${u}" not a displacement unit`; break; }
        if (/^(l|liter|liters|litre|litres)$/.test(u)) { if (v < 0.5 || v > 10) { ok = false; why = `displacement ${v}${u} out of range`; } }
        else if (/cu|cid|cubic|^ci$/.test(u)) { if (v < 30 || v > 700) { ok = false; why = `displacement ${v}${u} out of range`; } } // cubic inches
        else { if (v < 500 || v > 10000) { ok = false; why = `displacement ${v}${u} out of range`; } } // cc / cm3
        break;
      }
      case "def_capacity": {
        // Diesel exhaust fluid tank — small. gal/L (qt fallback).
        if (!CAP_UNITS.includes(u)) { ok = false; why = `unit "${u}" not a capacity unit`; break; }
        if (/gal/.test(u)) { if (v < 1 || v > 30) { ok = false; why = `DEF capacity ${v}${u} out of range`; } }
        else if (/l|liter|litre/.test(u)) { if (v < 3 || v > 120) { ok = false; why = `DEF capacity ${v}${u} out of range`; } }
        else { if (v < 1 || v > 130) { ok = false; why = `DEF capacity ${v}${u} out of range`; } } // qt
        break;
      }
      // ---- Batch D numeric types ----
      case "gcwr": {
        // gross combined weight rating; canonicalized to kg by normalizeSpec (WEIGHT_TYPES).
        // Spans light cars to HD dually-with-trailer, so the kg band is wide.
        if (u !== "kg") { ok = false; why = `gcwr unit "${u}" not canonical kg (normalize failed)`; break; }
        if (v < 1500 || v > 40000) { ok = false; why = `gcwr ${v}kg out of range`; }
        break;
      }
      case "trailer_tongue_weight": {
        // a weight; NOT canonicalized (kept in the printed unit, like towing_capacity).
        if (!WEIGHT_UNITS.includes(u)) { ok = false; why = `unit "${u}" not a weight unit`; break; }
        if (/kg|kilogram/.test(u)) { if (v < 10 || v > 4000) { ok = false; why = `tongue weight ${v}${u} out of range`; } }
        else { if (v < 20 || v > 9000) { ok = false; why = `tongue weight ${v}${u} out of range`; } } // lb
        break;
      }
      case "dimension": {
        // length family (wheelbase / overall L·W·H / tread / track / ground clearance) — one
        // type, the measurement+config carried in value_text. Lenient: spans clearance (~5 in)
        // to overall length (~270 in); the gate only rejects clearly-wrong magnitudes/units.
        if (!LENGTH_UNITS.includes(u)) { ok = false; why = `unit "${u}" not a length unit`; break; }
        if (u === "mm") { if (v < 20 || v > 12000) { ok = false; why = `dimension ${v}mm out of range`; } }
        else if (u === "cm") { if (v < 2 || v > 1200) { ok = false; why = `dimension ${v}cm out of range`; } }
        else if (u === "m") { if (v < 0.1 || v > 12) { ok = false; why = `dimension ${v}m out of range`; } }
        else { if (v < 0.5 || v > 480) { ok = false; why = `dimension ${v}${u} out of range`; } } // in / "
        break;
      }
      case "ac_compressor_oil_capacity": {
        // small A/C compressor-oil volume: fl oz / oz / ml / cc.
        if (!/(oz|ml|cc|cm3)/.test(u)) { ok = false; why = `unit "${u}" not an oil-volume unit`; break; }
        if (/ml|cc|cm3/.test(u)) { if (v < 10 || v > 800) { ok = false; why = `compressor oil ${v}${u} out of range`; } }
        else { if (v < 0.3 || v > 40) { ok = false; why = `compressor oil ${v}${u} out of range`; } } // oz / fl-oz
        break;
      }
      case "washer_fluid_capacity": {
        if (!CAP_UNITS.includes(u)) { ok = false; why = `unit "${u}" not a capacity unit`; break; }
        if (/gal/.test(u)) { if (v < 0.3 || v > 8) { ok = false; why = `washer capacity ${v}${u} out of range`; } }
        else if (/l|liter|litre/.test(u)) { if (v < 1 || v > 15) { ok = false; why = `washer capacity ${v}${u} out of range`; } }
        else { if (v < 1 || v > 16) { ok = false; why = `washer capacity ${v}${u} out of range`; } } // qt
        break;
      }
      // ---- Batch E numeric types ----
      case "cargo_load_limit": {
        // cargo / roof-rack / tie-down load weight; printed unit (NOT kg-canonicalized).
        if (!WEIGHT_UNITS.includes(u)) { ok = false; why = `unit "${u}" not a weight unit`; break; }
        if (/kg|kilogram/.test(u)) { if (v < 5 || v > 5000) { ok = false; why = `cargo load ${v}${u} out of range`; } }
        else { if (v < 10 || v > 10000) { ok = false; why = `cargo load ${v}${u} out of range`; } } // lb
        break;
      }
      case "vehicle_capacity_weight": {
        // door-sticker payload; printed unit (NOT kg-canonicalized).
        if (!WEIGHT_UNITS.includes(u)) { ok = false; why = `unit "${u}" not a weight unit`; break; }
        if (/kg|kilogram/.test(u)) { if (v < 50 || v > 5000) { ok = false; why = `payload ${v}${u} out of range`; } }
        else { if (v < 100 || v > 10000) { ok = false; why = `payload ${v}${u} out of range`; } } // lb
        break;
      }
      case "oil_low_to_full": {
        // dipstick low->full add quantity — small volume (qt / L).
        if (!CAP_UNITS.includes(u)) { ok = false; why = `unit "${u}" not a capacity unit`; break; }
        if (v < 0.3 || v > 4) { ok = false; why = `oil low-to-full ${v}${u} out of range`; }
        break;
      }
      case "low_fuel_warning_level": {
        // fuel remaining when the low-fuel light triggers — fuel volume (gal / L).
        if (!CAP_UNITS.includes(u)) { ok = false; why = `unit "${u}" not a capacity unit`; break; }
        if (/gal/.test(u)) { if (v < 0.3 || v > 12) { ok = false; why = `low-fuel level ${v}${u} out of range`; } }
        else if (/l|liter|litre/.test(u)) { if (v < 1 || v > 45) { ok = false; why = `low-fuel level ${v}${u} out of range`; } }
        else { if (v < 0.3 || v > 45) { ok = false; why = `low-fuel level ${v}${u} out of range`; } } // qt
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
    [VEHICLE.year, VEHICLE.make, VEHICLE.model, String(engine ?? "").trim()],
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

// Neutralize every image XObject in a built chunk: replace the raw image
// stream with a single byte (the indirect object + all /XObject and /Do
// references stay valid — only the bytes collapse). Returns how many were
// stripped. Used by chunkToB64 only when a chunk would exceed the request cap.
function stripImageStreams(chunkDoc) {
  let stripped = 0;
  for (const [, obj] of chunkDoc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream) {
      const sub = obj.dict.get(PDFName.of("Subtype"));
      if (sub && sub.toString() === "/Image") {
        obj.contents = new Uint8Array([0]);
        obj.dict.set(PDFName.of("Length"), chunkDoc.context.obj(1));
        stripped++;
      }
    }
  }
  return stripped;
}

// Build a base64 PDF containing exactly the given 0-indexed pages of srcDoc
// (in the order supplied). Works for both contiguous ranges and the sparse
// page sets the trimmer produces. #7b: if the result would exceed the request
// size cap, strip embedded images and rebuild so the chunk fits (see
// CHUNK_B64_SOFT_LIMIT). Returns { b64, rawBytes, strippedImages }.
async function chunkToB64(srcDoc, idx) {
  const build = async (strip) => {
    const chunk = await PDFDocument.create();
    const copied = await chunk.copyPages(srcDoc, idx);
    for (const p of copied) chunk.addPage(p);
    const strippedImages = strip ? stripImageStreams(chunk) : 0;
    const bytes = await chunk.save();
    return { bytes, strippedImages };
  };

  let { bytes, strippedImages } = await build(false);
  // base64 inflates by ~4/3; compare against the request cap before encoding.
  if (Math.ceil(bytes.length / 3) * 4 > CHUNK_B64_SOFT_LIMIT) {
    ({ bytes, strippedImages } = await build(true));
  }
  return {
    b64: Buffer.from(bytes).toString("base64"),
    rawBytes: bytes.length,
    strippedImages,
  };
}

// ---- Identity guard (local, zero API cost) --------------------------------
// Cross-checks the PDF's front-matter text against the declared vehicle so a
// wrong --make/--model/--year (or wrong PDF) can't silently mis-file specs.
// The model name is the strong discriminator (F-150 vs CR-V vs Sierra); we
// require it to appear plus at least one corroborating signal (make or year).
// Tolerant matching: case-insensitive, and the model is compared with all
// non-alphanumerics stripped (so "F-150"/"F‑150"/"F 150" and "CR-V"/"CRV" match).
async function verifyIdentity(pdfBytes, vehicle) {
  const data = new Uint8Array(pdfBytes);
  const doc = await getDocument({ data, useSystemFonts: true }).promise;
  const pagesToScan = Math.min(15, doc.numPages);
  let text = "";
  try {
    for (let i = 1; i <= pagesToScan; i++) {
      const tc = await (await doc.getPage(i)).getTextContent();
      text += " " + tc.items.map((t) => t.str).join(" ");
    }
  } finally {
    await doc.destroy();
  }
  const lower = text.toLowerCase();
  const squashed = lower.replace(/[^a-z0-9]/g, "");
  const modelKey = String(vehicle.model ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const found = {
    model: modelKey.length > 0 && squashed.includes(modelKey),
    make: lower.includes(String(vehicle.make ?? "").toLowerCase()),
    year: lower.includes(String(vehicle.year ?? "")),
  };
  // Model is mandatory; require >=1 corroborating signal so a coincidental
  // model substring alone can't pass.
  const ok = found.model && (found.make || found.year);
  return { ok, found, pagesScanned: pagesToScan };
}

// ---- Identity vision fallback (#17 — small paid call, only on text-fail) ---
// When the local text scan can't find the model/year (e.g. the cover is an
// image with no extractable text — common on manufacturer portal PDFs), send
// just the first few pages to Claude as a vision pass to READ the cover/title
// and compare it against the declared vehicle. This keeps identity confirmation
// AUTOMATIC for the common "no text but has a cover" case, so the operator only
// needs --identity-override for genuinely cover-less files (e.g. the Subaru
// STIS PDF, which has no cover at all — a vision pass finds nothing).
//
// FAIL-SAFE: returns { confirmed:false, ... } on any error or non-confirmation,
// so identity NEVER passes silently — the caller falls through to the abort.
// Cost: one PDF-vision call over <=3 cover pages (a few thousand input tokens),
// ~a couple of cents on opus-4-6; fires only when the text scan already failed
// AND no override was supplied (the override short-circuits before this call).
const IDENTITY_VISION_TOOL = {
  name: "report_cover_identity",
  description:
    "Report what the document's cover/title page(s) identify the vehicle as, and whether that matches the declared vehicle.",
  input_schema: {
    type: "object",
    properties: {
      confirmed: {
        type: "boolean",
        description: "True ONLY if the cover/title page text clearly identifies the SAME year/make/model (or an unambiguous match) as the declared vehicle. If the pages are blank, generic, or name a different vehicle, this is false.",
      },
      cover_title: {
        type: "string",
        description: "The vehicle title/heading you actually read on the cover, verbatim (empty if none is legible).",
      },
      reasoning: {
        type: "string",
        description: "One sentence on why it matches or not.",
      },
    },
    required: ["confirmed", "cover_title", "reasoning"],
  },
};

async function verifyIdentityVision(pdfBytes, vehicle, client) {
  const doc = await PDFDocument.load(pdfBytes);
  const n = Math.min(3, doc.getPageCount());
  const idx = Array.from({ length: n }, (_, i) => i);
  const { b64 } = await chunkToB64(doc, idx);
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 1024,
    system:
      "You verify a document's identity from its cover/title pages ONLY. Read the visible cover text. " +
      "Do not guess from content you cannot see. Confirm a match ONLY when the cover clearly names the same vehicle.",
    tools: [IDENTITY_VISION_TOOL],
    tool_choice: { type: "tool", name: "report_cover_identity" },
    messages: [
      {
        role: "user",
        content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } },
          {
            type: "text",
            text:
              `These are the first ${n} page(s) of a PDF. Do the cover/title page(s) identify this as the ` +
              `${vehicle.year} ${vehicle.make} ${vehicle.model}? Call report_cover_identity exactly once.`,
          },
        ],
      },
    ],
  });
  const final = await stream.finalMessage();
  logApiCost(final.usage, MODEL, { callType: "identity-vision" });
  const block = final.content.find((b) => b.type === "tool_use");
  return block
    ? block.input
    : { confirmed: false, cover_title: "", reasoning: "no tool output" };
}

// ---- Trim: locate the spec-bearing pages (local, zero API cost) -----------
// Extracts every page's text with pdfjs-dist, scores it via the shared
// manufacturer-agnostic scorePageText (./trimScan.js), expands each hot page by
// ±BAND_MARGIN_PAGES, and merges into bands. Returns
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
      if (scorePageText(text) >= PAGE_SCORE_THRESHOLD) hot.push(i); // 0-indexed
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
  // Hard cap only for the pathological case. Chunked extraction sends small
  // page-ranges, so a large manual is fine — only the whole-PDF token pre-flight
  // below is size-constrained, and it is skipped (not fatal) when too large.
  if (bytes > 100 * 1024 * 1024) {
    console.error("[extract] PDF exceeds 100MB — too large to process here; use the Files API.");
    process.exit(1);
  }

  const pdfBytes = fs.readFileSync(PDF_PATH);
  const client = new Anthropic();

  // Identity guard — confirm the PDF actually IS the declared vehicle BEFORE any
  // extraction spend or DB write. A wrong --make/--model/--year (or the wrong PDF
  // path) would otherwise file one vehicle's specs under another's identity — the
  // same corruption class as the old hardcoding, from operator error.
  const idCheck = await verifyIdentity(pdfBytes, VEHICLE);
  console.log(
    `[extract] identity check vs "${VEHICLE_LABEL}" (scanned ${idCheck.pagesScanned} pp): ` +
      `model=${idCheck.found.model} make=${idCheck.found.make} year=${idCheck.found.year}`,
  );
  // Some manufacturers' manuals carry NO model/year in extractable text at
  // all (found on the 2023 Subaru Impreza STIS PDF: the model name exists
  // only in the catalog/filename — the foreword says "your SUBARU vehicle"
  // and the file has no text cover, so neither text scan nor a vision pass
  // can confirm it). For those, identity rests on PROVENANCE (the
  // manufacturer's own portal serving the file under the declared vehicle).
  // --identity-override="<justification>" lets the operator assert that
  // provenance-based identity explicitly: the failed check + justification
  // are logged loudly and persisted in the run snapshot for audit. Without
  // the flag, the abort below stands unchanged.
  const identityOverride = argVal("identity-override", "");
  let identityVision = null; // #17 — vision-pass result, persisted in the snapshot
  if (!idCheck.ok && identityOverride) {
    console.warn(
      `[extract] IDENTITY OVERRIDE accepted for "${VEHICLE_LABEL}" — text check failed ` +
        `(model=${idCheck.found.model}, make=${idCheck.found.make}, year=${idCheck.found.year}) ` +
        `but the operator asserts provenance-based identity: ${identityOverride}`,
    );
  } else if (!idCheck.ok) {
    // #17 — text scan failed and no override. Try a VISUAL cover-page check
    // before aborting: many manuals name the model/year only on a cover image
    // (no extractable text), so a vision pass keeps confirmation automatic for
    // the common no-text-but-has-cover case. Fail-safe: any error or a
    // non-confirmation falls through to the abort — identity never passes
    // silently. (The override above short-circuits this, so a known cover-less
    // file like the Subaru STIS PDF spends nothing on a vision pass that would
    // find nothing.)
    console.log(
      `[extract] text identity check failed for "${VEHICLE_LABEL}" — attempting visual cover-page check (vision pass) ...`,
    );
    try {
      identityVision = await verifyIdentityVision(pdfBytes, VEHICLE, client);
    } catch (err) {
      identityVision = { confirmed: false, cover_title: "", reasoning: `vision pass error: ${err.message}` };
      console.warn(`[extract] identity vision pass failed (continuing to abort): ${err.message}`);
    }
    if (identityVision.confirmed) {
      console.warn(
        `[extract] IDENTITY CONFIRMED BY VISION for "${VEHICLE_LABEL}" — cover read: ` +
          `"${identityVision.cover_title}" (${identityVision.reasoning})`,
      );
    } else {
      console.error(
        `[extract] ABORT: the PDF's front matter does not match the declared vehicle "${VEHICLE_LABEL}" ` +
          `(text: model=${idCheck.found.model}, make=${idCheck.found.make}, year=${idCheck.found.year}; ` +
          `vision: ${identityVision.reasoning}). ` +
          `Refusing to file these specs under a possibly-wrong identity — check --make/--model/--year and the PDF path. ` +
          `If the document's identity is provenance-based (manufacturer portal serves it under this vehicle but the ` +
          `text/cover never names it), re-run with --identity-override="<justification>".`,
      );
      process.exit(1);
    }
  }

  // --- Pre-flight: token count of the WHOLE document (headline finding) --
  // This sends the whole PDF, so skip it when the base64 would overflow the
  // ~32MB request limit (raw > ~22MB). It is purely informational; extraction
  // itself only sends trimmed page-chunks, which stay well under the limit.
  let preflightTokens = null;
  const PREFLIGHT_MAX_BYTES = 22 * 1024 * 1024;
  if (bytes > PREFLIGHT_MAX_BYTES) {
    console.log(
      `[extract] whole-document token pre-flight skipped (PDF ${(bytes / 1024 / 1024).toFixed(1)}MB exceeds the ` +
        `${PREFLIGHT_MAX_BYTES / 1024 / 1024}MB whole-send cap; trimmed chunks are counted/sent individually)`,
    );
  } else {
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
      `${first}-${last}) from a ${pageCount}-page ${VEHICLE_LABEL} owner's manual.`;
    console.log(`[extract] chunk ${ci + 1}/${chunks.length} (${idx.length} pages, ~${first}-${last}) -> ${MODEL} ...`);
    const { b64, rawBytes, strippedImages } = await chunkToB64(srcDoc, idx);
    if (strippedImages > 0) {
      console.log(
        `[extract] chunk ${ci + 1}: oversized — stripped ${strippedImages} embedded image(s) to fit the ` +
          `request limit (now ${(rawBytes / 1024 / 1024).toFixed(1)}MB raw; spec tables are text, unaffected)`,
      );
    }
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
    // #6 PAGE FIX — trust Claude's ABSOLUTE page numbers; no remap. The prompt
    // instructs Claude to report absolute manual page numbers, so the previous
    // post-processing remap (which assumed chunk-relative numbering and
    // re-translated via idx[p-1]) double-counted and produced wrong stored
    // pages on Ford/Sierra rows. The value + verbatim_quote were always
    // correct; this was a citation-precision bug only. We now store the page
    // as Claude reports it (coerced to an integer; the validation gate still
    // rejects a missing/invalid page, and verbatim_quote remains the anchor).
    for (const s of out.specs || []) { rawSpecs.push(s); }
    for (const f of out.component_facts || []) { rawFacts.push(f); }
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
       values ('oem_owner_manual', $1, $2, $3, now(), $4, 1)
       returning id`,
      [
        SOURCE_META.title,
        SOURCE_META.url,
        SOURCE_META.publisher,
        "Manufacturer-published owner's manual (tier1_open)",
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

  // --- Per-run replayable snapshot --------------------------------------
  // Write the full run to a gitignored file so a regression baseline survives
  // independently of the DB — a later migration deleting rows can never destroy
  // it again (the gap that lost the original source_id=2 first slice). Captures
  // stored rows (with absolute pages + quotes), quarantined items, the discovery
  // list, the page selection, and the cost split — a complete, replayable record.
  const runsDir = path.join(__dirname, "..", "extraction_runs");
  fs.mkdirSync(runsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dumpPath = path.join(runsDir, `run_${sourceId}_${stamp}.json`);
  const dump = {
    source_id: sourceId,
    written_at: new Date().toISOString(),
    pdf: path.basename(PDF_PATH),
    pdf_pages: pageCount,
    identity_check: idCheck.found,
    identity_override: identityOverride || null,
    identity_vision: identityVision, // #17 — null unless a vision fallback ran

    whole_document_tokens: preflightTokens,
    mode: FORCE_FULL ? "full" : "trim",
    selection: selectionNote,
    pages_fed: selectedPages.length,
    selected_pages_1indexed: selectedPages.map((p) => p + 1),
    chunks: chunks.length,
    truncated: anyTruncated,
    tokens: totals.tokens,
    cost: totals.cost,
    stored_specs: passedSpecs,
    stored_component_facts: passedFacts,
    quarantined_specs: quarantinedSpecs,
    quarantined_component_facts: quarantinedFacts,
    discovery,
  };
  fs.writeFileSync(dumpPath, JSON.stringify(dump, null, 2));
  console.log(
    `[extract] run snapshot written: ${path.relative(process.cwd(), dumpPath)} ` +
      `(${passedSpecs.length} specs, ${passedFacts.length} facts, ${quarantinedSpecs.length + quarantinedFacts.length} quarantined)\n`,
  );

  await pool.end();
}

// Run the extraction only when invoked directly (npm run extract:pdf). Guarding
// this lets the pure validation helpers (validateSpec/normalizeSpec/…) be
// imported by a zero-cost node check (e.g. scripts/verifyFuelRange.js) without
// triggering an extraction run or a DB write.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("[extract] error:", err.message);
    process.exit(1);
  });
}

// Exported for zero-cost node checks (no DB, no Claude). The validation gate is
// the boundary the #16 fuel-capacity fix lives in. verifyIdentity (text scan)
// and verifyIdentityVision (#17 cover-page vision pass) are exported so the
// identity path can be exercised by a focused harness without a full run.
export {
  validateSpec,
  validateComponentFact,
  normalizeSpec,
  normUnitForMatch,
  verifyIdentity,
  verifyIdentityVision,
};
