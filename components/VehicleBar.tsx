import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import type { VehicleInfo } from "../lib/types";
import { HIT_TARGET, colors, fonts, radii } from "../lib/theme";

export default function VehicleBar({
  vehicle,
  onReset,
  // Phase 4 (unified shell): the light phase relabels the action ("New chat")
  // — defaulted so every existing call site renders exactly as before.
  resetLabel = "New diagnosis",
  // Light-chat vehicle affordance (shell checklist fix): when provided, the
  // vehicle info region becomes tappable (change/clear the chat's vehicle)
  // and shows a subtle disclosure hint. Absent (every diagnostic call site)
  // → plain non-interactive View, exactly as before.
  onPressVehicle,
}: {
  vehicle: VehicleInfo;
  onReset: () => void;
  resetLabel?: string;
  onPressVehicle?: () => void;
}) {
  const name = [vehicle.year, vehicle.make, vehicle.model, vehicle.trim]
    .filter((s) => s && s.length > 0)
    .join(" ");

  const hasEngine = !!vehicle.engineType && vehicle.engineType.length > 0;

  const info = (
    <>
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
      {onPressVehicle ? <Text style={styles.editHint}>▾</Text> : null}
    </>
  );

  return (
    <View style={styles.bar}>
      <View style={styles.inner}>
        {onPressVehicle ? (
          <TouchableOpacity
            style={styles.info}
            onPress={onPressVehicle}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Change or clear the vehicle for this chat"
          >
            {info}
          </TouchableOpacity>
        ) : (
          <View style={styles.info}>{info}</View>
        )}
        <TouchableOpacity
          style={styles.reset}
          onPress={onReset}
          activeOpacity={0.7}
          accessibilityLabel={resetLabel}
        >
          <Text style={styles.resetText}>{resetLabel}</Text>
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
  // The tappable-vehicle disclosure hint (light chat only).
  editHint: {
    color: colors.faint,
    fontSize: 10,
    marginLeft: 4,
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
