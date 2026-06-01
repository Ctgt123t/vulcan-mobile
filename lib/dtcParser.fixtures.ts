// ============================================================================
// DTC parser test fixtures.
//
// Each fixture contains the raw ELM327 response string exactly as it arrives
// from the adapter (including CAN IDs and framing), the mode echo byte string,
// and the expected DTC codes. Used by both the Node.js test script and the
// in-app runDtcParserSelfTest() function.
//
// Sources:
//   REAL — captured verbatim from actual vehicle logs (see notes)
//   SYNTHETIC — constructed from the ISO-TP spec to exercise specific paths
// ============================================================================

export interface DtcParserFixture {
  label: string;
  rawResponse: string;
  modeEcho: string;
  expectedCodes: string[];
  notes?: string;
}

export const DTC_PARSER_FIXTURES: DtcParserFixture[] = [
  // ---- Real captures: 2011 GMC Sierra 4.8L (OBDLink MX+ via Classic BT) ----

  {
    label: "REAL — Sierra Mode 03 (stored), zero codes, 3 ECUs",
    rawResponse: "7E8 02 43 00 7EB 02 43 00 7EA 02 43 00",
    modeEcho: "43",
    expectedCodes: [],
    notes:
      "PCM (7E8), EBCM (7EB), BCM (7EA) each respond with count=0. " +
      "The pre-fix flat-scan parser produced phantom P0002, C0300, P0243 " +
      "by treating frame-boundary bytes as DTC payload.",
  },
  {
    label: "REAL — Sierra Mode 07 (pending), zero codes, 3 ECUs",
    rawResponse: "7E8 02 47 00 7EB 02 47 00 7EA 02 47 00",
    modeEcho: "47",
    expectedCodes: [],
    notes: "Pre-fix parser produced P0002, C0700, P0247.",
  },
  {
    label: "REAL — Sierra Mode 07 (pending), zero codes, order variation",
    rawResponse: "7EA 02 47 00 7E8 02 47 00 7EB 02 47 00",
    modeEcho: "47",
    expectedCodes: [],
    notes: "Same codes, different ECU ordering in the response stream.",
  },
  {
    label: "REAL — Sierra Mode 0A (permanent), P0442, 3 ECUs",
    rawResponse: "7EB 02 4A 00 7E8 04 4A 01 04 42 7EA 02 4A 00",
    modeEcho: "4A",
    expectedCodes: ["P0442"],
    notes:
      "PCM (7E8) has 1 permanent code (P0442 = EVAP small leak). " +
      "EBCM and BCM have none. Pre-fix parser produced P0004, C0A01, P0442, P024A " +
      "— found the real code but also generated 3 phantoms from framing bytes.",
  },
  {
    label: "REAL — Sierra Mode 0A (permanent), P0442, reversed ECU order",
    rawResponse: "7EB 02 4A 00 7E8 04 4A 01 04 42 7EA 02 4A 00",
    modeEcho: "4A",
    expectedCodes: ["P0442"],
  },

  // ---- Synthetic: single-frame, multi-ECU (no multi-frame) ----

  {
    label: "SYNTH — SF, 2 stored codes on PCM, GM count-byte format",
    rawResponse: "7E8 06 43 02 04 42 95 16 7EB 02 43 00",
    modeEcho: "43",
    expectedCodes: ["P0442", "B1516"],
    notes:
      "PCM: PCI=06 (6 data bytes), mode echo, count=2, P0442 (04 42), B1516 (95 16). " +
      "EBCM: count=0.",
  },
  {
    label: "SYNTH — SF, 1 stored code, SAE no-count format",
    rawResponse: "7E8 03 43 04 42 00",
    modeEcho: "43",
    expectedCodes: ["P0442"],
    notes:
      "PCI=03 (3 data bytes): mode echo + 1 DTC pair. No count byte — SAE direct-pair format. " +
      "Trailing 00 is outside the declared SF payload (data.slice(1,4)) and is ignored.",
  },
  {
    label: "SYNTH — SF, 3 stored codes, SAE no-count, 00 00 terminator",
    rawResponse: "7E8 09 43 04 42 95 16 01 71 00 00",
    modeEcho: "43",
    expectedCodes: ["P0442", "B1516", "P0171"],
    notes:
      "PCI=09 (9 data bytes). No count byte; null-pair 00 00 terminates the decode.",
  },

  // ---- Synthetic: multi-frame ISO-TP ----

  {
    label: "SYNTH — FF+CF, 3 codes, single ECU, no interleaving",
    rawResponse:
      "7E8 10 08 43 03 04 42 95 16 7E8 21 01 71 AA AA AA AA",
    modeEcho: "43",
    expectedCodes: ["P0442", "B1516", "P0171"],
    notes:
      "FF: total=8 bytes, first 6 payload bytes: 43 03 04 42 95 16. " +
      "CF1: seq=1, payload 01 71 + padding AA AA AA AA. " +
      "Trimmed to 8: 43 03 04 42 95 16 01 71. GM count=3.",
  },
  {
    label: "SYNTH — FF+CF, 3 codes, INTERLEAVED with zero-code ECUs",
    rawResponse:
      "7EB 02 43 00 7E8 10 08 43 03 04 42 95 16 7EA 02 43 00 7E8 21 01 71 AA AA AA AA",
    modeEcho: "43",
    expectedCodes: ["P0442", "B1516", "P0171"],
    notes:
      "The real-world interleaved case: 7E8's CF arrives AFTER 7EA's single-frame " +
      "response. Correct reassembly requires grouping by CAN ID. A flat-stream " +
      "scanner would misread 7EA's frame bytes as part of 7E8's payload.",
  },
  {
    label: "SYNTH — FF+CF, 4 codes, single ECU (10-byte payload)",
    rawResponse:
      "7E8 10 0A 43 04 04 42 95 16 7E8 21 01 71 01 84 AA AA",
    modeEcho: "43",
    expectedCodes: ["P0442", "B1516", "P0171", "P0184"],
    notes:
      "FF declares 10 bytes total. 6 bytes in FF + 4 used bytes from CF1 = 10. " +
      "GM count=4. Verifies correct trim to totalLength.",
  },
  {
    label: "SYNTH — FF+2CFs, 6 codes, single ECU (14-byte payload)",
    rawResponse:
      "7E8 10 0E 43 06 04 42 95 16 7E8 21 01 71 01 84 02 07 02 7E8 22 43 AA AA AA AA AA",
    modeEcho: "43",
    expectedCodes: ["P0442", "B1516", "P0171", "P0184", "P0207", "P0243"],
    notes:
      "FF declares 14 bytes. FF CAN data (8 bytes): 10 0E + payload[0..5]=43 06 04 42 95 16. " +
      "CF1 CAN data (8 bytes): 21 + payload[6..12]=01 71 01 84 02 07 02. " +
      "CF2 CAN data (8 bytes): 22 + payload[13]=43 + padding AA*6. " +
      "Assembled trimmed to 14: 43 06 [6 × 2-byte pairs]. GM count=6.",
  },

  // ---- Synthetic: non-CAN / ATH0 ----

  {
    label: "SYNTH — ATH0 / non-CAN, 1 code, GM count-byte format",
    rawResponse: "43 01 04 42",
    modeEcho: "43",
    expectedCodes: ["P0442"],
    notes:
      "No 3-char CAN ID tokens. Flat-scan path. Mode echo + count=1 + P0442.",
  },
  {
    label: "SYNTH — ATH0 / non-CAN, 2 codes, SAE no-count format",
    rawResponse: "43 04 42 95 16 00 00",
    modeEcho: "43",
    expectedCodes: ["P0442", "B1516"],
    notes: "Mode echo + 2 DTC pairs + null terminator.",
  },

  // ---- Pathological / malformed — all must return [] gracefully ----

  {
    label: "PATHO — empty string",
    rawResponse: "",
    modeEcho: "43",
    expectedCodes: [],
  },
  {
    label: "PATHO — NO DATA response",
    rawResponse: "NO DATA",
    modeEcho: "43",
    expectedCodes: [],
  },
  {
    label: "PATHO — UNABLE TO CONNECT",
    rawResponse: "UNABLE TO CONNECT",
    modeEcho: "43",
    expectedCodes: [],
  },
  {
    label: "PATHO — mode echo absent (Mode 07 response in Mode 03 parse)",
    rawResponse: "7E8 03 47 04 42",
    modeEcho: "43",
    expectedCodes: [],
    notes: "Payload [47 04 42] does not contain the Mode 03 echo 0x43 → empty.",
  },
  {
    label: "PATHO — SF with length=1 (just the mode echo, no payload)",
    rawResponse: "7E8 01 43",
    modeEcho: "43",
    expectedCodes: [],
    notes: "PCI=01, len=1, payload=[43]. After echo, frameData=[] → 0 codes.",
  },
  {
    label: "PATHO — orphan CF with no preceding FF",
    rawResponse: "7E8 21 04 42 95 16 7EB 02 43 00",
    modeEcho: "43",
    expectedCodes: [],
    notes:
      "7E8's CF has no FF — silently dropped. 7EB's SF has count=0. " +
      "No codes decoded, no crash.",
  },
  // ---- Non-CAN protocol fixtures (ISO 9141, KWP2000, J1850 with ATH0) ----
  //
  // After detecting a non-CAN protocol via ATDPN, the handshake sends ATH0
  // (headers off). All subsequent responses arrive as bare data bytes with no
  // framing headers — exactly the flat-scan format these fixtures exercise.
  // The dtcParser routes here automatically when parseCanFrames() returns null
  // (no 3-char CAN ID tokens found).

  {
    label: "NON-CAN — Mode 03 ATH0, zero stored codes",
    rawResponse: "43 00",
    modeEcho: "43",
    expectedCodes: [],
    notes:
      "ISO 9141 / KWP2000 / J1850 with ATH0. Mode echo + count=0. " +
      "This is the most common response on older vehicles with no stored codes.",
  },
  {
    label: "NON-CAN — Mode 03 ATH0, 1 stored code, SAE no-count with null terminator",
    rawResponse: "43 04 42 00 00",
    modeEcho: "43",
    expectedCodes: ["P0442"],
    notes:
      "ATH0. Mode echo + P0442 bytes + null terminator. No count byte — SAE no-count format.",
  },
  {
    label: "NON-CAN — Mode 03 ATH0, 2 stored codes, SAE no-count",
    rawResponse: "43 04 42 01 71 00 00",
    modeEcho: "43",
    expectedCodes: ["P0442", "P0171"],
    notes:
      "ATH0, two codes in SAE no-count format. " +
      "Flat-scan pairs: [04,42]→P0442, [01,71]→P0171, [00,00]→null stop.",
  },
  {
    label: "NON-CAN — Mode 0A ATH0, 1 permanent code, count-byte format",
    rawResponse: "4A 01 04 42",
    modeEcho: "4A",
    expectedCodes: ["P0442"],
    notes:
      "Mode 0A permanent codes with ATH0. Count-byte format: echo + count=1 + P0442. " +
      "Confirms count-byte detection works in the flat-scan path.",
  },
  {
    label: "NON-CAN — Mode 07 ATH0, zero pending codes",
    rawResponse: "47 00",
    modeEcho: "47",
    expectedCodes: [],
    notes:
      "Mode 07 pending codes with ATH0. Mode echo + count=0. " +
      "Tests the flat-scan path with the Mode 07 echo byte.",
  },

  // NOTE — truncated multi-frame (FF with no CF) is intentionally NOT a test
  // fixture. When a FF arrives but its CFs don't, the assembled payload is
  // shorter than declared. The count-byte heuristic fails on the truncated
  // data; the no-count path runs and produces incorrect codes (e.g. [P0304,
  // C0295] instead of the real codes). This is a known limitation: detecting
  // truncation requires comparing assembled-vs-declared length at decode time,
  // which is not yet implemented. In practice the ELM327 returns STOPPED or
  // CAN ERROR when CFs are lost, and those responses are filtered before
  // parseDtcResponse runs. A DEBUG_OBD2 warning fires when
  // assembled < totalLength. Tracking issue: implement truncation detection.
];
