-- 0007_phase2_spec_types.sql — Batch D Phase 2: spec_types for the parsed TEXTUAL `other` rows.
--
-- Phase 2 builds deterministic (no-Claude) parsers that lift the real value out of
-- verbatim_quote for the textual `other` rows (value_text held only the LABEL). Most parsed
-- families land in component_fact (engine / spark_plug / transmission / tire / wheel / lug_nut /
-- key_fob / wiper_blade / <filter> — free-form, NO migration, per Batch C bulbs/fuses). Three
-- families land in `spec` and need a real spec_type:
--   firing_order     (cylinder firing sequence, e.g. "1-3-4-2"; value in value_text)
--   fuel_type        (fuel requirement, e.g. "Unleaded gasoline only"; value in value_text)
--   adjustment_spec  (pedal/free-play/clearance measurement; value in value_text, the WHICH in
--                     qualifier) — a family type like `dimension`.
-- All three are TEXTUAL (value in value_text) so they are NOT added to validateSpec NUMERIC_TYPES;
-- the emit_extracted_specs enum + prompt are widened so future extractions type them directly.
--
-- ADDITIVE + REVERSIBLE + READ-SAFE (same posture as 0003/0005/0006): pure CHECK-widening; the
-- fail-soft read path only queries its SPEC_TYPE_MAP (these aren't mapped) so reads can't break.
-- Down-migration: recreate spec_spec_type_check WITHOUT the 3 new values. Phase-2 re-keys are
-- reversed via the captured originals in 0007_phase2_reversal.json (cross-table moves DELETE the
-- source spec row, so label/value-based reversal is impossible — only the captured rows reverse it).

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
    -- Batch A (0002)
    'fuel_capacity',
    'axle_fluid_type', 'axle_fluid_capacity',
    'transfer_case_fluid_type', 'transfer_case_fluid_capacity',
    'gvwr', 'gawr', 'idle_speed',
    -- Batch C (0003)
    'towing_capacity', 'fuel_octane', 'compression_ratio',
    'displacement', 'def_type', 'def_capacity',
    -- Batch D (0005)
    'gcwr', 'dimension', 'ac_compressor_oil_capacity',
    'washer_fluid_capacity', 'trailer_tongue_weight',
    -- Batch E (0006)
    'cargo_load_limit', 'vehicle_capacity_weight',
    'oil_low_to_full', 'low_fuel_warning_level',
    -- Phase 2 (0007) — parsed textual families that land in spec
    'firing_order', 'fuel_type', 'adjustment_spec',
    'other'
  ));
