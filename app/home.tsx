import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
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
        <Navbar transparent />
        <ScrollView
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.hero}>
            <Text style={styles.headline}>What are we diagnosing today?</Text>
          </View>

          <View style={styles.actions}>
            {/* Post-merge cleanup: ONE chat entry. Ask starts light and
                deepens via "Diagnose this" (always available, even on an
                empty thread — the direct-diagnosis path). Diagnosis is also
                reachable via the OBD2 screen's "Escalate to Diagnosis" and
                case resume (Chats / auto-prompt), which enter /chat at the
                intake directly. */}
            <ActionTile
              icon="chatbubbles-outline"
              title="Ask Vulcan"
              subtitle="Ask anything automotive — escalate to a full diagnosis any time"
              onPress={() => router.push("/chat")}
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
                isConnected ? "Device connected" : "Connect a device"
              }
            >
              {isConnected ? (
                <View style={styles.utilityRow}>
                  <View style={styles.warmDot} />
                  <Text style={styles.connectedText}>Device connected</Text>
                </View>
              ) : (
                <View style={styles.utilityRow}>
                  <Ionicons
                    name="bluetooth-outline"
                    size={14}
                    color={colors.muted}
                  />
                  <Text style={styles.utilityText}>Connect a device</Text>
                </View>
              )}
            </Pressable>
            <Pressable
              style={styles.utilityLink}
              onPress={() => router.push("/diagnostic-logs")}
              accessibilityRole="button"
              accessibilityLabel="Diagnostic log"
            >
              <View style={styles.utilityRow}>
                <Ionicons
                  name="document-text-outline"
                  size={14}
                  color={colors.muted}
                />
                <Text style={styles.utilityText}>Diagnostic log</Text>
              </View>
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
    paddingTop: space.sm,
    paddingBottom: space.xs,
  },
  headline: {
    color: colors.heading,
    fontSize: 22,
    fontFamily: fonts.sansSemibold,
    textAlign: "center",
    lineHeight: 29,
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
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: space.lg,
  },
  utilityLink: {
    paddingVertical: space.sm,
    paddingHorizontal: space.sm,
    minHeight: HIT_TARGET,
    alignItems: "center",
    justifyContent: "center",
  },
  utilityRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  utilityText: {
    color: colors.muted,
    fontSize: 12,
    fontFamily: fonts.sansMedium,
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
