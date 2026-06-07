-- 0002_widen_specs_and_audit_columns.sql — Batch A schema changes.
--
-- Bundles two changes the first-slice extraction test surfaced:
--   (Item 2) Widen the spec.spec_type controlled vocabulary so ~30 real specs
--            (fuel-tank capacity, axle/transfer-case fluids, GVWR/axle weights,
--            fast-idle RPM) land in real typed buckets instead of a generic
--            `other`, AND require a descriptive label for anything still typed
--            `other` (so an `other` row can never be a value with no subject —
--            "340 kg" of WHAT).
--   (Item 3) Persist the audit trail (page + verbatim_quote) on every spec and
--            component_fact row. The extractor already captures both; they were
--            being dropped at the INSERT. NOT NULL so "every stored fact carries
--            its provenance quote" is a DB-enforced invariant, not a hope —
--            defense-in-depth behind the extractor's verbatim-quote gate.
--
-- The migrate runner (migrate.js) wraps this whole file in a single
-- begin/commit, so every statement below applies atomically or not at all.
--
-- NOTE — deliberate, documented exception to the "migrations are schema-only"
-- convention established by 0001_init.sql: the block at the TOP performs a
-- one-time, narrowly-scoped (WHERE source_id = 2) deletion of the disposable
-- first-slice PoC rows. This is intentional and safe (see the block comment).
-- Placing it at the top, inside the same transaction as the NOT NULL ADD COLUMNs,
-- makes the ordering trap structurally impossible: the tables are emptied of
-- legacy rows before the NOT NULL columns are added, so the add cannot fail
-- against pre-existing quote-less rows — and if anything errors, the whole file
-- (deletes included) rolls back.

-- ---------------------------------------------------------------------------
-- (1) One-time removal of the first-slice PoC data (source_id = 2).
--
-- These 72 spec + 48 component_fact rows were written by the extraction PoC
-- BEFORE the audit columns existed and BEFORE the widened vocab — so they have
-- no persisted page/verbatim_quote to back-fill (the extraction output was never
-- dumped) and their `other`-bucket rows would violate the new label CHECK below.
-- They are disposable: the very next step after this migration is to re-run the
-- full Sierra manual through the updated (trimmed + widened + audited) pipeline,
-- which regenerates this exact data with superior typing and a full audit trail.
--
-- Order matters: spec and component_fact reference source(id) with no ON DELETE
-- action, so the child rows must go before the source row. (vehicle_variant
-- rows from the PoC are intentionally left in place — they are harmless config
-- rows and will be reused on re-run via the variant upsert.)
-- ---------------------------------------------------------------------------
delete from component_fact where source_id = 2;
delete from spec           where source_id = 2;
delete from source         where id = 2;

-- ---------------------------------------------------------------------------
-- (2) Widen the spec_type controlled vocabulary (+8 values).
--
-- The existing inline CHECK auto-named `spec_spec_type_check` (verified live via
-- pg_constraint before writing this migration). Drop and recreate it with the
-- starter set PLUS the 8 new plain key/value spec types. (These are simple
-- typed specs only — the richer fuse/bulb/towing-by-axle-ratio schema expansion
-- remains deferred and is NOT introduced here.)
-- ---------------------------------------------------------------------------
alter table spec drop constraint spec_spec_type_check;
alter table spec add constraint spec_spec_type_check
  check (spec_type in (
    -- starter set (0001_init.sql)
    'oil_capacity', 'oil_viscosity', 'oil_type',
    'coolant_capacity', 'coolant_type',
    'transmission_fluid_type', 'transmission_fluid_capacity',
    'brake_fluid_type', 'power_steering_fluid_type',
    'torque', 'tire_pressure', 'spark_plug_gap',
    'battery_group', 'maintenance_interval',
    'refrigerant_type', 'refrigerant_capacity',
    -- Batch A additions
    'fuel_capacity',
    'axle_fluid_type', 'axle_fluid_capacity',
    'transfer_case_fluid_type', 'transfer_case_fluid_capacity',
    'gvwr', 'gawr', 'idle_speed',
    'other'
  ));

-- ---------------------------------------------------------------------------
-- (3) Require a descriptive label for any row still typed `other`.
--
-- For an `other` row, value_text is OVERLOADED: it carries the human descriptor
-- of WHAT the value is (e.g. "front GAWR", "fast-idle RPM"), NOT the value
-- itself (the value lives in value_numeric + value_unit for numeric others).
-- This partial CHECK makes a subject-less `other` row impossible at the DB
-- layer; the extractor's tool schema + validation gate enforce it redundantly.
-- ---------------------------------------------------------------------------
alter table spec add constraint spec_other_requires_label
  check (
    spec_type <> 'other'
    or (value_text is not null and length(btrim(value_text)) > 0)
  );

-- ---------------------------------------------------------------------------
-- (4) Persist the audit trail on every row (NOT NULL).
--
-- Safe to add NOT NULL with no default: the tables were emptied of legacy rows
-- in step (1) above, so there are no existing rows to violate the constraint.
-- All future inserts (the re-run, and the productionized pipeline) must supply
-- both — which the extractor already captures.
-- ---------------------------------------------------------------------------
alter table spec           add column page integer not null;
alter table spec           add column verbatim_quote text not null;
alter table component_fact add column page integer not null;
alter table component_fact add column verbatim_quote text not null;
