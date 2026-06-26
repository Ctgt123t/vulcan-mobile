-- 0004_nhtsa_canonical_identity.sql — §5.B / #4 NHTSA-canonical vehicle naming.
--
-- The false-miss problem: a make/model written three ways that don't join
-- (tech free-text "Chevy", the manual's title-page spelling at extraction-write,
-- the lookup query) silently misses specs that exist. Fix: normalize all three
-- toward NHTSA's canonical spelling. This migration stands up the naming
-- authority + the alias tables; the resolver (server/canonicalVehicle.js) and
-- the import script (scripts/importNhtsaMakes.js) use them.
--
-- ADDITIVE + REVERSIBLE + READ-SAFE:
--   * Three NEW tables only (nhtsa_make, make_alias, model_alias) — drop cleanly
--     to reverse. No existing column/constraint is altered.
--   * The re-key UPDATE at the bottom is idempotent and a NO-OP on the current
--     data (every existing vehicle_variant is already canonical: GMC / Ford /
--     Subaru, Sierra / F-150 / Impreza). It only canonicalizes a row whose
--     make/model is a known alias, so it cannot create a UNIQUE-config collision
--     on today's rows. No re-extraction — rows are relabeled in place.
--   * The fail-soft live read path is unaffected: the resolver degrades to an
--     in-code alias seed if these tables are unreadable, and an unresolved name
--     falls through to the existing honest miss (never a wrong-vehicle match).
--
-- The aliases live in TABLES (operator-extensible without a code deploy); the
-- resolver also carries an identical in-code seed as the fail-soft fallback.

-- nhtsa_make — the canonical make-spelling authority + the #14 picker source.
-- Populated from NHTSA's public GetAllMakes by scripts/importNhtsaMakes.js
-- (not seeded here — it's a ~10k-row network fetch, re-runnable).
create table if not exists nhtsa_make (
  make_id   integer primary key,
  make_name text not null
);
create index if not exists nhtsa_make_lower_idx on nhtsa_make (lower(make_name));

-- make_alias / model_alias — free-text spelling (lower-cased) -> canonical.
create table if not exists make_alias (
  alias          text primary key,
  canonical_make text not null
);
create table if not exists model_alias (
  alias           text primary key,
  canonical_model text not null
);

-- Curated make aliases (NHTSA does not publish aliases). Keys are lower-cased.
-- Canonical values match the post-titleCase NHTSA spelling the VIN path emits
-- (e.g. "MERCEDES-BENZ" -> "Mercedes-Benz"), so write-side and read-side join.
insert into make_alias (alias, canonical_make) values
  ('chevy', 'Chevrolet'), ('chev', 'Chevrolet'), ('chevrolet', 'Chevrolet'),
  ('vw', 'Volkswagen'), ('volkswagon', 'Volkswagen'),
  ('mercedes', 'Mercedes-Benz'), ('mercedes benz', 'Mercedes-Benz'), ('benz', 'Mercedes-Benz'),
  ('bimmer', 'BMW'), ('beemer', 'BMW'),
  ('caddy', 'Cadillac'),
  ('alfa', 'Alfa Romeo'),
  ('range rover', 'Land Rover'), ('landrover', 'Land Rover'),
  ('chrysler', 'Chrysler'), ('volkswagen', 'Volkswagen')
on conflict (alias) do update set canonical_make = excluded.canonical_make;

-- Small model aliases (deterministic punctuation/spacing variants).
insert into model_alias (alias, canonical_model) values
  ('f150', 'F-150'), ('f-150', 'F-150'),
  ('f250', 'F-250'), ('f-250', 'F-250'),
  ('f350', 'F-350'), ('f-350', 'F-350'),
  ('crv', 'CR-V'), ('cr-v', 'CR-V')
on conflict (alias) do update set canonical_model = excluded.canonical_model;

-- Re-key existing rows to canonical (idempotent; no-op on today's canonical rows).
update vehicle_variant vv
  set make  = coalesce((select canonical_make  from make_alias  where alias = lower(btrim(vv.make))),  vv.make),
      model = coalesce((select canonical_model from model_alias where alias = lower(btrim(vv.model))), vv.model);
