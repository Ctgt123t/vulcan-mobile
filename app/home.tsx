import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import BrandMark from "../components/BrandMark";
import Navbar from "../components/Navbar";
import Background from "../components/ui/Background";
import GlassCard from "../components/ui/GlassCard";
import { useObd2 } from "../contexts/Obd2Context";
import { HIT_TARGET, colors, fonts, radii, space } from "../lib/theme";

// v2 "steel glass" reference screen. The locked mock: atmospheric background;
// translucent (NOT blurred) glass tiles with steel line-icon chips; the warm
// brand mark + glow as the permanent anchor under a "DIAGNOSTIC SUITE" overline;
// quiet footer utilities with a WARM connected-device indicator when an adapter
// is live. Fonts are set EXPLICITLY via the Plex tokens (the global patch still
// covers un-migrated screens).

export default function HomeScreen() {
  const router = useRouter();
  const { isConnected } = useObd2();

  return (
    <Background>
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <Navbar />
        <ScrollView
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.hero}>
            <Text style={styles.overline}>DIAGNOSTIC SUITE</Text>
            <View style={styles.wordmarkRow}>
              <BrandMark size={46} glow />
              <Text style={styles.wordmark}>Vulcan</Text>
            </View>
            <Text style={styles.headline}>What are we diagnosing today?</Text>
          </View>

          <View style={styles.actions}>
            <ActionTile
              icon="chatbubbles-outline"
              title="Ask Vulcan"
              subtitle="Ask anything automotive"
              onPress={() => router.push("/ask")}
            />
            <ActionTile
              icon="pulse-outline"
              title="Diagnose"
              subtitle="Guided diagnosis — uses live OBD2 data when connected"
              onPress={() => router.push("/diagnose")}
            />
            <ActionTile
              icon="clipboard-outline"
              title="Inspection Report"
              subtitle="Multi-point vehicle inspection"
              onPress={() => router.push("/inspection")}
            />
            <ActionTile
              icon="hardware-chip-outline"
              title="OBD2 Scan"
              subtitle="Connect to vehicle systems"
              onPress={() => router.push("/obd2")}
            />
          </View>

          {/* Quiet footer utilities. "Connect a Device" is one-time setup, so it
              lives here, not as a primary tile. It shows the WARM live treatment
              when an adapter is connected, plain otherwise. */}
          <View style={styles.footerLinks}>
            <Pressable
              style={styles.utilityLink}
              onPress={() => router.push("/connect")}
              accessibilityRole="button"
              accessibilityLabel={
                isConnected ? "Device connected" : "Connect a Device"
              }
            >
              {isConnected ? (
                <View style={styles.connectedRow}>
                  <View style={styles.warmDot} />
                  <Text style={styles.connectedText}>Device connected</Text>
                </View>
              ) : (
                <Text style={styles.utilityText}>Connect a Device</Text>
              )}
            </Pressable>
            <Pressable
              style={styles.utilityLink}
              onPress={() => router.push("/diagnostic-logs")}
              accessibilityRole="button"
              accessibilityLabel="Diagnostic Log"
            >
              <Text style={styles.utilityText}>Diagnostic Log</Text>
            </Pressable>
          </View>
        </ScrollView>
      </SafeAreaView>
    </Background>
  );
}

function ActionTile({
  icon,
  title,
  subtitle,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  subtitle: string;
  onPress: () => void;
}) {
  return (
    <GlassCard onPress={onPress} accessibilityLabel={title}>
      <View style={styles.tileRow}>
        <View style={styles.iconChip}>
          <Ionicons name={icon} size={24} color={colors.steelGlyph} />
        </View>
        <View style={styles.tileBody}>
          <Text style={styles.tileTitle}>{title}</Text>
          <Text style={styles.tileSubtitle}>{subtitle}</Text>
        </View>
        <Ionicons name="chevron-forward" size={20} color={colors.faint} />
      </View>
    </GlassCard>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: "transparent", // let the atmosphere show through
  },
  content: {
    flexGrow: 1,
    paddingHorizontal: space.xl,
    paddingTop: space.xxl,
    paddingBottom: space.xxl,
    gap: space.xxl,
  },
  hero: {
    alignItems: "center",
    gap: space.md,
  },
  overline: {
    color: colors.muted,
    fontSize: 11,
    fontFamily: fonts.sansSemibold,
    letterSpacing: 2.5,
  },
  wordmarkRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
  },
  wordmark: {
    color: colors.heading,
    fontSize: 30,
    fontFamily: fonts.sansBold,
    letterSpacing: -0.4,
  },
  headline: {
    color: colors.muted,
    fontSize: 17,
    fontFamily: fonts.sans,
    textAlign: "center",
    lineHeight: 24,
  },
  actions: {
    gap: space.md,
    marginTop: space.xs,
  },
  tileRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: space.lg,
    paddingVertical: space.lg,
    minHeight: HIT_TARGET + 40,
    gap: space.lg,
  },
  iconChip: {
    width: 52,
    height: 52,
    borderRadius: radii.md,
    backgroundColor: colors.steelChip,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.steelChipBorder,
    alignItems: "center",
    justifyContent: "center",
  },
  tileBody: {
    flex: 1,
    gap: 3,
  },
  tileTitle: {
    color: colors.heading,
    fontSize: 17,
    fontFamily: fonts.sansSemibold,
    letterSpacing: 0.1,
  },
  tileSubtitle: {
    color: colors.muted,
    fontSize: 13,
    fontFamily: fonts.sans,
    lineHeight: 19,
  },
  footerLinks: {
    alignItems: "center",
    gap: space.xs,
  },
  utilityLink: {
    alignSelf: "center",
    paddingVertical: space.sm,
    paddingHorizontal: space.lg,
    minHeight: HIT_TARGET,
    alignItems: "center",
    justifyContent: "center",
  },
  utilityText: {
    color: colors.muted,
    fontSize: 12,
    fontFamily: fonts.sansMedium,
  },
  connectedRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
  },
  warmDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.warm,
    shadowColor: colors.warm,
    shadowOpacity: 0.8,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 0 },
  },
  connectedText: {
    color: colors.warmText,
    fontSize: 12,
    fontFamily: fonts.sansSemibold,
    letterSpacing: 0.2,
  },
});
