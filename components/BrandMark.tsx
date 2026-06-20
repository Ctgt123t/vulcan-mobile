import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, View, type ViewStyle } from "react-native";
import { colors } from "../lib/theme";

type Props = {
  size?: number;
  style?: ViewStyle;
  /** Soft warm glow behind the chip (the home hero anchor). Off by default so
   *  the small navbar mark stays crisp. */
  glow?: boolean;
};

// The brand mark is WARM amber everywhere (v2 color rule: amber = identity).
// A warm chip (translucent amber fill + amber rim) with an amber bolt glyph,
// optionally a soft warm glow when used as the home hero anchor.
export default function BrandMark({ size = 28, style, glow = false }: Props) {
  const radius = Math.max(6, Math.round(size * 0.28));
  const iconSize = Math.round(size * 0.62);
  return (
    <View
      style={[
        styles.base,
        { width: size, height: size, borderRadius: radius },
        glow && {
          shadowColor: colors.warm,
          shadowOpacity: 0.55,
          shadowRadius: Math.round(size * 0.32),
          shadowOffset: { width: 0, height: 0 },
          elevation: 6,
        },
        style,
      ]}
    >
      <Ionicons name="flash" size={iconSize} color={colors.brandGlyph} />
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    backgroundColor: colors.brandChip,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.brandChipBorder,
    alignItems: "center",
    justifyContent: "center",
  },
});
