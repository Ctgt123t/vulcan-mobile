// ============================================================================
// DTC response parser — standalone pure module.
//
// Intentionally free of React Native / Expo dependencies so it can be
// imported and run in Node.js directly (see dtcParser.test.ts).
//
// Three-pass pipeline for ATH1 CAN responses:
//   Pass 1  parseCanFrames()    — split raw string into per-ECU CAN frames
//   Pass 2  assemblePayloads()  — ISO-TP reassembly per CAN ID (SF / FF+CFs)
//   Pass 3  decodePayloadDtcs() — DTC pair decode from assembled payload
//
// Fallback for non-CAN / ATH0 (no 3-char CAN ID tokens found):
//   parseDtcResponseFlatScan()  — simple byte scan for headers-off mode
//
// Design principles:
//   - Never mutate input. Every function returns new data.
//   - Fail safe: any malformed or unrecognised input returns [] or the
//     largest subset of codes that could be unambiguously decoded.
//   - DEBUG_OBD2 assertions fire on anything structurally suspicious so
//     new vehicle formats surface immediately during testing.
// ============================================================================

import { DEBUG_OBD2 } from "./debug";
import type { DtcParserFixture } from "./dtcParser.fixtures";

// ---- Parser warning listener ----
//
// emitParserWarning() always calls this listener (not gated by DEBUG_OBD2)
// so structural parse issues are captured in the on-device diagnostic log
// even in preview builds where console output is unavailable. The listener
// is registered by lib/obd2.ts on module load.

type ParserWarningListener = (msg: string) => void;
let _warningListener: ParserWarningListener | null = null;

export function setParserWarningListener(fn: ParserWarningListener): void {
  _warningListener = fn;
}

function emitParserWarning(msg: string): void {
  if (DEBUG_OBD2) console.warn(msg);
  _warningListener?.(msg);
}

// ---- DTC byte encoding ----

// Decode two raw OBD-II response bytes into a DTC code string.
// Returns null for the 00 00 null-pair, which acts as a terminator in
// SAE no-count responses and as a "no-code" indicator in count=0 frames.
export function decodeDtcBytes(a: number, b: number): string | null {
  if (a === 0 && b === 0) return null;
  const types = ["P", "C", "B", "U"];
  const type = types[(a >> 6) & 0x03];
  const second = (a >> 4) & 0x03;
  const third = (a & 0x0f).toString(16).toUpperCase();
  const fourth = ((b >> 4) & 0x0f).toString(16).toUpperCase();
  const fifth = (b & 0x0f).toString(16).toUpperCase();
  return `${type}${second}${third}${fourth}${fifth}`;
}

// ---- CAN frame types ----

export interface CanFrame {
  canId: string; // e.g. "7E8"
  data: number[]; // all data bytes following the CAN ID token
}

// ---- Pass 1: CAN frame extraction ----

// Split a raw ELM327 ATH1 response into individual CAN frames.
//
// In the ELM327 ATH1 output, responses from all ECUs are concatenated in the
// order they arrive on the bus. Each frame starts with a 3-char hex CAN ID
// token (e.g. "7E8"), followed by the frame's data bytes (2-char hex tokens).
// Frames from different ECUs are often interleaved — especially for multi-frame
// ISO-TP responses, where a transmitting ECU's consecutive frames arrive
// between single-frame responses from other ECUs.
//
// Returns null when no 3-char hex tokens are found (non-CAN / ATH0 mode).
export function parseCanFrames(response: string): CanFrame[] | null {
  const tokens = response.split(/\s+/).filter((t) => t.length > 0);

  const frames: CanFrame[] = [];
  let currentId: string | null = null;
  let currentData: number[] = [];

  for (const tok of tokens) {
    if (/^[0-9A-F]{3}$/i.test(tok)) {
      // New CAN ID: save the previous frame (if any data was collected).
      if (currentId !== null && currentData.length > 0) {
        frames.push({ canId: currentId.toUpperCase(), data: currentData });
      }
      currentId = tok.toUpperCase();
      currentData = [];
    } else if (/^[0-9A-F]{2}$/i.test(tok)) {
      currentData.push(parseInt(tok, 16));
    }
    // Tokens that are neither 2- nor 3-char hex are silently ignored
    // (carriage returns, noise, partial tokens from buffer overruns).
  }

  // Flush the last frame.
  if (currentId !== null && currentData.length > 0) {
    frames.push({ canId: currentId, data: currentData });
  }

  return frames.length > 0 ? frames : null;
}

// ---- Pass 2: ISO-TP reassembly ----

// Assemble per-ECU payloads from a list of CAN frames using ISO 15765-2.
//
// ISO-TP frame types (identified by the PCI byte — first data byte):
//
//   Single Frame (SF): PCI = 0x0N
//     N = total data length (1–7 bytes). Payload = data[1..N].
//
//   First Frame (FF): PCI = 0x10–0x1F
//     Total declared length = ((PCI & 0x0F) << 8) | data[1].
//     First payload bytes = data[2..7] (up to 6 bytes in a standard CAN frame).
//
//   Consecutive Frame (CF): PCI = 0x20–0x2F
//     Sequence number = PCI & 0x0F. Payload = data[1..7] (7 bytes per CF).
//
// FF + CFs from the same CAN ID are assembled in arrival order and trimmed
// to the total length declared in the FF. Frames from different CAN IDs are
// processed independently, correctly handling bus-interleaved multi-ECU
// responses without any framing bytes crossing ECU boundaries.
//
// Flow-control frames (0x30–0x3F) are not sent by us — the ELM327 handles
// FC automatically after receiving an FF. We never need to generate FC frames.
export function assemblePayloads(frames: CanFrame[]): Map<string, number[]> {
  const result = new Map<string, number[]>();

  // Per-CAN-ID state for in-progress multi-frame assemblies.
  const ffState = new Map<string, { totalLength: number; payload: number[] }>();

  for (const frame of frames) {
    const pci = frame.data[0];
    if (pci === undefined) continue;

    const pciType = pci & 0xF0;

    if (pciType === 0x00) {
      // ---- Single Frame ----
      const len = pci & 0x0F;
      if (len === 0) continue;
      const payload = frame.data.slice(1, 1 + len);
      if (payload.length < len) {
        emitParserWarning(
          `[dtc-parser] SUSPICIOUS: SF ${frame.canId} declares length ${len} ` +
            `but frame only has ${payload.length} data bytes`,
        );
      }
      result.set(frame.canId, payload);

    } else if (pciType === 0x10) {
      // ---- First Frame ----
      const totalLength = ((pci & 0x0F) << 8) | (frame.data[1] ?? 0);
      const payload = [...frame.data.slice(2)];
      ffState.set(frame.canId, { totalLength, payload });
      if (DEBUG_OBD2) {
        console.log(
          `[dtc-parser] FF ${frame.canId}: totalLength=${totalLength}, ` +
            `firstPayloadBytes=[${payload.map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ")}]`,
        );
      }

    } else if (pciType === 0x20) {
      // ---- Consecutive Frame ----
      const ff = ffState.get(frame.canId);
      if (ff) {
        ff.payload.push(...frame.data.slice(1));
        if (DEBUG_OBD2) {
          console.log(
            `[dtc-parser] CF ${frame.canId} seq=${pci & 0x0F}: ` +
              `appended ${frame.data.length - 1} bytes, ` +
              `assembled=${ff.payload.length}/${ff.totalLength}`,
          );
        }
      } else {
        emitParserWarning(
          `[dtc-parser] SUSPICIOUS: CF from ${frame.canId} with no preceding FF — ` +
            `orphan CF ignored`,
        );
      }

    } else {
      emitParserWarning(
        `[dtc-parser] WARN: unknown PCI type 0x${pci.toString(16).toUpperCase()} ` +
          `from ${frame.canId} — frame skipped`,
      );
    }
  }

  // Finalize: trim multi-frame payloads to the total length declared in the FF.
  for (const [canId, ff] of ffState.entries()) {
    if (ff.payload.length < ff.totalLength) {
      emitParserWarning(
        `[dtc-parser] SUSPICIOUS: ${canId} FF declared ${ff.totalLength} bytes ` +
          `but only ${ff.payload.length} assembled — missing consecutive frames?`,
      );
    }
    result.set(canId, ff.payload.slice(0, ff.totalLength));
  }

  return result;
}

// ---- Pass 3: DTC decode ----

// Decode DTC pairs from a single ECU's assembled ISO-TP payload.
//
// The payload begins with the OBD mode echo byte (e.g. 0x43 for Mode 03).
// After the echo, two payload formats are supported:
//
//   GM count-byte format: [ECHO] [COUNT] [PAIR_1_A PAIR_1_B] ... [PAIR_N_A PAIR_N_B]
//     Detected when: frameData[0] * 2 === frameData.length - 1
//
//   SAE no-count format:  [ECHO] [PAIR_1_A PAIR_1_B] ... [00 00] (null terminator)
//     Fallback when count-byte heuristic does not match.
export function decodePayloadDtcs(payload: number[], modeEcho: number): string[] {
  const echoIdx = payload.indexOf(modeEcho);
  if (echoIdx < 0) return [];

  const frameData = payload.slice(echoIdx + 1);
  if (frameData.length === 0) return [];

  const firstByte = frameData[0];
  const useCount =
    frameData.length >= 1 && firstByte * 2 === frameData.length - 1;

  const codes: string[] = [];

  if (useCount) {
    const count = firstByte;
    if (DEBUG_OBD2) console.log(`[dtc-parser] decode: count-byte format, count=${count}`);
    for (let j = 0; j < count; j++) {
      const a = frameData[1 + j * 2];
      const b = frameData[1 + j * 2 + 1];
      if (a === undefined || b === undefined) {
        emitParserWarning(
          `[dtc-parser] SUSPICIOUS: count=${count} but ran out of bytes at pair ${j}`,
        );
        break;
      }
      const code = decodeDtcBytes(a, b);
      if (DEBUG_OBD2) {
        console.log(
          `[dtc-parser]   [${j}] 0x${a.toString(16).padStart(2, "0").toUpperCase()} ` +
            `0x${b.toString(16).padStart(2, "0").toUpperCase()} → ${code ?? "null"}`,
        );
      }
      if (code) codes.push(code);
    }
  } else {
    if (DEBUG_OBD2) console.log(`[dtc-parser] decode: SAE no-count format`);
    let j = 0;
    while (j + 1 < frameData.length) {
      const a = frameData[j];
      const b = frameData[j + 1];
      const code = decodeDtcBytes(a, b);
      if (DEBUG_OBD2) {
        console.log(
          `[dtc-parser]   0x${a.toString(16).padStart(2, "0").toUpperCase()} ` +
            `0x${b.toString(16).padStart(2, "0").toUpperCase()} → ${code ?? "null (stop)"}`,
        );
      }
      if (!code) break;
      codes.push(code);
      j += 2;
    }
    if (j < frameData.length - 1) {
      const leftover = frameData.slice(j);
      if (!leftover.every((b) => b === 0x00)) {
        emitParserWarning(
          `[dtc-parser] SUSPICIOUS: ${leftover.length} unconsumed non-null bytes after decode: ` +
            `[${leftover.map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ")}]`,
        );
      }
    }
  }

  return codes;
}

// ---- ATH0 / non-CAN flat-scan fallback ----

// Used when no 3-char CAN ID tokens are found in the response — indicates
// either ATH0 mode (headers stripped) or a non-CAN protocol (ISO9141,
// KWP2000, J1850). Response format: [mode_echo] [payload bytes], no framing.
function parseDtcResponseFlatScan(response: string, echoVal: number): string[] {
  const bytes = response
    .replace(/^[^A-F0-9]+/i, "")
    .split(/\s+/)
    .filter((s) => /^[0-9A-F]{2}$/i.test(s))
    .map((s) => parseInt(s, 16));

  if (bytes.length === 0) return [];

  const codes = decodePayloadDtcs(bytes, echoVal);
  const result = Array.from(new Set(codes));

  if (DEBUG_OBD2) {
    console.log(`[dtc-parser] flat-scan result: [${result.join(", ") || "none"}]`);
  }

  return result;
}

// ---- Main entry point ----

// Parse a raw ELM327 DTC response string into an array of code strings.
//
// Handles:
//   - Multi-ECU CAN responses with interleaved frames (ATH1 mode)
//   - ISO-TP single-frame, first-frame, and consecutive-frame reassembly
//   - GM count-byte and SAE no-count DTC payload formats
//   - Non-CAN and ATH0 responses (flat-scan fallback)
//   - All common error strings (NO DATA, UNABLE TO CONNECT, STOPPED, ?)
export function parseDtcResponse(response: string, modeEcho: string): string[] {
  if (!response || response.trim().length === 0) return [];
  if (/NO\s*DATA|UNABLE|STOPPED|\?|CAN\s*ERROR/i.test(response)) return [];

  const echoVal = parseInt(modeEcho, 16);

  if (DEBUG_OBD2) {
    console.log(`[dtc-parser] echo=0x${modeEcho} raw: "${response}"`);
  }

  const frames = parseCanFrames(response);

  if (frames === null) {
    // Non-CAN or ATH0: no 3-char CAN ID tokens found.
    if (DEBUG_OBD2) {
      console.log(
        `[dtc-parser] no CAN frame structure — flat-scan fallback (ATH0/non-CAN)`,
      );
    }
    return parseDtcResponseFlatScan(response, echoVal);
  }

  if (DEBUG_OBD2) {
    console.log(
      `[dtc-parser] ${frames.length} CAN frame(s): ` +
        frames
          .map(
            (f) =>
              `${f.canId}[PCI=0x${(f.data[0] ?? 0).toString(16).toUpperCase()}]`,
          )
          .join(", "),
    );
  }

  const payloads = assemblePayloads(frames);

  const allCodes: string[] = [];
  for (const [canId, payload] of payloads.entries()) {
    if (DEBUG_OBD2) {
      console.log(
        `[dtc-parser] decoding ${canId} (${payload.length}B): ` +
          `[${payload.map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ")}]`,
      );
    }
    const codes = decodePayloadDtcs(payload, echoVal);
    allCodes.push(...codes);
  }

  const result = Array.from(new Set(allCodes));

  if (DEBUG_OBD2) {
    console.log(`[dtc-parser] → [${result.join(", ") || "none"}]`);
  }
  if (result.length > 20) {
    emitParserWarning(
      `[dtc-parser] SUSPICIOUS: ${result.length} codes decoded — ` +
        `implausibly high for a standard scan`,
    );
  }

  return result;
}

// ---- In-app self-test ----

// Validates the parser against all fixtures. Runs synchronously and logs
// PASS/FAIL to the Metro console. Called on app startup when DEBUG_OBD2=1
// so regression failures surface before connecting to a vehicle.
export function runDtcParserSelfTest(): {
  passed: number;
  failed: number;
  failures: string[];
} {
  // Lazy import to keep the production bundle free of fixture data when
  // DEBUG_OBD2 is false (Expo's dead-code elimination removes unused branches).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { DTC_PARSER_FIXTURES } = require("./dtcParser.fixtures") as {
    DTC_PARSER_FIXTURES: DtcParserFixture[];
  };

  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  console.log("[dtc-test] === DTC Parser Self-Test ===");

  for (const fixture of DTC_PARSER_FIXTURES) {
    const actual = parseDtcResponse(fixture.rawResponse, fixture.modeEcho);

    // Order-independent comparison.
    const expectedSet = new Set(fixture.expectedCodes);
    const actualSet = new Set(actual);
    const ok =
      expectedSet.size === actualSet.size &&
      [...expectedSet].every((c) => actualSet.has(c));

    if (ok) {
      passed++;
      console.log(`[dtc-test]  PASS  ${fixture.label}`);
    } else {
      failed++;
      console.error(
        `[dtc-test]  FAIL  ${fixture.label}\n` +
          `             expected: [${fixture.expectedCodes.join(", ") || "none"}]\n` +
          `             actual:   [${actual.join(", ") || "none"}]`,
      );
      failures.push(fixture.label);
    }
  }

  if (failed === 0) {
    console.log(`[dtc-test] === ALL ${passed} PASSED ===`);
  } else {
    console.error(`[dtc-test] === ${failed} FAILED / ${passed} PASSED ===`);
    for (const f of failures) console.error(`[dtc-test]     ✗ ${f}`);
  }

  return { passed, failed, failures };
}
