// ----------------------------------------------------------------------------
// Config-mismatch detector for DTC definitions.
//
// When a code's verified definition references a system (forced induction,
// diesel emissions, hybrid, etc.) that the connected vehicle's decoded
// configuration doesn't match, we flag the response so the OBD2 screen and
// the Diagnose conversation both treat the code with appropriate skepticism.
//
// Rules are stateless predicates over (entry, vehicle). They run on every
// /api/dtc/:code request and during Diagnose DTC enrichment, so they must
// stay cheap. No I/O, no allocation hot paths.
//
// Add new rules by appending to RULES. Each rule needs:
//   id           — short slug used in logs and as a key in the response
//   matchEntry   — predicate over the lookupDtc result (uses description text)
//   matchVehicle — predicate over vehicle metadata; return true to flag
//   message      — sentence shown to the technician and injected to Claude
//   severity     — "low" | "medium" | "high" (currently advisory only)
//
// Scaling note (per CLAUDE.md): this is pure-function enrichment with no
// per-user storage. Stateless and horizontally scalable.
// ----------------------------------------------------------------------------

function textBlob(entry) {
  return `${entry?.shortDescription ?? ""} ${entry?.detailedDescription ?? ""}`;
}

function engineTypeBlob(vehicle) {
  return String(vehicle?.engineType ?? "").toLowerCase();
}

const FORCED_INDUCTION_DTC = /turbo|supercharg|wastegate|\bboost\b|intercooler/i;
const FORCED_INDUCTION_ENG =
  /turbo|ecoboost|supercharg|tdi|tfsi|tsi|biturbo|twinturbo|gtdi|t-?jet|skyactiv-?t/i;

const DIESEL_DTC = /diesel|\bdpf\b|\bdef\b|\bscr\b|\bglow plug\b|\bcommon rail\b|particulate filter|injector control pressure/i;
const DIESEL_ENG = /diesel|tdi|cdi|powerstroke|duramax|cummins|crd|hdi|bluetec|ecodiesel|jtd/i;

const RULES = [
  {
    id: "forced-induction-on-na",
    matchEntry: (entry) => FORCED_INDUCTION_DTC.test(textBlob(entry)),
    matchVehicle: (vehicle) => {
      const eng = engineTypeBlob(vehicle);
      // Only flag when we have engine info but it doesn't indicate FI.
      // No engine info → no claim either way.
      if (!eng) return false;
      return !FORCED_INDUCTION_ENG.test(eng);
    },
    message:
      "This is a forced-induction code (turbocharger, supercharger, wastegate, or boost-circuit). The decoded engine for this vehicle doesn't indicate forced induction. Possibilities: a manufacturer-specific repurposing of the code for a different subsystem, a scan-tool misread, or a faulty sensor reporting a code outside its intended system. Worth confirming with a re-scan and verifying the engine option before chasing turbo components.",
    severity: "medium",
  },
  {
    id: "diesel-on-gas",
    matchEntry: (entry) => DIESEL_DTC.test(textBlob(entry)),
    matchVehicle: (vehicle) => {
      const eng = engineTypeBlob(vehicle);
      if (!eng) return false;
      return !DIESEL_ENG.test(eng);
    },
    message:
      "This code references a diesel-specific subsystem (DPF, DEF/SCR, glow plugs, common-rail injection, or particulate filter). The decoded engine for this vehicle doesn't indicate diesel. Likely a manufacturer-specific code with a different meaning on this powertrain, or a scan-tool misread.",
    severity: "medium",
  },
];

// Returns a `configMismatch` object suitable for attaching to a DTC
// response, or null if no rule fired. When multiple rules match we return
// the first one — adding ordering significance is a future concern.
export function detectConfigMismatch(entry, vehicle) {
  if (!entry || !vehicle) return null;
  for (const rule of RULES) {
    if (rule.matchEntry(entry) && rule.matchVehicle(vehicle)) {
      return {
        id: rule.id,
        message: rule.message,
        severity: rule.severity ?? null,
      };
    }
  }
  return null;
}
