-- 0005_batch_d_spec_types.sql — Batch D: widen spec_type for the NUMERIC `other`-bucket families.
--
-- Run-1's feed left 1,073 rows in the labeled-`other` bucket. 593 are NUMERIC (the value is
-- in value_numeric); this migration adds real types for the 5 recurring numeric families so
-- those rows can be re-keyed IN PLACE (no re-extraction — see the Phase-1 re-key that follows
-- this migration), and so FUTURE extractions type them directly (validateSpec + the
-- emit_extracted_specs enum were widened to match):
--   gcwr                        (gross combined weight rating; parallels gvwr/gawr)
--   dimension                   (family: wheelbase / overall length·width·height / tread /
--                                track / ground clearance — measurement+config stays in
--                                value_text; value in value_numeric)
--   ac_compressor_oil_capacity  (A/C refrigerant compressor oil amount)
--   washer_fluid_capacity       (windshield-washer reservoir capacity)
--   trailer_tongue_weight       (max trailer tongue/nose/kingpin weight; distinct from
--                                towing_capacity)
--
-- The 480 TEXTUAL `other` rows (firing_order, engine descriptors, spark-plug identity, fuel
-- type, wheel/tire size, lug-nut size) are DEFERRED to a Phase-2 quote-parser pass: their
-- value lives ONLY in verbatim_quote, so a bare re-key would not make them queryable. Their
-- types are intentionally NOT added here.
--
-- ADDITIVE + REVERSIBLE + READ-SAFE (identical posture to 0003):
--   * Pure CHECK-widening — only ADDS allowed values, so NO existing spec row can violate it;
--     safe against the populated live DB. The migrate runner wraps this in one transaction.
--   * The fail-soft read path (specProviders/supabaseSpecs.js) only queries the spec_types in
--     its SPEC_TYPE_MAP; these 5 are not mapped (intent-widening is a deliberate later follow-
--     on, a mobile change), so they are never selected and CANNOT break existing reads.
--   * Down-migration: recreate spec_spec_type_check WITHOUT the 5 new values. Because these
--     types did not exist before Batch D, EVERY row carrying one is exactly the Phase-1 re-key
--     set, so the re-key is fully reversed by:
--       update spec set spec_type='other' where spec_type in
--         ('gcwr','dimension','ac_compressor_oil_capacity','washer_fluid_capacity','trailer_tongue_weight');
--     run that first, then the recreate-without succeeds.

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
    -- Batch D additions (0005) — numeric `other` families
    'gcwr', 'dimension', 'ac_compressor_oil_capacity',
    'washer_fluid_capacity', 'trailer_tongue_weight',
    'other'
  ));
