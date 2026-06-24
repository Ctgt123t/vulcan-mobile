import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import type { NumericRange } from "../../lib/assessmentTypes";
import type { ConditionReadout } from "../../lib/captureDetector";
import { HIT_TARGET, colors, fonts, radii } from "../../lib/theme";

// Stage 2 capture-card primitive — PLACEHOLDER, presentational only.
// During Stage 2's auto-capture this card will show live state while the
// phone watches for an operating condition and captures the requested
// window ("Vulcan is watching for [condition]… capturing…"). No capture
// logic lives here: the component renders whatever state it is given, so
// Stage 2's executor can drive it without UI changes. Until then it is
// rendered with mocked states behind the DEBUG_UI flag (see lib/debug.ts).

export type CaptureCardState = "waiting" | "capturing" | "complete";

// Format a target range for the WAITING readout: "600–900 rpm", "≥ 80 degC",
// "≤ 5 kPa" (Fix 2 — legible warm-up).
function formatRange(r: NumericRange): string {
  const u = r.unit ? ` ${r.unit}` : "";
  if (r.min != null && r.max != null) return `${r.min}–${r.max}${u}`;
  if (r.min != null) return `≥ ${r.min}${u}`;
  if (r.max != null) return `≤ ${r.max}${u}`;
  return "any";
}

export default function CaptureCard({
  state,
  conditionLabel,
  signalIds,
  recordedSignalIds,
  conditions,
  durationSeconds,
  progress,
  onCancel,
}: {
  state: CaptureCardState;
  conditionLabel: string;
  signalIds: string[];
  // The signals this capture RECORDS (shown as a distinct "Recording: …" line) —
  // separate from the arming conditions in conditionLabel/conditions.
  recordedSignalIds?: string[];
  // Fix 2: per-condition live readout (current vs target + met). When present,
  // the WAITING card shows it instead of bare signal chips.
  conditions?: ConditionReadout[];
  durationSeconds?: number;
  // 0–1, only meaningful while capturing.
  progress?: number;
  // Stage 2 wires this to abort the watch; no button renders when absent.
  onCancel?: () => void;
}) {
  const armingLabel = conditionLabel.trim();
  const title =
    state === "waiting"
      ? armingLabel
        ? `Watching for: ${armingLabel}`
        : "Watching for the capture condition"
      : state === "capturing"
        ? armingLabel
          ? `Capturing — ${armingLabel}`
          : "Capturing"
        : "Capture complete";
  // The recorded signals to surface separately. Fall back to signalIds.
  const recorded = (recordedSignalIds && recordedSignalIds.length > 0 ? recordedSignalIds : signalIds) ?? [];

  const subtitle =
    state === "waiting"
      ? "Capture starts automatically when the condition is detected."
      : state === "capturing"
        ? `Recording a ${durationSeconds ?? "—"}s window of the requested signals.`
        : "Evidence will be sent to Vulcan for an updated assessment.";

  return (
    <View
      style={[
        styles.card,
        state === "complete" ? styles.cardComplete : styles.cardActive,
      ]}
    >
      <View style={styles.headerRow}>
        <View style={styles.titleRow}>
          <Ionicons
            name={
              state === "waiting"
                ? "eye-outline"
                : state === "capturing"
                  ? "radio-button-on"
                  : "checkmark-circle"
            }
            size={18}
            color={state === "complete" ? colors.okText : colors.accent}
          />
          <Text style={styles.title}>{title}</Text>
        </View>
        <StatePill state={state} />
      </View>

      <Text style={styles.subtitle}>{subtitle}</Text>

      {state === "capturing" && (
        <View style={styles.progressTrack}>
          <View
            style={[
              styles.progressFill,
              { width: `${Math.round(Math.min(Math.max(progress ?? 0, 0), 1) * 100)}%` },
            ]}
          />
        </View>
      )}

      {/* Fix 2: live per-condition ARMING readout while waiting/capturing —
          current value → target band with a met (✓) state, so a warm-up wait
          reads as "almost there" rather than a dead spinner. Gates only. */}
      {state !== "complete" && conditions && conditions.length > 0 && (
        <View style={styles.conditionList}>
          {conditions.map((c, i) => (
            <View key={`${c.label}-${i}`} style={styles.conditionRow}>
              <Ionicons
                name={c.met ? "checkmark-circle" : "ellipse-outline"}
                size={14}
                color={c.met ? colors.okText : colors.muted}
              />
              <Text style={styles.conditionLabel}>{c.label}</Text>
              <Text
                style={[
                  styles.conditionValue,
                  c.met && { color: colors.okText },
                ]}
              >
                {c.current == null ? "—" : c.current}
              </Text>
              <Text style={styles.conditionArrow}>→</Text>
              <Text style={styles.conditionTarget}>{formatRange(c.range)}</Text>
            </View>
          ))}
        </View>
      )}

      {/* The signals being RECORDED — distinct from the arming conditions above.
          Always shown so it's clear what data the capture is collecting. */}
      {recorded.length > 0 && (
        <View style={styles.recordRow}>
          <Text style={styles.recordLabel}>Recording:</Text>
          {recorded.map((id) => (
            <View key={id} style={styles.signalChip}>
              <Text style={styles.signalChipText}>{id}</Text>
            </View>
          ))}
        </View>
      )}

      {onCancel && state !== "complete" && (
        <TouchableOpacity
          style={styles.cancelLink}
          onPress={onCancel}
          activeOpacity={0.6}
          accessibilityRole="button"
          accessibilityLabel="Stop watching"
        >
          <Text style={styles.cancelLinkText}>Stop watching</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

function StatePill({ state }: { state: CaptureCardState }) {
  const palette =
    state === "complete"
      ? { bg: colors.okBg, text: colors.okText }
      : state === "capturing"
        ? { bg: colors.warnBg, text: colors.warnText }
        : { bg: colors.accentFade, text: colors.accent };
  return (
    <View style={[styles.pill, { backgroundColor: palette.bg }]}>
      <Text style={[styles.pillText, { color: palette.text }]}>
        {state.toUpperCase()}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radii.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.glassRim,
    padding: 14,
    gap: 10,
    backgroundColor: colors.glassFill,
  },
  cardActive: {
    borderColor: colors.accent,
  },
  cardComplete: {
    borderColor: colors.okBorder,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexShrink: 1,
  },
  title: {
    fontSize: 14,
    fontWeight: "700",
    color: colors.heading,
    flexShrink: 1,
  },
  subtitle: {
    fontSize: 12,
    color: colors.muted,
    lineHeight: 17,
  },
  pill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  pillText: {
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.8,
  },
  progressTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.surface2,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    borderRadius: 3,
    backgroundColor: colors.accent,
  },
  // Fix 2 — per-condition readout rows
  conditionList: {
    gap: 6,
  },
  conditionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  conditionLabel: {
    fontSize: 12,
    fontWeight: "700",
    color: colors.text,
    fontFamily: fonts.mono,
    minWidth: 56,
  },
  conditionValue: {
    fontSize: 12,
    fontWeight: "700",
    color: colors.heading,
    fontFamily: fonts.mono,
  },
  conditionArrow: {
    fontSize: 12,
    color: colors.muted,
  },
  conditionTarget: {
    fontSize: 12,
    color: colors.muted,
    fontFamily: fonts.mono,
  },
  signalRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  recordRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 6,
  },
  recordLabel: {
    fontSize: 11,
    fontWeight: "700",
    color: colors.muted,
    letterSpacing: 0.4,
  },
  signalChip: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: radii.sm,
    backgroundColor: colors.steelChip,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.steelChipBorder,
  },
  signalChipText: {
    fontSize: 11,
    fontWeight: "600",
    color: colors.text,
    fontFamily: fonts.mono,
  },
  cancelLink: {
    alignSelf: "flex-start",
    minHeight: HIT_TARGET - 16,
    justifyContent: "center",
    paddingHorizontal: 2,
  },
  cancelLinkText: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: "600",
  },
});
