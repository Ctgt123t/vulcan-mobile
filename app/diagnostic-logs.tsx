import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useState } from "react";
import {
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Navbar from "../components/Navbar";
import { diagnosticLogger, type DiagnosticLogEntry } from "../lib/diagnosticLogger";
import Background from "../components/ui/Background";
import { HIT_TARGET, colors, fonts, radii } from "../lib/theme";

// ---- Types ----

type Session = ReturnType<typeof diagnosticLogger.getSessions>[number];

// ---- Screen ----

export default function DiagnosticLogsScreen() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [totalEntries, setTotalEntries] = useState(0);
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(new Set());
  const [expandedEntries, setExpandedEntries] = useState<Set<string>>(new Set());

  // Reload on every focus so data captured in other screens is visible.
  useFocusEffect(
    useCallback(() => {
      const s = diagnosticLogger.getSessions();
      setSessions(s);
      setTotalEntries(diagnosticLogger.getEntries().length);
    }, []),
  );

  function toggleSession(sessionId: string) {
    setExpandedSessions((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  }

  function toggleEntry(entryId: string) {
    setExpandedEntries((prev) => {
      const next = new Set(prev);
      if (next.has(entryId)) next.delete(entryId);
      else next.add(entryId);
      return next;
    });
  }

  function onExport() {
    diagnosticLogger.exportShare().catch(() => {});
  }

  function onClear() {
    Alert.alert(
      "Clear diagnostic log?",
      "All captured sessions and entries will be permanently deleted.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Clear",
          style: "destructive",
          onPress: async () => {
            await diagnosticLogger.clear();
            setSessions([]);
            setTotalEntries(0);
            setExpandedSessions(new Set());
            setExpandedEntries(new Set());
          },
        },
      ],
    );
  }

  return (
    <Background>
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <Navbar transparent showBack />
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={styles.headerTitle}>Diagnostic Log</Text>
          <Text style={styles.headerCount}>
            {totalEntries} entr{totalEntries === 1 ? "y" : "ies"} · {sessions.length} session{sessions.length === 1 ? "" : "s"}
          </Text>
        </View>
        <View style={styles.headerActions}>
          <TouchableOpacity
            style={styles.headerBtn}
            onPress={onExport}
            activeOpacity={0.8}
            disabled={totalEntries === 0}
          >
            <Ionicons name="share-outline" size={18} color={totalEntries === 0 ? colors.muted : colors.accent} />
            <Text style={[styles.headerBtnText, totalEntries === 0 && styles.dimText]}>Export</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.headerBtn}
            onPress={onClear}
            activeOpacity={0.8}
            disabled={totalEntries === 0}
          >
            <Ionicons name="trash-outline" size={18} color={totalEntries === 0 ? colors.muted : colors.dangerText} />
            <Text style={[styles.headerBtnText, { color: totalEntries === 0 ? colors.muted : colors.dangerText }]}>
              Clear
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {sessions.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="document-outline" size={40} color={colors.muted} />
            <Text style={styles.emptyTitle}>No sessions recorded yet</Text>
            <Text style={styles.emptyBody}>
              Connect to a vehicle and run a DTC scan or start a diagnosis — events are captured automatically.
            </Text>
          </View>
        ) : (
          sessions.map((session) => (
            <SessionCard
              key={session.sessionId}
              session={session}
              expanded={expandedSessions.has(session.sessionId)}
              expandedEntries={expandedEntries}
              onToggleSession={() => toggleSession(session.sessionId)}
              onToggleEntry={toggleEntry}
            />
          ))
        )}
      </ScrollView>
    </SafeAreaView>
    </Background>
  );
}

// ---- Session card ----

function SessionCard({
  session,
  expanded,
  expandedEntries,
  onToggleSession,
  onToggleEntry,
}: {
  session: Session;
  expanded: boolean;
  expandedEntries: Set<string>;
  onToggleSession: () => void;
  onToggleEntry: (id: string) => void;
}) {
  const v = session.vehicle;
  const vehicleLabel = v
    ? ([v.year, v.make, v.model].filter(Boolean).join(" ") ||
        (v.vin ? `VIN ${v.vin}` : "Unknown vehicle"))
    : "Unknown vehicle";
  const date = new Date(session.startedAt);
  const dateLabel = `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;

  // Protocol badge color
  const isCan = session.protocolType === "can";
  const isNonCan = session.protocolType === "non-can";
  const protocolBg = isCan ? colors.okBg : isNonCan ? colors.warnBg : colors.surface2;
  const protocolText = isCan ? colors.okText : isNonCan ? colors.warnText : colors.muted;

  // Visible entries (skip session_start / session_end for the collapsed count)
  const visibleEntries = session.entries.filter(
    (e) => e.type !== "session_start" && e.type !== "session_end",
  );

  const warningCount = visibleEntries.filter((e) => e.type === "parser_warning").length;

  return (
    <View style={styles.sessionCard}>
      <TouchableOpacity
        style={styles.sessionHeader}
        onPress={onToggleSession}
        activeOpacity={0.8}
      >
        <View style={styles.sessionMeta}>
          <Text style={styles.sessionVehicle} numberOfLines={1}>
            {vehicleLabel}
          </Text>
          <View style={styles.sessionMetaRow}>
            <Text style={styles.sessionDate}>{dateLabel}</Text>
            {session.protocol && session.protocol !== "unknown" && (
              <View style={[styles.protocolBadge, { backgroundColor: protocolBg }]}>
                <Text style={[styles.protocolBadgeText, { color: protocolText }]}>
                  {session.protocol}
                </Text>
              </View>
            )}
            {warningCount > 0 && (
              <View style={styles.warnBadge}>
                <Ionicons name="warning" size={10} color={colors.dangerText} />
                <Text style={styles.warnBadgeText}>{warningCount}</Text>
              </View>
            )}
          </View>
          {v?.vin && (
            <Text style={styles.sessionVin} numberOfLines={1}>
              VIN: {v.vin}
            </Text>
          )}
        </View>
        <View style={styles.sessionRight}>
          <Text style={styles.sessionEntryCount}>{visibleEntries.length}</Text>
          <Text style={styles.expandChev}>{expanded ? "▾" : "▸"}</Text>
        </View>
      </TouchableOpacity>

      {expanded && (
        <View style={styles.sessionEntries}>
          {visibleEntries.map((entry) => (
            <EntryRow
              key={entry.id}
              entry={entry}
              expanded={expandedEntries.has(entry.id)}
              onToggle={() => onToggleEntry(entry.id)}
            />
          ))}
          {visibleEntries.length === 0 && (
            <Text style={styles.noEntries}>No events captured in this session.</Text>
          )}
        </View>
      )}
    </View>
  );
}

// ---- Entry row ----

function EntryRow({
  entry,
  expanded,
  onToggle,
}: {
  entry: DiagnosticLogEntry;
  expanded: boolean;
  onToggle: () => void;
}) {
  const time = new Date(entry.ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const isWarning = entry.type === "parser_warning";

  return (
    <TouchableOpacity
      style={[styles.entryRow, isWarning && styles.entryRowWarning]}
      onPress={onToggle}
      activeOpacity={0.8}
    >
      <View style={styles.entryHeader}>
        <EntryIcon type={entry.type} />
        <View style={styles.entryMeta}>
          <Text style={styles.entryTime}>{time}</Text>
          <Text
            style={[styles.entrySummary, isWarning && styles.entrySummaryWarning]}
            numberOfLines={expanded ? undefined : 2}
          >
            {summarizeEntry(entry)}
          </Text>
        </View>
        <Text style={styles.expandChev}>{expanded ? "▾" : "▸"}</Text>
      </View>

      {expanded && (
        <View style={styles.entryDetail}>
          <EntryDetail entry={entry} />
        </View>
      )}
    </TouchableOpacity>
  );
}

function EntryIcon({ type }: { type: DiagnosticLogEntry["type"] }) {
  const iconMap: Record<string, { name: keyof typeof Ionicons.glyphMap; color: string }> = {
    dtc_scan: { name: "scan-outline", color: colors.accent },
    parser_warning: { name: "warning", color: colors.dangerText },
    pid_snapshot: { name: "pulse-outline", color: colors.okText },
    assessment: { name: "analytics-outline", color: colors.accent },
    ask_vulcan: { name: "chatbubble-outline", color: colors.accent },
    diagnose_turn: { name: "medkit-outline", color: colors.warnText },
    protocol: { name: "hardware-chip-outline", color: colors.okText },
    self_test: { name: "checkmark-circle-outline", color: colors.okText },
    session_start: { name: "play-circle-outline", color: colors.muted },
    session_end: { name: "stop-circle-outline", color: colors.muted },
  };
  const icon = iconMap[type] ?? { name: "ellipse-outline" as const, color: colors.muted };
  return (
    <View style={styles.entryIconWrap}>
      <Ionicons name={icon.name} size={16} color={icon.color} />
    </View>
  );
}

function summarizeEntry(entry: DiagnosticLogEntry): string {
  switch (entry.type) {
    case "dtc_scan": {
      const codes = entry.parsedCodes ?? [];
      return `DTC Mode ${entry.mode}: ${codes.length > 0 ? codes.join(", ") : "no codes"}`;
    }
    case "parser_warning":
      return entry.warning ?? "Parser warning";
    case "pid_snapshot": {
      const count = Object.keys(entry.pidData ?? {}).length;
      return `PID Snapshot: ${count} signal${count === 1 ? "" : "s"}`;
    }
    case "assessment": {
      const h = entry.assessment?.hypotheses?.[0];
      return h
        ? `Assessment: ${h.name} (${h.confidence})`
        : "Assessment: no hypotheses";
    }
    case "ask_vulcan": {
      const costStr = entry.apiCost ? ` — $${entry.apiCost.cost.total.toFixed(4)}` : "";
      const q = entry.queryText ? ` "${entry.queryText}"` : "";
      return `Ask Vulcan:${q}${costStr}`;
    }
    case "diagnose_turn": {
      const costStr = entry.apiCost ? ` — $${entry.apiCost.cost.total.toFixed(4)}` : "";
      return `Diagnose (${entry.diagnoseTurnKind ?? "turn"})${costStr}`;
    }
    case "protocol":
      return `Protocol: ${entry.protocol ?? "unknown"}`;
    case "self_test":
      return `Self-test: ${entry.selfTestPassed ?? 0} passed${
        (entry.selfTestFailed ?? 0) > 0 ? `, ${entry.selfTestFailed} FAILED` : ""
      }`;
    default:
      return entry.type;
  }
}

function EntryDetail({ entry }: { entry: DiagnosticLogEntry }) {
  switch (entry.type) {
    case "dtc_scan":
      return (
        <View style={styles.detailBlock}>
          {entry.rawResponse && (
            <Text style={styles.detailMono} selectable>
              raw: {entry.rawResponse}
            </Text>
          )}
          <Text style={styles.detailLabel}>Parsed codes</Text>
          <Text style={styles.detailValue}>
            {(entry.parsedCodes ?? []).join(", ") || "none"}
          </Text>
        </View>
      );

    case "parser_warning":
      return (
        <View style={styles.detailBlock}>
          <Text style={styles.detailWarningMsg} selectable>
            {entry.warning}
          </Text>
        </View>
      );

    case "pid_snapshot": {
      const signals = Object.entries(entry.pidData ?? {});
      return (
        <View style={styles.detailBlock}>
          {signals.map(([key, s]) => (
            <View key={key} style={styles.pidRow}>
              <Text style={styles.pidName} numberOfLines={1}>{s.name}</Text>
              <Text style={styles.pidValue}>
                {s.value != null ? `${s.value}` : "—"}
                {s.unit ? ` ${s.unit}` : ""}
              </Text>
            </View>
          ))}
        </View>
      );
    }

    case "assessment": {
      const a = entry.assessment;
      if (!a) return null;
      const c = entry.apiCost;
      return (
        <View style={styles.detailBlock}>
          {c && (
            <>
              <Text style={styles.detailLabel}>API COST</Text>
              <Text style={styles.detailValue}>
                ${c.cost.total.toFixed(4)} total — input ${c.cost.input.toFixed(4)} · cache-write ${c.cost.cacheWrite.toFixed(4)} · cache-read ${c.cost.cacheRead.toFixed(4)} · output ${c.cost.output.toFixed(4)}
              </Text>
              <Text style={styles.detailMono}>
                tokens: in={c.tokens.input} cw={c.tokens.cacheWrite} cr={c.tokens.cacheRead} out={c.tokens.output} · {c.model}
              </Text>
            </>
          )}
          <Text style={styles.detailLabel}>Stance</Text>
          <Text style={styles.detailValue}>{a.stance} — {a.stance_reason}</Text>
          {a.hypotheses.map((h, i) => (
            <View key={i} style={styles.hypothesisRow}>
              <Text style={styles.hypothesisName}>{i + 1}. {h.name}</Text>
              <Text style={styles.hypothesisConf}>{h.confidence}</Text>
            </View>
          ))}
          <Text style={styles.detailLabel}>Next step ({a.next_step.type})</Text>
          <Text style={styles.detailValue}>{a.next_step.action}</Text>
          {a.data_ceiling_note.length > 0 && (
            <>
              <Text style={styles.detailLabel}>Data ceiling</Text>
              <Text style={styles.detailValue}>{a.data_ceiling_note}</Text>
            </>
          )}
        </View>
      );
    }

    case "ask_vulcan":
    case "diagnose_turn": {
      const c = entry.apiCost;
      if (!c) return null;
      return (
        <View style={styles.detailBlock}>
          <Text style={styles.detailLabel}>API COST</Text>
          <Text style={styles.detailValue}>
            ${c.cost.total.toFixed(4)} total — input ${c.cost.input.toFixed(4)} · cache-write ${c.cost.cacheWrite.toFixed(4)} · cache-read ${c.cost.cacheRead.toFixed(4)} · output ${c.cost.output.toFixed(4)}
          </Text>
          <Text style={styles.detailMono}>
            tokens: in={c.tokens.input} cw={c.tokens.cacheWrite} cr={c.tokens.cacheRead} out={c.tokens.output} · {c.model}
          </Text>
        </View>
      );
    }

    case "self_test":
      return (
        <View style={styles.detailBlock}>
          <Text style={styles.detailValue}>
            {entry.selfTestPassed} passed / {entry.selfTestFailed} failed
          </Text>
          {(entry.selfTestFailures ?? []).map((f, i) => (
            <Text key={i} style={styles.detailWarningMsg}>✗ {f}</Text>
          ))}
        </View>
      );

    default:
      return null;
  }
}

// ---- Styles ----

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "transparent" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: "transparent",
  },
  headerLeft: { gap: 2 },
  headerTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: colors.heading,
  },
  headerCount: {
    fontSize: 11,
    color: colors.muted,
  },
  headerActions: {
    flexDirection: "row",
    gap: 8,
  },
  headerBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radii.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.glassRim,
    backgroundColor: colors.glassFill,
    minHeight: HIT_TARGET - 12,
  },
  headerBtnText: {
    fontSize: 12,
    fontWeight: "600",
    color: colors.accent,
  },
  content: {
    padding: 12,
    paddingBottom: 48,
    gap: 10,
  },
  empty: {
    alignItems: "center",
    paddingVertical: 60,
    gap: 14,
    paddingHorizontal: 32,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: "600",
    color: colors.muted,
  },
  emptyBody: {
    fontSize: 13,
    color: colors.muted,
    textAlign: "center",
    lineHeight: 19,
  },
  // Session card
  sessionCard: {
    backgroundColor: colors.glassFill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.glassRim,
    borderRadius: radii.sm,
    overflow: "hidden",
  },
  sessionHeader: {
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
    gap: 10,
  },
  sessionMeta: { flex: 1, gap: 3 },
  sessionVehicle: {
    fontSize: 14,
    fontWeight: "700",
    color: colors.heading,
  },
  sessionMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
  },
  sessionDate: {
    fontSize: 11,
    color: colors.muted,
  },
  sessionVin: {
    fontSize: 10,
    color: colors.muted,
    fontFamily: fonts.mono,
  },
  protocolBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  protocolBadgeText: {
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.5,
  },
  warnBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    backgroundColor: colors.dangerBg,
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 4,
  },
  warnBadgeText: {
    fontSize: 10,
    fontWeight: "700",
    color: colors.dangerText,
  },
  sessionRight: {
    alignItems: "center",
    gap: 2,
  },
  sessionEntryCount: {
    fontSize: 18,
    fontWeight: "700",
    color: colors.accent,
  },
  sessionEntries: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  noEntries: {
    padding: 14,
    fontSize: 12,
    color: colors.muted,
    fontStyle: "italic",
  },
  // Entry row
  entryRow: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    gap: 0,
  },
  entryRowWarning: {
    backgroundColor: colors.dangerBg,
  },
  entryHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
  },
  entryIconWrap: {
    width: 20,
    alignItems: "center",
    marginTop: 1,
  },
  entryMeta: { flex: 1, gap: 1 },
  entryTime: {
    fontSize: 10,
    color: colors.muted,
    fontFamily: fonts.mono,
  },
  entrySummary: {
    fontSize: 13,
    color: colors.text,
    lineHeight: 18,
  },
  entrySummaryWarning: {
    color: colors.dangerText,
    fontWeight: "600",
  },
  expandChev: {
    fontSize: 16,
    color: colors.muted,
    marginTop: 2,
  },
  entryDetail: {
    marginTop: 8,
    paddingLeft: 28,
  },
  detailBlock: {
    gap: 4,
  },
  detailLabel: {
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 1.2,
    color: colors.accent,
    marginTop: 4,
  },
  detailValue: {
    fontSize: 12,
    color: colors.text,
    lineHeight: 17,
  },
  detailMono: {
    fontSize: 11,
    color: colors.muted,
    fontFamily: fonts.mono,
    lineHeight: 16,
  },
  detailWarningMsg: {
    fontSize: 12,
    color: colors.dangerText,
    lineHeight: 17,
  },
  pidRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 8,
  },
  pidName: {
    flex: 1,
    fontSize: 12,
    color: colors.muted,
  },
  pidValue: {
    fontSize: 12,
    fontWeight: "600",
    color: colors.text,
    fontFamily: fonts.mono,
  },
  hypothesisRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 2,
  },
  hypothesisName: {
    flex: 1,
    fontSize: 12,
    color: colors.text,
  },
  hypothesisConf: {
    fontSize: 10,
    fontWeight: "700",
    color: colors.muted,
  },
  dimText: {
    color: colors.muted,
  },
});
