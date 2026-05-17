import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import InspectionItemRow from "../components/InspectionItemRow";
import Navbar from "../components/Navbar";
import VehicleBar from "../components/VehicleBar";
import VinScanner from "../components/VinScanner";
import { VinDecodeError, decodeVin, isLikelyVin } from "../lib/api";
import {
  INSPECTION_TEMPLATE,
  SHOP_PLACEHOLDER,
  buildEmptyItems,
  buildInspectionHtml,
  clearDraft,
  countByStatus,
  loadDraft,
  saveDraft,
  totalItemCount,
} from "../lib/inspection";
import {
  type InspectionRecord,
  makeRecordId,
  saveRecord,
} from "../lib/records";
import { fetchTsbs } from "../lib/tsbs";
import { HIT_TARGET, colors } from "../lib/theme";
import type {
  InspectionItems,
  ItemStatus,
  Tsb,
  VehicleInfo,
} from "../lib/types";

const EMPTY_VEHICLE: VehicleInfo = {
  year: "",
  make: "",
  model: "",
  trim: "",
  engineType: "",
  mileage: "",
};

type Phase = "intake" | "checklist" | "done";

export default function Screen() {
  const [phase, setPhase] = useState<Phase>("intake");
  const [vehicle, setVehicle] = useState<VehicleInfo>(EMPTY_VEHICLE);
  const [vin, setVin] = useState("");
  const [items, setItems] = useState<InspectionItems>(buildEmptyItems);
  const [draftLoaded, setDraftLoaded] = useState(false);

  const [scannerOpen, setScannerOpen] = useState(false);
  const [decoding, setDecoding] = useState(false);
  const [decodeError, setDecodeError] = useState<string | null>(null);
  const [decoded, setDecoded] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const lastDecodedRef = useRef<string>("");

  const [generating, setGenerating] = useState(false);
  const [shareUri, setShareUri] = useState<string | null>(null);

  const [tsbs, setTsbs] = useState<Tsb[]>([]);
  const lastTsbKeyRef = useRef<string>("");

  // Restore draft on mount, if one exists.
  useEffect(() => {
    let active = true;
    loadDraft().then((draft) => {
      if (!active) return;
      if (draft) {
        setVehicle(draft.vehicle);
        setVin(draft.vin);
        setItems(draft.items);
        setPhase(draft.phase);
        if (draft.vehicle.year && draft.vehicle.make && draft.vehicle.model) {
          setDecoded(true);
        }
      }
      setDraftLoaded(true);
    });
    return () => {
      active = false;
    };
  }, []);

  // Auto-save draft on changes (debounced) once initial load has finished.
  useEffect(() => {
    if (!draftLoaded) return;
    if (phase === "done") return;
    const t = setTimeout(() => {
      void saveDraft({ vehicle, vin, items, phase });
    }, 400);
    return () => clearTimeout(t);
  }, [draftLoaded, phase, vehicle, vin, items]);

  // VIN decode effect — same pattern as troubleshoot.
  useEffect(() => {
    const trimmed = vin.trim().toUpperCase();
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
        setVehicle((v) => ({
          ...v,
          year: d.year || v.year,
          make: d.make || v.make,
          model: d.model || v.model,
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
  }, [vin]);

  // Background TSB fetch when the vehicle is known. Failures silently
  // resolve to [] — TSB enrichment is optional, never blocks the inspection.
  useEffect(() => {
    const y = vehicle.year.trim();
    const m = vehicle.make.trim();
    const mo = vehicle.model.trim();
    if (!y || !m || !mo) {
      setTsbs([]);
      lastTsbKeyRef.current = "";
      return;
    }
    const key = `${y}|${m.toLowerCase()}|${mo.toLowerCase()}`;
    if (lastTsbKeyRef.current === key) return;
    lastTsbKeyRef.current = key;
    let cancelled = false;
    fetchTsbs(y, m, mo)
      .then((ts) => {
        if (!cancelled) setTsbs(ts);
      })
      .catch(() => {
        if (!cancelled) setTsbs([]);
      });
    return () => {
      cancelled = true;
    };
  }, [vehicle.year, vehicle.make, vehicle.model]);

  const counts = useMemo(() => countByStatus(items), [items]);
  const total = totalItemCount();

  function updateVehicle<K extends keyof VehicleInfo>(
    field: K,
    value: VehicleInfo[K],
  ) {
    setVehicle((v) => ({ ...v, [field]: value }));
  }

  function setItemStatus(itemId: string, status: ItemStatus) {
    setItems((prev) => ({
      ...prev,
      [itemId]: { ...prev[itemId], status },
    }));
  }

  function setItemNotes(itemId: string, notes: string) {
    setItems((prev) => ({
      ...prev,
      [itemId]: { ...prev[itemId], notes },
    }));
  }

  async function capturePhotoFor(itemId: string) {
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) {
        Alert.alert(
          "Camera access required",
          "Enable camera permission in Settings to attach photos.",
        );
        return;
      }
      const result = await ImagePicker.launchCameraAsync({
        quality: 0.7,
        allowsEditing: false,
      });
      if (!result.canceled && result.assets?.[0]) {
        setItems((prev) => ({
          ...prev,
          [itemId]: { ...prev[itemId], photoUri: result.assets[0].uri },
        }));
      }
    } catch (err) {
      console.warn("[inspection] photo capture failed:", err);
      Alert.alert("Couldn't capture photo", "Try again.");
    }
  }

  function removePhotoFor(itemId: string) {
    setItems((prev) => ({
      ...prev,
      [itemId]: { ...prev[itemId], photoUri: undefined },
    }));
  }

  function intakeValid(): boolean {
    return (
      vehicle.year.trim().length > 0 &&
      vehicle.make.trim().length > 0 &&
      vehicle.model.trim().length > 0 &&
      vehicle.mileage.trim().length > 0
    );
  }

  function onBeginInspection() {
    if (!intakeValid()) return;
    setPhase("checklist");
  }

  function handleVinScanned(scanned: string) {
    setVin(scanned);
    setScannerOpen(false);
  }

  async function onGenerateReport() {
    if (counts.completed === 0) {
      Alert.alert(
        "Nothing to report",
        "Mark at least one item before generating.",
      );
      return;
    }
    setGenerating(true);
    try {
      const dateStr = new Date().toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
      const html = buildInspectionHtml({
        shop: SHOP_PLACEHOLDER,
        vehicle,
        vin: vin.trim() || undefined,
        mileage: vehicle.mileage,
        items,
        date: dateStr,
        tsbs,
      });
      const { uri } = await Print.printToFileAsync({ html });

      const record: InspectionRecord = {
        type: "inspection",
        id: makeRecordId(),
        date: new Date().toISOString(),
        vehicle,
        vin: vin.trim() || undefined,
        mileage: vehicle.mileage,
        items,
        tsbs,
      };
      try {
        await saveRecord(record);
      } catch (err) {
        console.warn("[inspection] saveRecord failed:", err);
      }

      await clearDraft();
      setShareUri(uri);
      setPhase("done");

      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, {
          mimeType: "application/pdf",
          UTI: "com.adobe.pdf",
          dialogTitle: "Share inspection report",
        });
      }
    } catch (err) {
      console.warn("[inspection] generate failed:", err);
      Alert.alert(
        "Couldn't generate report",
        "Something went wrong. Try again.",
      );
    } finally {
      setGenerating(false);
    }
  }

  async function onShareAgain() {
    if (!shareUri) return;
    try {
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(shareUri, {
          mimeType: "application/pdf",
          UTI: "com.adobe.pdf",
          dialogTitle: "Share inspection report",
        });
      }
    } catch (err) {
      console.warn("[inspection] share failed:", err);
    }
  }

  function resetSession() {
    setPhase("intake");
    setVehicle(EMPTY_VEHICLE);
    setVin("");
    setItems(buildEmptyItems());
    setDecoded(false);
    setDecodeError(null);
    setManualOpen(false);
    setShareUri(null);
    lastDecodedRef.current = "";
    void clearDraft();
  }

  // ---------- Intake phase ----------
  if (phase === "intake") {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <Navbar showBack />
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <ScrollView
            contentContainerStyle={styles.intakeContent}
            keyboardShouldPersistTaps="handled"
          >
            <Text style={styles.h1}>Inspection</Text>
            <Text style={styles.subtitle}>
              Identify the vehicle to begin a multi-point inspection.
            </Text>

            <View style={styles.card}>
              <Text style={styles.label}>VIN</Text>
              <View style={styles.vinRow}>
                <TextInput
                  style={[styles.input, styles.vinInput]}
                  value={vin}
                  onChangeText={(v) =>
                    setVin(v.replace(/[^A-Za-z0-9]/g, "").toUpperCase())
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
                  accessibilityLabel="Scan VIN with camera"
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
                <View style={[styles.errorBox, styles.errorBoxTight]}>
                  <Text style={styles.errorText}>{decodeError}</Text>
                </View>
              )}

              {decoded && !decoding && (
                <View style={styles.decodedBox}>
                  <Text style={styles.decodedLabel}>DECODED</Text>
                  <Text style={styles.decodedLine}>
                    {[vehicle.year, vehicle.make, vehicle.model]
                      .filter((s) => s && s.length > 0)
                      .join(" ") || "(no values returned)"}
                  </Text>
                  {vehicle.trim ? (
                    <Text style={styles.decodedSub}>Trim: {vehicle.trim}</Text>
                  ) : null}
                  {vehicle.engineType ? (
                    <Text style={styles.decodedSub}>
                      Engine: {vehicle.engineType}
                    </Text>
                  ) : null}
                </View>
              )}

              <View style={styles.singleField}>
                <Text style={styles.label}>MILEAGE</Text>
                <TextInput
                  style={styles.input}
                  value={vehicle.mileage}
                  onChangeText={(v) => updateVehicle("mileage", v)}
                  placeholder="98,500"
                  placeholderTextColor={colors.muted}
                  keyboardType="number-pad"
                />
              </View>

              <TouchableOpacity
                style={styles.disclosureBtn}
                onPress={() => setManualOpen((m) => !m)}
                activeOpacity={0.7}
                accessibilityLabel="Toggle manual vehicle entry"
              >
                <Text style={styles.disclosureText}>
                  {manualOpen ? "▾  " : "▸  "}Enter vehicle info manually
                  instead
                </Text>
              </TouchableOpacity>

              {manualOpen && (
                <View style={styles.manualBox}>
                  <View style={styles.row3}>
                    <ManualField
                      label="Year"
                      value={vehicle.year}
                      onChangeText={(v) => updateVehicle("year", v)}
                      placeholder="2015"
                      keyboardType="number-pad"
                    />
                    <ManualField
                      label="Make"
                      value={vehicle.make}
                      onChangeText={(v) => updateVehicle("make", v)}
                      placeholder="Toyota"
                      autoCapitalize="words"
                    />
                    <ManualField
                      label="Model"
                      value={vehicle.model}
                      onChangeText={(v) => updateVehicle("model", v)}
                      placeholder="Camry"
                      autoCapitalize="words"
                    />
                  </View>
                  <View style={styles.row2}>
                    <ManualField
                      label="Trim Level"
                      value={vehicle.trim ?? ""}
                      onChangeText={(v) => updateVehicle("trim", v)}
                      placeholder="LE, XSE, TRD"
                    />
                    <ManualField
                      label="Engine Type"
                      value={vehicle.engineType ?? ""}
                      onChangeText={(v) => updateVehicle("engineType", v)}
                      placeholder="2.5L 4-cyl, 3.5L V6"
                    />
                  </View>
                </View>
              )}

              <TouchableOpacity
                style={[
                  styles.submit,
                  !intakeValid() && styles.submitDisabled,
                ]}
                onPress={onBeginInspection}
                disabled={!intakeValid()}
                activeOpacity={0.85}
              >
                <Text style={styles.submitText}>Begin inspection</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>

        <VinScanner
          visible={scannerOpen}
          onClose={() => setScannerOpen(false)}
          onScanned={handleVinScanned}
        />
      </SafeAreaView>
    );
  }

  // ---------- Done phase ----------
  if (phase === "done") {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <Navbar showBack />
        <View style={styles.doneWrap}>
          <View style={styles.doneIconWrap}>
            <Ionicons name="checkmark" size={48} color="#FFFFFF" />
          </View>
          <Text style={styles.doneTitle}>Inspection saved</Text>
          <Text style={styles.doneBody}>
            The report PDF has been generated and the inspection is in Records.
          </Text>
          {shareUri && (
            <TouchableOpacity
              style={styles.shareBtn}
              onPress={onShareAgain}
              activeOpacity={0.85}
            >
              <Ionicons
                name="share-outline"
                size={18}
                color="#FFFFFF"
                style={{ marginRight: 8 }}
              />
              <Text style={styles.submitText}>Share PDF again</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={styles.newBtn}
            onPress={resetSession}
            activeOpacity={0.85}
          >
            <Text style={styles.newBtnText}>Start new inspection</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // ---------- Checklist phase ----------
  const progressPct =
    total > 0 ? Math.round((counts.completed / total) * 100) : 0;

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <Navbar showBack />
      <VehicleBar vehicle={vehicle} onReset={resetSession} />

      <View style={styles.progressBlock}>
        <View style={styles.progressHeader}>
          <Text style={styles.progressText}>
            {counts.completed} of {total} items inspected
          </Text>
          <Text style={styles.progressPct}>{progressPct}%</Text>
        </View>
        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: `${progressPct}%` }]} />
        </View>
        <View style={styles.miniCounts}>
          <CountChip label="Good" count={counts.good} kind="good" />
          <CountChip
            label="Attention"
            count={counts.attention}
            kind="attention"
          />
          <CountChip label="Urgent" count={counts.urgent} kind="urgent" />
        </View>
      </View>

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.checklistContent}
          keyboardShouldPersistTaps="handled"
        >
          {INSPECTION_TEMPLATE.map((section) => (
            <View key={section.id} style={styles.section}>
              <Text style={styles.sectionTitle}>{section.title}</Text>
              <View style={styles.sectionCard}>
                {section.items.map((def) => (
                  <InspectionItemRow
                    key={def.id}
                    label={def.label}
                    item={
                      items[def.id] ?? {
                        status: null,
                        notes: "",
                      }
                    }
                    onStatusChange={(s) => setItemStatus(def.id, s)}
                    onNotesChange={(n) => setItemNotes(def.id, n)}
                    onCapturePhoto={() => capturePhotoFor(def.id)}
                    onRemovePhoto={() => removePhotoFor(def.id)}
                  />
                ))}
              </View>
            </View>
          ))}
        </ScrollView>

        <SafeAreaView edges={["bottom"]} style={styles.footerBar}>
          <TouchableOpacity
            style={[
              styles.generateBtn,
              (generating || counts.completed === 0) && styles.submitDisabled,
            ]}
            onPress={onGenerateReport}
            disabled={generating || counts.completed === 0}
            activeOpacity={0.85}
            accessibilityLabel="Generate inspection PDF report"
          >
            {generating ? (
              <ActivityIndicator size="small" color="#FFFFFF" />
            ) : (
              <Text style={styles.submitText}>Generate Report</Text>
            )}
          </TouchableOpacity>
        </SafeAreaView>
      </KeyboardAvoidingView>
    </SafeAreaView>
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
    <View style={styles.field}>
      <Text style={styles.label}>{label.toUpperCase()}</Text>
      <TextInput
        style={styles.input}
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

function CountChip({
  label,
  count,
  kind,
}: {
  label: string;
  count: number;
  kind: "good" | "attention" | "urgent";
}) {
  const palette =
    kind === "good"
      ? { bg: colors.okBg, border: colors.okBorder, text: colors.okText }
      : kind === "attention"
        ? { bg: colors.warnBg, border: colors.warnBorder, text: colors.warnText }
        : {
            bg: colors.dangerBg,
            border: colors.dangerBorder,
            text: colors.dangerText,
          };
  return (
    <View
      style={[
        styles.chip,
        { backgroundColor: palette.bg, borderColor: palette.border },
      ]}
    >
      <Text style={[styles.chipText, { color: palette.text }]}>
        {count} {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  flex: {
    flex: 1,
  },

  // intake
  intakeContent: {
    paddingHorizontal: 20,
    paddingTop: 24,
    paddingBottom: 48,
  },
  h1: {
    fontSize: 26,
    fontWeight: "600",
    color: colors.heading,
    marginBottom: 6,
    letterSpacing: -0.3,
  },
  subtitle: {
    color: colors.muted,
    fontSize: 14,
    marginBottom: 24,
    lineHeight: 21,
  },
  card: {
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 8,
    padding: 16,
  },
  row3: {
    flexDirection: "row",
    gap: 10,
  },
  row2: {
    flexDirection: "row",
    gap: 10,
  },
  field: {
    flex: 1,
    marginBottom: 14,
  },
  singleField: {
    marginTop: 14,
    marginBottom: 0,
  },
  label: {
    fontSize: 11,
    fontWeight: "500",
    color: colors.muted,
    letterSpacing: 0.7,
    marginBottom: 6,
  },
  input: {
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
  vinRow: {
    flexDirection: "row",
    gap: 10,
    alignItems: "stretch",
  },
  vinInput: {
    flex: 1,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    letterSpacing: 1,
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
    letterSpacing: 0.3,
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
    paddingHorizontal: 4,
    justifyContent: "center",
  },
  disclosureText: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: "600",
    letterSpacing: 0.3,
  },
  manualBox: {
    marginTop: 4,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  submit: {
    marginTop: 18,
    minHeight: HIT_TARGET,
    backgroundColor: colors.accent,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 18,
  },
  submitDisabled: {
    opacity: 0.45,
  },
  submitText: {
    color: "#FFFFFF",
    fontSize: 15,
    fontWeight: "600",
    letterSpacing: 0.2,
  },
  errorBox: {
    marginTop: 12,
    backgroundColor: colors.dangerBg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.dangerBorder,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 6,
  },
  errorBoxTight: {
    marginTop: 10,
  },
  errorText: {
    color: colors.dangerText,
    fontSize: 13,
  },

  // checklist progress
  progressBlock: {
    backgroundColor: colors.surface,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    gap: 10,
  },
  progressHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
  },
  progressText: {
    color: colors.text,
    fontSize: 13,
    fontWeight: "600",
  },
  progressPct: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: "700",
  },
  progressTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.border,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    backgroundColor: colors.accent,
    borderRadius: 3,
  },
  miniCounts: {
    flexDirection: "row",
    gap: 6,
  },
  chip: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
  },
  chipText: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.3,
  },

  // checklist body
  checklistContent: {
    padding: 16,
    paddingBottom: 32,
    gap: 18,
  },
  section: {
    gap: 8,
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1.8,
    color: colors.accent,
    paddingLeft: 2,
  },
  sectionCard: {
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 14,
  },

  // footer
  footerBar: {
    backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
  },
  generateBtn: {
    minHeight: HIT_TARGET,
    backgroundColor: colors.accent,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 18,
  },

  // done
  doneWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
    gap: 12,
  },
  doneIconWrap: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: "#16A34A",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  doneTitle: {
    color: colors.heading,
    fontSize: 22,
    fontWeight: "700",
    letterSpacing: -0.2,
  },
  doneBody: {
    color: colors.muted,
    fontSize: 14,
    textAlign: "center",
    lineHeight: 21,
    marginBottom: 12,
  },
  shareBtn: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: HIT_TARGET,
    paddingHorizontal: 20,
    backgroundColor: colors.accent,
    borderRadius: 10,
  },
  newBtn: {
    minHeight: HIT_TARGET,
    paddingHorizontal: 20,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  newBtnText: {
    color: colors.text,
    fontWeight: "600",
    fontSize: 15,
  },
});
