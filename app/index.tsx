import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
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
import Navbar from "../components/Navbar";
import Results from "../components/Results";
import VehicleBar from "../components/VehicleBar";
import { DiagnoseError, diagnose } from "../lib/api";
import { HIT_TARGET, colors } from "../lib/theme";
import type { AssistantTurn, ChatMessage, VehicleInfo } from "../lib/types";

const EMPTY_VEHICLE: VehicleInfo = {
  year: "",
  make: "",
  model: "",
  trim: "",
  engineType: "",
  mileage: "",
};

type Phase = "intake" | "chat";

export default function Screen() {
  const [phase, setPhase] = useState<Phase>("intake");
  const [vehicle, setVehicle] = useState<VehicleInfo>(EMPTY_VEHICLE);
  const [symptom, setSymptom] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [answer, setAnswer] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const listRef = useRef<FlatList<ChatMessage> | null>(null);

  useEffect(() => {
    if (phase === "chat") {
      const id = setTimeout(() => {
        listRef.current?.scrollToEnd({ animated: true });
      }, 50);
      return () => clearTimeout(id);
    }
  }, [messages.length, loading, phase]);

  function updateVehicle<K extends keyof VehicleInfo>(
    field: K,
    value: VehicleInfo[K],
  ) {
    setVehicle((v) => ({ ...v, [field]: value }));
  }

  function lastAssistantTurn(): AssistantTurn | null {
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
  }

  async function callApi(nextMessages: ChatMessage[]): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const turn = await diagnose(vehicle, nextMessages);
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

  async function onSubmitAnswer() {
    const trimmed = answer.trim();
    if (!trimmed) return;
    const next: ChatMessage[] = [
      ...messages,
      { role: "user", content: trimmed },
    ];
    setMessages(next);
    setAnswer("");
    await callApi(next);
  }

  function resetSession() {
    setPhase("intake");
    setMessages([]);
    setAnswer("");
    setSymptom("");
    setError(null);
  }

  const latestTurn = lastAssistantTurn();
  const isFinal = latestTurn?.kind === "diagnosis";

  if (phase === "intake") {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <Navbar />
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          keyboardVerticalOffset={0}
        >
          <ScrollView
            contentContainerStyle={styles.intakeContent}
            keyboardShouldPersistTaps="handled"
          >
            <Text style={styles.h1}>Vulcan</Text>
            <Text style={styles.subtitle}>
              Technician-side diagnostic assistant. Enter the vehicle and the
              presenting complaint to begin.
            </Text>

            <View style={styles.card}>
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

              <Field
                label="Mileage"
                value={vehicle.mileage}
                onChangeText={(v) => updateVehicle("mileage", v)}
                placeholder="98,500"
                keyboardType="number-pad"
              />

              <View style={styles.field}>
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
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <Navbar />
      <VehicleBar vehicle={vehicle} onReset={resetSession} />

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
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

        {!isFinal && (
          <SafeAreaView edges={["bottom"]} style={styles.footerBar}>
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
          </SafeAreaView>
        )}
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
          <Text style={styles.bubbleText}>{message.content}</Text>
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
  submit: {
    marginTop: 4,
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
