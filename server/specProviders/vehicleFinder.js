// ----------------------------------------------------------------------------
// Vehicle Finder API provider (https://vehicle-finder.com).
//
// Two-call flow:
//   1. Resolve vehicle → id via GET /v1/vehicles?year=…&make=…&model=…
//   2. Fetch the resource → GET /v1/vehicles/{id}/{resource}
//
// We cache the vehicle-id lookup in-process for the lifetime of the
// container so spec queries against the same vehicle don't pay the
// resolution cost twice. The vehicleSpecCache.json layer above already
// caches the final spec result across restarts, so this in-memory map is
// just a per-process speedup.
//
// Authentication: X-API-Key header. The key is read from VEHICLE_FINDER_API_KEY
// at module load. If the env var is missing, configured() returns false and
// the orchestrator skips this provider — never throws.
// ----------------------------------------------------------------------------

export const id = "vehicle-finder";

const BASE_URL = "https://api.vehicle-finder.com/v1";
const API_KEY = process.env.VEHICLE_FINDER_API_KEY ?? "";

export function configured() {
  return API_KEY.length > 0;
}

if (!configured()) {
  console.log(
    "[vehicle-finder] no VEHICLE_FINDER_API_KEY set — provider disabled",
  );
} else {
  console.log("[vehicle-finder] provider enabled");
}

// Map orchestrator spec types to this provider's resource paths. Spec types
// without a mapping are NOT supported by Vehicle Finder.
const RESOURCE_BY_SPEC_TYPE = {
  oil: "oil-change",
  torque: "torque-specs",
  maintenanceInterval: "maintenance",
};

// In-memory vehicle resolution cache: normalizedKey → numeric id.
const idCache = new Map();

function normalizeKey(vehicle) {
  return [vehicle.year, vehicle.make, vehicle.model, vehicle.trim ?? ""]
    .map((s) => String(s).toLowerCase().trim())
    .join("|");
}

async function resolveVehicleId(vehicle, fetcher) {
  const key = normalizeKey(vehicle);
  if (idCache.has(key)) return idCache.get(key);

  const params = new URLSearchParams({
    year: String(vehicle.year),
    make: String(vehicle.make),
    model: String(vehicle.model),
  });
  const url = `${BASE_URL}/vehicles?${params.toString()}`;
  console.log(`[vehicle-finder] GET ${url}`);
  const res = await fetcher(url, {
    headers: { "X-API-Key": API_KEY, Accept: "application/json" },
  });
  console.log(`[vehicle-finder] resolve status=${res.status}`);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.log(`[vehicle-finder] resolve error body (truncated): ${text.slice(0, 300)}`);
    throw new Error(`vehicle resolve ${res.status}`);
  }
  const body = await res.json();
  // Log the top-level shape of the response so we can see what keys the API
  // actually returns vs the shapes we tolerate.
  const topKeys = body && typeof body === "object" && !Array.isArray(body)
    ? Object.keys(body).slice(0, 10)
    : Array.isArray(body)
      ? `array(${body.length})`
      : typeof body;
  console.log(`[vehicle-finder] resolve body shape: ${JSON.stringify(topKeys)}`);
  // Vehicle Finder wraps the list under `data`; we also tolerate `results`
  // and bare arrays in case other endpoints differ.
  const rows = Array.isArray(body)
    ? body
    : Array.isArray(body?.data)
      ? body.data
      : Array.isArray(body?.results)
        ? body.results
        : [];
  console.log(`[vehicle-finder] resolve rows=${rows.length}`);
  if (rows.length === 0) return null;

  // Pick the row best matching the vehicle's engineType (e.g. "3.5L V6"
  // → row.engine "3.5L EcoBoost"). The API returns one row per engine
  // option, so picking the right one matters for oil capacity / torque.
  const pick = pickBestRow(rows, vehicle);
  const vid = pick.id ?? pick.vehicle_id ?? pick.vehicleId;
  if (vid == null) {
    console.log(
      `[vehicle-finder] row had no id field — sample row: ${JSON.stringify(pick).slice(0, 300)}`,
    );
    return null;
  }
  console.log(
    `[vehicle-finder] resolved id=${vid} (engine=${pick.engine ?? "?"}, trim=${pick.trim ?? "?"})`,
  );
  idCache.set(key, vid);
  return vid;
}

// Tokens we use to score row.engine against vehicle.engineType: anything
// that looks like a displacement (e.g. "3.5l", "2.7"), or a config tag
// like "v6"/"v8"/"i4"/"ecoboost"/"diesel"/"hybrid".
function engineTokens(s) {
  const out = new Set();
  if (typeof s !== "string") return out;
  const lower = s.toLowerCase();
  // Displacement: 3.5l, 5.0, 6.7l, etc.
  const disp = lower.match(/\d\.\d\s*l?/g);
  if (disp) for (const d of disp) out.add(d.replace(/\s/g, "").replace(/l$/, ""));
  // Config / fuel / variant keywords
  for (const kw of ["v6", "v8", "v10", "v12", "i3", "i4", "i5", "i6", "h4", "h6",
                    "ecoboost", "turbo", "diesel", "hybrid", "phev", "ev",
                    "powerstroke", "duramax", "cummins", "hemi", "vtec"]) {
    if (lower.includes(kw)) out.add(kw);
  }
  return out;
}

function pickBestRow(rows, vehicle) {
  const wantEngine = engineTokens(vehicle.engineType);
  const wantTrim = String(vehicle.trim ?? "").toLowerCase().trim();

  let best = rows[0];
  let bestScore = -1;
  for (const row of rows) {
    let score = 0;
    if (wantEngine.size > 0) {
      const rowEngine = engineTokens(row.engine);
      for (const t of wantEngine) if (rowEngine.has(t)) score += 2;
    }
    if (wantTrim && String(row.trim ?? "").toLowerCase().trim() === wantTrim) {
      score += 3;
    }
    if (score > bestScore) {
      bestScore = score;
      best = row;
    }
  }
  return best;
}

// Provider-agnostic shape mappers — convert Vehicle Finder's response into
// the keys our formatters expect.
function mapOil(raw) {
  if (!raw || typeof raw !== "object") return null;
  const spec = raw.oil_spec ?? {};
  const drain = raw.drain_bolt ?? {};
  const filters = Array.isArray(raw.filters) ? raw.filters : [];

  // Filters land as structured rows so the formatter can present brand,
  // part number, and the OEM flag separately.
  const filterRows = filters.map((f) => ({
    brand: f.brand ?? null,
    partNumber: f.part_number ?? null,
    description: f.description ?? null,
    isOem: Boolean(f.is_oem),
  }));

  // Drain-bolt torque comes back in Nm — convert to ft-lb so the formatter
  // can show both units like real OEM service literature does.
  const torqueNm = typeof drain.torque_nm === "number" ? drain.torque_nm : null;
  const torqueFtLb = torqueNm != null ? +(torqueNm * 0.737562).toFixed(1) : null;

  return {
    viscosity: spec.viscosity ?? null,
    oilType: spec.oil_type ?? null,
    capacityWithFilterQt: spec.capacity_with_filter ?? null,
    capacityWithoutFilterQt: spec.capacity_without_filter ?? null,
    oemSpec: spec.oem_spec ?? null,
    filters: filterRows,
    drainBoltTorqueNm: torqueNm,
    drainBoltTorqueFtLb: torqueFtLb,
    drainBoltSocketSizeMm: drain.socket_size_mm ?? null,
    drainBoltThreadSize: drain.thread_size ?? null,
    drainBoltNotes: drain.notes ?? null,
    sourceConfidence: spec.source ?? null,
    lastVerifiedAt: spec.last_verified_at ?? null,
  };
}

// Verified against /v1/vehicles/{id}/torque-specs: bare array of rows with
// snake_case torque values and a machine-readable `component` slug.
function mapTorque(raw) {
  if (!Array.isArray(raw)) return null;
  return {
    specs: raw.map((row) => ({
      fastener: humanizeComponent(row.component),
      ftLbs: row.torque_ft_lbs ?? null,
      nm: row.torque_nm ?? null,
      notes: row.notes ?? null,
    })),
  };
}

function humanizeComponent(slug) {
  if (typeof slug !== "string") return "";
  return slug.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

// Verified against /v1/vehicles/{id}/maintenance: { schedules: [{
//   mileage_interval, months_interval, description, parts: [{...}] }] }
function mapMaintenance(raw) {
  if (!raw || typeof raw !== "object") return null;
  const schedules = Array.isArray(raw.schedules) ? raw.schedules : [];
  if (schedules.length === 0) return null;
  const items = schedules
    .slice()
    .sort((a, b) => (a.mileage_interval ?? 0) - (b.mileage_interval ?? 0))
    .map((s) => ({
      mileageInterval: s.mileage_interval ?? null,
      monthsInterval: s.months_interval ?? null,
      task: s.description ?? "",
      parts: Array.isArray(s.parts)
        ? s.parts.map((p) => ({
            partType: p.part_type ?? null,
            brand: p.brand ?? null,
            partNumber: p.part_number ?? null,
            description: p.description ?? null,
            qty: p.qty ?? null,
          }))
        : [],
    }));
  return { items };
}

const MAPPERS = {
  oil: mapOil,
  torque: mapTorque,
  maintenanceInterval: mapMaintenance,
};

export async function lookup(vehicle, specType, _params, fetcher) {
  if (!configured()) return null;
  const resource = RESOURCE_BY_SPEC_TYPE[specType];
  if (!resource) return null;

  const vehicleId = await resolveVehicleId(vehicle, fetcher);
  if (vehicleId == null) return null;

  const url = `${BASE_URL}/vehicles/${encodeURIComponent(vehicleId)}/${resource}`;
  console.log(`[vehicle-finder] GET ${url}`);
  const res = await fetcher(url, {
    headers: { "X-API-Key": API_KEY, Accept: "application/json" },
  });
  console.log(`[vehicle-finder] ${resource} status=${res.status}`);
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.log(
      `[vehicle-finder] ${resource} error body (truncated): ${text.slice(0, 300)}`,
    );
    throw new Error(`${resource} fetch ${res.status}`);
  }
  const body = await res.json();
  // Vehicle Finder wraps every response in { data, meta }; unwrap before
  // handing to the mapper. Tolerant of un-wrapped responses too in case
  // some endpoints return the payload directly.
  const inner = body && typeof body === "object" && "data" in body ? body.data : body;
  const innerKeys = inner && typeof inner === "object" && !Array.isArray(inner)
    ? Object.keys(inner).slice(0, 12)
    : Array.isArray(inner)
      ? `array(${inner.length})`
      : typeof inner;
  console.log(`[vehicle-finder] ${resource} inner shape: ${JSON.stringify(innerKeys)}`);
  // One-shot raw-body log so we can verify the torque + maintenance
  // mappers against real data. Will be removed once both are confirmed.
  console.log(
    `[vehicle-finder] ${resource} raw inner: ${JSON.stringify(inner).slice(0, 2000)}`,
  );
  const mapper = MAPPERS[specType];
  const data = mapper ? mapper(inner) : inner;
  if (!data) {
    console.log(
      `[vehicle-finder] ${resource} mapped to null — raw sample: ${JSON.stringify(body).slice(0, 400)}`,
    );
    return null;
  }
  console.log(
    `[vehicle-finder] ${resource} mapped OK — keys: ${JSON.stringify(Object.keys(data).slice(0, 12))}`,
  );
  return { data };
}
