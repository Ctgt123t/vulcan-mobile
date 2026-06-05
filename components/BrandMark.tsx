import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, View, type ViewStyle } from "react-native";
import { colors } from "../lib/theme";

type Props = {
  size?: number;
  style?: ViewStyle;
};

export default function BrandMark({ size = 28, style }: Props) {
  const radius = Math.max(6, Math.round(size * 0.28));
  const iconSize = Math.round(size * 0.62);
  return (
    <View
      style={[
        styles.base,
        { width: size, height: size, borderRadius: radius },
        style,
      ]}
    >
      <Ionicons name="flash" size={iconSize} color="#FFFFFF" />
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
});
