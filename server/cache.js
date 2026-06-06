import fs from "node:fs";
import { cacheFile } from "./cacheDir.js";

// ----------------------------------------------------------------------------
// Response cache for Ask Vulcan factual answers.
//
// Key  = normalized vehicle + normalized question
// TTL  = 30 days
// Disk = cache.json (gitignored), persisted on every write so cache survives
//        server restarts and Railway redeploys.
//
// Scope guards (enforced by callers, not this module):
//   - Only Ask Vulcan calls — never Diagnose
//   - Only single-turn questions (no conversation context)
//   - Only "factual" questions (capacities, specs, intervals, torque, etc.)
//   - Only when a vehicle context is provided
//
// This keeps us from caching diagnostic reasoning, which depends on running
// conversation context and would poison the cache.
// ----------------------------------------------------------------------------

const CACHE_PATH = cacheFile("cache.json");

const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Cache key version stamp. BUMP THIS BY HAND whenever the Ask Vulcan system
// prompt changes in a way that should invalidate previously-cached answers
// (e.g. a behavioral/guardrail change). The model name is also folded into
// the key (see buildCacheKey), so a model swap auto-invalidates without a
// bump. Both mechanisms turn old-regime entries into cache MISSES so they
// regenerate under the current model+prompt instead of being served stale.
//
// History:
//   v1  (implicit) — unversioned legacy keys "<vehicle>::<question>"
//   v2  — versioned + model-stamped; spec-shaped questions no longer cached
export const CACHE_VERSION = "v2";

let state = {
  hits: 0,
  misses: 0,
  writes: 0,
  entries: {},
};

try {
  if (fs.existsSync(CACHE_PATH)) {
    const raw = fs.readFileSync(CACHE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    state = {
      hits: parsed.hits ?? 0,
      misses: parsed.misses ?? 0,
      writes: parsed.writes ?? 0,
      entries: parsed.entries ?? {},
    };
    console.log(
      `[cache] loaded ${Object.keys(state.entries).length} entries (hits=${state.hits}, misses=${state.misses})`,
    );
  }
} catch (err) {
  console.warn("[cache] failed to load cache.json, starting fresh:", err.message);
}

function persist() {
  try {
    fs.writeFileSync(CACHE_PATH, JSON.stringify(state, null, 2));
  } catch (err) {
    console.warn("[cache] failed to write cache.json:", err.message);
  }
}

function normalizeQuestion(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeVehicle(v) {
  if (!v || typeof v !== "object") return "";
  return [v.year, v.make, v.model, v.engineType]
    .map((x) => String(x ?? "").toLowerCase().trim())
    .join("|");
}

export function buildCacheKey(vehicle, question, model) {
  const m = String(model ?? "").toLowerCase().trim();
  return `${CACHE_VERSION}::${m}::${normalizeVehicle(vehicle)}::${normalizeQuestion(question)}`;
}

// Heuristic: which questions are "factual and vehicle specific" enough to
// be safe to cache for 30 days? Anything that's a spec lookup, capacity,
// interval, torque value, or part type. Diagnostic phrasing ("why does my
// car…", "what's causing…") is intentionally not cached.
const FACTUAL_PATTERNS = [
  /\bcapacit/i, // capacity, capacities
  /\bspec(s|ification)?\b/i,
  /\binterval\b/i,
  /\btorque\b/i,
  /\bgap\b/i, // spark plug gap
  /\bviscosity\b/i,
  /\bweight\b/i,
  /\bsize\b/i,
  /\bpart\s*(number|#)\b/i,
  /\bhow\s+much\s+(oil|coolant|fluid|transmission|brake)\b/i,
  /\bhow\s+many\s+(quarts|liters|ounces|miles|km|kilometers)\b/i,
  /\bwhat\s+(type|kind|weight|viscosity)\s+of\s+(oil|fluid|coolant|transmission)\b/i,
  /\bwhat\s+(oil|coolant|atf|fluid)\b/i,
  /\bfilter\s+(part|number|#)\b/i,
  /\bevery\s+\d+/i, // "every 30000 miles"
];

export function isCacheableQuestion(q) {
  if (typeof q !== "string" || q.length === 0) return false;
  return FACTUAL_PATTERNS.some((re) => re.test(q));
}

export function getCached(key) {
  const entry = state.entries[key];
  if (!entry) {
    state.misses++;
    return null;
  }
  const age = Date.now() - new Date(entry.createdAt).getTime();
  if (age > TTL_MS) {
    delete state.entries[key];
    state.misses++;
    persist();
    return null;
  }
  state.hits++;
  console.log(
    `[cache] HIT key="${key.slice(0, 80)}" totalHits=${state.hits}`,
  );
  persist(); // update hit counter on disk
  return entry.answer;
}

export function setCached(key, vehicle, question, answer) {
  state.entries[key] = {
    vehicle,
    question,
    answer,
    createdAt: new Date().toISOString(),
  };
  state.writes++;
  persist();
  console.log(
    `[cache] STORE key="${key.slice(0, 80)}" totalEntries=${Object.keys(state.entries).length}`,
  );
}

export function cacheStats() {
  return {
    hits: state.hits,
    misses: state.misses,
    writes: state.writes,
    entries: Object.keys(state.entries).length,
  };
}
