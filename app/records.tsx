import { Ionicons } from "@expo/vector-icons";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Navbar from "../components/Navbar";
import Results from "../components/Results";
import {
  INSPECTION_TEMPLATE,
  SHOP_PLACEHOLDER,
  buildInspectionHtml,
  countByStatus,
  totalItemCount,
} from "../lib/inspection";
import {
  type DiagnosticRecord,
  type InspectionRecord,
  type SavedRecord,
  loadRecords,
} from "../lib/records";
import { HIT_TARGET, colors } from "../lib/theme";
import type {
  AssistantTurn,
  ChatMessage,
  InspectionItem,
  ItemStatus,
  VehicleInfo,
} from "../lib/types";

type FilterKey = "confirmed" | "incorrect" | "inspection";

function vehicleLine(v: VehicleInfo): string {
  return (
    [v.year, v.make, v.model]
      .filter((s) => s && s.length > 0)
      .join(" ") || "Unknown vehicle"
  );
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export default function RecordsScreen() {
  const [records, setRecords] = useState<SavedRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FilterKey>("confirmed");
  const [selected, setSelected] = useState<SavedRecord | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      const all = await loadRecords();
      if (active) {
        setRecords(all);
        setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const confirmedCount = records.filter(
    (r) => r.type === "diagnosis" && r.outcome === "confirmed",
  ).length;
  const incorrectCount = records.filter(
    (r) => r.type === "diagnosis" && r.outcome === "incorrect",
  ).length;
  const inspectionCount = records.filter((r) => r.type === "inspection").length;

  const visible = records.filter((r) => {
    if (filter === "inspection") return r.type === "inspection";
    return r.type === "diagnosis" && r.outcome === filter;
  });

  const emptyText =
    filter === "confirmed"
      ? "No confirmed fixes yet. Confirmed diagnoses will appear here."
      : filter === "incorrect"
        ? "No rejected diagnoses yet. Tap 'Not Correct' on a diagnosis to log it here."
        : "No inspections yet. Run a multi-point inspection from the home screen.";

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <Navbar showRecordsLink={false} showBack />

      <View style={styles.tabs}>
        <TabBtn
          active={filter === "confirmed"}
          label={`Fixed · ${confirmedCount}`}
          onPress={() => setFilter("confirmed")}
        />
        <TabBtn
          active={filter === "incorrect"}
          label={`Rejected · ${incorrectCount}`}
          onPress={() => setFilter("incorrect")}
        />
        <TabBtn
          active={filter === "inspection"}
          label={`Inspections · ${inspectionCount}`}
          onPress={() => setFilter("inspection")}
        />
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="small" color={colors.accent} />
        </View>
      ) : visible.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.empty}>{emptyText}</Text>
        </View>
      ) : (
        <FlatList
          data={visible}
          keyExtractor={(r) => r.id}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) =>
            item.type === "diagnosis" ? (
              <DiagnosisCard record={item} onPress={() => setSelected(item)} />
            ) : (
              <InspectionCard record={item} onPress={() => setSelected(item)} />
            )
          }
        />
      )}

      <Modal
        visible={!!selected}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => setSelected(null)}
      >
        {selected?.type === "diagnosis" && (
          <DiagnosisDetail
            record={selected}
            onClose={() => setSelected(null)}
          />
        )}
        {selected?.type === "inspection" && (
          <InspectionDetail
            record={selected}
            onClose={() => setSelected(null)}
          />
        )}
      </Modal>
    </SafeAreaView>
  );
}

// ---------- Tab button ----------

function TabBtn({
  active,
  label,
  onPress,
}: {
  active: boolean;
  label: string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[styles.tab, active && styles.tabActive]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <Text style={[styles.tabText, active && styles.tabTextActive]}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

// ---------- Diagnosis card ----------

function DiagnosisCard({
  record,
  onPress,
}: {
  record: DiagnosticRecord;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={styles.card}
      onPress={onPress}
      activeOpacity={0.85}
    >
      <View style={styles.cardHeader}>
        <Text style={styles.cardDate}>{formatDate(record.date)}</Text>
        <View
          style={[
            styles.outcomeBadge,
            record.outcome === "confirmed"
              ? styles.outcomeOk
              : styles.outcomeBad,
          ]}
        >
          <Text
            style={[
              styles.outcomeText,
              {
                color:
                  record.outcome === "confirmed"
                    ? colors.okText
                    : colors.dangerText,
              },
            ]}
          >
            {record.outcome === "confirmed" ? "FIXED" : "REJECTED"}
          </Text>
        </View>
      </View>
      <Text style={styles.cardVehicle}>{vehicleLine(record.vehicle)}</Text>
      {(record.vehicle.engineType || record.vehicle.mileage) && (
        <Text style={styles.cardSub}>
          {[
            record.vehicle.engineType,
            record.vehicle.mileage ? `${record.vehicle.mileage} mi` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </Text>
      )}
      <Text style={styles.cardLabel}>SYMPTOM</Text>
      <Text style={styles.cardBody} numberOfLines={2}>
        {record.symptom}
      </Text>
      <Text style={styles.cardLabel}>DIAGNOSIS</Text>
      <Text style={styles.cardBody} numberOfLines={3}>
        {record.diagnosis.root_cause}
      </Text>
    </TouchableOpacity>
  );
}

// ---------- Inspection card ----------

function InspectionCard({
  record,
  onPress,
}: {
  record: InspectionRecord;
  onPress: () => void;
}) {
  const counts = countByStatus(record.items);
  return (
    <TouchableOpacity
      style={styles.card}
      onPress={onPress}
      activeOpacity={0.85}
    >
      <View style={styles.cardHeader}>
        <Text style={styles.cardDate}>{formatDate(record.date)}</Text>
        <View style={[styles.outcomeBadge, styles.outcomeInspect]}>
          <Text style={[styles.outcomeText, { color: colors.accent }]}>
            INSPECTION
          </Text>
        </View>
      </View>
      <Text style={styles.cardVehicle}>{vehicleLine(record.vehicle)}</Text>
      {(record.vehicle.engineType || record.mileage) && (
        <Text style={styles.cardSub}>
          {[
            record.vehicle.engineType,
            record.mileage ? `${record.mileage} mi` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </Text>
      )}
      <View style={styles.inspectionCounts}>
        <CountPill kind="good" count={counts.good} label="Good" />
        <CountPill kind="attention" count={counts.attention} label="Attention" />
        <CountPill kind="urgent" count={counts.urgent} label="Urgent" />
        <Text style={styles.inspectionMeta}>
          {counts.completed} / {totalItemCount()} items
        </Text>
      </View>
    </TouchableOpacity>
  );
}

function CountPill({
  kind,
  count,
  label,
}: {
  kind: "good" | "attention" | "urgent";
  count: number;
  label: string;
}) {
  const p =
    kind === "good"
      ? { bg: colors.okBg, border: colors.okBorder, text: colors.okText }
      : kind === "attention"
        ? {
            bg: colors.warnBg,
            border: colors.warnBorder,
            text: colors.warnText,
          }
        : {
            bg: colors.dangerBg,
            border: colors.dangerBorder,
            text: colors.dangerText,
          };
  return (
    <View
      style={[
        styles.countPill,
        { backgroundColor: p.bg, borderColor: p.border },
      ]}
    >
      <Text style={[styles.countPillText, { color: p.text }]}>
        {count} {label}
      </Text>
    </View>
  );
}

// ---------- Diagnosis detail ----------

function DiagnosisDetail({
  record,
  onClose,
}: {
  record: DiagnosticRecord;
  onClose: () => void;
}) {
  return (
    <SafeAreaView
      style={styles.safe}
      edges={["top", "bottom", "left", "right"]}
    >
      <View style={styles.detailTopBar}>
        <TouchableOpacity
          onPress={onClose}
          style={styles.closeBtn}
          activeOpacity={0.7}
          accessibilityLabel="Close record"
        >
          <Text style={styles.closeText}>Close</Text>
        </TouchableOpacity>
        <Text style={styles.detailTitle}>
          {record.outcome === "confirmed"
            ? "Confirmed fix"
            : "Rejected diagnosis"}
        </Text>
        <View style={styles.closeBtn} />
      </View>

      <ScrollView contentContainerStyle={styles.detailContent}>
        <Text style={styles.detailDate}>{formatDate(record.date)}</Text>
        <Text style={styles.detailVehicle}>{vehicleLine(record.vehicle)}</Text>

        <View style={styles.metaCard}>
          {record.vehicle.trim ? (
            <MetaRow label="Trim" value={record.vehicle.trim} />
          ) : null}
          {record.vehicle.engineType ? (
            <MetaRow label="Engine" value={record.vehicle.engineType} />
          ) : null}
          {record.vehicle.mileage ? (
            <MetaRow label="Mileage" value={`${record.vehicle.mileage} mi`} />
          ) : null}
          {record.vin ? <MetaRow label="VIN" value={record.vin} /> : null}
        </View>

        <Text style={styles.sectionLabel}>SYMPTOM</Text>
        <View style={styles.symptomBox}>
          <Text style={styles.symptomText}>{record.symptom}</Text>
        </View>

        <Text style={styles.sectionLabel}>CONVERSATION</Text>
        <View style={styles.thread}>
          {record.conversation.map((m, i) => (
            <ConvoRow key={i} message={m} />
          ))}
        </View>

        <Text style={styles.sectionLabel}>FINAL DIAGNOSIS</Text>
        <Results data={record.diagnosis} />
      </ScrollView>
    </SafeAreaView>
  );
}

// ---------- Inspection detail ----------

function InspectionDetail({
  record,
  onClose,
}: {
  record: InspectionRecord;
  onClose: () => void;
}) {
  const [sharing, setSharing] = useState(false);
  const counts = countByStatus(record.items);

  async function onSharePdf() {
    setSharing(true);
    try {
      const dateStr = formatDate(record.date);
      const html = buildInspectionHtml({
        shop: SHOP_PLACEHOLDER,
        vehicle: record.vehicle,
        vin: record.vin,
        mileage: record.mileage,
        items: record.items,
        date: dateStr,
        tsbs: record.tsbs,
      });
      const { uri } = await Print.printToFileAsync({ html });
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, {
          mimeType: "application/pdf",
          UTI: "com.adobe.pdf",
          dialogTitle: "Share inspection report",
        });
      } else {
        Alert.alert("Sharing unavailable", "PDF saved to: " + uri);
      }
    } catch (err) {
      console.warn("[records] share failed:", err);
      Alert.alert("Couldn't share PDF", "Try again.");
    } finally {
      setSharing(false);
    }
  }

  return (
    <SafeAreaView
      style={styles.safe}
      edges={["top", "bottom", "left", "right"]}
    >
      <View style={styles.detailTopBar}>
        <TouchableOpacity
          onPress={onClose}
          style={styles.closeBtn}
          activeOpacity={0.7}
          accessibilityLabel="Close record"
        >
          <Text style={styles.closeText}>Close</Text>
        </TouchableOpacity>
        <Text style={styles.detailTitle}>Inspection</Text>
        <TouchableOpacity
          onPress={onSharePdf}
          style={styles.closeBtn}
          activeOpacity={0.7}
          disabled={sharing}
          accessibilityLabel="Share inspection PDF"
        >
          {sharing ? (
            <ActivityIndicator size="small" color={colors.accent} />
          ) : (
            <Ionicons name="share-outline" size={22} color={colors.accent} />
          )}
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.detailContent}>
        <Text style={styles.detailDate}>{formatDate(record.date)}</Text>
        <Text style={styles.detailVehicle}>{vehicleLine(record.vehicle)}</Text>

        <View style={styles.metaCard}>
          {record.vehicle.trim ? (
            <MetaRow label="Trim" value={record.vehicle.trim} />
          ) : null}
          {record.vehicle.engineType ? (
            <MetaRow label="Engine" value={record.vehicle.engineType} />
          ) : null}
          {record.mileage ? (
            <MetaRow label="Mileage" value={`${record.mileage} mi`} />
          ) : null}
          {record.vin ? <MetaRow label="VIN" value={record.vin} /> : null}
        </View>

        <View style={styles.summaryRow}>
          <CountPill kind="good" count={counts.good} label="Good" />
          <CountPill
            kind="attention"
            count={counts.attention}
            label="Attention"
          />
          <CountPill kind="urgent" count={counts.urgent} label="Urgent" />
        </View>

        {INSPECTION_TEMPLATE.map((section) => (
          <View key={section.id} style={styles.detailSection}>
            <Text style={styles.sectionLabel}>
              {section.title.toUpperCase()}
            </Text>
            <View style={styles.detailSectionCard}>
              {section.items.map((def, i) => {
                const item: InspectionItem = record.items[def.id] ?? {
                  status: null,
                  notes: "",
                };
                return (
                  <View
                    key={def.id}
                    style={[
                      styles.detailItemRow,
                      i === section.items.length - 1 && styles.lastRow,
                    ]}
                  >
                    <View
                      style={[
                        styles.statusDot,
                        statusDotStyle(item.status),
                      ]}
                    />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.detailItemLabel}>{def.label}</Text>
                      <Text
                        style={[
                          styles.detailItemStatus,
                          statusTextStyle(item.status),
                        ]}
                      >
                        {statusReadable(item.status)}
                      </Text>
                      {item.notes ? (
                        <Text style={styles.detailItemNotes}>
                          {item.notes}
                        </Text>
                      ) : null}
                    </View>
                  </View>
                );
              })}
            </View>
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

function statusReadable(status: ItemStatus): string {
  if (status === "good") return "Good";
  if (status === "attention") return "Needs Attention";
  if (status === "urgent") return "Urgent";
  return "Not inspected";
}

function statusDotStyle(status: ItemStatus) {
  if (status === "good") return { backgroundColor: "#16A34A" };
  if (status === "attention") return { backgroundColor: "#F59E0B" };
  if (status === "urgent") return { backgroundColor: "#DC2626" };
  return { backgroundColor: colors.borderStrong };
}

function statusTextStyle(status: ItemStatus) {
  if (status === "good") return { color: colors.okText };
  if (status === "attention") return { color: colors.warnText };
  if (status === "urgent") return { color: colors.dangerText };
  return { color: colors.muted };
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metaRow}>
      <Text style={styles.metaLabel}>{label}</Text>
      <Text style={styles.metaValue}>{value}</Text>
    </View>
  );
}

function ConvoRow({ message }: { message: ChatMessage }) {
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
      <View style={styles.assistantWrap}>
        <Text style={styles.assistantLabel}>ASSISTANT</Text>
        <View style={[styles.bubble, styles.bubbleAssistant]}>
          <Text style={styles.bubbleText}>{message.content}</Text>
        </View>
      </View>
    );
  }
  if (turn.kind === "question") {
    return (
      <View style={styles.assistantWrap}>
        <Text style={styles.assistantLabel}>ASSISTANT</Text>
        <View style={[styles.bubble, styles.bubbleAssistant]}>
          <Text style={styles.bubbleText}>{turn.question}</Text>
        </View>
      </View>
    );
  }
  return (
    <View style={styles.assistantWrap}>
      <Text style={styles.assistantLabel}>ASSISTANT (DIAGNOSIS)</Text>
      <View style={[styles.bubble, styles.bubbleAssistant]}>
        <Text style={styles.bubbleText}>{turn.diagnosis.root_cause}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  tabs: {
    flexDirection: "row",
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  tab: {
    flex: 1,
    minHeight: HIT_TARGET,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 6,
  },
  tabActive: {
    backgroundColor: colors.accentFade,
    borderColor: colors.accent,
  },
  tabText: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.2,
  },
  tabTextActive: {
    color: colors.accent,
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 40,
  },
  empty: {
    color: colors.muted,
    fontSize: 14,
    textAlign: "center",
    lineHeight: 21,
  },
  listContent: {
    padding: 16,
    gap: 12,
  },
  card: {
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 8,
    padding: 14,
    marginBottom: 10,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  cardDate: {
    color: colors.muted,
    fontSize: 11,
    letterSpacing: 0.3,
  },
  outcomeBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
  },
  outcomeOk: {
    backgroundColor: colors.okBg,
    borderColor: colors.okBorder,
  },
  outcomeBad: {
    backgroundColor: colors.dangerBg,
    borderColor: colors.dangerBorder,
  },
  outcomeInspect: {
    backgroundColor: colors.accentFade,
    borderColor: colors.accent,
  },
  outcomeText: {
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 1.2,
  },
  cardVehicle: {
    color: colors.heading,
    fontSize: 16,
    fontWeight: "600",
    marginBottom: 2,
  },
  cardSub: {
    color: colors.muted,
    fontSize: 12,
    marginBottom: 8,
  },
  cardLabel: {
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 1.2,
    color: colors.accent,
    marginTop: 8,
    marginBottom: 4,
  },
  cardBody: {
    color: colors.text,
    fontSize: 13,
    lineHeight: 19,
  },
  inspectionCounts: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 6,
    marginTop: 8,
  },
  inspectionMeta: {
    color: colors.muted,
    fontSize: 12,
    marginLeft: "auto",
  },
  countPill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
  },
  countPillText: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.3,
  },
  detailTopBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
  },
  closeBtn: {
    minWidth: HIT_TARGET + 24,
    minHeight: HIT_TARGET,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 12,
  },
  closeText: {
    color: colors.accent,
    fontSize: 15,
    fontWeight: "600",
  },
  detailTitle: {
    color: colors.heading,
    fontSize: 16,
    fontWeight: "600",
    letterSpacing: 0.3,
  },
  detailContent: {
    padding: 16,
    paddingBottom: 48,
  },
  detailDate: {
    color: colors.muted,
    fontSize: 12,
    marginBottom: 4,
  },
  detailVehicle: {
    color: colors.heading,
    fontSize: 22,
    fontWeight: "600",
    marginBottom: 12,
    letterSpacing: -0.2,
  },
  metaCard: {
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 6,
    marginBottom: 18,
  },
  metaRow: {
    flexDirection: "row",
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  metaLabel: {
    color: colors.muted,
    fontSize: 12,
    width: 80,
    fontWeight: "600",
    letterSpacing: 0.3,
  },
  metaValue: {
    flex: 1,
    color: colors.text,
    fontSize: 13,
  },
  summaryRow: {
    flexDirection: "row",
    gap: 8,
    flexWrap: "wrap",
    marginBottom: 18,
  },
  sectionLabel: {
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 1.8,
    color: colors.accent,
    marginBottom: 8,
    marginTop: 6,
  },
  detailSection: {
    marginBottom: 18,
  },
  detailSectionCard: {
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 14,
  },
  detailItemRow: {
    flexDirection: "row",
    paddingVertical: 10,
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    alignItems: "flex-start",
  },
  lastRow: {
    borderBottomWidth: 0,
  },
  statusDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    marginTop: 4,
  },
  detailItemLabel: {
    color: colors.text,
    fontSize: 13,
    lineHeight: 18,
  },
  detailItemStatus: {
    fontSize: 11,
    fontWeight: "600",
    marginTop: 2,
  },
  detailItemNotes: {
    fontSize: 12,
    color: colors.muted,
    marginTop: 4,
    fontStyle: "italic",
    paddingLeft: 6,
    borderLeftWidth: 2,
    borderLeftColor: colors.border,
  },
  symptomBox: {
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 8,
    padding: 14,
    marginBottom: 18,
  },
  symptomText: {
    color: colors.text,
    fontSize: 14,
    lineHeight: 21,
  },
  thread: {
    gap: 10,
    marginBottom: 18,
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
    fontSize: 14,
    lineHeight: 21,
  },
  bubbleTextUser: {
    color: colors.userText,
  },
  userWrap: {
    alignItems: "flex-end",
  },
  assistantWrap: {
    gap: 4,
  },
  assistantLabel: {
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 1.5,
    color: colors.muted,
  },
});
