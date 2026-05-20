import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ----------------------------------------------------------------------------
// DTC database — loaded from dtcData.json on startup and consulted by the
// Ask Vulcan retrieval layer before any Claude call. To add codes, just
// append entries to dtcData.json. Pattern-based entries (cylinder misfires,
// per-coil codes, etc.) are generated at lookup time below.
// ----------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_PATH = path.join(__dirname, "dtcData.json");

let DATA = {};
try {
  DATA = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
  console.log(`[dtc] loaded ${Object.keys(DATA).length} static codes`);
} catch (err) {
  console.warn("[dtc] failed to load dtcData.json:", err.message);
}

// Module-level counter so /metrics can report DTC-database hit rate.
let hitCount = 0;
export function dtcStats() {
  return { hits: hitCount, staticEntries: Object.keys(DATA).length };
}

// SAE DTC format: a letter (P, B, C, U) followed by 4 hex digits. Real-world
// codes are almost always decimal (P0301), but the standard allows hex
// (P0A12 on hybrids). We accept both.
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

// Pattern handlers — codes that follow predictable per-cylinder/per-bank
// numbering. Order matters: first match wins.
const PATTERN_HANDLERS = [
  {
    name: "cylinder-misfire",
    match: /^P03(0[1-9]|[12][0-9]|3[0-2])$/, // P0301 through P0332
    build: (code) => {
      const cyl = parseInt(code.slice(2), 10);
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

export function lookupDtc(code) {
  const normalized = code.toUpperCase();
  if (DATA[normalized]) {
    hitCount++;
    return DATA[normalized];
  }
  for (const handler of PATTERN_HANDLERS) {
    if (handler.match.test(normalized)) {
      hitCount++;
      return handler.build(normalized);
    }
  }
  return null;
}

// Format a DTC entry as a plain-text answer suitable for the Ask Vulcan
// response body. Mobile renders this exactly like a Claude text reply.
export function formatDtcAnswer(entry) {
  const lines = [
    `**${entry.code} — ${entry.shortDescription}**`,
    "",
    entry.detailedDescription,
    "",
    `System: ${entry.system}`,
    `Urgency: ${entry.urgency}`,
    "",
    "Common causes:",
    ...entry.commonCauses.map((c) => `• ${c}`),
  ];
  return lines.join("\n");
}

// Format DTC entries as a context block to inject into Claude's system
// prompt when the user's message contains a code but also asks a more
// complex question. This anchors Claude's answer to the verified definition
// rather than letting it hallucinate.
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
    lines.push(`  Common causes: ${e.commonCauses.join("; ")}`);
    lines.push("");
  }
  return lines.join("\n");
}
