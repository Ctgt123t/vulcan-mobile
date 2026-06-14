// ============================================================================
// Thread → history serialization — NODE TEST GATE (Stage 2C-4 SB4 / DB-1).
//
// THE GATE for the unified flow's serialization. The unified brain only reasons
// well if buildTurnHistory produces a coherent, compact, strictly-alternating
// narrative — AND (DB-1, load-bearing) one that ENDS ON A USER TURN, because
// /api/diagnose-turn cannot accept a trailing assistant message (hard 400). The
// original gate validated coherence + alternation but NOT sendability, and it
// even ENCODED THE BUG AS CORRECT (it built an assistant-terminated history and
// asserted that length was valid). This rewrite is organized around EVERY
// runDiagnoseTurn ENTRY PATH and proves each one ends on a user turn — the same
// path-by-path discipline as the VIN-regression check.
//
// Entry paths (app/diagnose.tsx callers of runDiagnoseTurn):
//   A. onSubmitIntake     — opening turn, messages = [complaint]
//   B. sendUserMessage    — a tech message appended before the call
//   C. onRerunAssessment  — re-fire with NO new user turn (the crash path)
//        C1. fresh: thread ends on an assistant assessment
//        C2. resumed: restored thread ends on an assessment
//        C3. re-run after a capture: tail is the evolved assessment
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

// Non-empty, first turn user, strictly alternating roles.
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

// THE DB-1 INVARIANT: a sendable history ends on a user turn.
function assertEndsOnUser(out: ChatMessage[], label: string) {
  ok(out.length > 0, `${label}: non-empty (complaint always survives)`);
  eq(out[out.length - 1]?.role, "user", `${label}: ENDS ON A USER TURN (sendable)`);
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

// A common 3-message opening (complaint → question → answer), used by several
// entry-path cases.
const opening = (): ChatMessage[] => [
  userMsg("Cold start rough idle, smooths out when warm. No codes."), // 0
  questionMsg("Any white smoke on cold start?"), // 1
  userMsg("Yeah, white smoke for the first minute or so."), // 2
];

// ===========================================================================
// ENTRY PATH A — onSubmitIntake: the opening turn (messages = [complaint]).
// ===========================================================================
section("PATH A — onSubmitIntake (opening turn)");
{
  const out = buildTurnHistory([userMsg("Cold start rough idle, no codes.")], [], []);
  eq(out.length, 1, "opening turn = just the complaint");
  assertAlternates(out, "A");
  assertEndsOnUser(out, "A");
  ok(find(out, "rough idle") >= 0, "complaint present");
}

// ===========================================================================
// ENTRY PATH B — sendUserMessage: full multi-turn narrative, a tech message
// appended before the call. The rich coherence case — and it ends on the user.
// ===========================================================================
section("PATH B — sendUserMessage (full narrative, ends on the new user turn)");
{
  const messages: ChatMessage[] = [
    ...opening(),
    userMsg("Okay — what should I check or watch next?"), // 3 (the new tech message)
  ];
  // Assessments + captures from the capture loop anchored after the answer (msg 2).
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

  assertAlternates(out, "B");
  assertEndsOnUser(out, "B");
  ok(find(out, "what should I check") >= 0, "the new tech message is the final user turn");
  eq(out[out.length - 1].content.includes("what should I check"), true, "tail is the tech message (not trimmed)");

  // Coherent NARRATIVE ORDER (hypothesis evolves after each capture).
  ok(out.every((m) => !m.content.includes('"kind"')), "no raw AssistantTurn JSON leaks");
  ok(find(out, "Any white smoke") >= 0, "question rendered as text");
  ok(find(out, "[Captured evidence]") >= 0, "captured evidence present");
  ok(find(out, "avg 590") >= 0, "averaged value present");
  ok(find(out, "RPM <=700rpm while ECT <=30degC, sustained 3s") >= 0, "capture plan in raw units");
  const iGlow = find(out, "glow-plug fault (POSSIBLE)");
  const iCap1 = find(out, "avg 590");
  const iInjLikely = find(out, "injector balance fault (LIKELY)");
  const iConclude = find(out, "injector balance fault (STRONGLY_SUPPORTED)");
  ok(
    iGlow >= 0 && iGlow < iCap1 && iCap1 < iInjLikely && iInjLikely < iConclude,
    "turns are in true case order",
  );
}

// ===========================================================================
// ENTRY PATH C1 — onRerunAssessment, FRESH: the thread ends on an assistant
// assessment (the brain's last turn), and re-run fires with NO new user turn.
// THE CRASH CASE. The trailing assistant assessment MUST be trimmed so the
// history ends on a user turn.
// ===========================================================================
section("PATH C1 — re-run, fresh thread ending on an assessment (THE CRASH)");
{
  // Fresh connected session: complaint, then the brain's first turn was an
  // assessment (no question, no tech reply after).
  const messages: ChatMessage[] = [userMsg("Cold start rough idle, no codes.")]; // 0
  const assessments: HistoryAssessment[] = [
    HA(0, "2026-06-14T10:00:01.000Z", captureAssessment("glow-plug fault", "POSSIBLE", "cold-start white smoke")),
  ];
  const out = buildTurnHistory(messages, assessments, []);

  // Without the guarantee this was [user, assistant] → 400. Now trimmed.
  assertEndsOnUser(out, "C1");
  assertAlternates(out, "C1");
  eq(out.length, 1, "trailing assistant assessment trimmed → just the complaint");
  ok(find(out, "rough idle") >= 0, "complaint (the user turn the re-run answers) survives");
  ok(find(out, "[Assessment]") < 0, "the trailing assessment is dropped from the sent history");
}

// ===========================================================================
// ENTRY PATH C2 — onRerunAssessment, RESUMED: a restored thread (opening +
// one assessment, no trailing user) re-run. Same guarantee on restored input.
// ===========================================================================
section("PATH C2 — re-run a resumed case ending on an assessment");
{
  const messages = opening(); // [complaint, question, answer]
  const assessments: HistoryAssessment[] = [
    HA(2, "2026-06-14T10:00:01.000Z", captureAssessment("glow-plug fault", "POSSIBLE", "cold-start white smoke")),
  ];
  const out = buildTurnHistory(messages, assessments, []);

  assertEndsOnUser(out, "C2");
  assertAlternates(out, "C2");
  // [user(complaint), assistant(question), user(answer)] — the assessment tail trimmed.
  eq(out.length, 3, "assessment tail trimmed → ends on the tech's answer");
  eq(out[out.length - 1].content.includes("white smoke for the first minute"), true, "tail is the tech's answer");
}

// ===========================================================================
// ENTRY PATH C3 — onRerunAssessment AFTER A CAPTURE: tail is the evolved
// assessment; trimming it leaves the captured-evidence USER turn, so the re-run
// re-interprets the evidence. The capture facts must survive.
// ===========================================================================
section("PATH C3 — re-run after a capture (tail = evolved assessment)");
{
  const messages: ChatMessage[] = [userMsg("Cold start rough idle, no codes.")]; // 0
  const assessments: HistoryAssessment[] = [
    HA(0, "2026-06-14T10:00:01.000Z", captureAssessment("glow-plug fault", "POSSIBLE", "cold-start white smoke")),
    HA(0, "2026-06-14T10:00:03.000Z", captureAssessment("injector balance fault", "LIKELY", "RPM instability persisted cold")),
  ];
  const captures: HistoryCapture[] = [
    HC(0, "2026-06-14T10:00:02.000Z", captureEntry(600, 590)),
  ];
  const out = buildTurnHistory(messages, assessments, captures);

  assertEndsOnUser(out, "C3");
  assertAlternates(out, "C3");
  // [user(complaint), assistant(A1), user(capture), assistant(A2→trimmed)]
  eq(out.length, 3, "evolved-assessment tail trimmed → ends on the captured evidence");
  ok(out[out.length - 1].content.includes("[Captured evidence]"), "tail is the captured-evidence user turn");
  ok(find(out, "avg 590") >= 0, "the captured facts survive for re-interpretation");
}

// ===========================================================================
// resumed MID-SEQUENCE (saved after a capture, before the evolved assessment):
// already ends on a capture (user) — no trim needed; still must be sendable.
// ===========================================================================
section("resumed mid-sequence (ends on a capture; no trim)");
{
  const messages = opening();
  const assessments: HistoryAssessment[] = [
    HA(2, "2026-06-14T10:00:01.000Z", captureAssessment("glow-plug fault", "POSSIBLE", "white smoke on cold start")),
  ];
  const captures: HistoryCapture[] = [
    HC(2, "2026-06-14T10:00:02.000Z", captureEntry(600, 590)),
  ];
  const out = buildTurnHistory(messages, assessments, captures);
  eq(out.length, 5, "no trim — capture is already the tail");
  assertAlternates(out, "resumed-mid");
  assertEndsOnUser(out, "resumed-mid");
  ok(find(out, "[Captured evidence]") >= 0, "captured facts present");
  ok(find(out, "glow-plug fault (POSSIBLE)") >= 0, "prior assessment present");
}

// ===========================================================================
// coalesce: two adjacent assistant assessments WITH a trailing user message
// merge into one assistant turn (alternation), and the history still ends on
// the user. (Tests coalesce without the terminal trim removing it.)
// ===========================================================================
section("coalesce adjacent assistant turns (with a trailing user turn)");
{
  const messages: ChatMessage[] = [
    userMsg("Rough idle, no codes."), // 0
    userMsg("Any other ideas?"), // 1 (a later tech message)
  ];
  const assessments: HistoryAssessment[] = [
    HA(0, "2026-06-14T10:00:01.000Z", captureAssessment("glow-plug fault", "POSSIBLE", "first read")),
    HA(0, "2026-06-14T10:00:02.000Z", concludeAssessment("injector balance fault", "re-run conclusion")),
  ];
  const out = buildTurnHistory(messages, assessments, []);
  // [user(complaint), assistant(A1+A2 coalesced), user("Any other ideas?")]
  eq(out.length, 3, "two adjacent assessments coalesce to one assistant turn");
  assertAlternates(out, "coalesce");
  assertEndsOnUser(out, "coalesce");
  ok(
    out[1].content.includes("glow-plug fault") && out[1].content.includes("injector balance fault"),
    "both assessments preserved in the coalesced turn",
  );
}

// ===========================================================================
// committed diagnosis: prose, not JSON. With a trailing user turn it survives;
// as a bare tail (re-run after a diagnosis) it trims to the prior user turn.
// ===========================================================================
section("committed diagnosis serialization");
{
  const withFollowup = buildTurnHistory(
    [userMsg("Stalls at idle when warm."), diagnosisMsg("Failed glow plugs (bank 1)", "high"), userMsg("Thanks — anything else?")],
    [],
    [],
  );
  assertAlternates(withFollowup, "diagnosis");
  assertEndsOnUser(withFollowup, "diagnosis");
  ok(find(withFollowup, "Committed diagnosis: Failed glow plugs (bank 1)") >= 0, "diagnosis root cause as prose");
  ok(find(withFollowup, "urgency: high") >= 0, "diagnosis urgency present");
  ok(withFollowup.every((m) => !m.content.includes('"root_cause"')), "no raw diagnosis JSON leaks");

  // Bare diagnosis tail (no trailing user) → trims to the complaint.
  const bare = buildTurnHistory([userMsg("Stalls at idle."), diagnosisMsg("Failed glow plugs", "high")], [], []);
  assertEndsOnUser(bare, "diagnosis-bare");
  eq(bare.length, 1, "bare diagnosis tail trims to the complaint");
}

// ===========================================================================
// conversational-only thread (disconnected): passes through, ends on the answer.
// ===========================================================================
section("conversational-only thread (disconnected)");
{
  const out = buildTurnHistory(
    [
      userMsg("Squealing noise on startup."),
      questionMsg("Does it go away after a minute or stay?"),
      userMsg("Goes away after about 30 seconds."),
    ],
    [],
    [],
  );
  eq(out.length, 3, "pure conversation passes through 1:1");
  assertAlternates(out, "conversational");
  assertEndsOnUser(out, "conversational");
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
