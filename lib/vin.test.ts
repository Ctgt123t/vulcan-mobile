// ============================================================================
// VIN extract/validate — NODE TEST GATE. Same discipline/harness as
// dtcParser.test.ts. The SOFT-checksum behavior is the load-bearing contract:
// a bad check digit must NOT reject the VIN.
//
// Run from project root:
//   npx ts-node --skipProject --compiler-options "{\"module\":\"CommonJS\",\"moduleResolution\":\"node\",\"esModuleInterop\":true}" --transpile-only lib/vin.test.ts
// ============================================================================

import { extractVin, vinCheckDigitValid } from "./vin";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(cond: boolean, msg: string) {
  if (cond) passed++;
  else {
    failed++;
    failures.push(msg);
    console.log(`  FAIL: ${msg}`);
  }
}
function eq(actual: unknown, expected: unknown, msg: string) {
  ok(actual === expected, `${msg} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}
function section(n: string) {
  console.log(`\n=== ${n} ===`);
}

// Canonical valid-check-digit VIN (check char at position 9 = "X").
const VIN = "1HGBH41JXMN109186";
// Same VIN with positions 9&10 transposed → check digit no longer valid.
const VIN_BADCHK = "1HGBH41JXNM109186";

// ---------------------------------------------------------------------------
section("extractVin — clean + wrapped payloads");
eq(extractVin(VIN), VIN, "clean 17-char VIN returned");
eq(extractVin("I" + VIN), VIN, "leading 'I' import flag stripped → VIN extracted");
eq(extractVin("*" + VIN + "*"), VIN, "Code 39 *…* start/stop wrapper stripped");
eq(extractVin(`  ${VIN}\n`), VIN, "surrounding whitespace/newline stripped");
eq(extractVin(`VIN: ${VIN}`), VIN, "label prefix stripped");
eq(
  extractVin(`https://vingenie.com/decode/${VIN}`),
  VIN,
  "QR URL embedding the VIN → VIN substring extracted",
);
eq(extractVin(VIN.toLowerCase()), VIN, "lowercase input → uppercased VIN");

// ---------------------------------------------------------------------------
section("extractVin — rejections (null)");
eq(extractVin("ABC123"), null, "<17 chars → null");
eq(extractVin(""), null, "empty → null");
eq(extractVin("the quick brown fox jumped"), null, "no 17-char run → null");
// I/O/Q can't be inside a VIN; an O in the run splits it below 17 → no candidate.
eq(
  extractVin("1HGBH4OJXMN109186"),
  null,
  "an O inside the 17 breaks the run → no valid candidate → null",
);

// ---------------------------------------------------------------------------
section("vinCheckDigitValid — ISO 3779");
ok(vinCheckDigitValid(VIN) === true, "canonical VIN → check digit valid");
ok(vinCheckDigitValid(VIN_BADCHK) === false, "transposed VIN → check digit invalid");
ok(vinCheckDigitValid("1HGCM82633A004352") === true, "Wikipedia canonical VIN (check=3) valid");
ok(vinCheckDigitValid("TOOSHORT") === false, "non-17 → false");
ok(vinCheckDigitValid("1HGBH4IJXMN10918Z") === false, "contains I (non-VIN char) → false");

// ---------------------------------------------------------------------------
section("SOFT-CHECKSUM LOCK-IN (critical): a bad check digit is NOT rejected");
eq(
  extractVin(VIN_BADCHK),
  VIN_BADCHK,
  "VIN failing the check digit is STILL returned by extractVin (not null)",
);
ok(
  vinCheckDigitValid(VIN_BADCHK) === false,
  "…and vinCheckDigitValid reports false separately (the confidence signal)",
);
eq(extractVin("I" + VIN_BADCHK), VIN_BADCHK, "wrapped bad-check VIN still extracted");

// ---------------------------------------------------------------------------
section("disambiguation — prefer a valid-check-digit window in a long run");
// A run longer than 17 where a valid VIN sits as a window: the valid one wins.
{
  const longRun = "99" + VIN; // 19-char run; one window is the valid VIN
  const got = extractVin(longRun);
  ok(
    got !== null && vinCheckDigitValid(got),
    "a valid-check-digit window is preferred over junk windows in a long run",
  );
}

// ---------------------------------------------------------------------------
section("idempotent");
eq(extractVin(extractVin(VIN) ?? ""), VIN, "extract(extract(VIN)) === VIN");

// ---------------------------------------------------------------------------
console.log(`\n${"=".repeat(48)}`);
if (failed === 0) {
  console.log(`[vin-test] ALL ${passed} PASSED`);
} else {
  console.log(`[vin-test] ${failed} FAILED, ${passed} passed`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
