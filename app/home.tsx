import { useRouter } from "expo-router";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import BrandMark from "../components/BrandMark";
import Navbar from "../components/Navbar";
import { HIT_TARGET, colors } from "../lib/theme";

export default function HomeScreen() {
  const router = useRouter();

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <Navbar />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.hero}>
          <View style={styles.wordmarkRow}>
            <BrandMark size={44} />
            <Text style={styles.wordmark}>Vulcan</Text>
          </View>
          <Text style={styles.headline}>
            What are we diagnosing today?
          </Text>
        </View>

        <View style={styles.actions}>
          <ActionTile
            icon="⚡"
            title="Ask Vulcan"
            subtitle="Ask anything automotive"
            onPress={() => router.push("/ask")}
          />
          <ActionTile
            icon="🔍"
            title="Diagnose"
            subtitle="Guided vehicle diagnosis"
            onPress={() => router.push("/diagnose")}
          />
          <ActionTile
            icon="📋"
            title="Inspection Report"
            subtitle="Multi-point vehicle inspection"
            onPress={() => router.push("/inspection")}
          />
          <ActionTile
            icon="🔌"
            title="OBD2 Scan"
            subtitle="Connect to vehicle systems"
            onPress={() => router.push("/obd2")}
          />
        </View>

        <Pressable
          style={styles.diagLogLink}
          onPress={() => router.push("/diagnostic-logs")}
        >
          <Text style={styles.diagLogText}>Diagnostic Log</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

function ActionTile({
  icon,
  title,
  subtitle,
  onPress,
  comingSoon,
}: {
  icon: string;
  title: string;
  subtitle: string;
  onPress: () => void;
  comingSoon?: boolean;
}) {
  return (
    <Pressable
      style={({ pressed }) => [
        styles.tile,
        pressed && styles.tilePressed,
      ]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={title}
    >
      <View style={styles.tileIconWrap}>
        <Text style={styles.tileIcon}>{icon}</Text>
      </View>
      <View style={styles.tileBody}>
        <View style={styles.tileTitleRow}>
          <Text style={styles.tileTitle}>{title}</Text>
          {comingSoon && (
            <View style={styles.soonBadge}>
              <Text style={styles.soonBadgeText}>SOON</Text>
            </View>
          )}
        </View>
        <Text style={styles.tileSubtitle}>{subtitle}</Text>
      </View>
      <Text style={styles.tileChevron}>›</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    flexGrow: 1,
    paddingHorizontal: 20,
    paddingTop: 32,
    paddingBottom: 32,
    gap: 28,
  },
  hero: {
    alignItems: "center",
    gap: 14,
  },
  wordmarkRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  wordmark: {
    color: colors.heading,
    fontSize: 30,
    fontWeight: "700",
    letterSpacing: -0.4,
  },
  headline: {
    color: colors.muted,
    fontSize: 17,
    fontWeight: "400",
    textAlign: "center",
    lineHeight: 24,
  },
  actions: {
    gap: 12,
    marginTop: 8,
  },
  tile: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 18,
    minHeight: HIT_TARGET + 40,
    gap: 14,
  },
  tilePressed: {
    backgroundColor: colors.surface2,
    borderColor: colors.accent,
  },
  tileIconWrap: {
    width: 56,
    height: 56,
    borderRadius: 12,
    backgroundColor: colors.accentFade,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  tileIcon: {
    fontSize: 28,
  },
  tileBody: {
    flex: 1,
    gap: 4,
  },
  tileTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  tileTitle: {
    color: colors.heading,
    fontSize: 17,
    fontWeight: "600",
    letterSpacing: 0.1,
  },
  tileSubtitle: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 19,
  },
  tileChevron: {
    color: colors.muted,
    fontSize: 28,
    fontWeight: "300",
    marginRight: 4,
  },
  soonBadge: {
    backgroundColor: colors.accentFade,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.accent,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  soonBadgeText: {
    color: colors.accent,
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 1.2,
  },
  diagLogLink: {
    alignSelf: "center",
    paddingVertical: 8,
    paddingHorizontal: 16,
    minHeight: HIT_TARGET,
    alignItems: "center",
    justifyContent: "center",
  },
  diagLogText: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: "500",
  },
});
