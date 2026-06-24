-- 0003_batch_c_spec_types.sql — Batch C: widen the spec_type vocabulary.
--
-- Adds 6 new text-quotable typed spec buckets so richer manual data that today
-- lands in `other` (or isn't captured) gets a real type in a single extraction:
--   towing_capacity, fuel_octane, compression_ratio, displacement,
--   def_type, def_capacity   (the #9 vocab-widening set, minus battery_capacity
--   and firing_order, which were dropped from scope — low owner-manual coverage).
--
-- Bulbs and fuse-assignment tables are NOT here: they are stored in the existing
-- component_fact table (free-text component/fact_type/value_text — designed for
-- exactly "bulb fitment"), so they need NO schema change. Fuse-box LAYOUT
-- diagrams and warning-light symbol glyphs are diagram-bound and DEFERRED (a
-- separate vision-capture track; they also collide with the #7b image-strip).
--
-- ADDITIVE + REVERSIBLE + READ-SAFE:
--   * This is a pure CHECK-widening — it only ADDS allowed values, so NO existing
--     spec row can violate it; safe to apply against the populated live DB (unlike
--     a NOT NULL add). The migrate runner wraps the file in a single transaction.
--   * The fail-soft read path (specProviders/supabaseSpecs.js) only queries the
--     specific spec_types in its SPEC_TYPE_MAP; these new types are not mapped
--     yet (intent-widening is a deliberate follow-on), so they are never selected
--     and CANNOT break existing reads. The `other`-needs-a-label CHECK and the
--     audit-column NOT NULLs from 0002 are untouched.
--   * Down-migration: recreate spec_spec_type_check WITHOUT the 6 new values
--     (the inverse of the block below). Standard CHECK-change caveat — if rows of
--     the new types already exist, they must be relabeled/removed first, else the
--     recreate fails; that is expected and intentional (don't silently orphan
--     typed data).
--
-- The existing constraint is the inline-auto-named spec_spec_type_check
-- (recreated by 0002). Drop + recreate with the full set.

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
    -- Batch A additions (0002)
    'fuel_capacity',
    'axle_fluid_type', 'axle_fluid_capacity',
    'transfer_case_fluid_type', 'transfer_case_fluid_capacity',
    'gvwr', 'gawr', 'idle_speed',
    -- Batch C additions (0003)
    'towing_capacity', 'fuel_octane', 'compression_ratio',
    'displacement', 'def_type', 'def_capacity',
    'other'
  ));
