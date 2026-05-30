import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Navbar from "../components/Navbar";
import { useVehicle } from "../contexts/VehicleContext";
import { obd2 } from "../lib/obd2";
import {
  type PidCatalogResponse,
  type PidPreset,
  createPreset,
  deletePreset,
  fetchPidCatalog,
  intersectWithSupport,
  liveMonitorableSignals,
  loadCachedBitmask,
  loadCachedCatalog,
  loadPresets,
  loadSelectedCodes,
  loadUnsupportedCodes,
  saveCachedBitmask,
  saveCatalog,
  saveSelectedCodes,
} from "../lib/pidCatalog";
import { HIT_TARGET, colors } from "../lib/theme";
import type { PidDescriptor } from "../lib/obd2";

// ----------------------------------------------------------------------------
// PID selection screen. Two views in one component:
//   - Top level: category list (Engine, Fuel System, …) with a "X PIDs
//     selected" count per category.
//   - Drilled in: per-category PID list with checkboxes.
//
// State that survives navigation lives in pidCatalog (AsyncStorage).
// Selection edits are persisted on every toggle so closing/reopening the
// screen restores the same checkboxes.
//
// Done button at the top right hands the freshly-selected descriptor list
// to obd2.setSelectedPids() so the live polling driver picks up the change
// without restarting the tick loop.
// ----------------------------------------------------------------------------

export default function PidSelectionScreen() {
  const router = useRouter();
  const { vehicle } = useVehicle();
  const vehicleReady = Boolean(
    vehicle.year && vehicle.make && vehicle.model,
  );

  // catalog = full OBDb data for this vehicle (unfiltered). bitmask =
  // ECU's mode 01 support set. We intersect at render time so a flaky
  // bitmask query (or a poll-loop race) doesn't shrink the persisted
  // catalog across openings.
  const [catalog, setCatalog] = useState<PidCatalogResponse | null>(null);
  const [bitmask, setBitmask] = useState<Set<number> | null>(null);
  const [selectedCodes, setSelectedCodes] = useState<Set<string>>(new Set());
  const [unsupported, setUnsupported] = useState<Set<string>>(new Set());
  const [presets, setPresets] = useState<PidPreset[]>([]);
  const [loading, setLoading] = useState(true);
  const [drillCategory, setDrillCategory] = useState<string | null>(null);
  const [presetModalOpen, setPresetModalOpen] = useState(false);
  const [presetName, setPresetName] = useState("");

  // ---------- Hydrate from cache + network ----------
  useEffect(() => {
    if (!vehicleReady) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      const [cached, cachedBitmask, selected, unsup, savedPresets] = await Promise.all([
        loadCachedCatalog(vehicle.make, vehicle.model, vehicle.year),
        loadCachedBitmask(vehicle.make, vehicle.model, vehicle.year),
        loadSelectedCodes(vehicle.make, vehicle.model, vehicle.year),
        loadUnsupportedCodes(vehicle.make, vehicle.model, vehicle.year),
        loadPresets(),
      ]);
      if (cancelled) return;
      if (cached) setCatalog(cached);
      if (cachedBitmask) setBitmask(cachedBitmask);
      setSelectedCodes(new Set(selected));
      setUnsupported(unsup);
      setPresets(savedPresets);

      // Background refresh: fresh catalog from network.
      const fresh = await fetchPidCatalog(vehicle.make, vehicle.model, vehicle.year);
      if (cancelled) {
        setLoading(false);
        return;
      }
      if (fresh) {
        setCatalog(fresh);
        saveCatalog(fresh).catch(() => {});
      }

      // Background refresh: bitmask from the ECU, but only if we don't
      // already have one cached. The bitmask query is serialized against
      // the poll loop inside Obd2Manager so concurrent commands don't
      // collide.
      if (!cachedBitmask && obd2.isConnected()) {
        try {
          const supported = await obd2.getSupportedMode01Pids();
          if (!cancelled && supported.size > 0) {
            setBitmask(supported);
            saveCachedBitmask(
              vehicle.make,
              vehicle.model,
              vehicle.year,
              supported,
            ).catch(() => {});
          }
        } catch (err) {
          console.warn("[obd2-pids] bitmask query failed:", err);
        }
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [vehicle.make, vehicle.model, vehicle.year, vehicleReady]);

  // ---------- Derived: signals grouped by category ----------
  // Apply the live-monitorable filter + dedupe-by-code, then intersect
  // with the ECU's mode 01 support bitmask (when we have it). Anything
  // surviving lands in its category bucket. Bit-level signals (MIL,
  // readiness flags, etc.) and enum signals are filtered out — they
  // share command codes with each other and aren't useful as live
  // gauges; they'll resurface in a dedicated "Readiness / Status" view
  // when that work lands.
  const signalsByCategory = useMemo(() => {
    const out: Record<string, PidDescriptor[]> = {};
    const categories = catalog?.categories ?? [];
    for (const c of categories) out[c] = [];
    const all = liveMonitorableSignals(catalog?.signals ?? []);
    const filtered = bitmask ? intersectWithSupport(all, bitmask) : all;
    for (const s of filtered) {
      const cat = s.category || "Other";
      if (!out[cat]) out[cat] = [];
      out[cat].push(s);
    }
    return out;
  }, [catalog, bitmask]);

  // ---------- Toggle handlers ----------
  function persistSelection(next: Set<string>) {
    if (!vehicleReady) return;
    saveSelectedCodes(
      vehicle.make,
      vehicle.model,
      vehicle.year,
      Array.from(next),
    ).catch(() => {});
  }

  function toggleCode(code: string) {
    setSelectedCodes((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      persistSelection(next);
      return next;
    });
  }

  function selectAllInCategory(category: string) {
    setSelectedCodes((prev) => {
      const next = new Set(prev);
      for (const s of signalsByCategory[category] ?? []) {
        if (s.code && !unsupported.has(s.code)) next.add(s.code);
      }
      persistSelection(next);
      return next;
    });
  }

  function clearAllInCategory(category: string) {
    setSelectedCodes((prev) => {
      const next = new Set(prev);
      for (const s of signalsByCategory[category] ?? []) {
        if (s.code) next.delete(s.code);
      }
      persistSelection(next);
      return next;
    });
  }

  // ---------- Presets ----------
  async function onSavePreset() {
    const name = presetName.trim();
    if (!name || selectedCodes.size === 0) return;
    const created = await createPreset(name, Array.from(selectedCodes));
    setPresets((prev) => [...prev, created]);
    setPresetName("");
    setPresetModalOpen(false);
  }

  function applyPreset(preset: PidPreset) {
    // Only apply codes that exist in this vehicle's catalog and aren't
    // marked unsupported.
    if (!catalog) return;
    const knownCodes = new Set(catalog.signals.map((s) => s.code));
    const next = new Set(
      preset.pidCodes.filter((c) => knownCodes.has(c) && !unsupported.has(c)),
    );
    setSelectedCodes(next);
    persistSelection(next);
    const missing = preset.pidCodes.length - next.size;
    if (missing > 0) {
      Alert.alert(
        "Preset applied",
        `${next.size} of ${preset.pidCodes.length} PIDs applied — ${missing} aren't supported by this vehicle.`,
      );
    }
  }

  async function onDeletePreset(preset: PidPreset) {
    await deletePreset(preset.id);
    setPresets((prev) => prev.filter((p) => p.id !== preset.id));
  }

  // ---------- Apply on done ----------
  function onDone() {
    if (catalog) {
      const byCode = new Map(catalog.signals.map((s) => [s.code, s]));
      const descriptors: PidDescriptor[] = [];
      for (const code of selectedCodes) {
        const sig = byCode.get(code);
        if (sig && !unsupported.has(code)) descriptors.push(sig);
      }
      obd2.setSelectedPids(descriptors);
    }
    router.back();
  }

  // ---------- Render ----------

  if (!vehicleReady) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <Navbar showBack />
        <View style={styles.emptyWrap}>
          <Ionicons name="car-outline" size={32} color={colors.muted} />
          <Text style={styles.emptyTitle}>No vehicle connected</Text>
          <Text style={styles.emptyBody}>
            Connect an OBD2 adapter on the OBD2 Scan screen so Vulcan can
            identify the vehicle and load its supported PIDs.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  if (loading && !catalog) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <Navbar showBack />
        <View style={styles.emptyWrap}>
          <ActivityIndicator size="small" color={colors.accent} />
          <Text style={styles.emptyTitle}>Loading PIDs…</Text>
        </View>
      </SafeAreaView>
    );
  }

  // Drilled-in: per-category PID picker
  if (drillCategory) {
    const list = signalsByCategory[drillCategory] ?? [];
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <Navbar showBack />
        <View style={styles.subhead}>
          <TouchableOpacity
            style={styles.backBtn}
            onPress={() => setDrillCategory(null)}
            activeOpacity={0.7}
          >
            <Ionicons name="chevron-back" size={20} color={colors.accent} />
            <Text style={styles.backBtnText}>Categories</Text>
          </TouchableOpacity>
          <Text style={styles.subheadTitle}>{drillCategory}</Text>
          <TouchableOpacity style={styles.doneBtn} onPress={onDone} activeOpacity={0.7}>
            <Text style={styles.doneBtnText}>Done</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.categoryBulkBar}>
          <TouchableOpacity
            style={styles.bulkBtn}
            onPress={() => selectAllInCategory(drillCategory)}
            activeOpacity={0.7}
          >
            <Text style={styles.bulkBtnText}>Select all</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.bulkBtn}
            onPress={() => clearAllInCategory(drillCategory)}
            activeOpacity={0.7}
          >
            <Text style={styles.bulkBtnText}>Clear all</Text>
          </TouchableOpacity>
        </View>

        <FlatList
          data={list}
          // Belt-and-suspenders unique key: signal `id` is unique within
          // a catalog, `code` is only unique post-dedupe. Fall back to a
          // composite if neither is present.
          keyExtractor={(item) => item.id ?? item.code ?? `${item.name}-${item.command?.mode}-${item.command?.pid}`}
          renderItem={({ item }) => {
            const code = item.code ?? "";
            const checked = selectedCodes.has(code);
            const unsup = unsupported.has(code);
            return (
              <TouchableOpacity
                style={[styles.pidRow, unsup && styles.pidRowDisabled]}
                onPress={() => !unsup && toggleCode(code)}
                disabled={unsup}
                activeOpacity={0.6}
              >
                <View style={[styles.checkbox, checked && styles.checkboxChecked]}>
                  {checked ? (
                    <Ionicons name="checkmark" size={16} color="#FFFFFF" />
                  ) : null}
                </View>
                <View style={styles.pidRowText}>
                  <Text style={styles.pidName} numberOfLines={1}>
                    {item.name}
                  </Text>
                  <Text style={styles.pidMeta} numberOfLines={1}>
                    {code}
                    {item.unit ? ` · ${item.unit}` : ""}
                    {item.max != null ? ` · ${item.min}–${item.max}` : ""}
                    {unsup ? " · UNSUPPORTED" : ""}
                  </Text>
                </View>
              </TouchableOpacity>
            );
          }}
          ListEmptyComponent={
            <View style={styles.emptyWrap}>
              <Text style={styles.emptyBody}>
                No PIDs available in this category for this vehicle.
              </Text>
            </View>
          }
        />
      </SafeAreaView>
    );
  }

  // Top-level: category list + presets
  const categories = catalog?.categories ?? [];

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <Navbar showBack />
      <View style={styles.subhead}>
        <Text style={styles.subheadTitle}>PIDs</Text>
        <TouchableOpacity style={styles.doneBtn} onPress={onDone} activeOpacity={0.7}>
          <Text style={styles.doneBtnText}>Done</Text>
        </TouchableOpacity>
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.sectionLabel}>CATEGORIES</Text>
        <Text style={styles.bodyDim}>
          {selectedCodes.size} PID{selectedCodes.size === 1 ? "" : "s"} selected
        </Text>
        {categories.map((cat) => {
          const list = signalsByCategory[cat] ?? [];
          const selectedInCat = list.filter((s) =>
            s.code ? selectedCodes.has(s.code) : false,
          ).length;
          if (list.length === 0) return null;
          return (
            <TouchableOpacity
              key={cat}
              style={styles.categoryRow}
              onPress={() => setDrillCategory(cat)}
              activeOpacity={0.6}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.categoryName}>{cat}</Text>
                <Text style={styles.categoryMeta}>
                  {selectedInCat} of {list.length} selected
                </Text>
              </View>
              <Ionicons
                name="chevron-forward"
                size={20}
                color={colors.muted}
              />
            </TouchableOpacity>
          );
        })}

        <Text style={[styles.sectionLabel, { marginTop: 24 }]}>PRESETS</Text>
        <TouchableOpacity
          style={styles.savePresetBtn}
          onPress={() => setPresetModalOpen(true)}
          disabled={selectedCodes.size === 0}
          activeOpacity={0.7}
        >
          <Ionicons name="bookmark-outline" size={16} color={colors.accent} />
          <Text style={styles.savePresetBtnText}>
            Save current selection as preset
          </Text>
        </TouchableOpacity>
        {presets.map((p) => (
          <View key={p.id} style={styles.presetRow}>
            <TouchableOpacity
              style={styles.presetMain}
              onPress={() => applyPreset(p)}
              activeOpacity={0.6}
            >
              <Text style={styles.presetName}>{p.name}</Text>
              <Text style={styles.presetMeta}>{p.pidCodes.length} PIDs</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() =>
                Alert.alert("Delete preset?", p.name, [
                  { text: "Cancel", style: "cancel" },
                  {
                    text: "Delete",
                    style: "destructive",
                    onPress: () => onDeletePreset(p),
                  },
                ])
              }
              activeOpacity={0.6}
              style={styles.presetDeleteBtn}
            >
              <Ionicons name="trash-outline" size={18} color={colors.dangerText} />
            </TouchableOpacity>
          </View>
        ))}
      </ScrollView>

      <Modal
        visible={presetModalOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setPresetModalOpen(false)}
      >
        <View style={styles.modalBg}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Save preset</Text>
            <Text style={styles.modalSub}>
              {selectedCodes.size} PID{selectedCodes.size === 1 ? "" : "s"} will be saved
            </Text>
            <TextInput
              value={presetName}
              onChangeText={setPresetName}
              placeholder="e.g. Misfire diagnosis"
              placeholderTextColor={colors.muted}
              style={styles.modalInput}
              autoFocus
            />
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.modalBtn, styles.modalBtnSecondary]}
                onPress={() => {
                  setPresetName("");
                  setPresetModalOpen(false);
                }}
                activeOpacity={0.7}
              >
                <Text style={styles.modalBtnSecondaryText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.modalBtn,
                  styles.modalBtnPrimary,
                  presetName.trim().length === 0 && styles.modalBtnDisabled,
                ]}
                onPress={onSavePreset}
                disabled={presetName.trim().length === 0}
                activeOpacity={0.85}
              >
                <Text style={styles.modalBtnPrimaryText}>Save</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  subhead: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
    gap: 8,
  },
  subheadTitle: {
    flex: 1,
    color: colors.heading,
    fontSize: 16,
    fontWeight: "600",
  },
  backBtn: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: HIT_TARGET - 12,
    paddingRight: 8,
    gap: 2,
  },
  backBtnText: { color: colors.accent, fontSize: 15, fontWeight: "600" },
  doneBtn: {
    minHeight: HIT_TARGET - 12,
    minWidth: HIT_TARGET,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: colors.accent,
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center",
  },
  doneBtnText: { color: "#FFFFFF", fontSize: 14, fontWeight: "600" },
  content: { padding: 16, gap: 8, paddingBottom: 48 },
  sectionLabel: {
    color: colors.accent,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1.8,
    marginTop: 4,
  },
  bodyDim: { color: colors.muted, fontSize: 13, marginBottom: 8 },
  categoryRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 14,
    minHeight: HIT_TARGET,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 8,
  },
  categoryName: { color: colors.heading, fontSize: 15, fontWeight: "600" },
  categoryMeta: { color: colors.muted, fontSize: 12, marginTop: 2 },
  categoryBulkBar: {
    flexDirection: "row",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
  },
  bulkBtn: {
    minHeight: HIT_TARGET - 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.accent,
    backgroundColor: colors.accentFade,
    alignItems: "center",
    justifyContent: "center",
  },
  bulkBtnText: { color: colors.accent, fontSize: 13, fontWeight: "600" },
  pidRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    minHeight: HIT_TARGET,
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
  },
  pidRowDisabled: { opacity: 0.4 },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 4,
    borderWidth: StyleSheet.hairlineWidth + 0.5,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxChecked: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  pidRowText: { flex: 1, gap: 2 },
  pidName: { color: colors.heading, fontSize: 14, fontWeight: "600" },
  pidMeta: { color: colors.muted, fontSize: 11, fontFamily: "Menlo" },
  savePresetBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: HIT_TARGET,
    paddingHorizontal: 14,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.accent,
    backgroundColor: colors.accentFade,
    marginTop: 4,
  },
  savePresetBtnText: { color: colors.accent, fontSize: 14, fontWeight: "600" },
  presetRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 12,
    minHeight: HIT_TARGET,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 8,
  },
  presetMain: { flex: 1, gap: 2 },
  presetName: { color: colors.heading, fontSize: 14, fontWeight: "600" },
  presetMeta: { color: colors.muted, fontSize: 11 },
  presetDeleteBtn: {
    minWidth: HIT_TARGET,
    minHeight: HIT_TARGET,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyWrap: {
    flex: 1,
    padding: 32,
    gap: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyTitle: {
    color: colors.heading,
    fontSize: 16,
    fontWeight: "600",
  },
  emptyBody: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 19,
    textAlign: "center",
  },
  modalBg: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.4)",
    justifyContent: "center",
    padding: 24,
  },
  modalCard: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 18,
    gap: 12,
  },
  modalTitle: { color: colors.heading, fontSize: 16, fontWeight: "700" },
  modalSub: { color: colors.muted, fontSize: 13 },
  modalInput: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: colors.text,
    backgroundColor: colors.surface2,
  },
  modalActions: { flexDirection: "row", gap: 10 },
  modalBtn: {
    flex: 1,
    minHeight: HIT_TARGET,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  modalBtnSecondary: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface2,
  },
  modalBtnSecondaryText: { color: colors.text, fontSize: 14, fontWeight: "600" },
  modalBtnPrimary: { backgroundColor: colors.accent },
  modalBtnPrimaryText: { color: "#FFFFFF", fontSize: 14, fontWeight: "600" },
  modalBtnDisabled: { opacity: 0.4 },
});
