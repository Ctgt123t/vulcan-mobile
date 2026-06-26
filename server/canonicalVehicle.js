// ----------------------------------------------------------------------------
// canonicalVehicle.js — §5.B / #4 NHTSA-canonical vehicle-identity resolver.
//
// Fixes the silent false-miss where a make/model written three ways that don't
// join (tech free-text, the manual's title-page spelling at extraction-write,
// the lookup query) reports "no data" on a spec that exists. All three points
// normalize toward NHTSA's canonical spelling via this one resolver.
//
// FAIL-SAFE (load-bearing): if the resolver cannot CONFIDENTLY canonicalize, it
// returns the cleaned input UNCHANGED — it never invents a canonical key that
// would silently mis-join. Because both the stored rows and the query pass
// through the SAME resolver, an unaliased spelling difference becomes an honest
// miss (the existing guard-railed fallback), never a wrong-vehicle hit.
//
// Aliases live in DB tables (make_alias / model_alias — operator-extensible) AND
// in an identical in-code seed here. The in-code seed is always available, so
// resolution works even if the DB is unreachable (same fail-soft posture as the
// read path); ensureCanonicalLoaded() merges the DB rows in opportunistically.
// ----------------------------------------------------------------------------

import { query, isDbReady } from "./db.js";

// In-code seed — MUST mirror the make_alias / model_alias seeds in
// 0004_nhtsa_canonical_identity.sql. Keys are lower-cased free-text spellings;
// values are the canonical NHTSA spelling (post-titleCase, as the VIN path emits
// it) so write-side and read-side join.
const MAKE_ALIAS_SEED = {
  chevy: "Chevrolet", chev: "Chevrolet", chevrolet: "Chevrolet",
  vw: "Volkswagen", volkswagon: "Volkswagen", volkswagen: "Volkswagen",
  mercedes: "Mercedes-Benz", "mercedes benz": "Mercedes-Benz", benz: "Mercedes-Benz",
  bimmer: "BMW", beemer: "BMW",
  caddy: "Cadillac",
  alfa: "Alfa Romeo",
  "range rover": "Land Rover", landrover: "Land Rover",
  chrysler: "Chrysler",
};
const MODEL_ALIAS_SEED = {
  f150: "F-150", "f-150": "F-150",
  f250: "F-250", "f-250": "F-250",
  f350: "F-350", "f-350": "F-350",
  crv: "CR-V", "cr-v": "CR-V",
};

// Live maps — seeded in-code immediately (sync usable), augmented from the DB
// tables by ensureCanonicalLoaded() (best-effort, cached).
const makeAlias = new Map(Object.entries(MAKE_ALIAS_SEED));
const modelAlias = new Map(Object.entries(MODEL_ALIAS_SEED));

let dbLoaded = false;
let loadingPromise = null;

// Best-effort one-time merge of the DB alias tables on top of the in-code seed.
// Never throws; on any failure the in-code seed remains authoritative.
export async function ensureCanonicalLoaded() {
  if (dbLoaded) return;
  if (loadingPromise) return loadingPromise;
  loadingPromise = (async () => {
    if (!isDbReady()) return; // DB down -> seeds only (retry on a later call)
    try {
      const [ma, moa] = await Promise.all([
        query("select alias, canonical_make from make_alias"),
        query("select alias, canonical_model from model_alias"),
      ]);
      for (const r of ma.rows) makeAlias.set(String(r.alias).toLowerCase(), r.canonical_make);
      for (const r of moa.rows) modelAlias.set(String(r.alias).toLowerCase(), r.canonical_model);
      dbLoaded = true; // only mark loaded on success; a DB blip retries next call
    } catch (err) {
      console.warn(`[canonical] alias-table load failed (using in-code seed): ${err.message}`);
    } finally {
      loadingPromise = null;
    }
  })();
  return loadingPromise;
}

function clean(s) {
  return String(s ?? "").trim().replace(/\s+/g, " ");
}

// Free-text make -> canonical NHTSA spelling. Alias hit -> canonical; otherwise
// the cleaned input is returned UNCHANGED (fail-safe; the join lower()s both
// sides, so an already-canonical make matches regardless of casing).
export function canonicalizeMake(raw) {
  const c = clean(raw);
  if (!c) return c;
  return makeAlias.get(c.toLowerCase()) ?? c;
}

// Free-text model -> canonical spelling (punctuation/spacing variants only;
// deliberately conservative — no hyphen-stripping that could merge distinct
// models). Fail-safe passthrough otherwise.
export function normalizeModel(raw) {
  const c = clean(raw);
  if (!c) return c;
  return modelAlias.get(c.toLowerCase()) ?? c;
}

// Returns a shallow copy of the vehicle with make/model canonicalized. Leaves
// year/engine/etc. untouched — §5.A's engine-level variant resolution is
// unchanged; 5.B only fixes name-matching.
export function canonicalizeVehicle(v) {
  if (!v || typeof v !== "object") return v;
  return { ...v, make: canonicalizeMake(v.make), model: normalizeModel(v.model) };
}
