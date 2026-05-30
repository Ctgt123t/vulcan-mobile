import { useRouter } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import DiagnosisActions from "../components/DiagnosisActions";
import Navbar from "../components/Navbar";
import RecallList from "../components/RecallList";
import Results from "../components/Results";
import TsbList from "../components/TsbList";
import VehicleBar from "../components/VehicleBar";
import VinScanner from "../components/VinScanner";
import { EMPTY_VEHICLE, useVehicle } from "../contexts/VehicleContext";
import {
  DiagnoseError,
  VinDecodeError,
  decodeVin,
  diagnose,
  isLikelyVin,
} from "../lib/api";
import { consumeHandoff, setHandoff } from "../lib/handoff";
import {
  type DiagnosticRecord,
  type RecordOutcome,
  makeRecordId,
  saveRecord,
} from "../lib/records";
import { HIT_TARGET, colors } from "../lib/theme";
import type {
  AssistantTurn,
  ChatMessage,
  FinalDiagnosis,
  VehicleInfo,
} from "../lib/types";

type Phase = "intake" | "chat";

export default function Screen() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("intake");
  // Vehicle, recalls, and TSBs live in the global VehicleContext so the
  // auto-VIN flow (when the OBD2 adapter connects) populates the intake
  // form here automatically.
  const {
    vehicle,
    vin: ctxVin,
    recalls,
    tsbs,
    setVehicleManually,
    clearVehicle,
  } = useVehicle();
  // Local VIN input — synced with the context's vin when the context
  // updates from elsewhere (e.g. OBD2 auto-detect).
  const [vin, setVin] = useState<string>(ctxVin ?? "");
  useEffect(() => {
    if ((ctxVin ?? "") !== vin) {
      setVin(ctxVin ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctxVin]);
  const [symptom, setSymptom] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [answer, setAnswer] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [scannerOpen, setScannerOpen] = useState(false);
  const [decoding, setDecoding] = useState(false);
  const [decodeError, setDecodeError] = useState<string | null>(null);
  const [decoded, setDecoded] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const lastDecodedRef = useRef<string>("");

  const [confirmedDone, setConfirmedDone] = useState(false);
  const [savingRecord, setSavingRecord] = useState(false);

  const listRef = useRef<FlatList<ChatMessage> | null>(null);
  const insets = useSafeAreaInsets();
  // Height of the chrome above the KAV — measured for the iOS KAV offset.
  const [headerHeight, setHeaderHeight] = useState(0);
  // Manual keyboard-height tracking for Android. KeyboardAvoidingView is
  // unreliable on Android (especially with newArch + expo-router), so we
  // listen to the Keyboard API directly and apply paddingBottom equal to
  // the keyboard height. On iOS this stays 0 and KAV does the work.
  const [androidKbHeight, setAndroidKbHeight] = useState(0);

  // Auto-scroll on keyboard open + capture keyboard height for Android.
  useEffect(() => {
    if (phase !== "chat") return;
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
  }, [phase]);

  // Consume a handoff from Ask Vulcan (if present) on mount and pre-fill
  // the intake. We don't auto-submit — the technician confirms the vehicle
  // and symptom before the diagnostic conversation starts. Vehicle pushes
  // into the global context so the recall/TSB lookups fire automatically.
  useEffect(() => {
    let active = true;
    consumeHandoff("to_diagnose").then((h) => {
      if (!active || !h) return;
      if (h.vehicle) {
        setVehicleManually({ ...EMPTY_VEHICLE, ...h.vehicle }, h.vin ?? null).catch(
          () => {},
        );
      }
      if (h.vin) setVin(h.vin);
      const dtcLine =
        h.dtcs && h.dtcs.length > 0
          ? `OBD2 scan returned the following DTCs: ${h.dtcs.join(", ")}.`
          : "";
      const combined = [dtcLine, h.symptom].filter((s) => s).join("\n\n");
      if (combined) setSymptom(combined);
    });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (phase === "chat") {
      const id = setTimeout(() => {
        listRef.current?.scrollToEnd({ animated: true });
      }, 50);
      return () => clearTimeout(id);
    }
  }, [messages.length, loading, phase]);

  // Manual VIN decode — when the user types or scans a VIN here, push the
  // decoded vehicle into the context (which then fans out to recall/TSB/
  // PID fetches automatically). Mirrors the OBD2 auto-VIN path.
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
        const merged: VehicleInfo = {
          year: d.year || vehicle.year,
          make: d.make || vehicle.make,
          model: d.model || vehicle.model,
          trim: d.trim || vehicle.trim,
          engineType: d.engineType || vehicle.engineType,
          mileage: vehicle.mileage,
        };
        setVehicleManually(merged, trimmed).catch(() => {});
        setDecoded(true);
      })
      .catch((err) => {
        const msg =
          err instanceof VinDecodeError ? err.message : "Decode failed.";
        setDecodeError(msg);
        setDecoded(false);
      })
      .finally(() => setDecoding(false));
    // We intentionally don't depend on `vehicle` — re-running on every
    // vehicle change would re-decode the same VIN repeatedly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vin]);

  const latestTurn = useMemo<AssistantTurn | null>(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") {
        try {
          return JSON.parse(messages[i].content) as AssistantTurn;
        } catch {
          return null;
        }
      }
    }
    return null;
  }, [messages]);
  const isFinal = latestTurn?.kind === "diagnosis";
  const relevantRecalls = useMemo(() => {
    if (latestTurn?.kind !== "diagnosis") return [];
    const ids = new Set(latestTurn.diagnosis.relevant_recall_campaigns ?? []);
    return recalls.filter((r) => ids.has(r.campaignNumber));
  }, [latestTurn, recalls]);
  const relevantTsbs = useMemo(() => {
    if (latestTurn?.kind !== "diagnosis") return [];
    const ids = new Set(latestTurn.diagnosis.relevant_tsb_numbers ?? []);
    return tsbs.filter((t) => ids.has(t.number));
  }, [latestTurn, tsbs]);

  function updateVehicle<K extends keyof VehicleInfo>(
    field: K,
    value: VehicleInfo[K],
  ) {
    // Push every edit through the context so the global vehicle stays in
    // sync. The context's refreshMetadata is debounced by year/make/model
    // so per-keystroke edits don't fan out to repeated recall/TSB fetches.
    setVehicleManually({ ...vehicle, [field]: value }, vin || null).catch(() => {});
  }

  async function callApi(nextMessages: ChatMessage[]): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const turn = await diagnose(vehicle, nextMessages, recalls, tsbs);
      setMessages([
        ...nextMessages,
        { role: "assistant", content: JSON.stringify(turn) },
      ]);
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

  function intakeValid(): boolean {
    return (
      vehicle.year.trim().length > 0 &&
      vehicle.make.trim().length > 0 &&
      vehicle.model.trim().length > 0 &&
      vehicle.mileage.trim().length > 0 &&
      symptom.trim().length > 0
    );
  }

  async function onSubmitIntake() {
    if (!intakeValid()) return;
    const first: ChatMessage = { role: "user", content: symptom.trim() };
    setMessages([first]);
    setPhase("chat");
    await callApi([first]);
  }

  async function sendUserMessage(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    const next: ChatMessage[] = [
      ...messages,
      { role: "user", content: trimmed },
    ];
    setMessages(next);
    setAnswer("");
    await callApi(next);
  }

  async function onSubmitAnswer() {
    await sendUserMessage(answer);
  }

  function handleVinScanned(scanned: string) {
    setVin(scanned);
    setScannerOpen(false);
  }

  async function onSwitchToAsk() {
    // Carry vehicle context + the diagnostic conversation (rendered as plain
    // text for Ask Vulcan's flat format) so the technician can ask a general
    // question without dropping the thread.
    const askMessages: ChatMessage[] = messages.map((m) => {
      if (m.role === "user") return m;
      try {
        const turn = JSON.parse(m.content) as AssistantTurn;
        if (turn.kind === "question") {
          return { role: "assistant", content: turn.question };
        }
        if (turn.kind === "diagnosis") {
          return {
            role: "assistant",
            content: `${turn.diagnosis.root_cause}\n\n${turn.diagnosis.reasoning}`,
          };
        }
      } catch {
        // fall through
      }
      return { role: "assistant", content: m.content };
    });
    await setHandoff({
      type: "to_ask",
      vehicle,
      vin: vin.trim() || undefined,
      messages: askMessages,
      recalls,
      tsbs,
    });
    router.replace("/ask");
  }

  async function persistRecord(
    outcome: RecordOutcome,
    diagnosis: FinalDiagnosis,
    snapshot: ChatMessage[],
  ) {
    const record: DiagnosticRecord = {
      type: "diagnosis",
      id: makeRecordId(),
      date: new Date().toISOString(),
      vehicle,
      vin: vin.trim() || undefined,
      symptom: symptom.trim() || snapshot[0]?.content || "",
      conversation: snapshot,
      diagnosis,
      outcome,
    };
    setSavingRecord(true);
    try {
      await saveRecord(record);
    } catch (err) {
      console.warn("[records] save failed:", err);
    } finally {
      setSavingRecord(false);
    }
  }

  async function onConfirmDiagnosis() {
    if (latestTurn?.kind !== "diagnosis") return;
    await persistRecord("confirmed", latestTurn.diagnosis, messages);
    setConfirmedDone(true);
  }

  async function onRejectDiagnosis() {
    if (latestTurn?.kind !== "diagnosis") return;
    await persistRecord("incorrect", latestTurn.diagnosis, messages);
    const rejection =
      "That diagnosis was not correct — the indicated fix did not resolve the issue. Continue investigating: ask any additional clarifying questions you need, then commit to a different diagnosis.";
    await sendUserMessage(rejection);
  }

  function resetSession() {
    setPhase("intake");
    setMessages([]);
    setAnswer("");
    setSymptom("");
    setError(null);
    setVin("");
    setDecoded(false);
    setDecodeError(null);
    setManualOpen(false);
    clearVehicle().catch(() => {});
    setConfirmedDone(false);
    lastDecodedRef.current = "";
  }

  if (phase === "intake") {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <Navbar showBack />
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          keyboardVerticalOffset={0}
        >
          <ScrollView
            contentContainerStyle={styles.intakeContent}
            keyboardShouldPersistTaps="handled"
          >
            <Text style={styles.h1}>Diagnose</Text>
            <Text style={styles.subtitle}>
              Scan the VIN on the driver door jamb sticker, or enter it
              manually. Vehicle details auto-populate from NHTSA.
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
                    <Field
                      label="Year"
                      value={vehicle.year}
                      onChangeText={(v) => updateVehicle("year", v)}
                      placeholder="2015"
                      keyboardType="number-pad"
                    />
                    <Field
                      label="Make"
                      value={vehicle.make}
                      onChangeText={(v) => updateVehicle("make", v)}
                      placeholder="Toyota"
                      autoCapitalize="words"
                    />
                    <Field
                      label="Model"
                      value={vehicle.model}
                      onChangeText={(v) => updateVehicle("model", v)}
                      placeholder="Camry"
                      autoCapitalize="words"
                    />
                  </View>
                  <View style={styles.row2}>
                    <Field
                      label="Trim Level"
                      value={vehicle.trim ?? ""}
                      onChangeText={(v) => updateVehicle("trim", v)}
                      placeholder="LE, XSE, TRD"
                    />
                    <Field
                      label="Engine Type"
                      value={vehicle.engineType ?? ""}
                      onChangeText={(v) => updateVehicle("engineType", v)}
                      placeholder="2.5L 4-cyl, 3.5L V6"
                    />
                  </View>
                </View>
              )}

              <View style={styles.singleField}>
                <Text style={styles.label}>PRESENTING COMPLAINT</Text>
                <TextInput
                  style={[styles.input, styles.textarea]}
                  multiline
                  placeholder="Customer reports intermittent misfire at idle, MIL on. P0301 stored. No recent service history."
                  placeholderTextColor={colors.muted}
                  value={symptom}
                  onChangeText={setSymptom}
                  textAlignVertical="top"
                />
              </View>

              <TouchableOpacity
                style={[
                  styles.submit,
                  (!intakeValid() || loading) && styles.submitDisabled,
                ]}
                onPress={onSubmitIntake}
                disabled={!intakeValid() || loading}
                activeOpacity={0.85}
              >
                <Text style={styles.submitText}>
                  {loading ? "Starting…" : "Begin diagnosis"}
                </Text>
              </TouchableOpacity>

              {error && (
                <View style={styles.errorBox}>
                  <Text style={styles.errorText}>{error}</Text>
                </View>
              )}
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

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <View
        onLayout={(e) => setHeaderHeight(e.nativeEvent.layout.height)}
      >
        <Navbar showBack />
        <VehicleBar vehicle={vehicle} onReset={resetSession} />
      </View>

      <KeyboardAvoidingView
        style={[
          styles.flex,
          Platform.OS === "android" && { paddingBottom: androidKbHeight },
        ]}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={
          Platform.OS === "ios" ? insets.top + headerHeight : 0
        }
      >
        <FlatList
          ref={listRef}
          style={styles.thread}
          contentContainerStyle={styles.threadContent}
          data={messages}
          keyExtractor={(_, i) => String(i)}
          renderItem={({ item }) => <MessageRow message={item} />}
          ListFooterComponent={
            <>
              {loading && (
                <View style={styles.assistantTurn}>
                  <Text style={styles.assistantLabel}>
                    DIAGNOSTIC ASSISTANT
                  </Text>
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
              {relevantRecalls.length > 0 && (
                <RecallList recalls={relevantRecalls} />
              )}
              {relevantTsbs.length > 0 && <TsbList tsbs={relevantTsbs} />}
              {error && (
                <View style={styles.errorBox}>
                  <Text style={styles.errorText}>{error}</Text>
                </View>
              )}
            </>
          }
          onContentSizeChange={() =>
            listRef.current?.scrollToEnd({ animated: true })
          }
        />

        <SafeAreaView edges={["bottom"]} style={styles.footerBar}>
          {confirmedDone ? (
            <View style={styles.confirmedBox}>
              <Text style={styles.confirmedBadge}>FIX CONFIRMED</Text>
              <Text style={styles.confirmedText}>
                Saved to records.
              </Text>
              <TouchableOpacity
                style={styles.newDiagBtn}
                onPress={resetSession}
                activeOpacity={0.85}
                accessibilityLabel="Start a new diagnosis"
              >
                <Text style={styles.newDiagBtnText}>New Diagnosis</Text>
              </TouchableOpacity>
            </View>
          ) : isFinal ? (
            <DiagnosisActions
              onConfirm={onConfirmDiagnosis}
              onReject={onRejectDiagnosis}
              disabled={loading || savingRecord}
            />
          ) : (
            <>
              <TouchableOpacity
                style={styles.switchLink}
                onPress={onSwitchToAsk}
                activeOpacity={0.6}
                accessibilityRole="button"
                accessibilityLabel="Switch to Ask Vulcan"
              >
                <Text style={styles.switchLinkText}>
                  Switch to Ask Vulcan ›
                </Text>
              </TouchableOpacity>
              <View style={styles.answerRow}>
                <TextInput
                  style={styles.answerInput}
                  multiline
                  placeholder="Type your response…"
                  placeholderTextColor={colors.muted}
                  value={answer}
                  onChangeText={setAnswer}
                  editable={!loading}
                  textAlignVertical="top"
                />
                <TouchableOpacity
                  style={[
                    styles.sendBtn,
                    (loading || answer.trim().length === 0) &&
                      styles.submitDisabled,
                  ]}
                  onPress={onSubmitAnswer}
                  disabled={loading || answer.trim().length === 0}
                  activeOpacity={0.85}
                  accessibilityLabel="Send"
                >
                  <Text style={styles.sendBtnText}>Send</Text>
                </TouchableOpacity>
              </View>
            </>
          )}
        </SafeAreaView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Field({
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

function MessageRow({ message }: { message: ChatMessage }) {
  if (message.role === "user") {
    return (
      <View style={styles.userWrap}>
        <View style={[styles.bubble, styles.bubbleUser]}>
          <Text style={[styles.bubbleText, styles.bubbleTextUser]}>
            {message.content}
          </Text>
        </View>
      </View>
    );
  }

  let turn: AssistantTurn | null = null;
  try {
    turn = JSON.parse(message.content) as AssistantTurn;
  } catch {
    return (
      <View style={styles.assistantTurn}>
        <Text style={styles.assistantLabel}>DIAGNOSTIC ASSISTANT</Text>
        <View style={[styles.bubble, styles.bubbleAssistant]}>
          <Text style={styles.bubbleText}>{message.content}</Text>
        </View>
      </View>
    );
  }

  if (turn.kind === "question") {
    return (
      <View style={styles.assistantTurn}>
        <Text style={styles.assistantLabel}>DIAGNOSTIC ASSISTANT</Text>
        <View style={[styles.bubble, styles.bubbleAssistant]}>
          <Text style={styles.bubbleText}>{turn.question}</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.assistantTurn}>
      <Text style={styles.assistantLabel}>DIAGNOSTIC ASSISTANT</Text>
      <Results data={turn.diagnosis} />
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
  textarea: {
    minHeight: 120,
    paddingTop: 12,
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
    color: "#fff",
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
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 18,
  },
  submitDisabled: {
    opacity: 0.45,
  },
  submitText: {
    color: "#fff",
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
  thread: {
    flex: 1,
  },
  threadContent: {
    padding: 16,
    gap: 14,
  },
  assistantTurn: {
    alignItems: "flex-start",
    gap: 6,
    marginBottom: 14,
  },
  assistantLabel: {
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 1.8,
    color: colors.accent,
    paddingLeft: 2,
  },
  userWrap: {
    alignItems: "flex-end",
    marginBottom: 14,
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
  footerBar: {
    backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  confirmedBox: {
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 12,
    gap: 10,
  },
  confirmedBadge: {
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 1.8,
    color: colors.okText,
  },
  confirmedText: {
    color: colors.text,
    fontSize: 14,
    lineHeight: 20,
  },
  newDiagBtn: {
    marginTop: 4,
    minHeight: HIT_TARGET,
    backgroundColor: colors.accent,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 18,
  },
  newDiagBtnText: {
    color: "#fff",
    fontWeight: "600",
    fontSize: 15,
    letterSpacing: 0.3,
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
  answerRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 10,
  },
  answerInput: {
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
  sendBtnText: {
    color: "#fff",
    fontWeight: "600",
    fontSize: 14,
    letterSpacing: 0.3,
  },
});
