import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { useObd2 } from "../contexts/Obd2Context";
import { EMPTY_VEHICLE, useVehicle } from "../contexts/VehicleContext";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import Navbar from "../components/Navbar";
import PhotoThumb from "../components/PhotoThumb";
import VehicleBar from "../components/VehicleBar";
import VinScanner from "../components/VinScanner";
import {
  DiagnoseError,
  VinDecodeError,
  ask,
  decodeVin,
  isLikelyVin,
} from "../lib/api";
import { consumeHandoff, setHandoff } from "../lib/handoff";
import { diagnosticLogger } from "../lib/diagnosticLogger";
import { persistPhoto, pickAndResize, withoutBase64 } from "../lib/photoEvidence";
import { HIT_TARGET, colors } from "../lib/theme";
import type {
  ChatMessage,
  ImageAttachment,
  VehicleInfo,
} from "../lib/types";

export default function AskScreen() {
  const router = useRouter();
  const { isConnected: obdConnected } = useObd2();
  const {
    vehicle,
    vin,
    recalls,
    tsbs,
    setVehicleManually,
    clearVehicle,
  } = useVehicle();
  // hasVehicle is derived from the global vehicle: any year/make/model
  // triple counts as a usable vehicle context for the Ask API.
  const hasVehicle = Boolean(
    vehicle.year?.trim() && vehicle.make?.trim() && vehicle.model?.trim(),
  );
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Photo Evidence: a photo staged in the composer before Send, a flag while the
  // picker is open, and the transient base64 of the most recently attached photo
  // — injected into the ONE outgoing request, never re-uploaded (lean history).
  const [pendingPhoto, setPendingPhoto] = useState<ImageAttachment | null>(null);
  const [attaching, setAttaching] = useState(false);
  const pendingPhotoBase64Ref = useRef<string | null>(null);

  const [vehicleModalOpen, setVehicleModalOpen] = useState(false);
  const listRef = useRef<FlatList<ChatMessage> | null>(null);
  const insets = useSafeAreaInsets();
  // Header chrome height (used for the iOS KAV offset).
  const [headerHeight, setHeaderHeight] = useState(0);
  // Manual Android keyboard tracking — KeyboardAvoidingView is unreliable
  // on Android with newArch, so we listen to the Keyboard API directly and
  // apply paddingBottom equal to the keyboard height.
  const [androidKbHeight, setAndroidKbHeight] = useState(0);

  // Auto-scroll on keyboard open + capture keyboard height for Android.
  useEffect(() => {
    const showSub = Keyboard.addListener("keyboardDidShow", (e) => {
      if (Platform.OS === "android") {
        setAndroidKbHeight(e.endCoordinates.height);
      }
      setTimeout(() => {
        listRef.current?.scrollToEnd({ animated: true });
      }, 60);
    });
    const hideSub = Keyboard.addListener("keyboardDidHide", () => {
      if (Platform.OS === "android") setAndroidKbHeight(0);
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  // Consume a handoff from Diagnose on mount (if present). The handoff's
  // vehicle and message thread come in here; recalls/TSBs are managed by
  // the VehicleContext now, so we only seed those from the handoff if the
  // global vehicle isn't already populated.
  useEffect(() => {
    let active = true;
    consumeHandoff("to_ask").then((h) => {
      if (!active || !h) return;
      if (h.vehicle && !hasVehicle) {
        setVehicleManually({ ...EMPTY_VEHICLE, ...h.vehicle }, h.vin ?? null).catch(
          () => {},
        );
      }
      if (h.messages) setMessages(h.messages);
    });
    return () => {
      active = false;
    };
    // Intentionally only on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (messages.length === 0) return;
    const id = setTimeout(() => {
      listRef.current?.scrollToEnd({ animated: true });
    }, 50);
    return () => clearTimeout(id);
  }, [messages.length, loading]);

  // Offer camera vs library → pick → resize → durable-persist. Returns an
  // ImageAttachment (durable uri + transient base64) or null (all fail-soft).
  // Reuses the mode-agnostic lib/photoEvidence.ts shipped with Diagnose.
  function chooseSource(): Promise<"camera" | "library" | null> {
    return new Promise((resolve) => {
      Alert.alert("Add a photo", undefined, [
        { text: "Take Photo", onPress: () => resolve("camera") },
        { text: "Choose from Library", onPress: () => resolve("library") },
        { text: "Cancel", style: "cancel", onPress: () => resolve(null) },
      ]);
    });
  }

  async function attachPhoto(): Promise<ImageAttachment | null> {
    const source = await chooseSource();
    if (!source) return null;
    setAttaching(true);
    try {
      const picked = await pickAndResize(source);
      if (!picked) return null;
      const uri = await persistPhoto(picked.uri);
      return { ...picked, uri };
    } finally {
      setAttaching(false);
    }
  }

  async function onComposerAttach() {
    const photo = await attachPhoto();
    if (photo) setPendingPhoto(photo);
  }

  async function send(text: string, image?: ImageAttachment | null) {
    const trimmed = text.trim();
    if ((!trimmed && !image) || loading) return;
    const content = trimmed || (image ? "Photo attached" : "");
    // Persist the message WITHOUT base64 (bytes are transient); the base64 is
    // injected into the outgoing request's final image turn only.
    const stored: ChatMessage = image
      ? { role: "user", content, image: withoutBase64(image) }
      : { role: "user", content };
    const next: ChatMessage[] = [...messages, stored];
    setMessages(next);
    setDraft("");
    setPendingPhoto(null);
    pendingPhotoBase64Ref.current = image?.base64 ?? null;
    setLoading(true);
    setError(null);
    // Inject the transient base64 into the LAST user turn (the attach turn) of
    // a local clone — sent on THIS ask only. The server's buildTurnContent emits
    // the image block for that turn and a text placeholder for any prior photo
    // turn (no base64), so bytes ride exactly once across asks (lean history).
    let outgoing = next;
    if (pendingPhotoBase64Ref.current) {
      const b64 = pendingPhotoBase64Ref.current;
      outgoing = next.map((m, i) =>
        i === next.length - 1 && m.image
          ? { ...m, image: { ...m.image, base64: b64 } }
          : m,
      );
    }
    try {
      const reply = await ask(
        outgoing,
        hasVehicle ? vehicle : undefined,
        recalls,
        tsbs,
        diagnosticLogger.getCurrentSessionId(),
      );
      setMessages([...next, { role: "assistant", content: reply.text }]);
      if (reply.cost) {
        diagnosticLogger.log({
          type: "ask_vulcan",
          vehicle: hasVehicle
            ? { year: vehicle.year, make: vehicle.make, model: vehicle.model, vin: vin ?? null }
            : undefined,
          callType: "ask-vulcan",
          queryText: trimmed.slice(0, 80),
          apiCost: reply.cost,
        });
      }
    } catch (err) {
      const msg =
        err instanceof DiagnoseError
          ? err.message
          : "Unexpected error. Try again.";
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  function resetVehicle() {
    clearVehicle().catch(() => {});
  }

  async function onSwitchToDiagnose() {
    // Carry vehicle + use the latest user message as the presenting complaint.
    const lastUser = [...messages]
      .reverse()
      .find((m) => m.role === "user");
    await setHandoff({
      type: "to_diagnose",
      vehicle: hasVehicle ? vehicle : undefined,
      vin: vin ? vin.trim() || undefined : undefined,
      symptom: lastUser?.content ?? "",
      recalls,
      tsbs,
    });
    router.replace("/diagnose");
  }

  const canSwitchToDiagnose = messages.some((m) => m.role === "assistant");

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <View
        onLayout={(e) => setHeaderHeight(e.nativeEvent.layout.height)}
      >
        <Navbar showBack />

        {obdConnected && (
          <View style={styles.obdBanner}>
            <View style={styles.obdDot} />
            <Text style={styles.obdBannerText}>
              OBD2 adapter connected — live data available
            </Text>
          </View>
        )}
        {hasVehicle ? (
          <VehicleBar vehicle={vehicle} onReset={resetVehicle} />
        ) : (
          <TouchableOpacity
            style={styles.addVehicleBtn}
            onPress={() => setVehicleModalOpen(true)}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Add vehicle context"
          >
            <Ionicons
              name="add-circle-outline"
              size={18}
              color={colors.accent}
            />
            <Text style={styles.addVehicleText}>
              Add vehicle for vehicle-specific questions
            </Text>
          </TouchableOpacity>
        )}
      </View>

      <KeyboardAvoidingView
        style={[
          styles.flex,
          Platform.OS === "android" && { paddingBottom: androidKbHeight },
        ]}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        // Offset must be 0: the header is a sibling above this KAV, so a
        // non-zero offset over-lifts the composer (dead gap above the keyboard).
        keyboardVerticalOffset={0}
      >
        {messages.length === 0 ? (
          <View style={styles.emptyWrap}>
            <Text style={styles.emptyTitle}>Ask Vulcan</Text>
            <Text style={styles.emptyBody}>
              Ask anything automotive. Specs, procedures, fluid capacities, how
              systems work — or describe a problem and we'll work through it.
            </Text>
          </View>
        ) : (
          <FlatList
            ref={listRef}
            data={messages}
            keyExtractor={(_, i) => String(i)}
            style={styles.thread}
            contentContainerStyle={styles.threadContent}
            renderItem={({ item }) => <MessageRow message={item} />}
            ListFooterComponent={
              <>
                {loading && (
                  <View style={styles.assistantWrap}>
                    <View style={[styles.bubble, styles.bubbleAssistant]}>
                      <View style={styles.loadingRow}>
                        <ActivityIndicator
                          size="small"
                          color={colors.accent}
                        />
                        <Text style={styles.loadingText}>Thinking…</Text>
                      </View>
                    </View>
                  </View>
                )}
                {error && (
                  <View style={styles.errorBox}>
                    <Text style={styles.errorText}>{error}</Text>
                  </View>
                )}
              </>
            }
          />
        )}

        <SafeAreaView edges={["bottom"]} style={styles.footerBar}>
          {canSwitchToDiagnose && (
            <TouchableOpacity
              style={styles.switchLink}
              onPress={onSwitchToDiagnose}
              activeOpacity={0.6}
              accessibilityRole="button"
              accessibilityLabel="Switch to Diagnose mode"
            >
              <Text style={styles.switchLinkText}>
                Switch to Diagnose mode ›
              </Text>
            </TouchableOpacity>
          )}
          <View style={styles.composerWrap}>
            {pendingPhoto && (
              <View style={styles.stagedChip}>
                <Image
                  source={{ uri: pendingPhoto.uri }}
                  style={styles.stagedThumb}
                  resizeMode="cover"
                />
                <Text style={styles.stagedText}>Photo attached</Text>
                <TouchableOpacity
                  onPress={() => setPendingPhoto(null)}
                  accessibilityLabel="Remove photo"
                  hitSlop={8}
                >
                  <Ionicons name="close-circle" size={18} color={colors.muted} />
                </TouchableOpacity>
              </View>
            )}
            <View style={styles.inputRow}>
              <TouchableOpacity
                style={styles.attachBtn}
                onPress={onComposerAttach}
                disabled={loading || attaching}
                activeOpacity={0.7}
                accessibilityLabel="Attach a photo"
              >
                <Ionicons
                  name="camera-outline"
                  size={22}
                  color={loading || attaching ? colors.muted : colors.accent}
                />
              </TouchableOpacity>
              <TextInput
                style={styles.input}
                multiline
                placeholder={
                  hasVehicle
                    ? "Ask anything about this vehicle…"
                    : "Ask anything automotive…"
                }
                placeholderTextColor={colors.muted}
                value={draft}
                onChangeText={setDraft}
                editable={!loading}
                textAlignVertical="top"
              />
              <TouchableOpacity
                style={[
                  styles.sendBtn,
                  (loading || (draft.trim().length === 0 && !pendingPhoto)) &&
                    styles.sendDisabled,
                ]}
                onPress={() => send(draft, pendingPhoto)}
                disabled={loading || (draft.trim().length === 0 && !pendingPhoto)}
                activeOpacity={0.85}
                accessibilityLabel="Send"
              >
                <Text style={styles.sendBtnText}>Send</Text>
              </TouchableOpacity>
            </View>
          </View>
        </SafeAreaView>
      </KeyboardAvoidingView>

      <AddVehicleModal
        visible={vehicleModalOpen}
        onClose={() => setVehicleModalOpen(false)}
        onConfirm={(v, scannedVin) => {
          setVehicleManually(v, scannedVin || null).catch(() => {});
          setVehicleModalOpen(false);
        }}
      />
    </SafeAreaView>
  );
}

// ---------- Message row ----------

function MessageRow({ message }: { message: ChatMessage }) {
  if (message.role === "user") {
    return (
      <View style={styles.userWrap}>
        <View style={[styles.bubble, styles.bubbleUser]}>
          {message.image && <PhotoThumb image={message.image} />}
          {message.content.length > 0 && (
            <Text style={[styles.bubbleText, styles.bubbleTextUser]}>
              {message.content}
            </Text>
          )}
        </View>
      </View>
    );
  }
  return (
    <View style={styles.assistantWrap}>
      <View style={[styles.bubble, styles.bubbleAssistant]}>
        <Text style={styles.bubbleText}>{message.content}</Text>
      </View>
    </View>
  );
}

// ---------- Add vehicle modal ----------

function AddVehicleModal({
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
            onPress={() =>
              canSave && onConfirm(localVehicle, localVin.trim())
            }
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
          // iOS: auto-inset for the keyboard + scroll the focused field above it
          // (this pageSheet modal had NO keyboard avoidance, so Model was covered).
          // No-op on Android, which uses adjustResize (app.json).
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
              <ManualField
                label="Year"
                value={localVehicle.year}
                onChangeText={(v) => updateField("year", v)}
                placeholder="2015"
                keyboardType="number-pad"
              />
              <ManualField
                label="Make"
                value={localVehicle.make}
                onChangeText={(v) => updateField("make", v)}
                placeholder="Toyota"
                autoCapitalize="words"
              />
              <ManualField
                label="Model"
                value={localVehicle.model}
                onChangeText={(v) => updateField("model", v)}
                placeholder="Camry, Sierra 1500"
                autoCapitalize="words"
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
  safe: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  flex: {
    flex: 1,
  },
  obdBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: colors.okBg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.okBorder,
  },
  obdDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.okText,
  },
  obdBannerText: {
    color: colors.okText,
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.3,
  },
  addVehicleBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    minHeight: HIT_TARGET,
  },
  addVehicleText: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: "600",
    letterSpacing: 0.2,
  },
  emptyWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
    gap: 12,
  },
  emptyTitle: {
    color: colors.heading,
    fontSize: 26,
    fontWeight: "700",
    letterSpacing: -0.3,
  },
  emptyBody: {
    color: colors.muted,
    fontSize: 14,
    textAlign: "center",
    lineHeight: 21,
  },
  thread: {
    flex: 1,
  },
  threadContent: {
    padding: 16,
    gap: 12,
  },
  bubble: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  bubbleUser: {
    maxWidth: "88%",
    backgroundColor: colors.userBg,
    borderColor: colors.userBorder,
    borderBottomRightRadius: 4,
  },
  bubbleAssistant: {
    width: "100%",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderBottomLeftRadius: 4,
  },
  bubbleText: {
    color: colors.text,
    fontSize: 15,
    lineHeight: 22,
  },
  bubbleTextUser: {
    color: colors.userText,
  },
  userWrap: {
    alignItems: "flex-end",
  },
  assistantWrap: {
    alignItems: "flex-start",
  },
  loadingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  loadingText: {
    color: colors.muted,
    fontSize: 14,
    fontStyle: "italic",
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
  errorText: {
    color: colors.dangerText,
    fontSize: 13,
  },
  footerBar: {
    backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  switchLink: {
    minHeight: HIT_TARGET - 12,
    alignSelf: "flex-end",
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginRight: 8,
    marginTop: 4,
  },
  switchLinkText: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.2,
  },
  composerWrap: {
    flexDirection: "column",
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 10,
  },
  attachBtn: {
    minHeight: HIT_TARGET,
    minWidth: HIT_TARGET,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
    backgroundColor: colors.surface2,
  },
  stagedChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 12,
    marginTop: 8,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: colors.accentFade,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.accent,
    alignSelf: "flex-start",
  },
  stagedThumb: {
    width: 32,
    height: 32,
    borderRadius: 4,
  },
  stagedText: {
    fontSize: 12,
    fontWeight: "600",
    color: colors.accent,
  },
  input: {
    flex: 1,
    minHeight: HIT_TARGET,
    maxHeight: 160,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: colors.text,
    backgroundColor: colors.surface2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 8,
  },
  sendBtn: {
    minHeight: HIT_TARGET,
    minWidth: HIT_TARGET + 24,
    backgroundColor: colors.accent,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  sendDisabled: {
    opacity: 0.45,
  },
  sendBtnText: {
    color: "#FFFFFF",
    fontWeight: "600",
    fontSize: 14,
    letterSpacing: 0.3,
  },

  // ---------- Add vehicle modal ----------
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
