// ----------------------------------------------------------------------------
// VIN decode via the self-hosted vPIC decode DB (the trimmed NHTSA vPIC dump
// restored into the `vpic` schema, co-located with the spec DB). This replaces
// the mobile app's old direct call to the flaky public NHTSA API.
//
// vpic.spvindecode returns a TALL key/value result (one row per decoded
// attribute). This module owns the tall->wide pivot and reproduces the
// engineType composition the device's decodeVin() used to do client-side —
// ported BYTE-FOR-BYTE (titleCase / nhtsaIsYes / buildEngineType) so the
// server-side config-mismatch detector keeps keyword-matching the same string
// (e.g. "Turbocharged" / "Diesel"). See GET /api/decode-vin in index.js.
// ----------------------------------------------------------------------------

export const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/i;

export function isLikelyVin(value) {
  return VIN_RE.test(String(value ?? "").trim());
}

function titleCase(s) {
  return s
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .trim();
}

// NHTSA's value for the Turbo / Other fields can be "Yes" / "No" / null /
// rarely a model name. Treat anything that doesn't look like a clear "no"
// or empty as a positive signal. (Ported verbatim from the old client decodeVin.)
function nhtsaIsYes(value) {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  if (v === "" || v === "no" || v === "false" || v === "0" || v === "not applicable") {
    return false;
  }
  return true;
}

// Ported byte-for-byte from the old mobile buildEngineType(). The resulting
// string is consumed by detectConfigMismatch (turbo-DTC-on-NA-engine, etc.), so
// any deviation silently degrades the safety detector — keep this identical.
export function buildEngineType(displacementL, cyl, turbo, fuelType, otherEngineInfo) {
  const parts = [];
  if (displacementL) {
    const n = Number(displacementL);
    if (Number.isFinite(n) && n > 0) parts.push(`${n.toFixed(1)}L`);
  }
  if (cyl) {
    const n = Number(cyl);
    if (Number.isFinite(n) && n > 0) parts.push(`${n}-cyl`);
  }
  // Surface forced-induction explicitly so the config-mismatch detector can
  // keyword-match engineType. Turbo is a direct field; Diesel comes from
  // FuelTypePrimary; OtherEngineInfo carries free-text like "EcoBoost".
  if (nhtsaIsYes(turbo)) parts.push("Turbocharged");
  if (fuelType && /diesel/i.test(fuelType)) parts.push("Diesel");
  if (otherEngineInfo && /ecoboost|supercharg|biturbo|twinturbo/i.test(otherEngineInfo)) {
    parts.push(otherEngineInfo.trim());
  }
  return parts.join(" ");
}

// Stable vPIC element ids (itemelementid) for the fields the device consumes.
// We key the pivot on these ids, NOT the human-readable variable names — the ids
// are stable across monthly vPIC releases, the display strings are not.
const ELEMENT_ID = {
  ModelYear: 29,
  Make: 26,
  Model: 28,
  Series: 34,
  Trim: 38,
  Trim2: 109,
  EngineCylinders: 9,
  DisplacementL: 13,
  Turbo: 135,
  FuelTypePrimary: 24,
  OtherEngineInfo: 129,
  ErrorCode: 143,
  ErrorText: 191,
};

// Collapse the tall spvindecode rows to one value per element id (first
// non-empty wins). `rows` = [{ itemelementid, variable, value }, ...].
export function pivotDecode(rows) {
  const byId = new Map();
  for (const r of rows || []) {
    const id = Number(r.itemelementid);
    const val = r.value == null ? "" : String(r.value);
    const prev = byId.get(id);
    if (prev === undefined || (prev === "" && val !== "")) byId.set(id, val);
  }
  const get = (key) => byId.get(ELEMENT_ID[key]) ?? "";
  return {
    ModelYear: get("ModelYear"),
    Make: get("Make"),
    Model: get("Model"),
    Series: get("Series"),
    Trim: get("Trim"),
    Trim2: get("Trim2"),
    EngineCylinders: get("EngineCylinders"),
    DisplacementL: get("DisplacementL"),
    Turbo: get("Turbo"),
    FuelTypePrimary: get("FuelTypePrimary"),
    OtherEngineInfo: get("OtherEngineInfo"),
    ErrorCode: get("ErrorCode"),
    ErrorText: get("ErrorText"),
  };
}

// Build the wide VinDecoded the device expects, or { error } when the VIN yields
// no usable vehicle. Mirrors the OLD client decodeVin() EXACTLY: reject only when
// Make AND Model AND ModelYear are all empty. An ErrorCode != 0 that still
// produced a make/model is a usable decode and must NOT be rejected (the F-150 /
// F-250 / Corolla smoke-test VINs were all ErrorCode=1 and decoded fine).
export function buildVinDecoded(rows) {
  const row = pivotDecode(rows);
  if (!row.Make && !row.Model && !row.ModelYear) {
    return { error: (row.ErrorText || "Could not decode VIN.").split(";")[0] };
  }
  return {
    decoded: {
      year: (row.ModelYear ?? "").trim(),
      make: row.Make ? titleCase(row.Make) : "",
      model: row.Model ? titleCase(row.Model) : "",
      // Raw, untouched by titleCase — a query disambiguator, not display text.
      series: (row.Series ?? "").trim(),
      trim: row.Trim ? titleCase(row.Trim) : row.Trim2 ? titleCase(row.Trim2) : "",
      engineType: buildEngineType(
        row.DisplacementL ?? "",
        row.EngineCylinders ?? "",
        row.Turbo,
        row.FuelTypePrimary,
        row.OtherEngineInfo,
      ),
    },
  };
}
