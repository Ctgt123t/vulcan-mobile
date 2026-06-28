import fs from "node:fs";
import { cacheFile } from "./cacheDir.js";
import * as supabaseSpecs from "./specProviders/supabaseSpecs.js";

// ----------------------------------------------------------------------------
// Vehicle spec retrieval — second layer of the hybrid retrieval system (the
// first is DTC lookup in dtcDatabase.js + dtcFallback.js).
//
// Goal: route factual vehicle-spec questions ("how many quarts of oil",
// "lug nut torque", "what coolant") to authoritative data providers BEFORE
// they reach Claude, so we don't pay for hallucinated values. Each spec
// lookup that comes from an external provider is cached forever (the data
// doesn't change for a given vehicle).
//
// Flow:
//   1. detectSpecIntent(text) → { specType, params? } | null
//   2. lookupSpec(vehicle, specType, params) tries the provider chain in
//      order, returns the first hit (with caching at the orchestrator level
//      so providers stay simple).
//   3. formatSpecAnswer(specType, result) renders the response as plain
//      text suitable for the Ask Vulcan chat bubble.
//
// Providers must export:
//   id: string
//   configured(): boolean
//   async lookup(vehicle, specType, params, fetcher): { data, source } | null
//
// Adding a new provider: drop a file in ./specProviders, import it here,
// append to PROVIDERS. Order = priority.
// ----------------------------------------------------------------------------

const CACHE_PATH = cacheFile("vehicleSpecCache.json");

// Spec types the orchestrator understands. Each is a stable key used in
// caching, metrics, and provider capability lists.
export const SPEC_TYPES = Object.freeze({
  OIL: "oil",
  COOLANT: "coolant",
  TRANSMISSION_FLUID: "transmissionFluid",
  BRAKE_FLUID: "brakeFluid",
  POWER_STEERING_FLUID: "powerSteeringFluid",
  TORQUE: "torque",
  BATTERY: "battery",
  MAINTENANCE_INTERVAL: "maintenanceInterval",
  // Fuse-box assignments (Fix 2). NOT a fluid spec_type — retrieved from
  // component_fact via lookupFuse, NOT lookupSpec/SPEC_TYPE_MAP. Tool-only (it
  // is NOT in SPEC_PATTERNS, so it never routes through the fluid fast-path).
  FUSE: "fuse",
});

// ----------- Cache ----------------------------------------------------------

let cache = {
  entries: {},
  hits: 0,
  misses: 0,
  providerCalls: 0,
  providerErrors: 0,
  // Spec questions that fell through to Claude with NO structured vehicle to
  // look up against (open-ended Ask Vulcan). Previously these bypassed the
  // provider chain entirely and were counted nowhere — this makes the true
  // Claude-spec-answer rate visible alongside the provider `misses`.
  noVehicleFallthroughs: 0,
};

try {
  if (fs.existsSync(CACHE_PATH)) {
    const raw = fs.readFileSync(CACHE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    cache = {
      entries: parsed.entries ?? {},
      hits: parsed.hits ?? 0,
      misses: parsed.misses ?? 0,
      providerCalls: parsed.providerCalls ?? 0,
      providerErrors: parsed.providerErrors ?? 0,
      noVehicleFallthroughs: parsed.noVehicleFallthroughs ?? 0,
    };
    const total = cache.hits + cache.misses;
    const hitRate = total > 0 ? `${((cache.hits / total) * 100).toFixed(1)}%` : "n/a";
    console.log(
      `[vehicleSpecs] loaded ${Object.keys(cache.entries).length} cached spec entries ` +
        `(hits=${cache.hits}, misses=${cache.misses}, hitRate=${hitRate}, providerCalls=${cache.providerCalls})`,
    );
  }
} catch (err) {
  console.warn(
    "[vehicleSpecs] failed to load vehicleSpecCache.json, starting fresh:",
    err.message,
  );
}

function persist() {
  try {
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
  } catch (err) {
    console.warn(
      "[vehicleSpecs] failed to write vehicleSpecCache.json:",
      err.message,
    );
  }
}

// ----------- Pattern detection ---------------------------------------------

// Each entry: regex → spec type. First match wins. Order matters — more
// specific patterns before more general ones (e.g. "transmission fluid"
// before bare "fluid").
const SPEC_PATTERNS = [
  { specType: SPEC_TYPES.TRANSMISSION_FLUID, match: /\b(transmission|atf)\s+fluid\b|\bwhat\s+(atf|transmission)\b/i },
  { specType: SPEC_TYPES.BRAKE_FLUID, match: /\bbrake\s+fluid\b|\bdot\s*[345]\b/i },
  { specType: SPEC_TYPES.POWER_STEERING_FLUID, match: /\bpower\s+steering\s+fluid\b/i },
  { specType: SPEC_TYPES.COOLANT, match: /\bcoolant\b|\bantifreeze\b/i },
  { specType: SPEC_TYPES.OIL, match: /\b(how\s+much|how\s+many\s+quarts\s+of|what)\s+oil\b|\boil\s+(capacity|type|spec|weight|viscosity|grade)\b|\bwhat\s+(weight|viscosity|grade)\s+of\s+oil\b/i },
  { specType: SPEC_TYPES.TORQUE, match: /\btorque\s+spec(s|ification)?\b|\b(lug\s*nut|drain\s*(plug|bolt)|spark\s*plug|head\s*bolt|axle\s*nut)\s+torque\b|\btorque\s+(for|on|of)\b/i },
  { specType: SPEC_TYPES.BATTERY, match: /\bbattery\s+(size|group|cca|amperage|spec)\b|\bgroup\s+\d{2,3}\s+battery\b|\bbci\s+group\b/i },
  { specType: SPEC_TYPES.MAINTENANCE_INTERVAL, match: /\bmaintenance\s+(schedule|interval)\b|\bservice\s+interval\b|\bwhen\s+to\s+change\b|\bevery\s+\d+\s*(miles|km|kilometers|months|years)\b/i },
];

export function detectSpecIntent(text) {
  if (typeof text !== "string" || text.length === 0) return null;
  for (const { specType, match } of SPEC_PATTERNS) {
    if (match.test(text)) return { specType };
  }
  return null;
}

// Diagnose mode: find every spec category the complaint touches on so we
// can proactively inject verified values into Claude's context. Returns an
// array of spec types (possibly empty).
export function detectAllSpecIntents(text) {
  if (typeof text !== "string" || text.length === 0) return [];
  const hits = [];
  for (const { specType, match } of SPEC_PATTERNS) {
    if (match.test(text)) hits.push(specType);
  }
  return hits;
}

// Broad, deliberately over-inclusive spec detector used ONLY for the
// cache-exclusion decision — NOT for guardrail injection (that stays
// detectSpecIntent / SPEC_PATTERNS, which is intentionally narrow so the
// caution preamble only fires on clear spec asks).
//
// The risk profile is inverted from the guardrail detector. A spec answer
// must always be generated live and guarded — never frozen for 30 days in
// the response cache — because the cache survives prompt/model changes. The
// brittle narrowness of detectSpecIntent is exactly what let "oil change
// specs" slip past it and get cached as generic Q&A (the 2026-06 stale-cache
// bug). So here, when in doubt, treat it as a spec and DO NOT cache: a false
// positive costs one uncached answer (cheap); a false negative freezes a
// stale, unguarded spec (the bug). This is now load-bearing, not cosmetic.
// Component-identity-shaped questions (filter type/location, part numbers).
// Shared by two consumers with the SAME inverted risk profile as the
// spec-shaped set below:
//   - isSpecShapedQuestion folds these in, so component questions are
//     cache-excluded (a hallucinated component fact must not be frozen for
//     30 days — pre-widening, "where is the fuel filter" was cacheable).
//   - isComponentShapedQuestion gates the componentFact demand log in
//     /api/ask (spec_miss rows with spec_type "componentFact"), since
//     component questions never reach lookupSpec and would otherwise be
//     invisible to the extraction queue.
const COMPONENT_SHAPED_PATTERNS = [
  /\bfilter\b/i,
  /\bpart\s*(number|#)s?\b/i,
];

export function isComponentShapedQuestion(text) {
  if (typeof text !== "string" || text.length === 0) return false;
  return COMPONENT_SHAPED_PATTERNS.some((re) => re.test(text));
}

const SPEC_SHAPED_PATTERNS = [
  ...COMPONENT_SHAPED_PATTERNS,
  /\bspec(s|ification|ifications)?\b/i,
  /\bcapacit/i, // capacity / capacities
  /\btorque\b/i,
  /\b(ft|foot)[-\s.]?lbs?\b|\blb[-\s.]?ft\b|\bnewton[-\s]?met|\bn[-\s.]?m\b/i,
  /\bpsi\b|\bpressure\b|\bkpa\b/i,
  /\bviscosit/i,
  /\b\d{1,2}w[-\s]?\d{2}\b/i, // oil weight: 0w20, 0w-20, 5w30, 10w-40
  /\boil\b|\bcoolant\b|\bantifreeze\b|\bfluid\b|\batf\b|\brefrigerant\b|\br[-\s]?134a\b|\b1234yf\b/i,
  /\bgap\b|\bclearance\b/i,
  /\bfuse\b|\bfuse\s*box\b|\bamperage\b/i, // fuse questions -> never cache (Fix 2)
  /\binterval\b|\bevery\s+\d/i,
  /\btire\s+pressure\b/i,
  /\bgear\s+ratio\b|\bbolt\s+pattern\b/i,
  /\bhow\s+(much|many)\b/i,
  /\bfill\b/i,
];

export function isSpecShapedQuestion(text) {
  if (typeof text !== "string" || text.length === 0) return false;
  // Subsume the narrow guardrail set, then widen.
  if (detectSpecIntent(text)) return true;
  return SPEC_SHAPED_PATTERNS.some((re) => re.test(text));
}

// ----------- Provider orchestration ----------------------------------------

// The Supabase spec DB is now the sole spec data source (Vehicle Finder removed
// — proven a dead end; Open Labor stays disabled/unrouted). The provider shape
// is kept so a future Tier-2 retrieval-grounded provider can slot in here.
const PROVIDERS = [supabaseSpecs];

// Shared fetcher passed into providers so they don't each implement timeouts.
async function fetchWithTimeout(url, options = {}, timeoutMs = 7000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Returns { data, source, fromCache } | null
//
// AIRTIGHT FAIL-SOFT GUARANTEE: this function NEVER throws. It is awaited from
// the Diagnose/Assess proactive-injection paths OUTSIDE their endpoint's inner
// try/catch, so an escaping rejection here would 500 the request. A DB outage,
// a query error, or any unexpected fault must degrade to a clean miss (null) →
// the honest guard-railed Claude fallback. The whole body is wrapped to enforce
// that. DB-down and DB-miss are identical to the caller (differ only in logging).
//
// DB results are NOT written to vehicleSpecCache.json — the DB IS the persistent
// store; double-caching would re-introduce staleness (a re-extraction wouldn't
// surface) for no benefit (DB reads are cheap, no external API cost/latency).
// The hit/miss/error counters are kept for /metrics and the startup rollup.
export async function lookupSpec(vehicle, specType, params = null) {
  try {
    if (!vehicle || !vehicle.year || !vehicle.make || !vehicle.model) {
      return null;
    }

    for (const provider of PROVIDERS) {
      if (!provider.configured()) continue;
      cache.providerCalls++;
      try {
        const result = await provider.lookup(
          vehicle,
          specType,
          params,
          fetchWithTimeout,
        );
        if (result && result.data) {
          cache.hits++;
          persist();
          console.log(
            `[vehicleSpecs] HIT ${specType} for ${vehicle.year} ${vehicle.make} ${vehicle.model} (source=${provider.id})`,
          );
          return { data: result.data, source: provider.id, fromCache: false };
        }
      } catch (err) {
        cache.providerErrors++;
        console.warn(
          `[vehicleSpecs] provider ${provider.id} failed for ${specType}:`,
          err.message,
        );
      }
    }

    cache.misses++;
    persist();
    console.log(
      `[vehicleSpecs] MISS ${specType} for ${vehicle.year} ${vehicle.make} ${vehicle.model} — falling through to Claude`,
    );
    // Demand-ranked extraction queue. Fully fail-soft: recordSpecMiss never
    // throws, and the extra guard here keeps the no-throw guarantee airtight.
    try {
      await supabaseSpecs.recordSpecMiss(vehicle, specType);
    } catch (err) {
      console.warn(`[vehicleSpecs] miss-log unexpected error (continuing): ${err.message}`);
    }
    return null;
  } catch (err) {
    console.warn(
      `[vehicleSpecs] lookupSpec unexpected error for ${specType} (failing soft to miss):`,
      err.message,
    );
    return null;
  }
}

// Demand logging for component-identity questions ("what filter / part
// number"). These never route through lookupSpec (no component entry in the
// spec_lookup enum — deliberate, the component tool path is deferred), so
// without this the extraction queue is blind to component demand. Writes a
// spec_miss row with the sentinel type "componentFact" via the same
// fail-soft queue writer the spec path uses. NEVER throws, NEVER awaited on
// the response path.
export function recordComponentFactMiss(vehicle) {
  try {
    // Fire-and-forget: recordSpecMiss is internally fail-soft (never
    // rejects), the .catch is belt-and-suspenders.
    supabaseSpecs.recordSpecMiss(vehicle, "componentFact").catch(() => {});
  } catch {
    // keep the no-throw guarantee airtight
  }
}

// ----------- Fuse retrieval (component_fact, NOT the fluid path) -------------
//
// Separate from lookupSpec because fuse data is component_fact (not spec) and
// carries a circuit keyword; it does NOT route through provider.lookup /
// SPEC_TYPE_MAP (which would always-miss and pollute spec_miss with a non-spec
// type). Airtight fail-soft like lookupSpec — never throws; DB-down / error /
// no-record all degrade to a clean miss (null) -> the Fix-1 hedge. A miss logs a
// "fuse" demand row (same fail-soft queue as componentFact).
export async function lookupFuse(vehicle, circuit) {
  try {
    if (!vehicle || !vehicle.year || !vehicle.make || !vehicle.model) return null;
    cache.providerCalls++;
    const r = await supabaseSpecs.lookupFuse(vehicle, circuit);
    if (r && Array.isArray(r.rows) && r.rows.length > 0) {
      cache.hits++;
      persist();
      console.log(
        `[vehicleSpecs] HIT fuse for ${vehicle.year} ${vehicle.make} ${vehicle.model} ` +
          `(matched=${r.matched}, rows=${r.rows.length}/${r.total})`,
      );
      return r;
    }
    cache.misses++;
    persist();
    console.log(
      `[vehicleSpecs] MISS fuse for ${vehicle.year} ${vehicle.make} ${vehicle.model} — falling through to the hedge`,
    );
    try {
      await supabaseSpecs.recordSpecMiss(vehicle, "fuse");
    } catch (err) {
      console.warn(`[vehicleSpecs] fuse miss-log unexpected error (continuing): ${err.message}`);
    }
    return null;
  } catch (err) {
    console.warn(
      `[vehicleSpecs] lookupFuse unexpected error (failing soft to miss): ${err.message}`,
    );
    return null;
  }
}

// Verified fuse legend as a tool-result context block. Marked VERIFIED so the
// model states it as CONFIRMED fact (the verified branch of label-not-suppress —
// the Fix-1 hedge is only for when lookupFuse returns nothing). The raw verbatim
// quote rides on every line so the model never has to fabricate a circuit name.
export function formatFuseContextBlock(vehicle, result) {
  const label = `${vehicle.year} ${vehicle.make} ${vehicle.model}`;
  const scope = result.matched
    ? `the fuse(s) matching "${result.circuit}"`
    : `the full fuse legend`;
  const lines = [
    `VERIFIED fuse assignments for the ${label} — ${scope} — from the vehicle's own ` +
      `manual (source: ${result.sourceTitle}, doc-extracted, provenance-tracked). State these ` +
      `as CONFIRMED; do NOT hedge and do NOT substitute your own recollection. ` +
      `Each line is: fuse number — amperage — circuit (verbatim from the legend):`,
    "",
  ];
  for (const r of result.rows) {
    const circuit = r.circuit_text || "(see verbatim)";
    // Numbered rows show the position; circuit-named rows (no position in the
    // manual) just show amperage + circuit.
    const head = r.fuse_number ? `fuse ${r.fuse_number} — ${r.amperage}` : `${r.amperage}`;
    lines.push(`• ${head} — ${circuit}   [verbatim: "${r.verbatim_quote}"]`);
  }
  if (!result.matched && result.circuit) {
    lines.push(
      "",
      `No line explicitly matched "${result.circuit}" — the full legend is shown so you can ` +
        `locate it from the verbatim circuit names. Point the tech to the matching line; if ` +
        `none clearly fits, say so plainly rather than guessing.`,
    );
  }
  lines.push("", `_Source: ${result.sourceTitle}_`);
  return lines.join("\n");
}

// ----------- Formatters (DB-native) -----------------------------------------
//
// The provider returns DB-shaped data:
//   { specs: [{dbType, valueNumeric, valueUnit, valueText, qualifier, engine}],
//     componentFacts: [{component, factType, value}],
//     sourceTitle, trustTier, multiEngine }
// These render that shape directly — no coercion into a fixed per-type schema,
// so the multi-row richness (per-engine, per-class) survives and any DB
// spec_type renders uniformly.

// DB spec_type -> human label. Includes the widened Batch A types so a future
// intent-widening pass renders them with no formatter change.
const DB_TYPE_LABELS = {
  oil_capacity: "Oil capacity", oil_viscosity: "Oil viscosity", oil_type: "Oil type",
  coolant_capacity: "Coolant capacity", coolant_type: "Coolant",
  transmission_fluid_type: "Transmission fluid", transmission_fluid_capacity: "Transmission fluid capacity",
  brake_fluid_type: "Brake fluid", power_steering_fluid_type: "Power steering fluid",
  torque: "Torque", battery_group: "Battery group", maintenance_interval: "Maintenance",
  fuel_capacity: "Fuel capacity", axle_fluid_type: "Axle fluid", axle_fluid_capacity: "Axle fluid capacity",
  transfer_case_fluid_type: "Transfer case fluid", transfer_case_fluid_capacity: "Transfer case fluid capacity",
  gvwr: "GVWR", gawr: "GAWR", idle_speed: "Idle speed",
  refrigerant_type: "Refrigerant", refrigerant_capacity: "Refrigerant capacity",
  spark_plug_gap: "Spark plug gap", tire_pressure: "Tire pressure", other: "Spec",
};

function fmtSpecValue(s) {
  return s.valueNumeric != null
    ? `${s.valueNumeric}${s.valueUnit ? " " + s.valueUnit : ""}`
    : (s.valueText ?? "");
}

// One bullet line for a spec row. `showEngine` labels the engine when the result
// spans multiple engines, so the tech can pick their own.
function specLine(s, showEngine) {
  const label = DB_TYPE_LABELS[s.dbType] || s.dbType;
  let line = `• ${label}: ${fmtSpecValue(s)}`;
  if (s.qualifier) line += ` (${s.qualifier})`;
  if (showEngine && s.engine) line += ` — ${s.engine}`;
  return line;
}

function componentFactLine(f) {
  const ft = f.factType && f.factType !== "type"
    ? " " + String(f.factType).replace(/_/g, " ")
    : "";
  return `• ${f.component}${ft}: ${f.value}`;
}

// Ask Vulcan direct answer. Seamless on a hit — NO verified/unverified badge,
// just a clean spec card with a source footer.
export function formatSpecAnswer(specType, result, vehicle) {
  const d = result.data;
  const engLabel = !d.multiEngine && vehicle.engineType ? ` · ${vehicle.engineType}` : "";
  const lines = [`**${vehicle.year} ${vehicle.make} ${vehicle.model}${engLabel}**`, ""];
  for (const s of d.specs) lines.push(specLine(s, d.multiEngine));
  if (d.componentFacts && d.componentFacts.length) {
    lines.push("");
    for (const f of d.componentFacts) lines.push(componentFactLine(f));
  }
  lines.push("", `_Source: ${d.sourceTitle}_`);
  return lines.join("\n");
}

// Same data as a system-prompt context block for Diagnose / Assess — Claude
// reads it as "verified specs, prefer these over your own recollection".
export function formatSpecContextBlock(entries) {
  if (!entries.length) return "";
  const lines = [
    "Verified vehicle specs retrieved from the Vulcan spec database (doc-extracted, provenance-tracked). Use these values exactly — do not substitute your own recollection:",
    "",
  ];
  for (const e of entries) {
    const d = e.data;
    lines.push(`[${e.specType}] (source: ${d.sourceTitle})`);
    for (const s of d.specs) lines.push(specLine(s, true));
    if (d.componentFacts) for (const f of d.componentFacts) lines.push(componentFactLine(f));
    lines.push("");
  }
  return lines.join("\n");
}

// ----------- No-vehicle spec telemetry --------------------------------------

// Record a spec-intent question that reached Claude without a structured
// vehicle (so no provider lookup was possible). Lightweight telemetry that
// keeps the count visible at /metrics so the no-vehicle path isn't a
// measurement blind spot. (The old SPEC_CAUTION_PREAMBLE that this used to
// pair with is retired — the hedge now lives in the spec_lookup tool-miss
// result text + the APP_CONTEXT factory-spec rule.)
export function recordNoVehicleSpecFallthrough() {
  cache.noVehicleFallthroughs++;
  persist();
}

// ----------- Metrics --------------------------------------------------------

export function vehicleSpecsStats() {
  return {
    entries: Object.keys(cache.entries).length,
    hits: cache.hits,
    misses: cache.misses,
    providerCalls: cache.providerCalls,
    providerErrors: cache.providerErrors,
    noVehicleFallthroughs: cache.noVehicleFallthroughs,
    providers: PROVIDERS.map((p) => ({
      id: p.id,
      configured: p.configured(),
    })),
  };
}
