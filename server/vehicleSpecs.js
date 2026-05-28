import fs from "node:fs";
import { cacheFile } from "./cacheDir.js";
import * as vehicleFinder from "./specProviders/vehicleFinder.js";
import * as openLabor from "./specProviders/openLabor.js";

// ----------------------------------------------------------------------------
// Vehicle spec retrieval — second layer of the hybrid retrieval system (the
// first is DTC lookup in dtcDatabase.js + dtcFallback.js).
//
// Goal: route factual vehicle-spec questions ("how many quarts of oil",
// "lug nut torque", "what coolant") to authoritative data providers BEFORE
// they reach Claude, so we don't pay for hallucinated values. Each spec
// lookup that comes from an external provider is cached forever (the data
// doesn't change for a given vehicle).
//
// Flow:
//   1. detectSpecIntent(text) → { specType, params? } | null
//   2. lookupSpec(vehicle, specType, params) tries the provider chain in
//      order, returns the first hit (with caching at the orchestrator level
//      so providers stay simple).
//   3. formatSpecAnswer(specType, result) renders the response as plain
//      text suitable for the Ask Vulcan chat bubble.
//
// Providers must export:
//   id: string
//   configured(): boolean
//   async lookup(vehicle, specType, params, fetcher): { data, source } | null
//
// Adding a new provider: drop a file in ./specProviders, import it here,
// append to PROVIDERS. Order = priority.
// ----------------------------------------------------------------------------

const CACHE_PATH = cacheFile("vehicleSpecCache.json");

// Spec types the orchestrator understands. Each is a stable key used in
// caching, metrics, and provider capability lists.
export const SPEC_TYPES = Object.freeze({
  OIL: "oil",
  COOLANT: "coolant",
  TRANSMISSION_FLUID: "transmissionFluid",
  BRAKE_FLUID: "brakeFluid",
  POWER_STEERING_FLUID: "powerSteeringFluid",
  TORQUE: "torque",
  BATTERY: "battery",
  MAINTENANCE_INTERVAL: "maintenanceInterval",
});

// ----------- Cache ----------------------------------------------------------

let cache = {
  entries: {},
  hits: 0,
  misses: 0,
  providerCalls: 0,
  providerErrors: 0,
};

try {
  if (fs.existsSync(CACHE_PATH)) {
    const raw = fs.readFileSync(CACHE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    cache = {
      entries: parsed.entries ?? {},
      hits: parsed.hits ?? 0,
      misses: parsed.misses ?? 0,
      providerCalls: parsed.providerCalls ?? 0,
      providerErrors: parsed.providerErrors ?? 0,
    };
    const total = cache.hits + cache.misses;
    const hitRate = total > 0 ? `${((cache.hits / total) * 100).toFixed(1)}%` : "n/a";
    console.log(
      `[vehicleSpecs] loaded ${Object.keys(cache.entries).length} cached spec entries ` +
        `(hits=${cache.hits}, misses=${cache.misses}, hitRate=${hitRate}, providerCalls=${cache.providerCalls})`,
    );
  }
} catch (err) {
  console.warn(
    "[vehicleSpecs] failed to load vehicleSpecCache.json, starting fresh:",
    err.message,
  );
}

function persist() {
  try {
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
  } catch (err) {
    console.warn(
      "[vehicleSpecs] failed to write vehicleSpecCache.json:",
      err.message,
    );
  }
}

function normalizeVehicle(v) {
  if (!v || typeof v !== "object") return "";
  return [v.year, v.make, v.model, v.trim, v.engineType]
    .map((x) => String(x ?? "").toLowerCase().trim())
    .join("|");
}

function cacheKey(vehicle, specType, params) {
  const p = params ? JSON.stringify(params) : "";
  return `${normalizeVehicle(vehicle)}::${specType}::${p}`;
}

// ----------- Pattern detection ---------------------------------------------

// Each entry: regex → spec type. First match wins. Order matters — more
// specific patterns before more general ones (e.g. "transmission fluid"
// before bare "fluid").
const SPEC_PATTERNS = [
  { specType: SPEC_TYPES.TRANSMISSION_FLUID, match: /\b(transmission|atf)\s+fluid\b|\bwhat\s+(atf|transmission)\b/i },
  { specType: SPEC_TYPES.BRAKE_FLUID, match: /\bbrake\s+fluid\b|\bdot\s*[345]\b/i },
  { specType: SPEC_TYPES.POWER_STEERING_FLUID, match: /\bpower\s+steering\s+fluid\b/i },
  { specType: SPEC_TYPES.COOLANT, match: /\bcoolant\b|\bantifreeze\b/i },
  { specType: SPEC_TYPES.OIL, match: /\b(how\s+much|how\s+many\s+quarts\s+of|what)\s+oil\b|\boil\s+(capacity|type|spec|weight|viscosity|grade)\b|\bwhat\s+(weight|viscosity|grade)\s+of\s+oil\b/i },
  { specType: SPEC_TYPES.TORQUE, match: /\btorque\s+spec(s|ification)?\b|\b(lug\s*nut|drain\s*(plug|bolt)|spark\s*plug|head\s*bolt|axle\s*nut)\s+torque\b|\btorque\s+(for|on|of)\b/i },
  { specType: SPEC_TYPES.BATTERY, match: /\bbattery\s+(size|group|cca|amperage|spec)\b|\bgroup\s+\d{2,3}\s+battery\b|\bbci\s+group\b/i },
  { specType: SPEC_TYPES.MAINTENANCE_INTERVAL, match: /\bmaintenance\s+(schedule|interval)\b|\bservice\s+interval\b|\bwhen\s+to\s+change\b|\bevery\s+\d+\s*(miles|km|kilometers|months|years)\b/i },
];

export function detectSpecIntent(text) {
  if (typeof text !== "string" || text.length === 0) return null;
  for (const { specType, match } of SPEC_PATTERNS) {
    if (match.test(text)) return { specType };
  }
  return null;
}

// Diagnose mode: find every spec category the complaint touches on so we
// can proactively inject verified values into Claude's context. Returns an
// array of spec types (possibly empty).
export function detectAllSpecIntents(text) {
  if (typeof text !== "string" || text.length === 0) return [];
  const hits = [];
  for (const { specType, match } of SPEC_PATTERNS) {
    if (match.test(text)) hits.push(specType);
  }
  return hits;
}

// Catch ALL spec-shaped questions, even ones that won't route to a provider
// (e.g. coolant when no provider supplies coolant data). Used by the Ask
// Vulcan handler to decide whether to prepend the anti-hallucination
// preamble before calling Claude.
export function isSpecQuestion(text) {
  return detectSpecIntent(text) !== null;
}

// ----------- Provider orchestration ----------------------------------------

const PROVIDERS = [vehicleFinder, openLabor];

// Shared fetcher passed into providers so they don't each implement timeouts.
async function fetchWithTimeout(url, options = {}, timeoutMs = 7000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Returns { data, source, fromCache } | null
export async function lookupSpec(vehicle, specType, params = null) {
  if (!vehicle || !vehicle.year || !vehicle.make || !vehicle.model) {
    return null;
  }
  const key = cacheKey(vehicle, specType, params);

  const cached = cache.entries[key];
  if (cached) {
    cache.hits++;
    persist();
    console.log(
      `[vehicleSpecs] HIT ${specType} for ${vehicle.year} ${vehicle.make} ${vehicle.model} (source=${cached.source})`,
    );
    return { data: cached.data, source: cached.source, fromCache: true };
  }

  for (const provider of PROVIDERS) {
    if (!provider.configured()) continue;
    cache.providerCalls++;
    try {
      const result = await provider.lookup(
        vehicle,
        specType,
        params,
        fetchWithTimeout,
      );
      if (result && result.data) {
        cache.entries[key] = {
          data: result.data,
          source: provider.id,
          vehicle: {
            year: vehicle.year,
            make: vehicle.make,
            model: vehicle.model,
            trim: vehicle.trim,
            engineType: vehicle.engineType,
          },
          specType,
          params,
          fetchedAt: new Date().toISOString(),
        };
        persist();
        console.log(
          `[vehicleSpecs] STORE ${specType} from ${provider.id} for ${vehicle.year} ${vehicle.make} ${vehicle.model}`,
        );
        return { data: result.data, source: provider.id, fromCache: false };
      }
    } catch (err) {
      cache.providerErrors++;
      console.warn(
        `[vehicleSpecs] provider ${provider.id} failed for ${specType}:`,
        err.message,
      );
    }
  }

  cache.misses++;
  persist();
  console.log(
    `[vehicleSpecs] MISS ${specType} for ${vehicle.year} ${vehicle.make} ${vehicle.model} — falling through to Claude`,
  );
  return null;
}

// ----------- Formatters ----------------------------------------------------

function fmtOil(d, v) {
  const head = `**${v.year} ${v.make} ${v.model}${v.engineType ? " · " + v.engineType : ""} — Oil**`;
  const lines = [head, ""];
  if (d.viscosity) lines.push(`• Viscosity: ${d.viscosity}`);
  if (d.oilType) lines.push(`• Oil type: ${d.oilType}`);
  if (d.capacityWithFilterQt != null) {
    lines.push(`• Capacity with filter: ${d.capacityWithFilterQt} qt`);
  }
  if (d.capacityWithoutFilterQt != null) {
    lines.push(`• Capacity without filter: ${d.capacityWithoutFilterQt} qt`);
  }
  if (d.oemSpec) lines.push(`• OEM spec: ${d.oemSpec}`);

  if (Array.isArray(d.filters) && d.filters.length > 0) {
    lines.push("", "Filter part numbers:");
    for (const f of d.filters) {
      const label = [f.brand, f.partNumber].filter(Boolean).join(" ");
      const oem = f.isOem ? " (OEM)" : "";
      const desc = f.description ? ` — ${f.description}` : "";
      lines.push(`• ${label}${oem}${desc}`);
    }
  }

  const torqueBits = [];
  if (d.drainBoltTorqueFtLb != null) torqueBits.push(`${d.drainBoltTorqueFtLb} ft-lb`);
  if (d.drainBoltTorqueNm != null) torqueBits.push(`${d.drainBoltTorqueNm} Nm`);
  if (torqueBits.length > 0) {
    let line = `• Drain bolt torque: ${torqueBits.join(" / ")}`;
    if (d.drainBoltNotes) line += ` — ${d.drainBoltNotes}`;
    lines.push("", line);
  } else if (d.drainBoltNotes) {
    lines.push("", `• Drain bolt: ${d.drainBoltNotes}`);
  }
  if (d.drainBoltSocketSizeMm) lines.push(`• Drain bolt socket: ${d.drainBoltSocketSizeMm} mm`);
  if (d.drainBoltThreadSize) lines.push(`• Drain bolt thread: ${d.drainBoltThreadSize}`);
  return lines.join("\n");
}

function fmtTorque(d, v) {
  const head = `**${v.year} ${v.make} ${v.model} — Torque Specs**`;
  const lines = [head, ""];
  const rows = Array.isArray(d.specs) ? d.specs : [];
  for (const row of rows) {
    const lbf = row.ftLbs != null ? `${row.ftLbs} ft-lb` : null;
    const nm = row.nm != null ? `${row.nm} Nm` : null;
    const val = [lbf, nm].filter(Boolean).join(" / ");
    lines.push(`• ${row.fastener}: ${val}${row.notes ? ` — ${row.notes}` : ""}`);
  }
  return lines.join("\n");
}

function fmtMaintenance(d, v) {
  const head = `**${v.year} ${v.make} ${v.model} — Maintenance Schedule**`;
  const lines = [head, ""];
  const items = Array.isArray(d.items) ? d.items : [];
  // Group consecutive tasks that share an interval so the schedule reads
  // like an OEM service chart ("Every 5,000 mi / 6 mo:" then bullets).
  let lastInterval = null;
  for (const i of items) {
    const miles = i.mileageInterval != null
      ? `${i.mileageInterval.toLocaleString()} mi`
      : null;
    const months = i.monthsInterval != null ? `${i.monthsInterval} mo` : null;
    const interval = [miles, months].filter(Boolean).join(" / ") || "?";
    if (interval !== lastInterval) {
      if (lastInterval !== null) lines.push("");
      lines.push(`**Every ${interval}:**`);
      lastInterval = interval;
    }
    let line = `• ${i.task}`;
    if (i.parts && i.parts.length > 0) {
      const partsText = i.parts.map((p) => {
        const label = [p.brand, p.partNumber].filter(Boolean).join(" ");
        const qty = p.qty ? ` ×${p.qty}` : "";
        return `${label}${qty}`;
      }).join(", ");
      line += ` — ${partsText}`;
    }
    lines.push(line);
  }
  return lines.join("\n");
}

function fmtGeneric(d, v, label) {
  const head = `**${v.year} ${v.make} ${v.model} — ${label}**`;
  const lines = [head, ""];
  if (typeof d === "string") {
    lines.push(d);
  } else {
    for (const [k, val] of Object.entries(d)) {
      if (val == null || val === "") continue;
      lines.push(`• ${k}: ${val}`);
    }
  }
  return lines.join("\n");
}

const FORMATTERS = {
  [SPEC_TYPES.OIL]: fmtOil,
  [SPEC_TYPES.TORQUE]: fmtTorque,
  [SPEC_TYPES.MAINTENANCE_INTERVAL]: fmtMaintenance,
  [SPEC_TYPES.COOLANT]: (d, v) => fmtGeneric(d, v, "Coolant"),
  [SPEC_TYPES.TRANSMISSION_FLUID]: (d, v) => fmtGeneric(d, v, "Transmission Fluid"),
  [SPEC_TYPES.BRAKE_FLUID]: (d, v) => fmtGeneric(d, v, "Brake Fluid"),
  [SPEC_TYPES.POWER_STEERING_FLUID]: (d, v) => fmtGeneric(d, v, "Power Steering Fluid"),
  [SPEC_TYPES.BATTERY]: (d, v) => fmtGeneric(d, v, "Battery"),
};

export function formatSpecAnswer(specType, result, vehicle) {
  const fmt = FORMATTERS[specType];
  const text = fmt ? fmt(result.data, vehicle) : fmtGeneric(result.data, vehicle, specType);
  return `${text}\n\n_Source: ${result.source}${result.fromCache ? " (cached)" : ""}_`;
}

// Same data, but rendered as a system-prompt context block for Diagnose
// mode — Claude reads it as "verified specs, prefer these over your own
// recollection".
export function formatSpecContextBlock(entries) {
  if (!entries.length) return "";
  const lines = [
    "Verified vehicle specs retrieved from authoritative provider(s). Use these values exactly — do not substitute your own recollection:",
    "",
  ];
  for (const e of entries) {
    lines.push(`[${e.specType}] (source: ${e.source})`);
    lines.push(JSON.stringify(e.data, null, 2));
    lines.push("");
  }
  return lines.join("\n");
}

// ----------- Anti-hallucination preamble -----------------------------------

// Prepended to the system context when a spec question goes to Claude
// (either because no provider hit OR because we want defensive framing
// even on a hit-adjacent question).
export const SPEC_CAUTION_PREAMBLE = `You are being asked a factual vehicle specification question that our authoritative data sources could not answer. If you are not highly confident in the specific value, say so clearly and recommend the user verify with an OEM source or service manual. Do not guess capacities, torque values, fluid types, or intervals — wrong values here cause real damage.`;

// ----------- Metrics --------------------------------------------------------

export function vehicleSpecsStats() {
  return {
    entries: Object.keys(cache.entries).length,
    hits: cache.hits,
    misses: cache.misses,
    providerCalls: cache.providerCalls,
    providerErrors: cache.providerErrors,
    providers: PROVIDERS.map((p) => ({
      id: p.id,
      configured: p.configured(),
    })),
  };
}
