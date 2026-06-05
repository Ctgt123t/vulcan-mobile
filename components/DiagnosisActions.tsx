import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { HIT_TARGET, colors } from "../lib/theme";

type Props = {
  onConfirm: () => void;
  onReject: () => void;
  disabled?: boolean;
};

export default function DiagnosisActions({
  onConfirm,
  onReject,
  disabled,
}: Props) {
  return (
    <View style={styles.row}>
      <TouchableOpacity
        style={[styles.btn, styles.confirm, disabled && styles.disabled]}
        onPress={onConfirm}
        disabled={disabled}
        activeOpacity={0.85}
        accessibilityLabel="Confirm diagnosis as correct"
      >
        <Text style={styles.solidText}>Confirmed Fix  ✓</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[styles.btn, styles.reject, disabled && styles.disabled]}
        onPress={onReject}
        disabled={disabled}
        activeOpacity={0.85}
        accessibilityLabel="Mark diagnosis as not correct"
      >
        <Text style={styles.solidText}>Not Correct  ✗</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 10,
    gap: 10,
  },
  btn: {
    flex: 1,
    minHeight: HIT_TARGET,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 12,
  },
  confirm: {
    backgroundColor: colors.successFill,
  },
  reject: {
    backgroundColor: colors.dangerFill,
  },
  solidText: {
    color: "#FFFFFF",
    fontSize: 15,
    fontWeight: "600",
    letterSpacing: 0.3,
  },
  disabled: {
    opacity: 0.5,
  },
});
