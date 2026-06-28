// ----------------------------------------------------------------------------
// propagateSpecs.js — spec propagation engine (run-2 step 2). Fills missing
// same-generation / same-engine vehicles' STABLE specs from already-extracted
// sibling vehicles. No Claude, no extraction — DB compute only.
//
//   node scripts/propagateSpecs.js            # DRY-RUN (no writes) — the default
//   node scripts/propagateSpecs.js --write    # apply (INSERT inferred rows)
//
// SAFETY (measured in the feasibility study, do not loosen):
//  - ALLOWLIST-ONLY: only spec_types proven stable across >=2 same-gen pairs
//    (physical/mechanical numbers). Fluid spec-strings + compression/displacement/
//    maintenance/octane are the DENYLIST (33-56% agreement = real mid-gen changes).
//    coolant_capacity (68%) and tire_pressure (63%) are EXCLUDED (cautious tier).
//  - GEN-MAP bounds propagation to a single generation (a gen boundary = engine
//    change = stop). vPIC has NO generation field, so this is curated; the 8
//    multi-year platforms are overlap-confirmed.
//  - REACH=2: each inferred value is at most 2 model-years from its real source
//    anchor (within the study's validated same-gen stability span).
//  - NO-CLOBBER: only INSERTs inferred rows for (year,make,model) with NO
//    extracted variant; never touches an extracted row; only sources from
//    origin='extracted' rows (never propagates from a prior inference).
//  - Every inferred row: origin='inferred', inferred_from_variant_id=anchor,
//    source_id + page + verbatim_quote carried from the anchor's real manual.
// ----------------------------------------------------------------------------
import "dotenv/config";
import { pool } from "../db.js";

const WRITE = process.argv.includes("--write");
export const MIN_YEAR = 2013, MAX_YEAR = 2025, REACH = 2;

// Curated generation-map: "Make|Model" -> [[startYear,endYear], ...]. Platform/engine-generation
// SPLITS are separate ranges. Jeep Wrangler 2018 verified JL from the stored manual ("All-New
// Wrangler 2018" cover + 2.0L turbo, JL-only). The 8 multi-year platforms are overlap-confirmed.
export const GEN_MAP = {
  "Buick|Enclave": [[2018, 2024]], "Buick|Encore": [[2013, 2022]], "Buick|Envision": [[2016, 2020], [2021, 2024]],
  "Cadillac|Escalade": [[2015, 2020], [2021, 2024]], "Cadillac|XT5": [[2017, 2023]],
  "Chevrolet|Blazer": [[2019, 2024]], "Chevrolet|Camaro": [[2016, 2024]], "Chevrolet|Colorado": [[2015, 2022], [2023, 2024]],
  "Chevrolet|Cruze": [[2016, 2019]], "Chevrolet|Equinox": [[2018, 2024]], "Chevrolet|Impala": [[2014, 2020]],
  "Chevrolet|Malibu": [[2016, 2024]], "Chevrolet|Silverado": [[2014, 2018], [2019, 2024]], "Chevrolet|Sonic": [[2012, 2020]],
  "Chevrolet|Spark": [[2016, 2022]], "Chevrolet|Suburban": [[2015, 2020], [2021, 2024]], "Chevrolet|Tahoe": [[2015, 2020], [2021, 2024]],
  "Chevrolet|Traverse": [[2018, 2023]], "Chevrolet|Trax": [[2013, 2022]],
  "Chrysler|300": [[2011, 2023]], "Chrysler|Pacifica": [[2017, 2024]],
  "Dodge|Challenger": [[2015, 2023]], "Dodge|Charger": [[2011, 2023]], "Dodge|Durango": [[2014, 2023]],
  "Dodge|Grand Caravan": [[2011, 2020]], "Dodge|Journey": [[2013, 2020]],
  "Ford|Edge": [[2015, 2024]], "Ford|Escape": [[2013, 2019], [2020, 2024]], "Ford|Expedition": [[2018, 2024]],
  "Ford|Explorer": [[2011, 2019], [2020, 2024]], "Ford|F-150": [[2015, 2020], [2021, 2024]], "Ford|Flex": [[2013, 2019]],
  "Ford|Fusion": [[2013, 2020]], "Ford|Mustang": [[2015, 2023]], "Ford|Ranger": [[2019, 2023]], "Ford|Taurus": [[2013, 2019]],
  "Ford|Transit": [[2015, 2023]],
  "GMC|Acadia": [[2017, 2023]], "GMC|Canyon": [[2015, 2022]], "GMC|Sierra": [[2007, 2013], [2014, 2018], [2019, 2024]],
  "GMC|Terrain": [[2018, 2024]], "GMC|Yukon": [[2015, 2020], [2021, 2024]],
  "Honda|Accord": [[2018, 2022]],
  "Jeep|Cherokee": [[2014, 2023]], "Jeep|Compass": [[2017, 2024]], "Jeep|Grand Cherokee": [[2011, 2021], [2022, 2024]],
  "Jeep|Renegade": [[2015, 2023]], "Jeep|Wrangler": [[2018, 2024]],
  "Lincoln|Nautilus": [[2019, 2023]], "Lincoln|Navigator": [[2018, 2024]],
  "Mazda|CX-5": [[2017, 2024]], "Mazda|CX-9": [[2016, 2023]], "Mazda|Mazda3": [[2014, 2018], [2019, 2024]],
  "Nissan|Altima": [[2019, 2024]], "Nissan|Armada": [[2017, 2024]], "Nissan|Frontier": [[2005, 2021], [2022, 2024]],
  "Nissan|Kicks": [[2018, 2023]], "Nissan|Maxima": [[2016, 2023]], "Nissan|Murano": [[2015, 2024]],
  "Nissan|Pathfinder": [[2013, 2020], [2022, 2024]], "Nissan|Rogue": [[2014, 2020], [2021, 2024]],
  "Nissan|Sentra": [[2013, 2019], [2020, 2024]], "Nissan|Titan": [[2016, 2024]],
  "Ram|1500": [[2013, 2018], [2019, 2024]],
  "Subaru|Impreza": [[2017, 2023]], "Subaru|Outback": [[2015, 2019], [2020, 2024]],
  "Toyota|4Runner": [[2010, 2024]], "Toyota|Camry": [[2018, 2024]], "Toyota|Corolla": [[2014, 2019], [2020, 2024]],
  "Toyota|Highlander": [[2014, 2019], [2020, 2024]], "Toyota|Sequoia": [[2008, 2022], [2023, 2024]],
  "Toyota|Sienna": [[2011, 2020], [2021, 2024]],
};

// STRICT allowlist (study-measured stable, >=2 same-gen pairs, physical/mechanical).
export const ALLOWLIST = new Set([
  "oil_capacity", "fuel_capacity", "transmission_fluid_capacity", "oil_viscosity",
  "transfer_case_fluid_capacity", "spark_plug_gap", "towing_capacity", "torque", "dimension",
]);

export function genFor(make, model, year) {
  const ranges = GEN_MAP[make + "|" + model];
  if (!ranges) return null;
  for (const [a, b] of ranges) if (year >= a && year <= b) return [a, b];
  return null;
}
export function engineKey(ed) {
  if (!ed || !ed.trim()) return "*";
  const s = ed.toLowerCase();
  const disp = (s.match(/(\d\.\d)\s*l/) || s.match(/(\d\.\d)/) || [])[1] || "";
  const fi = /ecoboost|gtdi|turbo|tdi/.test(s) ? "t" : "", d = /diesel/.test(s) ? "d" : "", h = /hev|hybrid|phev/.test(s) ? "h" : "";
  return disp ? disp + fi + d + h : "?" + s.replace(/[^a-z0-9]/g, "").slice(0, 8);
}

async function computePlan() {
  const vrows = (await pool.query(`select id vid, year, make, model, engine_descriptor ed from vehicle_variant order by make, model, year`)).rows;
  const specRows = (await pool.query(
    `select vehicle_variant_id vid, spec_type st, coalesce(qualifier,'') q, value_numeric vn, value_unit vu,
            value_text vt, source_id sid, page pg, verbatim_quote vq
     from spec where spec_type = any($1) and origin = 'extracted'`, [[...ALLOWLIST]])).rows;
  const byVid = new Map();
  for (const r of specRows) (byVid.get(r.vid) || byVid.set(r.vid, []).get(r.vid)).push(r);

  const plates = new Map();
  for (const v of vrows) {
    const key = v.make + "|" + v.model, g = genFor(v.make, v.model, v.year);
    if (!plates.has(key)) plates.set(key, { years: new Set(), byGen: new Map(), unbounded: new Set() });
    const P = plates.get(key); P.years.add(v.year);
    if (!g) { P.unbounded.add(v.year); continue; }
    const gk = g.join("-");
    if (!P.byGen.has(gk)) P.byGen.set(gk, { range: g, anchors: [] });
    P.byGen.get(gk).anchors.push({ year: v.year, vid: v.vid, ed: v.ed, ek: engineKey(v.ed), specs: byVid.get(v.vid) || [] });
  }
  const plan = [], unbounded = [];
  for (const [key, P] of plates) {
    const [make, model] = key.split("|");
    if (P.unbounded.size) unbounded.push(`${key}(${[...P.unbounded].join(",")})`);
    for (const [, gen] of P.byGen) {
      const byEk = new Map();
      for (const a of gen.anchors) (byEk.get(a.ek) || byEk.set(a.ek, []).get(a.ek)).push(a);
      for (const [ek, anchors] of byEk) {
        const reach = new Set();
        for (const a of anchors) for (let t = a.year - REACH; t <= a.year + REACH; t++)
          if (t >= gen.range[0] && t <= gen.range[1] && t >= MIN_YEAR && t <= MAX_YEAR) reach.add(t);
        for (const ty of reach) {
          if (P.years.has(ty)) continue; // never infer into a year that has extracted data
          const src = anchors.reduce((b, a) => Math.abs(a.year - ty) < Math.abs(b.year - ty) ? a : b);
          if (src.specs.length) plan.push({ make, model, year: ty, ed: src.ed, ek, fromYear: src.year, fromVid: src.vid, specs: src.specs });
        }
      }
    }
  }
  return { plan, unbounded };
}

async function main() {
  const { plan, unbounded } = await computePlan();
  const newYMM = new Set(plan.map(p => p.make + "|" + p.model + "|" + p.year));
  const totalSpecs = plan.reduce((a, p) => a + p.specs.length, 0);
  const hist = {};
  for (const p of plan) for (const s of p.specs) hist[s.st] = (hist[s.st] || 0) + 1;
  console.log(`[propagate] mode=${WRITE ? "WRITE" : "DRY-RUN"} reach=±${REACH} window=${MIN_YEAR}-${MAX_YEAR} allowlist=${ALLOWLIST.size}`);
  console.log(`[propagate] would create: ${newYMM.size} new YMM entries, ${plan.length} inferred variants, ${totalSpecs} inferred specs`);
  console.log(`[propagate] spec_types: ${Object.entries(hist).sort((a, b) => b[1] - a[1]).map(([k, n]) => k + ":" + n + (ALLOWLIST.has(k) ? "" : " !!NON-ALLOWLIST")).join(" ")}`);
  console.log(`[propagate] unbounded (gap, not propagated): ${unbounded.join(" ") || "none"}`);

  if (!WRITE) { console.log("[propagate] DRY-RUN — no writes. Re-run with --write to apply."); await pool.end(); return; }

  const cl = await pool.connect();
  let varCreated = 0, specWritten = 0;
  const exBefore = (await cl.query("select count(*)::int n from spec where origin='extracted'")).rows[0].n;
  try {
    await cl.query("begin");
    for (const p of plan) {
      const vr = await cl.query(
        `insert into vehicle_variant (year,make,model,series_trim,engine_code,engine_descriptor,drivetrain,market)
         values ($1,$2,$3,'','',$4,'','') on conflict on constraint vehicle_variant_unique_config do nothing returning id`,
        [p.year, p.make, p.model, p.ed]);
      const vid = vr.rows.length ? (varCreated++, vr.rows[0].id)
        : (await cl.query(`select id from vehicle_variant where year=$1 and make=$2 and model=$3 and series_trim='' and engine_code='' and engine_descriptor=$4 and drivetrain='' and market=''`, [p.year, p.make, p.model, p.ed])).rows[0].id;
      for (const s of p.specs) {
        await cl.query(
          `insert into spec (vehicle_variant_id,spec_type,value_numeric,value_unit,value_text,qualifier,confidence,source_id,page,verbatim_quote,origin,inferred_from_variant_id)
           values ($1,$2,$3,$4,$5,$6,null,$7,$8,$9,'inferred',$10)`,
          [vid, s.st, s.vn, s.vu, s.vt, s.q || null, s.sid, s.pg, s.vq, p.fromVid]);
        specWritten++;
      }
    }
    const exAfter = (await cl.query("select count(*)::int n from spec where origin='extracted'")).rows[0].n;
    if (exAfter !== exBefore) throw new Error(`NO-CLOBBER VIOLATED: extracted ${exBefore} -> ${exAfter}`);
    await cl.query("commit");
    console.log(`[propagate] WRITE committed: ${varCreated} variants, ${specWritten} inferred specs. extracted UNTOUCHED (${exBefore}).`);
  } catch (e) { await cl.query("rollback"); console.log("[propagate] ROLLED BACK: " + e.message); }
  finally { cl.release(); await pool.end(); }
}
main().catch(e => { console.error("[propagate] error:", e.message); process.exit(1); });
