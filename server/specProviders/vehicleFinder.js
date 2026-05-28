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
  const res = await fetcher(url, {
    headers: { "X-API-Key": API_KEY, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`vehicle resolve ${res.status}`);
  }
  const body = await res.json();
  // Tolerant of either { results: [...] } or [...] response shapes.
  const rows = Array.isArray(body) ? body : Array.isArray(body?.results) ? body.results : [];
  if (rows.length === 0) return null;

  // Prefer the trim match if we have one.
  let pick = rows[0];
  if (vehicle.trim) {
    const t = String(vehicle.trim).toLowerCase().trim();
    const exact = rows.find((r) => String(r.trim ?? "").toLowerCase().trim() === t);
    if (exact) pick = exact;
  }
  const vid = pick.id ?? pick.vehicle_id ?? pick.vehicleId;
  if (vid == null) return null;
  idCache.set(key, vid);
  return vid;
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
  const res = await fetcher(url, {
    headers: { "X-API-Key": API_KEY, Accept: "application/json" },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`${resource} fetch ${res.status}`);
  }
  const body = await res.json();
  const mapper = MAPPERS[specType];
  const data = mapper ? mapper(body) : body;
  if (!data) return null;
  return { data };
}
