import { StyleSheet, Text, View } from "react-native";
import { colors } from "../lib/theme";

export default function Navbar() {
  return (
    <View style={styles.navbar}>
      <View style={styles.inner}>
        <View style={styles.brand}>
          <View style={styles.iconBox}>
            <Text style={styles.iconChar}>⚡</Text>
          </View>
          <Text style={styles.brandName}>Vulcan</Text>
          <View style={styles.proBadge}>
            <Text style={styles.proBadgeText}>PRO</Text>
          </View>
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
    paddingHorizontal: 20,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  brand: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  iconBox: {
    width: 22,
    height: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  iconChar: {
    color: colors.accent,
    fontSize: 18,
  },
  brandName: {
    color: colors.heading,
    fontSize: 15,
    fontWeight: "600",
    letterSpacing: 0.1,
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
});
