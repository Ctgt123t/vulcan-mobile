// ----------------------------------------------------------------------------
// trimPreflight.js — read-only, zero-API-cost preflight for an extraction run.
//
// Replicates extractFromPdf.js's keyword-density page scan (same dictionary,
// same threshold/margin/floor constants) against a candidate manual WITHOUT
// running the extractor, so the Honda finding (#7a: the GM-shaped trim
// dictionary SILENTLY under-selects on non-GM manuals) can be checked before
// any Claude spend. Also dumps the first-pages text (local identity peek) and
// per-page scores around the selected bands so a human can judge whether the
// manual's actual Specifications / Maintenance chapters were captured.
//
// Usage: node scripts/trimPreflight.js <pdfPath>
// Keep the SPEC_SIGNALS / threshold constants in sync with extractFromPdf.js
// if they change there (this is a diagnostic mirror, not an import, so the
// extractor stays untouched).
// ----------------------------------------------------------------------------

import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PAGE_SCORE_THRESHOLD = 6;
const BAND_MARGIN_PAGES = 5;
const MIN_SELECTED_PAGES = 20;

const SPEC_SIGNALS = [
  ["capacities and specifications", 4], ["maintenance schedule", 4],
  ["recommended fluids", 3], ["capacity", 2], ["specification", 2],
  ["lb-ft", 2], ["ft-lb", 2], ["lb ft", 2], ["ft lb", 2], ["n·m", 2],
  ["viscosity", 2], ["dexos", 2], ["dex-cool", 2], ["dexron", 2],
  ["gawr", 2], ["gvwr", 2], ["r-134a", 2], ["spark plug gap", 2],
  ["torque", 1], ["coolant", 1], ["refrigerant", 1], ["lubricant", 1],
  ["fluid", 1], ["sae ", 1], ["quart", 1], ["liter", 1], ["litre", 1],
  ["psi", 1], ["kpa", 1], [" rpm", 1], ["transfer case", 1],
  ["differential", 1], [" axle", 1], ["fuel tank", 1], ["dot 3", 1],
  ["brake fluid", 1], ["tire pressure", 1], ["idle speed", 1],
];

const pdfPath = process.argv[2];
if (!pdfPath) {
  console.error("usage: node scripts/trimPreflight.js <pdfPath>");
  process.exit(1);
}

const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");

const data = new Uint8Array(fs.readFileSync(path.resolve(pdfPath)));
const doc = await getDocument({ data, useSystemFonts: true }).promise;
const pageCount = doc.numPages;
console.log(`[preflight] ${pdfPath} — ${pageCount} pages`);

const scores = [];
const texts = [];
for (let i = 1; i <= pageCount; i++) {
  const page = await doc.getPage(i);
  const tc = await page.getTextContent();
  const text = tc.items.map((it) => it.str).join(" ").toLowerCase();
  texts.push(text);
  let score = 0;
  for (const [sig, w] of SPEC_SIGNALS) if (text.includes(sig)) score += w;
  scores.push(score);
}

// Identity peek: first 3 pages of raw text (what verifyIdentity will see).
console.log("\n=== IDENTITY PEEK (pages 1-3 text, first 600 chars each) ===");
for (let i = 0; i < Math.min(3, pageCount); i++) {
  console.log(`--- page ${i + 1} ---`);
  console.log(texts[i].slice(0, 600).replace(/\s+/g, " ").trim() || "(no extractable text)");
}

// Hot pages + bands (same algorithm shape as the extractor: hot -> ±margin -> merge).
const hot = [];
scores.forEach((s, i) => { if (s >= PAGE_SCORE_THRESHOLD) hot.push(i); });
const selected = new Set();
for (const h of hot) {
  for (let p = Math.max(0, h - BAND_MARGIN_PAGES); p <= Math.min(pageCount - 1, h + BAND_MARGIN_PAGES); p++) {
    selected.add(p);
  }
}
const sel = [...selected].sort((a, b) => a - b);

// Merge into contiguous bands for readability.
const bands = [];
for (const p of sel) {
  const last = bands[bands.length - 1];
  if (last && p === last[1] + 1) last[1] = p;
  else bands.push([p, p]);
}

console.log(`\n=== TRIM RESULT ===`);
console.log(`hot pages (score>=${PAGE_SCORE_THRESHOLD}): ${hot.length}`);
console.log(`selected after ±${BAND_MARGIN_PAGES} margin: ${sel.length}/${pageCount} pages`);
console.log(`fail-safe floor (${MIN_SELECTED_PAGES}): ${sel.length < MIN_SELECTED_PAGES ? "TRIPPED — extractor would distrust the trim" : "ok"}`);
console.log(`bands (1-indexed): ${bands.map(([a, b]) => `${a + 1}-${b + 1}`).join(", ")}`);

// Score histogram of the top-scoring pages, to spot near-misses just under
// the threshold (the silent-under-selection signature).
const ranked = scores.map((s, i) => [i + 1, s]).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]);
console.log(`\n=== TOP 30 SCORING PAGES (page:score) ===`);
console.log(ranked.slice(0, 30).map(([p, s]) => `${p}:${s}`).join("  "));
const nearMiss = scores.map((s, i) => [i + 1, s]).filter(([p, s]) => s === PAGE_SCORE_THRESHOLD - 1 || s === PAGE_SCORE_THRESHOLD - 2);
const rescued = nearMiss.filter(([p]) => selected.has(p - 1));
console.log(`\nnear-miss pages (score ${PAGE_SCORE_THRESHOLD - 2}-${PAGE_SCORE_THRESHOLD - 1}): ${nearMiss.length}, of which ${rescued.length} rescued by margin; UNRESCUED: ${nearMiss.filter(([p]) => !selected.has(p - 1)).map(([p, s]) => `${p}:${s}`).join(" ") || "none"}`);

// Keyword search for the chapters we KNOW a Subaru manual has, to verify the
// scan caught them: "Specifications" chapter + "Maintenance and service".
console.log(`\n=== CHAPTER ANCHOR CHECK (is each anchor page inside the selection?) ===`);
const anchors = [
  "engine oil filter",
  "oil filter",
  "specifications",
  "maintenance and service",
  "fluid capacity",
  "engine coolant",
];
for (const a of anchors) {
  const pages = [];
  texts.forEach((t, i) => { if (t.includes(a)) pages.push(i); });
  const inSel = pages.filter((p) => selected.has(p));
  console.log(`"${a}": ${pages.length} pages, ${inSel.length} inside selection${pages.length !== inSel.length ? ` — OUTSIDE: ${pages.filter((p) => !selected.has(p)).map((p) => p + 1).join(",")}` : ""}`);
}
