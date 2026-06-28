-- 0006_batch_e_spec_types.sql — Batch E: widen spec_type for the REMAINING numeric `other` families.
--
-- After Batch D (0005), 190 NUMERIC rows remained in the labeled-`other` bucket. Batch E adds
-- real types for 4 more numeric families (value already in value_numeric — re-keyed in place,
-- no re-extraction; see the Phase-1 re-key after this migration), and folds 4 other clusters
-- into EXISTING types (towing_capacity / torque / displacement / tire_pressure) — those need
-- NO new type, so they are not added here.
--
-- New types (this migration):
--   cargo_load_limit         (roof rack / toolbox / ladder rack / tie-down / bed-anchor / etc.
--                             cargo & accessory load-weight limits; printed unit, not kg-canon)
--   vehicle_capacity_weight  (door-sticker payload; printed unit)
--   oil_low_to_full          (dipstick low→full add quantity; small volume)
--   low_fuel_warning_level   (fuel remaining when the low-fuel light triggers)
--
-- validateSpec + the emit_extracted_specs enum + the prompt were widened to match, so FUTURE
-- extractions type these directly.
--
-- ADDITIVE + REVERSIBLE + READ-SAFE (identical posture to 0003/0005): pure CHECK-widening; the
-- fail-soft read path only queries its SPEC_TYPE_MAP (these 4 aren't mapped) so reads can't
-- break. Down-migration: recreate spec_spec_type_check WITHOUT the 4 new values; because they
-- did not exist before Batch E, every row carrying one IS the Phase-1 re-key set, reversed by
--   update spec set spec_type='other' where spec_type in
--     ('cargo_load_limit','vehicle_capacity_weight','oil_low_to_full','low_fuel_warning_level');
-- The FOLD-into-existing clusters are reversed separately by the captured row-ids recorded in
-- 0006_batch_e_folds.reversal.json (label-based reversal is unsafe — a genuine torque row
-- already has value_text 'lug bolt torque', which a fold-reversal regex would wrongly catch).

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
    -- Batch D additions (0005)
    'gcwr', 'dimension', 'ac_compressor_oil_capacity',
    'washer_fluid_capacity', 'trailer_tongue_weight',
    -- Batch E additions (0006) — remaining numeric `other` families
    'cargo_load_limit', 'vehicle_capacity_weight',
    'oil_low_to_full', 'low_fuel_warning_level',
    'other'
  ));
