import { Ionicons } from "@expo/vector-icons";
import {
  Image,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { HIT_TARGET, colors } from "../lib/theme";
import type { InspectionItem, ItemStatus } from "../lib/types";

type Props = {
  label: string;
  item: InspectionItem;
  onStatusChange: (status: ItemStatus) => void;
  onNotesChange: (notes: string) => void;
  onCapturePhoto: () => void;
  onRemovePhoto: () => void;
};

const STATUS_OPTIONS: {
  key: Exclude<ItemStatus, null>;
  label: string;
  bg: string;
  bgActive: string;
  borderActive: string;
  textActive: string;
}[] = [
  {
    key: "good",
    label: "Good",
    bg: colors.surface,
    bgActive: "#16A34A",
    borderActive: "#15803D",
    textActive: "#FFFFFF",
  },
  {
    key: "attention",
    label: "Attention",
    bg: colors.surface,
    bgActive: "#F59E0B",
    borderActive: "#B45309",
    textActive: "#FFFFFF",
  },
  {
    key: "urgent",
    label: "Urgent",
    bg: colors.surface,
    bgActive: "#DC2626",
    borderActive: "#991B1B",
    textActive: "#FFFFFF",
  },
];

export default function InspectionItemRow({
  label,
  item,
  onStatusChange,
  onNotesChange,
  onCapturePhoto,
  onRemovePhoto,
}: Props) {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>

      <View style={styles.statusRow}>
        {STATUS_OPTIONS.map((opt) => {
          const active = item.status === opt.key;
          return (
            <TouchableOpacity
              key={opt.key}
              style={[
                styles.statusBtn,
                active && {
                  backgroundColor: opt.bgActive,
                  borderColor: opt.borderActive,
                },
              ]}
              onPress={() => onStatusChange(active ? null : opt.key)}
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityLabel={`${label}: ${opt.label}${active ? ", selected" : ""}`}
              accessibilityState={{ selected: active }}
            >
              <Text
                style={[
                  styles.statusBtnText,
                  active && { color: opt.textActive },
                ]}
              >
                {opt.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <TextInput
        style={styles.notes}
        value={item.notes}
        onChangeText={onNotesChange}
        placeholder="Notes (optional)…"
        placeholderTextColor={colors.muted}
        multiline
        textAlignVertical="top"
      />

      <View style={styles.photoRow}>
        {item.photoUri ? (
          <View style={styles.photoBlock}>
            <Image source={{ uri: item.photoUri }} style={styles.thumb} />
            <TouchableOpacity
              style={styles.removePhotoBtn}
              onPress={onRemovePhoto}
              activeOpacity={0.7}
              accessibilityLabel="Remove photo"
            >
              <Ionicons name="close" size={14} color="#FFFFFF" />
            </TouchableOpacity>
          </View>
        ) : null}
        <TouchableOpacity
          style={styles.cameraBtn}
          onPress={onCapturePhoto}
          activeOpacity={0.7}
          accessibilityLabel="Attach photo"
        >
          <Ionicons name="camera-outline" size={18} color={colors.accent} />
          <Text style={styles.cameraText}>
            {item.photoUri ? "Replace photo" : "Attach photo"}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    gap: 10,
  },
  label: {
    color: colors.heading,
    fontSize: 14,
    fontWeight: "600",
    lineHeight: 19,
  },
  statusRow: {
    flexDirection: "row",
    gap: 8,
  },
  statusBtn: {
    flex: 1,
    minHeight: HIT_TARGET,
    paddingHorizontal: 8,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  statusBtnText: {
    color: colors.text,
    fontSize: 13,
    fontWeight: "600",
  },
  notes: {
    minHeight: HIT_TARGET,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: colors.text,
    backgroundColor: colors.surface2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 8,
  },
  photoRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    flexWrap: "wrap",
  },
  photoBlock: {
    position: "relative",
  },
  thumb: {
    width: 56,
    height: 56,
    borderRadius: 8,
    backgroundColor: colors.surface2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  removePhotoBtn: {
    position: "absolute",
    top: -6,
    right: -6,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.text,
    alignItems: "center",
    justifyContent: "center",
  },
  cameraBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: HIT_TARGET - 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.accent,
    backgroundColor: colors.accentFade,
  },
  cameraText: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: "600",
  },
});
