// ----------------------------------------------------------------------------
// trimPreflight.js — read-only, zero-API-cost preflight for an extraction run.
//
// Mirrors extractFromPdf.js's keyword-density page scan against a candidate
// manual WITHOUT running the extractor, so the Honda finding (#7a: the trim
// dictionary SILENTLY under-selects on non-GM manuals) can be checked before
// any Claude spend. Also dumps the first-pages text (local identity peek) and
// per-page scores around the selected bands so a human can judge whether the
// manual's actual Specifications / Maintenance chapters were captured.
//
// Usage: node scripts/trimPreflight.js <pdfPath>
// The scoring is IMPORTED from the shared ./trimScan.js (the SAME module the
// extractor uses), so the two can never drift — a green preflight is a real
// guarantee about what the extractor will select, not an approximation.
// ----------------------------------------------------------------------------

import path from "node:path";
import fs from "node:fs";
import {
  PAGE_SCORE_THRESHOLD,
  BAND_MARGIN_PAGES,
  MIN_SELECTED_PAGES,
  scorePageText,
} from "./trimScan.js";

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
  scores.push(scorePageText(text));
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
