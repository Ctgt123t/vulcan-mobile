// ----------------------------------------------------------------------------
// trimScan.js — manufacturer-agnostic spec-page scoring for trim-before-extract.
//
// SHARED, PURE, zero-dependency: imported by BOTH the extractor
// (extractFromPdf.js `selectSpecPages`) and the zero-cost preflight
// (trimPreflight.js). Having ONE source for the scoring kills the drift risk
// that bit #7a — the two used to carry hand-synced copies of the dictionary,
// and the preflight's coverage numbers were only trustworthy if someone kept
// them identical. Now the preflight scores pages with the EXACT logic the
// extractor runs, so a green preflight is a real guarantee.
//
// #7a FIX — kill the GM-shaped vocabulary. The original dictionary was
// accidentally fitted to the Sierra: its strong, load-bearing signals were GM
// brand/standard names (dexos / dex-cool / dexron / gawr / gvwr / r-134a) and
// GM-manual heading phrasings ("Capacities and Specifications"). On a non-GM
// manual those signals never fire, so spec-bearing pages scored under the
// threshold and were SILENTLY dropped — a quiet false-negative in page
// selection (measured: Honda captured 18% of its core spec pages, the Subaru
// Outback GSG 0% because its front-of-book specs fell into the back-half
// fail-safe gap).
//
// The fix drives scoring off signals every manufacturer's spec/maintenance
// pages carry, in two parts:
//   1. GENERIC spec/maintenance VOCABULARY (engine oil, oil filter, engine
//      coolant, brake fluid, transmission fluid, spark plug, tire pressure,
//      viscosity, capacity, specifications, maintenance schedule, …) —
//      manufacturer-independent words that appear regardless of brand.
//   2. STRUCTURAL MEASUREMENT PATTERNS (regex) — viscosity grades (0W-20),
//      capacity+unit (4.4 qt / 3.2 L), torque+unit (89 lb-ft / lbf·ft),
//      tire-pressure (psi / kPa), service intervals (160,000 miles), tire
//      sizes (235/65R17), spark-plug gaps (1.1 mm). These are dense on spec
//      pages of ANY make by construction, not by vocabulary.
// The GM brand names are KEPT but demoted to weight-1 bonuses — they help on a
// GM manual without being required by any manual.
//
// Posture is unchanged and deliberately conservative: OVER-include on purpose
// (the ±margin + fail-safe floor still apply in the caller). Under-selection is
// the failure mode being killed; mild over-selection only costs a little extra
// trimming, never a dropped spec.
// ----------------------------------------------------------------------------

// Tunables — named, not buried magic numbers. Kept conservative (over-include).
export const PAGE_SCORE_THRESHOLD = 6; // min keyword score for a page to count as "hot"
export const BAND_MARGIN_PAGES = 5;    // pages added on EACH side of every hot page (over-include)
export const MIN_SELECTED_PAGES = 20;  // sanity floor: fewer selected than this distrusts the trim

// Substring signals (case-insensitive). A page scores the sum of the distinct
// signals it contains. Generic, cross-manufacturer spec vocabulary carries the
// scoring; the few GM-specific brand names at the bottom are weight-1 bonuses.
export const SPEC_SIGNALS = [
  // strong, generic section headings (any make's spec/maintenance chapter)
  ["capacities and specifications", 4], ["maintenance schedule", 4],
  ["scheduled maintenance", 4], ["recommended fluids", 3],
  ["fluid capacities", 3], ["specifications", 3], ["service intervals", 3],
  ["specification", 2], ["maintenance minder", 2],
  // generic fluid / component vocabulary — present across all manufacturers
  ["engine oil", 2], ["oil filter", 2], ["engine coolant", 2],
  ["brake fluid", 2], ["transmission fluid", 2], ["transfer case", 2],
  ["differential fluid", 2], ["spark plug", 2], ["tire pressure", 2],
  ["viscosity", 2], ["capacity", 2],
  // generic, weak
  ["coolant", 1], ["antifreeze", 1], ["lubricant", 1], ["fluid", 1],
  ["refrigerant", 1], ["torque", 1], ["idle speed", 1], [" axle", 1],
  ["dot 3", 1], ["dot 4", 1],
  // GM/brand BONUSES — no longer load-bearing (help on a GM manual only)
  ["dexos", 1], ["dex-cool", 1], ["dexron", 1],
  ["gawr", 1], ["gvwr", 1], ["r-134a", 1],
];

// Structural measurement patterns (manufacturer-independent by construction).
// Each fires at most once per page, adding its weight. These are what catch a
// dense spec/maintenance table on a make whose vocabulary we didn't anticipate.
export const SPEC_PATTERNS = [
  [/\b\d+\s?w[- ]?\d+\b/, 3],                                                              // viscosity grade 0W-20 / 5W30
  [/\b\d+(\.\d+)?\s?(us |imp )?(qt|quart|quarts|liter|litre|liters|litres|gal|gallon|ml)\b/, 2], // capacity + unit
  [/\b\d+(\.\d+)?\s?(lb[-. ]?ft|ft[-. ]?lb|lbf[·. -]?ft|n[·.-]?m|nm)\b/, 2],                // torque + unit
  [/\b\d{2,3}\s?\(?\s?\d{2,3}\s?kpa/, 1],                                                  // tire pressure "32 (220 kPa"
  [/\b\d+\s?psi\b/, 1],                                                                    // pressure psi
  [/\b\d[\d,]{2,}\s?(miles|km)\b/, 1],                                                      // service interval "160,000 miles"
  [/\b\d{3}\/\d{2}r\d{2}\b/, 2],                                                            // tire size 235/65R17
  [/\b\d\.\d{1,2}\s?mm\b/, 1],                                                              // spark-plug gap mm
];

// Score one page's (already lower-cased) text. Distinct substring signals plus
// matching structural patterns. Pure — no I/O, no state.
export function scorePageText(lowerText) {
  let score = 0;
  for (const [needle, w] of SPEC_SIGNALS) {
    if (lowerText.includes(needle)) score += w;
  }
  for (const [re, w] of SPEC_PATTERNS) {
    if (re.test(lowerText)) score += w;
  }
  return score;
}
