// ============================================================================
// VIN extraction + validation — PURE (no RN deps), node-testable.
//
// Replaces the old anchored `^[A-HJ-NPR-Z0-9]{17}$` full-match in VinScanner,
// which rejected any payload that wasn't EXACTLY 17 chars after stripping
// punctuation — so a Code 39 VIN carrying a leading `I` import flag / `*…*`
// start-stop wrapper, or a QR payload that's a URL containing the VIN, all
// failed. This SEARCHES for a 17-char VIN candidate instead.
//
// SOFT CHECKSUM (decided behavior): extractVin returns the VIN whenever
// charset + length pass. A FAILING ISO-3779 check digit does NOT reject it —
// the check digit is a separate confidence signal (vinCheckDigitValid), never a
// gate. (Non-US-market VINs don't always carry a valid check digit; blocking
// would drop legitimate scans.)
// ============================================================================

// VIN charset excludes I, O, Q (ISO 3779 — they'd be confused with 1 / 0).
// A maximal run of these is a VIN candidate; anything else (space, *, -, the
// import `I`, URL punctuation) delimits runs.
const VIN_RUN_RE = /[A-HJ-NPR-Z0-9]+/g;

// ISO 3779 transliteration values (I/O/Q intentionally absent).
const TRANSLIT: Record<string, number> = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
  J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
  "0": 0, "1": 1, "2": 2, "3": 3, "4": 4,
  "5": 5, "6": 6, "7": 7, "8": 8, "9": 9,
};

// Positional weights 1..17. Position 9 (index 8) is the check digit (weight 0).
const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

// ISO 3779 check-digit validation. Returns false for a non-17 / non-VIN-charset
// input. A "true" means the 9th character matches the computed check character
// (a digit, or "X" for remainder 10).
export function vinCheckDigitValid(vin: string): boolean {
  if (typeof vin !== "string" || vin.length !== 17) return false;
  const v = vin.toUpperCase();
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const val = TRANSLIT[v[i]];
    if (val === undefined) return false; // contains I/O/Q or junk
    sum += val * WEIGHTS[i];
  }
  const r = sum % 11;
  const expected = r === 10 ? "X" : String(r);
  return v[8] === expected;
}

// Extract a 17-char VIN from a scanned payload (1D barcode data, or a QR/URL
// payload that embeds the VIN). Returns the VIN (uppercased) or null. SOFT — a
// candidate that passes charset + length is returned even if its check digit
// fails; when multiple 17-char candidates exist (a longer run), the one whose
// check digit validates is preferred, else the first candidate.
export function extractVin(payload: string): string | null {
  if (typeof payload !== "string" || payload.length === 0) return null;
  const runs = payload.toUpperCase().match(VIN_RUN_RE);
  if (!runs) return null;

  const candidates: string[] = [];
  for (const run of runs) {
    // Slide a 17-char window across any run >= 17 (exact-17 runs yield one).
    for (let i = 0; i + 17 <= run.length; i++) {
      candidates.push(run.slice(i, i + 17));
    }
  }
  if (candidates.length === 0) return null;

  // Prefer a check-digit-valid candidate (disambiguates a longer junk run);
  // otherwise return the first — never reject on a bad check digit (soft).
  return candidates.find(vinCheckDigitValid) ?? candidates[0];
}
