// ----------------------------------------------------------------------------
// diagramLookup.js — in-app diagram retrieval (fuse / component / wiring).
//
// Search-engine posture: find REAL open-web diagrams via Brave Image Search and
// surface them with attribution + a tap-through to the source. We never store,
// ingest, or relabel them as Vulcan data (Brave ToS §3(b): transient/in-memory
// only — no persistent cache). The model NEVER fabricates a diagram; this module
// only returns real image results or an honest "search the web" fallback link.
//
// V1 shipping policy (validated by the diagram probes — see the §6.1-style
// investigation):
//   - fuse:      IMAGES, with the §3 YEAR/GENERATION GUARD (dedicated year-keyed
//                fuse hosts; ~92% coverage). A wrong-generation fuse box looks
//                plausible and a tech acts on it physically, so a result is shown
//                ONLY when the queried year is verified in the title/URL/range.
//   - component: IMAGES in NARROW HIGH-PRECISION mode — surfaced ONLY from a
//                year-verified trustworthy source (dedicated diagram host or an
//                OEM parts-catalog page whose URL/title carries the queried year).
//                ~35% coverage by design; every other query falls to the link.
//                The §3 guard is identical and absolute here — never a best guess.
//   - wiring / anything else: LINKS-ONLY (open-web image quality is poor and the
//                good sources are provenance-dodgy — see the probe).
//
// The universal "search the web" fallback (a prebuilt query URL) is ALWAYS
// returned, on every type and every empty result, so no request dead-ends.
//
// Fail-soft: a missing BRAVE_API_KEY or any Brave/network error degrades to
// links-only (never throws, never 500s the caller).
// ----------------------------------------------------------------------------

const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/images/search";
const RAW_COUNT = 12;       // raw results pulled before filtering
const TOP_N = 3;            // results surfaced after filtering
const CACHE_TTL_MS = 10 * 60 * 1000; // transient in-memory only (Brave ToS — no persistent cache)
export const ATTRIBUTION = "Powered by Brave";

// Which types surface images, and how each query is phrased.
// "parts" (A+ build, 2026-07-02): ANY named assembly/system diagram ("oil pan",
// "cooling system", "front suspension") via a REQUIRED free-text subject. This
// broadens what is SEARCHED, not what is TRUSTED: filtering runs the same
// NARROW high-precision component rule (dedicated diagram hosts + year-keyed
// OEM catalogs, yearVerified mandatory — the §3 guard, unchanged and absolute).
// The three tuned types keep byte-for-byte behavior. Wiring/schematic-shaped
// subjects route to the links-only path (same rationale as the wiring type).
export const TYPE_CONFIG = {
  fuse:      { images: true,  mode: "fuse",      phrase: "fuse box diagram" },
  component: { images: true,  mode: "component", phrase: "serpentine belt diagram" },
  wiring:    { images: false, mode: "links",     phrase: "wiring diagram" },
  parts:     { images: true,  mode: "component", phrase: null /* subject-driven */ },
};
export const DIAGRAM_TYPES = Object.keys(TYPE_CONFIG);

// ---- "parts" subject handling ----------------------------------------------
// Free text from the model, so sanitize hard before it reaches a query URL:
// lowercase, whitelist [a-z0-9 -], collapse whitespace, cap length. Returns ""
// when nothing usable survives (the caller falls to links-only).
export const SUBJECT_MAX_LEN = 40;
export function sanitizeSubject(subject) {
  return String(subject || "")
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SUBJECT_MAX_LEN)
    .trim();
}

// Wiring/schematic-shaped subjects go links-only — open-web image quality and
// provenance for schematics is poor (the wiring-type probe finding applies to
// the subject route too; never a lower bar via the parts door).
export function isWiringShapedSubject(subject) {
  return /\b(wiring|schematic|circuit|electrical|harness|pinout)\b/i.test(subject);
}

// A "parts" lookup can surface IMAGES only with a usable, non-wiring subject.
export function partsSubjectUsable(subject) {
  const s = sanitizeSubject(subject);
  return s.length > 0 && !isWiringShapedSubject(s);
}

// ---- host / title classification (tuned across the probe passes) -----------
const DENY_HOSTS = [
  "pinterest.", "facebook.", "youtube.", "youtu.be", "instagram.", "tiktok.",
  "amazon.", "ebay.", "walmart.", "aliexpress.", "reddit.", "twitter.", "x.com",
  "quora.", "etsy.", "alibaba.", "scribd.",
  // aftermarket parts STORES (product photos, not diagrams)
  "go-parts", "rockauto", "fordpartsgiant", "partsgiant", "autozone", "oreilly",
  "advanceauto", "napaonline", "summitracing", "carid", "partsgeek", "parts-geek",
  "carparts", "buyautoparts", "partsouq", "mazdastuff", "fcpeuro", "ecstuning",
  // how-to VIDEO hosts
  "1aauto", "howtoo", "vimeo",
];
const DENY_TITLE = [
  /how to|replace|replacement|install/i,
  /duralast|gates |dayco|bando|continental |micro-?v|goodyear|acdelco|motorcraft/i,
  /\bsku\b|compatible with|image \d+ of \d+|\bfits?\b.*\d{4}/i,
  /tensioner\b(?!.*diagram)/i,
];
const KEEP_TITLE = [/diagram/i, /routing/i, /belts? *(?:&|and) *pulleys/i, /serpentine/i, /pulley/i, /fuse/i, /relay/i];

// Dedicated diagram hosts (high precision) for each mode.
const FUSE_PREFER = ["fuse-box.info", "fusesdiagram", "fuseboxdiagrams", "startmycar", "dot.report", "autogenius", "ninjafix", "mywikimotors"];
const COMPONENT_DEDICATED = ["serpentinebeltdiagram", "fixya", "2carpros"];
// OEM dealer parts-catalog signature: year-keyed URL (year IN the url) on a parts catalog.
const OEM_CATALOG_HOST = /(parts\.|oempartsonline|partsnow|oemparts)/i;

function host(u) { try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; } }

// ---- §3 YEAR/GENERATION GUARD ---------------------------------------------
// Parse every 4-digit year and year-range from text; the queried year must be
// an explicit match or fall inside a range. No year present => NOT verified
// (drop — better an honest fallback than a confident wrong-generation diagram).
export function yearVerified(text, year) {
  if (!year) return false;
  const y = Number(year);
  if (!Number.isInteger(y)) return false;
  const s = String(text || "");
  // ranges first: 2015-2018 / 2015–2018 / 2015 - 2018
  const ranges = s.matchAll(/(19|20)\d{2}\s*[-–—]\s*(19|20)\d{2}/g);
  for (const m of ranges) {
    const a = Number(m[0].slice(0, 4));
    const b = Number(m[0].slice(-4));
    if (a <= y && y <= b) return true;
  }
  // explicit individual years (covers comma lists "2013, 2014, … 2018")
  const years = new Set((s.match(/(19|20)\d{2}/g) || []).map(Number));
  return years.has(y);
}

// Classify one raw Brave result for a given mode. Returns the surfaced shape
// + a `pass` flag. PURE (no I/O) so it's unit-testable without the API.
export function classifyResult(r, vehicle, mode) {
  const src = r.url || r.source || "";
  const h = host(src);
  const title = r.title || "";
  const hay = `${title} ${src}`;
  const haySquash = hay.toLowerCase().replace(/[^a-z0-9]/g, "");
  const modelTok = String(vehicle.model || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const modelMatch = modelTok.length > 1 && haySquash.includes(modelTok);
  const denyHost = DENY_HOSTS.some((d) => h.includes(d));
  const denyTitle = DENY_TITLE.some((re) => re.test(title));
  const diagramish = KEEP_TITLE.some((re) => re.test(hay));
  const verified = yearVerified(hay, vehicle.year); // checks title + url
  const oemCatalog = OEM_CATALOG_HOST.test(h) && /(19|20)\d{2}/.test(src) && /diagram|belts?|pulley/i.test(hay);

  let trustedSource;
  if (mode === "fuse") {
    // dedicated fuse hosts OR any non-denied diagram-titled page (fuse hosts are
    // reliable + year-keyed; the year guard does the heavy lifting).
    trustedSource = FUSE_PREFER.some((p) => h.includes(p)) || diagramish;
  } else {
    // NARROW: only dedicated diagram hosts or year-keyed OEM catalogs.
    trustedSource = COMPONENT_DEDICATED.some((p) => h.includes(p)) || oemCatalog;
  }

  const pass = !denyHost && !denyTitle && diagramish && modelMatch && verified && trustedSource;
  return {
    pass,
    domain: h,
    title,
    sourceUrl: src,
    thumbnailUrl: r.thumbnail?.src || r.properties?.url || "",
    _prefer: FUSE_PREFER.concat(COMPONENT_DEDICATED).some((p) => h.includes(p)),
  };
}

export function filterResults(rawResults, vehicle, mode) {
  const scored = (rawResults || [])
    .map((r) => classifyResult(r, vehicle, mode))
    .filter((c) => c.pass && c.thumbnailUrl);
  scored.sort((a, b) => (b._prefer ? 1 : 0) - (a._prefer ? 1 : 0));
  return scored.slice(0, TOP_N).map(({ domain, title, sourceUrl, thumbnailUrl }) => ({
    domain, title, sourceUrl, thumbnailUrl,
  }));
}

// ---- query + fallback link -------------------------------------------------
// `subject` applies only to type "parts" (sanitized here; ignored elsewhere).
export function buildQuery(vehicle, type, subject) {
  if (type === "parts") {
    const subj = sanitizeSubject(subject);
    return `${vehicle.year} ${vehicle.make} ${vehicle.model} ${subj} diagram`
      .replace(/\s+/g, " ")
      .trim();
  }
  const cfg = TYPE_CONFIG[type] || { phrase: "diagram" };
  return `${vehicle.year} ${vehicle.make} ${vehicle.model} ${cfg.phrase}`.trim();
}
// Universal fallback: a normal browser image-search the tech taps to open.
// Subject-specific for "parts" — an upgrade over a flat refusal: even a
// links-only miss hands the tech a query already scoped to their assembly.
export function buildWebSearchUrl(vehicle, type, subject) {
  return `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(buildQuery(vehicle, type, subject))}`;
}

// ---- transient in-memory cache (Brave ToS: no persistent storage) ----------
const _cache = new Map();
function cacheGet(key) {
  const e = _cache.get(key);
  if (!e) return null;
  if (Date.now() > e.expires) { _cache.delete(key); return null; }
  return e.value;
}
function cacheSet(key, value) { _cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS }); }

// ---- main ------------------------------------------------------------------
// Returns { type, images: [...], webSearchUrl, attribution, supported }.
// Never throws. `supported` = whether this request surfaces images at all.
// `subject` applies only to type "parts" (required there — empty/wiring-shaped
// subjects go links-only).
export async function diagramLookup(vehicle, type, subject) {
  const cfg = TYPE_CONFIG[type];
  const webSearchUrl = buildWebSearchUrl(vehicle, type, subject);
  const imagesPossible =
    Boolean(cfg && cfg.images) && (type !== "parts" || partsSubjectUsable(subject));
  const base = { type, images: [], webSearchUrl, attribution: ATTRIBUTION, supported: imagesPossible };

  // links-only requests (wiring / unknown / unusable parts subject) — no image call.
  if (!imagesPossible) return base;

  const subjKey = type === "parts" ? `|${sanitizeSubject(subject)}` : "";
  const key = `${type}${subjKey}|${vehicle.year}|${String(vehicle.make).toLowerCase()}|${String(vehicle.model).toLowerCase()}`;
  const cached = cacheGet(key);
  if (cached) return { ...base, images: cached };

  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey) return base; // fail-soft: no key -> links-only

  try {
    const url = `${BRAVE_ENDPOINT}?q=${encodeURIComponent(buildQuery(vehicle, type, subject))}&count=${RAW_COUNT}&safesearch=strict&country=us`;
    const res = await fetch(url, {
      headers: { Accept: "application/json", "Accept-Encoding": "gzip", "X-Subscription-Token": apiKey },
    });
    if (!res.ok) return base;
    const json = await res.json();
    const images = filterResults(json.results || [], vehicle, cfg.mode);
    cacheSet(key, images);
    return { ...base, images };
  } catch {
    return base; // network/parse error -> links-only
  }
}
