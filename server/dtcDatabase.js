import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

// ----------------------------------------------------------------------------
// DTC database — sourced from the open-source Wal33D/dtc-database project
// (MIT licensed). The SQLite file `dtc_codes.db` contains 18,805 entries
// covering 33 manufacturers plus 9,415 generic SAE J2012 codes.
//
// Schema:
//   dtc_definitions(code, manufacturer, description, type, locale,
//                   is_generic, source_file)
//   PRIMARY KEY (code, manufacturer, locale)
//
// Lookup order (lookupDtc):
//   1. Manufacturer-specific entry if `make` was provided
//   2. Pattern handler (cylinder/coil-specific copy — richer than the
//      one-line generic description)
//   3. Generic SAE entry
//   4. null (caller can fall back to Claude interpretation)
//
// The source database provides only a single `description` field per entry.
// We map onto the existing mobile response schema by reusing description for
// both summary and detail, deriving `system` from the code type letter, and
// defaulting `urgency` to "medium" / `commonCauses` to [] since the source
// has no signal for either.
// ----------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.join(__dirname, "dtc_codes.db");

let db = null;
let totalRows = 0;
let totalGeneric = 0;
let totalManufacturer = 0;
try {
  db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  totalRows = db.prepare("SELECT COUNT(*) AS n FROM dtc_definitions").get().n;
  totalGeneric = db
    .prepare("SELECT COUNT(*) AS n FROM dtc_definitions WHERE is_generic = 1")
    .get().n;
  totalManufacturer = totalRows - totalGeneric;
  console.log(
    `[dtc] loaded SQLite database: ${totalRows} entries ` +
      `(${totalGeneric} generic, ${totalManufacturer} manufacturer-specific)`,
  );
} catch (err) {
  console.warn("[dtc] failed to open dtc_codes.db:", err.message);
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
    totalEntries: totalRows,
    genericEntries: totalGeneric,
    manufacturerEntries: totalManufacturer,
  };
}

// Prepared statements are created lazily so the module still imports cleanly
// if the SQLite file is missing (the lookup just returns null in that case).
let stmtSpecific = null;
let stmtGeneric = null;

function ensureStatements() {
  if (!db) return;
  if (!stmtSpecific) {
    stmtSpecific = db.prepare(
      "SELECT code, manufacturer, description, type " +
        "FROM dtc_definitions " +
        "WHERE code = ? AND manufacturer = ? AND locale = 'en' " +
        "LIMIT 1",
    );
  }
  if (!stmtGeneric) {
    stmtGeneric = db.prepare(
      "SELECT code, manufacturer, description, type " +
        "FROM dtc_definitions " +
        "WHERE code = ? AND is_generic = 1 AND locale = 'en' " +
        "LIMIT 1",
    );
  }
}

// ----------- Code extraction (unchanged) -----------------------------------

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

function deriveEntry(row) {
  const desc = row.description || "";
  return {
    code: row.code,
    shortDescription: desc,
    detailedDescription: desc,
    system: SYSTEM_BY_TYPE[row.type] || "Unknown",
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
  // Take the first word, strip non-letters. "Mercedes-Benz" → "MERCEDES",
  // "Chevy Truck" → "CHEVY". Covers the brands present in the source DB.
  const first = upper.split(/\s+/)[0].replace(/[^A-Z]/g, "");
  // Filter to brands that actually exist in the DB so we don't waste a query
  // on unknown makes.
  const known = new Set([
    "ACURA", "AUDI", "BMW", "BUICK", "CADILLAC", "CHEVY", "CHRYSLER", "DODGE",
    "FORD", "GEO", "GM", "GMC", "HONDA", "INFINITI", "JAGUAR", "JEEP", "KIA",
    "LEXUS", "LINCOLN", "MAZDA", "MERCEDES", "MERCURY", "MITSUBISHI", "NISSAN",
    "OLDSMOBILE", "PLYMOUTH", "PONTIAC", "SATURN", "SUBARU", "SUZUKI", "TOYOTA",
    "VOLKSWAGEN",
  ]);
  if (known.has(first)) return first;
  // Common aliases
  const aliases = { CHEVROLET: "CHEVY", VW: "VOLKSWAGEN", "MERCEDES-BENZ": "MERCEDES" };
  if (aliases[first]) return aliases[first];
  return null;
}

// ----------- Lookup ---------------------------------------------------------

export function lookupDtc(code, make = null) {
  const normalized = code.toUpperCase();
  ensureStatements();

  // 1. Manufacturer-specific lookup if a known make was provided.
  const mfr = normalizeManufacturer(make);
  if (db && mfr) {
    const row = stmtSpecific.get(normalized, mfr);
    if (row) {
      stats.manufacturerHits++;
      return deriveEntry(row);
    }
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
  if (db) {
    const row = stmtGeneric.get(normalized);
    if (row) {
      stats.genericHits++;
      return deriveEntry(row);
    }
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
    lines.push("");
  }
  return lines.join("\n");
}
