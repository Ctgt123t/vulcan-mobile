import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import type { VehicleInfo } from "../lib/types";
import { HIT_TARGET, colors } from "../lib/theme";

export default function VehicleBar({
  vehicle,
  onReset,
}: {
  vehicle: VehicleInfo;
  onReset: () => void;
}) {
  const name = [vehicle.year, vehicle.make, vehicle.model, vehicle.trim]
    .filter((s) => s && s.length > 0)
    .join(" ");

  const metaParts: string[] = [];
  if (vehicle.engineType && vehicle.engineType.length > 0) {
    metaParts.push(vehicle.engineType);
  }
  metaParts.push(`${vehicle.mileage} mi`);

  return (
    <View style={styles.bar}>
      <View style={styles.inner}>
        <View style={styles.info}>
          <Text style={styles.name} numberOfLines={1}>
            {name}
          </Text>
          <Text style={styles.sep}>·</Text>
          <Text style={styles.meta} numberOfLines={1}>
            {metaParts.join(" · ")}
          </Text>
        </View>
        <TouchableOpacity
          style={styles.reset}
          onPress={onReset}
          activeOpacity={0.7}
          accessibilityLabel="Start a new diagnosis"
        >
          <Text style={styles.resetText}>New diagnosis</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    backgroundColor: colors.surface2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  inner: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  info: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 8,
    minWidth: 0,
  },
  name: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: "600",
    letterSpacing: 0.1,
  },
  sep: {
    color: colors.muted,
  },
  meta: {
    color: colors.muted,
    fontSize: 12,
    flexShrink: 1,
  },
  reset: {
    minHeight: HIT_TARGET,
    paddingHorizontal: 12,
    justifyContent: "center",
    alignItems: "center",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    borderRadius: 6,
  },
  resetText: {
    color: colors.text,
    fontSize: 12,
    letterSpacing: 0.2,
  },
});
