// ============================================================================
// API cost logger.
//
// Captures the token usage and dollar cost of every Claude API call made by
// the backend. Maintains:
//   - Per-call entries (rolling, last MAX_ENTRIES calls)
//   - Running aggregate (today / this week / all-time / by model / by type)
//
// Persistence: costEntries.json + costAggregate.json on the Railway Volume
// (same CACHE_DIR as all other cache files). Both survive redeploys when the
// Volume is mounted. Reset to zero if the Volume is not wired — not harmful,
// but historical cost data will be lost.
//
// Scaling note: JSON file storage is fine for a single-instance Railway
// service at current traffic. At thousands of concurrent users the aggregate
// should move to a real database (Supabase/Postgres). Flag this before
// scaling.
//
// Writes are fire-and-forget (debounced) so cost capture never adds latency
// to API responses.
// ============================================================================

import fs from "node:fs";
import { cacheFile } from "./cacheDir.js";
import { computeCost } from "./costConfig.js";

const ENTRIES_PATH   = cacheFile("costEntries.json");
const AGGREGATE_PATH = cacheFile("costAggregate.json");
const MAX_ENTRIES    = 500;   // rolling cap — ~100KB on disk
const SAVE_DELAY_MS  = 2000;  // debounce window for disk writes
const SUMMARY_EVERY  = 10;    // print a cost summary every N API calls

// ---- In-memory state ----

let entries   = [];
let aggregate = blankAggregate();
let dirty     = false;
let saveTimer = null;

// Unique session IDs seen today / this week (in-memory only; not persisted).
let todaySessionIds = new Set();
let weekSessionIds  = new Set();

// ---- Startup: load from disk ----

try {
  if (fs.existsSync(ENTRIES_PATH)) {
    const raw = JSON.parse(fs.readFileSync(ENTRIES_PATH, "utf8"));
    entries = Array.isArray(raw.entries) ? raw.entries : [];
  }
  if (fs.existsSync(AGGREGATE_PATH)) {
    aggregate = JSON.parse(fs.readFileSync(AGGREGATE_PATH, "utf8"));
    // Re-populate session ID sets from today's/this week's data.
    // We don't persist the sets themselves (they'd be stale), so seed from
    // recent entries instead.
    const today     = todayUtc();
    const weekStart = weekStartUtc();
    for (const e of entries) {
      if (!e.sessionId) continue;
      if (e.date === today)      todaySessionIds.add(e.sessionId);
      if (e.date >= weekStart)   weekSessionIds.add(e.sessionId);
    }
  }
  console.log(
    `[cost-logger] loaded: ${entries.length} entries, ` +
      `allTime=$${(aggregate.allTime?.totalCost ?? 0).toFixed(4)} ` +
      `(${aggregate.allTime?.calls ?? 0} calls)`,
  );
} catch (err) {
  console.warn("[cost-logger] failed to load cost data, starting fresh:", err.message);
  entries   = [];
  aggregate = blankAggregate();
}

// ---- Public API ----

// Log the cost of one Claude API call. Safe to call fire-and-forget:
//   logApiCost(response.usage, MODEL, { sessionId, callType }).
// Returns the computed cost data (or null if model pricing is unknown).
export function logApiCost(usage, model, meta = {}) {
  // caseId (merge-plan Phase 2, additive): attributes diagnostic calls to the
  // diagnosis credit's metering key. sessionId is per-OBD2-connect and null
  // for disconnected diagnoses, so it cannot key billing — caseId can.
  const { sessionId = null, callType = "unknown", caseId = null } = meta;

  const costData = computeCost(usage, model);
  if (!costData) return null; // unknown model — already warned by computeCost

  const today = todayUtc();

  const entry = {
    id:        `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    ts:        Date.now(),
    date:      today,
    sessionId,
    caseId,
    callType,
    model:     costData.model,
    tokens:    costData.tokens,
    cost:      costData.cost,
  };

  // In-memory append + roll
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) {
    entries = entries.slice(entries.length - MAX_ENTRIES);
  }

  // Update aggregate
  _updateAggregate(entry, today);

  // Console log — always show for every call (DTC + assessment context)
  console.log(
    `[cost] ${callType}/${model} ` +
      `in=${entry.tokens.input}+cw=${entry.tokens.cacheWrite}+cr=${entry.tokens.cacheRead} ` +
      `out=${entry.tokens.output} → $${entry.cost.total.toFixed(6)}` +
      (sessionId ? ` [${sessionId}]` : ""),
  );

  // Periodic summary every SUMMARY_EVERY calls
  if (aggregate.allTime.calls % SUMMARY_EVERY === 0) {
    console.log(
      `[cost] summary — today: $${aggregate.today.totalCost.toFixed(4)} ` +
        `(${aggregate.today.calls} calls, ${aggregate.today.sessions} sessions) | ` +
        `week: $${aggregate.week.totalCost.toFixed(4)} | ` +
        `allTime: $${aggregate.allTime.totalCost.toFixed(4)} (${aggregate.allTime.calls} calls)`,
    );
  }

  dirty = true;
  _scheduleFlush();

  return costData;
}

// Returns the full aggregate + session breakdown from recent entries.
export function getCostSummary() {
  // Per-session rollup from recent in-memory entries
  const sessionMap = new Map();
  for (const e of entries) {
    if (!e.sessionId) continue;
    const s = sessionMap.get(e.sessionId) ?? {
      sessionId: e.sessionId,
      date: e.date,
      calls: 0,
      totalCost: 0,
      byType: {},
    };
    s.calls++;
    s.totalCost = r6(s.totalCost + e.cost.total);
    if (!s.byType[e.callType]) s.byType[e.callType] = { calls: 0, totalCost: 0 };
    s.byType[e.callType].calls++;
    s.byType[e.callType].totalCost = r6(s.byType[e.callType].totalCost + e.cost.total);
    sessionMap.set(e.sessionId, s);
  }

  return {
    aggregate,
    // Newest session first
    recentSessions: Array.from(sessionMap.values())
      .sort((a, b) => (b.date > a.date ? 1 : -1))
      .slice(0, 25),
    // Most recent 50 individual call entries
    recentEntries: entries.slice(-50),
  };
}

// Per-case cost rollup from recent in-memory entries (merge-plan Phase 2).
// Joined against the usage meter's credited cases by /api/usage/summary so a
// diagnosis credit reconciles with what it actually cost us. Rolling window:
// entries cap at MAX_ENTRIES, so old cases age out of this map (flagged in
// the summary's reconciliation note). Old entries without caseId are skipped.
export function costByCaseId() {
  const map = {};
  for (const e of entries) {
    if (!e.caseId) continue;
    const c = map[e.caseId] ?? { calls: 0, totalCost: 0, byType: {} };
    c.calls++;
    c.totalCost = r6(c.totalCost + e.cost.total);
    if (!c.byType[e.callType]) c.byType[e.callType] = { calls: 0, totalCost: 0 };
    c.byType[e.callType].calls++;
    c.byType[e.callType].totalCost = r6(c.byType[e.callType].totalCost + e.cost.total);
    map[e.caseId] = c;
  }
  return map;
}

// Surface key stats for the existing startup rollup log in index.js.
export function costStats() {
  return {
    todayCalls:      aggregate.today.calls,
    todayCost:       aggregate.today.totalCost,
    todaySessions:   aggregate.today.sessions,
    allTimeCalls:    aggregate.allTime.calls,
    allTimeCost:     aggregate.allTime.totalCost,
  };
}

// Force flush (e.g. on process exit). Normally happens automatically.
export function flushNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  _persist();
}

// ---- Internal helpers ----

function _updateAggregate(entry, today) {
  const weekStart = weekStartUtc();

  // Reset today bucket if the date rolled over
  if (aggregate.today.date !== today) {
    aggregate.today = { date: today, calls: 0, sessions: 0, totalCost: 0, byType: {} };
    todaySessionIds = new Set();
  }
  // Reset week bucket if the week rolled over
  if (aggregate.week.weekStart !== weekStart) {
    aggregate.week = { weekStart, calls: 0, sessions: 0, totalCost: 0, byType: {} };
    weekSessionIds = new Set();
  }

  const cost = entry.cost.total;
  const type = entry.callType;

  // Today
  aggregate.today.calls++;
  aggregate.today.totalCost = r6(aggregate.today.totalCost + cost);
  if (entry.sessionId) {
    todaySessionIds.add(entry.sessionId);
    aggregate.today.sessions = todaySessionIds.size;
  }
  _bumpType(aggregate.today.byType, type, cost);

  // Week
  aggregate.week.calls++;
  aggregate.week.totalCost = r6(aggregate.week.totalCost + cost);
  if (entry.sessionId) {
    weekSessionIds.add(entry.sessionId);
    aggregate.week.sessions = weekSessionIds.size;
  }
  _bumpType(aggregate.week.byType, type, cost);

  // All-time
  aggregate.allTime.calls++;
  aggregate.allTime.totalCost = r6(aggregate.allTime.totalCost + cost);
  _bumpType(aggregate.allTime.byType, type, cost);

  // Per-model
  const m = entry.model;
  if (!aggregate.byModel[m]) {
    aggregate.byModel[m] = {
      calls: 0,
      inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0,
      inputCost: 0, cacheWriteCost: 0, cacheReadCost: 0, outputCost: 0, totalCost: 0,
    };
  }
  const bm = aggregate.byModel[m];
  bm.calls++;
  bm.inputTokens      += entry.tokens.input;
  bm.cacheWriteTokens += entry.tokens.cacheWrite;
  bm.cacheReadTokens  += entry.tokens.cacheRead;
  bm.outputTokens     += entry.tokens.output;
  bm.inputCost      = r6(bm.inputCost      + entry.cost.input);
  bm.cacheWriteCost = r6(bm.cacheWriteCost + entry.cost.cacheWrite);
  bm.cacheReadCost  = r6(bm.cacheReadCost  + entry.cost.cacheRead);
  bm.outputCost     = r6(bm.outputCost     + entry.cost.output);
  bm.totalCost      = r6(bm.totalCost      + cost);

  // All-time cost breakdown (for optimisation analysis)
  aggregate.costBreakdown.inputCost      = r6(aggregate.costBreakdown.inputCost      + entry.cost.input);
  aggregate.costBreakdown.cacheWriteCost = r6(aggregate.costBreakdown.cacheWriteCost + entry.cost.cacheWrite);
  aggregate.costBreakdown.cacheReadCost  = r6(aggregate.costBreakdown.cacheReadCost  + entry.cost.cacheRead);
  aggregate.costBreakdown.outputCost     = r6(aggregate.costBreakdown.outputCost     + entry.cost.output);

  aggregate.updatedAt = new Date().toISOString();
}

function _bumpType(byType, type, cost) {
  if (!byType[type]) byType[type] = { calls: 0, totalCost: 0 };
  byType[type].calls++;
  byType[type].totalCost = r6(byType[type].totalCost + cost);
}

function _scheduleFlush() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    _persist();
  }, SAVE_DELAY_MS);
}

function _persist() {
  if (!dirty) return;
  dirty = false;
  try {
    fs.writeFileSync(ENTRIES_PATH,   JSON.stringify({ entries }, null, 2));
    fs.writeFileSync(AGGREGATE_PATH, JSON.stringify(aggregate,  null, 2));
  } catch (err) {
    console.warn("[cost-logger] failed to save cost data:", err.message);
  }
}

function blankAggregate() {
  const today     = todayUtc();
  const weekStart = weekStartUtc();
  return {
    updatedAt: new Date().toISOString(),
    today:    { date: today,     calls: 0, sessions: 0, totalCost: 0, byType: {} },
    week:     { weekStart,       calls: 0, sessions: 0, totalCost: 0, byType: {} },
    allTime:  {                  calls: 0,              totalCost: 0, byType: {} },
    byModel:  {},
    costBreakdown: { inputCost: 0, cacheWriteCost: 0, cacheReadCost: 0, outputCost: 0 },
  };
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

function weekStartUtc() {
  const d   = new Date();
  const day = d.getUTCDay(); // 0 = Sunday
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day))
    .toISOString()
    .slice(0, 10);
}

function r6(n) {
  return Math.round(n * 1_000_000) / 1_000_000;
}
