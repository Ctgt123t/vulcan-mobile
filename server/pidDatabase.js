import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cacheFile } from "./cacheDir.js";

// ----------------------------------------------------------------------------
// PID (Parameter ID) database — third layer of the hybrid retrieval system.
//
// Two-tier data:
//
//   1. Standard SAE J1979 PIDs — bundled at deploy time as pidStandard.json
//      (sourced from OBDb/SAEJ1979, normalized at integration). 294 signals
//      covering modes 01-09 of the OBD-II spec. Always loaded into memory.
//
//   2. Vehicle-specific PIDs — fetched on-demand from the OBDb GitHub repo
//      for each {make, model}. Filtered by year using the command's
//      `filter.from`/`filter.to` (signals with no filter apply to all years
//      for that model). Results cached forever in pidCache.json on the
//      Railway Volume — vehicle PIDs don't change once published.
//
// Fetch path: https://raw.githubusercontent.com/OBDb/{Make}-{Model}/main/signalsets/v3/default.json
//
// Output shape (per signal):
//   {
//     command: { mode, pid },        // e.g. { mode: "01", pid: "0C" }
//     code: "01 0C",                 // display form
//     id, name, description, path, unit, min, max, suggestedMetric,
//     decode: { length, multiplier, divisor, offset, signed, startBit, enum },
//     yearRange?: { from, to },      // vehicle-specific only
//   }
//
// License: OBDb is CC-BY-SA-4.0. NOTICE file at repo root carries the
// attribution; API responses include a `source` field crediting OBDb.
// ----------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STANDARD_PATH = path.join(__dirname, "pidStandard.json");
const CACHE_PATH = cacheFile("pidCache.json");

// ----------- Standard PID load ---------------------------------------------

let standardSignals = [];
let standardSource = "unknown";
try {
  const parsed = JSON.parse(fs.readFileSync(STANDARD_PATH, "utf8"));
  standardSignals = Array.isArray(parsed.signals) ? parsed.signals : [];
  standardSource = parsed.source ?? "OBDb/SAEJ1979";
  console.log(
    `[pidDatabase] loaded ${standardSignals.length} standard SAE J1979 signals from ${standardSource}`,
  );
} catch (err) {
  console.warn("[pidDatabase] failed to load pidStandard.json:", err.message);
}

// ----------- Vehicle PID cache ---------------------------------------------

// Cache entries are keyed by "{MAKE}-{MODEL}" (normalized) and store the
// full unfiltered signal set + the source repo name. Year filtering happens
// at query time so a single cached entry serves all years.
let cache = {
  entries: {},
  hits: 0,
  misses: 0,
  fetches: 0,
  fetchErrors: 0,
  notFound: 0, // repos that returned 404 — also cached so we don't retry
};

try {
  if (fs.existsSync(CACHE_PATH)) {
    const parsed = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
    cache = {
      entries: parsed.entries ?? {},
      hits: parsed.hits ?? 0,
      misses: parsed.misses ?? 0,
      fetches: parsed.fetches ?? 0,
      fetchErrors: parsed.fetchErrors ?? 0,
      notFound: parsed.notFound ?? 0,
    };
    const total = cache.hits + cache.misses;
    const hitRate = total > 0 ? `${((cache.hits / total) * 100).toFixed(1)}%` : "n/a";
    console.log(
      `[pidDatabase] loaded ${Object.keys(cache.entries).length} cached vehicle PID sets ` +
        `(hits=${cache.hits}, misses=${cache.misses}, hitRate=${hitRate}, fetches=${cache.fetches})`,
    );
  }
} catch (err) {
  console.warn(
    "[pidDatabase] failed to load pidCache.json, starting fresh:",
    err.message,
  );
}

function persist() {
  try {
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
  } catch (err) {
    console.warn("[pidDatabase] failed to write pidCache.json:", err.message);
  }
}

// ----------- OBDb repo resolution + fetch ----------------------------------

// Normalize make/model to OBDb's repo-naming convention.
// "Ford", "F-150" → "Ford-F-150"
// "toyota", "camry" → "Toyota-Camry"
function repoName(make, model) {
  const norm = (s) => String(s ?? "").trim().replace(/\s+/g, "-");
  const titleCase = (s) =>
    s.replace(/(^|-)([a-z])/g, (_, sep, c) => sep + c.toUpperCase());
  const m = titleCase(norm(make).toLowerCase());
  const mo = titleCase(norm(model).toLowerCase());
  if (!m || !mo) return null;
  return `${m}-${mo}`;
}

function cacheKey(make, model) {
  return repoName(make, model);
}

// Fetch raw OBDb data for a vehicle. Returns:
//   { commands: [...] }  on success
//   null                 on 404 (repo doesn't exist for this make/model)
// Throws on transport / 5xx errors so the caller can decide whether to
// cache the miss or retry on the next request.
async function fetchObdbVehicle(make, model) {
  const repo = repoName(make, model);
  if (!repo) return null;
  const url = `https://raw.githubusercontent.com/OBDb/${repo}/main/signalsets/v3/default.json`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  let res;
  try {
    res = await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 404) {
    console.log(`[pidDatabase] OBDb has no repo for ${repo}`);
    return null;
  }
  if (!res.ok) {
    throw new Error(`OBDb fetch ${res.status} for ${repo}`);
  }
  return await res.json();
}

// ----------- Signal normalization ------------------------------------------

function commandCode(cmd) {
  if (!cmd || !cmd.cmd) return null;
  const entries = Object.entries(cmd.cmd);
  if (entries.length === 0) return null;
  const [mode, pid] = entries[0];
  return { mode, pid };
}

// User-facing categories for the PID selection UI. The UI navigates these
// labels in the same order presented here — Engine first, fallback "Other"
// last. Keep the labels stable; clients display them verbatim.
export const PID_CATEGORIES = [
  "Engine",
  "Fuel System",
  "Air/Intake",
  "Oxygen Sensors",
  "Emissions",
  "Speed/Transmission",
  "Electrical",
  "Other",
];

// Categorizer — map an OBDb signal to one of the user-facing categories.
// Strategy: NAME-first because the OBDb `path` field tends to be very
// generic ("Engine.*" covers everything from RPM to MAF to throttle). The
// signal name is specific. We fall back to path-based rules only when the
// name doesn't yield a clear classification.
function categorizeSignal(signal) {
  const path = String(signal.path ?? "");
  const text = `${signal.name ?? ""} ${signal.description ?? ""} ${signal.id ?? ""}`;

  // Name-based rules first — most specific.
  if (/o2 sensor|oxygen sensor|\bho2s\b|wideband|lambda sensor|^o2\b/i.test(text))
    return "Oxygen Sensors";
  if (/catalyst|\begr\b|\bevap\b|particulate|\bdpf\b|\bdef\b|\bscr\b|readiness monitor|misfire monitor|secondary air|nox |fuel evap|warm[- ]?up.*catalyst/i.test(text))
    return "Emissions";
  if (/fuel trim|fuel pressure|fuel level|fuel rail|injector|\bafr\b|\blambda\b|equivalence ratio|commanded.*fuel|fuel temp|fuel system status/i.test(text))
    return "Fuel System";
  if (/\bmaf\b|\bmap\b|intake air|throttle|\bboost\b|barometric|manifold absolute|wastegate|charge air|airflow|air temperature/i.test(text))
    return "Air/Intake";
  if (/vehicle speed|\bgear\b|transmission|gearbox|\btcc\b|torque converter|odometer|\btrip\b|cruise control/i.test(text))
    return "Speed/Transmission";
  if (/battery|module voltage|control module voltage|charging system|alternator|\bvbat\b|\bvbatt\b/i.test(text))
    return "Electrical";
  if (/\brpm\b|engine load|timing advance|coolant temp|oil temp|engine torque|ignition timing|engine speed|engine run time|engine oil/i.test(text))
    return "Engine";

  // Path-based fallback when name is too generic ("Sensor 1", "Status", etc).
  if (/^Fuel/i.test(path)) return "Fuel System";
  if (/^O2|^Oxygen/i.test(path)) return "Oxygen Sensors";
  if (/^Emissions|^EGR|^EVAP|^Catalyst|^DPF|^SCR|^DTCs\.Generic/i.test(path))
    return "Emissions";
  if (/^Intake|^Air|^MAF|^MAP|^Throttle|^Boost|^Turbo/i.test(path))
    return "Air/Intake";
  if (/^Transmission|^Gear|^Speed|^Vehicle|^Trips/i.test(path))
    return "Speed/Transmission";
  if (/^Battery|^Charging|^Electrical|^Control/i.test(path)) return "Electrical";
  if (/^Engine/i.test(path)) return "Engine";

  return "Other";
}

function normalizeSignal(signal, command) {
  const fmt = signal.fmt || {};
  const code = commandCode(command);
  return {
    command: code,
    code: code ? `${code.mode} ${code.pid}` : null,
    id: signal.id ?? null,
    name: signal.name ?? null,
    description: signal.description ?? signal.name ?? null,
    path: signal.path ?? null,
    category: categorizeSignal(signal),
    unit: fmt.unit ?? null,
    min: fmt.min ?? 0,
    max: fmt.max ?? null,
    decode: {
      length: fmt.len ?? null,
      multiplier: fmt.mul ?? null,
      divisor: fmt.div ?? null,
      offset: fmt.add ?? null,
      signed: fmt.sign ?? false,
      startBit: fmt.bix ?? null,
      enum: fmt.map ?? null,
    },
    suggestedMetric: signal.suggestedMetric ?? null,
    hidden: signal.hidden ?? false,
  };
}

// Walks the raw OBDb response, flattens commands → signals, attaches the
// command's year filter (when present) to each signal so query-time
// filtering is a simple per-signal check.
function flattenCommands(raw) {
  if (!raw || !Array.isArray(raw.commands)) return [];
  const out = [];
  for (const command of raw.commands) {
    const yearRange = command.filter
      ? { from: command.filter.from ?? null, to: command.filter.to ?? null }
      : null;
    for (const signal of command.signals || []) {
      const normalized = normalizeSignal(signal, command);
      if (yearRange) normalized.yearRange = yearRange;
      out.push(normalized);
    }
  }
  return out;
}

// ----------- Year filtering -------------------------------------------------

function signalAppliesToYear(signal, year) {
  if (!signal.yearRange) return true;
  const { from, to } = signal.yearRange;
  const y = Number(year);
  if (!Number.isFinite(y)) return true;
  if (from != null && y < from) return false;
  if (to != null && y > to) return false;
  return true;
}

// ----------- Public API -----------------------------------------------------

export function getStandardPids() {
  return {
    source: standardSource,
    license: "CC-BY-SA-4.0",
    count: standardSignals.length,
    categories: PID_CATEGORIES,
    signals: standardSignals,
  };
}

// Returns { make, model, year, source, count, signals } where signals is the
// union of standard SAE PIDs and vehicle-specific PIDs filtered by year. If
// OBDb has no data for this make/model, returns the standard set only with
// source flagged "standard-only".
export async function getVehiclePids(make, model, year) {
  const repo = repoName(make, model);
  if (!repo) {
    return null;
  }

  let entry = cache.entries[repo];
  if (entry) {
    cache.hits++;
    persist();
  } else {
    cache.misses++;
    cache.fetches++;
    try {
      const raw = await fetchObdbVehicle(make, model);
      if (raw == null) {
        // Repo doesn't exist — cache the negative result so we don't refetch
        // on every request.
        cache.notFound++;
        entry = { signals: [], notFound: true, fetchedAt: new Date().toISOString() };
        cache.entries[repo] = entry;
      } else {
        const signals = flattenCommands(raw);
        entry = {
          signals,
          notFound: false,
          fetchedAt: new Date().toISOString(),
          source: `OBDb/${repo}`,
        };
        cache.entries[repo] = entry;
        console.log(
          `[pidDatabase] cached ${signals.length} signals for OBDb/${repo}`,
        );
      }
    } catch (err) {
      cache.fetchErrors++;
      persist();
      throw err;
    }
    persist();
  }

  const vehicleSignals = (entry.signals || []).filter((s) =>
    signalAppliesToYear(s, year),
  );

  return {
    make,
    model,
    year: year != null ? Number(year) : null,
    source: entry.notFound ? "standard-only" : entry.source ?? `OBDb/${repo}`,
    license: "CC-BY-SA-4.0",
    standardCount: standardSignals.length,
    vehicleCount: vehicleSignals.length,
    categories: PID_CATEGORIES,
    signals: [...standardSignals, ...vehicleSignals],
  };
}

export function pidStats() {
  return {
    standardSignals: standardSignals.length,
    cachedVehicles: Object.keys(cache.entries).length,
    hits: cache.hits,
    misses: cache.misses,
    fetches: cache.fetches,
    fetchErrors: cache.fetchErrors,
    notFound: cache.notFound,
  };
}
