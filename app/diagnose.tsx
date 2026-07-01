import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import DiagnosisActions from "../components/DiagnosisActions";
import { VehiclePickerRow } from "../components/VehiclePicker";
import FindDiagramModal from "../components/FindDiagramModal";
import Navbar from "../components/Navbar";
import PhotoThumb from "../components/PhotoThumb";
import RecallList from "../components/RecallList";
import Results from "../components/Results";
import TsbList from "../components/TsbList";
import VehicleBar from "../components/VehicleBar";
import VinScanner from "../components/VinScanner";
import Background from "../components/ui/Background";
import GlassCard from "../components/ui/GlassCard";
import { NextStepBlock } from "../components/assessment/parts";
import CaptureCard from "../components/assessment/CaptureCard";
import FindingCard from "../components/assessment/FindingCard";
import ConditionSelector from "../components/assessment/ConditionSelector";
import DataBadge from "../components/assessment/DataBadge";
import { useObd2 } from "../contexts/Obd2Context";
import { EMPTY_VEHICLE, useVehicle } from "../contexts/VehicleContext";
import {
  AssessError,
  DiagnoseError,
  DiagnoseTurnError,
  EvidenceUpdateError,
  VinDecodeError,
  assess,
  decodeVin,
  diagnose,
  diagnoseTurn,
  evidenceUpdate,
  isLikelyVin,
  recordDiagnosisStart,
} from "../lib/api";
import { CaptureExecutor } from "../lib/captureExecutor";
import type { ConditionReadout } from "../lib/captureDetector";
import {
  describeArmingCondition,
  listRecordedSignalIds,
  describeArmingConditionFromPlan,
  listRecordedSignalIdsFromPlan,
} from "../lib/captureDetector";
import { resolvePlan, type ResolveContext } from "../lib/captureResolver";
import {
  buildSelectedDescriptors,
  fetchPidCatalog,
  loadCachedBitmask,
  loadCachedCatalog,
  saveCatalog,
} from "../lib/pidCatalog";
import {
  type DiagnoseTurn,
  type DiagnosticAssessment,
  type DiagnosticSnapshot,
  type OperatingCondition,
} from "../lib/assessmentTypes";
import {
  formatInspectionResult,
  hasFindingOptions,
  readFindingOptions,
} from "../lib/findingOptions";
import {
  persistPhoto,
  pickAndResize,
  readPhotoBase64,
  withoutBase64,
} from "../lib/photoEvidence";
import { buildDiagnosticSnapshot } from "../lib/diagnosticSnapshot";
import {
  buildTurnHistory,
  type HistoryAssessment,
  type HistoryCapture,
} from "../lib/turnHistory";
import { consumeHandoff, setHandoff } from "../lib/handoff";
import { setDiagnoseSessionActive } from "../lib/activeDiagnoseSession";
import { diagnosticLogger } from "../lib/diagnosticLogger";
import {
  closeCase,
  deleteCase,
  linkRecord,
  loadCase,
  loadIndex,
  pruneForNewCase,
  upsertCase,
} from "../lib/diagnosticCases";
import {
  type CaseCloseReason,
  type CaseIndexEntry,
  type CaseStateSlot,
  type CaseStatus,
  type DiagnosticCase,
  type EvidenceCaptureEntry,
  type SavedAssessmentEntry,
  makeCaseId,
  sanitizeMessages,
  vehicleLabel,
} from "../lib/diagnosticCasesCore";
import { obd2, signalKeyOf, type PidDescriptor } from "../lib/obd2";
import {
  consumeObd2DiagnoseEscalation,
  getObd2DiagnoseHandoff,
} from "../lib/obd2Handoff";
import {
  type DiagnosticRecord,
  type RecordOutcome,
  makeRecordId,
  saveRecord,
} from "../lib/records";
import { HIT_TARGET, colors, fonts, radii } from "../lib/theme";
import type {
  AssistantTurn,
  ChatMessage,
  FinalDiagnosis,
  ImageAttachment,
  VehicleInfo,
} from "../lib/types";

type Phase = "intake" | "chat";

// A structured assessment occupying a slot in the conversation thread.
// `afterMessageIndex` anchors the card to a fixed position (rendered after
// that message) so the layout doesn't jump when the assessment resolves
// after later conversational turns have already rendered.
// Stage 2C-4 (transient, never persisted): the live capture-round state shown on
// a DATA_CAPTURE assessment card after "Start monitoring" is tapped. `phase`
// is broader than CaptureCardState so terminal non-complete outcomes
// (stopped/unavailable) carry an explanatory note. The evolved assessment from
// the round is a SEPARATE appended AssessmentEntry — this only drives the card.
interface CaptureUiState {
  // "waiting" | "capturing" | "complete" map 1:1 to CaptureCardState; the
  // terminal "stopped" | "unavailable" | "error" render a note box instead.
  phase:
    | "waiting"
    | "capturing"
    | "complete"
    | "stopped"
    | "unavailable"
    | "error";
  // The ARMING condition shown as "Watching for: …" — context gate (+ any bounded
  // measured target). Record-only measured signals are NOT here; they live in
  // recordedSignalIds ("Recording: …").
  conditionLabel: string;
  signalIds: string[];
  // The measured signals this capture records (for the "Recording: …" line).
  recordedSignalIds?: string[];
  // Fix 2: per-condition live readout (current value vs target + met) so the
  // WAITING card reads as "warming up, almost there" instead of a dead spinner.
  conditions?: ConditionReadout[];
  durationSeconds?: number;
  progress?: number;
  note?: string;
}

// Round-level state (catalog-load failure / no-runnable-items / pre-resolve
// placeholder) lives under this reserved key in the per-item captures map, since
// it isn't tied to a specific plan item index.
const CAPTURE_ROUND_KEY = -1;

interface AssessmentEntry {
  id: number;
  afterMessageIndex: number;
  slot:
    | { status: "running" }
    | { status: "done"; assessment: DiagnosticAssessment }
    | { status: "error"; message: string };
  // Present only on a DATA_CAPTURE assessment whose capture round is in
  // progress / done this session. Keyed by plan item index (CAPTURE_ROUND_KEY for
  // round-level states) so a multi-item plan renders one card PER item instead of
  // overwriting a single slot — the fix for the gate "flipping" mid-wait.
  // Runtime-only; SavedAssessmentEntry omits it.
  captures?: Record<number, CaptureUiState>;
  // Wall-clock time this assessment resolved (set on done; restored from the
  // saved entry on resume). SB4 history serialization orders done assessments
  // against captured-evidence results by this timestamp.
  completedAt?: string;
}

type ThreadRow =
  | { key: string; kind: "message"; message: ChatMessage }
  | { key: string; kind: "assessment"; entry: AssessmentEntry };

// Any capture slot present on this entry (round active or terminal this session).
function hasAnyCapture(entry: AssessmentEntry): boolean {
  return !!entry.captures && Object.keys(entry.captures).length > 0;
}
// Any capture slot still actively watching/capturing (gates re-run + cancel).
function anyCaptureActive(entry: AssessmentEntry): boolean {
  return Object.values(entry.captures ?? {}).some(
    (c) => c.phase === "waiting" || c.phase === "capturing",
  );
}

export default function Screen() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("intake");
  // Vehicle, recalls, and TSBs live in the global VehicleContext so the
  // auto-VIN flow (when the OBD2 adapter connects) populates the intake
  // form here automatically.
  const {
    vehicle,
    vin: ctxVin,
    source: ctxSource,
    recalls,
    tsbs,
    setVehicleManually,
    clearVehicle,
  } = useVehicle();
  // Local VIN input. SEEDED FROM THE CONNECTED ADAPTER (obd2.getConnectedVin() —
  // manager ground truth, set on Mode-09 parse, cleared on disconnect), NEVER
  // from the persisted/overridable VehicleContext vin (which leaks the PREVIOUS
  // vehicle's VIN into a fresh intake). Fresh + disconnected starts empty.
  const [vin, setVin] = useState<string>(() =>
    obd2.isConnected() ? obd2.getConnectedVin() ?? "" : "",
  );
  // Auto-import the connected vehicle's VIN into the intake field — ONCE per
  // resolved VIN, so a late auto-VIN resolve (Mode-09 decoding after the intake
  // is already open) reactively populates it, while a tech's later manual
  // edit/scan is never fought. ctxVin is the reactive trigger (it changes when
  // the auto-VIN flow commits a vehicle); we read the VALUE from
  // obd2.getConnectedVin() (ground truth) so a stale persisted obd2-auto VIN can
  // never flash in during a reconnect. Gated to the intake screen so it can
  // never write the connected car's VIN into a saved case's envelope during chat
  // (a resumed no-VIN case must stay no-VIN). Disconnected leaves the field as
  // typed. The connect-time mismatch case (tech kept a manual vehicle) keeps the
  // typed VIN naturally: "keep entered" leaves ctxVin unchanged, so this never
  // re-runs to override it.
  const autoVinAppliedRef = useRef<string | null>(null);
  useEffect(() => {
    if (phase !== "intake") return;
    if (!obd2.isConnected()) return;
    const connectedVin = obd2.getConnectedVin();
    if (connectedVin && autoVinAppliedRef.current !== connectedVin) {
      autoVinAppliedRef.current = connectedVin;
      setVin(connectedVin);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, ctxVin]);
  const [symptom, setSymptom] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [answer, setAnswer] = useState("");
  // Photo Evidence (Step 1): a photo staged in the main composer before Send,
  // and a flag while the picker is open. The transient base64 of the most
  // recently attached photo (the attach turn) lives in a ref — it's injected
  // into the ONE outgoing request and never persisted (lean cost-in-history).
  const [pendingPhoto, setPendingPhoto] = useState<ImageAttachment | null>(null);
  const [attaching, setAttaching] = useState(false);
  const pendingPhotoBase64Ref = useRef<string | null>(null);
  // Photo-on-intake (Diagnose intake screen): a photo staged at intake that
  // rides into the FIRST diagnose turn. Dedicated state (not the composer's
  // pendingPhoto). base64 is injected via pendingPhotoBase64Ref in onSubmitIntake.
  const [intakePhoto, setIntakePhoto] = useState<ImageAttachment | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // "Find a diagram" surface — opens a modal that hits POST /api/diagram-lookup
  // directly (NOT the diagnosis brain). Additive; nothing else depends on it.
  const [diagramModalOpen, setDiagramModalOpen] = useState(false);
  // PULL_CODES (Item B): the assessment entry whose brain-requested code re-pull
  // is in flight (adapter is being read). Drives the in-progress card state; null
  // when no pull is running. One pull at a time.
  const [pullingEntryId, setPullingEntryId] = useState<number | null>(null);

  // Structured-assessment state (merged Smart Diagnose path). When the
  // adapter is connected and scan data exists, an assessment runs
  // automatically on Start Diagnosis — in parallel with the conversational
  // call — and renders as a card in the thread.
  const { isConnected, status: obd2Status } = useObd2();
  // SB2-D: opening Diagnose attempts a silent reconnect to the remembered
  // adapter (gated + mutex-safe; no-op if already connected, no saved adapter,
  // or permissions not granted) so the tech doesn't have to visit the OBD2
  // screen first. The app-level owner covers launch + foreground; this covers
  // in-app navigation to Diagnose.
  useFocusEffect(
    useCallback(() => {
      obd2.ensureAutoReconnect().catch(() => {});
    }, []),
  );
  const [condition, setCondition] = useState<OperatingCondition>("WARM_IDLE");
  const [assessments, setAssessments] = useState<AssessmentEntry[]>([]);
  const assessmentIdRef = useRef(0);

  // ---- Stage 2B: case save / resume ----
  const params = useLocalSearchParams<{ resume?: string; focusVin?: string }>();
  // Captured once so the mount-time prefill effects know to skip when resuming.
  const resumeIdAtMount = useRef(
    typeof params.resume === "string" ? params.resume : null,
  ).current;
  // Active-case metadata not held in screen state. null = no active case
  // (fresh intake not yet submitted, or an unsaved session at the 25-open cap).
  const caseMetaRef = useRef<{
    id: string;
    createdAt: string;
    status: CaseStatus;
    closeReason: CaseCloseReason | null;
    closedAt: string | null;
    linkedRecordIds: string[];
    loggerSessionIds: string[];
  } | null>(null);
  // Resume marker. null = fresh session (2A behavior, guard always passes).
  // Non-null = resumed, carrying the case VIN (itself null for a no-VIN /
  // manual / pre-2008 case). Sole input to the liveVehicleMatchesCase guard.
  const resumedCaseRef = useRef<{ vin: string | null } | null>(null);
  // Merge-plan Phase 1: the full Ask thread carried by an Ask→Diagnose
  // escalation, stashed at intake-consume and seeded BEFORE the complaint at
  // submit (so the case + brain history hold the whole conversation).
  // Consume-once; cleared on resume + reset so a stale thread can't leak into
  // a later fresh intake (same discipline as the handoff drains).
  const carriedThreadRef = useRef<ChatMessage[] | null>(null);
  // Merge-plan Phase 2 (metering): which door this intake came through, for
  // the diagnosis-start usage event (and the §9 under-escalation metric —
  // how often Ask threads escalate). Set by the intake-consume effect,
  // reset to "direct" on resetSession.
  const entrySourceRef = useRef<"direct" | "ask" | "obd2">("direct");
  // Mirrors of the volatile thread arrays so saveCase reads the latest values
  // without an async-setState race; explicit overrides at each trigger are the
  // primary path, these are the backstop.
  const messagesRef = useRef<ChatMessage[]>([]);
  const assessmentsRef = useRef<AssessmentEntry[]>([]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  useEffect(() => {
    assessmentsRef.current = assessments;
  }, [assessments]);
  // Stage 2C-4: the evidence loop's persisted output. evidenceLedger accrues one
  // EvidenceCaptureEntry per completed capture round; caseState holds the
  // last-known evolved differential (REPLACE-current). Mirror the messagesRef
  // pattern so saveCase reads the latest without an async-setState race. These
  // are runtime-held (not screen state) because nothing renders off them
  // directly — the thread renders the prior+evolved assessment cards instead.
  const evidenceLedgerRef = useRef<EvidenceCaptureEntry[]>([]);
  const caseStateRef = useRef<CaseStateSlot | null>(null);

  // Stage 2C-4 capture round (one at a time). The live executor (onTick
  // subscription) + the active-round marker. roundActiveRef.complete guards
  // against the detector's trailing post-fire "waiting" card overwriting the
  // "complete" state set in onEvidence. priorSelection restores the live
  // polling selection after the round (the plan signals are added transiently).
  const captureExecutorRef = useRef<CaptureExecutor | null>(null);
  const roundActiveRef = useRef<{
    entryId: number;
    complete: boolean;
    priorSelection: PidDescriptor[];
  } | null>(null);
  // Stop any live capture subscription if the screen unmounts mid-round so the
  // detector can't keep firing in the background.
  useEffect(() => {
    return () => {
      captureExecutorRef.current?.stop();
      captureExecutorRef.current = null;
      roundActiveRef.current = null;
    };
  }, []);

  // If the adapter disconnects mid-round, the poll loop stops feeding ticks —
  // end the round gracefully instead of leaving the card stuck watching.
  useEffect(() => {
    if (!isConnected && roundActiveRef.current && !roundActiveRef.current.complete) {
      const active = roundActiveRef.current;
      setCaptures(active.entryId, {
        [CAPTURE_ROUND_KEY]: {
          phase: "stopped",
          conditionLabel: "",
          signalIds: [],
          note: "Connection lost — monitoring stopped.",
        },
      });
      teardownRound(false); // disconnect already stopped polling; nothing to restore
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected]);

  // Saved-cases list (intake) + lifecycle state.
  const [cases, setCases] = useState<CaseIndexEntry[]>([]);
  const [showAllCases, setShowAllCases] = useState(false);
  // v2 intake: the saved-cases section is a collapsed glass disclosure (closed
  // by default so the form is immediately visible).
  const [casesOpen, setCasesOpen] = useState(false);
  // When the multi-match auto-prompt routes here with ?focusVin, the list filters
  // to that vehicle's cases (open + closed) until the tech taps "Show all".
  const [caseFilterVin, setCaseFilterVin] = useState<string | null>(null);
  // True when an over-cap session is running unsaved (the tech chose "continue
  // without saving" at the all-25-open prompt). Surfaced as a chat banner.
  const [unsaved, setUnsaved] = useState(false);

  const refreshCases = () => {
    loadIndex()
      .then(setCases)
      .catch((err) => console.warn("[cases] index load failed:", err));
  };
  // Refresh the list whenever the intake screen is shown (covers initial mount
  // and every return to intake via resetSession). Cheap — index only, no bodies.
  useEffect(() => {
    if (phase === "intake") refreshCases();
  }, [phase]);

  // Mark a diagnose CHAT session active so the VIN auto-prompt won't hijack it.
  useEffect(() => {
    setDiagnoseSessionActive(phase === "chat");
    return () => setDiagnoseSessionActive(false);
  }, [phase]);

  // Apply a ?focusVin filter from the multi-match auto-prompt.
  useEffect(() => {
    if (typeof params.focusVin === "string" && params.focusVin) {
      setCaseFilterVin(params.focusVin);
      setShowAllCases(true);
    }
  }, [params.focusVin]);

  const displayedCases = caseFilterVin
    ? cases.filter(
        (c) =>
          c.vin != null &&
          c.vin.toUpperCase() === caseFilterVin.toUpperCase(),
      )
    : cases;

  // The different-vehicle guard — the ONE place the resume-eligibility rule
  // lives at render time (the resume-time block lives in the resume effect).
  // Returns whether the live connection is provably the case's vehicle:
  //   - fresh session            → true  (2A behavior, untouched)
  //   - resumed, disconnected    → true  (no live car; canAutoAssess gates it)
  //   - resumed no-VIN, connected→ false (can't prove same car → hard suppress;
  //                                 closes the no-VIN leak structurally)
  //   - resumed VIN, connected   → connected VIN must equal the case VIN
  // connectedVin is read from the OBD2 manager (ground truth), never from the
  // overridable VehicleContext.
  function liveVehicleMatchesCase(): boolean {
    const r = resumedCaseRef.current;
    if (!r) return true;
    if (!isConnected) return true;
    if (r.vin == null) return false;
    const live = obd2.getConnectedVin();
    return live != null && live.toUpperCase() === r.vin.toUpperCase();
  }

  const [scannerOpen, setScannerOpen] = useState(false);
  const [decoding, setDecoding] = useState(false);
  const [decodeError, setDecodeError] = useState<string | null>(null);
  const [decoded, setDecoded] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const lastDecodedRef = useRef<string>("");

  const [confirmedDone, setConfirmedDone] = useState(false);
  const [savingRecord, setSavingRecord] = useState(false);

  const listRef = useRef<FlatList<ThreadRow> | null>(null);
  const insets = useSafeAreaInsets();
  // Height of the chrome above the KAV — measured for the iOS KAV offset.
  const [headerHeight, setHeaderHeight] = useState(0);
  // Manual keyboard-height tracking for Android. KeyboardAvoidingView is
  // unreliable on Android (especially with newArch + expo-router), so we
  // listen to the Keyboard API directly and apply paddingBottom equal to
  // the keyboard height. On iOS this stays 0 and KAV does the work.
  const [androidKbHeight, setAndroidKbHeight] = useState(0);

  // Keyboard height tracking (all phases) + auto-scroll in chat phase.
  // The KAV on iOS handles intake; Android needs manual paddingBottom tracking
  // for both the intake ScrollView and the chat input bar.
  useEffect(() => {
    const showSub = Keyboard.addListener("keyboardDidShow", (e) => {
      if (Platform.OS === "android") {
        setAndroidKbHeight(e.endCoordinates.height);
      }
      if (phase === "chat") {
        setTimeout(() => {
          listRef.current?.scrollToEnd({ animated: true });
        }, 60);
      }
    });
    const hideSub = Keyboard.addListener("keyboardDidHide", () => {
      if (Platform.OS === "android") setAndroidKbHeight(0);
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [phase]);

  // Mount-time intake entry. ONE effect handles all non-resume entry paths in
  // sequence (no inter-effect ordering/consume races): OBD2 escalation, then an
  // Ask→Diagnose handoff, then — if neither applies — a fresh start. The
  // fresh-start branch closes the previous-vehicle leak: a brand-new diagnosis
  // opened while DISCONNECTED begins with empty fields (mirroring
  // resetSession's disconnected branch) instead of inheriting the persisted
  // global vehicle. When CONNECTED, the auto-VIN vehicle is kept (the
  // legitimate persist case); a resume is handled entirely by the resume effect
  // (guarded out here); cross-mode carryover stays explicit via the handoff.
  useEffect(() => {
    if (resumeIdAtMount) return; // resuming → the resume effect drains handoffs
    let active = true;
    (async () => {
      // 1. OBD2 escalation (in-memory, consume-once). Sets the complaint to the
      //    scanned codes; the vehicle is the connected one, left as-is.
      const esc = consumeObd2DiagnoseEscalation();
      if (esc) {
        entrySourceRef.current = "obd2";
        const dtcLine =
          esc.dtcs.length > 0
            ? `OBD2 scan — stored codes: ${esc.dtcs.join(", ")}.`
            : "";
        const permLine =
          esc.permanentDtcs.length > 0
            ? `Permanent codes (survived last clear): ${esc.permanentDtcs.join(", ")}.`
            : "";
        const combined = [dtcLine, permLine].filter((s) => s).join("\n\n");
        if (combined) setSymptom(combined);
        return; // explicit entry — do not clear
      }
      // 2. Ask→Diagnose handoff (AsyncStorage, consume). Prefills vehicle +
      //    complaint; vehicle pushes to context so recall/TSB lookups fire.
      const h = await consumeHandoff("to_diagnose");
      if (!active) return;
      if (h) {
        entrySourceRef.current = "ask";
        if (h.vehicle) {
          setVehicleManually(
            { ...EMPTY_VEHICLE, ...h.vehicle },
            h.vin ?? null,
          ).catch(() => {});
        }
        if (h.vin) setVin(h.vin);
        // Merge-plan Phase 1: stash the carried Ask thread (tolerant read —
        // same sanitizer as the case migrator; base64 never restored, unknown
        // fields dropped). Trim leading assistant turns so the seeded thread
        // starts on a user turn — preserves endOnUserTurn's can't-empty
        // invariant and the API's user-first ordering.
        const carried = sanitizeMessages(h.messages);
        while (carried.length > 0 && carried[0].role === "assistant") {
          carried.shift();
        }
        carriedThreadRef.current = carried.length > 0 ? carried : null;
        const dtcLine =
          h.dtcs && h.dtcs.length > 0
            ? `OBD2 scan — stored codes: ${h.dtcs.join(", ")}.`
            : "";
        const permLine =
          h.permanentDtcs && h.permanentDtcs.length > 0
            ? `Permanent codes (survived last clear): ${h.permanentDtcs.join(", ")}.`
            : "";
        const combined = [dtcLine, permLine, h.symptom]
          .filter((s) => s)
          .join("\n\n");
        if (combined) setSymptom(combined);
        return; // explicit entry — do not clear
      }
      // 3. Genuinely fresh intake. When DISCONNECTED, start empty (same clears
      //    as resetSession's disconnected branch) so the previous vehicle
      //    doesn't leak in. When CONNECTED, keep the auto-VIN vehicle.
      if (!isConnected) {
        setVin("");
        setDecoded(false);
        setDecodeError(null);
        setManualOpen(false);
        lastDecodedRef.current = "";
        clearVehicle().catch(() => {});
      }
    })();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Resume a saved case (?resume=<id>). Drains any pending escalation /
  // to_diagnose handoff (consume + discard) so a stale prefill can't surface in
  // a later fresh intake on this screen instance, then either BLOCKS (truth-
  // table row 4) or applies the resume.
  useEffect(() => {
    const resumeId = typeof params.resume === "string" ? params.resume : null;
    if (!resumeId) return;
    attemptResume(resumeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.resume]);

  // Block-checked resume, shared by the ?resume param effect (external entry —
  // Batch 4 auto-prompt) and the saved-cases list taps (in-screen entry).
  // Drains pending handoffs so a stale prefill can't surface later, enforces
  // the resume-time different-vehicle BLOCK (truth-table row 4 — connectedVin is
  // ground truth from the OBD2 manager, not the overridable context), then
  // applies the resume.
  async function attemptResume(resumeId: string): Promise<void> {
    const saved = await loadCase(resumeId);
    consumeObd2DiagnoseEscalation();
    consumeHandoff("to_diagnose").catch(() => {});
    carriedThreadRef.current = null; // resume wins over a stale carried thread
    if (!saved) {
      // Gone / unreadable (e.g. a future-version body after a rollback).
      Alert.alert(
        "Case unavailable",
        "This case couldn't be loaded — it may have been removed, or was saved by a newer version of the app.",
      );
      refreshCases();
      return;
    }
    if (saved.vehicle.vin && isConnected) {
      const live = obd2.getConnectedVin();
      if (live && live.toUpperCase() !== saved.vehicle.vin.toUpperCase()) {
        const name =
          [
            saved.vehicle.vehicle.year,
            saved.vehicle.vehicle.make,
            saved.vehicle.vehicle.model,
          ]
            .filter((s) => s && s.length > 0)
            .join(" ") || "case vehicle";
        Alert.alert(
          "Different vehicle connected",
          `This case is for a ${vehicleLabel(saved.vehicle)}. You're connected to a different vehicle. Disconnect, or connect to the ${name}, to resume it.`,
        );
        return; // conversation never opens
      }
    }
    applyResume(saved);
  }

  // Restore a saved case into the screen. The envelope carries NO live data, so
  // nothing here can arm the assess gate; resumedCaseRef makes the guard active.
  function applyResume(saved: DiagnosticCase): void {
    resumedCaseRef.current = { vin: saved.vehicle.vin };
    caseMetaRef.current = {
      id: saved.id,
      createdAt: saved.createdAt,
      status: saved.status,
      closeReason: saved.closeReason,
      closedAt: saved.closedAt,
      linkedRecordIds: [...saved.linkedRecordIds],
      loggerSessionIds: [...saved.loggerSessionIds],
    };
    // Restore the case vehicle into context UNLESS the live connection already
    // IS the case car (VIN match) — then leave the live context untouched to
    // avoid a needless recall/TSB refetch + flicker.
    const liveMatch =
      saved.vehicle.vin != null &&
      isConnected &&
      obd2.getConnectedVin()?.toUpperCase() ===
        saved.vehicle.vin.toUpperCase();
    if (!liveMatch) {
      setVehicleManually(
        { ...EMPTY_VEHICLE, ...saved.vehicle.vehicle },
        saved.vehicle.vin,
      ).catch(() => {});
      setVin(saved.vehicle.vin ?? "");
    }
    setSymptom(saved.complaint);
    setCondition(saved.operatingCondition);
    setMessages(saved.messages);
    messagesRef.current = saved.messages;
    const restored: AssessmentEntry[] = saved.assessments.map((sa, i) => ({
      id: i + 1,
      afterMessageIndex: sa.afterMessageIndex,
      slot:
        sa.result.status === "done"
          ? { status: "done", assessment: sa.result.assessment }
          : { status: "error", message: sa.result.message },
      // Restore the resolve time so a resumed case serializes its history in
      // true order (SB4); ledger captures carry their own afterMessageIndex.
      completedAt: sa.completedAt,
    }));
    setAssessments(restored);
    assessmentsRef.current = restored;
    assessmentIdRef.current = restored.length; // next re-run gets a fresh id
    // Stage 2C-4: restore the evidence-loop output so a resumed case carries its
    // capture history + last-known evolved differential forward.
    evidenceLedgerRef.current = [...saved.evidenceLedger];
    caseStateRef.current = saved.caseState;
    setConfirmedDone(
      saved.status === "closed" && saved.closeReason === "fix_confirmed",
    );
    setError(null);
    setPhase("chat");
  }

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
          series: d.series || vehicle.series,
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

  // Auto-assessment gate. Descriptors come from the OBD2 escalation handoff
  // when present, falling back to the manager's live polling selection (the
  // home-tile entry path). DTCs/freeze frame only travel via the handoff —
  // they live in the OBD2 screen's component state, not the manager.
  const obd2Handoff = getObd2DiagnoseHandoff();
  const assessDescriptors =
    obd2Handoff.selectedDescriptors.length > 0
      ? obd2Handoff.selectedDescriptors
      : obd2.getSelectedPids();
  const assessDtcCount =
    obd2Handoff.dtcs.length +
    obd2Handoff.pendingDtcs.length +
    obd2Handoff.permanentDtcs.length;
  // Same rule that gated Smart Diagnose's run button: never fire an
  // assessment with nothing to assess (connected but zero signals + zero
  // DTCs adds no information and burns an Opus call).
  const canAutoAssess =
    isConnected && (assessDescriptors.length > 0 || assessDtcCount > 0);

  // SB4: the 2B-guarded live connection — a vehicle is connected AND it's this
  // case's vehicle (fresh sessions always pass the guard). The SOLE gate for
  // sending a live snapshot and running a capture. It deliberately does NOT
  // require pre-selected signals/DTCs (the old canAutoAssess/liveAssessmentAllowed
  // condition): a brain-requested capture resolves + selects its own PIDs, so the
  // Start gate must be available even with nothing pre-selected. canAutoAssess
  // remains only for the intake-screen "live data available" affordance.
  const captureConnectionOk = isConnected && liveVehicleMatchesCase();
  // WHY a brain-requested capture can't run, for the affordance label/branch
  // (investigation: never conflate "no adapter" with "wrong vehicle"). Mirrors
  // captureConnectionOk's two factors: not connected at all vs connected to a
  // vehicle that isn't this case's (resumed VIN-mismatch / resumed manual).
  const captureGate: "ready" | "disconnected" | "wrong_vehicle" = !isConnected
    ? "disconnected"
    : !liveVehicleMatchesCase()
      ? "wrong_vehicle"
      : "ready";
  // When resumed + connected but the guard fails, explain why the live path is
  // off (two distinct reasons → two messages).
  const resumeBlockBanner =
    resumedCaseRef.current && isConnected && !liveVehicleMatchesCase()
      ? resumedCaseRef.current.vin == null
        ? "Live assessment isn't available on a resumed manually-entered case. Start a new case to assess the connected vehicle."
        : "Connected to a different vehicle than this case — live assessment is disabled. Connect to this case's vehicle to assess it."
      : null;

  // ---- Persist the current envelope (Stage 2B) ----
  // No-op when there's no active case (fresh intake pre-submit, or an unsaved
  // over-cap session). Fire-and-forget — a failed write logs and never blocks
  // the UI. `over` supplies the just-changed array so we never read stale state.
  function saveCase(over?: {
    messages?: ChatMessage[];
    assessments?: AssessmentEntry[];
    evidenceLedger?: EvidenceCaptureEntry[];
    caseState?: CaseStateSlot | null;
  }): void {
    const meta = caseMetaRef.current;
    if (!meta) return;
    const sid = diagnosticLogger.getCurrentSessionId();
    if (sid && !meta.loggerSessionIds.includes(sid)) {
      meta.loggerSessionIds.push(sid);
    }
    const msgs = over?.messages ?? messagesRef.current;
    const asmts = over?.assessments ?? assessmentsRef.current;
    const savedAssessments = asmts
      .map((a): SavedAssessmentEntry | null => {
        if (a.slot.status === "done") {
          return {
            afterMessageIndex: a.afterMessageIndex,
            result: { status: "done", assessment: a.slot.assessment },
            operatingCondition: condition,
            completedAt: new Date().toISOString(),
          };
        }
        if (a.slot.status === "error") {
          return {
            afterMessageIndex: a.afterMessageIndex,
            result: { status: "error", message: a.slot.message },
            operatingCondition: condition,
            completedAt: new Date().toISOString(),
          };
        }
        return null; // running slots are never persisted
      })
      .filter((x): x is SavedAssessmentEntry => x !== null);

    const envelope: DiagnosticCase = {
      schemaVersion: 1,
      id: meta.id,
      status: meta.status,
      closeReason: meta.closeReason,
      createdAt: meta.createdAt,
      updatedAt: new Date().toISOString(),
      closedAt: meta.closedAt,
      vehicle: { vehicle, vin: vin.trim() || null, source: ctxSource },
      complaint: symptom.trim(),
      mileage: vehicle.mileage,
      operatingCondition: condition,
      messages: msgs,
      assessments: savedAssessments,
      linkedRecordIds: meta.linkedRecordIds,
      loggerSessionIds: meta.loggerSessionIds,
      // Stage 2C-4: persist the evidence-loop output (was hardcoded []/null,
      // which erased every round's result on the next save). `over` supplies the
      // just-changed value so we never read stale refs.
      evidenceLedger: over?.evidenceLedger ?? evidenceLedgerRef.current,
      caseState:
        over?.caseState !== undefined ? over.caseState : caseStateRef.current,
    };
    upsertCase(envelope).catch((err) =>
      console.warn("[cases] save failed:", err),
    );
  }

  // DEAD (SB4): the thread no longer fires /api/assess directly — the unified
  // brain (runDiagnoseTurn) emits assessments. Kept until the focused dead-code
  // cleanup pass (with the unused assess() client); not called from anywhere.
  async function runAssessment(afterMessageIndex: number, complaintText: string) {
    const id = ++assessmentIdRef.current;
    const withRunning: AssessmentEntry[] = [
      ...assessmentsRef.current,
      { id, afterMessageIndex, slot: { status: "running" } },
    ];
    setAssessments(withRunning);
    assessmentsRef.current = withRunning;
    // Running slots are intentionally not persisted (an in-flight call can't
    // survive a process death), so no saveCase() here.

    const handoff = getObd2DiagnoseHandoff();
    const descriptors =
      handoff.selectedDescriptors.length > 0
        ? handoff.selectedDescriptors
        : obd2.getSelectedPids();
    const ringBuffer = obd2.captureSnapshot(5000);
    const snapshot = buildDiagnosticSnapshot(
      ringBuffer,
      descriptors,
      condition,
      handoff.dtcs,
      handoff.pendingDtcs,
      handoff.permanentDtcs,
      handoff.freezeFrame,
    );

    try {
      const result = await assess(
        vehicle,
        vin.trim() || null,
        vehicle.mileage,
        complaintText,
        snapshot,
        recalls,
        tsbs,
        diagnosticLogger.getCurrentSessionId(),
      );
      diagnosticLogger.log({
        type: "assessment",
        vehicle: vehicle.year
          ? { year: vehicle.year, make: vehicle.make, model: vehicle.model, vin: vin.trim() || null }
          : undefined,
        assessment: result.assessment,
        operatingCondition: condition,
        apiCost: result.cost,
      });
      const next = assessmentsRef.current.map((a) =>
        a.id === id
          ? {
              ...a,
              slot: { status: "done" as const, assessment: result.assessment },
            }
          : a,
      );
      setAssessments(next);
      assessmentsRef.current = next;
      saveCase({ assessments: next });
    } catch (err) {
      const msg =
        err instanceof AssessError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Assessment failed.";
      const next = assessmentsRef.current.map((a) =>
        a.id === id
          ? { ...a, slot: { status: "error" as const, message: msg } }
          : a,
      );
      setAssessments(next);
      assessmentsRef.current = next;
      saveCase({ assessments: next });
    }
  }

  // ---- Stage 2C-4: single-round evidence loop ----
  // MINIMAL wiring to run ONE capture round end-to-end. SUB-BATCH 2 replaces the
  // Start affordance with the hands-off per-round driving UX and adds the
  // self-continuing loop. Nothing here auto-continues.

  // Merge plan descriptors into the current polling selection (dedupe by
  // signalKey; the plan's aiSelected descriptors win).
  function mergeSelection(
    current: PidDescriptor[],
    add: PidDescriptor[],
  ): PidDescriptor[] {
    const byKey = new Map<string, PidDescriptor>();
    for (const p of current) byKey.set(p.signalKey ?? signalKeyOf(p), p);
    for (const p of add) byKey.set(p.signalKey ?? signalKeyOf(p), p);
    return [...byKey.values()];
  }

  // Patch the transient capture state for ONE plan item on an assessment entry
  // (merge). Keyed by itemIndex so concurrent items don't overwrite each other.
  function patchCapture(
    entryId: number,
    itemIndex: number,
    patch: Partial<CaptureUiState>,
  ): void {
    const next = assessmentsRef.current.map((a) => {
      if (a.id !== entryId) return a;
      const captures = { ...(a.captures ?? {}) };
      const base: CaptureUiState =
        captures[itemIndex] ?? { phase: "waiting", conditionLabel: "", signalIds: [] };
      captures[itemIndex] = { ...base, ...patch };
      return { ...a, captures };
    });
    setAssessments(next);
    assessmentsRef.current = next;
  }

  // Replace the whole per-item capture map for an entry (seed / complete / clear).
  function setCaptures(entryId: number, captures: Record<number, CaptureUiState>): void {
    const next = assessmentsRef.current.map((a) =>
      a.id === entryId ? { ...a, captures } : a,
    );
    setAssessments(next);
    assessmentsRef.current = next;
  }

  // Merge a patch into EVERY current capture slot on an entry (round-wide notes:
  // pause/resume). No-op if the entry has no capture slots.
  function patchAllCaptures(entryId: number, patch: Partial<CaptureUiState>): void {
    const next = assessmentsRef.current.map((a) => {
      if (a.id !== entryId || !a.captures) return a;
      const captures: Record<number, CaptureUiState> = {};
      for (const [k, v] of Object.entries(a.captures)) {
        captures[Number(k)] = { ...v, ...patch };
      }
      return { ...a, captures };
    });
    setAssessments(next);
    assessmentsRef.current = next;
  }

  function teardownRound(restoreSelection: boolean): void {
    const active = roundActiveRef.current;
    captureExecutorRef.current?.stop();
    captureExecutorRef.current = null;
    if (restoreSelection && active) {
      // Drop the transiently-added plan signals from the live polling view.
      try {
        obd2.setSelectedPids(active.priorSelection);
      } catch {
        // best-effort
      }
    }
    roundActiveRef.current = null;
  }

  // Kick off ONE capture round from a DATA_CAPTURE assessment card.
  // Press handler for the DATA_CAPTURE affordance. The affordance now renders
  // even when a capture can't run (mirrors the PULL_CODES precedent: always show
  // a button, branch in the handler) so the tech is never left with a dangling
  // instruction. Branches on the REASON it can't run — disconnected routes to
  // the Connect-a-Device surface; wrong/unprovable vehicle surfaces the existing
  // resume-block messaging (NOT a connect prompt — the adapter is already on);
  // ready runs the round exactly as before. The capture loop internals are
  // untouched.
  function handleStartCapturePress(entry: AssessmentEntry): void {
    if (!isConnected) {
      router.push("/connect");
      return;
    }
    if (!liveVehicleMatchesCase()) {
      Alert.alert(
        "Connected to a different vehicle",
        resumeBlockBanner ??
          "Connected to a different vehicle than this case — live assessment is disabled. Connect to this case's vehicle to capture live data.",
      );
      return;
    }
    void startCaptureRound(entry);
  }

  async function startCaptureRound(entry: AssessmentEntry): Promise<void> {
    if (roundActiveRef.current) return; // one round at a time
    if (entry.slot.status !== "done") return;
    const assessment = entry.slot.assessment;
    if (assessment.next_step.type !== "DATA_CAPTURE") return;
    const requestedData = assessment.next_step.requested_data ?? [];
    if (requestedData.length === 0) return;
    if (!captureConnectionOk) return; // connected + different-vehicle guard (2B)

    // Immediate per-item "waiting" cards so the tech sees feedback instantly,
    // seeded from the RAW plan with the SAME gate-only arming label the detector
    // will emit on its first tick — no prose→numeric flip (the operating_condition
    // prose is NOT shown as the gate). Refined by onCard once ticks arrive.
    const seed: Record<number, CaptureUiState> = {};
    requestedData.forEach((rd, i) => {
      if (!rd.capture_plan) return; // prose-only item — not executable, no card
      seed[i] = {
        phase: "waiting",
        conditionLabel: describeArmingConditionFromPlan(rd.capture_plan),
        signalIds: listRecordedSignalIdsFromPlan(rd.capture_plan),
        recordedSignalIds: listRecordedSignalIdsFromPlan(rd.capture_plan),
        durationSeconds: rd.capture_plan.capture_window_seconds,
      };
    });
    setCaptures(entry.id, seed);

    // Build the resolve context from the connected vehicle. DB-2: prefer the
    // cached catalog (now persisted app-wide on connect via VehicleContext), and
    // fall back to a direct network fetch (+persist) for the cold-cache race
    // (e.g. resume → tap Start before the app-wide prefetch lands) or a vehicle
    // never warmed. Only a true miss (no cache AND no network) blocks the round.
    let catalog = await loadCachedCatalog(
      vehicle.make,
      vehicle.model,
      vehicle.year,
    );
    if (!catalog) {
      catalog = await fetchPidCatalog(vehicle.make, vehicle.model, vehicle.year);
      if (catalog) saveCatalog(catalog).catch(() => {});
    }
    if (!catalog) {
      setCaptures(entry.id, {
        [CAPTURE_ROUND_KEY]: {
          phase: "unavailable",
          conditionLabel: "",
          signalIds: [],
          note: "Couldn't load this vehicle's signal catalog to set up monitoring — check your connection and try again.",
        },
      });
      return;
    }
    const selectedKeys = new Set(
      obd2.getSelectedPids().map((p) => p.signalKey ?? signalKeyOf(p)),
    );
    const supportedMode01 =
      (await loadCachedBitmask(vehicle.make, vehicle.model, vehicle.year)) ??
      new Set<number>();
    const resolveContext: ResolveContext = {
      catalog: catalog.signals,
      selectedKeys,
      supportedMode01,
      unsupportedKeys: obd2.getUnsupportedPids(),
    };

    // Resolve to know which signals are runnable + which to poll.
    const resolved = resolvePlan(requestedData, resolveContext);
    const runnable = resolved.filter((r) => r.runnable);
    if (runnable.length === 0) {
      const firstUnrunnable = resolved.find((r) => !r.runnable);
      const reason =
        firstUnrunnable && !firstUnrunnable.runnable
          ? `${firstUnrunnable.targetSignalId} (${firstUnrunnable.detail.status === "unavailable" ? firstUnrunnable.detail.reason : "unavailable"})`
          : "the requested signal";
      setCaptures(entry.id, {
        [CAPTURE_ROUND_KEY]: {
          phase: "unavailable",
          conditionLabel: "",
          signalIds: [],
          note: `Can't watch ${reason} on this vehicle. Pick a different test or capture it manually on the OBD2 screen.`,
        },
      });
      return;
    }

    // Re-seed the live cards to exactly the RUNNABLE items (drops any item whose
    // target couldn't bind), using the detector's own gate-only label so the
    // first onCard tick is identical (no flip).
    const runnableSeed: Record<number, CaptureUiState> = {};
    for (const item of runnable) {
      if (!item.runnable) continue;
      runnableSeed[item.itemIndex] = {
        phase: "waiting",
        conditionLabel: describeArmingCondition(item),
        signalIds: listRecordedSignalIds(item),
        recordedSignalIds: listRecordedSignalIds(item),
        durationSeconds: item.captureWindowSeconds,
      };
    }
    setCaptures(entry.id, runnableSeed);

    // Collect the resolved plan signalKeys and build descriptors to poll.
    const planKeys = new Set<string>();
    for (const item of runnable) {
      if (!item.runnable) continue;
      for (const t of item.targets) {
        if (t.availability.status === "resolved") planKeys.add(t.availability.signalKey);
      }
      for (const g of item.gate) {
        if (g.availability.status === "resolved") planKeys.add(g.availability.signalKey);
      }
    }
    const planDescriptors = buildSelectedDescriptors(
      catalog,
      [...planKeys],
      resolveContext.unsupportedKeys,
      planKeys,
    );

    // Apply the plan to the live polling driver (existing API; in-memory only).
    const priorSelection = obd2.getSelectedPids();
    const merged = mergeSelection(priorSelection, planDescriptors);
    obd2.setSelectedPids(merged);
    if (!obd2.isPolling()) {
      obd2.startPolling(merged);
    }

    const handoff = getObd2DiagnoseHandoff();
    const executor = new CaptureExecutor({
      requestedData,
      resolveContext,
      evidenceContext: {
        descriptors: planDescriptors,
        operatingCondition: condition,
        dtcs: handoff.dtcs,
        pendingDtcs: handoff.pendingDtcs,
        permanentDtcs: handoff.permanentDtcs,
        freezeFrame: handoff.freezeFrame,
      },
      callbacks: {
        onCard: (u) => {
          if (roundActiveRef.current?.complete) return; // ignore post-fire reset
          // Keyed by u.itemIndex so concurrent plan items render distinct cards
          // instead of overwriting one slot (the mid-wait "flip" fix).
          patchCapture(entry.id, u.itemIndex, {
            phase: u.state,
            conditionLabel: u.conditionLabel,
            signalIds: u.signalIds,
            recordedSignalIds: u.recordedSignalIds,
            conditions: u.conditions,
            durationSeconds: u.durationSeconds,
            progress: u.progress,
            note: undefined,
          });
        },
        onEvidence: (evidence) => {
          handleCaptureEvidence(entry, assessment, evidence);
        },
        onStatus: (s) => {
          if (s.type === "paused") {
            patchAllCaptures(entry.id, { note: "Paused — waiting for live data…" });
          } else if (s.type === "resumed") {
            patchAllCaptures(entry.id, { note: undefined });
          }
        },
      },
    });
    captureExecutorRef.current = executor;
    roundActiveRef.current = { entryId: entry.id, complete: false, priorSelection };
    executor.start();
  }

  // PULL_CODES (Item B): the brain asked for a fresh trouble-code re-read mid-
  // session (e.g. confirm a code cleared after a repair). Runs Mode 03/07/0A on
  // the connected vehicle at zero technician effort and injects the fresh codes
  // as the next user turn — the SAME on-demand path as a capture/finding result
  // (sendUserMessage → runDiagnoseTurn), NOT /api/evidence. Degrades gracefully:
  // when no live connection passes the 2B guard we DON'T read codes off the wrong
  // (or absent) vehicle — we route to /connect so the tech hooks up this case's
  // vehicle first.
  async function pullCodes(entry: AssessmentEntry): Promise<void> {
    if (pullingEntryId != null) return; // one pull at a time
    if (entry.slot.status !== "done") return;
    if (entry.slot.assessment.next_step.type !== "PULL_CODES") return;
    if (!captureConnectionOk) {
      router.push("/connect");
      return;
    }
    setPullingEntryId(entry.id);
    try {
      const res = await obd2.scanDtcs();
      // Same dtcLine/permLine phrasing as the escalation handoff (above) so the
      // brain reads fresh codes in a format it already understands.
      const dtcLine =
        res.dtcs.length > 0
          ? `OBD2 scan — stored codes: ${res.dtcs.join(", ")}.`
          : "OBD2 scan — no stored codes.";
      const pendLine =
        res.pending.length > 0 ? `Pending codes: ${res.pending.join(", ")}.` : "";
      const permLine =
        res.permanent.length > 0
          ? `Permanent codes (survived last clear): ${res.permanent.join(", ")}.`
          : "";
      const combined = ["Re-scanned codes.", dtcLine, pendLine, permLine]
        .filter((s) => s)
        .join("\n\n");
      await sendUserMessage(combined);
    } catch {
      await sendUserMessage(
        "Re-scanned codes — the adapter didn't return a clean read (the connection may have dropped). Treat the codes as unchanged from the last scan.",
      );
    } finally {
      setPullingEntryId(null);
    }
  }

  // The capture fired (or was cancelled). One round → on a real capture, send to
  // /api/evidence-update; on cancel, just stop.
  function handleCaptureEvidence(
    entry: AssessmentEntry,
    priorAssessment: DiagnosticAssessment,
    evidence: EvidenceCaptureEntry,
  ): void {
    const active = roundActiveRef.current;
    if (active) active.complete = true;

    if (evidence.outcome === "cancelled") {
      setCaptures(entry.id, {
        [CAPTURE_ROUND_KEY]: {
          phase: "stopped",
          conditionLabel: "",
          signalIds: [],
          note: "Monitoring stopped.",
        },
      });
      teardownRound(true);
      return;
    }

    // Completed (or timeout with a partial window): mark the FIRED item complete
    // (and drop the other items' now-stale waiting cards — the round concluded),
    // stop the executor + restore polling, persist the evidence, and interpret it.
    const firedIndex = evidence.trigger?.firedItemIndex ?? CAPTURE_ROUND_KEY;
    const firedBase =
      assessmentsRef.current.find((a) => a.id === entry.id)?.captures?.[firedIndex];
    setCaptures(entry.id, {
      [firedIndex]: {
        phase: "complete",
        conditionLabel: firedBase?.conditionLabel ?? "",
        signalIds: firedBase?.signalIds ?? [],
        recordedSignalIds: firedBase?.recordedSignalIds,
        durationSeconds: firedBase?.durationSeconds,
        progress: 1,
      },
    });
    captureExecutorRef.current?.stop();
    captureExecutorRef.current = null;
    if (active) {
      try {
        obd2.setSelectedPids(active.priorSelection);
      } catch {
        // best-effort
      }
    }
    // Stamp the thread anchor (SB4) so history serialization can order this
    // capture against the surrounding assessments — including after a resume.
    // Done here (not in the executor) so the 2C-4 executor stays untouched.
    const stamped: EvidenceCaptureEntry = {
      ...evidence,
      afterMessageIndex: Math.max(messagesRef.current.length - 1, 0),
    };
    const ledger = [...evidenceLedgerRef.current, stamped];
    evidenceLedgerRef.current = ledger;
    runEvidenceUpdate(priorAssessment, stamped, ledger);
  }

  // Send the captured evidence + prior assessment to the server and render the
  // evolved assessment as a new anchored card; write caseState/ledger to chart.
  async function runEvidenceUpdate(
    priorAssessment: DiagnosticAssessment,
    evidence: EvidenceCaptureEntry,
    ledger: EvidenceCaptureEntry[],
  ): Promise<void> {
    const id = ++assessmentIdRef.current;
    const afterMessageIndex = Math.max(messagesRef.current.length - 1, 0);
    const withRunning: AssessmentEntry[] = [
      ...assessmentsRef.current,
      { id, afterMessageIndex, slot: { status: "running" } },
    ];
    setAssessments(withRunning);
    assessmentsRef.current = withRunning;

    try {
      const result = await evidenceUpdate(
        vehicle,
        vin.trim() || null,
        vehicle.mileage,
        symptom.trim(),
        priorAssessment,
        evidence,
        recalls,
        tsbs,
        diagnosticLogger.getCurrentSessionId(),
        caseMetaRef.current?.id ?? null,
      );
      diagnosticLogger.log({
        type: "assessment",
        vehicle: vehicle.year
          ? { year: vehicle.year, make: vehicle.make, model: vehicle.model, vin: vin.trim() || null }
          : undefined,
        assessment: result.assessment,
        operatingCondition: condition,
        apiCost: result.cost,
      });
      const evolved = result.assessment;
      // REPLACE-current caseState; the prior assessment stays in assessments[]
      // (the history). One stepsTaken line per round — the diagnostic trail.
      const caseState: CaseStateSlot = {
        hypotheses: evolved.hypotheses,
        ruledOut: caseStateRef.current?.ruledOut ?? [],
        stepsTaken: [
          ...(caseStateRef.current?.stepsTaken ?? []),
          {
            action: priorAssessment.next_step.action,
            result: `Captured evidence → ${evolved.hypotheses[0]?.name ?? "updated differential"}`,
            at: new Date().toISOString(),
          },
        ],
      };
      caseStateRef.current = caseState;
      const next = assessmentsRef.current.map((a) =>
        a.id === id
          ? {
              ...a,
              slot: { status: "done" as const, assessment: evolved },
              completedAt: new Date().toISOString(),
            }
          : a,
      );
      setAssessments(next);
      assessmentsRef.current = next;
      saveCase({ assessments: next, evidenceLedger: ledger, caseState });
    } catch (err) {
      const msg =
        err instanceof EvidenceUpdateError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Evidence update failed.";
      const next = assessmentsRef.current.map((a) =>
        a.id === id
          ? { ...a, slot: { status: "error" as const, message: msg } }
          : a,
      );
      setAssessments(next);
      assessmentsRef.current = next;
      // The capture still happened — persist the ledger even though the
      // interpretation failed (caseState unchanged).
      saveCase({ assessments: next, evidenceLedger: ledger });
    } finally {
      roundActiveRef.current = null;
    }
  }

  function cancelCaptureRound(): void {
    const active = roundActiveRef.current;
    if (!active) return;
    setCaptures(active.entryId, {
      [CAPTURE_ROUND_KEY]: {
        phase: "stopped",
        conditionLabel: "",
        signalIds: [],
        note: "Monitoring stopped.",
      },
    });
    teardownRound(true);
  }

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
  // The conclusion can arrive on EITHER path: provide_diagnosis (a "diagnosis"
  // message turn) OR a STRONGLY_SUPPORTED emit_diagnostic_assessment (an
  // AssessmentEntry card, never a message). Pull the advisory ids from whichever
  // delivered the conclusion. For the assessment path we only read the LATEST
  // done assessment AND only when it's the current thread tail (no later user/
  // assistant turn) — the same not-yet-superseded anchor test used elsewhere — so
  // a recall heads-up can't linger after the tech continues past the conclusion.
  // The brain populates these fields ONLY at conclusion, so mid-diagnosis
  // assessments carry empty arrays and never surface an advisory.
  const concludingAdvisory = useMemo<{ recalls: string[]; tsbs: string[] }>(() => {
    if (latestTurn?.kind === "diagnosis") {
      return {
        recalls: latestTurn.diagnosis.relevant_recall_campaigns ?? [],
        tsbs: latestTurn.diagnosis.relevant_tsb_numbers ?? [],
      };
    }
    const last = assessments[assessments.length - 1];
    if (
      last &&
      last.slot.status === "done" &&
      last.afterMessageIndex >= messages.length - 1
    ) {
      return {
        recalls: last.slot.assessment.relevant_recall_campaigns ?? [],
        tsbs: last.slot.assessment.relevant_tsb_numbers ?? [],
      };
    }
    return { recalls: [], tsbs: [] };
  }, [latestTurn, assessments, messages.length]);
  const relevantRecalls = useMemo(() => {
    const ids = new Set(concludingAdvisory.recalls);
    return recalls.filter((r) => ids.has(r.campaignNumber));
  }, [concludingAdvisory, recalls]);
  const relevantTsbs = useMemo(() => {
    const ids = new Set(concludingAdvisory.tsbs);
    return tsbs.filter((t) => ids.has(t.number));
  }, [concludingAdvisory, tsbs]);

  // Interleave assessment cards into the message thread at their anchored
  // positions. Keys are stable (message index / assessment id) so a slot's
  // card updates in place when its assessment resolves.
  const threadRows = useMemo<ThreadRow[]>(() => {
    const rows: ThreadRow[] = [];
    messages.forEach((m, i) => {
      rows.push({ key: `m${i}`, kind: "message", message: m });
      for (const a of assessments) {
        if (a.afterMessageIndex === i) {
          rows.push({ key: `a${a.id}`, kind: "assessment", entry: a });
        }
      }
    });
    // Defensive: an anchor past the end of the thread still renders.
    for (const a of assessments) {
      if (a.afterMessageIndex >= messages.length) {
        rows.push({ key: `a${a.id}`, kind: "assessment", entry: a });
      }
    }
    return rows;
  }, [messages, assessments]);

  const lastAssessmentId =
    assessments.length > 0 ? assessments[assessments.length - 1].id : null;

  // "Re-run" re-fires the unified brain (SB4 DECISION 2) so the affordance
  // routes through the one brain instead of the retired /api/assess path.
  function onRerunAssessment() {
    void runDiagnoseTurn();
  }

  function updateVehicle<K extends keyof VehicleInfo>(
    field: K,
    value: VehicleInfo[K],
  ) {
    // Push every edit through the context so the global vehicle stays in
    // sync. The context's refreshMetadata is debounced by year/make/model
    // so per-keystroke edits don't fan out to repeated recall/TSB fetches.
    setVehicleManually({ ...vehicle, [field]: value }, vin || null).catch(() => {});
  }

  // DEAD (SB4): the thread no longer fires /api/diagnose directly — the unified
  // brain (runDiagnoseTurn) drives the conversation. Kept until the focused
  // dead-code cleanup pass (with the unused diagnose() client); not called.
  async function callApi(nextMessages: ChatMessage[]): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const result = await diagnose(
        vehicle, nextMessages, recalls, tsbs,
        diagnosticLogger.getCurrentSessionId(),
      );
      const appended: ChatMessage[] = [
        ...nextMessages,
        { role: "assistant", content: JSON.stringify(result.turn) },
      ];
      setMessages(appended);
      messagesRef.current = appended;
      // "Once per completed turn" save grain.
      saveCase({ messages: appended });
      if (result.cost) {
        diagnosticLogger.log({
          type: "diagnose_turn",
          vehicle: vehicle.year
            ? { year: vehicle.year, make: vehicle.make, model: vehicle.model, vin: vin.trim() || null }
            : undefined,
          callType: "diagnose",
          diagnoseTurnKind: result.turn.kind,
          apiCost: result.cost,
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

  // ---- Stage 2C-4 SB4: the UNIFIED diagnostic turn ----
  // ONE call per turn to the unified brain (/api/diagnose-turn) — replaces the
  // old parallel assess + diagnose double-fire. The brain sees the serialized
  // case narrative (buildTurnHistory) + a live snapshot WHEN a vehicle is
  // connected AND the 2B different-vehicle guard passes, then commits to exactly
  // one move: a conversational question, a structured assessment (a DATA_CAPTURE
  // next-step IS "request a live capture" — the existing 2C-4 executor runs it
  // and /api/evidence-update interprets it), or a committed diagnosis. The old
  // auto-assess-on-connect is now BRAIN behavior: a connected start with a
  // live-data complaint makes the brain choose an assessment+capture itself.

  // Render one discriminated turn onto the EXISTING tracks: question / diagnosis
  // append an assistant ChatMessage (AssistantTurn JSON, as today); assessment
  // appends a done AssessmentEntry (a DATA_CAPTURE one arms the existing Start
  // gate). No card / anchored-slot / keyboard changes.
  function dispatchTurn(turn: DiagnoseTurn): void {
    if (turn.kind === "assessment") {
      const id = ++assessmentIdRef.current;
      const afterMessageIndex = Math.max(messagesRef.current.length - 1, 0);
      const entry: AssessmentEntry = {
        id,
        afterMessageIndex,
        slot: { status: "done", assessment: turn.assessment },
        completedAt: new Date().toISOString(),
      };
      const next = [...assessmentsRef.current, entry];
      setAssessments(next);
      assessmentsRef.current = next;
      // Keep the patient chart's last-known differential current: REPLACE the
      // hypotheses, preserve the ruled-out list + diagnostic trail (the capture
      // loop appends a step per round; a direct assessment turn is a
      // reassessment, not a step). buildTurnHistory reconstructs the narrative
      // from assessments[] — this is a chart-completeness write, not brain input.
      const caseState: CaseStateSlot = {
        hypotheses: turn.assessment.hypotheses,
        ruledOut: caseStateRef.current?.ruledOut ?? [],
        stepsTaken: caseStateRef.current?.stepsTaken ?? [],
      };
      caseStateRef.current = caseState;
      saveCase({ assessments: next, caseState });
      return;
    }
    // question | diagnosis → an assistant turn in the message thread (the exact
    // AssistantTurn JSON shape MessageRow / Results already render).
    const assistantTurn: AssistantTurn =
      turn.kind === "question"
        ? { kind: "question", question: turn.question, diagnosis: null }
        : { kind: "diagnosis", question: null, diagnosis: turn.diagnosis };
    const appended: ChatMessage[] = [
      ...messagesRef.current,
      { role: "assistant", content: JSON.stringify(assistantTurn) },
    ];
    setMessages(appended);
    messagesRef.current = appended;
    saveCase({ messages: appended });
  }

  async function runDiagnoseTurn(): Promise<void> {
    setLoading(true);
    setError(null);

    // captureConnectionOk (hoisted) is the 2B-guarded live connection; when it
    // fails (resumed + different / unprovable car) we send connected:false + no
    // snapshot so the brain can never reason over or capture the wrong car's
    // live data — preserving the Stage 2B guarantee.
    // Escalation/diagnose turn carries CODES + VEHICLE ONLY — never the passive
    // OBD2 readings. A key-on-engine-off ring buffer (idle/default values) misled
    // the brain into reasoning over garbage and skipping the live-capture offer.
    // We send an EMPTY-SIGNALS snapshot (empty buffer + empty descriptors →
    // signals:[]) that STILL carries the DTCs + freeze frame. Never snapshot:null
    // — that would drop the codes AND flip the server to "disconnected". The
    // object-present path keeps hasSnapshot/isConnected true; formatSnapshotBlock
    // renders "No live signal data captured" + the codes → the DB-3 "connected +
    // empty → request a capture" branch fires. Live data reaches the brain ONLY
    // via a Claude-requested capture (startCaptureRound), which is independent of
    // this snapshot.
    let snapshot: DiagnosticSnapshot | null = null;
    if (captureConnectionOk) {
      const handoff = getObd2DiagnoseHandoff();
      snapshot = buildDiagnosticSnapshot(
        [],
        [],
        condition,
        handoff.dtcs,
        handoff.pendingDtcs,
        handoff.permanentDtcs,
        handoff.freezeFrame,
      );
    }

    // Serialize the full case narrative the brain reasons on (chat + done
    // assessments + captured evidence), time-ordered + alternating. The client
    // truncates it (first complaint + last N).
    const historyAssessments: HistoryAssessment[] = [];
    for (const a of assessmentsRef.current) {
      if (a.slot.status === "done") {
        historyAssessments.push({
          afterMessageIndex: a.afterMessageIndex,
          completedAt: a.completedAt ?? new Date().toISOString(),
          assessment: a.slot.assessment,
        });
      }
    }
    const historyCaptures: HistoryCapture[] = evidenceLedgerRef.current.map(
      (e) => ({
        afterMessageIndex:
          typeof e.afterMessageIndex === "number"
            ? e.afterMessageIndex
            : Math.max(messagesRef.current.length - 1, 0),
        capturedAt: e.capturedAt,
        entry: e,
      }),
    );
    // Photo lean-history: inject the transient base64 into the LAST user turn
    // carrying an image (the attach turn) so the bytes ride THIS request only.
    // The persisted messages never hold base64; this is a local clone, and
    // buildTurnHistory keeps the image only on the final user turn (else a text
    // placeholder), so the server re-sends bytes exactly once.
    let msgsForHistory = messagesRef.current;
    const outgoingB64 = pendingPhotoBase64Ref.current;
    if (outgoingB64) {
      let injectIdx = -1;
      for (let i = msgsForHistory.length - 1; i >= 0; i--) {
        if (msgsForHistory[i].role === "user" && msgsForHistory[i].image) {
          injectIdx = i;
          break;
        }
      }
      if (injectIdx >= 0) {
        msgsForHistory = msgsForHistory.map((m, i) =>
          i === injectIdx && m.image
            ? { ...m, image: { ...m.image, base64: outgoingB64 } }
            : m,
        );
      }
    }
    const history = buildTurnHistory(
      msgsForHistory,
      historyAssessments,
      historyCaptures,
    );

    try {
      const result = await diagnoseTurn({
        vehicle,
        vin: vin.trim() || null,
        mileage: vehicle.mileage,
        complaint: symptom.trim(),
        messages: history,
        snapshot,
        connected: captureConnectionOk,
        recalls,
        tsbs,
        sessionId: diagnosticLogger.getCurrentSessionId(),
        caseId: caseMetaRef.current?.id ?? null,
      });
      dispatchTurn(result.turn);
      if (result.cost) {
        diagnosticLogger.log({
          type: "diagnose_turn",
          vehicle: vehicle.year
            ? { year: vehicle.year, make: vehicle.make, model: vehicle.model, vin: vin.trim() || null }
            : undefined,
          callType: "diagnose-turn",
          diagnoseTurnKind: result.turn.kind,
          apiCost: result.cost,
        });
      }
    } catch (err) {
      // Graceful degradation: the turn failed, but the conversation survives —
      // surface the error and let the tech retry with another message.
      const msg =
        err instanceof DiagnoseTurnError
          ? err.message
          : err instanceof Error
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
    // Create a fresh case (cap-enforced). This is a NEW session even if the VIN
    // matches an existing case — cases key on their own id. resumedCaseRef stays
    // null so the guard runs in fresh mode (2A behavior).
    resumedCaseRef.current = null;
    setUnsaved(false);
    const proceed = await ensureCaseForNewSession();
    if (!proceed) return; // tech cancelled at the all-25-open prompt → stay on intake
    // Merge-plan Phase 2 (metering): the ESCALATION EVENT — intake submit is
    // where a diagnosis starts (all three doors funnel here: direct, Ask→,
    // OBD2→), so this is where the flat diagnosis credit mints. Fire-and-
    // forget + fail-soft (never blocks the turn); idempotent server-side by
    // caseId (null only for a deliberate unsaved-at-cap session).
    recordDiagnosisStart({
      caseId: caseMetaRef.current?.id ?? null,
      sessionId: diagnosticLogger.getCurrentSessionId(),
      vehicle: { year: vehicle.year, make: vehicle.make, model: vehicle.model },
      source: entrySourceRef.current,
    });
    // Photo-on-intake: attach the staged photo to the FIRST turn (persisted image
    // WITHOUT base64) and prime the transient ref so runDiagnoseTurn's existing
    // injection (:~1379) sends the bytes exactly once. Consume the staged photo.
    const photo = intakePhoto;
    setIntakePhoto(null);
    const first: ChatMessage = photo
      ? { role: "user", content: symptom.trim(), image: withoutBase64(photo) }
      : { role: "user", content: symptom.trim() };
    pendingPhotoBase64Ref.current = photo?.base64 ?? null;
    // Merge-plan Phase 1: an Ask→Diagnose escalation seeds the carried Ask
    // thread BEFORE the complaint — the case envelope + buildTurnHistory then
    // hold the whole conversation (plain-text assistant turns serialize as-is
    // and render via MessageRow's non-JSON branch). Consume-once. The carried
    // thread starts on a user turn (trimmed at stash), so messages[0] stays a
    // user turn and the terminal-user guarantee is untouched.
    const carried = carriedThreadRef.current ?? [];
    carriedThreadRef.current = null;
    // Phase-1 follow-up (carried-photo visibility): the diagnostic brain never
    // saw an Ask-thread photo — bytes are transient, the carried image is
    // uri-metadata only, so history serializes a DANGLING "[photo attached]"
    // placeholder (the lean rule's carry-forward assumes the SAME brain saw the
    // image once). Fix: make the COMPLAINT turn the attach turn for the MOST
    // RECENT carried photo — re-read the bytes from the durable uri and prime
    // the existing injection, so the proven photo-on-intake path sends the
    // vision block exactly once on the first diagnostic turn; later turns
    // revert to placeholders (lean rule intact; base64 never persisted). A
    // staged intake photo WINS (fresher, deliberate) — the carried photo then
    // stays a placeholder. Earlier carried photos stay placeholders. A read
    // failure (purged/reinstalled file) skips cleanly to today's behavior.
    if (!photo) {
      const lastCarriedPhoto = [...carried]
        .reverse()
        .find((m) => m.role === "user" && m.image);
      if (lastCarriedPhoto?.image) {
        const b64 = await readPhotoBase64(lastCarriedPhoto.image.uri);
        if (b64) {
          first.image = { ...lastCarriedPhoto.image };
          // Same-photo labeling (on-device finding): without this note the
          // thread's shape reads as a photo SEQUENCE (a mid-history
          // "[photo attached]" placeholder + an image on the complaint), and
          // the brain narrated a comparison to a "previous" photo it never
          // saw. The note lives in the PERSISTED content deliberately — on
          // later turns this image also degrades to a placeholder, so history
          // shows two markers for one photo; a persistent caption keeps both
          // self-explaining (incl. after resume). Text-only; pipeline intact.
          first.content = `${first.content}\n\n(Photo re-attached from earlier in this conversation — same photo, not a new one.)`;
          pendingPhotoBase64Ref.current = b64;
        }
      }
    }
    const seeded = [...carried, first];
    setMessages(seeded);
    messagesRef.current = seeded;
    setPhase("chat");
    saveCase({ messages: seeded });
    // SB4: ONE unified call decides the opening move. A connected start with a
    // live-data complaint makes the brain choose an assessment+capture itself —
    // the old auto-assess-on-connect, now brain behavior. No double-fire.
    await runDiagnoseTurn();
  }

  function newCaseMeta() {
    const now = new Date().toISOString();
    return {
      id: makeCaseId(),
      createdAt: now,
      status: "open" as CaseStatus,
      closeReason: null,
      closedAt: null,
      linkedRecordIds: [] as string[],
      loggerSessionIds: [] as string[],
    };
  }

  // Cap + all-25-open consent. Sets caseMetaRef (saved session) or leaves it
  // null + flags unsaved. Returns false ONLY if the tech cancelled the submit.
  // pruneForNewCase already deleted the oldest CLOSED case when one existed;
  // `blocked` means all 25 are open, which needs explicit consent.
  async function ensureCaseForNewSession(): Promise<boolean> {
    const decision = await pruneForNewCase();
    if (!decision.blocked) {
      caseMetaRef.current = newCaseMeta();
      return true;
    }
    const oldest = [...decision.openEntries].sort((a, b) =>
      a.updatedAt.localeCompare(b.updatedAt),
    )[0];
    const choice = await promptAllOpenConsent(oldest);
    if (choice === "cancel") return false;
    if (choice === "unsaved") {
      caseMetaRef.current = null;
      setUnsaved(true);
      return true;
    }
    // delete_oldest — the ONLY way to free a cap slot when all 25 are open
    // (closing keeps the case stored, so it wouldn't make room). Explicit,
    // labeled deletion with consent.
    if (oldest) await deleteCase(oldest.id);
    caseMetaRef.current = newCaseMeta();
    refreshCases();
    return true;
  }

  // Three-way consent for the all-25-open edge. Honest labels: the make-room
  // action DELETES the oldest open case (closing can't free a slot).
  function promptAllOpenConsent(
    oldest: CaseIndexEntry | undefined,
  ): Promise<"delete_oldest" | "unsaved" | "cancel"> {
    const label = oldest?.vehicleLabel ?? "the oldest open case";
    return new Promise((resolve) => {
      Alert.alert(
        "Case limit reached (25 open)",
        `All 25 case slots are open. To SAVE this new case, the oldest open case must be deleted:\n\n${label}\n\nOr continue without saving this session.`,
        [
          { text: "Cancel", style: "cancel", onPress: () => resolve("cancel") },
          {
            text: "Continue without saving",
            onPress: () => resolve("unsaved"),
          },
          {
            text: "Delete oldest & save",
            style: "destructive",
            onPress: () => resolve("delete_oldest"),
          },
        ],
        { cancelable: true, onDismiss: () => resolve("cancel") },
      );
    });
  }

  // ---- Saved-cases list actions ----

  function onCloseCaseFromList(entry: CaseIndexEntry) {
    closeCase(entry.id, "closed_by_user")
      .then(refreshCases)
      .catch((err) => console.warn("[cases] close failed:", err));
  }

  function onDeleteCaseFromList(entry: CaseIndexEntry) {
    Alert.alert(
      "Delete case?",
      `Permanently delete this case?\n\n${entry.vehicleLabel}\n${entry.complaintPreview}`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            deleteCase(entry.id)
              .then(refreshCases)
              .catch((err) => console.warn("[cases] delete failed:", err));
          },
        },
      ],
    );
  }

  // Offer camera vs library, then pick → resize → durable-persist. Returns an
  // ImageAttachment (durable uri + transient base64) or null (cancel/denied/fail
  // — all fail-soft). Mode-agnostic primitive in lib/photoEvidence.ts.
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

  // Intake "Add a photo": stage a photo that rides into the first diagnose turn.
  async function onIntakeAttach() {
    const photo = await attachPhoto();
    if (photo) setIntakePhoto(photo);
  }

  // A user turn = trimmed text and/or a photo. The persisted message carries the
  // image WITHOUT base64 (bytes are transient); the base64 is held in the ref
  // and injected into the ONE outgoing request by runDiagnoseTurn (the attach
  // turn). A subsequent text turn supersedes it (ref cleared to null).
  async function sendUserMessage(text: string, image?: ImageAttachment | null) {
    const trimmed = text.trim();
    if (!trimmed && !image) return;
    const content = trimmed || (image ? "Photo attached" : "");
    const stored: ChatMessage = image
      ? { role: "user", content, image: withoutBase64(image) }
      : { role: "user", content };
    const next: ChatMessage[] = [...messages, stored];
    setMessages(next);
    messagesRef.current = next;
    setAnswer("");
    pendingPhotoBase64Ref.current = image?.base64 ?? null;
    // Save the user turn before the API call so a failure/crash after this
    // point doesn't lose the technician's input.
    saveCase({ messages: next });
    await runDiagnoseTurn();
  }

  async function onSubmitAnswer() {
    const photo = pendingPhoto;
    setPendingPhoto(null);
    await sendUserMessage(answer, photo);
  }

  // Composer "attach" button (general / anytime entry point): stage a photo so
  // Send ships text + photo as one turn.
  async function onComposerAttach() {
    const photo = await attachPhoto();
    if (photo) setPendingPhoto(photo);
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

  // Returns the generated record id so the caller can link it to the case.
  async function persistRecord(
    outcome: RecordOutcome,
    diagnosis: FinalDiagnosis,
    snapshot: ChatMessage[],
  ): Promise<string> {
    const recordId = makeRecordId();
    const record: DiagnosticRecord = {
      type: "diagnosis",
      id: recordId,
      date: new Date().toISOString(),
      vehicle,
      vin: vin.trim() || undefined,
      symptom: symptom.trim() || snapshot[0]?.content || "",
      // Strip photos from the confirmed-fix record: local URIs are install-scoped
      // and meaningless once a device is wiped. Keep the text trail + outcome.
      conversation: snapshot.map((m) =>
        m.image ? { role: m.role, content: m.content } : m,
      ),
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
    return recordId;
  }

  async function onConfirmDiagnosis() {
    if (latestTurn?.kind !== "diagnosis") return;
    const recordId = await persistRecord(
      "confirmed",
      latestTurn.diagnosis,
      messages,
    );
    // Confirm Fix = the DiagnosticRecords tie-in: close the case and link the
    // record. closeCase enqueues after the diagnosis-turn save (same write
    // queue), so it closes the full-thread body. Keep meta in sync for any
    // later save.
    const meta = caseMetaRef.current;
    if (meta) {
      meta.status = "closed";
      meta.closeReason = "fix_confirmed";
      meta.closedAt = new Date().toISOString();
      meta.linkedRecordIds = [...meta.linkedRecordIds, recordId];
      await closeCase(meta.id, "fix_confirmed", recordId);
    }
    setConfirmedDone(true);
  }

  async function onRejectDiagnosis() {
    if (latestTurn?.kind !== "diagnosis") return;
    const recordId = await persistRecord(
      "incorrect",
      latestTurn.diagnosis,
      messages,
    );
    // Reject = link the record but keep the case OPEN (still diagnosing); the
    // rejection turn below then lands via the normal callApi save.
    const meta = caseMetaRef.current;
    if (meta) {
      meta.linkedRecordIds = [...meta.linkedRecordIds, recordId];
      await linkRecord(meta.id, recordId);
    }
    const rejection =
      "That diagnosis was not correct — the indicated fix did not resolve the issue. Continue investigating: ask any additional clarifying questions you need, then commit to a different diagnosis.";
    await sendUserMessage(rejection);
  }

  function resetSession() {
    setPhase("intake");
    setMessages([]);
    messagesRef.current = [];
    setAssessments([]);
    assessmentsRef.current = [];
    setAnswer("");
    setSymptom("");
    setError(null);
    setConfirmedDone(false);
    setUnsaved(false);
    setPendingPhoto(null);
    setIntakePhoto(null);
    pendingPhotoBase64Ref.current = null;
    carriedThreadRef.current = null; // a fresh intake never inherits a carried thread
    entrySourceRef.current = "direct"; // and re-enters through the direct door
    // Stage 2B: the previous case was already saved at its last completed turn
    // and stays OPEN + resumable from the list — reset does NOT touch its stored
    // body or status. Clearing these refs makes the next intake a genuinely
    // fresh case (new id at submit) and drops the resume guard. The
    // connection-aware vehicle handling below is unchanged from 2A.
    caseMetaRef.current = null;
    resumedCaseRef.current = null;
    // SB1: re-arm the connected-VIN auto-import so "New Diagnosis" re-derives the
    // field from adapter ground truth (connected → connected VIN; the
    // disconnected branch below clears it).
    autoVinAppliedRef.current = null;
    // Stage 2C-4: stop any live capture round and drop the evidence-loop refs —
    // the next intake is a fresh case.
    captureExecutorRef.current?.stop();
    captureExecutorRef.current = null;
    roundActiveRef.current = null;
    evidenceLedgerRef.current = [];
    caseStateRef.current = null;
    // Only clear the vehicle when no adapter is connected. With a live
    // connection the vehicle came from the OBD2 auto-VIN flow — wiping it
    // would desync the global context from the physically-connected vehicle.
    if (!isConnected) {
      setVin("");
      setDecoded(false);
      setDecodeError(null);
      setManualOpen(false);
      clearVehicle().catch(() => {});
      lastDecodedRef.current = "";
    }
  }

  if (phase === "intake") {
    return (
      <Background>
        <SafeAreaView style={styles.safeTransparent} edges={["top", "left", "right"]}>
        <Navbar transparent showBack />
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          keyboardVerticalOffset={0}
        >
          <ScrollView
            contentContainerStyle={[
              styles.intakeContent,
              Platform.OS === "android" && androidKbHeight > 0
                ? { paddingBottom: androidKbHeight + 16 }
                : null,
            ]}
            keyboardShouldPersistTaps="handled"
            // iOS: scroll the focused field above the keyboard. Complementary to
            // the KAV (which lifts the viewport above the keyboard, so the added
            // inset is ~0 — no double-count) + adds scroll-to-focused.
            automaticallyAdjustKeyboardInsets
          >
            <Text style={styles.h1}>Diagnose</Text>
            <Text style={styles.subtitle}>
              Scan the VIN on the driver&apos;s door jamb, connect an OBD2
              adapter to read it automatically, or enter it manually.
            </Text>

            {cases.length > 0 && (
              <View style={styles.casesSection}>
                {/* Collapsed glass disclosure bar (closed by default so the form
                    is immediately visible). All saved-case behavior — open,
                    close/delete, view-all, vehicle filter — is preserved; only
                    the presentation moved behind this bar. */}
                <GlassCard
                  onPress={() => setCasesOpen((o) => !o)}
                  accessibilityLabel={
                    casesOpen ? "Hide saved cases" : "Show saved cases"
                  }
                >
                  <View style={styles.casesBar}>
                    <Ionicons
                      name="folder-open-outline"
                      size={18}
                      color={colors.steelGlyph}
                    />
                    <Text style={styles.casesBarLabel}>
                      {caseFilterVin ? "Cases for this vehicle" : "Saved cases"}
                    </Text>
                    <View style={styles.casesCountChip}>
                      <Text style={styles.casesCountText}>
                        {displayedCases.length}
                      </Text>
                    </View>
                    <View style={styles.flex} />
                    <Ionicons
                      name={casesOpen ? "chevron-up" : "chevron-down"}
                      size={18}
                      color={colors.faint}
                    />
                  </View>
                </GlassCard>

                {casesOpen && (
                  <View style={styles.casesExpanded}>
                    {caseFilterVin && (
                      <TouchableOpacity
                        style={styles.casesToggle}
                        onPress={() => setCaseFilterVin(null)}
                        activeOpacity={0.7}
                        accessibilityLabel="Show all cases"
                      >
                        <Text style={styles.casesClearFilter}>
                          Show all cases
                        </Text>
                      </TouchableOpacity>
                    )}
                    {(showAllCases
                      ? displayedCases
                      : displayedCases.slice(0, 3)
                    ).map((c) => (
                      <CaseRow
                        key={c.id}
                        entry={c}
                        onOpen={() => attemptResume(c.id)}
                        onCloseCase={() => onCloseCaseFromList(c)}
                        onDeleteCase={() => onDeleteCaseFromList(c)}
                      />
                    ))}
                    {displayedCases.length === 0 && (
                      <Text style={styles.casesEmpty}>
                        No saved cases for this vehicle.
                      </Text>
                    )}
                    {!caseFilterVin && displayedCases.length > 3 && (
                      <TouchableOpacity
                        style={styles.casesToggle}
                        onPress={() => setShowAllCases((s) => !s)}
                        activeOpacity={0.7}
                        accessibilityLabel={
                          showAllCases ? "Show fewer cases" : "View all cases"
                        }
                      >
                        <Text style={styles.disclosureText}>
                          {showAllCases
                            ? "Show fewer"
                            : `View all (${displayedCases.length})`}
                        </Text>
                      </TouchableOpacity>
                    )}
                  </View>
                )}
              </View>
            )}

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
                  <Ionicons name="camera-outline" size={16} color={colors.bg} />
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
                  <VehiclePickerRow
                    year={vehicle.year}
                    make={vehicle.make}
                    model={vehicle.model}
                    onYear={(v) => updateVehicle("year", v)}
                    onMake={(v) => updateVehicle("make", v)}
                    onModel={(v) => updateVehicle("model", v)}
                  />
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

              {isConnected && (
                <View style={styles.singleField}>
                  <Text style={styles.label}>LIVE OBD2 DATA</Text>
                  <View style={styles.warmConnectedRow}>
                    <View style={styles.warmDot} />
                    <Text style={styles.warmConnectedText}>
                      Adapter connected — live data will be included
                    </Text>
                  </View>
                  <View style={styles.dataStatusRow}>
                    <DataBadge
                      label={`${assessDescriptors.length} live signal${assessDescriptors.length === 1 ? "" : "s"}`}
                      active={assessDescriptors.length > 0}
                      icon="pulse"
                    />
                    <DataBadge
                      label={`${assessDtcCount} DTC${assessDtcCount === 1 ? "" : "s"}`}
                      active={assessDtcCount > 0}
                      icon="alert-circle"
                    />
                  </View>
                  <Text style={styles.autoAssessNote}>
                    {canAutoAssess
                      ? "A structured assessment of this data will run automatically when you start the diagnosis."
                      : "No live signals or codes yet — select PIDs or run a code scan on the OBD2 screen to include an automatic assessment."}
                  </Text>
                </View>
              )}

              {/* SB2-D: when no adapter is connected, offer to connect one
                  (routes to the OBD2 picker — no duplicate picker here) so live
                  monitoring is reachable without hunting for the OBD2 screen. */}
              {!isConnected && (
                <View style={styles.singleField}>
                  <Text style={styles.label}>LIVE OBD2 DATA</Text>
                  {obd2Status === "connecting" || obd2Status === "handshaking" ? (
                    <Text style={styles.autoAssessNote}>
                      Connecting to your OBD2 adapter…
                    </Text>
                  ) : (
                    <>
                      <Text style={styles.autoAssessNote}>
                        No adapter connected. Connect one to add a live-data
                        assessment and monitoring to this diagnosis.
                      </Text>
                      <TouchableOpacity
                        style={styles.connectAdapterBtn}
                        onPress={() => router.push("/connect")}
                        activeOpacity={0.85}
                        accessibilityRole="button"
                        accessibilityLabel="Connect an OBD2 adapter"
                      >
                        <Ionicons
                          name="bluetooth-outline"
                          size={16}
                          color={colors.accent}
                        />
                        <Text style={styles.connectAdapterBtnText}>
                          Connect an OBD2 adapter
                        </Text>
                      </TouchableOpacity>
                    </>
                  )}
                </View>
              )}

              {canAutoAssess && (
                <View style={styles.singleField}>
                  <Text style={styles.label}>OPERATING CONDITION</Text>
                  <Text style={styles.conditionHelp}>
                    What is the vehicle doing RIGHT NOW? The data snapshot is
                    captured the moment you start.
                  </Text>
                  <ConditionSelector value={condition} onChange={setCondition} />
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
                {/* Photo-on-intake (optional): a staged photo rides into the
                    first diagnose turn. Reuses the shipped photo pipeline. */}
                {intakePhoto ? (
                  <View style={styles.intakePhotoRow}>
                    <PhotoThumb image={intakePhoto} />
                    <TouchableOpacity
                      style={styles.intakePhotoRemove}
                      onPress={() => setIntakePhoto(null)}
                      activeOpacity={0.7}
                      accessibilityLabel="Remove photo"
                      hitSlop={8}
                    >
                      <Ionicons name="close-circle" size={18} color={colors.muted} />
                      <Text style={styles.intakePhotoRemoveText}>Remove</Text>
                    </TouchableOpacity>
                  </View>
                ) : (
                  <TouchableOpacity
                    style={styles.intakeAttachBtn}
                    onPress={onIntakeAttach}
                    disabled={attaching}
                    activeOpacity={0.7}
                    accessibilityLabel="Add a photo"
                  >
                    <Ionicons
                      name="camera-outline"
                      size={18}
                      color={attaching ? colors.muted : colors.accent}
                    />
                    <Text style={styles.intakeAttachText}>
                      {attaching ? "Opening…" : "Add a photo (optional)"}
                    </Text>
                  </TouchableOpacity>
                )}
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
                  {loading ? "Starting…" : "Start Diagnosis"}
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
      </Background>
    );
  }

  return (
    <Background>
    <SafeAreaView style={styles.safeTransparent} edges={["top", "left", "right"]}>
      <View
        onLayout={(e) => setHeaderHeight(e.nativeEvent.layout.height)}
      >
        <Navbar transparent showBack />
        <VehicleBar vehicle={vehicle} onReset={resetSession} />
        <View style={styles.diagramBarRow}>
          <Pressable
            style={styles.findDiagramBtn}
            onPress={() => setDiagramModalOpen(true)}
            accessibilityRole="button"
          >
            <Text style={styles.findDiagramText}>🗺  Find a diagram</Text>
          </Pressable>
        </View>
      </View>

      <FindDiagramModal
        visible={diagramModalOpen}
        vehicle={vehicle}
        onClose={() => setDiagramModalOpen(false)}
      />

      <KeyboardAvoidingView
        style={[
          styles.flex,
          Platform.OS === "android" && { paddingBottom: androidKbHeight },
        ]}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        // The header is a sibling ABOVE this KAV, so the KAV frame already
        // begins below it — RN's padding = keyboardHeight + offset, so any
        // non-zero offset OVER-lifts the composer (the "dead gap above the
        // keyboard" bug). Offset must be 0 (matches the working intake KAV).
        keyboardVerticalOffset={0}
      >
        <FlatList
          ref={listRef}
          style={styles.thread}
          contentContainerStyle={styles.threadContent}
          data={threadRows}
          keyExtractor={(item) => item.key}
          ListHeaderComponent={
            unsaved || resumeBlockBanner ? (
              <View style={styles.bannerStack}>
                {unsaved && (
                  <View style={styles.resumeBanner}>
                    <Text style={styles.resumeBannerText}>
                      This session isn&apos;t being saved — the 25-case limit
                      was reached, so it won&apos;t appear in Saved Cases.
                    </Text>
                  </View>
                )}
                {resumeBlockBanner && (
                  <View style={styles.resumeBanner}>
                    <Text style={styles.resumeBannerText}>
                      {resumeBlockBanner}
                    </Text>
                  </View>
                )}
              </View>
            ) : null
          }
          renderItem={({ item }) =>
            item.kind === "message" ? (
              <MessageRow message={item.message} />
            ) : (
              <AssessmentThreadCard
                entry={item.entry}
                onRerun={
                  captureConnectionOk &&
                  item.entry.id === lastAssessmentId &&
                  item.entry.slot.status !== "running" &&
                  !anyCaptureActive(item.entry)
                    ? onRerunAssessment
                    : undefined
                }
                onStartCapture={
                  // No captureConnectionOk gate — the affordance always renders
                  // on the latest not-yet-acted DATA_CAPTURE card; the handler
                  // branches (connect / wrong-vehicle / run). captureGate sets
                  // the label.
                  item.entry.id === lastAssessmentId &&
                  item.entry.slot.status === "done" &&
                  item.entry.slot.assessment.next_step.type === "DATA_CAPTURE" &&
                  !hasAnyCapture(item.entry)
                    ? () => handleStartCapturePress(item.entry)
                    : undefined
                }
                captureGate={captureGate}
                onCancelCapture={
                  anyCaptureActive(item.entry) ? cancelCaptureRound : undefined
                }
                onSubmitFinding={
                  item.entry.id === lastAssessmentId &&
                  item.entry.slot.status === "done" &&
                  item.entry.slot.assessment.next_step.type ===
                    "PHYSICAL_INSPECTION" &&
                  hasFindingOptions(item.entry.slot.assessment.next_step) &&
                  // not yet answered: no user turn appended after this card's
                  // anchor (a tapped finding appends one, which hides the card —
                  // including during the in-flight turn and on resume).
                  item.entry.afterMessageIndex >= messages.length - 1
                    ? sendUserMessage
                    : undefined
                }
                onPickPhoto={attachPhoto}
                onPullCodes={
                  item.entry.id === lastAssessmentId &&
                  item.entry.slot.status === "done" &&
                  item.entry.slot.assessment.next_step.type === "PULL_CODES" &&
                  // not yet answered (same anchor test as onSubmitFinding): the
                  // injected code-pull result appends a user turn, hiding the card.
                  item.entry.afterMessageIndex >= messages.length - 1
                    ? () => pullCodes(item.entry)
                    : undefined
                }
                pullingCodes={pullingEntryId === item.entry.id}
              />
            )
          }
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
                <View style={styles.answerRow}>
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
                      (loading ||
                        (answer.trim().length === 0 && !pendingPhoto)) &&
                        styles.submitDisabled,
                    ]}
                    onPress={onSubmitAnswer}
                    disabled={
                      loading || (answer.trim().length === 0 && !pendingPhoto)
                    }
                    activeOpacity={0.85}
                    accessibilityLabel="Send"
                  >
                    <Text style={styles.sendBtnText}>Send</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </>
          )}
        </SafeAreaView>
      </KeyboardAvoidingView>
    </SafeAreaView>
    </Background>
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

// Relative-time formatter for saved-case rows. Coarse buckets — exact
// timestamps add no value to a "when did I last touch this" list.
function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return `${Math.floor(d / 30)}mo ago`;
}

// One saved-case row. Tapping the body resumes (open) / views (closed) via the
// block-checked attemptResume; the trailing action is Close (open) or Delete
// (closed). Renders from the lightweight index entry — no case body is loaded
// until the row is actually opened.
function CaseRow({
  entry,
  onOpen,
  onCloseCase,
  onDeleteCase,
}: {
  entry: CaseIndexEntry;
  onOpen: () => void;
  onCloseCase: () => void;
  onDeleteCase: () => void;
}) {
  const isOpen = entry.status === "open";
  // Three chip states: OPEN (in progress), FIXED (confirmed-fix close — also the
  // confirmed-fix DB feed, so it stands out), CLOSED (user-closed / other).
  const chip = isOpen
    ? { label: "OPEN", box: styles.caseChipOpen, text: styles.caseChipTextOpen }
    : entry.closeReason === "fix_confirmed"
      ? {
          label: "FIXED",
          box: styles.caseChipFixed,
          text: styles.caseChipTextFixed,
        }
      : {
          label: "CLOSED",
          box: styles.caseChipClosed,
          text: styles.caseChipTextClosed,
        };
  return (
    <View style={styles.caseRow}>
      <TouchableOpacity
        style={styles.caseRowMain}
        onPress={onOpen}
        activeOpacity={0.7}
        accessibilityLabel={`${isOpen ? "Resume" : "View"} case: ${entry.vehicleLabel}`}
      >
        <View style={styles.caseRowHeader}>
          <Text style={styles.caseVehicle} numberOfLines={1}>
            {entry.vehicleLabel}
          </Text>
          <View style={[styles.caseChip, chip.box]}>
            <Text style={[styles.caseChipText, chip.text]}>{chip.label}</Text>
          </View>
        </View>
        {entry.complaintPreview ? (
          <Text style={styles.caseComplaint} numberOfLines={1}>
            {entry.complaintPreview}
          </Text>
        ) : null}
        <Text style={styles.caseMeta}>{formatRelative(entry.updatedAt)}</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={styles.caseAction}
        onPress={isOpen ? onCloseCase : onDeleteCase}
        activeOpacity={0.7}
        accessibilityLabel={isOpen ? "Close case" : "Delete case"}
      >
        <Text style={styles.caseActionText}>{isOpen ? "Close" : "Delete"}</Text>
      </TouchableOpacity>
    </View>
  );
}

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

// A structured assessment rendered as a thread item. The running state
// occupies the slot from the moment the assessment fires, so the card
// resolving later never shifts the layout of turns rendered below it.
function AssessmentThreadCard({
  entry,
  onRerun,
  onStartCapture,
  onCancelCapture,
  onSubmitFinding,
  onPickPhoto,
  onPullCodes,
  pullingCodes,
  captureGate,
}: {
  entry: AssessmentEntry;
  onRerun?: () => void;
  // Stage 2C-4: present (from the parent) only when this card is the latest
  // done DATA_CAPTURE assessment, live-assessment is allowed, and no round has
  // started on it yet. MINIMAL — SUB-BATCH 2 replaces this with the hands-off
  // per-round driving UX.
  onStartCapture?: () => void;
  onCancelCapture?: () => void;
  // Stage 3 (Step 1): present (from the parent) only when this card is the
  // latest done PHYSICAL_INSPECTION with well-formed finding_options that has
  // not been answered yet. Composes the tapped finding into a user turn. NO
  // connection required — the whole point of the guided physical lane.
  onSubmitFinding?: (resultText: string, image?: ImageAttachment | null) => void;
  // Photo Evidence (Step 1): the shared picker so a finding + photo is ONE turn.
  onPickPhoto?: () => Promise<ImageAttachment | null>;
  // PULL_CODES (Item B): present (from the parent) only when this is the latest
  // done PULL_CODES assessment not yet answered. Re-reads the vehicle's codes and
  // injects them as a user turn (or routes to /connect when disconnected). NO
  // connection gate here — the handler branches. pullingCodes = read in flight.
  onPullCodes?: () => void;
  pullingCodes?: boolean;
  // Why the capture can't run (drives the affordance label). Only meaningful when
  // onStartCapture is present. "ready" = run; "disconnected" = route to /connect;
  // "wrong_vehicle" = surface the resume-block messaging (adapter already on).
  captureGate?: "ready" | "disconnected" | "wrong_vehicle";
}) {
  // One capture card per plan item (sorted by item index), so concurrent items
  // render distinctly instead of overwriting one slot.
  const captureSlots = Object.entries(entry.captures ?? {})
    .map(([k, v]) => ({ itemIndex: Number(k), state: v }))
    .sort((a, b) => a.itemIndex - b.itemIndex);
  // A photo staged against this finding card; sent with the next outcome tap.
  const [stagedFindingPhoto, setStagedFindingPhoto] =
    useState<ImageAttachment | null>(null);
  async function handleFindingAttach() {
    if (!onPickPhoto) return;
    const p = await onPickPhoto();
    if (p) setStagedFindingPhoto(p);
  }
  const isDataCapture =
    entry.slot.status === "done" &&
    entry.slot.assessment.next_step.type === "DATA_CAPTURE";
  // The finding-outcome card data (bounded inspection + well-formed options),
  // derived once. null unless this is a done PHYSICAL_INSPECTION with options.
  const finding =
    entry.slot.status === "done"
      ? (() => {
          const outcomes = readFindingOptions(entry.slot.assessment.next_step);
          return outcomes
            ? { outcomes, action: entry.slot.assessment.next_step.action }
            : null;
        })()
      : null;

  return (
    <View style={styles.assessmentWrap}>
      <Text style={styles.assistantLabel}>STRUCTURED ASSESSMENT</Text>
      {entry.slot.status === "running" && (
        <View style={[styles.bubble, styles.bubbleAssistant]}>
          <View style={styles.loadingRow}>
            <ActivityIndicator size="small" color={colors.accent} />
            <Text style={styles.loadingText}>
              Analyzing live vehicle data… this may take 15–30 seconds.
            </Text>
          </View>
        </View>
      )}
      {entry.slot.status === "done" && (
        <NextStepBlock assessment={entry.slot.assessment} />
      )}
      {entry.slot.status === "error" && (
        <View style={[styles.errorBox, styles.assessmentErrorBox]}>
          <Text style={styles.errorText}>
            Assessment failed: {entry.slot.message} The conversation below
            continues without it.
          </Text>
        </View>
      )}

      {/* Stage 2C-4 capture round — driven by the real detector via the
          executor's onCard. One card PER plan item (keyed by item index), so a
          multi-item plan no longer overwrites a single slot / "flips" mid-wait.
          Lives under the DATA_CAPTURE assessment that ordered it. */}
      {captureSlots.map(({ itemIndex, state: cap }) =>
        cap.phase === "waiting" || cap.phase === "capturing" || cap.phase === "complete" ? (
          <CaptureCard
            key={`cap-${itemIndex}`}
            state={cap.phase}
            conditionLabel={cap.conditionLabel}
            signalIds={cap.signalIds}
            recordedSignalIds={cap.recordedSignalIds}
            conditions={cap.conditions}
            durationSeconds={cap.durationSeconds}
            progress={cap.progress}
            onCancel={
              cap.phase !== "complete" && onCancelCapture ? onCancelCapture : undefined
            }
          />
        ) : (
          <View key={`cap-${itemIndex}`} style={[styles.captureNoteBox]}>
            <Text style={styles.captureNoteText}>
              {cap.note ?? "Monitoring stopped."}
            </Text>
          </View>
        ),
      )}

      {/* Stage 3 (Step 1) guided result-capture — a directed physical
          inspection with brain-authored bounded outcomes. The parent gates this
          to latest-card-only + not-yet-answered + NO connection required; here
          we just render when well-formed options exist. */}
      {finding && onSubmitFinding && (
        <FindingCard
          action={finding.action}
          outcomes={finding.outcomes}
          onOutcome={(o) =>
            onSubmitFinding(
              formatInspectionResult({ outcome: o }),
              stagedFindingPhoto,
            )
          }
          onCouldntCheck={() =>
            onSubmitFinding(
              formatInspectionResult({ couldntCheck: true }),
              stagedFindingPhoto,
            )
          }
          onFreeText={(t) =>
            onSubmitFinding(formatInspectionResult({ note: t }), stagedFindingPhoto)
          }
          onAttachPhoto={onPickPhoto ? handleFindingAttach : undefined}
          photoStaged={!!stagedFindingPhoto}
        />
      )}

      {/* PULL_CODES (Item B) — the brain asked for a fresh code re-read. Card
          stays interactive whether or not connected; the handler runs scanDtcs()
          on a live connection or routes to /connect when disconnected. */}
      {onPullCodes && (
        <TouchableOpacity
          style={styles.startCaptureBtn}
          onPress={onPullCodes}
          disabled={pullingCodes}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel="Re-scan trouble codes"
        >
          {pullingCodes ? (
            <View style={styles.loadingRow}>
              <ActivityIndicator size="small" color={colors.accent} />
              <Text style={styles.startCaptureBtnText}>Re-scanning codes…</Text>
            </View>
          ) : (
            <Text style={styles.startCaptureBtnText}>↻ Re-scan codes</Text>
          )}
        </TouchableOpacity>
      )}

      {/* Start / connect affordance. Always renders on the latest not-yet-acted
          DATA_CAPTURE card; the label reflects WHY it can't run yet so the tech
          is never left a dangling instruction (SUB-BATCH 2 reworks the run UX). */}
      {isDataCapture && onStartCapture && captureSlots.length === 0 && (
        <TouchableOpacity
          style={styles.startCaptureBtn}
          onPress={onStartCapture}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel={
            captureGate === "disconnected"
              ? "Connect an OBD2 adapter to capture this data"
              : captureGate === "wrong_vehicle"
                ? "Live capture unavailable — a different vehicle is connected"
                : "Start monitoring for the requested data"
          }
        >
          <Text style={styles.startCaptureBtnText}>
            {captureGate === "disconnected"
              ? "⚲ Connect a device to capture"
              : captureGate === "wrong_vehicle"
                ? "⚠ Different vehicle — can't capture"
                : "◉ Start monitoring"}
          </Text>
        </TouchableOpacity>
      )}

      {onRerun && (
        <TouchableOpacity
          style={styles.rerunLink}
          onPress={onRerun}
          activeOpacity={0.6}
          accessibilityRole="button"
          accessibilityLabel="Re-run assessment"
        >
          <Text style={styles.rerunLinkText}>Re-run assessment ↻</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  // Intake: transparent so the v2 atmosphere (Background) shows through.
  safeTransparent: {
    flex: 1,
    backgroundColor: "transparent",
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
    fontFamily: fonts.sansSemibold,
    color: colors.heading,
    marginBottom: 6,
    letterSpacing: -0.3,
  },
  subtitle: {
    color: colors.muted,
    fontSize: 14,
    fontFamily: fonts.sans,
    marginBottom: 24,
    lineHeight: 21,
  },
  // v2: the form is a stack of individual glass fields on the atmosphere — the
  // old single opaque card wrapper is now a transparent passthrough.
  card: {
    backgroundColor: "transparent",
    padding: 0,
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
  // Photo-on-intake affordance
  intakeAttachBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: radii.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.glassRim,
    backgroundColor: colors.glassFill,
    alignSelf: "flex-start",
  },
  intakeAttachText: {
    fontSize: 13,
    fontFamily: fonts.sansSemibold,
    color: colors.accent,
  },
  intakePhotoRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    marginTop: 10,
  },
  intakePhotoRemove: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingVertical: 6,
  },
  intakePhotoRemoveText: {
    fontSize: 12,
    fontWeight: "600",
    color: colors.muted,
  },
  label: {
    fontSize: 11,
    fontFamily: fonts.sansSemibold,
    color: colors.muted,
    letterSpacing: 1.2,
    marginBottom: 7,
  },
  // v2 glass field — translucent steel tint + hairline rim, crisp corners.
  input: {
    minHeight: HIT_TARGET,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    fontFamily: fonts.sans,
    color: colors.text,
    backgroundColor: colors.glassFill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.glassRim,
    borderRadius: radii.sm,
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
    fontFamily: fonts.mono,
    letterSpacing: 1,
  },
  scanBtn: {
    flexDirection: "row",
    gap: 6,
    minHeight: HIT_TARGET,
    minWidth: HIT_TARGET + 24,
    paddingHorizontal: 16,
    backgroundColor: colors.accent, // solid light steel
    borderRadius: radii.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  scanBtnText: {
    color: colors.bg, // dark text on steel
    fontFamily: fonts.sansSemibold,
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
    backgroundColor: colors.accent, // solid light steel CTA
    borderRadius: radii.sm,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 18,
  },
  submitDisabled: {
    opacity: 0.45,
  },
  submitText: {
    color: colors.bg, // dark text on steel
    fontSize: 15,
    fontFamily: fonts.sansSemibold,
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
  // Resumed-case live-assessment-disabled banner (different-vehicle guard).
  resumeBanner: {
    backgroundColor: colors.surface2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 4,
  },
  resumeBannerText: {
    color: colors.muted,
    fontSize: 12,
    lineHeight: 17,
  },
  bannerStack: {
    gap: 8,
    marginBottom: 4,
  },
  // Saved-cases list (intake)
  casesSection: {
    marginBottom: 20,
    gap: 8,
  },
  casesSectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 2,
  },
  casesSectionLabel: {
    fontSize: 11,
    fontWeight: "500",
    color: colors.muted,
    letterSpacing: 0.7,
  },
  casesClearFilter: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: "600",
  },
  casesEmpty: {
    color: colors.muted,
    fontSize: 13,
    paddingVertical: 6,
  },
  casesToggle: {
    minHeight: HIT_TARGET - 12,
    justifyContent: "center",
    paddingHorizontal: 2,
  },
  // v2 collapsed saved-cases disclosure bar (inside a GlassCard).
  casesBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 14,
    minHeight: HIT_TARGET,
  },
  casesBarLabel: {
    color: colors.heading,
    fontSize: 14,
    fontFamily: fonts.sansSemibold,
  },
  casesCountChip: {
    backgroundColor: colors.steelChip,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.steelChipBorder,
    borderRadius: 999,
    minWidth: 22,
    paddingHorizontal: 7,
    paddingVertical: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  casesCountText: {
    color: colors.steelGlyph,
    fontSize: 11,
    fontFamily: fonts.sansSemibold,
  },
  casesExpanded: {
    gap: 8,
    marginTop: 8,
  },
  caseRow: {
    flexDirection: "row",
    alignItems: "stretch",
    backgroundColor: colors.glassFill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.glassRim,
    borderRadius: radii.sm,
    overflow: "hidden",
  },
  caseRowMain: {
    flex: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 3,
    minHeight: HIT_TARGET,
    justifyContent: "center",
  },
  caseRowHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  caseVehicle: {
    flex: 1,
    color: colors.text,
    fontSize: 14,
    fontWeight: "600",
  },
  caseChip: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 4,
  },
  caseChipOpen: {
    backgroundColor: colors.surface2,
  },
  caseChipFixed: {
    backgroundColor: colors.okBg,
  },
  caseChipClosed: {
    backgroundColor: colors.surface2,
  },
  caseChipText: {
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 1,
  },
  caseChipTextOpen: {
    color: colors.accent,
  },
  caseChipTextFixed: {
    color: colors.okText,
  },
  caseChipTextClosed: {
    color: colors.muted,
  },
  caseComplaint: {
    color: colors.muted,
    fontSize: 13,
  },
  caseMeta: {
    color: colors.muted,
    fontSize: 11,
  },
  caseAction: {
    minWidth: 64,
    paddingHorizontal: 12,
    alignItems: "center",
    justifyContent: "center",
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: colors.border,
    backgroundColor: colors.surface2,
  },
  caseActionText: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: "600",
  },
  // Intake — live-data section (connected only)
  dataStatusRow: {
    flexDirection: "row",
    gap: 8,
  },
  autoAssessNote: {
    fontSize: 12,
    color: colors.muted,
    lineHeight: 17,
    marginTop: 8,
  },
  // v2: the screen's one warm accent — shown only when an adapter is connected.
  warmConnectedRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 8,
  },
  warmDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.warm,
    shadowColor: colors.warm,
    shadowOpacity: 0.8,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 0 },
  },
  warmConnectedText: {
    color: colors.warmText,
    fontSize: 13,
    fontFamily: fonts.sansSemibold,
    letterSpacing: 0.2,
  },
  // SB2-D: "Connect an OBD2 adapter" affordance (routes to the OBD2 picker).
  connectAdapterBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 10,
    alignSelf: "flex-start",
    minHeight: HIT_TARGET - 8,
    justifyContent: "center",
    borderRadius: radii.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.glassRim,
    backgroundColor: colors.glassFill,
    paddingHorizontal: 16,
  },
  connectAdapterBtnText: {
    color: colors.accent,
    fontSize: 14,
    fontFamily: fonts.sansSemibold,
  },
  conditionHelp: {
    fontSize: 12,
    color: colors.muted,
    lineHeight: 17,
    marginBottom: 8,
  },
  // Assessment thread card
  assessmentWrap: {
    width: "100%",
    gap: 10,
    marginBottom: 14,
  },
  assessmentErrorBox: {
    marginTop: 0,
  },
  rerunLink: {
    alignSelf: "flex-start",
    minHeight: HIT_TARGET - 12,
    paddingHorizontal: 2,
    paddingVertical: 6,
    justifyContent: "center",
  },
  rerunLinkText: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.2,
  },
  // Stage 2C-4 capture-round affordances (minimal; SUB-BATCH 2 reworks the UX).
  startCaptureBtn: {
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
  startCaptureBtnText: {
    color: colors.accent,
    fontSize: 14,
    fontWeight: "700",
  },
  captureNoteBox: {
    borderRadius: radii.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.glassRim,
    backgroundColor: colors.glassFill,
    padding: 12,
  },
  captureNoteText: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 18,
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
    backgroundColor: colors.glassFill,
    borderColor: colors.glassRim,
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
    backgroundColor: "transparent",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.glassRim,
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
    color: colors.bg,
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
  composerWrap: {
    flexDirection: "column",
  },
  diagramBarRow: {
    flexDirection: "row",
    paddingHorizontal: 12,
    paddingBottom: 6,
  },
  findDiagramBtn: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: colors.steelChip,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.steelChipBorder,
  },
  findDiagramText: {
    color: colors.text,
    fontSize: 12,
    fontWeight: "600",
  },
  answerRow: {
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
    borderRadius: radii.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.glassRim,
    backgroundColor: colors.glassFill,
  },
  // Staged-photo chip above the input
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
  // (in-bubble photo thumbnail styles moved to components/PhotoThumb.tsx)
  answerInput: {
    flex: 1,
    minHeight: HIT_TARGET,
    maxHeight: 160,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    fontFamily: fonts.sans,
    color: colors.text,
    backgroundColor: colors.glassFill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.glassRim,
    borderRadius: radii.sm,
  },
  sendBtn: {
    minHeight: HIT_TARGET,
    minWidth: HIT_TARGET + 24,
    backgroundColor: colors.accent,
    borderRadius: radii.sm,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  sendBtnText: {
    color: colors.bg,
    fontWeight: "600",
    fontSize: 14,
    letterSpacing: 0.3,
  },
});
