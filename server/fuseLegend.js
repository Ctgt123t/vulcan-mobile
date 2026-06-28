// ----------------------------------------------------------------------------
// Pure helpers for fuse-legend retrieval (Fix 2) — NO DB / IO, so they unit-test
// cleanly (scripts/verifyFuseRetrieval.js). supabaseSpecs.lookupFuse does the DB
// query and delegates shaping + circuit-keyword filtering to these functions.
//
// Fuse data lives in component_fact: component = "fuse N", value_text = "15A",
// and the CIRCUIT the fuse powers is only in verbatim_quote ("4 15A AUDIO NAVI").
// verbatim_quote is the GROUND TRUTH; circuit_text is a convenience parse and is
// never the sole basis for a stated claim (the raw quote always travels with it).
// ----------------------------------------------------------------------------

// Full fuse legends top out ~100 rows; cap for safety on the returned block.
export const FUSE_ROW_CAP = 160;

// Short, extensible circuit synonym groups: a tech's everyday word ("wipers") ->
// the abbreviations legends actually print ("WIP", "WSW"). Deliberately NOT
// exhaustive — extend as real misses show up. Matching is substring both ways so
// "wiper" hits "wipers" and vice-versa.
export const CIRCUIT_SYNONYMS = [
  ["wiper", "wipers", "wip", "wsw", "windshield", "washer"],
  ["cigarette", "cigar", "lighter", "12v", "power outlet", "power point", "accessory", "acc", "outlet", "socket"],
  ["horn"],
  ["radio", "audio", "navi", "navigation", "infotainment", "stereo"],
  ["headlight", "headlamp", "head lamp", "low beam", "high beam", "hlp"],
  ["fuel pump", "fuel", "f/pump"],
  ["a/c", "ac", "air conditioning", "hvac", "climate", "blower", "heater", "heat"],
  ["abs", "brake"],
  ["airbag", "air bag", "srs"],
  ["power window", "p/w", "window", "windows"],
  ["door lock", "lock", "central lock", "d/lock"],
  ["start", "starter", "ignition", "ig1", "ig2"],
  ["tail", "taillight", "tail light", "park", "parking light"],
  ["turn signal", "turn", "blinker", "hazard", "flasher"],
  ["seat", "heated seat", "seat heater"],
  ["sunroof", "moonroof"],
  ["trailer", "tow", "towing"],
  ["ecu", "pcm", "ecm", "engine control"],
  ["fog", "fog lamp", "fog light"],
  ["mirror", "mirrors"],
  ["defrost", "defog", "rear defrost"],
];

// Expand a tech's circuit word into the set of terms to search the legend for.
export function expandCircuit(keyword) {
  const k = String(keyword ?? "").trim().toLowerCase();
  if (!k) return [];
  const terms = new Set([k]);
  for (const group of CIRCUIT_SYNONYMS) {
    if (group.some((g) => k.includes(g) || g.includes(k))) {
      for (const g of group) terms.add(g);
    }
  }
  return [...terms];
}

// "4 15A AUDIO NAVI" -> "AUDIO NAVI" (strip leading position number + amperage).
// Falls back to the whole quote if it doesn't fit the expected shape.
export function parseCircuitText(verbatim) {
  let s = String(verbatim ?? "").trim();
  if (!s) return "";
  s = s.replace(/^\s*\d+\s+/, ""); // leading fuse number
  s = s.replace(/^\s*\d+(\.\d+)?\s*a\b\s*/i, ""); // leading amperage (15A / 7.5A / 15 A)
  return s.trim();
}

export function fuseNumber(component) {
  const m = String(component ?? "").match(/(\d+)/);
  return m ? m[1] : "";
}

// Shape one raw DB row { component, value_text, verbatim_quote } -> public row.
// The data has TWO representations of a fuse row:
//   - NUMBERED ("fuse 3" / value "30A" / verbatim "3 30A Windshield wiper"):
//     position in `component`, circuit in the verbatim tail.
//   - CIRCUIT-NAMED ("Engine Compartment Fuse - Front Wiper Motor" / "30 A" /
//     verbatim "Front Wiper Motor 30 A"): the component IS the circuit/location
//     name, with NO position number. (Calling fuseNumber on these would wrongly
//     grab a digit out of e.g. "Fuse Box 1" — so only numbered rows get a
//     fuse_number.)
export function shapeFuseRow(r) {
  const comp = String(r.component ?? "");
  const numbered = /^\s*fuse\s+\d/i.test(comp);
  if (numbered) {
    return {
      fuse_number: fuseNumber(comp),
      amperage: r.value_text ?? "",
      circuit_text: parseCircuitText(r.verbatim_quote),
      verbatim_quote: r.verbatim_quote ?? "",
    };
  }
  // Circuit-named: the position (when there is one) sits at the START of the
  // verbatim ("24 Horn 10 A" -> 24; "Front Wiper Motor 30 A" -> none). Clean a
  // leading "… Fuse [N] - " location prefix off the component for the circuit.
  const lead = String(r.verbatim_quote ?? "").match(/^\s*(\d+)\b/);
  const circuit = comp.replace(/^.*?fuse\s*\d*\s*-\s*/i, "").trim() || comp.trim();
  return {
    fuse_number: lead ? lead[1] : "",
    amperage: r.value_text ?? "",
    circuit_text: circuit,
    verbatim_quote: r.verbatim_quote ?? "",
  };
}

// Dedup (by component+quote) + numeric-sort raw rows into shaped rows.
export function shapeFuseRows(rawRows) {
  const seen = new Set();
  const rows = [];
  for (const r of rawRows || []) {
    const key = `${r.component}|${r.verbatim_quote}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(shapeFuseRow(r));
  }
  rows.sort((a, b) => (Number(a.fuse_number) || 0) - (Number(b.fuse_number) || 0));
  return rows;
}

// Filter shaped rows by a circuit keyword (synonym-expanded substring on the
// quote + parsed circuit). Returns { rows, matched }: matched=true when the
// keyword hit specific fuse(s); when it doesn't match (or no keyword), the FULL
// legend is returned with matched=false so the model can locate the circuit
// itself from the verbatim text (never fabricating).
export function filterByCircuit(rows, circuit) {
  const terms = expandCircuit(circuit);
  if (terms.length === 0) return { rows, matched: false };
  const hit = (rows || []).filter((r) => {
    const hay = `${r.verbatim_quote} ${r.circuit_text}`.toLowerCase();
    return terms.some((t) => hay.includes(t));
  });
  if (hit.length > 0) return { rows: hit, matched: true };
  return { rows, matched: false };
}
