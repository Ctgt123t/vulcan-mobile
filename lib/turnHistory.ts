// ============================================================================
// Thread → conversation-history serialization (Stage 2C-4 SB4).
//
// The unified brain (/api/diagnose-turn) sees ONE coherent, compact textual
// narrative of the case so far — never raw structured objects (bloat + worse
// reasoning), never dropped (the brain would forget it already ran a capture
// and re-ask). This transform turns the phone's three thread arrays (chat
// messages + assessment turns + captured-evidence results) into a single,
// time-ordered, alternating ChatMessage[] — exactly what a tech would remember
// about the case: what was said, what the brain concluded, what it asked for,
// and what came back.
//
// PURE module (type-only imports), so it's node-testable and turnHistory.test.ts
// is a hard gate — same discipline as dtcParser.ts / diagnosticCasesCore.ts.
//
// Captured-evidence results serialize as USER turns (they ARE new information
// coming in) — which also keeps the user/assistant alternation valid between a
// capture-requesting assessment and its evolved assessment.
// ============================================================================

import type { ChatMessage, FinalDiagnosis } from "./types";
import type {
  DiagnosticAssessment,
  NumericRange,
} from "./assessmentTypes";
import type { EvidenceCaptureEntry } from "./diagnosticCasesCore";

// One assessment turn, with the ordering metadata the thread already holds
// (afterMessageIndex anchors it after a chat message; completedAt orders it
// within that anchor against captures).
export interface HistoryAssessment {
  afterMessageIndex: number;
  completedAt: string; // ISO
  assessment: DiagnosticAssessment;
}

// One captured-evidence result, with the same ordering metadata.
export interface HistoryCapture {
  afterMessageIndex: number;
  capturedAt: string; // ISO
  entry: EvidenceCaptureEntry;
}

function rangeStr(r: NumericRange | undefined): string {
  if (!r) return "any";
  const u = r.unit ?? "";
  if (r.min != null && r.max != null) return `${r.min}-${r.max}${u}`;
  if (r.min != null) return `>=${r.min}${u}`;
  if (r.max != null) return `<=${r.max}${u}`;
  return "any";
}

function serializeDiagnosis(d: FinalDiagnosis): string {
  const parts = [`Committed diagnosis: ${d.root_cause}.`];
  if (d.reasoning) parts.push(d.reasoning);
  if (d.urgency) parts.push(`(urgency: ${d.urgency})`);
  return parts.join(" ");
}

// Compact one-line-ish summary of a structured assessment turn: leading
// hypothesis + confidence, the top supporting line, and the move it made
// (capture request / physical / question / conclusion).
export function serializeAssessment(a: DiagnosticAssessment): string {
  const parts = [`[Assessment] Stance ${a.stance}.`];
  const lead = a.hypotheses?.[0];
  if (lead) parts.push(`Leading: ${lead.name} (${lead.confidence}).`);
  if (lead?.supporting_evidence?.[0]) parts.push(`Why: ${lead.supporting_evidence[0]}`);
  const ns = a.next_step;
  if (ns) {
    if (ns.type === "DATA_CAPTURE" && ns.requested_data && ns.requested_data.length > 0) {
      const item = ns.requested_data[0];
      const cp = item.capture_plan;
      let cap: string;
      if (cp) {
        const gate = cp.context_gate
          .map((g) => `${g.signal_id} ${rangeStr(g.range)}`)
          .join(", ");
        cap =
          `${cp.measured_target.signal_id} ${rangeStr(cp.measured_target.range)}` +
          (gate ? ` while ${gate}` : "") +
          `, sustained ${cp.sustained_seconds}s`;
      } else {
        cap = `${item.signal_id} (${item.operating_condition})`;
      }
      parts.push(`Next: requested a live capture — ${cap}.`);
    } else if (ns.type === "PHYSICAL_INSPECTION") {
      parts.push(`Next: physical inspection — ${ns.action}`);
    } else if (ns.type === "QUESTION") {
      parts.push(`Next: ${ns.action}`);
    } else {
      parts.push(`Next: ${ns.action}`);
    }
  }
  if (a.data_ceiling_note && a.data_ceiling_note.length > 0) {
    parts.push(`Data ceiling: ${a.data_ceiling_note}`);
  }
  return parts.join(" ");
}

// Compact summary of a captured-evidence result, reusing the averaged
// DiagnosticSnapshot (observed) the snapshot builder already produced + the
// fire-time trigger context. Never raw samples.
export function serializeCapture(entry: EvidenceCaptureEntry): string {
  const parts = ["[Captured evidence]"];
  const t = entry.trigger;
  if (t) {
    parts.push(
      `${t.targetSignalId} ${t.targetValueAtFire ?? "n/a"} at fire;`,
    );
  }
  const sigs = (entry.observed?.signals ?? []).map((s) => {
    const u = s.unit ? ` ${s.unit}` : "";
    const range =
      s.minSample !== s.maxSample ? ` (range ${s.minSample}-${s.maxSample})` : "";
    return `${s.name} avg ${s.averageValue}${u}${range}`;
  });
  if (sigs.length > 0) parts.push(`window: ${sigs.join("; ")}.`);
  if (t && typeof t.sustainedHeldMs === "number") {
    parts.push(`Sustained ${(t.sustainedHeldMs / 1000).toFixed(0)}s.`);
  }
  if (entry.unavailableSignals && entry.unavailableSignals.length > 0) {
    parts.push(
      `Unavailable: ${entry.unavailableSignals.map((u) => u.signal_id).join(", ")}.`,
    );
  }
  if (entry.outcome && entry.outcome !== "completed") {
    parts.push(`(capture ${entry.outcome})`);
  }
  return parts.join(" ");
}

function serializeMessage(m: ChatMessage): ChatMessage {
  if (m.role === "user") return { role: "user", content: m.content };
  // Assistant content is JSON AssistantTurn (question/diagnosis), as everywhere.
  try {
    const turn = JSON.parse(m.content);
    if (turn && turn.kind === "question" && typeof turn.question === "string") {
      return { role: "assistant", content: turn.question };
    }
    if (turn && turn.kind === "diagnosis" && turn.diagnosis) {
      return { role: "assistant", content: serializeDiagnosis(turn.diagnosis) };
    }
  } catch {
    // not JSON — fall through to raw
  }
  return { role: "assistant", content: m.content };
}

// Coalesce adjacent same-role turns into one (joined) so the sequence strictly
// alternates user/assistant — the Anthropic message contract. (E.g. two
// assistant assessments with no capture between them merge into one.)
function coalesce(msgs: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of msgs) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      last.content = `${last.content}\n\n${m.content}`;
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

// TERMINAL-USER GUARANTEE (load-bearing): the conversation sent to
// /api/diagnose-turn MUST end on a user turn — the model cannot prefill an
// assistant turn (a trailing assistant message is a hard 400). Most entry paths
// append a user message before the call, but a re-run (onRerunAssessment) fires
// with NO new user message, so the serialized tail is the prior assistant
// assessment. Drop trailing assistant turns until the last turn is a user turn.
// messages[0] is always the user complaint, so this can never empty the history;
// the result is "answer the last user input again" — the correct re-roll
// semantics for re-run. This is a guarantee across EVERY entry path, not a patch
// for the re-run case alone.
function endOnUserTurn(msgs: ChatMessage[]): ChatMessage[] {
  let end = msgs.length;
  while (end > 0 && msgs[end - 1].role === "assistant") end--;
  return end === msgs.length ? msgs : msgs.slice(0, end);
}

// Build the serialized conversation history the unified brain sees.
// Order = the thread order: chat messages by index, and after message i the
// assessments + captures anchored at i, merged by their timestamp (so a capture
// loop reads assessment → captured evidence → evolved assessment in true order).
// The diagnoseTurn client truncates this (first + last N) for compactness.
export function buildTurnHistory(
  messages: ChatMessage[],
  assessments: HistoryAssessment[],
  captures: HistoryCapture[],
): ChatMessage[] {
  interface Anchored {
    anchor: number;
    ts: string;
    msg: ChatMessage;
  }
  const anchored: Anchored[] = [];
  for (const a of assessments) {
    anchored.push({
      anchor: a.afterMessageIndex,
      ts: a.completedAt,
      msg: { role: "assistant", content: serializeAssessment(a.assessment) },
    });
  }
  for (const c of captures) {
    anchored.push({
      anchor: c.afterMessageIndex,
      ts: c.capturedAt,
      msg: { role: "user", content: serializeCapture(c.entry) },
    });
  }

  const emitAnchored = (i: number, out: ChatMessage[]) => {
    anchored
      .filter((e) => e.anchor === i)
      .sort((x, y) => x.ts.localeCompare(y.ts))
      .forEach((e) => out.push(e.msg));
  };

  const out: ChatMessage[] = [];
  messages.forEach((m, i) => {
    out.push(serializeMessage(m));
    emitAnchored(i, out);
  });
  // Defensive: anything anchored past the last message index (e.g. an anchor
  // set to messages.length) still renders, in timestamp order.
  anchored
    .filter((e) => e.anchor >= messages.length)
    .sort((x, y) => x.ts.localeCompare(y.ts))
    .forEach((e) => out.push(e.msg));

  // Coalesce to strict alternation, THEN guarantee the history ends on a user
  // turn (sendable to /api/diagnose-turn from every entry path, incl. re-run).
  return endOnUserTurn(coalesce(out));
}
