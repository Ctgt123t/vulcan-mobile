import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { HIT_TARGET, colors } from "../../lib/theme";

// Stage 2 capture-card primitive — PLACEHOLDER, presentational only.
// During Stage 2's auto-capture this card will show live state while the
// phone watches for an operating condition and captures the requested
// window ("Vulcan is watching for [condition]… capturing…"). No capture
// logic lives here: the component renders whatever state it is given, so
// Stage 2's executor can drive it without UI changes. Until then it is
// rendered with mocked states behind the DEBUG_UI flag (see lib/debug.ts).

export type CaptureCardState = "waiting" | "capturing" | "complete";

export default function CaptureCard({
  state,
  conditionLabel,
  signalIds,
  durationSeconds,
  progress,
  onCancel,
}: {
  state: CaptureCardState;
  conditionLabel: string;
  signalIds: string[];
  durationSeconds?: number;
  // 0–1, only meaningful while capturing.
  progress?: number;
  // Stage 2 wires this to abort the watch; no button renders when absent.
  onCancel?: () => void;
}) {
  const title =
    state === "waiting"
      ? `Watching for: ${conditionLabel}`
      : state === "capturing"
        ? `Capturing — ${conditionLabel}`
        : "Capture complete";

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

      {signalIds.length > 0 && (
        <View style={styles.signalRow}>
          {signalIds.map((id) => (
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
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 14,
    gap: 10,
    backgroundColor: colors.surface,
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
  signalRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  signalChip: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: colors.surface2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  signalChipText: {
    fontSize: 11,
    fontWeight: "600",
    color: colors.text,
    fontFamily: "Menlo",
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
