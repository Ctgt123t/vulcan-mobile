import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { HIT_TARGET, colors } from "../lib/theme";
import type { Tsb } from "../lib/types";

type Props = {
  tsbs: Tsb[];
};

export default function TsbList({ tsbs }: Props) {
  if (tsbs.length === 0) return null;
  return (
    <View style={styles.wrap}>
      <View style={styles.headerRow}>
        <Text style={styles.headerText}>
          TECHNICAL SERVICE BULLETINS · {tsbs.length}
        </Text>
      </View>
      {tsbs.map((t, i) => (
        <TsbCard key={t.number || `tsb-${i}`} tsb={t} />
      ))}
    </View>
  );
}

function TsbCard({ tsb }: { tsb: Tsb }) {
  const [open, setOpen] = useState(false);
  const title = firstSentence(tsb.summary) || tsb.component || "Bulletin";

  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
      onPress={() => setOpen((o) => !o)}
      accessibilityRole="button"
      accessibilityLabel={`TSB ${tsb.number}. Tap to ${open ? "collapse" : "expand"}.`}
      accessibilityState={{ expanded: open }}
    >
      <View style={styles.cardHeader}>
        <View style={styles.cardHeaderText}>
          <Text style={styles.tsbNumber}>TSB {tsb.number}</Text>
          <Text style={styles.tsbTitle} numberOfLines={open ? undefined : 1}>
            {title}
          </Text>
        </View>
        <Text style={styles.chevron}>{open ? "▾" : "▸"}</Text>
      </View>

      {tsb.summary && !open && (
        <Text style={styles.brief} numberOfLines={2}>
          {tsb.summary}
        </Text>
      )}

      {open && (
        <View style={styles.details}>
          {tsb.component ? (
            <DetailBlock label="Component" text={tsb.component} />
          ) : null}
          {tsb.summary ? (
            <DetailBlock label="Summary" text={tsb.summary} />
          ) : null}
          {tsb.date ? <DetailBlock label="Issued" text={tsb.date} /> : null}
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

function firstSentence(s: string): string {
  if (!s) return "";
  const cleaned = s.replace(/\s+/g, " ").trim();
  const stop = cleaned.search(/[.!?](\s|$)/);
  if (stop > 0 && stop < 120) return cleaned.slice(0, stop + 1);
  if (cleaned.length > 100) return cleaned.slice(0, 100).trim() + "…";
  return cleaned;
}

const styles = StyleSheet.create({
  wrap: {
    marginTop: 12,
    gap: 8,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 2,
    marginBottom: 2,
  },
  headerText: {
    color: colors.infoText,
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 1.8,
  },
  card: {
    minHeight: HIT_TARGET,
    backgroundColor: colors.infoBg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.infoBorder,
    borderLeftWidth: 3,
    borderLeftColor: colors.infoText,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  cardPressed: {
    backgroundColor: colors.infoBorder,
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
  tsbNumber: {
    color: colors.infoText,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.5,
  },
  tsbTitle: {
    color: colors.heading,
    fontSize: 14,
    fontWeight: "600",
    lineHeight: 19,
  },
  chevron: {
    color: colors.infoText,
    fontSize: 16,
    fontWeight: "600",
    minWidth: 18,
    textAlign: "center",
  },
  brief: {
    color: colors.text,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 8,
  },
  details: {
    marginTop: 12,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.infoBorder,
    gap: 10,
  },
  detailBlock: {
    gap: 4,
  },
  detailLabel: {
    color: colors.infoText,
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
