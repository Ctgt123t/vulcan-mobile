# VULCAN — UNIFIED DATA LAYER STRATEGY

> **Purpose of this document.** This is a standing strategy document for Vulcan's unified vehicle-data layer (the "spec database" and everything around it). It captures the *plan*, the *reasoning behind each decision*, a *concrete proposed schema*, and the *open questions still to resolve* — so that a fresh conversation, a future session, or Claude Code can pick this up fully oriented. It is intended to live in the Vulcan Project knowledge alongside the project brief and CLAUDE.md. Keep it current as decisions firm up.
>
> **Status:** Foundation BUILT & VERIFIED LIVE. Extraction engine PROVEN via first slice test (see §6.1), then PRODUCTIONIZED in Batch A — trim-before-extract, widened `spec_type` vocab (+ an `other`-label rule), and persisted audit columns (absolute page + `verbatim_quote`, both NOT NULL) are DONE & validated, plus a per-run snapshot dump and chunk→absolute page remap. **Measured cost: ~$2.2 per large manual (~66% cut from the $6.31 full-manual baseline) — NOT the originally-assumed sub-$1** (the assumption was specs living in ~50–80 pages; they actually span ~170 — see §6.1). A `--full` baseline diff proved the trim drops **zero core specs**. NEXT: Tier 1 feed at scale. Still deferred: stronger/fuzzy dedup, and schema expansion for richer manual data (fuses/bulbs/towing/etc.). The six open questions are resolved or scoped (§9).
>
> **What's live:** `pg` (node-postgres) connection in `server/db.js` over the transaction pooler (port 6543), reading `SUPABASE_DB_URL`; tables `source`, `vehicle_variant` (8-col granular UNIQUE), `spec`, `component_fact`, `spec_miss`, each fact carrying a NOT NULL `source_id` provenance FK; controlled vocab via CHECK constraints; numbered SQL migrations run manually via `npm run migrate` (tracked in `schema_migrations`). Fail-soft: missing env var is fatal at startup, but a present-but-unreachable DB logs a loud error and keeps the core app (OBD2/Claude endpoints) serving — the spec DB is an enhancement over the honest fallback, never a hard dependency. RLS enabled; the pooler owner-role bypasses it. Existing JSON caches untouched; JSON→Postgres migration of those still deferred. Extraction PoC script committed at `server/scripts/extractFromPdf.js` (manual-run, not wired to any endpoint).
>
> **Re-verified against the codebase (2026-06-21).** The "what's live" above still matches the code exactly: `server/db.js` (single bounded `pg.Pool` over `SUPABASE_DB_URL`, pooler port 6543, `isDbReady()`/`initDb()` startup probe, fail-loud on a missing URL); **two** numbered migrations — `0001_init.sql` (tables `source`, `vehicle_variant`, `spec`, `component_fact`, `spec_miss`, each fact carrying a NOT NULL `source_id` FK) and `0002_widen_specs_and_audit_columns.sql` (widened `spec_type` vocab + NOT NULL `page`/`verbatim_quote` audit columns); the read path `server/specProviders/supabaseSpecs.js` is **READ-ONLY on `spec`/`component_fact`** (joined to `vehicle_variant`) and **writes only `spec_miss`** (fail-soft); the extraction engine is the sole writer of specs, a manual-run script at `server/scripts/extractFromPdf.js` (not wired to any endpoint); `/api/ask` routes spec intent through the `spec_lookup` tool loop (`server/askToolLoop.js`). **Nothing else in this document is implemented in code** — the schema beyond these five tables, the Tier-1 real feed, normalization (§5.B), dedup, and Batch B/C are PLAN, not built. This doc is the standing strategy/plan; treat anything outside this verified-state block as proposed-not-yet-implemented. The next concrete step (per the founder) is fleshing out the database from this accurate baseline.
>
> **CURRENT POSTURE — PAUSED IN A KNOWN-GOOD STATE (deliberate, not abandoned); its real feed is a pre-launch track.** The data layer is at a clean resting point. The pause was originally taken to build the diagnostic engine's Stage 2 — **that engine is now COMPLETE and hardware-validated (2016 F-350, 2026-06-14; see CLAUDE.md)**, and the data layer is *still* parked here because its remaining work belongs in the **pre-launch** window, not because anything blocks it. What is DONE: foundation live; extraction engine productionized (Batch A) **and validated cross-manufacturer** (run on GMC Sierra + Ford + Honda + Subaru owner's manuals — see §6.1); the spec path wired into the app under full Option C (verified hit / honest fallback / miss-logging, fail-soft); and **tool-use spec routing live in `/api/ask`** (the `spec_lookup` agentic loop — see CLAUDE.md → Backend → vehicle spec retrieval). What remains is **deliberately deferred** — see the deferred-work ledger (§11) for each item and its window. The two reasons this pause was safe through Stage 2 (and remains so): (1) the engine reasons over OBD2 data + already-stored DB facts, so it never depended on the deferred extraction/normalization work; (2) the pre-launch items (normalization §5.B, structured input) and the before-real-feed items (page-remap, Honda fixes) are flagged for their windows so they are not lost — "parked" here means *decided and resting*, not forgotten.

---

## 1. Why this exists — the core insight

Vulcan's value is an AI that **reasons like a master technician over real vehicle data**. The reliability of that depends on a single architectural principle, learned the hard way through the Ask Vulcan spec failures:

> **Verified data is the factual foundation; AI is the reasoning layer on top. The model must never be the source of truth for a specific fact it would otherwise recall from memory.**

When the model recites a fact from training (e.g. "2023 Impreza oil capacity = X"), it hallucinates — confidently, unpredictably, and differently on each run. This was proven repeatedly: same model, same question, different wrong answers; it even contradicted a part number it cited in its own response. No prompt tweak and no model upgrade fixes this, because there is no stable failure to target. **The only reliable fix is verified data.**

The same model reasoning *over facts it is given* (real OBD2 readings, injected DTC definitions, retrieved specs) is reliable — that is what current LLMs are good at, and that is what the diagnostic engine does. The database is what systematically converts Vulcan from "trust the AI's memory" to "trust the AI's reasoning over real data." **Every fact moved from model-recall to database-provided is a hallucination structurally eliminated.**

This makes the data layer the **keystone** of the whole project, not just a feature: it is what makes the AI trustworthy enough for the product vision.

---

## 2. Scope — the five data types (and what's already solved)

"Build a vehicle database" is really **five different problems**. Three are already solved; two are the actual gap. Recognizing this shrinks the project from "import all vehicle data" (overwhelming, stalls) to "fill two specific gaps" (tractable).

| # | Data type | What it answers | Status |
|---|---|---|---|
| 1 | **DTC definitions** | What does P0442 mean? | ✅ **Solved** — 18,805 codes, manufacturer-specific, Claude-fallback caching |
| 2 | **VIN decoding** | VIN → year/make/model/engine | ✅ **Mostly solved** — NHTSA; self-hosted vPIC on roadmap |
| 3 | **PID / signal definitions** | What live data does this vehicle expose? | ✅ **Solved** — OBDb (CC-licensed), trim/year filtered |
| 4 | **Service specs** | Oil capacity, torques, fluids, intervals | ❌ **THE GAP** — Vehicle Finder was a dud (3 spec types only, sparse) |
| 5 | **Component / configuration facts** | Filter type, location, what's-where | ❌ **NEW GAP** — identified from the Subaru filter fabrication; model invents these as confidently as numbers |

**Decision — scope:** Build a **unified store architecture** that has a home for all five types, but **populate in priority order**: fill the empty rooms first (4 and 5), migrate the already-working three (1, 2, 3) later, deliberately, only once the new store is proven.

**Reasoning:** "Unify everything" is correct as an *end-state architecture* but dangerous as a *build order*. The DTC/PID/VIN systems contain hard-won correctness (the phantom-code parser rewrite, the O2 voltage fix, the spec-series fix). Rebuilding them all at once to "unify" would reopen solved problems and risk regression for no new capability. Instead: design one schema that *can* hold all five, deliver immediate value by filling the real gaps (specs + component facts), and absorb the working three on a safe schedule.

---

## 3. Strategy — generation from source documents

**Decision — primary strategy:** Generate the database by having **Claude extract structured data from source documents**, into Vulcan's own verified store.

**Reasoning — why generation over aggregation:**
- **Aggregation** (pull in existing structured databases) is the path that kept stalling. The free sources are thin (Vehicle Finder), the good ones are proprietary and legally off-limits (Identifix, AllData, Mitchell1, Innova), and you're at the mercy of their coverage/licensing.
- **Generation** gives Vulcan control over the three things Vehicle Finder failed at: **coverage** (you decide what's in it), **granularity** (build it trim-aware from day one — the "Sierra" vs "Sierra 1500" lesson), and **fail-loud behavior** (you decide what an unknown returns).
- **The pattern is already proven in production:** the DTC Claude-fallback does exactly this — when a code isn't in the static DB, Claude produces a structured definition via tool use, cached so it's generated only once. Scaling a trusted existing technique, not inventing a new one.
- It converts existing Claude spend from a recurring per-call cost into an **asset-building** activity: generate-and-store-once, never pay to generate again. The opposite of Vehicle Finder's per-call dependency.

**The mortal danger (must be designed around):** Generation done naively is **the Ask Vulcan hallucination problem in a can — worse, because a wrong value written to a "verified" database is frozen, trusted, and served with authority forever.** The entire viability of this strategy rests on one rule:

> **Claude extracts from a provided source document; Claude does NOT generate facts from memory.** "Here is the Subaru maintenance table, extract the oil capacity" (reliable — reading a provided document) is categorically different from "What's the oil capacity for a 2023 Impreza?" (hallucination-bait — recalling from memory). The source document is the ground truth; Claude is the extraction engine, not the source.

This is the same reasoning-over-provided-facts vs. generating-facts distinction that governs the diagnostic engine.

---

## 4. Verification standard — Option C (strict store + honest fallback + miss-logging)

**Decision:** Strict storage, honest live fallback, miss-logging to drive acquisition.

Three layers, no contamination between them:

1. **Storage is STRICT.** Only doc-extracted, provenance-tracked specs enter the database. "In the DB" *always* means "verified from a real source." This keeps the database categorically trustworthy and is what makes it an asset. **Non-negotiable.**
2. **The miss path is HONEST and LIVE (never stored).** When the DB has no entry, the app falls through to the existing guard-railed Claude, which gives a best-effort answer explicitly framed as "I don't have this confirmed, here's the likely value, verify it." This answer is **ephemeral** — shown once, never written back to the database as if it were data.
3. **Miss-logging drives acquisition.** Every DB miss is logged ("techs asked for 2023 Tacoma trans-fluid spec 14×, no entry"). The miss-log becomes the *prioritization queue* for source acquisition — gaps tell you which documents to get next, ranked by real demand. (Metrics scaffolding already exists — the bigger cousin of the `noVehicleFallthroughs` counter.)

**Why not the alternatives:**
- **Strict-only (A)** is correct on storage but was missing the fallback framing — handled here by layer 2.
- **Tiered (B) — storing Claude-memory specs flagged "unverified" — was rejected.** It industrializes the Ask Vulcan failure and gives it false solidity. Labels erode in users' minds over repetition ("the app gave me a number" becomes trusted); and the moment the DB contains unverified entries, "it's in the DB" stops meaning "it's true," destroying the one property that made building a database worthwhile. The fix for misses is a *guess shown once, clearly as a guess* (layer 2) — NOT *a guess written into the verified store forever* (B).

**The accepted cost:** the database is **sparse early and fills over time**, at a rate governed by source acquisition. This is fine: sparse-early means *honest*-early, not *broken*-early, because the guard-railed fallback means the app never lies on day one (it either knows-verified or says-verify) and grows more *complete* over time.

---

## 5. Proposed schema (DRAFT — not final)

Designed to (a) hold all five data types in one store, (b) be trim/engine-granular from the start, (c) carry provenance for every fact, and (d) make "fail loud" natural (a missing row is an explicit miss, never a silent wrong substitution).

### 5.1 Core principle: a vehicle is identified granularly

The single biggest spec-data bug was coarse vehicle identity ("Sierra" silently returning a wrong record vs. "Sierra 1500"). The schema must make the vehicle key granular and explicit.

```
vehicle_variant
---------------
id                 (PK)
year               int          -- e.g. 2023
make               text         -- canonical, e.g. "GMC" (store canonical; map aliases separately)
model              text         -- e.g. "Sierra"
series_trim        text         -- e.g. "1500" / "1500 Denali"  (the disambiguator)
engine_code        text         -- e.g. "FB20", "L83 5.3L V8"
engine_descriptor  text         -- human label, e.g. "5.3L 8-cyl"
drivetrain         text NULL    -- e.g. "4WD" where it disambiguates specs
market             text NULL     -- e.g. "US" (specs vary by market)
notes              text NULL
UNIQUE (year, make, model, series_trim, engine_code, drivetrain, market)
```

> **RESOLVED (5.A) — key on mechanical configuration, not trim badge; default to engine-level, split finer only where specs actually differ.** Specs diverge based on *mechanical* hardware (engine, sometimes drivetrain/transmission), not marketing trim. A "1500 Denali" and "1500 SLT" with the same engine take the same oil — the difference is cosmetic. But "1500" vs "2500" *is* mechanical (different trucks). So the real uniqueness key is `year + make + model + series_trim(where mechanical, e.g. 1500/2500) + engine + drivetrain(where it matters)`. Keep the trim/drivetrain columns so the schema *can* go fine, but **resolve queries at the engine level by default**, only splitting a spec to a finer key when you observe that the value actually differs (e.g. a trans-fluid capacity that varies 2WD vs 4WD on the same engine). Data-driven, not guessed — avoids both the coarse-wrong-record bug AND the fragmented-empty-rows failure. (This also means many apparent source "conflicts" — 6.C — are really a too-coarse key merging two real variants.)
>
> **RESOLVED (5.B) — NHTSA-canonical normalization for vehicle identity. CORE LANDED 2026-06-25 (A-lite) — see the #4 entry in §11 for what shipped (server-side resolver `canonicalVehicle.js` at lookup + extraction-write; `make_alias`/`model_alias` tables + in-code seed; fail-safe passthrough; `nhtsa_make` authority table created, import pending NHTSA recovery). Client-side input pickers (#14) are the fast-follow.** The remaining vehicle-key risk is *naming mismatch*: the same vehicle written three different ways (user free-text entry, the manual's title-page spelling at extraction-write, and the lookup query) silently fails to join, producing a false miss on data that IS in the DB. **Decision: NHTSA is the canonical naming authority.** All three points normalize *toward NHTSA's spelling* — user input is normalized on the way in, **extraction stores rows under the canonical NHTSA key (NOT the manual's title-page spelling)**, and lookups normalize before querying. One spelling, one join. This **pairs with structured input / pickers on manual entry** (constrain make/model/year at the UI so free-text drift never enters in the first place) — same decision, same pre-launch window. **WHY SAFE TO DEFER PAST STAGE 2:** Stage 2 reasons over OBD2 data + DB facts already keyed correctly at write time; it does not depend on resolving arbitrary manual-entry strings, so the normalization gap cannot block it. **WHY IT MUST LAND BEFORE LAUNCH:** real users typing a misspelled or non-canonical make/model will hit *false misses* on specs that exist — a trust-eroding failure in the exact place (spec lookup) the whole data layer exists to make trustworthy. So: parked behind Stage 2, but a hard pre-launch gate, paired with the pickers work. (This sits on top of 5.A's mechanical-key resolution — 5.A decides *which variant*, 5.B decides *that the names match at all*. The schema's "store canonical; map aliases separately" note on `make` is the seed of this; 5.B makes it a cross-cutting rule.)

### 5.2 Specs (data type 4) — key/value with provenance

```
spec
----
id                 (PK)
vehicle_variant_id (FK -> vehicle_variant.id)
spec_type          text         -- controlled vocab: "oil_capacity", "oil_viscosity",
                                 --   "drain_plug_torque", "coolant_type", "coolant_capacity",
                                 --   "trans_fluid_type", "brake_fluid_type", "battery_group",
                                 --   "service_interval_oil", "spark_plug_gap", "tire_pressure", ...
                                 -- (DRAFT sketch. The LIVE vocab is the spec_spec_type_check
                                 --  CONSTRAINT, widened by migrations 0002→0007: Batch A/C/D/E +
                                 --  Phase 2 added fuel/axle/transfer-case/gvwr/gawr/idle,
                                 --  towing/octane/compression/displacement/def, gcwr/dimension/
                                 --  ac_compressor_oil_capacity/washer_fluid_capacity/
                                 --  trailer_tongue_weight, cargo_load_limit/
                                 --  vehicle_capacity_weight/oil_low_to_full/
                                 --  low_fuel_warning_level, and firing_order/fuel_type/
                                 --  adjustment_spec. See §11 Batch D/E + Phase 2.)
value_numeric      numeric NULL -- e.g. 6.0
value_unit         text NULL    -- e.g. "qt", "ft-lb", "kPa"  (store canonical; convert at display)
value_text         text NULL    -- e.g. "0W-20", "DOT 3", "dexos1 Gen 2"  (for non-numeric specs)
qualifier          text NULL    -- e.g. "with filter" / "without filter" / "severe service"
confidence         text         -- always "verified" in strict store (kept for future-proofing)
source_id          (FK -> source.id)   -- PROVENANCE: which document this came from
extracted_at       timestamp
UNIQUE (vehicle_variant_id, spec_type, qualifier)
```

### 5.3 Component / configuration facts (data type 5)

```
component_fact
--------------
id                 (PK)
vehicle_variant_id (FK)
component          text         -- "oil_filter", "oil_filter_location", "cabin_filter_location", ...
fact_type          text         -- "type" / "location" / "part_number" / "access_notes"
value_text         text         -- e.g. "spin-on", "front, driver's side near oil fill cap", "15208AA170"
source_id          (FK -> source.id)
extracted_at       timestamp
UNIQUE (vehicle_variant_id, component, fact_type)
```

> Component facts (filter type/location) are stored exactly like specs — strict, provenance-tracked — because the model fabricates them as confidently as numbers. They are NOT free-form model output.

### 5.4 Source / provenance (the trust backbone)

```
source
------
id                 (PK)
source_type        text         -- "owner_manual" / "manufacturer_spec_sheet" / "gov_nhtsa"
                                 --   / "gov_epa" / "obdb" / "retrieval_grounded" / "tech_contributed"
title              text         -- e.g. "2023 Subaru Impreza Owner's Manual, Maintenance section"
url_or_ref         text NULL    -- where it came from (citation / file ref)
publisher          text NULL    -- e.g. "Subaru of America"
retrieved_at       timestamp
license            text NULL    -- e.g. "manufacturer-published", "CC-BY-SA", "public-domain"
trust_tier         text         -- "tier1_open" / "tier2_retrieval" / "tier3_crowdsource"
```

> **Provenance is what makes the database defensible and auditable.** Every spec and component fact points at the source it was extracted from. This enables re-verification, dispute resolution, and confidence about *why* a value is trusted. It is also what lets a retrieval-grounded extraction (Tier 2) be trustworthy: the citation is the verification record (provided the citation is real and checkable — see open question 6.B).

### 5.5 Miss log (drives acquisition)

```
spec_miss
---------
id                 (PK)
vehicle_variant_query  text     -- what was asked for (vehicle + spec_type)
spec_type          text
asked_count        int          -- incremented on repeat misses
last_asked_at      timestamp
status             text         -- "open" / "sourced" / "wont_fix"
```

> This is the prioritization engine: rank `open` misses by `asked_count` to decide which source documents to acquire next. Demand-driven coverage growth.

### 5.6 Unified query surface

The app queries one logical interface — "give me everything verified about this vehicle variant" — that reads across `spec`, `component_fact`, and (once migrated) DTC/PID/VIN. A miss on any lookup returns an explicit not-found (→ honest live fallback + miss-log), never a silent wrong substitution.

> **Scaling note (per CLAUDE.md):** this store is Postgres/Supabase, not JSON files. It is the natural anchor for the pre-launch JSON→Postgres migration already on the roadmap. Stateless reads, indexed on the vehicle-variant key. Designed for thousands of concurrent users from the start.

---

## 6. Extraction engine (Layers 1–2) — proposed flow

The pipeline that turns a source document into verified rows. This is the agreed **first build target** because it must exist regardless of which sources feed it.

```
1. INGEST       A source document enters (PDF, structured gov data, retrieved page).
                Recorded in `source` with type, publisher, license, trust_tier, ref.
                ↓
2. EXTRACT      Claude is given the document content + a strict tool-use schema
                (emit_extracted_specs / emit_component_facts), and instructed to
                extract ONLY what appears in the document — never to supply a value
                from memory. Missing value in doc → omit, do not invent.
                ↓
3. NORMALIZE    Units canonicalized (qt/ft-lb/kPa internal; convert at display).
                Vehicle identity resolved to a `vehicle_variant` (granular key).
                Spec_type mapped to controlled vocabulary.
                ↓
4. VALIDATE     Sanity checks before write: value in plausible range for spec_type
                (e.g. oil capacity 2–15 qt, not 115); unit matches spec_type;
                vehicle_variant resolved unambiguously. Fail → quarantine for review,
                do NOT write. (Same "fail loud, never store garbage" discipline as
                the DTC parser's assertion harness.)
                ↓
5. STORE        Write spec / component_fact rows with source_id provenance + extracted_at.
                Conflict with existing verified value from a different source → flag for
                review rather than silently overwrite (open question 6.C).
```

**Key design commitments:**
- **Structured output via tool use**, not prompt-and-parse JSON — same as the assess endpoint and DTC fallback. The schema *forces* the shape.
- **Extraction prompt forbids memory-sourced values explicitly** — the single most important instruction in the whole pipeline. Mirror the diagnostic engine's verified-data-only discipline.
- **Validation gate before write** — a value that fails plausibility never reaches the store. This is the database equivalent of the DTC parser's self-test: protect against silently-wrong data at the boundary.
- **Build a test harness** — feed known source documents with known correct values, confirm the pipeline extracts them correctly, before trusting it on bulk data. (Same principle that makes the DTC parser trustworthy: validate logic without needing the physical world.)

> **RESOLVED (6.A) — on-demand first (miss-log driven), batch as an accelerant for proven-popular vehicles.** Do NOT bulk-extract the whole vehicle universe up front — wasted effort/cost on vehicles no one asks about, and you can't validate the pipeline until it runs on real demand. Instead: on-demand extraction driven by the miss-log (tech asks → honest fallback answers live → miss logged → that miss tells you what to extract next). Batch becomes an optimization on top: once the miss-log shows high-demand clusters, batch-extract those proactively to pre-warm the common cases. The miss-log is what tells you which vehicles graduate from on-demand to worth-batching. Earliest extraction work is automatically aimed at real demand.
>
> **RESOLVED (6.B) — the two hard parts are now native Claude API features; this is no longer a research risk. (Verified via current Anthropic docs.)** The crux was "how is a retrieved citation made real and checkable, not itself a hallucination." Answer:
> - **Citations API** grounds output in source documents and returns *structured citation objects with character-level offsets, document indices, and source-text excerpts, guaranteed at the API layer* (not prompted). One reported deployment cut source hallucination from 10% → 0%. This is the proof-of-source mechanism — the extracted value comes with a verifiable pointer to exactly where in the document it appears.
> - **Domain filtering** (`allowed_domains` on the web search/fetch tools) restricts retrieval to authoritative sources — Anthropic explicitly recommends it "for applications where source reliability is paramount." This IS the trusted-publisher whitelist, as a parameter, not custom code.
> - **Dynamic filtering** (web_search_20260209 + code execution) lets Claude write code to filter results before they hit context — Anthropic calls out *citation verification and sifting technical documentation* as target use cases (i.e. exactly spec extraction from a manufacturer doc).
> - **Safety rail (bonus):** the web *fetch* tool cannot dynamically construct URLs — it only fetches URLs from prior search results or explicitly provided — minimizing exfiltration risk. The pipeline can't be tricked into fetching attacker-controlled URLs.
> - **The Tier-2 safe pattern:** search authoritative `allowed_domains` → extract via Citations with the character-level offset stored as the provenance record → **if no citation grounds the value, do NOT store it** (strict store + fail-loud, now API-backed).
> - **CAVEAT (do not over-read):** Citations guarantees the value *faithfully appears in the cited source* — NOT that the source is correct or that the right vehicle variant was resolved. A perfectly-cited spec from the wrong model-year manual is still wrong. The validation gate (§6 step 4) and human spot-check remain essential. The API makes *provenance* trustworthy, not *truth*.
> - **COST NOTE:** web search is billed separately (~$10 / 1,000 searches) on top of tokens — a third cost bucket for Tier 2 only (Tier 1 doc-extraction doesn't incur it). Doesn't break the build-once economics; just measure it.
>
> **RESOLVED (6.C) — trust-tier precedence for what's served; flag conflicts, never silently overwrite.** Manufacturer-published doc > retrieved web page > crowdsourced entry — precedence by trust tier reflects actual authority. BUT do not silently overwrite: a disagreement is *information* — often a symptom of a too-coarse vehicle key (5.A) merging two real variants, or one source being wrong. Higher tier wins for the served value; the conflict is logged for review. Many "conflicts" will resolve to "you keyed too coarsely," tying 6.C back to 5.A.

---

## 6.1 First-slice extraction test — RESULTS (PROVEN)

First end-to-end test of the engine. Document: official 2011 GMC Sierra owner's manual PDF (Tier 1, manufacturer-published). Script committed at `server/scripts/extractFromPdf.js` (manual-run only, not wired to any endpoint, doesn't touch live spec path or JSON caches). 72 specs + 48 component facts stored against `source_id=2` in Supabase (read-back confirmed).

**The engine works — and provably doesn't hallucinate.** Answer-key check passed: 5.3L oil → 5.7 L with filter, dexos 5W-30 (matches known GM spec ≈ 6 qt). Also correct: DEX-COOL coolant capacities, spark-plug gaps (1.02 mm V8 / 1.52 mm V6), DEXRON-VI trans fluid + per-gearbox capacities, DOT 3 brake fluid, R134a refrigerant, wheel-nut torque, maintenance intervals. **0 of 120 items stored without a verbatim quote** (the anti-hallucination gate held). Decisive negative result: pages 1–300 (operating/infotainment) returned ZERO specs rather than inventing any.

**Cost finding (the key lever):**
- The manual was **594 pages / ~1.18M tokens — exceeds Opus's 1M context, cannot be fed whole.** Script caught this on a pre-flight token count and chunked (no silent truncation).
- **Full extraction = $6.31**, of which **94% was input (reading the document)**; output was $0.36.
- **Every spec came from the back half (pages 301–594). Front 300 pages cost ~$3 and produced nothing.** This is the cost lever — but the original "specs live in ~50–80 pages → ~85–90% cut → sub-$1/manual" was an *assumption*. **Measured in Batch A (threshold-6 keyword-density trim, 193/594 pages fed): specs actually spread across ~170 back-half pages (sections 9–12), so the achievable cut is ~66% → ~$2.2 per large manual, NOT sub-$1.** Pushing the threshold higher to chase sub-$1 starts dropping real spec pages (the spec content is genuinely that spread out). The economics conclusion is **unchanged**: this is a **one-time, build-once cost per vehicle** (~$2 once), the opposite of Vehicle Finder's pay-per-lookup-forever model — only the headline figure moved.
- **Trim safety PROVEN by a `--full` baseline diff (Batch A, measured not asserted):** the full-manual run (63 specs) vs the trimmed run (52 specs) confirmed **zero core specs dropped** — oil/coolant/spark-gap/transmission/fuel/axle/brake/refrigerant/torque all present (the count gap is near-dupes + extraction non-determinism, every diff line located in the manual). The **only** genuine trim-caused drop was a **non-core, deferred-scope item (fuel octane)** sitting in a gap between selected page bands. So the trim's failure mode is bounded: it can cost non-core/deferred items in band gaps, never core capacity/fluid/torque specs at threshold 6.

**Two tuning items before scaling (found by the test):**
1. **Vocab too narrow** — ~30 real specs (fuel-tank capacity, axle/transfer-case fluids, GVWR/axle weights, fast-idle RPM) fell into a generic `other` bucket with no `spec_type`. Captured but untyped; some `other` entries lack a label and aren't useful ("340 kg" of what?). Widen the `spec_type` CHECK vocab and require a descriptive label for any `other`.
2. **Dedup is exact-match only** — near-duplicates survived (e.g. "DOT 3" vs "DOT 3 Hydraulic Brake Fluid (GM PN…)", prose vs parsed interval forms). Needs value_text normalization / fuzzier dedup.

**Productionization status (Batch A — DONE & validated):**
- **Trim before extracting** — ✅ DONE. Local pdfjs-dist keyword-density page scan feeds only spec-bearing bands (±margin, fail-safe floor). Measured ~66% cost cut to ~$2.2/manual with **zero core specs dropped** (per the `--full` diff above). Threshold is a named tunable, kept conservative (over-include on purpose).
- **Widen `spec_type` vocab** — ✅ DONE (per item 1). +8 typed buckets (fuel_capacity, axle/transfer-case fluid type+capacity, gvwr, gawr, idle_speed); `other` now requires a descriptive label (DB CHECK + gate + tool schema); weights canonicalized to kg.
- **Persist `page` + `verbatim_quote` on rows** — ✅ DONE (per item, now real columns). Both NOT NULL on `spec` + `component_fact`; `page` remapped from chunk-relative to absolute PDF page; a per-run JSON snapshot is dumped so a regression baseline survives independently of the DB.
- **Stronger dedup/normalization** (per item 2) — ⏸ STILL DEFERRED to Batch B (exact-match dedup only; near-dups like "DOT 3" vs "DOT 3 Hydraulic Brake Fluid" still survive). **Two concrete read-path manifestations surfaced when the live spec path was wired to the DB (note for Batch B so they're not lost):** (1) a hit answer can show near-duplicate text lines (e.g. "Oil type: dexos" and "Oil type: dexos specification") — cosmetic, not a wrong value; (2) the §6.C cross-source conflict log fires on text-phrasing differences (e.g. "dexos" vs "dexos specification") on the 3 identical test sources — log-only, and absent in production where a vehicle has one source. Both resolve once fuzzy/normalized dedup lands.
- **Schema expansion for richer manual data** (fuses/bulbs/towing/etc., per the SCOPE DECISION below) — ⏸ STILL DEFERRED.

**Cross-manufacturer validation (Sierra / Ford / Honda) — findings & before-feed fixes.** Batch A was validated end-to-end on the Sierra, then the engine was run against Ford and Honda owner's manuals to check it generalizes. It mostly does — but the cross-run surfaced that the pipeline had been quietly *fitted to GM*, plus a few concrete bugs. None is a data-trust crisis (stored values/quotes are correct); all are flagged here so they're fixed in the right window, before the real feed scales.

> **STANDING PRINCIPLE (5-equivalent for the extractor) — guard against GM-shaped assumptions; "validated on one example" ≠ "generalized."** The extractor was validated on the Sierra and, without it being a deliberate choice, *fitted to* the Sierra: first a hardcoded vehicle identity, then a GM-shaped trim-keyword dictionary, then GM-shaped controlled vocab. Each was reasonable in isolation and invisible until a non-GM manual ran through. **Standing rule: before trusting the pipeline at scale, run it on a deliberately DIVERSE manufacturer set and actively hunt for GM-shaped assumptions** (identity, trim/series vocabulary, unit spellings, section naming, page structure). Treat "it worked on the manual I built it on" as the *start* of validation, not the end. This principle generalizes the specific Honda/Ford findings below — they are instances of it.

**Before the real feed — LANDED 2026-06-24 (#6, #7a, #7b, #15, #16, #17). `#9` vocab/unit widening still deferred to Batch C / the feed.**
- **Page-remap bug (#6) — DONE.** Confirmed root cause exactly as described (prompt at `extractChunk` instructs Claude to report *absolute* pages; the post-processing `remapPage` re-translated as if chunk-relative via `idx[p-1]`, double-counting). **Fix: dropped the remap; rows now store Claude's absolute page as reported** (coerced to int; the validation gate still rejects a missing/invalid page, `verbatim_quote` remains the anchor). `server/scripts/extractFromPdf.js`.
- **#7a GM-shaped trim dictionary (THE DANGEROUS ONE) — DONE.** The keyword-density scorer was fitted to GM: its load-bearing strong signals were GM brand/standard names (dexos/dex-cool/dexron/gawr/gvwr/r-134a) and GM heading phrasings, so non-GM spec pages scored under threshold and were SILENTLY dropped. **Approach: made the scoring manufacturer-agnostic** — driven by generic spec/maintenance vocabulary (engine oil, oil filter, engine coolant, brake fluid, transmission fluid, spark plug, tire pressure, viscosity, capacity, specifications, maintenance schedule…) + **structural measurement regex patterns** (viscosity grades `0W-20`, capacity+unit, torque+unit, tire pressures `psi`/`kPa`, service intervals `160,000 miles`, tire sizes `235/65R17`, spark-gap `mm`) that any make's spec pages carry by construction; GM brand names kept as non-load-bearing weight-1 bonuses. Conservative over-include posture (±margin + fail-safe floor) unchanged. The scorer was extracted to a SHARED `server/scripts/trimScan.js` imported by BOTH the extractor and the zero-cost `trimPreflight.js`, so they can never drift (the preflight's numbers are now a real guarantee). **Zero-cost validation (`trimPreflight`, core-spec-page coverage = unambiguous spec pages: viscosity grade, or capacity+unit with a fluid term, or ≥2 distinct fluid components):**

  | Manual | BEFORE selected | BEFORE core-cov | AFTER selected | AFTER core-cov |
  |---|---|---|---|---|
  | Sierra (GM) | 193/594 | **15/15 (100%)** | 259/594 | **15/15 (100%)** |
  | Ford F-150 | 200/629 | 54/59 (92%) | 250/629 | **59/59 (100%)** |
  | Honda CR-V | 24/671 | **2/11 (18%)** ⚠ | 151/671 | **11/11 (100%)** |
  | Subaru Impreza | 105/496 | 12/15 (80%) | 178/496 | **15/15 (100%)** |
  | Subaru Outback GSG | 66/132 (fail-safe) | **0/3 (0%)** ⚠ | 26/132 | **3/3 (100%)** |

  Non-GM coverage improved on every manual (Honda 18%→100%, the silent under-selection eliminated); GM (Sierra) did NOT regress (100%→100%). It also exposed a second latent danger the old code hid: the Outback GSG's front-of-book specs (pp.49–53) were entirely missed because the fail-safe back-half fallback skipped them — now captured. Sierra's mild over-inclusion (32%→44%) is within the accepted "over-include on purpose" stance.
- **#7b `pdf-lib` shared-resource chunk bloat — DONE.** Confirmed: `copyPages` materializes the document-wide shared resource pool (fonts/images inherited via the page tree) into EVERY chunk, so chunk size barely scales with page count — measured a **5-page** slice of the 33MB Honda manual at ~31.6MB raw (~42MB base64), tripping the 32MB request rejection, identical to a 150-page slice. ~14.6MB of that is embedded photos/diagrams (2294 image XObjects), which are NOT spec data (the verbatim-quote gate only stores text-quotable values; spec tables are vector text; Anthropic rasterizes pages for vision from the remaining vector content). **Fix: conditional image-strip** — when a built chunk would exceed the request cap (`CHUNK_B64_SOFT_LIMIT`), neutralize its image XObject streams (indirect objects stay valid, no dangling `/Do` refs; bytes collapse to 1) and rebuild. Brings any Honda chunk to ~17MB raw / ~22.7MB base64; confirmed via pdfjs re-parse that text/tables survive intact. Normal (sub-cap) manuals are byte-for-byte untouched.
- **Vocab / unit widening (#9) — DONE 2026-06-25 (with Batch C, minus firing_order).** Landed as typed buckets: **compression_ratio, displacement, fuel_octane, def_type, def_capacity** (+ `towing_capacity`), via migration `0003_batch_c_spec_types.sql`. **firing_order DROPPED from scope** (rare in owner manuals — low coverage; can be added later if a service-manual feed needs it). The earlier "lb.ft"/"lbf·ft" unit-parsing gap was already closed by `normUnitForMatch` in the Subaru run. See the Batch C entry in §11.
- **Cosmetic nit (#15) — DONE.** Re-indented the misaligned token-preflight `countTokens({…})` block in `extractFromPdf.js` (was valid JS, purely cosmetic).
- **Latent fuel-capacity range bug (#16) — DONE.** Confirmed: in `validateSpec`'s `fuel_capacity` branch `/l|liter|litre/.test(u)` matched "ga**l**", so gallon values took the litre range (10–230) and the dedicated `/gal/` branch was unreachable — a sub-10-gallon tank would be wrongly quarantined. **Fix: test `/gal/` first** (resolves gallon to its own 3–60 range before the litre test). Validated by the new zero-cost `server/scripts/verifyFuelRange.js` (8 cases incl. the previously-broken 9-gal small tank now passing; litre range intact). ⚠ Validation-gate change — see §11 safety note.

**Subaru validation run (2023 Impreza, 2026-06-12) — fourth manufacturer; two NEW manufacturer-shaped-assumption instances, both fixed in-run.** Official STIS PDF (MSA5M2301A, 496 pp, downloaded from techinfo.subaru.com). Trim worked unmodified: 105/496 pages selected, all core spec/maintenance sections captured (verified with the new zero-cost `scripts/trimPreflight.js` BEFORE spending; the unselected gaps were bulbs/fuses/infotainment — deferred scope). Single 105-page chunk — no #7b chunk-size trip. Final run: **48 specs + 21 component facts, 0 quarantined, $1.25** (×2 runs ≈ $2.51 total — the first run's capacities were quarantined by the unit gap below and the source was deleted + re-extracted clean as source_id=8). Answer-key check passed: 0W-20, 4.7 US qt with filter, 8.0/8.2 qt coolant, 13.2 gal tank, 89 lbf·ft wheel nuts, 33/32 psi, NGK DILKAR7B8, full bulb-spec table. Findings:
- **Identity vision fallback (#17) — DONE 2026-06-24 (the "real fix" landed).** Background: the Subaru STIS manual carries NO model/year in extractable text anywhere in 496 pages (no text cover; foreword says "your SUBARU vehicle"), so the text guard can't confirm identity. `--identity-override="<justification>"` (shipped 2026-06-12) covered it via provenance. **Now added: a visual cover-page check** — when the text identity scan fails AND no override was supplied, the extractor sends the first ≤3 pages to Claude as a PDF-vision pass (`verifyIdentityVision`, forced `report_cover_identity` tool) to READ the cover title and compare it against the declared vehicle, keeping confirmation automatic for the common no-text-but-has-cover case. **Fail-safe: any vision error or non-confirmation falls through to the existing ABORT — identity never passes silently** (the no-confirmation-and-no-override abort behavior is unchanged). `--identity-override` short-circuits BEFORE the vision call (so a known cover-less file like the STIS PDF spends nothing on a vision pass that would find nothing) and remains the documented fallback for that genuinely-cover-less residue. ⚠ Identity-guard change — see §11 safety note. **Cost:** one small PDF-vision call over ≤3 cover pages fires only on a text-identity failure with no override. **LIVE-VALIDATED 2026-06-25 (both branches):** positive — Ford F-150 cover ("2020 F-150 Owner's Manual") → `confirmed:true` ($0.032); fail-safe — Subaru Impreza STIS (foreword + internal model code "A1500BE-A", no printed model cover) → `confirmed:false` ($0.034), which correctly falls through to the unchanged abort. The vision read genuinely reads the cover text and does NOT rubber-stamp. Total #17 validation spend ~$0.066.
- **Unit-spelling gap, #9's Subaru flavor (FIXED — the #9 normalizer is now partially built).** First run quarantined ALL ten capacity/torque specs (correct values, perfect quotes) purely on "US qt" / "US gal" / "lbf·ft" spellings. `normUnitForMatch()` strips US/Imperial prefixes and canonicalizes ·/./space separator typography for validation MATCHING only (stored `value_unit` keeps the manual's exact spelling); `lbf-ft`/`ft-lbf` added to TORQUE_UNITS. This also covers Ford's "lb.ft" gap from #9; the remaining #9 scope (vocab widening: compression_ratio/displacement/firing_order/octane/DEF types) is still deferred.
- **Owner's manuals do NOT carry oil-filter part numbers (data-source finding, not a bug).** No "15208" anywhere in the text; the filter location exists only as a diagram callout (not quotable). The verbatim-quote gate correctly stored nothing — so the component-fact demand for filter type/PN/location (now visible via the `spec_miss` `componentFact` log) needs a DIFFERENT source class: parts-catalog data (Tier 1/2) or tech-verified capture (Tier 3). Owner's manuals verify the oil *specs* around the filter question (capacity "with filter", viscosity, type) but not the filter identity itself.

**SCOPE DECISION — expand beyond specs/component facts.** The manual is a richer source than the schema currently models. Discovery inventory of other high-value extractable data types to add (future schema/extractor work): **fuse/relay assignments + amperage + circuit-breaker locations; bulb part numbers; warning-light / DIC message meanings; tire specs + TPMS + door-label pressures; towing/trailering capacities by model/engine/axle ratio + GVWR/GAWR/load limits; axle fluids by series; battery specs; fuel/octane requirements.** (Infotainment/personalization procedures = lower value.) Owner's manuals are a deeper data source than "specs + component facts" — plan a schema expansion to capture these. Fuse diagrams flagged as especially valuable.

---

## 7. Source acquisition (Layer 3) — SKETCHED, not yet designed

Deferred to a later detailed pass (the schema + engine come first). Captured here so the plan is whole. Sources are layered by **legitimacy** and **time horizon** — you don't pick one, you layer them.

**Tier 1 — Open / government / manufacturer-published (the safe foundation; start here):**
- Government data, public-domain and underused: NHTSA/vPIC (deeper than current usage), EPA fuel-economy data (engine/displacement/fuel specifics), possibly CARB.
- **Manufacturer-published owner's manuals & maintenance schedules** — often posted openly as PDFs on manufacturer sites. Categorically different from scraping a proprietary aggregator: this material is *meant* to be public. Prime extraction source for capacities, intervals, fluid specs. **The big underexplored Tier-1 source.**
- Template already proven: OBDb (CC), NHTSA, MIT-licensed DTC set.

**Tier 2 — Retrieval-grounded generation (the scale accelerator; likely highest-leverage):**
- The clean, modern form of the "web scraping" instinct: Claude searches for a spec, finds an authoritative source, and **extracts from the retrieved document with the source cited** — fact comes from a retrieved page, not from memory. Same reliability distinction as the diagnostic engine.
- Turns source acquisition from "manually collect millions of documents" into "let Claude find + extract, store the citation as proof." Directly attacks the bottleneck that stalled the old planning.
- **Gated by open question 6.B** (citation must be real/checkable). This is the make-or-break design detail.

**Tier 3 — Crowdsource from Vulcan's own technicians (the long-game moat):**
- Skeleton already scaffolded: the confirmed-fix database. Extend the concept — your users are pros standing in front of real vehicles with the real specs in hand (door sticker, service manual, oil cap). Capture verified data points from the field: "You just did this oil change — what was the actual capacity?" → tech-verified spec from someone who read it off the car.
- Slow to start (needs user base), but **compounds into a proprietary dataset no competitor has**, because it's generated by your specific users doing their specific jobs. This is the defensible moat.

**Tier 4 — OFF-LIMITS (boundary stated explicitly):**
- Identifix, AllData, Mitchell1, Innova — proprietary, licensed; scraping them is legally dangerous and violates Vulcan's clean-data principle. The line: "extract from manufacturer-published owner's manuals" = fine; "scrape AllData" = not. The difference is *who published it and whether it was meant to be public.*

**Layering by time horizon:** Tier 1 + Tier 2 get Vulcan launched (safe foundation + fast scale). Tier 3 makes it defensible over time (the moat). All three feed the *same* extraction engine and the *same* unified store.

---

## 8. Build order (proposed)

1. ~~Design & stand up the unified schema in Postgres/Supabase~~ ✅ **DONE & verified live.**
2. **Build the extraction engine** (§6) with a test harness. ✅ **First slice PROVEN** (§6.1), then **PRODUCTIONIZED in Batch A** — trim-before-extract, widened vocab (+ `other`-label), persisted audit columns (absolute page + `verbatim_quote` NOT NULL), per-run dump + page remap: all DONE & validated (~$2.2/manual, ~66% cut, **zero core specs dropped** per the `--full` diff). **Still deferred:** stronger/fuzzy dedup, and schema expansion for richer manual data (fuses/bulbs/towing/etc.).
3. **Tier 1 first feed** — extract from a small set of manufacturer manuals + government data to validate the end-to-end pipeline on real, safe sources. ← **NEXT**
4. **Wire the honest-fallback + miss-logging** (Option C layers 2–3) into the app's spec path so the app is trustworthy while the DB is still sparse.
5. **Tier 2 (retrieval-grounded)** once 6.B is designed — the scale accelerator.
6. **Migrate the working three** (DTC, PID, VIN) into the unified store — deliberately, last, only once the store is proven.
7. **Tier 3 (crowdsource)** — switch on as the user base grows; the compounding moat.

---

## 9. Decisions & remaining items (consolidated)

**RESOLVED:**
- **5.A — Vehicle-key granularity:** key on *mechanical configuration* (engine, drivetrain-where-it-matters, mechanically-meaningful series like 1500/2500), NOT trim badge. Default-resolve at engine level; split a spec finer only where its value actually differs. Data-driven. (§5.1)
- **6.A — Extraction mode:** on-demand first, miss-log driven; batch as an accelerant for proven-popular vehicles. (§6)
- **6.B — Retrieval-grounded verification:** SOLVED via native API features — Citations API (guaranteed structured source offsets), domain filtering (`allowed_domains` whitelist), dynamic filtering. Store only citation-grounded values; fail loud otherwise. (§6)
- **6.C — Conflict resolution:** trust-tier precedence for the served value; flag conflicts for review (often a symptom of too-coarse keying). (§6)

**MEASURED (Batch A — was "needs measurement"):**
- **Cost:** Tier-1 doc extraction is a one-time, build-once per-document spend (asset-building, not recurring per-user — the opposite of Vehicle Finder). **Measured: ~$2.2 per large manual** (594-page Sierra, trimmed at threshold-6, ~66% cut from the $6.31 full-manual baseline; full detail in §6.1). Smaller manuals cost less; multiply per document. **Still to measure:** the separate Tier-2 web-search cost (~$10/1,000 searches), once that tier is built.

**REMAINS OPEN (judgment, resolve as you build):**
- **Validation thresholds:** the specific plausibility ranges per spec_type for the validation gate (§6 step 4). Start conservative, tune against real data.
- **Migration timing:** when is the new store "proven" enough to absorb the working DTC/PID/VIN systems? Defined as a *confidence gate*, not a date (see below).

**Migration "proven" gate (resolved as a standard, not a date):** absorb the working three only when (1) the store has run the specs + component-facts workload in production for a meaningful period with no integrity issues, (2) the extraction pipeline has a passing test harness, and (3) a migration rehearsal on a *copy* round-trips the data identically. Migrate **one system at a time** (DTC first — most self-contained and best-tested), keeping the old system as fallback until each is confirmed. Don't migrate to "finish" unification; migrate when the new store has independently earned the trust. No rush — the working systems work.

---

## 10. Connection to the rest of Vulcan

- **Diagnostic engine (Stage 2+):** the database is the verified-fact source the reasoning layer reasons *over*. Stage 2's evidence loop and the database are complementary halves of the "verified facts + sound reasoning" architecture. The stronger the database, the less the diagnostic engine must rely on model recall, the more trustworthy the diagnosis.
- **Ask Vulcan:** the database is the structural fix for the confident-wrongness that prompt-tuning could not solve. As the DB fills, more spec/component questions get verified answers; misses fall through to the (already-shipped) honest guardrail.
- **Pre-launch infrastructure:** this store IS the anchor for the planned JSON→Postgres/Supabase migration. Build it as the scalable foundation, not a bolt-on.
- **The moat:** Tier 3 crowdsourcing turns Vulcan's user base into a proprietary dataset competitors can't replicate — a genuine long-term business defensibility, built on the confirmed-fix skeleton that already exists.

---

## 11. Deferred-work ledger (consolidated, by timing window)

Everything parked as of the Stage-2 pause, with **why it's deferred** and **the window it must land in**, so a future session resumes without re-litigating. "Parked" = decided and resting. Items are cross-referenced to their detailed write-ups above and to CLAUDE.md where the home is code/architecture.

**DONE / LIVE (not deferred — listed so the boundary is clear):**
- **Foundation** (connection + schema), **extraction engine** (Batch A: trim-before-extract, widened vocab, audit columns; ~$2.2/large manual, zero core specs dropped), **cross-manufacturer validation** (Sierra/Ford/Honda), **Option C spec path** (verified hit / honest fallback / miss-logging, fail-soft), and **tool-use spec routing in `/api/ask`** (the `spec_lookup` agentic loop). The live spec path's **plumbing is proven end-to-end** (PR-1's deployed testing: in-DB vehicle returns DB data, miss hedges) — that proof is satisfied, not an open item.

**GROUNDWORK ALREADY LAID (enables later work):**
- **Agentic tool-loop pattern (#3)** — `server/askToolLoop.js` (built in PR-1) is the execute-then-continue machinery: *Claude requests data → server provides it → Claude continues in the same turn*. It is **registry-based — a new tool is one entry** in `ASK_TOOLS` + `ASK_TOOL_HANDLERS`. This is deliberately the **same machinery Stage 2's evidence loop needs** (request specific data under specific conditions → capture → continue), and it is the **socket future retrieval tools plug into** (see Batch C below). Architecture/registry details live in CLAUDE.md → Backend → vehicle spec retrieval.

**BEFORE THE REAL FEED — DONE 2026-06-24 (#6, #7a, #7b, #15, #16, #17 landed; full detail + the #7a coverage table in §6.1). Only #9 vocab widening remains, deferred to Batch C / the feed.**
- **#6 Page-remap bug — DONE.** Dropped the remap; store Claude's absolute pages as reported.
- **#7a GM-shaped trim dictionary (the dangerous one) — DONE.** Manufacturer-agnostic scoring (generic spec vocab + structural measurement regex; GM brand terms demoted to bonuses), extracted to a shared `server/scripts/trimScan.js` used by both the extractor and `trimPreflight.js` (no more drift). Coverage (core-spec pages): Honda **18%→100%**, Ford 92%→100%, Impreza 80%→100%, Outback GSG 0%→100%; **Sierra (GM) 100%→100%, no regression**. Also fixed a latent fail-safe gap that dropped the Outback GSG's front-of-book specs.
- **#7b `pdf-lib` shared-resource chunk bloat — DONE.** Conditional image-strip when a chunk would exceed the request cap (image XObjects neutralized, refs stay valid); Honda chunks ~42MB→~22.7MB base64, text/tables intact. Normal manuals untouched.
- **#15 Cosmetic nit — DONE.** Re-indented the token-preflight `countTokens` block.
- **#16 Fuel-capacity gallon range — DONE.** Test `/gal/` before the litre regex; sub-10-gallon tanks now pass. Validated by `server/scripts/verifyFuelRange.js`. ⚠ validation-gate change (safety note below).
- **#17 Identity vision fallback — DONE.** On a text-identity failure with no override, a ≤3-page PDF-vision pass reads the cover and compares to the declared vehicle (fail-safe: non-confirmation → the unchanged abort; `--identity-override` short-circuits before any spend and stays the cover-less fallback). ⚠ identity-guard change (safety note below).
- **⚠ SAFETY-GUARD FLAG (per the pre-approval rule):** #16 changes the **validation gate** (fuel-capacity range) and #17 changes the **identity guard** (adds the vision-confirm path before abort). Both were explicitly scoped by this task and validated zero-cost; flagged here so they are reviewed **before the next real extraction run** (the extractor is manual-run and was NOT run during this work — no paid runs). The #16 reorder only *widens* what passes for gallons (no new false-accepts demonstrated); #17 only adds an automatic confirm path and never weakens the silent-abort.
- These paid down the **GM-shaped-assumptions standing principle** (§6.1): the trim scan no longer depends on GM vocabulary, and the shared `trimScan.js` + `trimPreflight.js` make per-manual coverage checkable zero-cost before spending. The #9 unit-spelling normalizer (`normUnitForMatch`) was already built in the Subaru run.

**BATCH B — fuzzy/normalized dedup (#11; matters at multi-manual scale; §6.1, §8):** near-duplicate hit lines ("Oil type: dexos" vs "dexos specification") and §6.C conflict-log noise on identically-sourced rows. Both cosmetic/log-only today (one source per vehicle in production); they bite once many manuals cover the same vehicle.

**BATCH C — schema expansion (#12; the genuinely-new scope; §6.1 SCOPE DECISION) — CORE LANDED 2026-06-25 (capture side; migration `0003_batch_c_spec_types.sql`).** What landed:
- **New typed `spec_type`s (text-quotable, fit the existing `spec` table):** `towing_capacity`, `fuel_octane`, `compression_ratio`, `displacement`, `def_type`, `def_capacity` (the #9 set minus the dropped `firing_order`/`battery_capacity`). Migration is a pure CHECK-widening — additive, reversible, and read-safe (the fail-soft read path only queries mapped types, so new types can't break reads); applied live via `npm run migrate` and verified in `pg_constraint`.
- **Bulbs + fuse-assignment tables — NO migration:** stored in the existing `component_fact` table (free-text `component`/`fact_type`/`value_text`, designed for "bulb fitment"). Extractor prompt now directs fuse tables (fuse→amperage→circuit) and bulb tables (location→bulb type) into `component_facts`, verbatim-quote-or-quarantine preserved.
- **Trim-scanner extension (`trimScan.js`):** added manufacturer-agnostic fuse/bulb section signals. Adding signals only raises scores → selection grows monotonically → **core-spec coverage did not regress on any of the 5 manuals** (Sierra/Ford/Honda/Impreza/Outback all unchanged), while **fuse/bulb section coverage improved** (Honda 9→16/18, Impreza 10→22/23, Ford 9→10/10, Sierra 7→8/14, Outback 2/2). New zero-cost gate `verifyBatchCRanges.js` (19 checks).

**BATCH D — `other`-bucket vocab widening + in-place re-key — LANDED 2026-06-27 (migration `0005_batch_d_spec_types.sql`).** The first real feed (run-1, 90 vehicles, $201.85 — see §6.1 / the run-1 record) left **1,073 rows in the labeled-`other` bucket across 601 distinct labels**. Inspection split them: **593 NUMERIC** (the value is in `value_numeric`, label in `value_text`) vs **480 TEXTUAL** (value ONLY in `verbatim_quote`; `value_text` is the label). Batch D types + re-keys the numeric ones; the textual ones are Phase-2.
- **5 new numeric `spec_type`s** (additive 0003-pattern CHECK-widening): `gcwr` (gross combined weight rating; canonicalized to kg via WEIGHT_TYPES like gvwr/gawr), `dimension` (ONE family type — wheelbase / overall length·width·height / tread / track / ground clearance; the measurement + any config stays in `value_text`), `ac_compressor_oil_capacity`, `washer_fluid_capacity`, `trailer_tongue_weight` (printed-unit, like towing_capacity). `validateSpec` ranges/units + the `emit_extracted_specs` enum + the system prompt were widened so **FUTURE extractions type these directly**, not just the re-key.
- **In-place re-key (NO re-extraction):** per-family anchored-regex UPDATEs with a `value_numeric IS NOT NULL` guard moved **403 rows** out of `other` — gcwr 147, dimension 130, trailer_tongue_weight 81, ac_compressor_oil_capacity 34, washer_fluid_capacity 11; **`other` 1,073 → 670**. Each family ran in a transaction gated on a **row-conservation check** (`other` drops by exactly N, the new type gains exactly N) and only committed if conserved. **Fully reversible:** the 5 types didn't exist pre-D, so every row carrying one IS the re-key set → `UPDATE spec SET spec_type='other' WHERE spec_type IN (the 5)` reverses it. **No UNIQUE on `spec`** (the §5.2 sketch's `UNIQUE(variant, spec_type, qualifier)` was never implemented in 0001), so the re-key had no collision risk and same-type-multiple-rows-per-vehicle is already normal.
- **PHASE 2 (DEFERRED, the immediate next task):** the 480 textual `other` rows need a per-type **quote-parser** to lift the value out of `verbatim_quote` (a bare re-key would leave them un-queryable). Target set + proposed destinations: `firing_order` (spec), engine descriptors (engine type / bore×stroke / cylinder arrangement / VIN engine code / engine model → **`component_fact`** component='engine'), spark-plug identity (type / make / part_number → **`component_fact`** component='spark_plug', mirrors bulbs/fuses), fuel type/selection (spec/`fuel_octane`-adjacent), wheel/tire size (component_fact), lug-nut size (component_fact). Quote formats vary per type (`"Spark plug FXE20HE-11C"` vs `"Bore x Stroke in (mm) 3.504 x 3.937 (89.0 x 100.0)"` vs `"Firing order 1-4-2-5-3-6"` vs `"5.3L V8 (L82) F"`), so the parser is per-type with a verification gate. New zero-cost gate to add with Phase 2.

**BATCH E — remaining-numeric `other` re-key — LANDED 2026-06-27 (migration `0006_batch_e_spec_types.sql`).** Batch D left **190 NUMERIC** rows in `other`; Batch E re-keyed **150** of them (**`other` 670 → 520**), reusing the exact guarded / conservation-gated / reversible pattern (`value_numeric IS NOT NULL` guard; per-cluster transaction committed only if `other` drops by exactly N and the target gains exactly N).
- **4 NEW types** (additive CHECK-widening + `validateSpec` + `emit_extracted_specs` enum + prompt, so future extractions type them directly): `cargo_load_limit` (74 — roof-rack / toolbox / ladder-rack / tie-down / bed-anchor cargo & accessory load-weight limits), `vehicle_capacity_weight` (20 — door-sticker payload), `oil_low_to_full` (11 — dipstick low→full add quantity), `low_fuel_warning_level` (7).
- **4 FOLDS into existing types** (semantically correct, no new type): `torque` +12 (drain/fill-plug / axle-plug / nut / bolt / stem torques), `towing_capacity` +16 (max trailer weight by hitch type), `displacement` +6 (cubic-inches / engine displacement that should have typed at extraction), `tire_pressure` +4 (temporary/compact/inflatable spare-tire pressures).
- **Fold ordering:** torque ran BEFORE towing so a `"trailer hitch … bolt tightening torque"` routed to `torque`, not `towing_capacity` (towing moved 16, not the 17 estimated — the 1 difference is that correctly-routed row).
- **Fold reversibility (the wrinkle):** label-based reversal is UNSAFE — a genuine `torque` row already has `value_text='lug bolt torque'`, which a fold-reversal regex would wrongly catch. So the moved row-ids were captured (`UPDATE … RETURNING id`) and committed to **`migrations/0006_batch_e_folds.reversal.json`** (torque=12, towing_capacity=16, displacement=6, tire_pressure=4); reverse by `id`. NEW types reverse trivially by `spec_type` (they didn't exist pre-E). The fold UPDATE itself only touches `spec_type='other'`, so genuine target rows are never moved.
- **Cosmetic field-convention note (accepted):** the existing fold targets store the VALUE in `value_text` (`torque`=`"100 lb-ft (135 nm)"`); the folded `other` rows keep the LABEL there (value in `value_numeric`). Fully queryable (value in `value_numeric`) and the label usefully disambiguates *which* torque/trailer-rating — only a `value_text` convention mix under the type.
- **Left in `other`:** **40 numeric** (`compression_ratio` 6 — native type is all-textual `':1'` strings, a numeric fold would lose the format; auxiliary EV/hybrid coolant capacities; numeric brake-pedal clearance/wear → belongs with the Phase-2 adjustment family; singletons like redline rpm / seating capacity / horsepower) **+ the 480 textual rows → Phase 2** (the textual quote-parser, the immediate next task).

**BATCH D PHASE 2 — textual `other` quote-parser — LANDED 2026-06-28 (migration `0007_phase2_spec_types.sql`).** The 480 textual `other` rows held their real value ONLY in `verbatim_quote` (`value_text` was the label). Phase 2 built **deterministic, no-Claude per-type parsers** that lift the value out of the quote and re-key the row to its proper `spec_type` or `component_fact`, behind a **mandatory verification + quarantine gate** (a parse WRITES a real value, so a mis-parse stores wrong data — bias to quarantine; better an honest un-parsed row than a confidently wrong one).
- **Hard re-dry-run-proof gate (the load-bearing discipline):** before any write the parsers ran no-write across all 15 writing families with automated mis-parse detectors. It caught **two SILENT bugs a clean-looking parser had slipped** — spark-plug code truncation (`"DENSO FC16HR-Q8" → "FC16HR"`) and an adjustment range truncated by an un-normalized U+23AF dash (`"0.04 ⎯ 0.24 in" → "0.24 in"`) — both fixed and re-proven to **zero detected mis-parses** before a single write.
- **Moved 339 rows → 277 component_facts + spec re-keys; `other` 520 → 181.** **3 new spec_types** (CHECK-widening + enum + prompt; all textual, value in `value_text`): `firing_order` (53 — the sequence), `adjustment_spec` (33 — pedal/clutch free-play/clearance measurement, the WHICH in `qualifier`), `fuel_type` (6). **component_fact families (NO migration, free-form per Batch C):** tire/size 53, wheel/size 34, spark_plug type 33 + part_number 8, engine type 31 + bore_stroke 22 + cylinder_arrangement 13, key_fob/battery_type 21, lug_nut thread+socket 20, transmission/type 9, wiper_blade 16, oil/air/cabin-filter part_number 17.
- **Caution dials:** `firing_order` parsed aggressively — the sequence must be a **permutation of 1..N**, near-provably correct; prose families (engine type / cylinder arrangement / fuel type) required a domain keyword or quarantined. **QUARANTINED — left in `other`, not guessed:** `vin_engine_code` (ambiguous "F" vs "L82"), fuel-selection/octane/ethanol (mixed destination), and the misc tail (~65). 14 rows quarantined inside the parsed families + those whole families left.
- **Cross-table moves (the new wrinkle vs Phases 1/E):** routing to `component_fact` is **INSERT + DELETE from spec** (not an in-table rename), so label/value-based reversal is impossible — the **full source spec rows were captured to `migrations/0007_phase2_reversal.json`** (96 in-table re-keys + 243 cross-table moves, 277 cf ids). Reverse = restore the spec rows + delete the created component_facts.
- **Multi-value:** a quote listing several sizes became one `component_fact` PER size (35 tire rows → 53 facts; 18 wheel → 34).
- **Cosmetic tire-spacing fix (2026-06-28):** the parse had over-space-stripped tire sizes (`"P205/55R16 89V"` → `"P205/55R1689V"`); a follow-up reformatted the 48 affected `tire/size` facts to split the size from the load index (rim is exactly 2 digits → the remainder is the load index), `verbatim_quote` untouched. Zero remaining concatenated.
- **`other` now 181 = 40 numeric** (Batch-E leftovers incl `compression_ratio` — left as genuinely-misc by decision) **+ 141 textual** (`vin_engine_code`, fuel-selection, misc tail — genuinely miscellaneous / deliberately quarantined, no forced fits).

**BATCH D/E + Phase 2 — COMPLETE (2026-06-28).** The `other`-bucket reduction work is closed: from 1,073 rows (post-run-1) down to **181 genuinely-miscellaneous rows** across Batch D (numeric families, 0005), Batch E (remaining numeric, 0006), and Phase 2 (textual quote-parser, 0007). The remaining ~40 numeric + ~141 textual are deliberately left in `other` (no clean home / ambiguous / quarantined — not force-fit). All re-keys are reversible (in-place by spec_type, folds + cross-table moves by the committed reversal artifacts). No further `other` passes planned. **CURRENT-STATE NOTE (2026-06-28): this 181 figure was the post-Phase-2 / pre-run-2 state. The run-2 $50 top-up's 13 new extractions (src 99–111) reintroduced ~101 un-cleaned `other` rows — the LIVE `other` count is now 282 (56 numeric + 226 textual). The Batch-D/E/Phase-2 cleanup only ever processed run-1's vehicles; the run-2 additions are low-value and not scheduled for an `other` pass.**

**SPEC PROPAGATION V1 — LANDED 2026-06-28 (migration `0008_propagation_origin.sql`, engine `server/scripts/propagateSpecs.js`).** Run-2 step 2: fill missing same-generation/same-engine vehicles' STABLE specs from the 90 already-extracted run-1 vehicles — a ~$0 coverage multiplier (propagation-first, before any extraction top-up).
- **Feasibility-proven (the investigation):** same-gen sibling agreement (unit-normalized) is **89% for physical/mechanical specs** (oil/fuel/trans capacities + viscosity = **100%**) vs **44% for fluid spec-strings** — real mid-gen changes caught: Ford coolant orange→yellow, trans fluid MERCON LV→ULV, engine-oil spec WSS-M2C946-A→-B1. **vPIC has NO generation field** (`decodeVin` pulls only year/make/model/engine), so boundaries are a **CURATED gen-map** (the 8 multi-year platforms overlap-confirmed; **Jeep Wrangler 2018 verified JL** from the stored manual — "All-New Wrangler 2018" cover + 2.0L turbo, JL-only).
- **ALLOWLIST-ONLY (9 physical types):** oil_capacity, fuel_capacity, transmission_fluid_capacity, oil_viscosity, transfer_case_fluid_capacity, spark_plug_gap, towing_capacity, torque, dimension. **DENYLIST (never propagated):** all fluid type/spec strings + compression_ratio/displacement/maintenance_interval/fuel_octane. **EXCLUDED (cautious tier):** coolant_capacity (68%), tire_pressure (63%). Single-pair spec_types = insufficient evidence = excluded.
- **Schema (0008):** `origin text NOT NULL DEFAULT 'extracted' CHECK (origin IN ('extracted','inferred'))` + `inferred_from_variant_id bigint` on `spec` + `component_fact`. Additive / reversible / read-safe — the fail-soft read path ignores `origin` and presents inferred specs **normally** ("here it is"); the marker is invisible in normal use (only a provenance query checks it).
- **Engine + reach:** for each (generation, engine-key) with an extracted anchor, copy allowlist specs to the missing in-generation years within **±2 model-years** of an anchor (the study's validated stability span), writing `origin='inferred'`, `inferred_from_variant_id` = the anchor, and `source_id` + `page` + `verbatim_quote` carried from the anchor's **real manual** (honest provenance chain).
- **NO-CLOBBER (verified):** only fills (year,make,model) with **no** extracted variant; sources only from `origin='extracted'` rows; an extracted row is never touched. Post-write check: 4,900 extracted specs untouched, **0** variants carrying both extracted + inferred.
- **Result: +260 new year-make-model entries · 775 inferred variants · 3,637 inferred specs** (93 → 353 YMM, **~3.8×**) for **~$0**. Allowlist-only confirmed (zero leakage). DB now **1,263 variants / 8,537 specs**.
- **Overwrite-clear (one-directional):** `extractFromPdf.js` now `DELETE … WHERE origin='inferred'` for a variant before writing extracted rows — a real manual cleanly replaces inferred placeholders; an inferred row never overwrites an extracted one.
- **V2 (earned by future extractions):** dead-row pruning (an engine extrapolated ±2yr onto a year it didn't exist = a harmless never-retrieved row, not a wrong answer), reach-widening, and propagating the cautious tier if more same-gen pairs confirm stability. The $50 extraction top-up targets only what propagation can't fill (un-anchored generations, the volatile fluid specs on high-demand vehicles).

**RUN-2 $50 EXTRACTION TOP-UP — LANDED 2026-06-28.** The gap-sourcing investigation's clean recoverable list, extracted (propagation fan-out deferred to a separate step). **Confirmed the investigation's thesis in production:** Honda **OEM techinfo** copies self-identify where the dealereprocess redistributor copies didn't (2020 CR-V text-passed: page 1 = "Owner's Manual 2020 CR-V"). **13 vehicles stored for $31.55** (~$2.43/vehicle; under the $50 cap — the clean list exhausted first): src 99–111 = 2020 Honda CR-V (techinfo), 2021 Chevy Tahoe/Suburban, 2021 GMC Yukon, 2020 Mazda3, 2021 Nissan Sentra, 2022 Jeep Grand Cherokee (WL), 2022 Nissan Pathfinder/Frontier, 2021 Toyota Sienna, 2023 GMC Acadia, 2013 Chevy Silverado (GMT900), 2019 Ford Super Duty (declared `model="Super Duty"` — fixing the run-1 "F-250" naming mismatch; original driver run hit a transient API blip, foreground re-run stored clean). +740 extracted specs. extracted 4,900→5,783; **inferred untouched at 3,637** (no-clobber held — the new anchors are genuinely-uncovered vehicles).
- **Skipped/not-stored (honest, not forced):** Honda Civic (the `AT5A2020OM` techinfo copy did not self-ID → skip-and-noted under the no-`--identity-override` floor); 2015 Silverado + 2015 Camry (dealereprocess slug-404, retryable with a corrected slug).
- **§4 walls NOT attempted** (per the investigation): Toyota RAV4/Tacoma/Tundra/Avalon, all Hyundai/Kia, Subaru Forester/Crosstrek — inherently generic manuals, unverifiable.
- **New anchors → propagation fan-out (SEPARATE next go-ahead):** anchors already in the gen-map fan out automatically (±2yr) — Tahoe/Suburban/Yukon 2021, Mazda3 2020, Sentra 2021, GC-WL 2022, Pathfinder/Frontier 2022, Sienna 2021, Acadia 2023. The **new nameplates NOT yet in the gen-map (Honda CR-V, Ford Super Duty) need gen-map additions** before they fan out (CR-V 2017-2022 / Super Duty 2017-2022); 2013 Silverado (GMT900) is outside the mapped Silverado gens (orphan unless GMT900 is added). Expected fan-out ~25–30 additional YMM, to run in the propagation step.
- **Bug fix (flagged in the investigation):** `server/scripts/propagateSpecs.js` now guards `main()` with `process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href` so importing it for `GEN_MAP`/`engineKey`/`ALLOWLIST` no longer triggers a self-run.

**PROPAGATION RE-RUN (run-2 finale) — LANDED 2026-06-28.** Re-ran the propagation engine from the denser run-2 base to fan the 13 new anchors out. **Two new gen-map entries, verified from the manuals (not assumed):** `Honda|CR-V [[2017,2022],[2023,2024]]` (5th ǀ 6th — cover "2020 CR-V" + the mid-5th-gen 2.0 hybrid) and `Ford|Super Duty [[2017,2022],[2023,2024]]` (4th ǀ 5th — engines 6.2L/6.7L-diesel/6.8L-V10 = pre-7.3 "Godzilla" 4th gen). Same allowlist-only / ±2-reach / no-clobber / sources-only-from-extracted rules.
- **Wrote 30 new YMM entries · 75 inferred variants · 518 inferred specs** (allowlist-only, zero leakage). Per-anchor fan-out: Super Duty +4yr (2017/18/20/21, 124 specs), CR-V +4yr (2018/19/21/22, 32), Mazda3 +3, Sentra +3, the rest +2 each. 2013 Silverado (GMT900) correctly NOT propagated (orphan, outside mapped gens/window).
- **No-clobber verified:** extracted specs **5,783 → 5,783 unchanged**; inferred **3,637 → 4,155**; **0** variants carrying both extracted + inferred; zero non-allowlist leakage. DB grand: 1,404 variants / 9,938 specs.
- **RUN-2 COMPLETE COVERAGE: 396 answerable year-make-model entries = 106 real-extracted + 290 propagated-inferred** (from 90 run-1 + 13 run-2 extractions, ~$232 cumulative Claude spend across all extraction). **Remaining genuine gaps:** the verifiability walls (Toyota RAV4/Tacoma/Tundra/Avalon, all Hyundai/Kia, Subaru Forester/Crosstrek — inherently-generic manuals; only Tier-3 crowdsource or a licensed deal can cover them) and un-anchored generations with no extracted year. Honest launch-coverage figure: **396 YMM**, ~73% of it propagated for ~$0.

**DEFERRED (explicit follow-on tracks, NOT in the core):**
- **Diagram-bound capture** — fuse-box LAYOUT diagrams + warning-light/DIC symbol glyphs live in images and collide with the #7b image-strip (a stripped page is blank where the diagram was), so neither the text engine nor a vision pass on a stripped chunk can read them. Needs a dedicated, size-bounded vision-capture design. The fuse/bulb *assignment tables* (text) ARE captured; only the layout/symbol *images* are deferred.
- **Read-path / tool-loop intent widening** — exposing the new types to the app (`spec_lookup` `SPEC_TYPE_ENUM` + `SPEC_TYPE_MAP` in `supabaseSpecs.js` + `SPEC_PATTERNS`) is a mobile OTA change across the offline-engine fence. Capture landed now; retrieval is the next track — the data is in the DB, no re-extraction needed. **This is where a future retrieval tool (e.g. a fuse-diagram lookup) registers into the PR-1 tool-loop (#3) — "register one entry," not a rewrite.**
- **tire/TPMS/door-label pressures by position** — already representable via the existing `tire_pressure` type + `qualifier`; no new type needed (captured opportunistically).

**PRE-LAUNCH (hard gate; was parked behind the Stage 2 engine work, now complete — still a pre-launch gate):**
- **#4 NHTSA-canonical normalization** (§5.B) — **CORE LANDED 2026-06-25 (A-lite).** A server-side resolver (`server/canonicalVehicle.js`) canonicalizes make/model toward NHTSA's spelling at the two join points: **lookup** (`supabaseSpecs.lookup` + `recordSpecMiss`) and **extraction-write** (`extractFromPdf.js` keys rows under the canonical variant). Aliases live in DB tables (`make_alias`/`model_alias`, migration `0004_nhtsa_canonical_identity.sql`) **and** an identical in-code seed (fail-soft fallback). **Fail-safe:** an unaliased name passes through unchanged → an honest miss, never a wrong-vehicle match (proven: free-text "F150" now JOINS the stored "F-150" rows; bogus "Frod" stays a miss). Existing 30 variants were already canonical → the in-place re-key was a no-op (no re-extraction). The canonical **make authority table `nhtsa_make`** (from NHTSA `GetAllMakes`, via `npm run import:nhtsa-makes`) is created but **import is PENDING — NHTSA's vPIC API was 503 (full outage) at deploy time; re-run the one-liner when it recovers** (the resolver does NOT depend on it — it only feeds the #14 picker). **Still pre-launch:** client-side input normalization on the way in (the resolver currently normalizes server-side at the join, which fixes the false-miss; constraining entry at the UI is #14).
- **#14 Structured input / pickers** — **FAST-FOLLOW (decided 2026-06-25): deferred to a thin OTA pass** now that the canonical list source (`nhtsa_make`) + resolver exist. Constrain make/model/year at intake from the canonical lists (needs a `GET /api/makes` endpoint + the picker UI). Until then #4's server-side normalization cleans free-text at the join. (Endpoint also deferred to this pass to keep the #4 pass server/DB-only.)

**NEAR-LAUNCH:**
- **#13 Real extraction feed** — extract real manuals at scale, **demand-ranked off the `spec_miss` log** (§6.A on-demand-first). Deferred to near-launch; the engine is ready, the feed is a content/operations effort aimed by real demand.

**PR-2 — partially DONE via the unified-flow merge; one piece still deferred:**
- **#10 PR-2 — Diagnose/Assess unification.** The **structural half is DONE**: the unified-flow merge (SB1–SB4, hardware-validated 2026-06-14) folded the old parallel `/api/diagnose` (conversational) + `/api/assess` (structured) double-fire into the **single `/api/diagnose-turn` brain** that commits one move per turn (ask / request-a-live-capture / conclude). Stage 2's evidence loop now exists and runs inside that turn, exactly as anticipated. **What REMAINS deferred** is only the **Tier-2 mid-turn `askToolLoop` retrieval** — folding `spec_lookup` / `dtc_lookup` into the unified turn so the brain can pull verified specs/DTC defs mid-turn via the PR-1 execute-then-continue loop (a generalized `askToolLoop`). The forced-tool + proactive `detectAllSpecIntents` spec injection covers the turn for now; the mid-turn live-retrieval fold is the open item. (Code-side note also in CLAUDE.md → Backend → vehicle spec retrieval and Diagnostic Engine Architecture → the unified diagnostic turn.)
