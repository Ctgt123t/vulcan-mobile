import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ----------------------------------------------------------------------------
// DTC database — sourced from the open-source Wal33D/dtc-database project
// (MIT licensed). The original SQLite distribution is converted to a slim
// JSON map at integration time and shipped here as `dtcData.json`. We dropped
// the SQLite path because better-sqlite3 needs node-gyp + Python to compile
// against unfamiliar Node patch versions on Railway's Nixpacks builder, and
// our access pattern is a single primary-key lookup — no SQL needed.
//
// JSON shape: { [code]: { [MANUFACTURER]: description } }
//   - MANUFACTURER is "GENERIC" for SAE J2012 entries, otherwise an upper-
//     case brand key (FORD, ACURA, ...).
//   - description is the raw one-liner from the source database.
//   - The code's `type` (P/B/C/U) is derivable from the first character,
//     `is_generic` from the presence of the GENERIC key.
//
// Lookup order (lookupDtc):
//   1. Manufacturer-specific entry if `make` was provided and resolves
//   2. Pattern handler (cylinder/coil-specific copy is richer than the
//      one-line generic description)
//   3. Generic SAE entry
//   4. null (caller can fall back to Claude interpretation)
//
// Field synthesis for the response: `shortDescription` and
// `detailedDescription` both reuse the source description (it's typically
// one phrase); `system` derived from the code type; `urgency` defaults to
// "medium"; `commonCauses` defaults to []. Pattern handlers override all of
// these with hand-written copy.
// ----------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_PATH = path.join(__dirname, "dtcData.json");

let DATA = {};
let uniqueCodes = 0;
let totalEntries = 0;
let totalGeneric = 0;
let totalManufacturer = 0;
try {
  DATA = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
  uniqueCodes = Object.keys(DATA).length;
  for (const code in DATA) {
    for (const mfr in DATA[code]) {
      totalEntries++;
      if (mfr === "GENERIC") totalGeneric++;
      else totalManufacturer++;
    }
  }
  console.log(
    `[dtc] loaded ${totalEntries} entries across ${uniqueCodes} unique codes ` +
      `(${totalGeneric} generic, ${totalManufacturer} manufacturer-specific)`,
  );
} catch (err) {
  console.warn("[dtc] failed to load dtcData.json:", err.message);
}

// Separate counters so /metrics can report how often the manufacturer-specific
// path actually fires vs the generic fallback vs the pattern handlers.
const stats = {
  genericHits: 0,
  manufacturerHits: 0,
  patternHits: 0,
};

export function dtcStats() {
  return {
    ...stats,
    uniqueCodes,
    totalEntries,
    genericEntries: totalGeneric,
    manufacturerEntries: totalManufacturer,
  };
}

// ----------- Code extraction -----------------------------------------------

const DTC_RE = /\b([PBCU])([0-9A-F])([0-9A-F]{3})\b/gi;

export function extractDtcCodes(text) {
  if (typeof text !== "string") return [];
  const found = new Set();
  let m;
  DTC_RE.lastIndex = 0;
  while ((m = DTC_RE.exec(text)) !== null) {
    found.add(m[0].toUpperCase());
  }
  return Array.from(found);
}

export function isDtcCode(token) {
  return /^[PBCU][0-9A-F]{4}$/i.test(token);
}

// ----------- Pattern handlers ----------------------------------------------
//
// Kept because their per-cylinder / per-coil copy is richer than the
// one-line description in the source database.

const PATTERN_HANDLERS = [
  {
    name: "cylinder-misfire",
    match: /^P03(0[1-9]|[12][0-9]|3[0-2])$/, // P0301 through P0332
    build: (code) => {
      const cyl = parseInt(code.slice(2), 10) - 300;
      return {
        code,
        shortDescription: `Cylinder ${cyl} Misfire Detected`,
        detailedDescription: `The PCM detected a misfire on cylinder ${cyl} specifically. A misfire is a combustion event that either did not occur or was incomplete. Concentrated single-cylinder misfires usually point to a fault local to that cylinder (plug, coil, injector) rather than a system-wide issue.`,
        system: "Ignition / Fuel Delivery",
        commonCauses: [
          `Worn or fouled spark plug on cylinder ${cyl} (check first)`,
          `Failing ignition coil on cylinder ${cyl} (swap with adjacent coil to confirm)`,
          `Failing fuel injector on cylinder ${cyl}`,
          `Low compression on cylinder ${cyl} (worn rings, burnt valve, head gasket)`,
          "Vacuum leak near that runner",
          "Damaged spark plug wire (if equipped)",
        ],
        urgency: "medium",
      };
    },
  },
  {
    name: "coil-primary-secondary",
    match: /^P035[1-9]$|^P036[0-9]$/, // P0351-P0369: primary/secondary on coils 1-N
    build: (code) => {
      const last = parseInt(code.slice(2), 10);
      const cyl = last - 350;
      return {
        code,
        shortDescription: `Ignition Coil ${cyl} Primary/Secondary Circuit Malfunction`,
        detailedDescription: `The PCM detected an electrical fault in the primary or secondary circuit of the ignition coil for cylinder ${cyl}.`,
        system: "Ignition",
        commonCauses: [
          `Failed ignition coil on cylinder ${cyl}`,
          "Damaged coil connector or wiring",
          "Open or shorted coil driver inside the PCM (rare)",
          "Coil power supply fault",
        ],
        urgency: "medium",
      };
    },
  },
];

// ----------- Field derivation -----------------------------------------------

const SYSTEM_BY_TYPE = {
  P: "Powertrain",
  B: "Body",
  C: "Chassis",
  U: "Network Communication",
};

function deriveEntry(code, description) {
  const desc = description || "";
  const type = code[0];
  return {
    code,
    shortDescription: desc,
    detailedDescription: desc,
    system: SYSTEM_BY_TYPE[type] || "Unknown",
    commonCauses: [],
    urgency: "medium",
  };
}

// Normalize a free-form vehicle.make string ("Ford", "ford", "Ford Motor Co.")
// to the uppercase manufacturer key used by the source database.
function normalizeManufacturer(make) {
  if (typeof make !== "string") return null;
  const upper = make.toUpperCase().trim();
  if (!upper) return null;
  const first = upper.split(/\s+/)[0].replace(/[^A-Z]/g, "");
  const known = new Set([
    "ACURA", "AUDI", "BMW", "BUICK", "CADILLAC", "CHEVY", "CHRYSLER", "DODGE",
    "FORD", "GEO", "GM", "GMC", "HONDA", "INFINITI", "JAGUAR", "JEEP", "KIA",
    "LEXUS", "LINCOLN", "MAZDA", "MERCEDES", "MERCURY", "MITSUBISHI", "NISSAN",
    "OLDSMOBILE", "PLYMOUTH", "PONTIAC", "SATURN", "SUBARU", "SUZUKI", "TOYOTA",
    "VOLKSWAGEN",
  ]);
  if (known.has(first)) return first;
  const aliases = { CHEVROLET: "CHEVY", VW: "VOLKSWAGEN", "MERCEDESBENZ": "MERCEDES" };
  if (aliases[first]) return aliases[first];
  return null;
}

// ----------- Lookup ---------------------------------------------------------

export function lookupDtc(code, make = null) {
  const normalized = code.toUpperCase();
  const entry = DATA[normalized];

  // 1. Manufacturer-specific lookup if a known make was provided.
  const mfr = normalizeManufacturer(make);
  if (entry && mfr && entry[mfr]) {
    stats.manufacturerHits++;
    return deriveEntry(normalized, entry[mfr]);
  }

  // 2. Pattern handlers — cylinder/coil-specific copy beats the generic
  //    one-liner from the database.
  for (const handler of PATTERN_HANDLERS) {
    if (handler.match.test(normalized)) {
      stats.patternHits++;
      return handler.build(normalized);
    }
  }

  // 3. Generic fallback.
  if (entry && entry.GENERIC) {
    stats.genericHits++;
    return deriveEntry(normalized, entry.GENERIC);
  }

  return null;
}

// ----------- Formatters (unchanged shape, defensive against empty causes) ---

export function formatDtcAnswer(entry) {
  const lines = [
    `**${entry.code} — ${entry.shortDescription}**`,
    "",
    entry.detailedDescription,
    "",
    `System: ${entry.system}`,
    `Urgency: ${entry.urgency}`,
  ];
  if (entry.commonCauses && entry.commonCauses.length > 0) {
    lines.push("", "Common causes:");
    lines.push(...entry.commonCauses.map((c) => `• ${c}`));
  }
  return lines.join("\n");
}

export function formatDtcContextBlock(entries) {
  if (!entries.length) return "";
  const lines = [
    "Verified DTC definitions from the local SAE database (use these — do not invent alternate definitions):",
    "",
  ];
  for (const e of entries) {
    lines.push(`${e.code} — ${e.shortDescription}`);
    lines.push(`  Detailed: ${e.detailedDescription}`);
    lines.push(`  System: ${e.system}`);
    lines.push(`  Urgency: ${e.urgency}`);
    if (e.commonCauses && e.commonCauses.length > 0) {
      lines.push(`  Common causes: ${e.commonCauses.join("; ")}`);
    }
    if (e.configMismatch && e.configMismatch.message) {
      lines.push(`  ⚠ Configuration mismatch: ${e.configMismatch.message}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
