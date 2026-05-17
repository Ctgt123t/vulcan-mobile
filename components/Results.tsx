import { StyleSheet, Text, View } from "react-native";
import type { FinalDiagnosis } from "../lib/types";
import { colors } from "../lib/theme";

const URGENCY_STYLES: Record<
  FinalDiagnosis["urgency"],
  { bg: string; border: string; text: string }
> = {
  low: { bg: colors.okBg, border: colors.okBorder, text: colors.okText },
  medium: {
    bg: colors.warnBg,
    border: colors.warnBorder,
    text: colors.warnText,
  },
  high: {
    bg: colors.dangerBg,
    border: colors.dangerBorder,
    text: colors.dangerText,
  },
};

export default function Results({ data }: { data: FinalDiagnosis }) {
  const urgency = URGENCY_STYLES[data.urgency];

  return (
    <View style={styles.wrap}>
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>CONFIRMED DIAGNOSIS</Text>
        <Text style={styles.h2}>{data.root_cause}</Text>
        <Text style={styles.summary}>{data.reasoning}</Text>

        <View style={styles.badges}>
          <View
            style={[
              styles.badge,
              { backgroundColor: urgency.bg, borderColor: urgency.border },
            ]}
          >
            <Text style={[styles.badgeText, { color: urgency.text }]}>
              Urgency: {data.urgency}
            </Text>
          </View>
        </View>
      </View>

      {data.safety_warnings.length > 0 && (
        <View style={[styles.card, styles.safetyCard]}>
          <Text style={[styles.sectionTitle, styles.safetyTitle]}>
            SAFETY WARNINGS
          </Text>
          {data.safety_warnings.map((w, i) => (
            <View key={i} style={styles.warningRow}>
              <Text style={styles.warningBullet}>•</Text>
              <Text style={styles.warningText}>{w}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    gap: 10,
  },
  card: {
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 8,
    padding: 16,
  },
  safetyCard: {
    backgroundColor: colors.dangerBg,
    borderColor: colors.dangerBorder,
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1.5,
    color: colors.accent,
    marginBottom: 10,
  },
  safetyTitle: {
    color: colors.dangerText,
  },
  h2: {
    fontSize: 18,
    color: colors.heading,
    fontWeight: "600",
    marginBottom: 8,
  },
  summary: {
    fontSize: 14,
    color: colors.text,
    marginBottom: 16,
    lineHeight: 21,
  },
  badges: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  warningRow: {
    flexDirection: "row",
    marginBottom: 4,
    gap: 8,
  },
  warningBullet: {
    color: colors.dangerText,
    fontSize: 14,
    minWidth: 12,
  },
  warningText: {
    flex: 1,
    color: colors.dangerText,
    fontSize: 14,
    lineHeight: 21,
  },
});
