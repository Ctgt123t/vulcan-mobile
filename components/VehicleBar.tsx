import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import type { VehicleInfo } from "../lib/types";
import { HIT_TARGET, colors, fonts, radii } from "../lib/theme";

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

  const hasEngine = !!vehicle.engineType && vehicle.engineType.length > 0;

  return (
    <View style={styles.bar}>
      <View style={styles.inner}>
        <View style={styles.info}>
          <Text style={styles.name} numberOfLines={1}>
            {name}
          </Text>
          {hasEngine ? (
            <>
              <Text style={styles.sep}>·</Text>
              <Text style={styles.meta} numberOfLines={1}>
                {vehicle.engineType}
              </Text>
            </>
          ) : null}
          <Text style={styles.sep}>·</Text>
          {/* Mileage is data → IBM Plex Mono. */}
          <Text style={styles.metaMono} numberOfLines={1}>
            {vehicle.mileage} mi
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
  // v2: flows over the atmosphere (no fill), with a subtle hairline divider.
  bar: {
    backgroundColor: "transparent",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.glassRim,
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
    color: colors.heading,
    fontSize: 14,
    fontFamily: fonts.sansSemibold,
    letterSpacing: 0.1,
  },
  sep: {
    color: colors.muted,
  },
  meta: {
    color: colors.muted,
    fontSize: 12,
    fontFamily: fonts.sans,
    flexShrink: 1,
  },
  metaMono: {
    color: colors.muted,
    fontSize: 12,
    fontFamily: fonts.mono,
    flexShrink: 1,
  },
  // v2 ghost/steel button.
  reset: {
    minHeight: HIT_TARGET,
    paddingHorizontal: 12,
    justifyContent: "center",
    alignItems: "center",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.glassRim,
    backgroundColor: colors.glassFill,
    borderRadius: radii.sm,
  },
  resetText: {
    color: colors.accent,
    fontSize: 12,
    fontFamily: fonts.sansSemibold,
    letterSpacing: 0.2,
  },
});
