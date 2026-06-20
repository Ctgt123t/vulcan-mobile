import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import {
  type ConfidenceLevel,
  type DecisiveReason,
  type DiagnosticAssessment,
  type Hypothesis,
  type RequestedDataItem,
  type Stance,
} from "../../lib/assessmentTypes";
import { colors } from "../../lib/theme";

// ============================================================================
// Shared presentational primitives for the diagnostic card restructure.
//
// These were previously file-local helpers inside AssessmentResult.tsx (the old
// monolithic per-turn card). They are lifted here so the slim in-thread
// next-step bubble (NextStepBlock) can reuse them. (An earlier iteration also
// fed a persistent CasePanel above the thread; that panel was removed after
// shop testing — its stance/differential/verify content now lives entirely in
// the bubble's reasoning drawers.) Pure presentation — no state beyond local
// expand/collapse, no data fetching, no business logic.
// ============================================================================

export function StanceBanner({
  stance,
  reason,
}: {
  stance: Stance;
  reason: string;
}) {
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

export function ConfidenceChip({ level }: { level: ConfidenceLevel }) {
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

export function NextStepTypeBadge({ type }: { type: string }) {
  const label =
    type === "DATA_CAPTURE"
      ? "Data Capture"
      : type === "PHYSICAL_INSPECTION"
        ? "Physical Inspection"
        : type === "PULL_CODES"
          ? "Code Scan"
          : "Question";
  const palette =
    type === "DATA_CAPTURE"
      ? { bg: colors.accentFade, text: colors.accent }
      : type === "PHYSICAL_INSPECTION"
        ? { bg: colors.warnBg, text: colors.warnText }
        : type === "PULL_CODES"
          ? { bg: colors.accentFade, text: colors.accent }
          : { bg: colors.surface2, text: colors.muted };
  return (
    <View style={[styles.typeBadge, { backgroundColor: palette.bg }]}>
      <Text style={[styles.typeBadgeText, { color: palette.text }]}>{label}</Text>
    </View>
  );
}

export function EvidenceList({
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

// A single ranked hypothesis row with tap-to-expand evidence. Used by both the
// persistent panel's differential and the bubble's full-evidence drawer.
export function HypothesisCard({
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

// A quiet collapsible disclosure (e.g. "Why this step", "See full evidence").
// Optional `cue` renders a small marker on the toggle row (e.g. a verify icon)
// so the tech has a visible signal to open it without an always-on banner.
export function Drawer({
  label,
  children,
  defaultOpen = false,
  cue,
}: {
  label: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  cue?: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <View style={styles.drawer}>
      <TouchableOpacity
        style={styles.drawerToggle}
        onPress={() => setOpen((o) => !o)}
        activeOpacity={0.6}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ expanded: open }}
      >
        <Text style={styles.drawerChev}>{open ? "▾" : "▸"}</Text>
        <Text style={styles.drawerLabel}>{label}</Text>
        {cue}
      </TouchableOpacity>
      {open && <View style={styles.drawerBody}>{children}</View>}
    </View>
  );
}

// Small inline cue for the "Why this step" toggle row, shown when the turn has
// unverified specs to verify. Minimal by design (icon + short caption, no
// background strip) — it just signals "open me, there's a safety note inside".
export function VerifyCue() {
  return (
    <View style={styles.verifyCue}>
      <Ionicons name="warning-outline" size={12} color={colors.infoText} />
      <Text style={styles.verifyCueText}>VERIFY</Text>
    </View>
  );
}

// Compact "signals to capture" summary for a DATA_CAPTURE next step (the chip-
// level detail under the action in the slim bubble).
export function RequestedDataSummary({ items }: { items: RequestedDataItem[] }) {
  if (!items || items.length === 0) return null;
  return (
    <View style={styles.requestedDataBox}>
      <Text style={styles.requestedDataLabel}>SIGNALS TO CAPTURE</Text>
      {items.map((rd, i) => (
        <View key={i} style={styles.requestedDataRow}>
          <Text style={styles.requestedDataSignal}>{rd.signal_id}</Text>
          <Text style={styles.requestedDataDetail}>
            {rd.operating_condition} · {rd.duration_seconds}s
          </Text>
        </View>
      ))}
    </View>
  );
}

// The always-visible "verify against service info" / unverified-spec flag.
// Shared so the persistent panel renders it identically to the old card. This
// is a SAFETY warning (don't trust an unverified number), not reasoning.
export function VerifySpecs({
  specs,
}: {
  specs: DiagnosticAssessment["unverified_specs_needed"];
}) {
  if (!specs || specs.length === 0) return null;
  return (
    <View style={[styles.card, styles.unverifiedCard]}>
      <View style={styles.iconHeader}>
        <Ionicons name="book-outline" size={15} color={colors.infoText} />
        <Text style={[styles.cardLabel, { color: colors.infoText }]}>
          VERIFY AGAINST SERVICE INFO
        </Text>
      </View>
      <Text style={styles.unverifiedIntro}>
        Claude needed these factory values but they were not in the verified
        data. Confirm them in your service manual before acting on any
        recommendation that depends on them.
      </Text>
      {specs.map((s, i) => (
        <View key={i} style={styles.unverifiedRow}>
          <Text style={styles.unverifiedParam}>{s.parameter}</Text>
          <Text style={styles.unverifiedPurpose}>{s.purpose}</Text>
        </View>
      ))}
    </View>
  );
}

// The curated 2–3 decisive reasons behind the leading hypothesis (step 2). Each
// renders with a +/− marker (supports vs doubt), reusing the EvidenceList row
// styling for visual consistency.
function DecisiveReasons({ reasons }: { reasons: DecisiveReason[] }) {
  return (
    <View style={styles.whyLeading}>
      <Text style={styles.whyLeadingLabel}>Most decisive</Text>
      <View style={styles.evidenceSection}>
        {reasons.map((r, i) => (
          <View key={i} style={styles.evidenceRow}>
            <Text style={r.supports ? styles.evidencePlus : styles.evidenceMinus}>
              {r.supports ? "+" : "−"}
            </Text>
            <Text
              style={[
                styles.evidenceText,
                !r.supports && { color: colors.muted },
              ]}
            >
              {r.point}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

// The slim in-thread bubble body for an assessment turn: the next step + type
// chip + ONE reasoning entry point ("Why this step") with full evidence nested
// inside it. This is the sole home for the reasoning now (the persistent panel
// was removed).
//
//  - "Why this step" (collapsed by default; shows a small VERIFY cue on its
//    toggle row when there are unverified specs):
//      • the verify-against-service-info flag at the TOP (when present) — a
//        SAFETY warning, kept prominent within the drawer;
//      • next_step.rationale + the curated decisive_reasons (step 2). When the
//        field is absent/empty (older saved cases, the /api/assess path, or a
//        turn the brain omitted it) it FALLS BACK to the LEADING hypothesis's
//        evidence stand-in (or just the rationale);
//      • "See full evidence" — a deeper disclosure NESTED beneath, holding
//        all-hypotheses supporting/against lists + the data_ceiling_note.
export function NextStepBlock({
  assessment,
}: {
  assessment: DiagnosticAssessment;
}) {
  const ns = assessment.next_step;
  const leading = assessment.hypotheses[0] ?? null;
  const specs = assessment.unverified_specs_needed ?? [];
  const hasSpecs = specs.length > 0;
  // Step 2: the curated decisive reasons. Defensive read — older saved cases,
  // the /api/assess path, and turns the brain omitted it all lack the field;
  // drop any malformed/empty entries. When none remain, fall back to the prior
  // leading-hypothesis evidence stand-in (or just the rationale).
  const decisive = (assessment.decisive_reasons ?? []).filter(
    (r) => r && typeof r.point === "string" && r.point.trim().length > 0,
  );
  const hasDecisive = decisive.length > 0;
  const hasFullEvidence =
    assessment.hypotheses.length > 0 || assessment.data_ceiling_note.length > 0;

  return (
    <View style={[styles.card, styles.nextStepCard]}>
      <View style={styles.nextStepHeader}>
        <Text style={styles.cardLabel}>NEXT STEP</Text>
        <NextStepTypeBadge type={ns.type} />
      </View>
      <Text style={styles.nextStepAction}>{ns.action}</Text>
      {ns.type === "DATA_CAPTURE" &&
      ns.requested_data &&
      ns.requested_data.length > 0 ? (
        <RequestedDataSummary items={ns.requested_data} />
      ) : null}

      {/* The single reasoning entry point. The verify-against-service-info flag
          (a SAFETY warning) sits at the TOP of the expanded content, with a
          small VERIFY cue on the toggle row so the tech knows to open it. Full
          evidence is a deeper disclosure nested one level beneath. */}
      <Drawer label="Why this step" cue={hasSpecs ? <VerifyCue /> : undefined}>
        {hasSpecs && <VerifySpecs specs={specs} />}
        <Text style={styles.nextStepRationale}>{ns.rationale}</Text>
        {hasDecisive ? (
          <DecisiveReasons reasons={decisive} />
        ) : (
          leading && (
            <View style={styles.whyLeading}>
              <Text style={styles.whyLeadingLabel}>{leading.name}</Text>
              <EvidenceList
                supporting={leading.supporting_evidence}
                contradicting={leading.contradicting_evidence}
              />
            </View>
          )
        )}

        {hasFullEvidence && (
          <Drawer label="See full evidence">
            {assessment.hypotheses.map((h, i) => (
              <View key={i} style={styles.fullEvItem}>
                <View style={styles.fullEvHeader}>
                  <Text style={styles.hypothesisRank}>{i + 1}</Text>
                  <Text style={styles.hypothesisName}>{h.name}</Text>
                  <ConfidenceChip level={h.confidence} />
                </View>
                <View style={styles.fullEvBody}>
                  <EvidenceList
                    supporting={h.supporting_evidence}
                    contradicting={h.contradicting_evidence}
                  />
                </View>
              </View>
            ))}
            {assessment.data_ceiling_note.length > 0 && (
              <View style={[styles.card, styles.ceilingCard]}>
                <View style={styles.iconHeader}>
                  <Ionicons
                    name="layers-outline"
                    size={15}
                    color={colors.warnText}
                  />
                  <Text style={[styles.cardLabel, { color: colors.warnText }]}>
                    OBD2 DATA CEILING
                  </Text>
                </View>
                <Text style={styles.ceilingText}>
                  {assessment.data_ceiling_note}
                </Text>
              </View>
            )}
          </Drawer>
        )}
      </Drawer>
    </View>
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
  iconHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
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
  // Next-step type badge
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
  // Drawer (collapsible disclosure)
  drawer: {
    gap: 8,
  },
  drawerToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 4,
  },
  drawerChev: {
    fontSize: 13,
    color: colors.accent,
    width: 12,
  },
  drawerLabel: {
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.3,
    color: colors.accent,
  },
  verifyCue: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    marginLeft: 6,
  },
  verifyCueText: {
    fontSize: 9,
    fontWeight: "800",
    letterSpacing: 0.5,
    color: colors.infoText,
  },
  drawerBody: {
    gap: 10,
    paddingLeft: 2,
  },
  // Next-step card
  nextStepCard: {
    borderColor: colors.accent,
    backgroundColor: colors.surface,
  },
  nextStepHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
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
  whyLeading: {
    gap: 6,
  },
  whyLeadingLabel: {
    fontSize: 12,
    fontWeight: "700",
    color: colors.heading,
    lineHeight: 17,
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
  // Full-evidence drawer items
  fullEvItem: {
    gap: 8,
  },
  fullEvHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
  },
  fullEvBody: {
    paddingLeft: 24,
  },
  // Data ceiling card
  ceilingCard: {
    borderColor: colors.warnBorder,
    backgroundColor: colors.warnBg,
  },
  ceilingText: {
    fontSize: 13,
    color: colors.warnText,
    lineHeight: 19,
  },
  // Unverified specs / verify-against-service-info card
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
});
