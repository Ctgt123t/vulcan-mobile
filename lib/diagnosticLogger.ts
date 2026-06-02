// ============================================================================
// On-device diagnostic logger.
//
// Captures diagnostic events to a persistent in-memory + AsyncStorage
// rolling buffer during use, so data is available for review and export
// after a shop session even when the Metro console is unavailable (e.g. in
// a standalone preview build).
//
// Design:
//   - In-memory buffer — log() is synchronous and zero-latency.
//   - Debounced AsyncStorage flush — writes batch at 500ms intervals.
//   - Session concept — each adapter connection is a session; all log
//     entries for a session share a sessionId, so entries from different
//     vehicles can be clearly separated after a full day of testing.
//   - Rolling cap — entries beyond MAX_ENTRIES drop the oldest.
//   - Export — React Native Share API (no expo-file-system required).
// ============================================================================

import AsyncStorage from "@react-native-async-storage/async-storage";
import { Share } from "react-native";
import type { ApiCostData, DiagnosticAssessment } from "./assessmentTypes";

export type LogEntryType =
  | "session_start"
  | "session_end"
  | "protocol"
  | "dtc_scan"
  | "parser_warning"
  | "pid_snapshot"
  | "assessment"
  | "self_test";

export interface VehicleRef {
  year: string;
  make: string;
  model: string;
  vin: string | null;
}

export interface DiagnosticLogEntry {
  id: string;
  sessionId: string | null;
  ts: number;
  type: LogEntryType;
  // session_start / session_end
  vehicle?: VehicleRef;
  protocol?: string;
  protocolType?: "can" | "non-can" | "unknown";
  adapterName?: string;
  // dtc_scan
  mode?: string; // "03" | "07" | "0A"
  rawResponse?: string;
  parsedCodes?: string[];
  // parser_warning
  warning?: string;
  // pid_snapshot
  pidData?: Record<
    string,
    { name: string; value: number | null; unit: string | null; category: string }
  >;
  // assessment
  assessment?: DiagnosticAssessment;
  operatingCondition?: string;
  apiCost?: ApiCostData | null; // cost of the Claude call that produced this assessment
  // self_test
  selfTestPassed?: number;
  selfTestFailed?: number;
  selfTestFailures?: string[];
}

const STORAGE_KEY = "vulcan:diagnostic-log:v1";
const MAX_ENTRIES = 2000;
const FLUSH_DEBOUNCE_MS = 500;

class DiagnosticLogger {
  private entries: DiagnosticLogEntry[] = [];
  private currentSessionId: string | null = null;
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private initialized = false;

  // Call once at app startup to load historical entries from AsyncStorage.
  // Entries logged before this completes go to the in-memory buffer and
  // are persisted on the next flush.
  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as DiagnosticLogEntry[];
        // Only prepend if we haven't already accumulated entries before init
        this.entries = [...parsed, ...this.entries];
        if (this.entries.length > MAX_ENTRIES) {
          this.entries = this.entries.slice(this.entries.length - MAX_ENTRIES);
        }
      }
    } catch {
      // Silently continue — logging must never crash the app
    }
  }

  // Fire-and-forget. Synchronous write to memory; async persist.
  log(entry: Omit<DiagnosticLogEntry, "id" | "ts" | "sessionId">): void {
    const full: DiagnosticLogEntry = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      ts: Date.now(),
      sessionId: this.currentSessionId,
      ...entry,
    };
    this.entries.push(full);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries = this.entries.slice(this.entries.length - MAX_ENTRIES);
    }
    this.dirty = true;
    this.scheduleFlush();
  }

  // Start a new session — call when OBD2 adapter connects.
  startSession(opts: {
    vehicle?: VehicleRef;
    protocol?: string;
    protocolType?: "can" | "non-can" | "unknown";
    adapterName?: string;
  }): void {
    this.currentSessionId = `s${Date.now().toString(36)}`;
    this.log({ type: "session_start", ...opts });
  }

  // End the current session — call on disconnect.
  endSession(): void {
    if (this.currentSessionId) {
      this.log({ type: "session_end" });
      this.currentSessionId = null;
    }
  }

  getCurrentSessionId(): string | null {
    return this.currentSessionId;
  }

  getEntries(): DiagnosticLogEntry[] {
    return [...this.entries];
  }

  // Returns sessions from newest to oldest, each with their entries in
  // chronological order — ready to render in the log viewer.
  getSessions(): Array<{
    sessionId: string;
    vehicle?: VehicleRef;
    protocol?: string;
    protocolType?: "can" | "non-can" | "unknown";
    adapterName?: string;
    startedAt: number;
    endedAt?: number;
    entries: DiagnosticLogEntry[];
  }> {
    const map = new Map<string, DiagnosticLogEntry[]>();
    for (const e of this.entries) {
      const key = e.sessionId ?? "__nosession__";
      const arr = map.get(key) ?? [];
      arr.push(e);
      map.set(key, arr);
    }

    const sessions = [];
    for (const [sessionId, entries] of map.entries()) {
      if (sessionId === "__nosession__") continue;
      const start = entries.find((e) => e.type === "session_start");
      const end = entries.find((e) => e.type === "session_end");
      sessions.push({
        sessionId,
        vehicle: start?.vehicle,
        protocol: start?.protocol,
        protocolType: start?.protocolType,
        adapterName: start?.adapterName,
        startedAt: start?.ts ?? entries[0]?.ts ?? 0,
        endedAt: end?.ts,
        entries,
      });
    }

    // Newest session first
    return sessions.sort((a, b) => b.startedAt - a.startedAt);
  }

  async clear(): Promise<void> {
    this.entries = [];
    this.dirty = false;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await AsyncStorage.removeItem(STORAGE_KEY).catch(() => {});
  }

  // Export via React Native Share sheet (no native file dependencies).
  // Includes a human-readable text summary followed by the full JSON.
  async exportShare(): Promise<void> {
    const json = JSON.stringify(this.entries, null, 2);
    const summary = this.buildTextSummary();
    const combined =
      `=== VULCAN DIAGNOSTIC LOG ===\n` +
      `Exported: ${new Date().toLocaleString()}\n` +
      `${this.entries.length} entries\n\n` +
      summary +
      `\n\n${"─".repeat(60)}\n` +
      `RAW JSON (${this.entries.length} entries):\n` +
      json;

    try {
      await Share.share({
        title: "Vulcan Diagnostic Log",
        message: combined,
      });
    } catch {
      // User cancelled — no-op
    }
  }

  // Force flush — call on app background/suspend.
  async flush(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await AsyncStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(this.entries),
    ).catch(() => {});
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (this.dirty) {
        this.dirty = false;
        AsyncStorage.setItem(
          STORAGE_KEY,
          JSON.stringify(this.entries),
        ).catch(() => {});
      }
    }, FLUSH_DEBOUNCE_MS);
  }

  private buildTextSummary(): string {
    const sessions = this.getSessions();
    const lines: string[] = [];

    for (const session of sessions) {
      const v = session.vehicle;
      const vehicleLabel = v
        ? `${v.year} ${v.make} ${v.model}${v.vin ? ` (${v.vin})` : ""}`
        : "Unknown vehicle";
      const date = new Date(session.startedAt).toLocaleString();
      lines.push(`\n== ${vehicleLabel} ==`);
      lines.push(`   ${date} · Protocol: ${session.protocol ?? "unknown"}`);
      if (session.adapterName) lines.push(`   Adapter: ${session.adapterName}`);

      for (const e of session.entries) {
        const t = new Date(e.ts).toLocaleTimeString();
        switch (e.type) {
          case "dtc_scan":
            lines.push(
              `  [${t}] DTC Mode ${e.mode}: [${e.parsedCodes?.join(", ") || "no codes"}]`,
            );
            if (e.rawResponse) lines.push(`         raw: ${e.rawResponse}`);
            break;
          case "parser_warning":
            lines.push(`  [${t}] ⚠ PARSER WARNING: ${e.warning}`);
            break;
          case "assessment": {
            const h = e.assessment?.hypotheses?.[0];
            const costStr = e.apiCost ? ` — $${e.apiCost.cost.total.toFixed(4)}` : "";
            lines.push(
              `  [${t}] Smart Diagnose: ${h ? `${h.name} (${h.confidence})` : "no hypotheses"}${costStr}`,
            );
            if (e.apiCost) {
              lines.push(
                `       tokens: in=${e.apiCost.tokens.input} cw=${e.apiCost.tokens.cacheWrite} ` +
                `cr=${e.apiCost.tokens.cacheRead} out=${e.apiCost.tokens.output}`,
              );
            }
            break;
          }
          case "pid_snapshot": {
            const count = Object.keys(e.pidData ?? {}).length;
            lines.push(`  [${t}] PID Snapshot: ${count} signals`);
            break;
          }
          case "protocol":
            lines.push(`  [${t}] Protocol: ${e.protocol}`);
            break;
          case "self_test":
            lines.push(
              `  [${t}] Self-test: ${e.selfTestPassed ?? 0} passed, ${e.selfTestFailed ?? 0} failed`,
            );
            if ((e.selfTestFailed ?? 0) > 0) {
              for (const f of e.selfTestFailures ?? []) {
                lines.push(`         ✗ ${f}`);
              }
            }
            break;
        }
      }
    }

    return lines.join("\n");
  }
}

export const diagnosticLogger = new DiagnosticLogger();
