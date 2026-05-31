// ============================================================================
// DTC parser tests — Node.js runnable, no test framework required.
//
// Usage (from the project root, CMD):
//   npx ts-node --skipProject --compiler-options "{\"module\":\"CommonJS\",\"moduleResolution\":\"node\",\"esModuleInterop\":true}" --transpile-only lib/dtcParser.test.ts
//
// --skipProject   ignore the project tsconfig (avoids RN/Expo path issues)
// --transpile-only skip type checking for faster execution
//
// Exit code 0 = all pass. Exit code 1 = one or more failures.
// ============================================================================

// Suppress the DEBUG_OBD2 parse-trace logging so test output stays clean.
// Remove this line (or set EXPO_PUBLIC_DEBUG_OBD2=1 in the shell) if you want
// to see the full per-frame assembly trace while debugging a failing fixture.
process.env.EXPO_PUBLIC_DEBUG_OBD2 = "";

import { parseDtcResponse, parseCanFrames, assemblePayloads, decodePayloadDtcs, decodeDtcBytes } from "./dtcParser";
import { DTC_PARSER_FIXTURES } from "./dtcParser.fixtures";

let passed = 0;
let failed = 0;
const failures: string[] = [];

// ---- Unit tests for lower-level functions ----

function assert(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.error(`  FAIL  ${label}${detail ? `\n         ${detail}` : ""}`);
    failures.push(label);
  }
}

function assertCodes(label: string, actual: string[], expected: string[]): void {
  const a = new Set(actual);
  const e = new Set(expected);
  const ok =
    a.size === e.size && [...e].every((c) => a.has(c));
  if (ok) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    const msg = `expected [${expected.join(", ") || "none"}], got [${actual.join(", ") || "none"}]`;
    console.error(`  FAIL  ${label}\n         ${msg}`);
    failures.push(label);
  }
}

// --- decodeDtcBytes ---
console.log("\n── decodeDtcBytes ──");
assert("null pair → null",               decodeDtcBytes(0x00, 0x00) === null);
assert("P0442 → P0442",                  decodeDtcBytes(0x04, 0x42) === "P0442");
assert("B1516 → B1516",                  decodeDtcBytes(0x95, 0x16) === "B1516");
assert("P0171 → P0171",                  decodeDtcBytes(0x01, 0x71) === "P0171");
assert("C0300 (mode echo value) → C0300", decodeDtcBytes(0x43, 0x00) === "C0300");
assert("U0300 (0xC3, 0x00)",               decodeDtcBytes(0xC3, 0x00) === "U0300");

// --- parseCanFrames ---
console.log("\n── parseCanFrames ──");
const noFrames = parseCanFrames("43 01 04 42");
assert("ATH0 response → null (no CAN IDs)", noFrames === null);

const emptyFrames = parseCanFrames("");
assert("empty string → null", emptyFrames === null);

const sierraFrames = parseCanFrames("7E8 02 43 00 7EB 02 43 00 7EA 02 43 00");
assert("Sierra Mode03: 3 frames extracted", sierraFrames !== null && sierraFrames.length === 3);
assert("Sierra frame 0 canId = 7E8",       sierraFrames?.[0]?.canId === "7E8");
assert("Sierra frame 0 data = [02,43,00]", JSON.stringify(sierraFrames?.[0]?.data) === JSON.stringify([0x02, 0x43, 0x00]));

const interleavedFrames = parseCanFrames(
  "7EB 02 43 00 7E8 10 08 43 03 04 42 95 16 7EA 02 43 00 7E8 21 01 71 AA AA AA AA",
);
assert("interleaved: 4 frames extracted", interleavedFrames !== null && interleavedFrames.length === 4);
assert("interleaved: frame[1] is 7E8 FF",  interleavedFrames?.[1]?.canId === "7E8" && (interleavedFrames?.[1]?.data[0] ?? 0) === 0x10);
assert("interleaved: frame[3] is 7E8 CF",  interleavedFrames?.[3]?.canId === "7E8" && (interleavedFrames?.[3]?.data[0] ?? 0) === 0x21);

// --- assemblePayloads ---
console.log("\n── assemblePayloads ──");
const sierraPayloads = assemblePayloads(sierraFrames!);
assert("Sierra Mode03: 3 ECUs assembled",         sierraPayloads.size === 3);
assert("Sierra 7E8 payload = [43,00]",             JSON.stringify([...(sierraPayloads.get("7E8") ?? [])]) === JSON.stringify([0x43, 0x00]));

if (interleavedFrames) {
  const ip = assemblePayloads(interleavedFrames);
  assert("interleaved: 3 ECUs in result",            ip.size === 3);
  const p7e8 = ip.get("7E8") ?? [];
  assert("interleaved: 7E8 assembled = 8 bytes",     p7e8.length === 8);
  assert("interleaved: 7E8 payload[0] = 0x43",       p7e8[0] === 0x43);
  assert("interleaved: 7E8 payload[7] = 0x71 (P0171 B)", p7e8[7] === 0x71);
}

// --- decodePayloadDtcs ---
console.log("\n── decodePayloadDtcs ──");
assertCodes("count=0 payload → []",               decodePayloadDtcs([0x43, 0x00], 0x43), []);
assertCodes("count=1 payload → [P0442]",           decodePayloadDtcs([0x43, 0x01, 0x04, 0x42], 0x43), ["P0442"]);
assertCodes("count=3 payload → 3 codes",           decodePayloadDtcs([0x43, 0x03, 0x04, 0x42, 0x95, 0x16, 0x01, 0x71], 0x43), ["P0442", "B1516", "P0171"]);
assertCodes("SAE no-count, null terminator",        decodePayloadDtcs([0x43, 0x04, 0x42, 0x00, 0x00], 0x43), ["P0442"]);
assertCodes("echo absent → []",                    decodePayloadDtcs([0x47, 0x01, 0x04, 0x42], 0x43), []);
assertCodes("empty frameData → []",                decodePayloadDtcs([0x43], 0x43), []);

// --- parseDtcResponse: fixture suite ---
console.log("\n── parseDtcResponse fixtures ──");
for (const fixture of DTC_PARSER_FIXTURES) {
  assertCodes(fixture.label, parseDtcResponse(fixture.rawResponse, fixture.modeEcho), fixture.expectedCodes);
}

// ---- Summary ----
console.log(`\n${"─".repeat(60)}`);
if (failed === 0) {
  console.log(`ALL ${passed} TESTS PASSED`);
} else {
  console.error(`${failed} FAILED / ${passed} PASSED`);
  console.error("Failed:");
  for (const f of failures) console.error(`  ✗ ${f}`);
}
console.log("─".repeat(60));

process.exit(failed > 0 ? 1 : 0);
