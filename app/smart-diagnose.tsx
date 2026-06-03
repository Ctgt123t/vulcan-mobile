import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Keyboard,
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
import { useObd2 } from "../contexts/Obd2Context";
import { useVehicle } from "../contexts/VehicleContext";
import { AssessError, assess } from "../lib/api";
import { diagnosticLogger } from "../lib/diagnosticLogger";
import {
  OPERATING_CONDITION_LABELS,
  type ConfidenceLevel,
  type DiagnosticAssessment,
  type Hypothesis,
  type OperatingCondition,
  type Stance,
} from "../lib/assessmentTypes";
import { buildDiagnosticSnapshot } from "../lib/diagnosticSnapshot";
import { obd2 } from "../lib/obd2";
import { HIT_TARGET, colors } from "../lib/theme";

// Minimum ring buffer age before we consider the snapshot "warm enough".
// At 250ms poll interval this is ~12 samples — enough for a stable average.
const MIN_BUFFER_AGE_MS = 3000;

type ScreenPhase =
  | { kind: "intake" }
  | { kind: "assessing" }
  | { kind: "result"; assessment: DiagnosticAssessment }
  | { kind: "error"; message: string };

const CONDITIONS: OperatingCondition[] = [
  "COLD_START",
  "WARM_IDLE",
  "LIGHT_LOAD",
  "HEAVY_LOAD",
  "UNDER_SYMPTOM_CONDITION",
  "OTHER",
];

export default function SmartDiagnoseScreen() {
  const router = useRouter();
  const { isConnected } = useObd2();
  const { vehicle, vin, recalls, tsbs } = useVehicle();

  const [phase, setPhase] = useState<ScreenPhase>({ kind: "intake" });
  const [complaint, setComplaint] = useState("");
  const [condition, setCondition] = useState<OperatingCondition>("WARM_IDLE");
  const [mileage, setMileage] = useState(vehicle.mileage ?? "");
  const [androidKbHeight, setAndroidKbHeight] = useState(0);

  useEffect(() => {
    const showSub = Keyboard.addListener("keyboardDidShow", (e) => {
      if (Platform.OS === "android") setAndroidKbHeight(e.endCoordinates.height);
    });
    const hideSub = Keyboard.addListener("keyboardDidHide", () => {
      if (Platform.OS === "android") setAndroidKbHeight(0);
    });
    return () => { showSub.remove(); hideSub.remove(); };
  }, []);

  // The OBD2 screen holds the live DTC and freeze-frame state. We need to
  // read those to build the snapshot. Since we navigate here from the OBD2
  // screen we can rely on the singleton obd2 manager's ring buffer, but we
  // can't directly access the OBD2 screen's local dtcs/freezeFrame state.
  // These are passed in via route params (set by the OBD2 screen on navigate).
  // For Stage 1 they're passed via a module-level ref that the OBD2 screen
  // sets before navigating. See setSmartDiagnoseHandoff() below.

  async function onRunAssessment() {
    if (!isConnected) {
      setPhase({ kind: "error", message: "OBD2 adapter disconnected. Reconnect and try again." });
      return;
    }

    const handoff = getSmartDiagnoseHandoff();
    const ringBuffer = obd2.captureSnapshot(5000);
    const bufferAge = obd2.getRingBufferAge();

    // If we have less than the minimum, still proceed — but the snapshot may
    // have fewer samples. The server handles sparse data gracefully.
    const effectiveBuffer =
      ringBuffer.length > 0 ? ringBuffer : [];

    const snapshot = buildDiagnosticSnapshot(
      effectiveBuffer,
      handoff.selectedDescriptors,
      condition,
      handoff.dtcs,
      handoff.pendingDtcs,
      handoff.permanentDtcs,
      handoff.freezeFrame,
    );

    setPhase({ kind: "assessing" });
    try {
      const result = await assess(
        vehicle,
        vin,
        mileage,
        complaint.trim(),
        snapshot,
        recalls,
        tsbs,
        diagnosticLogger.getCurrentSessionId(),
      );
      diagnosticLogger.log({
        type: "assessment",
        vehicle: vehicle.year
          ? { year: vehicle.year, make: vehicle.make, model: vehicle.model, vin: vin ?? null }
          : undefined,
        assessment: result.assessment,
        operatingCondition: condition,
        apiCost: result.cost,
      });
      setPhase({ kind: "result", assessment: result.assessment });
    } catch (err) {
      const msg =
        err instanceof AssessError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Something went wrong. Check your connection and try again.";
      setPhase({ kind: "error", message: msg });
    }
  }

  function onReset() {
    setPhase({ kind: "intake" });
  }

  const handoff = getSmartDiagnoseHandoff();
  const signalCount = handoff.selectedDescriptors.length;
  const dtcCount = handoff.dtcs.length + handoff.pendingDtcs.length + handoff.permanentDtcs.length;
  const bufferAge = obd2.getRingBufferAge();
  const hasWarmBuffer = bufferAge >= MIN_BUFFER_AGE_MS;

  const sparseWarning =
    isConnected && signalCount > 0 && signalCount < 4
      ? `Only ${signalCount} PID${signalCount === 1 ? "" : "s"} selected — the assessment will be richer with more signals. Add fuel trims, O2 sensors, and engine load from the PID picker.`
      : null;

  const noDataWarning =
    isConnected && signalCount === 0 && dtcCount === 0
      ? "No live PIDs or DTCs are available. Connect your OBD2 adapter, select PIDs, and run a code scan before using Smart Diagnose."
      : null;

  const bufferWarmingNote =
    isConnected && signalCount > 0 && !hasWarmBuffer
      ? "Live data is still warming up — the snapshot will have fewer samples. For best results, wait a few seconds after connecting before running the assessment."
      : null;

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <Navbar showBack />
      <ScrollView contentContainerStyle={[
        styles.content,
        Platform.OS === "android" && androidKbHeight > 0
          ? { paddingBottom: androidKbHeight + 16 }
          : null,
      ]}>
        {phase.kind === "intake" && (
          <IntakeView
            vehicle={[vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(" ")}
            mileage={mileage}
            onMileageChange={setMileage}
            complaint={complaint}
            onComplaintChange={setComplaint}
            condition={condition}
            onConditionChange={setCondition}
            signalCount={signalCount}
            dtcCount={dtcCount}
            sparseWarning={sparseWarning}
            noDataWarning={noDataWarning}
            bufferWarmingNote={bufferWarmingNote}
            isConnected={isConnected}
            onRun={onRunAssessment}
          />
        )}

        {phase.kind === "assessing" && (
          <AssessingView />
        )}

        {phase.kind === "result" && (
          <ResultView
            assessment={phase.assessment}
            onReset={onReset}
          />
        )}

        {phase.kind === "error" && (
          <ErrorView message={phase.message} onReset={onReset} />
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

// ---- Intake view ----

function IntakeView({
  vehicle,
  mileage,
  onMileageChange,
  complaint,
  onComplaintChange,
  condition,
  onConditionChange,
  signalCount,
  dtcCount,
  sparseWarning,
  noDataWarning,
  bufferWarmingNote,
  isConnected,
  onRun,
}: {
  vehicle: string;
  mileage: string;
  onMileageChange: (v: string) => void;
  complaint: string;
  onComplaintChange: (v: string) => void;
  condition: OperatingCondition;
  onConditionChange: (v: OperatingCondition) => void;
  signalCount: number;
  dtcCount: number;
  sparseWarning: string | null;
  noDataWarning: string | null;
  bufferWarmingNote: string | null;
  isConnected: boolean;
  onRun: () => void;
}) {
  return (
    <>
      <View style={styles.header}>
        <Text style={styles.screenTitle}>Smart Diagnose</Text>
        <Text style={styles.screenSubtitle}>
          One-shot AI assessment of live vehicle data
        </Text>
      </View>

      {!isConnected ? (
        <View style={styles.card}>
          <View style={styles.warningBox}>
            <Ionicons name="warning-outline" size={16} color={colors.warnText} />
            <Text style={styles.warningText}>
              OBD2 adapter not connected. Return to the OBD2 screen, connect to
              your adapter, and run a code scan before using Smart Diagnose.
            </Text>
          </View>
        </View>
      ) : (
        <>
          {/* Data status */}
          <View style={styles.card}>
            <Text style={styles.cardLabel}>DATA AVAILABLE</Text>
            <View style={styles.dataStatusRow}>
              <DataBadge
                label={`${signalCount} live signal${signalCount === 1 ? "" : "s"}`}
                active={signalCount > 0}
                icon="pulse"
              />
              <DataBadge
                label={`${dtcCount} DTC${dtcCount === 1 ? "" : "s"}`}
                active={dtcCount > 0}
                icon="alert-circle"
              />
            </View>
            {noDataWarning ? (
              <View style={[styles.warningBox, { marginTop: 8 }]}>
                <Ionicons name="warning-outline" size={14} color={colors.warnText} />
                <Text style={styles.warningText}>{noDataWarning}</Text>
              </View>
            ) : null}
            {sparseWarning ? (
              <View style={[styles.infoBox, { marginTop: 8 }]}>
                <Ionicons name="information-circle-outline" size={14} color={colors.infoText} />
                <Text style={styles.infoText}>{sparseWarning}</Text>
              </View>
            ) : null}
            {bufferWarmingNote ? (
              <View style={[styles.infoBox, { marginTop: 8 }]}>
                <Ionicons name="time-outline" size={14} color={colors.infoText} />
                <Text style={styles.infoText}>{bufferWarmingNote}</Text>
              </View>
            ) : null}
          </View>

          {/* Operating condition */}
          <View style={styles.card}>
            <Text style={styles.cardLabel}>OPERATING CONDITION</Text>
            <Text style={styles.cardHelp}>
              What is the vehicle doing RIGHT NOW? Trigger the assessment while in
              the condition the fault occurs.
            </Text>
            <View style={styles.conditionGrid}>
              {CONDITIONS.map((c) => (
                <TouchableOpacity
                  key={c}
                  style={[
                    styles.conditionChip,
                    condition === c && styles.conditionChipActive,
                  ]}
                  onPress={() => onConditionChange(c)}
                  activeOpacity={0.75}
                >
                  <Text
                    style={[
                      styles.conditionChipText,
                      condition === c && styles.conditionChipTextActive,
                    ]}
                  >
                    {OPERATING_CONDITION_LABELS[c]}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          {/* Complaint */}
          <View style={styles.card}>
            <Text style={styles.cardLabel}>PRESENTING COMPLAINT</Text>
            <Text style={styles.cardHelp}>
              Optional — describe the symptom. The assessment works from DTCs and
              live data alone, but a description improves the relevance of the
              reasoning.
            </Text>
            <TextInput
              style={styles.textInput}
              value={complaint}
              onChangeText={onComplaintChange}
              placeholder="e.g. rough idle when warm, surges at highway speed, hard start cold"
              placeholderTextColor={colors.muted}
              multiline
              numberOfLines={3}
              textAlignVertical="top"
              returnKeyType="done"
            />
          </View>

          {/* Mileage */}
          <View style={styles.card}>
            <Text style={styles.cardLabel}>MILEAGE</Text>
            <TextInput
              style={[styles.textInput, styles.textInputSingle]}
              value={mileage}
              onChangeText={onMileageChange}
              placeholder="e.g. 87500 miles"
              placeholderTextColor={colors.muted}
              keyboardType="default"
              returnKeyType="done"
            />
            {vehicle ? (
              <Text style={styles.vehicleLine}>
                <Ionicons name="car-outline" size={12} color={colors.muted} />
                {"  "}{vehicle}
              </Text>
            ) : null}
          </View>

          <TouchableOpacity
            style={[
              styles.runBtn,
              (!isConnected || !!noDataWarning) && styles.btnDisabled,
            ]}
            onPress={onRun}
            disabled={!isConnected || !!noDataWarning}
            activeOpacity={0.85}
          >
            <Ionicons name="flash" size={20} color="#FFFFFF" />
            <Text style={styles.runBtnText}>Run Assessment</Text>
          </TouchableOpacity>
        </>
      )}
    </>
  );
}

function DataBadge({
  label,
  active,
  icon,
}: {
  label: string;
  active: boolean;
  icon: keyof typeof Ionicons.glyphMap;
}) {
  return (
    <View
      style={[
        styles.dataBadge,
        active ? styles.dataBadgeActive : styles.dataBadgeInactive,
      ]}
    >
      <Ionicons
        name={icon}
        size={13}
        color={active ? colors.okText : colors.muted}
      />
      <Text
        style={[
          styles.dataBadgeText,
          { color: active ? colors.okText : colors.muted },
        ]}
      >
        {label}
      </Text>
    </View>
  );
}

// ---- Assessing view ----

function AssessingView() {
  return (
    <View style={styles.centeredState}>
      <ActivityIndicator size="large" color={colors.accent} />
      <Text style={styles.assessingTitle}>Analyzing vehicle data…</Text>
      <Text style={styles.assessingSubtitle}>
        Vulcan is reasoning through the differential. This may take 15–30 seconds.
      </Text>
    </View>
  );
}

// ---- Error view ----

function ErrorView({
  message,
  onReset,
}: {
  message: string;
  onReset: () => void;
}) {
  return (
    <View style={styles.centeredState}>
      <Ionicons name="warning-outline" size={40} color={colors.dangerText} />
      <Text style={styles.errorTitle}>Assessment failed</Text>
      <Text style={styles.errorMessage}>{message}</Text>
      <TouchableOpacity style={styles.retryBtn} onPress={onReset} activeOpacity={0.85}>
        <Text style={styles.retryBtnText}>Try again</Text>
      </TouchableOpacity>
    </View>
  );
}

// ---- Result view ----

function ResultView({
  assessment,
  onReset,
}: {
  assessment: DiagnosticAssessment;
  onReset: () => void;
}) {
  const leading = assessment.hypotheses[0] ?? null;

  return (
    <>
      {/* Stance banner */}
      <StanceBanner stance={assessment.stance} reason={assessment.stance_reason} />

      {/* Leading hypothesis (prominent) */}
      {leading && (
        <View style={styles.card}>
          <Text style={styles.cardLabel}>LEADING HYPOTHESIS</Text>
          <View style={styles.leadingRow}>
            <Text style={styles.leadingName}>{leading.name}</Text>
            <ConfidenceChip level={leading.confidence} />
          </View>
          <EvidenceList
            supporting={leading.supporting_evidence}
            contradicting={leading.contradicting_evidence}
          />
        </View>
      )}

      {/* Next step — prominently displayed */}
      <View style={[styles.card, styles.nextStepCard]}>
        <View style={styles.nextStepHeader}>
          <Text style={styles.cardLabel}>NEXT STEP</Text>
          <NextStepTypeBadge type={assessment.next_step.type} />
        </View>
        <Text style={styles.nextStepAction}>{assessment.next_step.action}</Text>
        <Text style={styles.nextStepRationale}>{assessment.next_step.rationale}</Text>
        {assessment.next_step.type === "DATA_CAPTURE" &&
          assessment.next_step.requested_data &&
          assessment.next_step.requested_data.length > 0 && (
            <View style={styles.requestedDataBox}>
              <Text style={styles.requestedDataLabel}>SIGNALS TO CAPTURE</Text>
              {assessment.next_step.requested_data.map((rd, i) => (
                <View key={i} style={styles.requestedDataRow}>
                  <Text style={styles.requestedDataSignal}>{rd.signal_id}</Text>
                  <Text style={styles.requestedDataDetail}>
                    {rd.operating_condition} · {rd.duration_seconds}s
                  </Text>
                </View>
              ))}
            </View>
          )}
      </View>

      {/* Remaining hypotheses */}
      {assessment.hypotheses.length > 1 && (
        <View style={styles.card}>
          <Text style={styles.cardLabel}>DIFFERENTIAL</Text>
          {assessment.hypotheses.map((h, i) => (
            <HypothesisCard key={i} hypothesis={h} rank={i + 1} />
          ))}
        </View>
      )}

      {/* Data ceiling */}
      {assessment.data_ceiling_note.length > 0 && (
        <View style={[styles.card, styles.ceilingCard]}>
          <View style={styles.ceilingHeader}>
            <Ionicons name="layers-outline" size={15} color={colors.warnText} />
            <Text style={[styles.cardLabel, { color: colors.warnText }]}>
              OBD2 DATA CEILING
            </Text>
          </View>
          <Text style={styles.ceilingText}>{assessment.data_ceiling_note}</Text>
        </View>
      )}

      {/* Unverified specs needed */}
      {assessment.unverified_specs_needed.length > 0 && (
        <View style={[styles.card, styles.unverifiedCard]}>
          <View style={styles.ceilingHeader}>
            <Ionicons name="book-outline" size={15} color={colors.infoText} />
            <Text style={[styles.cardLabel, { color: colors.infoText }]}>
              VERIFY AGAINST SERVICE INFO
            </Text>
          </View>
          <Text style={styles.unverifiedIntro}>
            Claude needed these factory values but they were not in the verified data. Confirm them in your service manual before acting on any recommendation that depends on them.
          </Text>
          {assessment.unverified_specs_needed.map((s, i) => (
            <View key={i} style={styles.unverifiedRow}>
              <Text style={styles.unverifiedParam}>{s.parameter}</Text>
              <Text style={styles.unverifiedPurpose}>{s.purpose}</Text>
            </View>
          ))}
        </View>
      )}

      <TouchableOpacity style={styles.resetBtn} onPress={onReset} activeOpacity={0.85}>
        <Ionicons name="refresh" size={16} color={colors.accent} />
        <Text style={styles.resetBtnText}>Run new assessment</Text>
      </TouchableOpacity>
    </>
  );
}

function StanceBanner({ stance, reason }: { stance: Stance; reason: string }) {
  const isAutopilot = stance === "AUTOPILOT";
  return (
    <View
      style={[
        styles.stanceBanner,
        isAutopilot ? styles.stanceAutopilot : styles.stanceGuided,
      ]}
    >
      <View style={styles.stanceRow}>
        <Ionicons
          name={isAutopilot ? "analytics" : "hand-left-outline"}
          size={18}
          color={isAutopilot ? colors.accent : colors.warnText}
        />
        <Text
          style={[
            styles.stanceLabel,
            { color: isAutopilot ? colors.accent : colors.warnText },
          ]}
        >
          {stance === "AUTOPILOT" ? "AUTOPILOT" : "GUIDED"}
        </Text>
      </View>
      <Text style={styles.stanceReason}>{reason}</Text>
    </View>
  );
}

function ConfidenceChip({ level }: { level: ConfidenceLevel }) {
  const palette =
    level === "STRONGLY_SUPPORTED"
      ? { bg: colors.okBg, text: colors.okText }
      : level === "LIKELY"
        ? { bg: colors.warnBg, text: colors.warnText }
        : { bg: colors.surface2, text: colors.muted };

  const label =
    level === "STRONGLY_SUPPORTED"
      ? "Strongly Supported"
      : level === "LIKELY"
        ? "Likely"
        : "Possible";

  return (
    <View style={[styles.confidenceChip, { backgroundColor: palette.bg }]}>
      <Text style={[styles.confidenceChipText, { color: palette.text }]}>
        {label}
      </Text>
    </View>
  );
}

function NextStepTypeBadge({ type }: { type: string }) {
  const label =
    type === "DATA_CAPTURE"
      ? "Data Capture"
      : type === "PHYSICAL_INSPECTION"
        ? "Physical Inspection"
        : "Question";
  const palette =
    type === "DATA_CAPTURE"
      ? { bg: colors.accentFade, text: colors.accent }
      : type === "PHYSICAL_INSPECTION"
        ? { bg: colors.warnBg, text: colors.warnText }
        : { bg: colors.surface2, text: colors.muted };
  return (
    <View style={[styles.typeBadge, { backgroundColor: palette.bg }]}>
      <Text style={[styles.typeBadgeText, { color: palette.text }]}>{label}</Text>
    </View>
  );
}

function EvidenceList({
  supporting,
  contradicting,
}: {
  supporting: string[];
  contradicting: string[];
}) {
  return (
    <View style={styles.evidenceSection}>
      {supporting.length > 0 && (
        <View style={styles.evidenceGroup}>
          <Text style={styles.evidenceGroupLabel}>SUPPORTING</Text>
          {supporting.map((e, i) => (
            <View key={i} style={styles.evidenceRow}>
              <Text style={styles.evidencePlus}>+</Text>
              <Text style={styles.evidenceText}>{e}</Text>
            </View>
          ))}
        </View>
      )}
      {contradicting.length > 0 && (
        <View style={styles.evidenceGroup}>
          <Text style={[styles.evidenceGroupLabel, { color: colors.muted }]}>
            AGAINST
          </Text>
          {contradicting.map((e, i) => (
            <View key={i} style={styles.evidenceRow}>
              <Text style={styles.evidenceMinus}>−</Text>
              <Text style={[styles.evidenceText, { color: colors.muted }]}>{e}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

function HypothesisCard({
  hypothesis,
  rank,
}: {
  hypothesis: Hypothesis;
  rank: number;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <TouchableOpacity
      style={styles.hypothesisCard}
      onPress={() => setExpanded((e) => !e)}
      activeOpacity={0.8}
    >
      <View style={styles.hypothesisHeader}>
        <Text style={styles.hypothesisRank}>{rank}</Text>
        <Text style={styles.hypothesisName} numberOfLines={expanded ? undefined : 2}>
          {hypothesis.name}
        </Text>
        <ConfidenceChip level={hypothesis.confidence} />
        <Text style={styles.expandChev}>{expanded ? "▾" : "▸"}</Text>
      </View>
      {expanded && (
        <View style={styles.hypothesisBody}>
          <EvidenceList
            supporting={hypothesis.supporting_evidence}
            contradicting={hypothesis.contradicting_evidence}
          />
        </View>
      )}
    </TouchableOpacity>
  );
}

// ---- Handoff store ----
// The OBD2 screen calls setSmartDiagnoseHandoff() before navigating here,
// passing the live state that lives in its own component. This is a simple
// module-level store — lightweight, no context overhead, cleared on each call.

interface SmartDiagnoseHandoff {
  selectedDescriptors: import("../lib/obd2").PidDescriptor[];
  dtcs: string[];
  pendingDtcs: string[];
  permanentDtcs: string[];
  freezeFrame: import("../lib/obd2").FreezeFrame | null;
}

let handoffStore: SmartDiagnoseHandoff = {
  selectedDescriptors: [],
  dtcs: [],
  pendingDtcs: [],
  permanentDtcs: [],
  freezeFrame: null,
};

export function setSmartDiagnoseHandoff(h: SmartDiagnoseHandoff): void {
  handoffStore = h;
}

function getSmartDiagnoseHandoff(): SmartDiagnoseHandoff {
  return handoffStore;
}

// ---- Styles ----

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    padding: 16,
    paddingBottom: 48,
    gap: 14,
  },
  header: {
    gap: 4,
    marginBottom: 2,
  },
  screenTitle: {
    fontSize: 22,
    fontWeight: "700",
    color: colors.heading,
    letterSpacing: -0.3,
  },
  screenSubtitle: {
    fontSize: 13,
    color: colors.muted,
  },
  card: {
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 12,
    padding: 14,
    gap: 10,
  },
  cardLabel: {
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 1.6,
    color: colors.accent,
  },
  cardHelp: {
    fontSize: 12,
    color: colors.muted,
    lineHeight: 17,
  },
  // Data status
  dataStatusRow: {
    flexDirection: "row",
    gap: 8,
  },
  dataBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
  },
  dataBadgeActive: {
    backgroundColor: colors.okBg,
    borderColor: colors.okBorder,
  },
  dataBadgeInactive: {
    backgroundColor: colors.surface2,
    borderColor: colors.border,
  },
  dataBadgeText: {
    fontSize: 12,
    fontWeight: "600",
  },
  // Condition chips
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
  // Text inputs
  textInput: {
    backgroundColor: colors.surface2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 8,
    padding: 12,
    fontSize: 14,
    color: colors.text,
    minHeight: 80,
    lineHeight: 20,
  },
  textInputSingle: {
    minHeight: HIT_TARGET,
  },
  vehicleLine: {
    fontSize: 12,
    color: colors.muted,
    marginTop: -4,
  },
  // Run button
  runBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    minHeight: HIT_TARGET + 8,
    backgroundColor: colors.accent,
    borderRadius: 12,
    paddingHorizontal: 20,
  },
  runBtnText: {
    color: "#FFFFFF",
    fontSize: 16,
    fontWeight: "700",
    letterSpacing: 0.3,
  },
  btnDisabled: {
    opacity: 0.4,
  },
  // Warning / info boxes
  warningBox: {
    flexDirection: "row",
    gap: 8,
    padding: 10,
    backgroundColor: colors.warnBg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.warnBorder,
    borderRadius: 8,
    alignItems: "flex-start",
  },
  warningText: {
    flex: 1,
    fontSize: 12,
    color: colors.warnText,
    lineHeight: 17,
  },
  infoBox: {
    flexDirection: "row",
    gap: 8,
    padding: 10,
    backgroundColor: colors.infoBg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.infoBorder,
    borderRadius: 8,
    alignItems: "flex-start",
  },
  infoText: {
    flex: 1,
    fontSize: 12,
    color: colors.infoText,
    lineHeight: 17,
  },
  // Assessing state
  centeredState: {
    alignItems: "center",
    paddingVertical: 60,
    gap: 16,
  },
  assessingTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: colors.heading,
    textAlign: "center",
  },
  assessingSubtitle: {
    fontSize: 13,
    color: colors.muted,
    textAlign: "center",
    lineHeight: 19,
    paddingHorizontal: 20,
  },
  // Error state
  errorTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: colors.dangerText,
  },
  errorMessage: {
    fontSize: 14,
    color: colors.text,
    textAlign: "center",
    lineHeight: 20,
    paddingHorizontal: 24,
  },
  retryBtn: {
    minHeight: HIT_TARGET,
    paddingHorizontal: 24,
    backgroundColor: colors.accent,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 8,
  },
  retryBtnText: {
    color: "#FFFFFF",
    fontSize: 15,
    fontWeight: "600",
  },
  // Stance banner
  stanceBanner: {
    borderRadius: 12,
    padding: 14,
    gap: 6,
    borderWidth: StyleSheet.hairlineWidth,
  },
  stanceAutopilot: {
    backgroundColor: colors.accentFade,
    borderColor: colors.accent,
  },
  stanceGuided: {
    backgroundColor: colors.warnBg,
    borderColor: colors.warnBorder,
  },
  stanceRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  stanceLabel: {
    fontSize: 13,
    fontWeight: "800",
    letterSpacing: 1.5,
  },
  stanceReason: {
    fontSize: 13,
    color: colors.text,
    lineHeight: 18,
  },
  // Leading hypothesis
  leadingRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    flexWrap: "wrap",
  },
  leadingName: {
    flex: 1,
    fontSize: 17,
    fontWeight: "700",
    color: colors.heading,
    lineHeight: 23,
  },
  // Confidence chip
  confidenceChip: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    alignSelf: "flex-start",
  },
  confidenceChipText: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.3,
  },
  // Evidence
  evidenceSection: {
    gap: 10,
  },
  evidenceGroup: {
    gap: 5,
  },
  evidenceGroupLabel: {
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 1.4,
    color: colors.okText,
  },
  evidenceRow: {
    flexDirection: "row",
    gap: 8,
    paddingLeft: 2,
  },
  evidencePlus: {
    fontSize: 13,
    fontWeight: "700",
    color: colors.okText,
    width: 12,
    lineHeight: 19,
  },
  evidenceMinus: {
    fontSize: 15,
    fontWeight: "700",
    color: colors.muted,
    width: 12,
    lineHeight: 19,
  },
  evidenceText: {
    flex: 1,
    fontSize: 13,
    color: colors.text,
    lineHeight: 19,
  },
  // Next step card
  nextStepCard: {
    borderColor: colors.accent,
    backgroundColor: colors.surface,
  },
  nextStepHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  typeBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  typeBadgeText: {
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.5,
  },
  nextStepAction: {
    fontSize: 15,
    fontWeight: "700",
    color: colors.heading,
    lineHeight: 21,
  },
  nextStepRationale: {
    fontSize: 13,
    color: colors.text,
    lineHeight: 19,
  },
  requestedDataBox: {
    marginTop: 4,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    gap: 6,
  },
  requestedDataLabel: {
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 1.4,
    color: colors.accent,
    marginBottom: 2,
  },
  requestedDataRow: {
    gap: 2,
  },
  requestedDataSignal: {
    fontSize: 13,
    fontWeight: "700",
    color: colors.heading,
    fontFamily: "Menlo",
  },
  requestedDataDetail: {
    fontSize: 12,
    color: colors.muted,
  },
  // Hypothesis cards (differential list)
  hypothesisCard: {
    paddingVertical: 10,
    paddingHorizontal: 2,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    gap: 0,
  },
  hypothesisHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
  },
  hypothesisRank: {
    fontSize: 12,
    fontWeight: "700",
    color: colors.muted,
    width: 16,
    lineHeight: 22,
  },
  hypothesisName: {
    flex: 1,
    fontSize: 14,
    fontWeight: "600",
    color: colors.heading,
    lineHeight: 20,
  },
  expandChev: {
    fontSize: 16,
    color: colors.muted,
    lineHeight: 22,
  },
  hypothesisBody: {
    marginTop: 10,
    paddingLeft: 24,
  },
  // Data ceiling card
  ceilingCard: {
    borderColor: colors.warnBorder,
    backgroundColor: colors.warnBg,
  },
  ceilingHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  ceilingText: {
    fontSize: 13,
    color: colors.warnText,
    lineHeight: 19,
  },
  // Unverified specs card
  unverifiedCard: {
    borderColor: colors.infoBorder,
    backgroundColor: colors.infoBg,
  },
  unverifiedIntro: {
    fontSize: 12,
    color: colors.infoText,
    lineHeight: 17,
  },
  unverifiedRow: {
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.infoBorder,
    gap: 2,
  },
  unverifiedParam: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.infoText,
  },
  unverifiedPurpose: {
    fontSize: 12,
    color: colors.infoText,
    lineHeight: 17,
  },
  // Reset button
  resetBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    minHeight: HIT_TARGET,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.accent,
    backgroundColor: colors.accentFade,
    paddingHorizontal: 20,
  },
  resetBtnText: {
    color: colors.accent,
    fontSize: 14,
    fontWeight: "600",
  },
});
