import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import {
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Navbar from "../components/Navbar";
import Background from "../components/ui/Background";
import GlassCard from "../components/ui/GlassCard";
import { loadIndex } from "../lib/diagnosticCases";
import type { CaseIndexEntry } from "../lib/diagnosticCasesCore";
import { deleteLightThread, loadLightIndex } from "../lib/lightThreads";
import type { LightThreadIndexEntry } from "../lib/lightThreadsCore";
import { HIT_TARGET, colors, fonts, radii, space } from "../lib/theme";

// ============================================================================
// Unified chat list (Ask+Diagnose merge plan, Phase 3 — the multitasking
// surface). One list spanning BOTH thread kinds: light chats (lightThreads
// store) and diagnostic cases (diagnosticCases store), sorted by last
// activity. Leave any thread mid-flight, open another, return where you left
// off. Read-mostly: light threads can be deleted here (no lifecycle); case
// lifecycle actions (close/delete/consent) stay on the intake saved-cases
// list — one home for that logic.
// ============================================================================

type Row =
  | { kind: "light"; id: string; entry: LightThreadIndexEntry }
  | { kind: "case"; id: string; entry: CaseIndexEntry };

function rowUpdatedAt(r: Row): string {
  return r.entry.updatedAt;
}

function relTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

export default function ChatsScreen() {
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>([]);

  const refresh = useCallback(() => {
    let active = true;
    Promise.all([loadLightIndex(), loadIndex()])
      .then(([light, cases]) => {
        if (!active) return;
        const merged: Row[] = [
          ...light.map((e): Row => ({ kind: "light", id: e.id, entry: e })),
          ...cases.map((e): Row => ({ kind: "case", id: e.id, entry: e })),
        ].sort((a, b) => rowUpdatedAt(b).localeCompare(rowUpdatedAt(a)));
        setRows(merged);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  useFocusEffect(refresh);

  function openRow(row: Row) {
    if (row.kind === "case") {
      router.push({ pathname: "/chat", params: { resume: row.id } });
    } else {
      router.push({ pathname: "/chat", params: { thread: row.id } });
    }
  }

  function confirmDeleteLight(row: Row) {
    Alert.alert("Delete chat?", "This conversation will be removed.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          deleteLightThread(row.id)
            .then(() => refresh())
            .catch(() => {});
        },
      },
    ]);
  }

  return (
    <Background>
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <Navbar transparent showBack />
        <View style={styles.header}>
          <Text style={styles.title}>Chats</Text>
          <Text style={styles.subtitle}>
            Queries and diagnoses — pick up any conversation where you left
            off.
          </Text>
        </View>
        <FlatList
          data={rows}
          keyExtractor={(r) => `${r.kind}:${r.id}`}
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={
            <Text style={styles.empty}>
              No conversations yet. Start one from the home screen.
            </Text>
          }
          renderItem={({ item }) => (
            <GlassCard
              onPress={() => openRow(item)}
              accessibilityLabel={
                item.kind === "case"
                  ? `Diagnosis: ${item.entry.complaintPreview}`
                  : `Chat: ${(item.entry as LightThreadIndexEntry).titlePreview}`
              }
            >
              <View style={styles.rowInner}>
                <View style={styles.iconChip}>
                  <Ionicons
                    name={
                      item.kind === "case"
                        ? "pulse-outline"
                        : "chatbubbles-outline"
                    }
                    size={18}
                    color={colors.steelGlyph}
                  />
                </View>
                <View style={styles.rowBody}>
                  <Text style={styles.rowTitle} numberOfLines={1}>
                    {item.kind === "case"
                      ? item.entry.complaintPreview || "Diagnosis"
                      : (item.entry as LightThreadIndexEntry).titlePreview}
                  </Text>
                  <View style={styles.metaRow}>
                    {item.kind === "case" ? (
                      <Text
                        style={[
                          styles.chip,
                          item.entry.status === "open"
                            ? styles.chipOpen
                            : item.entry.closeReason === "fix_confirmed"
                              ? styles.chipFixed
                              : styles.chipClosed,
                        ]}
                      >
                        {item.entry.status === "open"
                          ? "DIAGNOSIS"
                          : item.entry.closeReason === "fix_confirmed"
                            ? "FIXED"
                            : "CLOSED"}
                      </Text>
                    ) : (
                      <Text style={[styles.chip, styles.chipLight]}>CHAT</Text>
                    )}
                    {(item.kind === "case"
                      ? item.entry.vehicleLabel
                      : (item.entry as LightThreadIndexEntry).vehicleLabel) ? (
                      <Text style={styles.metaText} numberOfLines={1}>
                        {item.kind === "case"
                          ? item.entry.vehicleLabel
                          : (item.entry as LightThreadIndexEntry).vehicleLabel}
                      </Text>
                    ) : null}
                    <Text style={styles.metaTime}>
                      {relTime(item.entry.updatedAt)}
                    </Text>
                  </View>
                </View>
                {item.kind === "light" ? (
                  <TouchableOpacity
                    style={styles.deleteBtn}
                    onPress={() => confirmDeleteLight(item)}
                    accessibilityRole="button"
                    accessibilityLabel="Delete chat"
                    hitSlop={8}
                  >
                    <Ionicons
                      name="trash-outline"
                      size={16}
                      color={colors.faint}
                    />
                  </TouchableOpacity>
                ) : (
                  <Ionicons
                    name="chevron-forward"
                    size={18}
                    color={colors.faint}
                  />
                )}
              </View>
            </GlassCard>
          )}
          ItemSeparatorComponent={() => <View style={{ height: space.sm }} />}
        />
        <Pressable
          style={styles.newChatBtn}
          onPress={() => router.push({ pathname: "/chat", params: { mode: "light" } })}
          accessibilityRole="button"
          accessibilityLabel="New chat"
        >
          <Ionicons name="add" size={18} color={colors.brandChip} />
          <Text style={styles.newChatText}>New chat</Text>
        </Pressable>
      </SafeAreaView>
    </Background>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "transparent" },
  header: {
    paddingHorizontal: space.xl,
    paddingTop: space.md,
    paddingBottom: space.lg,
    gap: 4,
  },
  title: {
    color: colors.heading,
    fontSize: 20,
    fontFamily: fonts.sansSemibold,
  },
  subtitle: {
    color: colors.muted,
    fontSize: 13,
    fontFamily: fonts.sans,
    lineHeight: 18,
  },
  listContent: {
    paddingHorizontal: space.xl,
    paddingBottom: space.xxl * 2,
    flexGrow: 1,
  },
  empty: {
    color: colors.muted,
    fontSize: 14,
    fontFamily: fonts.sans,
    textAlign: "center",
    marginTop: space.xxl,
  },
  rowInner: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    gap: space.md,
    minHeight: HIT_TARGET,
  },
  iconChip: {
    width: 36,
    height: 36,
    borderRadius: radii.sm,
    backgroundColor: colors.steelChip,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.steelChipBorder,
    alignItems: "center",
    justifyContent: "center",
  },
  rowBody: { flex: 1, gap: 4, minWidth: 0 },
  rowTitle: {
    color: colors.heading,
    fontSize: 14,
    fontFamily: fonts.sansMedium,
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
  },
  chip: {
    fontSize: 10,
    fontFamily: fonts.sansSemibold,
    letterSpacing: 0.6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radii.sm,
    overflow: "hidden",
  },
  chipLight: {
    color: colors.steelGlyph,
    backgroundColor: colors.steelChip,
  },
  chipOpen: {
    color: colors.warmText,
    backgroundColor: colors.warmFade,
  },
  chipFixed: {
    color: colors.okText,
    backgroundColor: colors.okBg,
  },
  chipClosed: {
    color: colors.muted,
    backgroundColor: colors.steelChip,
  },
  metaText: {
    color: colors.muted,
    fontSize: 11,
    fontFamily: fonts.sans,
    flexShrink: 1,
  },
  metaTime: {
    color: colors.faint,
    fontSize: 11,
    fontFamily: fonts.sans,
    marginLeft: "auto",
  },
  deleteBtn: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  newChatBtn: {
    position: "absolute",
    bottom: space.xl,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderRadius: radii.md,
    backgroundColor: colors.brandChip,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.brandChipBorder,
    minHeight: HIT_TARGET,
  },
  newChatText: {
    color: colors.warmText,
    fontSize: 14,
    fontFamily: fonts.sansSemibold,
  },
});
