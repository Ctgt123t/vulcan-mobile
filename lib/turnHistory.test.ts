// ============================================================================
// Thread → history serialization — NODE TEST GATE (Stage 2C-4 SB4).
//
// THE GATE for SB4: the unified brain only reasons well if buildTurnHistory
// produces a coherent, compact, strictly-alternating narrative of the case —
// across a full multi-turn case AND on a case resumed mid-sequence. Same
// discipline as lib/dtcParser.test.ts / lib/captureDetector.test.ts: a
// standalone, framework-free runner. SB4 is NOT done until this is green.
//
// Run from project root:
//   npx ts-node --skipProject --compiler-options "{\"module\":\"CommonJS\",\"moduleResolution\":\"node\",\"esModuleInterop\":true}" --transpile-only lib/turnHistory.test.ts
//
// (--transpile-only: types are not enforced here, so fixtures cast loosely.)
// ============================================================================

import type { ChatMessage } from "./types";
import type { DiagnosticAssessment } from "./assessmentTypes";
import type { EvidenceCaptureEntry } from "./diagnosticCasesCore";
import {
  type HistoryAssessment,
  type HistoryCapture,
  buildTurnHistory,
} from "./turnHistory";

// ---- tiny test harness ----------------------------------------------------

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(cond: boolean, msg: string) {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(msg);
    console.log(`  FAIL: ${msg}`);
  }
}
function eq(actual: unknown, expected: unknown, msg: string) {
  ok(actual === expected, `${msg} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}
function section(name: string) {
  console.log(`\n=== ${name} ===`);
}

// Asserts the message list satisfies the Anthropic contract we depend on:
// non-empty, first turn is user, strictly alternating roles.
function assertAlternates(out: ChatMessage[], label: string) {
  ok(out.length > 0, `${label}: non-empty`);
  eq(out[0]?.role, "user", `${label}: first turn is user`);
  let alt = true;
  for (let i = 1; i < out.length; i++) {
    if (out[i].role === out[i - 1].role) {
      alt = false;
      break;
    }
  }
  ok(alt, `${label}: strictly alternates user/assistant`);
}

// Index of the first turn whose content contains `needle` (-1 if none).
function find(out: ChatMessage[], needle: string): number {
  return out.findIndex((m) => m.content.includes(needle));
}

// ---- fixture builders -----------------------------------------------------

function userMsg(content: string): ChatMessage {
  return { role: "user", content };
}
function questionMsg(question: string): ChatMessage {
  return {
    role: "assistant",
    content: JSON.stringify({ kind: "question", question, diagnosis: null }),
  };
}
function diagnosisMsg(root_cause: string, urgency = "medium"): ChatMessage {
  return {
    role: "assistant",
    content: JSON.stringify({
      kind: "diagnosis",
      question: null,
      diagnosis: {
        root_cause,
        reasoning: "Consistent with the captured evidence.",
        urgency,
        safety_warnings: [],
        relevant_recall_campaigns: [],
        relevant_tsb_numbers: [],
      },
    }),
  };
}

function captureAssessment(
  leadName: string,
  confidence: string,
  why: string,
): DiagnosticAssessment {
  return {
    presenting_complaint: "cold start rough idle",
    stance: "AUTOPILOT",
    stance_reason: "fault lives in the data",
    hypotheses: [
      { name: leadName, confidence, supporting_evidence: [why], contradicting_evidence: [] },
    ],
    next_step: {
      action: "capture engine RPM during cold idle",
      rationale: "characterize the instability while cold",
      type: "DATA_CAPTURE",
      requested_data: [
        {
          signal_id: "RPM",
          operating_condition: "cold idle, ECT below 30C",
          duration_seconds: 90,
          capture_plan: {
            context_gate: [{ signal_id: "ECT", range: { min: null, max: 30, unit: "degC" } }],
            measured_target: { signal_id: "RPM", range: { min: null, max: 700, unit: "rpm" } },
            sustained_seconds: 3,
            capture_window_seconds: 90,
          },
        },
      ],
    },
    data_ceiling_note: "",
    unverified_specs_needed: [],
  } as unknown as DiagnosticAssessment;
}

function concludeAssessment(leadName: string, why: string): DiagnosticAssessment {
  return {
    presenting_complaint: "cold start rough idle",
    stance: "GUIDED",
    stance_reason: "physical confirmation needed",
    hypotheses: [
      { name: leadName, confidence: "STRONGLY_SUPPORTED", supporting_evidence: [why], contradicting_evidence: [] },
    ],
    next_step: {
      action: "inspect the suspect injector / glow-plug circuit",
      rationale: "confirm before parts",
      type: "PHYSICAL_INSPECTION",
    },
    data_ceiling_note: "",
    unverified_specs_needed: [],
  } as unknown as DiagnosticAssessment;
}

function captureEntry(targetVal: number, avg: number): EvidenceCaptureEntry {
  return {
    capturedAt: "2026-06-14T10:00:02.000Z",
    requested: [],
    operatingCondition: "COLD_START",
    observed: {
      capturedAt: 0,
      durationMs: 90000,
      operatingCondition: "COLD_START",
      signals: [
        {
          name: "RPM",
          signalId: "RPM",
          averageValue: avg,
          minSample: 480,
          maxSample: 700,
          unit: "rpm",
          encodingMin: 0,
          encodingMax: 16383,
          category: "Engine",
          sampleCount: 90,
        },
      ],
      absentSignalNames: [],
      dtcs: [],
      pendingDtcs: [],
      permanentDtcs: [],
      freezeFrame: null,
    },
    outcome: "completed",
    trigger: {
      firedAt: "2026-06-14T10:00:02.000Z",
      firedItemIndex: 0,
      targetSignalId: "RPM",
      targetValueAtFire: targetVal,
      gateValuesAtFire: [{ signal_id: "ECT", value: 18, range: { min: null, max: 30, unit: "degC" } }],
      sustainedHeldMs: 3200,
    },
    unavailableSignals: [],
  } as unknown as EvidenceCaptureEntry;
}

const HA = (afterMessageIndex: number, completedAt: string, assessment: DiagnosticAssessment): HistoryAssessment => ({
  afterMessageIndex,
  completedAt,
  assessment,
});
const HC = (afterMessageIndex: number, capturedAt: string, entry: EvidenceCaptureEntry): HistoryCapture => ({
  afterMessageIndex,
  capturedAt,
  entry,
});

// ===========================================================================
// TEST 1 — full multi-turn case:
//   ask → assessment+capture → captured result → evolved assessment+capture →
//   captured result → conclude (strongly-supported)
// ===========================================================================
section("multi-turn case (ask -> assess+capture -> result -> evolved -> conclude)");
{
  const messages: ChatMessage[] = [
    userMsg("Cold start rough idle, smooths out when warm. No codes."), // 0
    questionMsg("Any white smoke on cold start?"), // 1
    userMsg("Yeah, white smoke for the first minute or so."), // 2
  ];
  // All assessments + captures anchor after the last chat message (the capture
  // loop runs with no new chat turns), interleaved by timestamp.
  const assessments: HistoryAssessment[] = [
    HA(2, "2026-06-14T10:00:01.000Z", captureAssessment("glow-plug fault", "POSSIBLE", "white smoke on cold start")),
    HA(2, "2026-06-14T10:00:03.000Z", captureAssessment("injector balance fault", "LIKELY", "RPM instability persisted while cold")),
    HA(2, "2026-06-14T10:00:05.000Z", concludeAssessment("injector balance fault", "second capture isolated cylinder contribution")),
  ];
  const captures: HistoryCapture[] = [
    HC(2, "2026-06-14T10:00:02.000Z", captureEntry(600, 590)),
    HC(2, "2026-06-14T10:00:04.000Z", captureEntry(610, 605)),
  ];

  const out = buildTurnHistory(messages, assessments, captures);

  eq(out.length, 8, "produces 8 ordered turns");
  assertAlternates(out, "multi-turn");

  // The question turn renders as PLAIN TEXT, never raw JSON.
  ok(find(out, "Any white smoke") >= 0, "question text present");
  ok(out.every((m) => !m.content.includes('"kind"')), "no raw AssistantTurn JSON leaks into history");

  // Captured evidence renders as USER turns with the averaged facts.
  const cap1 = find(out, "[Captured evidence]");
  ok(cap1 >= 0 && out[cap1].role === "user", "captured evidence is a user turn");
  ok(find(out, "avg 590") >= 0, "averaged signal value present (590)");
  ok(find(out, "Sustained 3s") >= 0, "sustained-hold duration present");

  // Assessment turns render as ASSISTANT turns with lead + confidence + move.
  ok(find(out, "[Assessment]") >= 0, "assessment marker present");
  ok(find(out, "glow-plug fault (POSSIBLE)") >= 0, "first lead + confidence present");
  ok(find(out, "live capture") >= 0, "capture-request move described");
  ok(find(out, "RPM <=700rpm while ECT <=30degC, sustained 3s") >= 0, "capture plan rendered in raw units");

  // Coherent NARRATIVE ORDER: glow-plug (possible) → 1st capture → injector
  // (likely) → 2nd capture → injector (strongly supported, conclude).
  const iGlow = find(out, "glow-plug fault (POSSIBLE)");
  const iCap1 = find(out, "avg 590");
  const iInjLikely = find(out, "injector balance fault (LIKELY)");
  const iConclude = find(out, "injector balance fault (STRONGLY_SUPPORTED)");
  ok(
    iGlow < iCap1 && iCap1 < iInjLikely && iInjLikely < iConclude,
    "turns are in true case order (hypothesis evolves after each capture)",
  );
  ok(find(out, "physical inspection") >= 0, "conclusion's next move (physical inspection) present");
}

// ===========================================================================
// TEST 2 — resumed MID-SEQUENCE: the case was saved after the first capture
// (before the evolved assessment). buildTurnHistory runs on the restored
// (partial) arrays and must still produce a coherent, alternating history that
// the next /api/diagnose-turn call can reason on.
// ===========================================================================
section("resumed mid-sequence (saved after first capture, before evolution)");
{
  const messages: ChatMessage[] = [
    userMsg("Cold start rough idle, smooths out when warm. No codes."), // 0
    questionMsg("Any white smoke on cold start?"), // 1
    userMsg("Yeah, white smoke for the first minute or so."), // 2
  ];
  const assessments: HistoryAssessment[] = [
    HA(2, "2026-06-14T10:00:01.000Z", captureAssessment("glow-plug fault", "POSSIBLE", "white smoke on cold start")),
  ];
  const captures: HistoryCapture[] = [
    HC(2, "2026-06-14T10:00:02.000Z", captureEntry(600, 590)),
  ];

  const out = buildTurnHistory(messages, assessments, captures);

  eq(out.length, 5, "resumed partial case → 5 ordered turns");
  assertAlternates(out, "resumed");
  // The last thing the brain sees is the captured evidence (a user turn) — so
  // the next turn it produces is its read of that evidence. Coherent resume.
  eq(out[out.length - 1].role, "user", "last turn is the captured evidence (awaiting the brain's read)");
  ok(find(out, "[Captured evidence]") >= 0, "captured facts survive the resume");
  ok(find(out, "glow-plug fault (POSSIBLE)") >= 0, "prior assessment survives the resume");
}

// ===========================================================================
// TEST 3 — coalescing: two adjacent assessments with NO capture between them
// (e.g. a re-run) must merge into one assistant turn so alternation holds.
// ===========================================================================
section("alternation safety: adjacent same-role turns coalesce");
{
  const messages: ChatMessage[] = [userMsg("Rough idle, no codes.")]; // 0
  const assessments: HistoryAssessment[] = [
    HA(0, "2026-06-14T10:00:01.000Z", captureAssessment("glow-plug fault", "POSSIBLE", "first read")),
    HA(0, "2026-06-14T10:00:02.000Z", concludeAssessment("injector balance fault", "re-run conclusion")),
  ];
  const out = buildTurnHistory(messages, assessments, []);

  eq(out.length, 2, "two adjacent assistant assessments coalesce to one turn");
  assertAlternates(out, "coalesce");
  ok(
    out[1].content.includes("glow-plug fault") && out[1].content.includes("injector balance fault"),
    "both assessments preserved in the coalesced turn",
  );
}

// ===========================================================================
// TEST 4 — committed diagnosis message renders as readable prose, not JSON.
// ===========================================================================
section("committed diagnosis serialization");
{
  const messages: ChatMessage[] = [
    userMsg("Stalls at idle when warm."), // 0
    diagnosisMsg("Failed glow plugs (bank 1)", "high"), // 1
  ];
  const out = buildTurnHistory(messages, [], []);
  eq(out.length, 2, "two turns");
  assertAlternates(out, "diagnosis");
  ok(find(out, "Committed diagnosis: Failed glow plugs (bank 1)") >= 0, "diagnosis root cause as prose");
  ok(find(out, "urgency: high") >= 0, "diagnosis urgency present");
  ok(out.every((m) => !m.content.includes('"root_cause"')), "no raw diagnosis JSON leaks");
}

// ===========================================================================
// TEST 5 — disconnected conversational thread (no assessments/captures).
// ===========================================================================
section("conversational-only thread (disconnected)");
{
  const messages: ChatMessage[] = [
    userMsg("Squealing noise on startup."), // 0
    questionMsg("Does it go away after a minute or stay?"), // 1
    userMsg("Goes away after about 30 seconds."), // 2
  ];
  const out = buildTurnHistory(messages, [], []);
  eq(out.length, 3, "pure conversation passes through 1:1");
  assertAlternates(out, "conversational");
  ok(find(out, "Does it go away") >= 0, "question rendered as text");
}

// ===========================================================================
// SUMMARY
// ===========================================================================

console.log(`\n${"=".repeat(48)}`);
if (failed === 0) {
  console.log(`[turn-history-test] ALL ${passed} PASSED`);
} else {
  console.log(`[turn-history-test] ${failed} FAILED, ${passed} passed`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
