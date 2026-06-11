import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, Text, View } from "react-native";
import { colors } from "../../lib/theme";

// Small pill showing what data is available for an assessment
// (live signal count, DTC count) — green when present, muted when not.

export default function DataBadge({
  label,
  active,
  icon,
}: {
  label: string;
  active: boolean;
  icon: keyof typeof Ionicons.glyphMap;
}) {
  return (
    <View
      style={[
        styles.dataBadge,
        active ? styles.dataBadgeActive : styles.dataBadgeInactive,
      ]}
    >
      <Ionicons
        name={icon}
        size={13}
        color={active ? colors.okText : colors.muted}
      />
      <Text
        style={[
          styles.dataBadgeText,
          { color: active ? colors.okText : colors.muted },
        ]}
      >
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  dataBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
  },
  dataBadgeActive: {
    backgroundColor: colors.okBg,
    borderColor: colors.okBorder,
  },
  dataBadgeInactive: {
    backgroundColor: colors.surface2,
    borderColor: colors.border,
  },
  dataBadgeText: {
    fontSize: 12,
    fontWeight: "600",
  },
});
