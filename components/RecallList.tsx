import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { HIT_TARGET, colors } from "../lib/theme";
import type { Recall } from "../lib/types";

type Props = {
  recalls: Recall[];
};

export default function RecallList({ recalls }: Props) {
  if (recalls.length === 0) return null;
  return (
    <View style={styles.wrap}>
      <View style={styles.headerRow}>
        <Text style={styles.headerText}>
          ACTIVE RECALLS · {recalls.length}
        </Text>
      </View>
      {recalls.map((r, i) => (
        <RecallCard key={r.campaignNumber || `recall-${i}`} recall={r} />
      ))}
    </View>
  );
}

function RecallCard({ recall }: { recall: Recall }) {
  const [open, setOpen] = useState(false);
  const headline = recall.component || "Recall";

  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
      onPress={() => setOpen((o) => !o)}
      accessibilityRole="button"
      accessibilityLabel={`Recall: ${headline}. Tap to ${open ? "collapse" : "expand"}.`}
      accessibilityState={{ expanded: open }}
    >
      <View style={styles.cardHeader}>
        <View style={styles.cardHeaderText}>
          <Text style={styles.cardComponent}>{headline}</Text>
          {recall.campaignNumber ? (
            <Text style={styles.cardCampaign}>
              Campaign {recall.campaignNumber}
            </Text>
          ) : null}
        </View>
        <Text style={styles.chevron}>{open ? "▾" : "▸"}</Text>
      </View>

      {recall.summary ? (
        <Text
          style={styles.summary}
          numberOfLines={open ? undefined : 2}
        >
          {recall.summary}
        </Text>
      ) : null}

      {open && (
        <View style={styles.details}>
          {recall.consequence ? (
            <DetailBlock label="Consequence" text={recall.consequence} />
          ) : null}
          {recall.remedy ? (
            <DetailBlock label="Remedy" text={recall.remedy} />
          ) : null}
          {recall.reportReceivedDate ? (
            <DetailBlock label="Reported" text={recall.reportReceivedDate} />
          ) : null}
        </View>
      )}
    </Pressable>
  );
}

function DetailBlock({ label, text }: { label: string; text: string }) {
  return (
    <View style={styles.detailBlock}>
      <Text style={styles.detailLabel}>{label.toUpperCase()}</Text>
      <Text style={styles.detailText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginTop: 8,
    gap: 8,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 2,
    marginBottom: 2,
  },
  headerText: {
    color: colors.warnText,
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 1.8,
  },
  card: {
    minHeight: HIT_TARGET,
    backgroundColor: colors.warnBg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.warnBorder,
    borderLeftWidth: 3,
    borderLeftColor: colors.warnText,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  cardPressed: {
    backgroundColor: colors.warnBorder,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  cardHeaderText: {
    flex: 1,
    gap: 2,
  },
  cardComponent: {
    color: colors.heading,
    fontSize: 14,
    fontWeight: "600",
    letterSpacing: 0.2,
  },
  cardCampaign: {
    color: colors.warnText,
    fontSize: 11,
    fontWeight: "500",
    letterSpacing: 0.4,
  },
  chevron: {
    color: colors.warnText,
    fontSize: 16,
    fontWeight: "600",
    minWidth: 18,
    textAlign: "center",
  },
  summary: {
    color: colors.text,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 8,
  },
  details: {
    marginTop: 12,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.warnBorder,
    gap: 10,
  },
  detailBlock: {
    gap: 4,
  },
  detailLabel: {
    color: colors.warnText,
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 1.4,
  },
  detailText: {
    color: colors.text,
    fontSize: 13,
    lineHeight: 19,
  },
});
