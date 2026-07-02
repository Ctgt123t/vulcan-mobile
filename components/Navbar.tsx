import { useRouter } from "expo-router";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { HIT_TARGET, colors } from "../lib/theme";
import BrandMark from "./BrandMark";

type Props = {
  showRecordsLink?: boolean;
  showBack?: boolean;
  // Post-merge cleanup (2026-07-02): "Sign out" was removed from the header
  // (re-added later inside a future Settings screen — auth is still the
  // placeholder sign-in). Its slot now holds "Chats" (the unified thread
  // list), promoted from the home footer.
  showChatsLink?: boolean;
  // Home opt-in: flow over the atmospheric background (no fill/divider) and
  // render the actions as plain text links instead of filled chips. Other
  // screens omit this prop and keep the solid bar + chip buttons.
  transparent?: boolean;
};

export default function Navbar({
  showRecordsLink = true,
  showBack = false,
  showChatsLink = true,
  transparent = false,
}: Props) {
  const router = useRouter();

  return (
    <View style={[styles.navbar, transparent && styles.navbarTransparent]}>
      <View style={styles.inner}>
        <View style={styles.brand}>
          {showBack && (
            <TouchableOpacity
              style={styles.backBtn}
              onPress={() => router.back()}
              activeOpacity={0.7}
              accessibilityLabel="Back"
            >
              <Text style={[styles.backText, transparent && styles.backTextTransparent]}>‹</Text>
            </TouchableOpacity>
          )}
          <BrandMark size={28} />
          <Text style={styles.brandName} numberOfLines={1}>
            Vulcan
          </Text>
        </View>
        <View style={styles.actions}>
          {showRecordsLink && (
            <TouchableOpacity
              style={transparent ? styles.linkBtn : styles.actionBtn}
              onPress={() => router.push("/records")}
              activeOpacity={0.7}
              accessibilityLabel="View saved diagnostic records"
            >
              <Text
                style={[styles.actionText, transparent && styles.recordsLinkText]}
              >
                Records
              </Text>
            </TouchableOpacity>
          )}
          {showChatsLink && (
            <TouchableOpacity
              style={transparent ? styles.linkBtn : styles.actionBtn}
              onPress={() => router.push("/chats")}
              activeOpacity={0.7}
              accessibilityLabel="Chats — resume a conversation"
            >
              <Text
                style={[styles.actionText, transparent && styles.recordsLinkText]}
              >
                Chats
              </Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  navbar: {
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  // Home variant: flow over the atmosphere — no fill, no divider.
  navbarTransparent: {
    backgroundColor: "transparent",
    borderBottomWidth: 0,
  },
  inner: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  brand: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    // Let the brand group give way on narrow screens (RN default flexShrink is
    // 0, so without this the brand + actions collide). minWidth:0 lets the name
    // ellipsize rather than push the actions off-screen.
    flexShrink: 1,
    minWidth: 0,
    marginRight: 8,
  },
  backBtn: {
    minWidth: HIT_TARGET,
    minHeight: HIT_TARGET,
    marginLeft: -8,
    alignItems: "center",
    justifyContent: "center",
  },
  backText: {
    color: colors.accent,
    fontSize: 28,
    fontWeight: "300",
    marginTop: -4,
  },
  backTextTransparent: {
    color: "#AEB5BD", // steel (home/intake transparent header)
  },
  brandName: {
    color: colors.heading,
    fontSize: 17,
    fontWeight: "700",
    letterSpacing: -0.2,
    flexShrink: 1, // the name is what ellipsizes; the badge/logo stay fixed
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexShrink: 0, // Records / Sign out keep their size; the brand gives way
  },
  actionBtn: {
    minHeight: HIT_TARGET - 12,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface2,
    alignItems: "center",
    justifyContent: "center",
  },
  actionText: {
    color: colors.text,
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.3,
  },
  // Home variant: plain text links (no fill/border).
  linkBtn: {
    minHeight: HIT_TARGET - 12,
    paddingHorizontal: 8,
    paddingVertical: 6,
    alignItems: "center",
    justifyContent: "center",
  },
  recordsLinkText: {
    color: "#AEB5BD", // light steel (per v2 home mock)
  },
});
