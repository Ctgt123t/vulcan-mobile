// ----------------------------------------------------------------------------
// Supabase spec-DB provider — the live read path into the unified vehicle-data
// layer (built in Batch A). Replaces Vehicle Finder as the spec data source.
//
// READ-ONLY on spec / component_fact (extraction is the only writer — STRICT
// STORE). The only thing this module WRITES is spec_miss (the demand-ranked
// extraction queue), and that write is fully fail-soft.
//
// FAIL-SOFT IS THE LOAD-BEARING PROPERTY: every public function here returns a
// miss (null) / no-ops rather than throwing, on a DB outage OR any query error.
// DB-down and DB-miss are indistinguishable to the caller — both fall through
// to the honest guard-railed Claude answer. The DB is an enhancement, never a
// hard dependency.
//
// Vehicle resolution (salvaged lesson from vehicleFinder.js, adapted to the DB's
// actual shape): variants key on (year, make, model) + engine_descriptor only
// (series_trim/etc. are empty in practice); the truck CLASS (1500/2500) lives in
// each spec's `qualifier`, not the variant key. So:
//   - resolve on (year, make, model), match the right engine by token overlap
//     (the granular-key lesson — never serve a wrong engine's spec),
//   - NEVER fold series into the model (that was a Vehicle-Finder quirk; the DB
//     stores "Sierra" bare) — series is a row-level label/disambiguator instead,
//   - on ambiguity, render ALL matching rows labeled by qualifier rather than
//     guess one (honest, never a wrong-record substitution).
//
// Cross-source precedence (strategy §6.C): when more than one source covers a
// vehicle, the highest trust_tier (then newest) wins the served value; a losing
// source whose value CONFLICTS is logged for review. This is general — it is the
// same mechanism that will arbitrate a manufacturer doc vs. a retrieved web page
// later, not a one-off dedup for the identical test sources.
// ----------------------------------------------------------------------------

import { query, isDbReady } from "../db.js";
import {
  ensureCanonicalLoaded,
  canonicalizeMake,
  normalizeModel,
} from "../canonicalVehicle.js";
import { shapeFuseRows, filterByCircuit, FUSE_ROW_CAP } from "../fuseLegend.js";

export const id = "supabase-spec-db";

// Always "configured" — the readiness check is per-call (isDbReady) so a DB blip
// degrades to a miss instead of disabling the provider for the process lifetime.
export function configured() {
  return true;
}

// App spec-intent type (vehicleSpecs.SPEC_TYPES) -> the DB spec_type vocab it
// maps to. Only these 8 app intents are wired this pass; the widened DB types
// (fuel/axle/transfer-case/gvwr/gawr/idle/spark-gap/refrigerant/tire) have no
// app intent yet — deferred to the intent-widening follow-up.
const SPEC_TYPE_MAP = {
  oil: ["oil_capacity", "oil_viscosity", "oil_type"],
  coolant: ["coolant_capacity", "coolant_type"],
  transmissionFluid: ["transmission_fluid_type", "transmission_fluid_capacity"],
  brakeFluid: ["brake_fluid_type"],
  powerSteeringFluid: ["power_steering_fluid_type"],
  torque: ["torque"],
  battery: ["battery_group"],
  maintenanceInterval: ["maintenance_interval"],
};

// component_fact rows to fold into an app spec answer (the approved
// "oil-filter-fold"). Conservative: only the oil → oil-filter mapping this pass.
const COMPONENT_PATTERNS = {
  oil: [/oil\s*filter/i],
};

// ---- Engine matching (salvaged from vehicleFinder.engineTokens) ------------

function engineTokens(s) {
  const out = new Set();
  if (typeof s !== "string") return out;
  const lower = s.toLowerCase();
  const disp = lower.match(/\d\.\d\s*l?/g); // displacement: 5.3l, 6.0, ...
  if (disp) for (const d of disp) out.add(d.replace(/\s/g, "").replace(/l$/, ""));
  for (const kw of ["v6", "v8", "v10", "v12", "i3", "i4", "i5", "i6", "h4", "h6",
                    "ecoboost", "turbo", "diesel", "hybrid", "phev", "ev",
                    "powerstroke", "duramax", "cummins", "hemi", "vtec"]) {
    if (lower.includes(kw)) out.add(kw);
  }
  return out;
}

// True if a spec row's engine_descriptor applies to the vehicle's engine.
//   - empty descriptor = vehicle-wide spec -> always applies
//   - unknown vehicle engine -> don't exclude (render all, honest)
//   - both have a displacement -> require a shared displacement (the strong
//     signal); else fall back to any shared token.
function engineMatches(rowEngine, vehicleEngineType) {
  if (!rowEngine || rowEngine.trim() === "") return true;
  const want = engineTokens(vehicleEngineType);
  if (want.size === 0) return true;
  const have = engineTokens(rowEngine);
  const wantDisp = [...want].filter((t) => /^\d\.\d$/.test(t));
  const haveDisp = [...have].filter((t) => /^\d\.\d$/.test(t));
  if (wantDisp.length && haveDisp.length) {
    return wantDisp.some((d) => haveDisp.includes(d));
  }
  for (const t of want) if (have.has(t)) return true;
  return false;
}

// Normalize an engine descriptor to its token signature so different spellings
// of the same engine ("5.3L V8" / "5.3L V8 (LMG)") group together.
function normEngine(s) {
  return [...engineTokens(s)].sort().join("+");
}

function normValue(r) {
  return [
    r.value_numeric ?? "",
    String(r.value_unit ?? "").toLowerCase().trim(),
    String(r.value_text ?? "").toLowerCase().trim(),
  ].join("|");
}

function displayVal(r) {
  if (r.value_numeric != null) {
    return `${r.value_numeric}${r.value_unit ? " " + r.value_unit : ""}`;
  }
  return r.value_text ?? "?";
}

// ---- Source precedence + conflict logging (§6.C) ---------------------------

// Highest trust_tier wins, then newest created_at.
function pickWinningSource(rows) {
  const bySrc = new Map();
  for (const r of rows) {
    if (!bySrc.has(r.source_id)) {
      bySrc.set(r.source_id, {
        source_id: r.source_id,
        trust_tier: r.trust_tier,
        created_at: r.created_at,
        title: r.title,
      });
    }
  }
  return [...bySrc.values()].sort(
    (a, b) =>
      b.trust_tier - a.trust_tier ||
      new Date(b.created_at) - new Date(a.created_at),
  )[0];
}

// Log (do not store — no conflict table this pass) any case where a losing
// source disagrees with the winning source on the same logical spec. Silent on
// agreement (so the identical test sources 3/4/5 produce zero noise).
function detectAndLogConflicts(rows, winning, vehicle) {
  const groups = new Map();
  for (const r of rows) {
    const k = `${r.spec_type}|${normEngine(r.engine_descriptor)}|${String(r.qualifier ?? "").toLowerCase().trim()}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  for (const [k, grp] of groups) {
    const winRow = grp.find((r) => r.source_id === winning.source_id);
    if (!winRow) continue;
    const winVal = normValue(winRow);
    const conflicting = grp.filter(
      (r) => r.source_id !== winning.source_id && normValue(r) !== winVal,
    );
    if (conflicting.length) {
      const others = [...new Set(conflicting.map((r) => `src${r.source_id}(tier${r.trust_tier}):${displayVal(r)}`))].join(", ");
      console.warn(
        `[supabase-spec] CONFLICT ${vehicle.year} ${vehicle.make} ${vehicle.model} [${k}] — ` +
          `serving src${winning.source_id}(tier${winning.trust_tier}):${displayVal(winRow)}; ` +
          `losing: ${others} (logged for review, §6.C)`,
      );
    }
  }
}

// Collapse rows identical in (spec_type, qualifier, value) across engine
// spellings; keep rows that differ by qualifier (e.g. 1500 vs 2500) separate so
// they render as distinct labeled lines.
function dedupByValue(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const k = `${r.spec_type}|${String(r.qualifier ?? "").toLowerCase().trim()}|${normValue(r)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

// ---- Main lookup -----------------------------------------------------------

export async function lookup(vehicle, appSpecType, _params, _fetcher) {
  if (!isDbReady()) return null; // DB down -> miss (honest fallback)
  const dbTypes = SPEC_TYPE_MAP[appSpecType];
  if (!dbTypes) return null; // app intent not mapped to the DB vocab

  // §5.B — canonicalize the query's make/model toward the NHTSA spelling stored
  // rows are keyed under, so "Chevy"/"F150"/etc. join instead of false-missing.
  // Fail-safe: an unaliased name passes through unchanged (honest miss, never a
  // wrong-vehicle match). ensureCanonicalLoaded merges the DB alias tables on
  // top of the in-code seed (best-effort).
  await ensureCanonicalLoaded();
  const cMake = canonicalizeMake(vehicle.make);
  const cModel = normalizeModel(vehicle.model);

  try {
    const specRes = await query(
      `select s.spec_type, s.value_numeric, s.value_unit, s.value_text, s.qualifier,
              vv.engine_descriptor, s.source_id, src.trust_tier, src.created_at, src.title
         from spec s
         join vehicle_variant vv on vv.id = s.vehicle_variant_id
         join source src on src.id = s.source_id
        where vv.year = $1
          and lower(vv.make) = lower($2)
          and lower(vv.model) = lower($3)
          and s.spec_type = any($4)`,
      [vehicle.year, cMake, cModel, dbTypes],
    );
    if (specRes.rows.length === 0) return null; // no data -> miss

    const winning = pickWinningSource(specRes.rows);
    detectAndLogConflicts(specRes.rows, winning, vehicle);

    let rows = specRes.rows
      .filter((r) => r.source_id === winning.source_id)
      .filter((r) => engineMatches(r.engine_descriptor, vehicle.engineType));
    rows = dedupByValue(rows);
    if (rows.length === 0) return null; // engine-filtered to nothing -> miss

    // Component facts (oil-filter-fold), same winning source + engine filter.
    let componentFacts = [];
    const patterns = COMPONENT_PATTERNS[appSpecType];
    if (patterns) {
      const cfRes = await query(
        `select cf.component, cf.fact_type, cf.value_text, vv.engine_descriptor
           from component_fact cf
           join vehicle_variant vv on vv.id = cf.vehicle_variant_id
          where vv.year = $1
            and lower(vv.make) = lower($2)
            and lower(vv.model) = lower($3)
            and cf.source_id = $4`,
        [vehicle.year, cMake, cModel, winning.source_id],
      );
      const seenF = new Set();
      for (const r of cfRes.rows) {
        if (!patterns.some((re) => re.test(r.component))) continue;
        if (!engineMatches(r.engine_descriptor, vehicle.engineType)) continue;
        const k = `${r.component}|${r.fact_type}|${String(r.value_text).toLowerCase().trim()}`;
        if (seenF.has(k)) continue;
        seenF.add(k);
        componentFacts.push({ component: r.component, factType: r.fact_type, value: r.value_text });
      }
    }

    const data = {
      specs: rows.map((r) => ({
        dbType: r.spec_type,
        valueNumeric: r.value_numeric,
        valueUnit: r.value_unit,
        valueText: r.value_text,
        qualifier: r.qualifier,
        engine: r.engine_descriptor,
      })),
      componentFacts,
      sourceTitle: winning.title,
      trustTier: winning.trust_tier,
      // true when the served rows span >1 engine (so the renderer labels each
      // line with its engine to disambiguate).
      multiEngine: new Set(rows.map((r) => normEngine(r.engine_descriptor))).size > 1,
    };
    return { data };
  } catch (err) {
    console.warn(
      `[supabase-spec] lookup failed for ${appSpecType} (treating as miss): ${err.message}`,
    );
    return null;
  }
}

// ---- Fuse-assignment retrieval (component_fact, fact_type='amperage') -------
//
// Fuse data is component_fact, NOT spec, so it does NOT route through lookup() /
// SPEC_TYPE_MAP. Pulls the vehicle's fuse legend YEAR-EXACT (across all engine
// variants of the year/make/model, deduped — a fuse box is vehicle-wide, not
// per-engine) and, when a circuit keyword is given, filters to the matching
// fuse(s) via the synonym expansion in fuseLegend.js. Same canonicalization +
// airtight fail-soft posture as lookup(): returns null on DB-down / query error
// / no-record (the caller then hedges; never fabricates). Returns:
//   { rows:[{fuse_number, amperage, circuit_text, verbatim_quote}], matched,
//     circuit, sourceTitle, trustTier, total } | null
export async function lookupFuse(vehicle, circuit) {
  if (!isDbReady()) return null;
  await ensureCanonicalLoaded();
  const cMake = canonicalizeMake(vehicle.make);
  const cModel = normalizeModel(vehicle.model);
  try {
    const res = await query(
      `select cf.component, cf.value_text, cf.verbatim_quote,
              src.title as source_title, src.trust_tier
         from component_fact cf
         join vehicle_variant vv on vv.id = cf.vehicle_variant_id
         join source src on src.id = cf.source_id
        where vv.year = $1
          and lower(vv.make) = lower($2)
          and lower(vv.model) = lower($3)
          and cf.fact_type = 'amperage'
        order by cf.component`,
      [vehicle.year, cMake, cModel],
    );
    if (res.rows.length === 0) return null; // no fuse legend for this vehicle

    const all = shapeFuseRows(res.rows);
    const { rows, matched } = filterByCircuit(all, circuit);
    return {
      rows: rows.slice(0, FUSE_ROW_CAP),
      matched,
      circuit: String(circuit ?? "").trim(),
      sourceTitle: res.rows[0].source_title,
      trustTier: res.rows[0].trust_tier,
      total: all.length,
    };
  } catch (err) {
    console.warn(
      `[supabase-spec] fuse lookup failed (treating as miss): ${err.message}`,
    );
    return null;
  }
}

// ---- Miss-log (spec_miss) — fail-soft, never throws -------------------------

// Best-effort increment-on-repeat / insert-on-first. No UNIQUE key on spec_miss
// (approved: option (a), no migration this pass), so this is a non-atomic
// SELECT->UPDATE/INSERT; a rare race could double-count, which is harmless for a
// demand-ranking log. A write failure must NEVER affect the user-facing answer.
export async function recordSpecMiss(vehicle, appSpecType) {
  if (!isDbReady()) return; // DB down -> the answer already fell through; skip
  // Only log well-formed vehicles — skip malformed input so the demand queue
  // doesn't accrue junk rows (e.g. make/model that aren't real strings).
  const mk = String(vehicle?.make ?? "").trim();
  const md = String(vehicle?.model ?? "").trim();
  if (!mk || !md || mk === "[object Object]" || md === "[object Object]") return;
  // Canonicalize so the demand queue groups by the canonical name (a "Chevy" and
  // a "Chevrolet" miss are the same demand). Fail-safe passthrough preserved.
  const cMake = canonicalizeMake(vehicle.make);
  const cModel = normalizeModel(vehicle.model);
  try {
    const key = [vehicle.year, cMake, cModel, vehicle.series, vehicle.engineType]
      .map((x) => String(x ?? "").toLowerCase().trim())
      .join("|");
    const found = await query(
      `select id from spec_miss where spec_type = $1 and query_vehicle->>'key' = $2 limit 1`,
      [appSpecType, key],
    );
    if (found.rows.length > 0) {
      await query(
        `update spec_miss set asked_count = asked_count + 1, last_asked_at = now() where id = $1`,
        [found.rows[0].id],
      );
    } else {
      await query(
        `insert into spec_miss (spec_type, query_vehicle, asked_count, last_asked_at, status)
         values ($1, $2, 1, now(), 'open')`,
        [
          appSpecType,
          JSON.stringify({
            key,
            year: vehicle.year,
            make: cMake,
            model: cModel,
            series: vehicle.series ?? null,
            engineType: vehicle.engineType ?? null,
          }),
        ],
      );
    }
  } catch (err) {
    console.warn(`[supabase-spec] miss-log write failed (continuing): ${err.message}`);
  }
}
