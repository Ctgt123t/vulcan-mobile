import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { EMPTY_VEHICLE } from "../contexts/VehicleContext";
import { VinDecodeError, decodeVin, isLikelyVin } from "../lib/api";
import { HIT_TARGET, colors } from "../lib/theme";
import type { VehicleInfo } from "../lib/types";
import { VehiclePickerRow } from "./VehiclePicker";
import VinScanner from "./VinScanner";

// Extracted VERBATIM from app/ask.tsx during the Phase-4 unified-shell merge
// (the shell's light phase reuses it for the "Add vehicle" affordance). VIN
// auto-decode + scan + manual picker; behavior unchanged.

export default function AddVehicleModal({
  visible,
  onClose,
  onConfirm,
}: {
  visible: boolean;
  onClose: () => void;
  onConfirm: (vehicle: VehicleInfo, vin: string) => void;
}) {
  const [localVin, setLocalVin] = useState("");
  const [localVehicle, setLocalVehicle] = useState<VehicleInfo>(EMPTY_VEHICLE);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [decoding, setDecoding] = useState(false);
  const [decodeError, setDecodeError] = useState<string | null>(null);
  const [decoded, setDecoded] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const lastDecodedRef = useRef("");

  useEffect(() => {
    if (!visible) {
      setLocalVin("");
      setLocalVehicle(EMPTY_VEHICLE);
      setDecoded(false);
      setDecodeError(null);
      setManualOpen(false);
      lastDecodedRef.current = "";
    }
  }, [visible]);

  useEffect(() => {
    const trimmed = localVin.trim().toUpperCase();
    if (!isLikelyVin(trimmed)) {
      setDecoded(false);
      setDecodeError(null);
      return;
    }
    if (lastDecodedRef.current === trimmed) return;
    lastDecodedRef.current = trimmed;
    setDecoding(true);
    setDecodeError(null);
    decodeVin(trimmed)
      .then((d) => {
        setLocalVehicle((v) => ({
          ...v,
          year: d.year || v.year,
          make: d.make || v.make,
          model: d.model || v.model,
          series: d.series || v.series,
          trim: d.trim || v.trim,
          engineType: d.engineType || v.engineType,
        }));
        setDecoded(true);
      })
      .catch((err) => {
        const msg =
          err instanceof VinDecodeError ? err.message : "Decode failed.";
        setDecodeError(msg);
        setDecoded(false);
      })
      .finally(() => setDecoding(false));
  }, [localVin]);

  function updateField<K extends keyof VehicleInfo>(
    field: K,
    value: VehicleInfo[K],
  ) {
    setLocalVehicle((v) => ({ ...v, [field]: value }));
  }

  const canSave =
    localVehicle.year.trim().length > 0 &&
    localVehicle.make.trim().length > 0 &&
    localVehicle.model.trim().length > 0;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView style={styles.modalSafe} edges={["top", "bottom"]}>
        <View style={styles.modalTopBar}>
          <TouchableOpacity
            onPress={onClose}
            style={styles.modalCloseBtn}
            activeOpacity={0.7}
          >
            <Text style={styles.modalCloseText}>Cancel</Text>
          </TouchableOpacity>
          <Text style={styles.modalTitle}>Add Vehicle</Text>
          <TouchableOpacity
            onPress={() => canSave && onConfirm(localVehicle, localVin.trim())}
            disabled={!canSave}
            style={styles.modalCloseBtn}
            activeOpacity={0.7}
          >
            <Text
              style={[
                styles.modalCloseText,
                !canSave && { color: colors.muted },
              ]}
            >
              Save
            </Text>
          </TouchableOpacity>
        </View>

        <ScrollView
          contentContainerStyle={styles.modalContent}
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets
        >
          <Text style={styles.modalLabel}>VIN</Text>
          <View style={styles.vinRow}>
            <TextInput
              style={[styles.vinInput]}
              value={localVin}
              onChangeText={(v) =>
                setLocalVin(v.replace(/[^A-Za-z0-9]/g, "").toUpperCase())
              }
              placeholder="1HGBH41JXMN109186"
              placeholderTextColor={colors.muted}
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={17}
            />
            <TouchableOpacity
              style={styles.scanBtn}
              onPress={() => setScannerOpen(true)}
              activeOpacity={0.85}
            >
              <Text style={styles.scanBtnText}>Scan</Text>
            </TouchableOpacity>
          </View>

          {decoding && (
            <View style={styles.statusRow}>
              <ActivityIndicator size="small" color={colors.accent} />
              <Text style={styles.statusText}>Decoding VIN…</Text>
            </View>
          )}

          {decodeError && !decoding && (
            <View style={styles.errorBoxTight}>
              <Text style={styles.errorText}>{decodeError}</Text>
            </View>
          )}

          {decoded && !decoding && (
            <View style={styles.decodedBox}>
              <Text style={styles.decodedLabel}>DECODED</Text>
              <Text style={styles.decodedLine}>
                {[localVehicle.year, localVehicle.make, localVehicle.model]
                  .filter((s) => s && s.length > 0)
                  .join(" ")}
              </Text>
              {localVehicle.engineType ? (
                <Text style={styles.decodedSub}>
                  Engine: {localVehicle.engineType}
                </Text>
              ) : null}
            </View>
          )}

          <TouchableOpacity
            style={styles.disclosureBtn}
            onPress={() => setManualOpen((m) => !m)}
            activeOpacity={0.7}
          >
            <Text style={styles.disclosureText}>
              {manualOpen ? "▾  " : "▸  "}Enter manually instead
            </Text>
          </TouchableOpacity>

          {manualOpen && (
            <View style={styles.manualBox}>
              <VehiclePickerRow
                year={localVehicle.year}
                make={localVehicle.make}
                model={localVehicle.model}
                onYear={(v) => updateField("year", v)}
                onMake={(v) => updateField("make", v)}
                onModel={(v) => updateField("model", v)}
              />
              <ManualField
                label="Engine"
                value={localVehicle.engineType ?? ""}
                onChangeText={(v) => updateField("engineType", v)}
                placeholder="2.5L 4-cyl"
              />
            </View>
          )}
        </ScrollView>

        <VinScanner
          visible={scannerOpen}
          onClose={() => setScannerOpen(false)}
          onScanned={(v) => {
            setLocalVin(v);
            setScannerOpen(false);
          }}
        />
      </SafeAreaView>
    </Modal>
  );
}

function ManualField({
  label,
  value,
  onChangeText,
  placeholder,
  keyboardType,
  autoCapitalize,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  keyboardType?: "default" | "number-pad";
  autoCapitalize?: "none" | "words" | "sentences" | "characters";
}) {
  return (
    <View style={styles.manualField}>
      <Text style={styles.modalLabel}>{label.toUpperCase()}</Text>
      <TextInput
        style={styles.manualInput}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.muted}
        keyboardType={keyboardType ?? "default"}
        autoCapitalize={autoCapitalize ?? "none"}
        autoCorrect={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  modalSafe: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  modalTopBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  modalCloseBtn: {
    minWidth: HIT_TARGET + 16,
    minHeight: HIT_TARGET,
    justifyContent: "center",
    paddingHorizontal: 12,
  },
  modalCloseText: {
    color: colors.accent,
    fontSize: 15,
    fontWeight: "600",
  },
  modalTitle: {
    color: colors.heading,
    fontSize: 16,
    fontWeight: "600",
  },
  modalContent: {
    padding: 20,
    gap: 8,
  },
  modalLabel: {
    fontSize: 11,
    fontWeight: "500",
    color: colors.muted,
    letterSpacing: 0.7,
    marginBottom: 6,
    marginTop: 8,
  },
  vinRow: {
    flexDirection: "row",
    gap: 10,
    alignItems: "stretch",
  },
  vinInput: {
    flex: 1,
    minHeight: HIT_TARGET,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: colors.text,
    backgroundColor: colors.surface2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 6,
  },
  scanBtn: {
    minHeight: HIT_TARGET,
    minWidth: HIT_TARGET + 24,
    paddingHorizontal: 16,
    backgroundColor: colors.accent,
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center",
  },
  scanBtnText: {
    color: "#FFFFFF",
    fontWeight: "600",
    fontSize: 14,
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 10,
  },
  statusText: {
    color: colors.muted,
    fontSize: 13,
  },
  errorBoxTight: {
    marginTop: 10,
    backgroundColor: colors.dangerBg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.dangerBorder,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 6,
  },
  errorText: {
    color: colors.dangerText,
    fontSize: 13,
  },
  decodedBox: {
    marginTop: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: colors.okBg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.okBorder,
    borderRadius: 6,
  },
  decodedLabel: {
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 1.8,
    color: colors.okText,
    marginBottom: 4,
  },
  decodedLine: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "600",
  },
  decodedSub: {
    color: colors.muted,
    fontSize: 13,
    marginTop: 2,
  },
  disclosureBtn: {
    marginTop: 14,
    minHeight: HIT_TARGET,
    justifyContent: "center",
  },
  disclosureText: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: "600",
    letterSpacing: 0.3,
  },
  manualBox: {
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    gap: 4,
  },
  manualField: {
    marginBottom: 6,
  },
  manualInput: {
    minHeight: HIT_TARGET,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: colors.text,
    backgroundColor: colors.surface2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 6,
  },
});
