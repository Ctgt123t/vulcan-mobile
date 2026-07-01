// ============================================================================
// Usage meter — the metering foundation (Ask+Diagnose merge plan, Phase 2).
//
// Records the BILLABLE UNIT the founder locked: one flat "diagnosis credit"
// minted at the escalation event (a diagnosis starting — today, intake submit
// on the phone; in the merged shell, the "Diagnose this" escalation). Pre-
// escalation Ask turns stay light/free via the existing zero-cost fast-paths
// and are NOT metered here. Credit WEIGHTS / pricing tiers are a later
// business exercise — this module is the event log + rollup they will read.
//
// The metering key is the CASE ID (phone-generated, one per diagnosis).
// Deliberately NOT sessionId: the diagnostic-logger session is per-OBD2-
// connect and null for disconnected diagnoses (most Ask escalations), so it
// cannot key a billing event. caseId is null only for the rare deliberate
// "continue unsaved" session at the 25-open cap (each such start mints,
// with no idempotence key — honest and bounded).
//
// Mirrors costLogger.js exactly in discipline: JSON files on the Volume
// (CACHE_DIR), debounced fire-and-forget writes, tolerant loads, and NOTHING
// here ever throws into a request path.
//
// Scaling note (same as costLogger): JSON-file storage is fine for a single-
// instance Railway service at current traffic. Billing ENFORCEMENT (per-user
// credit balances) arrives with auth and must live in Postgres — this file
// then becomes the audit log feeding it. Flag before scaling horizontally:
// a second instance would keep a divergent creditedCases map.
// ============================================================================

import fs from "node:fs";
import { cacheFile } from "./cacheDir.js";

const EVENTS_PATH = cacheFile("usageEvents.json");
const AGGREGATE_PATH = cacheFile("usageAggregate.json");
const MAX_EVENTS = 1000; // rolling cap
const MAX_CREDITED_CASES = 2000; // idempotence-map cap (prune oldest mints)
const SAVE_DELAY_MS = 2000;

// ---- In-memory state ----

let events = [];
let aggregate = blankAggregate();
let dirty = false;
let saveTimer = null;

// ---- Startup: load from disk (tolerant — a corrupt file starts fresh) ----

try {
  if (fs.existsSync(EVENTS_PATH)) {
    const raw = JSON.parse(fs.readFileSync(EVENTS_PATH, "utf8"));
    events = Array.isArray(raw.events) ? raw.events : [];
  }
  if (fs.existsSync(AGGREGATE_PATH)) {
    const raw = JSON.parse(fs.readFileSync(AGGREGATE_PATH, "utf8"));
    if (raw && typeof raw === "object" && raw.allTime) aggregate = raw;
  }
  console.log(
    `[usage-meter] loaded: ${events.length} events, ` +
      `allTime credits=${aggregate.allTime.credits}`,
  );
} catch (err) {
  console.warn("[usage-meter] failed to load usage data, starting fresh:", err.message);
  events = [];
  aggregate = blankAggregate();
}

// ---- Public API ----

// Mint one diagnosis credit at the escalation event. Idempotent by caseId (a
// retried/duplicated event for an already-credited case is a no-op). caseId
// null (unsaved session) always mints. Never throws. Returns { minted }.
export function recordDiagnosisStart(meta = {}) {
  try {
    const caseId = typeof meta.caseId === "string" && meta.caseId.length > 0 ? meta.caseId : null;
    const sessionId = typeof meta.sessionId === "string" ? meta.sessionId : null;
    const source = typeof meta.source === "string" && meta.source.length > 0 ? meta.source : "direct";
    const vehicle = sanitizeVehicle(meta.vehicle);

    if (caseId && aggregate.creditedCases[caseId]) {
      console.log(`[usage] diagnosis-start duplicate (already credited): ${caseId}`);
      return { minted: false };
    }

    const now = Date.now();
    const today = todayUtc();
    const event = {
      id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      ts: now,
      date: today,
      type: "diagnosis_start",
      caseId,
      sessionId,
      source,
      vehicle,
    };
    events.push(event);
    if (events.length > MAX_EVENTS) events = events.slice(events.length - MAX_EVENTS);

    _bumpCredit(today, source);
    if (caseId) {
      aggregate.creditedCases[caseId] = { mintedAt: new Date(now).toISOString(), source };
      _pruneCreditedCases();
    }
    aggregate.updatedAt = new Date(now).toISOString();

    console.log(
      `[usage] diagnosis credit minted — case=${caseId ?? "(unsaved)"} source=${source}` +
        (sessionId ? ` [${sessionId}]` : "") +
        ` | today=${aggregate.today.credits} allTime=${aggregate.allTime.credits}`,
    );

    dirty = true;
    _scheduleFlush();
    return { minted: true };
  } catch (err) {
    console.warn("[usage-meter] recordDiagnosisStart failed:", err.message);
    return { minted: false };
  }
}

// Usage rollup + per-credit cost reconciliation. `costByCase` is the
// caseId → {calls, totalCost, byType} map from costLogger.costByCaseId()
// (built from the rolling per-call entries, so old cases age out of the
// join — the reconciliation covers recent history, flagged in `note`).
export function getUsageSummary(costByCase = {}) {
  const creditedIds = Object.keys(aggregate.creditedCases);
  const perCredit = creditedIds
    .map((caseId) => ({
      caseId,
      mintedAt: aggregate.creditedCases[caseId].mintedAt,
      source: aggregate.creditedCases[caseId].source,
      cost: costByCase[caseId] ?? null,
    }))
    .sort((a, b) => (b.mintedAt > a.mintedAt ? 1 : -1))
    .slice(0, 50);

  const joined = perCredit.filter((c) => c.cost);
  const joinedCost = joined.reduce((sum, c) => sum + c.cost.totalCost, 0);

  return {
    aggregate: {
      updatedAt: aggregate.updatedAt,
      today: aggregate.today,
      week: aggregate.week,
      allTime: aggregate.allTime,
      creditedCaseCount: creditedIds.length,
    },
    perCredit,
    reconciliation: {
      creditedCases: creditedIds.length,
      casesWithCostData: joined.length,
      joinedCost: Math.round(joinedCost * 1e6) / 1e6,
      avgCostPerCreditedCase:
        joined.length > 0 ? Math.round((joinedCost / joined.length) * 1e6) / 1e6 : null,
      note:
        "Cost join covers the cost logger's rolling per-call window (last 500 calls); " +
        "older credited cases show cost:null. Credits without cost data can also mean " +
        "the first turn failed after the credit event.",
    },
    recentEvents: events.slice(-50),
  };
}

// ---- Internal helpers ----

function sanitizeVehicle(v) {
  if (!v || typeof v !== "object") return null;
  const s = (x) => (typeof x === "string" ? x : "");
  const out = { year: s(v.year), make: s(v.make), model: s(v.model) };
  return out.year || out.make || out.model ? out : null;
}

function _bumpCredit(today, source) {
  const weekStart = weekStartUtc();
  if (aggregate.today.date !== today) {
    aggregate.today = { date: today, credits: 0, bySource: {} };
  }
  if (aggregate.week.weekStart !== weekStart) {
    aggregate.week = { weekStart, credits: 0, bySource: {} };
  }
  for (const bucket of [aggregate.today, aggregate.week, aggregate.allTime]) {
    bucket.credits++;
    bucket.bySource[source] = (bucket.bySource[source] ?? 0) + 1;
  }
}

function _pruneCreditedCases() {
  const ids = Object.keys(aggregate.creditedCases);
  if (ids.length <= MAX_CREDITED_CASES) return;
  ids
    .sort((a, b) =>
      aggregate.creditedCases[a].mintedAt.localeCompare(aggregate.creditedCases[b].mintedAt),
    )
    .slice(0, ids.length - MAX_CREDITED_CASES)
    .forEach((id) => delete aggregate.creditedCases[id]);
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
    fs.writeFileSync(EVENTS_PATH, JSON.stringify({ events }, null, 2));
    fs.writeFileSync(AGGREGATE_PATH, JSON.stringify(aggregate, null, 2));
  } catch (err) {
    console.warn("[usage-meter] failed to save usage data:", err.message);
  }
}

function blankAggregate() {
  return {
    updatedAt: new Date().toISOString(),
    today: { date: todayUtc(), credits: 0, bySource: {} },
    week: { weekStart: weekStartUtc(), credits: 0, bySource: {} },
    allTime: { credits: 0, bySource: {} },
    creditedCases: {},
  };
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function weekStartUtc() {
  const d = new Date();
  const day = d.getUTCDay();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day))
    .toISOString()
    .slice(0, 10);
}
