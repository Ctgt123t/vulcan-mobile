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
// the keys our formatters expect. Unknown fields are passed through.
function mapOil(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    viscosity: raw.viscosity ?? raw.oil_viscosity ?? raw.weight,
    oilType: raw.oil_type ?? raw.type,
    capacityQuarts: raw.capacity_quarts ?? raw.capacity_qt ?? raw.capacityQuarts,
    capacityLiters: raw.capacity_liters ?? raw.capacity_l ?? raw.capacityLiters,
    filterPartNumbers: raw.filter_part_numbers ?? raw.filterPartNumbers ?? raw.filters,
    drainBoltTorque: raw.drain_bolt_torque ?? raw.drainBoltTorque,
    changeIntervalMiles: raw.change_interval_miles ?? raw.changeIntervalMiles,
    notes: raw.notes,
  };
}

function mapTorque(raw) {
  // Expecting either an array of { fastener, ftLbs, nm, notes } or a
  // grouped object. Normalize to { specs: [...] }.
  if (Array.isArray(raw)) {
    return { specs: raw.map(normalizeTorqueRow) };
  }
  if (raw && Array.isArray(raw.specs)) {
    return { specs: raw.specs.map(normalizeTorqueRow) };
  }
  if (raw && typeof raw === "object") {
    return {
      specs: Object.entries(raw).map(([fastener, row]) => ({
        fastener,
        ...normalizeTorqueRow(row),
      })),
    };
  }
  return null;
}

function normalizeTorqueRow(row) {
  if (!row || typeof row !== "object") return { fastener: String(row ?? "") };
  return {
    fastener: row.fastener ?? row.name ?? row.bolt,
    ftLbs: row.ft_lbs ?? row.ftLbs ?? row.lbf_ft,
    nm: row.nm ?? row.newton_meters ?? row.newtonMeters,
    notes: row.notes,
  };
}

function mapMaintenance(raw) {
  if (Array.isArray(raw)) return { items: raw.map(normalizeMaintRow) };
  if (raw && Array.isArray(raw.items)) return { items: raw.items.map(normalizeMaintRow) };
  if (raw && Array.isArray(raw.schedule)) return { items: raw.schedule.map(normalizeMaintRow) };
  return null;
}

function normalizeMaintRow(row) {
  if (!row || typeof row !== "object") return { interval: "?", task: String(row ?? "") };
  return {
    interval: row.interval ?? row.mileage ?? row.miles ?? row.km,
    task: row.task ?? row.service ?? row.item ?? row.description,
    notes: row.notes,
  };
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
  const bodyKeys = body && typeof body === "object" && !Array.isArray(body)
    ? Object.keys(body).slice(0, 12)
    : Array.isArray(body)
      ? `array(${body.length})`
      : typeof body;
  console.log(`[vehicle-finder] ${resource} body shape: ${JSON.stringify(bodyKeys)}`);
  const mapper = MAPPERS[specType];
  const data = mapper ? mapper(body) : body;
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
