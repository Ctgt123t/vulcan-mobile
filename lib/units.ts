// ----------------------------------------------------------------------------
// Display-layer unit formatter.
//
// Polling produces raw values in whatever units OBDb declares (mostly SI:
// celsius, kilometersPerHour, kilopascal). This module converts to the
// units a US technician expects — Fahrenheit, MPH, PSI, miles — at the
// moment of display. Internal storage and anything that gets shipped to
// Claude reasoning still comes through here, so its presentation matches
// what the tech sees on the gauges.
//
// `system` is "imperial" by default. A future user preference can swap to
// "metric" by reading an AsyncStorage flag; the conversion table below
// returns either-or based on that arg without any API surface change.
//
// Ambiguous cases (flagged so we can revisit):
//   - Barometric pressure: scan tools commonly display kPa, weather uses
//     inHg. We convert to PSI (consistent with other pressures); switch
//     to inHg by adding a `category: "atmospheric"` hint to the signal
//     if that turns out to be wrong for techs in practice.
//   - EVAP vapor pressure: SI is pascal, US scan tools typically inH2O.
//     We convert to PSI for now; very small numbers (0.0X psi) — may want
//     inH2O later.
//   - Fuel level: percentage on every modern vehicle; pass through.
//   - MAF: kept in g/s in both systems (universal tech convention).
//   - Engine torque, axle torque: Nm in OBDb; converted to lb-ft.
// ----------------------------------------------------------------------------

export type UnitSystem = "imperial" | "metric";

export const DEFAULT_UNIT_SYSTEM: UnitSystem = "imperial";

export interface FormattedValue {
  text: string; // e.g. "192" or "+14.5" or "—"
  unit: string; // e.g. "°F", "mph", "psi", "" for unitless
  // The internal display-side numeric (post-conversion) — exposed so the
  // Claude integration can log "RPM: 2400 RPM" with both number and unit.
  numeric: number | null;
}

// Convert raw → display numeric for a given OBDb unit and target system.
// Pass-through if no conversion applies. Unknown units fall back to the
// raw value with no conversion.
export function convertValue(
  raw: number | null,
  unit: string | null,
  system: UnitSystem = DEFAULT_UNIT_SYSTEM,
): { value: number | null; displayUnit: string } {
  if (raw == null) return { value: null, displayUnit: shortUnit(unit, system) };
  if (!unit) return { value: raw, displayUnit: "" };

  if (system === "metric") {
    // Metric mode: keep SI as-is. The OBDb units already are SI for the
    // categories we'd convert.
    return { value: raw, displayUnit: shortUnit(unit, system) };
  }

  switch (unit) {
    case "celsius":
      return { value: raw * 1.8 + 32, displayUnit: "°F" };
    case "fahrenheit":
      return { value: raw, displayUnit: "°F" };
    case "kilometersPerHour":
      return { value: raw / 1.609344, displayUnit: "mph" };
    case "milesPerHour":
      return { value: raw, displayUnit: "mph" };
    case "kilopascal":
      return { value: raw / 6.89476, displayUnit: "psi" };
    case "pascal":
      return { value: raw / 6894.76, displayUnit: "psi" };
    case "bar":
      return { value: raw * 14.5038, displayUnit: "psi" };
    case "kilometers":
      return { value: raw / 1.609344, displayUnit: "mi" };
    case "miles":
      return { value: raw, displayUnit: "mi" };
    case "liters":
      return { value: raw / 3.785411784, displayUnit: "gal" };
    case "newtonMeters":
    case "newton_meters":
      return { value: raw / 1.35582, displayUnit: "lb-ft" };
    // Everything below is system-neutral.
    case "revolutionsPerMinute":
      return { value: raw, displayUnit: "RPM" };
    case "percent":
      return { value: raw, displayUnit: "%" };
    case "volts":
      return { value: raw, displayUnit: "V" };
    case "millivolts":
      return { value: raw, displayUnit: "mV" };
    case "amperes":
      return { value: raw, displayUnit: "A" };
    case "gramsPerSecond":
      return { value: raw, displayUnit: "g/s" };
    case "degrees":
      return { value: raw, displayUnit: "°" };
    case "seconds":
      return { value: raw, displayUnit: "s" };
    case "minutes":
      return { value: raw, displayUnit: "min" };
    case "hours":
      return { value: raw, displayUnit: "h" };
    case "grams":
      return { value: raw, displayUnit: "g" };
    case "nanograms":
      return { value: raw, displayUnit: "ng" };
    case "kilograms":
      return { value: raw * 2.20462, displayUnit: "lb" };
    case "scalar":
    case null:
    case undefined:
    case "":
      return { value: raw, displayUnit: "" };
    // Binary unit codes are handled by formatStatusValue, not here.
    case "yesno":
    case "noyes":
    case "offon":
      return { value: raw, displayUnit: "" };
    default:
      return { value: raw, displayUnit: unit };
  }
}

// Compact "short" unit label used by gauges. Same return as convertValue's
// displayUnit but exposed for callers that just need the label.
function shortUnit(unit: string | null, system: UnitSystem): string {
  if (!unit) return "";
  const c = convertValue(0, unit, system);
  return c.displayUnit;
}

// Round a number to a reasonable number of decimal places for live-data
// display. Integers stay integers; small fractional values keep more
// precision than large ones so battery voltage (12.42) reads usefully
// without making RPM (2438) look weird.
function smartFixed(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs >= 1000) return String(Math.round(v));
  if (abs >= 100) return v.toFixed(0);
  if (abs >= 10) return v.toFixed(1);
  if (abs >= 1) return v.toFixed(2);
  return v.toFixed(3);
}

// Render a converted numeric value for the gauge display, applying smart
// rounding and signed-prefix conventions for trim-style readings.
export function formatLiveValue(
  raw: number | null,
  unit: string | null,
  options?: { system?: UnitSystem; signed?: boolean },
): FormattedValue {
  const system = options?.system ?? DEFAULT_UNIT_SYSTEM;
  const { value, displayUnit } = convertValue(raw, unit, system);
  if (value == null) return { text: "—", unit: displayUnit, numeric: null };
  let text = smartFixed(value);
  if (options?.signed && value > 0) text = `+${text}`;
  return { text, unit: displayUnit, numeric: value };
}

// Heuristic — values that should display with a signed prefix when
// positive (fuel trims, anything with "trim" in the name). The polling
// driver populates signal.name on each LiveValue, so this looks there.
export function isSignedDisplay(signalName: string | null | undefined): boolean {
  if (!signalName) return false;
  return /trim|advance|deviation/i.test(signalName);
}

// ----------------------------------------------------------------------------
// Status-signal formatting (bit-level, enum, on/off, ready/not-ready).
//
// These signals don't render as numeric gauges. The Status panel renders
// the (label, formatted) pair returned by this function.
// ----------------------------------------------------------------------------

export interface StatusValue {
  // Human-readable rendering: "ON" / "OFF", "Ready" / "Not Ready", "3", etc.
  text: string;
  // Optional severity for color-coding in the UI.
  severity?: "alert" | "warning" | "ok" | "neutral";
}

export function formatStatusValue(
  raw: number | null,
  unit: string | null,
  enumMap?: Record<string, unknown> | null,
): StatusValue {
  if (raw == null) return { text: "—", severity: "neutral" };

  // Enum-mapped signals: look up the value in the map. The map shape is
  // OBDb's `{ "<int>": { value: "...", description: "..." } }`.
  if (enumMap && Object.keys(enumMap).length > 0) {
    const key = String(Math.trunc(raw));
    const entry = enumMap[key];
    if (entry && typeof entry === "object") {
      const e = entry as { value?: string; description?: string };
      return {
        text: e.value ?? e.description ?? key,
        severity: "neutral",
      };
    }
    return { text: key, severity: "neutral" };
  }

  // OBDb binary units. The convention is:
  //   yesno: 1 = "Yes", 0 = "No"  — readiness "supported" flags
  //   noyes: 0 = "Yes", 1 = "No"  — readiness "complete/not_complete"
  //                                  (counterintuitively, 0 = ready)
  //   offon: 0 = "Off", 1 = "On"  — MIL, lamps
  if (unit === "yesno") {
    return raw === 1
      ? { text: "Yes", severity: "ok" }
      : { text: "No", severity: "neutral" };
  }
  if (unit === "noyes") {
    return raw === 0
      ? { text: "Ready", severity: "ok" }
      : { text: "Not Ready", severity: "warning" };
  }
  if (unit === "offon") {
    return raw === 1
      ? { text: "ON", severity: "alert" }
      : { text: "Off", severity: "ok" };
  }

  // Counts (DTC_CNT, etc.) — plain integer with a "count > 0" highlight.
  if (unit === "scalar" || !unit) {
    const n = Math.trunc(raw);
    return {
      text: String(n),
      severity: n > 0 ? "warning" : "ok",
    };
  }

  // Fallback — just render the number with the raw unit. (Shouldn't hit
  // for status signals if the catalog is well-formed.)
  return { text: smartFixed(raw) + (unit ? ` ${unit}` : ""), severity: "neutral" };
}
