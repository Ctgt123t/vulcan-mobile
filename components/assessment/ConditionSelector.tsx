import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import {
  OPERATING_CONDITION_LABELS,
  type OperatingCondition,
} from "../../lib/assessmentTypes";
import { HIT_TARGET, colors } from "../../lib/theme";

// Operating-condition chip grid for the assessment intake. The snapshot is
// only as good as the condition it was captured under, so the tech picks
// what the vehicle is doing RIGHT NOW before the assessment fires.

const CONDITIONS: OperatingCondition[] = [
  "COLD_START",
  "WARM_IDLE",
  "LIGHT_LOAD",
  "HEAVY_LOAD",
  "UNDER_SYMPTOM_CONDITION",
  "OTHER",
];

export default function ConditionSelector({
  value,
  onChange,
}: {
  value: OperatingCondition;
  onChange: (c: OperatingCondition) => void;
}) {
  return (
    <View style={styles.conditionGrid}>
      {CONDITIONS.map((c) => (
        <TouchableOpacity
          key={c}
          style={[
            styles.conditionChip,
            value === c && styles.conditionChipActive,
          ]}
          onPress={() => onChange(c)}
          activeOpacity={0.75}
        >
          <Text
            style={[
              styles.conditionChipText,
              value === c && styles.conditionChipTextActive,
            ]}
          >
            {OPERATING_CONDITION_LABELS[c]}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  conditionGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  conditionChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface2,
    minHeight: HIT_TARGET - 4,
    justifyContent: "center",
  },
  conditionChipActive: {
    borderColor: colors.accent,
    backgroundColor: colors.accentFade,
  },
  conditionChipText: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.text,
  },
  conditionChipTextActive: {
    color: colors.accent,
  },
});
