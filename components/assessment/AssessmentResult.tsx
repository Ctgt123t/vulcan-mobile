import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import {
  OPERATING_CONDITION_LABELS,
  type ConfidenceLevel,
  type DiagnosticAssessment,
  type Hypothesis,
  type OperatingCondition,
  type RequestedDataItem,
  type Stance,
} from "../../lib/assessmentTypes";
import { DEBUG_UI } from "../../lib/debug";
import { HIT_TARGET, colors } from "../../lib/theme";
import CaptureCard, { type CaptureCardState } from "./CaptureCard";

// Structured assessment result display — stance banner, leading hypothesis,
// next step, full differential, data ceiling, unverified specs. Extracted
// from the Smart Diagnose screen so the merged diagnostic mode can render
// an assessment as a card inside its conversation thread.

export default function AssessmentResult({
  assessment,
  onReset,
}: {
  assessment: DiagnosticAssessment;
  onReset?: () => void;
}) {
  const leading = assessment.hypotheses[0] ?? null;

  return (
    <>
      {/* Stance banner */}
      <StanceBanner stance={assessment.stance} reason={assessment.stance_reason} />

      {/* Leading hypothesis (prominent) */}
      {leading && (
        <View style={styles.card}>
          <Text style={styles.cardLabel}>LEADING HYPOTHESIS</Text>
          <View style={styles.leadingRow}>
            <Text style={styles.leadingName}>{leading.name}</Text>
            <ConfidenceChip level={leading.confidence} />
          </View>
          <EvidenceList
            supporting={leading.supporting_evidence}
            contradicting={leading.contradicting_evidence}
          />
        </View>
      )}

      {/* Next step — prominently displayed */}
      <View style={[styles.card, styles.nextStepCard]}>
        <View style={styles.nextStepHeader}>
          <Text style={styles.cardLabel}>NEXT STEP</Text>
          <NextStepTypeBadge type={assessment.next_step.type} />
        </View>
        <Text style={styles.nextStepAction}>{assessment.next_step.action}</Text>
        <Text style={styles.nextStepRationale}>{assessment.next_step.rationale}</Text>
        {assessment.next_step.type === "DATA_CAPTURE" &&
          assessment.next_step.requested_data &&
          assessment.next_step.requested_data.length > 0 && (
            <View style={styles.requestedDataBox}>
              <Text style={styles.requestedDataLabel}>SIGNALS TO CAPTURE</Text>
              {assessment.next_step.requested_data.map((rd, i) => (
                <View key={i} style={styles.requestedDataRow}>
                  <Text style={styles.requestedDataSignal}>{rd.signal_id}</Text>
                  <Text style={styles.requestedDataDetail}>
                    {rd.operating_condition} · {rd.duration_seconds}s
                  </Text>
                </View>
              ))}
            </View>
          )}
      </View>

      {/* Remaining hypotheses */}
      {assessment.hypotheses.length > 1 && (
        <View style={styles.card}>
          <Text style={styles.cardLabel}>DIFFERENTIAL</Text>
          {assessment.hypotheses.map((h, i) => (
            <HypothesisCard key={i} hypothesis={h} rank={i + 1} />
          ))}
        </View>
      )}

      {/* Data ceiling */}
      {assessment.data_ceiling_note.length > 0 && (
        <View style={[styles.card, styles.ceilingCard]}>
          <View style={styles.ceilingHeader}>
            <Ionicons name="layers-outline" size={15} color={colors.warnText} />
            <Text style={[styles.cardLabel, { color: colors.warnText }]}>
              OBD2 DATA CEILING
            </Text>
          </View>
          <Text style={styles.ceilingText}>{assessment.data_ceiling_note}</Text>
        </View>
      )}

      {/* Unverified specs needed */}
      {assessment.unverified_specs_needed.length > 0 && (
        <View style={[styles.card, styles.unverifiedCard]}>
          <View style={styles.ceilingHeader}>
            <Ionicons name="book-outline" size={15} color={colors.infoText} />
            <Text style={[styles.cardLabel, { color: colors.infoText }]}>
              VERIFY AGAINST SERVICE INFO
            </Text>
          </View>
          <Text style={styles.unverifiedIntro}>
            Claude needed these factory values but they were not in the verified data. Confirm them in your service manual before acting on any recommendation that depends on them.
          </Text>
          {assessment.unverified_specs_needed.map((s, i) => (
            <View key={i} style={styles.unverifiedRow}>
              <Text style={styles.unverifiedParam}>{s.parameter}</Text>
              <Text style={styles.unverifiedPurpose}>{s.purpose}</Text>
            </View>
          ))}
        </View>
      )}

      {/* Stage 2 capture-card placeholder — mocked states, dev/preview only.
          Lives here because this is its real future home: under a
          DATA_CAPTURE next step, driven by requested_data. */}
      {DEBUG_UI && (
        <CaptureCardDevPreview
          requestedData={
            assessment.next_step.type === "DATA_CAPTURE"
              ? (assessment.next_step.requested_data ?? [])
              : []
          }
        />
      )}

      {onReset && (
        <TouchableOpacity style={styles.resetBtn} onPress={onReset} activeOpacity={0.85}>
          <Ionicons name="refresh" size={16} color={colors.accent} />
          <Text style={styles.resetBtnText}>Run new assessment</Text>
        </TouchableOpacity>
      )}
    </>
  );
}

// Dev-only wrapper that drives CaptureCard with mocked states — tap to
// cycle waiting → capturing → complete. Renders on every assessment (with
// mock fallback values when the next step isn't DATA_CAPTURE) so the
// placeholder is always reachable for review. Removed when Stage 2's real
// capture executor starts driving the card.
const DEV_PREVIEW_STATES: CaptureCardState[] = [
  "waiting",
  "capturing",
  "complete",
];

function CaptureCardDevPreview({
  requestedData,
}: {
  requestedData: RequestedDataItem[];
}) {
  const [stateIndex, setStateIndex] = useState(0);
  const state = DEV_PREVIEW_STATES[stateIndex];

  const first = requestedData[0] ?? null;
  const conditionLabel = first
    ? (OPERATING_CONDITION_LABELS[first.operating_condition as OperatingCondition] ??
      first.operating_condition)
    : "Warm Idle";
  const signalIds = first
    ? requestedData.map((rd) => rd.signal_id)
    : ["RPM", "STFT_B1", "O2_B1S1"];
  const durationSeconds = first ? first.duration_seconds : 30;

  return (
    <TouchableOpacity
      activeOpacity={0.8}
      onPress={() => setStateIndex((i) => (i + 1) % DEV_PREVIEW_STATES.length)}
      accessibilityRole="button"
      accessibilityLabel="Capture card preview — tap to cycle states"
    >
      <View style={styles.devPreviewWrap}>
        <Text style={styles.devPreviewLabel}>
          DEV PREVIEW · STAGE 2 CAPTURE CARD · TAP TO CYCLE
        </Text>
        <CaptureCard
          state={state}
          conditionLabel={conditionLabel}
          signalIds={signalIds}
          durationSeconds={durationSeconds}
          progress={state === "capturing" ? 0.4 : undefined}
          onCancel={state !== "complete" ? () => {} : undefined}
        />
      </View>
    </TouchableOpacity>
  );
}

function StanceBanner({ stance, reason }: { stance: Stance; reason: string }) {
  const isAutopilot = stance === "AUTOPILOT";
  return (
    <View
      style={[
        styles.stanceBanner,
        isAutopilot ? styles.stanceAutopilot : styles.stanceGuided,
      ]}
    >
      <View style={styles.stanceRow}>
        <Ionicons
          name={isAutopilot ? "analytics" : "hand-left-outline"}
          size={18}
          color={isAutopilot ? colors.accent : colors.warnText}
        />
        <Text
          style={[
            styles.stanceLabel,
            { color: isAutopilot ? colors.accent : colors.warnText },
          ]}
        >
          {stance === "AUTOPILOT" ? "AUTOPILOT" : "GUIDED"}
        </Text>
      </View>
      <Text style={styles.stanceReason}>{reason}</Text>
    </View>
  );
}

function ConfidenceChip({ level }: { level: ConfidenceLevel }) {
  const palette =
    level === "STRONGLY_SUPPORTED"
      ? { bg: colors.okBg, text: colors.okText }
      : level === "LIKELY"
        ? { bg: colors.warnBg, text: colors.warnText }
        : { bg: colors.surface2, text: colors.muted };

  const label =
    level === "STRONGLY_SUPPORTED"
      ? "Strongly Supported"
      : level === "LIKELY"
        ? "Likely"
        : "Possible";

  return (
    <View style={[styles.confidenceChip, { backgroundColor: palette.bg }]}>
      <Text style={[styles.confidenceChipText, { color: palette.text }]}>
        {label}
      </Text>
    </View>
  );
}

function NextStepTypeBadge({ type }: { type: string }) {
  const label =
    type === "DATA_CAPTURE"
      ? "Data Capture"
      : type === "PHYSICAL_INSPECTION"
        ? "Physical Inspection"
        : "Question";
  const palette =
    type === "DATA_CAPTURE"
      ? { bg: colors.accentFade, text: colors.accent }
      : type === "PHYSICAL_INSPECTION"
        ? { bg: colors.warnBg, text: colors.warnText }
        : { bg: colors.surface2, text: colors.muted };
  return (
    <View style={[styles.typeBadge, { backgroundColor: palette.bg }]}>
      <Text style={[styles.typeBadgeText, { color: palette.text }]}>{label}</Text>
    </View>
  );
}

function EvidenceList({
  supporting,
  contradicting,
}: {
  supporting: string[];
  contradicting: string[];
}) {
  return (
    <View style={styles.evidenceSection}>
      {supporting.length > 0 && (
        <View style={styles.evidenceGroup}>
          <Text style={styles.evidenceGroupLabel}>SUPPORTING</Text>
          {supporting.map((e, i) => (
            <View key={i} style={styles.evidenceRow}>
              <Text style={styles.evidencePlus}>+</Text>
              <Text style={styles.evidenceText}>{e}</Text>
            </View>
          ))}
        </View>
      )}
      {contradicting.length > 0 && (
        <View style={styles.evidenceGroup}>
          <Text style={[styles.evidenceGroupLabel, { color: colors.muted }]}>
            AGAINST
          </Text>
          {contradicting.map((e, i) => (
            <View key={i} style={styles.evidenceRow}>
              <Text style={styles.evidenceMinus}>−</Text>
              <Text style={[styles.evidenceText, { color: colors.muted }]}>{e}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

function HypothesisCard({
  hypothesis,
  rank,
}: {
  hypothesis: Hypothesis;
  rank: number;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <TouchableOpacity
      style={styles.hypothesisCard}
      onPress={() => setExpanded((e) => !e)}
      activeOpacity={0.8}
    >
      <View style={styles.hypothesisHeader}>
        <Text style={styles.hypothesisRank}>{rank}</Text>
        <Text style={styles.hypothesisName} numberOfLines={expanded ? undefined : 2}>
          {hypothesis.name}
        </Text>
        <ConfidenceChip level={hypothesis.confidence} />
        <Text style={styles.expandChev}>{expanded ? "▾" : "▸"}</Text>
      </View>
      {expanded && (
        <View style={styles.hypothesisBody}>
          <EvidenceList
            supporting={hypothesis.supporting_evidence}
            contradicting={hypothesis.contradicting_evidence}
          />
        </View>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 12,
    padding: 14,
    gap: 10,
  },
  cardLabel: {
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 1.6,
    color: colors.accent,
  },
  // Stance banner
  stanceBanner: {
    borderRadius: 12,
    padding: 14,
    gap: 6,
    borderWidth: StyleSheet.hairlineWidth,
  },
  stanceAutopilot: {
    backgroundColor: colors.accentFade,
    borderColor: colors.accent,
  },
  stanceGuided: {
    backgroundColor: colors.warnBg,
    borderColor: colors.warnBorder,
  },
  stanceRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  stanceLabel: {
    fontSize: 13,
    fontWeight: "800",
    letterSpacing: 1.5,
  },
  stanceReason: {
    fontSize: 13,
    color: colors.text,
    lineHeight: 18,
  },
  // Leading hypothesis
  leadingRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    flexWrap: "wrap",
  },
  leadingName: {
    flex: 1,
    fontSize: 17,
    fontWeight: "700",
    color: colors.heading,
    lineHeight: 23,
  },
  // Confidence chip
  confidenceChip: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    alignSelf: "flex-start",
  },
  confidenceChipText: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.3,
  },
  // Evidence
  evidenceSection: {
    gap: 10,
  },
  evidenceGroup: {
    gap: 5,
  },
  evidenceGroupLabel: {
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 1.4,
    color: colors.okText,
  },
  evidenceRow: {
    flexDirection: "row",
    gap: 8,
    paddingLeft: 2,
  },
  evidencePlus: {
    fontSize: 13,
    fontWeight: "700",
    color: colors.okText,
    width: 12,
    lineHeight: 19,
  },
  evidenceMinus: {
    fontSize: 15,
    fontWeight: "700",
    color: colors.muted,
    width: 12,
    lineHeight: 19,
  },
  evidenceText: {
    flex: 1,
    fontSize: 13,
    color: colors.text,
    lineHeight: 19,
  },
  // Next step card
  nextStepCard: {
    borderColor: colors.accent,
    backgroundColor: colors.surface,
  },
  nextStepHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  typeBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  typeBadgeText: {
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.5,
  },
  nextStepAction: {
    fontSize: 15,
    fontWeight: "700",
    color: colors.heading,
    lineHeight: 21,
  },
  nextStepRationale: {
    fontSize: 13,
    color: colors.text,
    lineHeight: 19,
  },
  requestedDataBox: {
    marginTop: 4,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    gap: 6,
  },
  requestedDataLabel: {
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 1.4,
    color: colors.accent,
    marginBottom: 2,
  },
  requestedDataRow: {
    gap: 2,
  },
  requestedDataSignal: {
    fontSize: 13,
    fontWeight: "700",
    color: colors.heading,
    fontFamily: "Menlo",
  },
  requestedDataDetail: {
    fontSize: 12,
    color: colors.muted,
  },
  // Hypothesis cards (differential list)
  hypothesisCard: {
    paddingVertical: 10,
    paddingHorizontal: 2,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    gap: 0,
  },
  hypothesisHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
  },
  hypothesisRank: {
    fontSize: 12,
    fontWeight: "700",
    color: colors.muted,
    width: 16,
    lineHeight: 22,
  },
  hypothesisName: {
    flex: 1,
    fontSize: 14,
    fontWeight: "600",
    color: colors.heading,
    lineHeight: 20,
  },
  expandChev: {
    fontSize: 16,
    color: colors.muted,
    lineHeight: 22,
  },
  hypothesisBody: {
    marginTop: 10,
    paddingLeft: 24,
  },
  // Data ceiling card
  ceilingCard: {
    borderColor: colors.warnBorder,
    backgroundColor: colors.warnBg,
  },
  ceilingHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  ceilingText: {
    fontSize: 13,
    color: colors.warnText,
    lineHeight: 19,
  },
  // Unverified specs card
  unverifiedCard: {
    borderColor: colors.infoBorder,
    backgroundColor: colors.infoBg,
  },
  unverifiedIntro: {
    fontSize: 12,
    color: colors.infoText,
    lineHeight: 17,
  },
  unverifiedRow: {
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.infoBorder,
    gap: 2,
  },
  unverifiedParam: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.infoText,
  },
  unverifiedPurpose: {
    fontSize: 12,
    color: colors.infoText,
    lineHeight: 17,
  },
  // Dev preview wrapper (capture-card placeholder)
  devPreviewWrap: {
    gap: 6,
  },
  devPreviewLabel: {
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 1.2,
    color: colors.muted,
  },
  // Reset button
  resetBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    minHeight: HIT_TARGET,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.accent,
    backgroundColor: colors.accentFade,
    paddingHorizontal: 20,
  },
  resetBtnText: {
    color: colors.accent,
    fontSize: 14,
    fontWeight: "600",
  },
});
