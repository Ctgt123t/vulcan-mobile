import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
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
import AssessmentResult from "../components/assessment/AssessmentResult";
import ConditionSelector from "../components/assessment/ConditionSelector";
import DataBadge from "../components/assessment/DataBadge";
import { useObd2 } from "../contexts/Obd2Context";
import { EMPTY_VEHICLE, useVehicle } from "../contexts/VehicleContext";
import {
  AssessError,
  DiagnoseError,
  VinDecodeError,
  assess,
  decodeVin,
  diagnose,
  isLikelyVin,
} from "../lib/api";
import {
  type DiagnosticAssessment,
  type OperatingCondition,
} from "../lib/assessmentTypes";
import { buildDiagnosticSnapshot } from "../lib/diagnosticSnapshot";
import { consumeHandoff, setHandoff } from "../lib/handoff";
import { diagnosticLogger } from "../lib/diagnosticLogger";
import {
  closeCase,
  linkRecord,
  loadCase,
  pruneForNewCase,
  upsertCase,
} from "../lib/diagnosticCases";
import {
  type CaseCloseReason,
  type CaseStatus,
  type DiagnosticCase,
  type SavedAssessmentEntry,
  makeCaseId,
  vehicleLabel,
} from "../lib/diagnosticCasesCore";
import { obd2 } from "../lib/obd2";
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
import { HIT_TARGET, colors } from "../lib/theme";
import type {
  AssistantTurn,
  ChatMessage,
  FinalDiagnosis,
  VehicleInfo,
} from "../lib/types";

type Phase = "intake" | "chat";

// A structured assessment occupying a slot in the conversation thread.
// `afterMessageIndex` anchors the card to a fixed position (rendered after
// that message) so the layout doesn't jump when the assessment resolves
// after later conversational turns have already rendered.
interface AssessmentEntry {
  id: number;
  afterMessageIndex: number;
  slot:
    | { status: "running" }
    | { status: "done"; assessment: DiagnosticAssessment }
    | { status: "error"; message: string };
}

type ThreadRow =
  | { key: string; kind: "message"; message: ChatMessage }
  | { key: string; kind: "assessment"; entry: AssessmentEntry };

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

  // Structured-assessment state (merged Smart Diagnose path). When the
  // adapter is connected and scan data exists, an assessment runs
  // automatically on Start Diagnosis — in parallel with the conversational
  // call — and renders as a card in the thread.
  const { isConnected } = useObd2();
  const [condition, setCondition] = useState<OperatingCondition>("WARM_IDLE");
  const [assessments, setAssessments] = useState<AssessmentEntry[]>([]);
  const assessmentIdRef = useRef(0);

  // ---- Stage 2B: case save / resume ----
  const params = useLocalSearchParams<{ resume?: string }>();
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

  // Consume a pending OBD2 escalation (if present) on mount and pre-fill
  // the complaint with the scanned codes — same lines the old OBD2
  // "Diagnose with Vulcan" handoff produced. Consume-once, so a later
  // home-tile visit doesn't re-prefill from an old escalation. The handoff
  // STORE stays readable (it feeds the auto-assessment gate); only the
  // escalation flag is consumed.
  useEffect(() => {
    if (resumeIdAtMount) return; // resuming → the resume effect drains it
    const esc = consumeObd2DiagnoseEscalation();
    if (!esc) return;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Consume a handoff from Ask Vulcan (if present) on mount and pre-fill
  // the intake. We don't auto-submit — the technician confirms the vehicle
  // and symptom before the diagnostic conversation starts. Vehicle pushes
  // into the global context so the recall/TSB lookups fire automatically.
  useEffect(() => {
    if (resumeIdAtMount) return; // resuming → the resume effect drains it
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
          ? `OBD2 scan — stored codes: ${h.dtcs.join(", ")}.`
          : "";
      const permLine =
        h.permanentDtcs && h.permanentDtcs.length > 0
          ? `Permanent codes (survived last clear): ${h.permanentDtcs.join(", ")}.`
          : "";
      const combined = [dtcLine, permLine, h.symptom].filter((s) => s).join("\n\n");
      if (combined) setSymptom(combined);
    });
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
    let active = true;
    (async () => {
      const saved = await loadCase(resumeId);
      if (!active) return;
      // Drain pending handoffs regardless of outcome (consume + discard).
      consumeObd2DiagnoseEscalation();
      consumeHandoff("to_diagnose").catch(() => {});
      if (!saved) {
        // Case gone / unreadable (e.g. a future-version body after a rollback).
        // Stay on a fresh intake rather than crash; the list won't have shown it.
        return;
      }
      // RESUME-TIME BLOCK (row 4): a VIN case while connected to a DIFFERENT
      // vehicle must not open the conversation at all. connectedVin is ground
      // truth from the OBD2 manager, not the overridable context.
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
    })();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.resume]);

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
    }));
    setAssessments(restored);
    assessmentsRef.current = restored;
    assessmentIdRef.current = restored.length; // next re-run gets a fresh id
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

  // Gate for actually RUNNING an assessment — the data-availability gate AND
  // the different-vehicle guard. Fresh sessions: identical to canAutoAssess.
  // Resumed sessions: additionally require the live car to be the case car.
  const liveAssessmentAllowed = canAutoAssess && liveVehicleMatchesCase();
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
      evidenceLedger: [],
      caseState: null,
    };
    upsertCase(envelope).catch((err) =>
      console.warn("[cases] save failed:", err),
    );
  }

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

  function onRerunAssessment() {
    runAssessment(Math.max(messages.length - 1, 0), symptom.trim());
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
    // Create a fresh case (cap-enforced). This is a NEW session even if the VIN
    // matches an existing case — cases key on their own id. resumedCaseRef stays
    // null so the guard runs in fresh mode (2A behavior).
    resumedCaseRef.current = null;
    const decision = await pruneForNewCase();
    if (decision.blocked) {
      // 25 open cases, none closable without consent. Batch 2 fallback: run
      // UNSAVED (caseMetaRef null → saveCase no-ops). The all-25-open consent
      // UX lands in Batch 3.
      caseMetaRef.current = null;
      console.warn(
        "[cases] 25 open cases — running this session unsaved (consent UX in Batch 3)",
      );
    } else {
      const now = new Date().toISOString();
      caseMetaRef.current = {
        id: makeCaseId(),
        createdAt: now,
        status: "open",
        closeReason: null,
        closedAt: null,
        linkedRecordIds: [],
        loggerSessionIds: [],
      };
    }
    setMessages([first]);
    messagesRef.current = [first];
    setPhase("chat");
    saveCase({ messages: [first] });
    if (liveAssessmentAllowed) {
      // Deliberately not awaited — the assessment and the first
      // conversational call run in parallel. Independent calls: if the
      // assessment fails, the conversation proceeds untouched.
      runAssessment(0, symptom.trim());
    }
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
    messagesRef.current = next;
    setAnswer("");
    // Save the user turn before the API call so a failure/crash after this
    // point doesn't lose the technician's input.
    saveCase({ messages: next });
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
    // Stage 2B: the previous case was already saved at its last completed turn
    // and stays OPEN + resumable from the list — reset does NOT touch its stored
    // body or status. Clearing these refs makes the next intake a genuinely
    // fresh case (new id at submit) and drops the resume guard. The
    // connection-aware vehicle handling below is unchanged from 2A.
    caseMetaRef.current = null;
    resumedCaseRef.current = null;
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
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <Navbar showBack />
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
                      placeholder="Camry, Sierra 1500"
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

              {isConnected && (
                <View style={styles.singleField}>
                  <Text style={styles.label}>LIVE OBD2 DATA</Text>
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
          data={threadRows}
          keyExtractor={(item) => item.key}
          ListHeaderComponent={
            resumeBlockBanner ? (
              <View style={styles.resumeBanner}>
                <Text style={styles.resumeBannerText}>{resumeBlockBanner}</Text>
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
                  liveAssessmentAllowed &&
                  item.entry.id === lastAssessmentId &&
                  item.entry.slot.status !== "running"
                    ? onRerunAssessment
                    : undefined
                }
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

// A structured assessment rendered as a thread item. The running state
// occupies the slot from the moment the assessment fires, so the card
// resolving later never shifts the layout of turns rendered below it.
function AssessmentThreadCard({
  entry,
  onRerun,
}: {
  entry: AssessmentEntry;
  onRerun?: () => void;
}) {
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
        <AssessmentResult assessment={entry.slot.assessment} />
      )}
      {entry.slot.status === "error" && (
        <View style={[styles.errorBox, styles.assessmentErrorBox]}>
          <Text style={styles.errorText}>
            Assessment failed: {entry.slot.message} The conversation below
            continues without it.
          </Text>
        </View>
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
