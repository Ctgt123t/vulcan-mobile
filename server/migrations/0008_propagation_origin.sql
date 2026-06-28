-- 0008_propagation_origin.sql — spec propagation: the hidden extracted-vs-inferred marker.
--
-- Run-2 spec propagation fills missing same-generation/same-engine vehicles' STABLE specs from
-- already-extracted sibling vehicles (allowlist-only: oil/fuel/trans/transfer-case capacities,
-- viscosity, spark-plug gap, towing, torque, dimensions — measured stable across same-gen pairs;
-- fluid spec-strings + compression/displacement/etc. are NEVER propagated). Each propagated row
-- is stored directly and presented to the tech normally, but carries a hidden marker so the
-- system can (a) never propagate volatile specs, (b) overwrite an inferred placeholder when a
-- real manual is later extracted, (c) audit.
--
--   origin                    'extracted' (a real manual for THIS vehicle) | 'inferred' (copied
--                             from a same-gen sibling). Existing rows default 'extracted' (correct).
--   inferred_from_variant_id  the anchor variant the value was copied from (audit + overwrite).
--                             NULL for extracted rows. The inferred row's source_id still points at
--                             the anchor's real manual (honest provenance chain).
--
-- ADDITIVE + REVERSIBLE + READ-SAFE: new nullable/defaulted columns only — no existing row changes
-- value; the fail-soft read path ignores `origin` (presents inferred specs normally; the marker is
-- invisible in normal use, only a provenance-specific query checks it). Down-migration: drop the
-- four columns. NO-CLOBBER is enforced by the propagation engine, not the schema: it only INSERTs
-- inferred rows for (year,make,model) that have NO extracted variant — an extracted row is never
-- touched, and an inferred row never overwrites an extracted one (one-directional).

alter table spec add column if not exists origin text not null default 'extracted'
  check (origin in ('extracted', 'inferred'));
alter table spec add column if not exists inferred_from_variant_id bigint
  references vehicle_variant(id) on delete set null;

alter table component_fact add column if not exists origin text not null default 'extracted'
  check (origin in ('extracted', 'inferred'));
alter table component_fact add column if not exists inferred_from_variant_id bigint
  references vehicle_variant(id) on delete set null;

create index if not exists spec_origin_idx on spec (origin);
create index if not exists component_fact_origin_idx on component_fact (origin);
