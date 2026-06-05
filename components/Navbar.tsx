import { useRouter } from "expo-router";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { HIT_TARGET, colors } from "../lib/theme";
import BrandMark from "./BrandMark";

type Props = {
  showRecordsLink?: boolean;
  showBack?: boolean;
  showSignOut?: boolean;
};

export default function Navbar({
  showRecordsLink = true,
  showBack = false,
  showSignOut = true,
}: Props) {
  const router = useRouter();

  function handleSignOut() {
    // Reset the stack back to the sign-in screen. dismissAll pops any pushed
    // screens; replace then swaps the root with "/" so back doesn't return
    // here. PLACEHOLDER: real auth will also clear the session token.
    const r = router as unknown as { dismissAll?: () => void };
    if (typeof r.dismissAll === "function") {
      r.dismissAll();
    }
    router.replace("/");
  }

  return (
    <View style={styles.navbar}>
      <View style={styles.inner}>
        <View style={styles.brand}>
          {showBack && (
            <TouchableOpacity
              style={styles.backBtn}
              onPress={() => router.back()}
              activeOpacity={0.7}
              accessibilityLabel="Back"
            >
              <Text style={styles.backText}>‹</Text>
            </TouchableOpacity>
          )}
          <BrandMark size={28} />
          <Text style={styles.brandName}>Vulcan</Text>
          <View style={styles.proBadge}>
            <Text style={styles.proBadgeText}>PRO</Text>
          </View>
        </View>
        <View style={styles.actions}>
          {showRecordsLink && (
            <TouchableOpacity
              style={styles.actionBtn}
              onPress={() => router.push("/records")}
              activeOpacity={0.7}
              accessibilityLabel="View saved diagnostic records"
            >
              <Text style={styles.actionText}>Records</Text>
            </TouchableOpacity>
          )}
          {showSignOut && (
            <TouchableOpacity
              style={styles.actionBtn}
              onPress={handleSignOut}
              activeOpacity={0.7}
              accessibilityLabel="Sign out"
            >
              <Text style={[styles.actionText, styles.signOutText]}>
                Sign out
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
  brandName: {
    color: colors.heading,
    fontSize: 17,
    fontWeight: "700",
    letterSpacing: -0.2,
  },
  proBadge: {
    backgroundColor: colors.accentFade,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.accent,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 4,
  },
  proBadgeText: {
    color: colors.accent,
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 1,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
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
  signOutText: {
    color: colors.muted,
  },
});
