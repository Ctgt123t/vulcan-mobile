# VULCAN — PROJECT BRIEF

## Purpose of this document
Strategic/contextual brief for a fresh chat about Vulcan. Captures product vision, decisions, architecture, roadmap, and working preferences so a new conversation can pick up without re-reading the full history. Code-level context lives in the repo's **CLAUDE.md**; the data-layer plan lives in **VULCAN_DATA_LAYER_STRATEGY.md** (both in the repo / Project knowledge — read those for full detail).

## What Vulcan is
An AI-powered automotive diagnostic mobile app for professional technicians. Core value: an AI diagnostic assistant (powered by Claude) that connects to vehicles via OBD2 Bluetooth adapters, reads live data and trouble codes, and reasons about them like a master technician — guiding diagnosis rather than displaying raw numbers. Signature feature is "autopilot" diagnosis: plug in, and Vulcan reasons to a confirmed root cause with minimal manual input, shifting between leading the diagnosis itself (data-driven faults) and directing the tech's physical inspection (mechanical faults).

Founder (Cole, Manchester NH) is a non-coder with automotive knowledge. The app is built entirely via Claude Code and AI-generated prompts. This chat's role: generate prompts for Claude Code, strategic guidance, research, troubleshooting.

## Target market & business model
- Primary market: individual professional technicians, targeting thousands of users
- Not initially targeting shops/dealerships (existing tooling/licensing) — possible later
- Subscription, monthly. Target $40–50/mo min, likely tiered: Basic / Pro / Shop
- Powered by Claude API — no custom ML model. Margin = subscription revenue minus API/infra costs
- Key risk: API costs scaling with usage. Cost control is a recurring design priority.

## Tech stack & architecture
- **Frontend:** Expo SDK 54, React Native, TypeScript, Expo Router
- **Backend:** Node.js/Express on Railway (auto-deploys from GitHub main)
- **Data layer (NEW — see below):** Supabase/Postgres now stood up for the unified vehicle-data layer. Existing legacy caches (DTC/PID/VIN/specs) still JSON on a Railway Volume — migration of those into Postgres is deferred and deliberate.
- **AI:** **Opus 4.6** for Diagnose AND Ask Vulcan (Ask Vulcan was moved from Sonnet to Opus this session for accuracy). Assess/Smart Diagnose on Opus. Prompt caching (ephemeral) for cost control; 20-message history cap.
- **OBD2:** Dual Bluetooth transport — react-native-ble-plx (BLE), react-native-bluetooth-classic (Classic). Unified layer in lib/obd2.ts. DTC parsing isolated in pure, tested lib/dtcParser.ts.
- **Builds:** EAS Build. Dev (needs dev server), preview (standalone, this is the shop-test build), production. **Deploy rule: mobile changes ship via `eas update` (OTA, to the PREVIEW channel for shop testing); server changes only reach Railway via `git push` to main. A task touching both needs BOTH.** .env is local-dev only; OTA/Railway use eas.json env blocks / Railway dashboard vars.
- **Repo:** GitHub. CLAUDE.md and VULCAN_DATA_LAYER_STRATEGY.md both committed.
- **Railway CLI:** authenticated (Claude Code can read deploy logs/status directly).

## The app modes
1. **Ask Vulcan** — open-ended Q&A, no VIN required, conversational. Pulls TSBs/recalls/specs.
2. **Diagnose** — structured diagnostic flow, VIN-based, ends in confirmed diagnosis + PDF. Verified DTC defs injected server-side.
3. **Inspection Report** — multi-point inspection w/ PDF. **KEEP (decided 2026-06-10)** — the app's only customer-facing PDF deliverable, zero cost in the current nav; revisit at the premium UI redesign.
4. **OBD2 Scan** — Bluetooth connection, DTC reading (stored/pending/permanent), live data, status panel. Now a simple instrument with one door into diagnosis: "Escalate to Diagnosis."
- The former **Smart Diagnose** (the AI diagnostic engine) was **folded into Diagnose** — it is no longer a separate mode (see below).

Branding: navy blue (#004B87), white/light theme, lightning-bolt icon. Premium UI redesign planned later.

NOTE: The **mode restructure** that merged Diagnose + Smart Diagnose into one mode (with OBD2 as a simple "escalate to diagnosis" instrument) is **DONE** — the Diagnose thread now runs on the unified `/api/diagnose-turn` brain (see the diagnostic-engine section below).

---

## THE AI DIAGNOSTIC ENGINE ("Smart Diagnose") — core differentiator
Local-state + LLM-reasoning hybrid. Core principles (settled):
- Phone does cheap local processing free; Claude called only at decision points (3–7 calls/session, never streaming — central cost control).
- Persistent "diagnostic state object" (patient chart) holds the evolving case; Claude updates it.
- **Adaptive stance:** Claude declares AUTOPILOT (data-led) or GUIDED (directs physical inspection), with reason, and flips as evidence comes in. The genuine innovation.
- One highest-value next step, never a checklist.
- Calibrated confidence in words (POSSIBLE / LIKELY / STRONGLY_SUPPORTED; CONFIRMED reserved for a later confirmation gate). Evidence for AND against each hypothesis; honest about the OBD2 data ceiling.
- **Safety discipline:** Claude reasons freely but must NEVER state a numeric factory spec unless verified-injected; unverified specs flagged for the tech.
- Phone produces objective FACTS only; judgment stays with Claude.

**Staged build plan (test each on a real car before the next):**
- **Stage 1 — single-shot brain:** ✅ BUILT & VALIDATED. Snapshot → structured assessment via /api/assess, Opus, tool use. Validated on a real P0442 EVAP case.
- **Stage 2 — iterative loop + MODE RESTRUCTURE:** ✅ **COMPLETE & hardware-validated on a 2016 F-350 (2026-06-14).** Claude requests specific data under specific conditions, the phone auto-captures, and the diagnosis evolves — all inside the unified diagnostic turn. Delivered as: the UI restructure (Diagnose + Smart Diagnose merged; OBD2 became a simple "escalate to diagnosis" instrument; the embeddable "capture-card" primitive is now driven by the real executor); **diagnostic session save/resume** (versioned case envelope, auto-save, VIN-match resume, different-vehicle safety guard); the capture loop (resolver + sustained-hold detector + forward-capture + the `/api/evidence-update` endpoint); and the **unified-flow merge (SB1–SB4)** that put the whole thread on ONE brain at `/api/diagnose-turn` (each turn: ask / request-a-live-capture / conclude) with a self-continuing capture loop. Cost safeguards live: sustained-condition / per-PID cooldown / auto-pause retained; the per-session fire-count cap was removed once the loop was hardware-proven.
- **Stage 3** — adaptive-stance UI switching + guided-inspection checklist (big tap buttons); stance flips mid-diagnosis.
- **Stage 4** — confirmed-fix priors injected as starting context (ties to confirmed-fix DB flywheel).
- **Stage 5** — hands-free voice/TTS (device-native TTS).

---

## THE UNIFIED DATA LAYER (Phase 4 — PAUSED in a known-good state; its real feed is a pre-launch track)
**This is the keystone that makes the AI trustworthy.** Core principle, learned from the Ask Vulcan failures: *verified data is the factual foundation; AI is the reasoning layer on top. The model must never be the source of truth for a fact it would recall from memory.* (See VULCAN_DATA_LAYER_STRATEGY.md for full detail.)

**Why it exists:** Vehicle Finder API was proven a dead end this session (covers only 3 spec types, sparse, returns wrong records silently). The fix is a proprietary database Vulcan owns. Five data types: DTC defs (✅ done, 18,805 codes), VIN decode (✅ mostly, NHTSA), PID defs (✅ done, OBDb), **service specs (the gap)**, **component/config facts (new gap)**.

**Strategy:** generate the DB by having Claude **extract from source documents** (NOT from memory — that's the hallucination trap). Verification standard = **Option C**: strict store (only doc-extracted, provenance-tracked data enters), honest live fallback for misses (the existing guard-railed Claude answer, ephemeral, never stored), miss-logging to drive what to source next.

**Status:**
- **Supabase/Postgres foundation:** ✅ BUILT & VERIFIED LIVE. `pg` connection over transaction pooler (server/db.js, reads SUPABASE_DB_URL); tables source/vehicle_variant/spec/component_fact/spec_miss; provenance FK on every fact; CHECK-constraint vocab; numbered SQL migrations (`npm run migrate`); fail-soft (a DB outage can't crash the core app); RLS on (owner-role bypasses). Legacy JSON caches untouched.
- **Extraction engine:** ✅ PROVEN via first-slice test on the 2011 GMC Sierra owner's manual, then **PRODUCTIONIZED in Batch A** (trim + widened vocab + persisted audit columns). Accurate (matched the known 5.3L oil spec, etc.), **zero hallucinations** (a mandatory verbatim-quote gate enforces this; 0/120 items stored without a quote; the front 300 non-spec pages returned nothing rather than inventing). Cost: $6.31 to feed the whole 594-page manual (~94% input/document cost); **trimming to the spec-bearing sections cut this ~66% to ~$2.2/manual.** The originally-assumed **sub-$1 did NOT hold** — specs span ~170 back-half pages, not the ~50–80 assumed — but a `--full` baseline diff proved the trim drops **zero core specs** (only a non-core, deferred item — fuel octane — fell in a band gap). Build-once economics still win: ~$2 once per vehicle vs Vehicle Finder's pay-per-lookup-forever.

**Productionize the pipeline — BATCH A ✅ DONE & validated.** Of the five known improvements, three were done together as Batch A; two stay deferred:
1. Trim-before-extract — ✅ DONE. Local keyword-density page scan feeds only spec-bearing bands; ~66% cost cut to ~$2.2/manual; `--full` diff proved **zero core specs dropped**.
2. Widen the spec_type vocab — ✅ DONE. +8 types (fuel/axle/transfer-case fluids, gvwr, gawr, idle_speed) **+ a required descriptive label for `other`**.
3. Stronger dedup (currently exact-match only) — ⏸ DEFERRED.
4. Persist page + verbatim_quote on rows — ✅ DONE. Both NOT NULL; `page` remapped to absolute PDF page; a per-run JSON snapshot is dumped so a regression baseline survives independently of the DB.
5. Expand schema for richer manual data — **fuses, bulbs, towing capacities, warning lights, tire/TPMS, battery, octane** (a deliberate scope expansion; owner's manuals are richer than "specs + component facts") — ⏸ DEFERRED.

**Tier 1 first feed (DEFERRED to near-launch, demand-ranked off the miss-log):** extract from a small set of manufacturer manuals + government data to validate the end-to-end pipeline at small scale on real, safe sources. The engine is ready; this is a content/operations effort that sits in the **pre-launch** window, not the immediate next task — the data layer is paused here in a known-good state (the diagnostic engine that reasons over its facts is now complete; see above). (All deferred data-layer items + their windows are catalogued in VULCAN_DATA_LAYER_STRATEGY.md §11.)

Sourcing tiers (layered): Tier 1 = open/gov/manufacturer-published docs (start here). Tier 2 = retrieval-grounded generation via Claude web search + Citations API + domain allowlist (the scale accelerator; verification de-risked this session — citations are API-guaranteed). Tier 3 = crowdsource from techs in the field (the long-game moat; builds on the confirmed-fix DB). Never scrape proprietary DBs (Identifix/AllData/Mitchell1/Innova).

---

## KEY DECISIONS & reasoning
- **Diagnostic engine architecture** — local-state + LLM-at-decision-points; adaptive stance; one-next-step; calibrated confidence; verified-data-only safety.
- **Ask Vulcan accuracy fix (this session)** — was confidently wrong on specs. Root cause: confidence-gated guardrails a confident-wrong model sails past, plus a thinner prompt than Diagnose. Fixed: moved to Opus, hard provenance-based spec rule in shared APP_CONTEXT (covers all modes, label-not-suppress in conversational modes, strict in assess), internal-consistency rule, spec questions non-cacheable, version-keyed self-pruning response cache. CONCLUSION: free-form mechanical fabrication is NOT fully fixable by prompt/model — the real fix is the verified database. The guardrail makes misses *honest* in the meantime.
- **Data layer** — see above. Generate-from-source-docs, strict store + honest fallback, Supabase foundation.
- **Claude-directed monitoring** (not autonomous anomaly detection) for live monitoring; **delivered** via the unified diagnostic turn (Stage 2). Cost safeguards as above.
- **OBD2 parsing: harden in-house**, no adoptable third-party stack exists. Owning the parser = owning the failure mode.
- **BLE-only on iOS** (Apple MFi blocks Classic). OBDLink MX+/LX = Android only. iPhone needs BLE (Veepeak BLE+ confirmed).
- **Legitimate data sources only.** Proprietary DB from open/CC/gov/manufacturer-published sources + Claude extraction + confirmed-fix DB.
- **Scalability is a standing requirement** (CLAUDE.md): flag non-scalable choices with the scalable solution noted.

## OBD2 data/protocol expansion (three tiers)
- **Tier 1 — harden generic OBD2** (highest priority). DTC multi-frame rewrite done. ATDP/ATH0 non-CAN handling for pre-2008/non-US vehicles was INTEGRATED this session (verify during the pro-tool validation gate).
- **Tier 2 — manufacturer-specific PID/DTC defs** via NASTF (Right-to-Repair). Legitimate, slow, over time.
- **Tier 3 — deep non-engine module access (ABS/airbag/BCM) — OUT OF SCOPE.** Needs J2534 + Windows PC, not phone+dongle. Honest framing (great in the generic lane, truthful about the ceiling) is the right posture.

---

## ROADMAP / PHASE TRACKER
| Phase | Status |
|---|---|
| 1. Get off Expo Go | ✅ COMPLETE |
| 2. OBD2 Foundation | ✅ COMPLETE |
| 3a. Diagnostic engine Stage 1 | ✅ COMPLETE |
| 3b. Stage 2 (iterative loop + mode restructure) | ✅ COMPLETE & hardware-validated (2016 F-350, 2026-06-14) — Stage 2A merge + 2B save/resume + 2C-1..4 + the unified-flow merge SB1–SB4 |
| 3c. Stage 3 (adaptive-stance UI, guided checklists) | NOT STARTED |
| 3d. Stages 4–5 (confirmed-fix priors; voice) | NOT STARTED |
| 4. Pre-launch infrastructure | 🔄 IN PROGRESS (data layer: foundation + extraction pipeline productionized — Batch A ✅ + Option C spec path + tool-use routing live; paused in a known-good state — Tier 1 feed deferred to near-launch; deferred items in strategy §11) |
| 5. Testing & launch | NOT STARTED |

**Where things stand right now:** the **diagnostic engine is COMPLETE and hardware-validated** (Stage 1 single-shot + Stage 2 iterative evidence loop + the mode merge, all running on the unified `/api/diagnose-turn` brain, proven on a 2016 F-350 on 2026-06-14). The **two active tracks next** are: **(1) UX / flow trimming & fine-tuning** of the diagnostic experience, and **(2) pre-launch infrastructure** (auth, billing, Sentry, analytics, the data-layer real feed, self-hosted vPIC). The data layer is **paused in a known-good state** (Tier 1 feed + remaining items deferred to pre-launch, catalogued in strategy §11) — pausing it never blocked the engine, since the engine reasons over the facts it provides. **Deferred polish on the engine** (not blocking): **baseline-poll-on-connect** (start a light passive PID poll on connect so a Diagnose-first session has a live snapshot immediately — today a connected-but-empty start asks one operating-condition question before its first capture); and the **offline-resilience priority bump** (a VIN-decode failure bit live during SB4 F-350 testing — graceful decode-failure handling + local OBD2 buffering, with the **self-hosted NHTSA vPIC decoder** as the durable fix).

### Phase 4 — Pre-launch infrastructure
- **Unified data layer** (in progress — replaces Vehicle Finder). Supabase foundation ✅.
- JSON→Postgres migration of the *existing* working caches — deferred; via a "confidence gate" (one system at a time, DTC first, old kept as fallback until proven).
- Server-side cost monitoring → structured table + dashboard (replaces the temporary in-app cost log). dtc-fallback is a separate cost line.
- Real auth (Supabase) — replaces a PLACEHOLDER sign-in currently in the app (no real auth; flagged in git history). Apple Sign-In if social login on iOS.
- Billing (RevenueCat + Stripe, tiered). Sentry (errors). Mixpanel (analytics). Fallback AI provider (Claude→GPT-4o for 529s).
- **OBD2 trust gate** — cross-validate reads vs Autel/Snap-on across makes/protocols (capture raw hex). Verify the ATDP/ATH0 non-CAN work here.
- iOS native cleanup (exclude Classic BT pod via config plugin; needs rebuild; before TestFlight). **Offline resilience ⚠️ PRIORITY** — a VIN-decode failure bit live during SB4 F-350 testing, so it's bumped up: graceful VIN-decode-failure handling + local OBD2 buffering, with the **self-hosted NHTSA vPIC decoder** as the durable fix (removes the NHTSA-API network dependency). Compatible-adapters screen.

### Legal/Business
- Form LLC (NH) + EIN before revenue; CPA/attorney. Switch Apple/Google to Organization after LLC. Consolidate Supabase under a business account (currently personal GitHub login). Trademark "Vulcan" (Class 9 & 42); "VulcanDX" backup; TESS search first.

### Phase 5 — Testing & launch
TestFlight + Google Play internal testing. Finalize tiered pricing. App Store listing. Premium UI redesign (after core locked).

### Decisions to revisit
- **Opus 4.8 vs 4.6 per-workload** — same headline rate, but a new tokenizer can inflate input tokens up to ~35%; extraction is 94% input, so MEASURE on extraction before switching. Likely worth it for reasoning modes. Mind US-inference premium + cost-tracking recalibration.
- ~~Inspection Report removal~~ — **decided KEEP (2026-06-10)** during the mode restructure; revisit at the premium UI redesign.

### Parked bugs / side quests
- VIN scan inconsistent capture + "check digit" rejection (deferred to UI/interface stage).
- 2015 Volvo XC70 read no PIDs at all (needs screenshots; modern/CAN).
- ~~Green "adapter connected" bar stuck on after disconnect~~ — **FIXED (2026-06-12)** (Classic disconnect listener read the nested `event.device.address`; pending shop-device confirmation).
- Pre-existing typecheck errors in ask.tsx/diagnose.tsx (known, harmless).

---

## WORKING PREFERENCES
- Terminal: **Windows CMD**, not PowerShell.
- This chat generates **self-contained prompt blocks** for Claude Code. For big/complex work, prompts instruct Claude Code to **review and flag concerns BEFORE writing code** (the review-first pattern — has caught real issues repeatedly; keep using it).
- **Check which model Claude Code is on** at the start of important sessions — Opus for heavy reasoning, Sonnet fine for mechanical tasks. (A Sonnet default once caused a subtly-broken fix.)
- **Confirm BOTH `eas update` AND `git push`** happened when a task touches mobile + server. Server changes verified on the SERVER (Railway logs/CLI), not just locally.
- Founder prefers **phase-tracker / categorized** status formats.
- Founder is non-technical — **plain-English, no unexplained jargon**.
- **Keep responses reasonably concise** (a recurring issue in prior chats was over-long replies).
- Don't reference time-of-day.
- **Verify hardware/services/APIs/pricing via web search**, not memory.
- Keep CLAUDE.md (and the strategy doc) updated on major changes.
- For foundational/critical code, **build test fixtures** so logic validates without the physical vehicle (founder tests only on vehicles on hand).
- Secrets: tokens/keys/connection strings go in env vars by the founder's own hand, never pasted into Claude Code chat, never committed.

## KNOWN GOTCHAS / LESSONS
- Long Claude Code sessions degrade — reset periodically (`/clear`), rely on CLAUDE.md. Confirm server changes actually get PUSHED, not just OTA'd.
- Dev builds depend on the dev server over WiFi — handoff breaks them, causing silent failures. Preview builds are standalone.
- .env edits are fragile (a missing newline once corrupted the API base URL).
- OBD2 parsing must handle multi-ECU/multi-frame CAN — parse by CAN ID first, never flatten (the phantom-code root cause).
- Validate OBD2 reads vs professional tools — the read layer was once confidently wrong (phantom DTCs, 115V O2) and only caught by cross-checking.
- OBD2 hard limits: no manufacturer-module access without OEM/J2534; odometer not reliably available; sub-second refresh only on batched Mode 01.
- **Confident-wrongness is the core AI risk** — proven repeatedly (specs, filter type). Unpredictable, not prompt-fixable. The architectural answer is verified data + reasoning-over-facts, not a smarter guesser.
- Caches can mask fixes: a response cache served pre-fix answers until version-keyed. When a fix "doesn't take," check whether a cache is serving stale data, and check the right layer (server vs app).
- Showing Claude's reasoning to the user does NOT increase API cost.

## HARDWARE NOTES
- OBDLink MX+ (owned): Android (Classic) only, NOT iOS.
- OBDLink LX (owned): Classic, NOT iOS.
- Veepeak OBDCheck BLE+ (owned): BLE, works iOS AND Android.
- Test devices: ONN Android tablet (MX+) + iPhone (Veepeak). Founder also has shop access with many makes/models. Test truck: 2011 GMC Sierra (real codes: B1516 body code [OBD2-unreachable] + P0442 EVAP permanent). Pro tools for validation: Autel + Snap-on.
- For users: recommend BLE adapters; Classic = Android only.
