import { useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { DiagramLookupResult, VehicleInfo } from "../lib/types";
import { diagramLookup } from "../lib/api";
import { colors } from "../lib/theme";
import DiagramResults from "./DiagramResults";

// Mid-diagnosis "Find a diagram" surface. Hits POST /api/diagram-lookup DIRECTLY
// (via lib/api diagramLookup) — deliberately NOT wired into the diagnosis brain
// (runDiagnoseTurn / the prompt are untouched). Self-contained: the tech picks a
// type, we look it up for the in-context vehicle, and render the shared card.

const TYPES: { key: "fuse" | "component" | "wiring"; label: string }[] = [
  { key: "fuse", label: "Fuse box" },
  { key: "component", label: "Belt / component" },
  { key: "wiring", label: "Wiring" },
];

export default function FindDiagramModal({
  visible,
  vehicle,
  onClose,
}: {
  visible: boolean;
  vehicle: VehicleInfo | null;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const [result, setResult] = useState<DiagramLookupResult | null>(null);

  const hasVehicle = Boolean(vehicle?.year && vehicle?.make && vehicle?.model);

  async function run(type: "fuse" | "component" | "wiring") {
    if (!hasVehicle || !vehicle) return;
    setActive(type);
    setLoading(true);
    setResult(null);
    const r = await diagramLookup(vehicle, type); // fail-soft -> always a result
    setResult(r);
    setLoading(false);
  }

  function close() {
    setActive(null);
    setResult(null);
    setLoading(false);
    onClose();
  }

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={close}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.headerRow}>
            <Text style={styles.title}>Find a diagram</Text>
            <Pressable onPress={close} accessibilityRole="button" hitSlop={10}>
              <Text style={styles.close}>✕</Text>
            </Pressable>
          </View>

          {hasVehicle ? (
            <Text style={styles.vehicle}>
              {vehicle?.year} {vehicle?.make} {vehicle?.model}
            </Text>
          ) : (
            <Text style={styles.note}>Set a vehicle (year, make, model) first.</Text>
          )}

          <View style={styles.typeRow}>
            {TYPES.map((t) => (
              <Pressable
                key={t.key}
                disabled={!hasVehicle || loading}
                style={[styles.typeBtn, active === t.key && styles.typeBtnActive, (!hasVehicle || loading) && styles.typeBtnDisabled]}
                onPress={() => run(t.key)}
              >
                <Text style={[styles.typeBtnText, active === t.key && styles.typeBtnTextActive]}>{t.label}</Text>
              </Pressable>
            ))}
          </View>

          <ScrollView style={styles.body} contentContainerStyle={{ paddingBottom: 12 }}>
            {loading && <ActivityIndicator color={colors.accent} style={{ marginTop: 16 }} />}
            {!loading && result && <DiagramResults result={result} />}
            {!loading && !result && hasVehicle && (
              <Text style={styles.note}>Pick a diagram type to search.</Text>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: colors.surface ?? "#191B1E",
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    padding: 16,
    maxHeight: "82%",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  title: { color: colors.text, fontSize: 16, fontWeight: "700" },
  close: { color: colors.muted, fontSize: 18, paddingHorizontal: 4 },
  vehicle: { color: colors.muted, fontSize: 13, marginTop: 4 },
  note: { color: colors.muted, fontSize: 13, marginTop: 10 },
  typeRow: { flexDirection: "row", gap: 8, marginTop: 12 },
  typeBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: "center",
    backgroundColor: colors.steelChip,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.steelChipBorder,
  },
  typeBtnActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  typeBtnDisabled: { opacity: 0.5 },
  typeBtnText: { color: colors.text, fontSize: 13, fontWeight: "600" },
  typeBtnTextActive: { color: "#10141A" },
  body: { marginTop: 4 },
});
