-- 0001_init.sql — Unified vehicle-data layer: foundational schema.
--
-- Tables: source, vehicle_variant, spec, component_fact, spec_miss.
-- Every spec and component_fact carries a NOT NULL source_id FK so provenance
-- rides on every fact. Controlled-vocabulary columns are enforced with CHECK
-- constraints seeded with a starter set; widen them in a later migration as
-- the extraction pipeline (deferred) defines new values.
--
-- This migration creates schema only. It does NOT migrate any existing JSON
-- cache data — that migration is deferred.

-- ---------------------------------------------------------------------------
-- source — provenance for every fact
-- ---------------------------------------------------------------------------
create table if not exists source (
  id           bigint generated always as identity primary key,
  source_type  text not null
    check (source_type in (
      'oem_service_manual', 'oem_owner_manual', 'tsb', 'recall',
      'manufacturer_api', 'third_party_api', 'community', 'user_provided', 'other'
    )),
  title        text,
  url_or_ref   text,
  publisher    text,
  retrieved_at timestamptz,
  license      text,
  -- trust_tier: 1 = OEM authoritative … 5 = unverified community.
  trust_tier   smallint not null check (trust_tier between 1 and 5),
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- vehicle_variant — keyed on mechanical configuration
--
-- Discriminator columns are NOT NULL DEFAULT '' so the granular UNIQUE
-- constraint behaves deterministically (Postgres treats NULLs as distinct,
-- which would otherwise allow duplicate logical rows).
-- ---------------------------------------------------------------------------
create table if not exists vehicle_variant (
  id                bigint generated always as identity primary key,
  year              smallint not null,
  make              text not null,
  model             text not null,
  series_trim       text not null default '',
  engine_code       text not null default '',
  engine_descriptor text not null default '',
  drivetrain        text not null default '',
  market            text not null default '',
  created_at        timestamptz not null default now(),
  constraint vehicle_variant_unique_config unique
    (year, make, model, series_trim, engine_code, engine_descriptor, drivetrain, market)
);

-- ---------------------------------------------------------------------------
-- spec — typed numeric/textual specifications
-- ---------------------------------------------------------------------------
create table if not exists spec (
  id                 bigint generated always as identity primary key,
  vehicle_variant_id bigint not null references vehicle_variant(id) on delete cascade,
  spec_type          text not null
    check (spec_type in (
      'oil_capacity', 'oil_viscosity', 'oil_type',
      'coolant_capacity', 'coolant_type',
      'transmission_fluid_type', 'transmission_fluid_capacity',
      'brake_fluid_type', 'power_steering_fluid_type',
      'torque', 'tire_pressure', 'spark_plug_gap',
      'battery_group', 'maintenance_interval',
      'refrigerant_type', 'refrigerant_capacity', 'other'
    )),
  value_numeric      double precision,
  value_unit         text,
  value_text         text,
  qualifier          text,                 -- e.g. 'with filter', 'severe service'
  confidence         numeric(3,2) check (confidence is null or (confidence >= 0 and confidence <= 1)),
  source_id          bigint not null references source(id),
  extracted_at       timestamptz not null default now()
);

create index if not exists spec_variant_type_idx on spec (vehicle_variant_id, spec_type);
create index if not exists spec_source_idx on spec (source_id);

-- ---------------------------------------------------------------------------
-- component_fact — non-numeric component facts (filter type, bulb fitment, …)
-- ---------------------------------------------------------------------------
create table if not exists component_fact (
  id                 bigint generated always as identity primary key,
  vehicle_variant_id bigint not null references vehicle_variant(id) on delete cascade,
  component          text not null,        -- e.g. 'oil_filter'
  fact_type          text not null,        -- e.g. 'type', 'part_number'
  value_text         text not null,
  source_id          bigint not null references source(id),
  extracted_at       timestamptz not null default now()
);

create index if not exists component_fact_variant_idx
  on component_fact (vehicle_variant_id, component, fact_type);
create index if not exists component_fact_source_idx on component_fact (source_id);

-- ---------------------------------------------------------------------------
-- spec_miss — log of spec queries we could not answer from the data layer.
-- vehicle_variant_id is nullable because a queried vehicle may not resolve to
-- a known variant; query_vehicle preserves the raw queried context either way.
-- ---------------------------------------------------------------------------
create table if not exists spec_miss (
  id                 bigint generated always as identity primary key,
  vehicle_variant_id bigint references vehicle_variant(id) on delete set null,
  query_vehicle      jsonb,
  spec_type          text not null,
  asked_count        integer not null default 1,
  last_asked_at      timestamptz not null default now(),
  status             text not null default 'open'
    check (status in ('open', 'sourced', 'wontfix', 'duplicate'))
);

create index if not exists spec_miss_status_idx on spec_miss (status, last_asked_at);
