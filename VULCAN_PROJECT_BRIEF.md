# VULCAN — PROJECT BRIEF

## Purpose of this document
Strategic/contextual brief for a fresh chat about Vulcan. Captures product vision, decisions, architecture, roadmap, and working preferences so a new conversation can pick up without re-reading the full history. Code-level context lives in the repo's **CLAUDE.md**; the data-layer plan lives in **VULCAN_DATA_LAYER_STRATEGY.md** (both in the repo / Project knowledge — read those for full detail).

> **Last updated: 2026-06-20.** This session cleared the **entire near-term diagnostic-flow queue** (escalation handoff, photo bundle, OBD2/code-pull bundle, and a mobile bug batch), got **iOS testing running on a new iPhone**, and banked several product decisions (video dropped, stance-UI-switch scrapped, Confirmed gate tabled, recall-relevance found already-built). The diagnostic engine was already complete + hardware-validated; the flow has now been refined against real shop testing. **The two remaining major tracks are the UI redesign (next) and Phase-4 pre-launch infrastructure (the real bulk).** See "Recently shipped" and the phase tracker.

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
- **Data layer:** Supabase/Postgres stood up for the unified vehicle-data layer. Existing legacy caches (DTC/PID/VIN/specs) still JSON on a Railway Volume — migration of those into Postgres is deferred and deliberate.
- **AI:** **Opus 4.6** for Diagnose AND Ask Vulcan; Assess on Opus. Prompt caching (ephemeral) for cost control; 20-message history cap. (Opus 4.8 vs 4.6 per-workload is still an open decision — see Decisions to revisit.)
- **OBD2:** Dual Bluetooth transport — react-native-ble-plx (BLE), react-native-bluetooth-classic (Classic). Unified layer in lib/obd2.ts. DTC parsing isolated in pure, tested lib/dtcParser.ts. VIN parsing/validation isolated in pure, tested lib/vin.ts. **iOS now excludes the Classic pod from its build via a `react-native.config.js` autolinking override (shipped this session)** — iOS uses BLE only; Android keeps Classic.
- **Builds:** EAS Build. Dev (needs dev server), preview (standalone, this is the shop-test build), production. **Deploy rule: mobile changes ship via `eas update` (OTA, to the PREVIEW channel for shop testing); server changes only reach Railway via `git push` to main. A task touching both needs BOTH.** .env is local-dev only; OTA/Railway use eas.json env blocks / Railway dashboard vars.
- **iOS build status:** Founder is enrolled in the Apple Developer Program; preview (ad-hoc/internal) builds run on a **new iPhone** (the previous device was replaced — its UDID was registered via `eas device:create` so ad-hoc builds install). BLE/OBD2 validated on iOS via the Veepeak. Background BLE is deliberately NOT pursued (needs entitlements + rebuild + App-Review scrutiny, and a generic adapter can't reliably wake a closed app); on-app-open/foreground auto-reconnect is the target and works.
- **Repo:** GitHub. CLAUDE.md and VULCAN_DATA_LAYER_STRATEGY.md both committed.
- **Railway CLI:** authenticated (Claude Code can read deploy logs/status directly).

## The app modes
1. **Ask Vulcan** — open-ended Q&A, no VIN required, conversational. Pulls TSBs/recalls/specs. **Supports photo evidence** (attach a photo to a question; image-bearing asks bypass the response cache).
2. **Diagnose** — structured diagnostic flow, VIN-based, ends in a structured, confidence-rated diagnosis with relevant recalls/TSBs. Verified DTC defs injected server-side. **Supports photo evidence**, including **photo-on-intake** (attach a photo on the intake screen that rides into the first turn). (Note: an early-vision "diagnosis PDF" was never built — the Inspection Report is the only PDF deliverable today; build-or-drop is a parked decision.)
3. **Inspection Report** — multi-point inspection w/ PDF. **KEEP (decided 2026-06-10)** — the app's only customer-facing PDF deliverable, zero cost in the current nav; revisit at the premium UI redesign.
4. **OBD2 Scan** — Bluetooth connection, DTC reading (stored/pending/permanent), live data, status panel. A simple instrument with one door into diagnosis: "Escalate to Diagnosis."
- **Connect a Device (NEW this session)** — a dedicated front-door screen (reached from the home tiles) for one-time adapter setup: connection status, connect/pick adapter, reconnect, forget. It's a thin surface over the already-existing app-wide connection / saved-adapter / auto-reconnect machinery, so the tech no longer has to enter the OBD2 Scan screen just to connect. "Not connected" nudges now route here.
- The former **Smart Diagnose** (the AI diagnostic engine) was **folded into Diagnose** — no longer a separate mode.

Branding: navy blue (#004B87), white/light theme, lightning-bolt icon. Premium UI redesign planned later.

NOTE: The **mode restructure** that merged Diagnose + Smart Diagnose into one mode (with OBD2 as a simple "escalate to diagnosis" instrument) is **DONE** — the Diagnose thread runs on the unified `/api/diagnose-turn` brain.

---

## THE AI DIAGNOSTIC ENGINE ("Smart Diagnose") — core differentiator
Local-state + LLM-reasoning hybrid. Core principles (settled):
- Phone does cheap local processing free; Claude called only at decision points (3–7 calls/session, never streaming — central cost control).
- Persistent "diagnostic state object" (patient chart) holds the evolving case; Claude updates it.
- **Adaptive stance:** Claude declares AUTOPILOT (data-led) or GUIDED (directs physical inspection), with reason, and flips as evidence comes in. The genuine innovation. (The *reasoning* is live and core; a proposed decorative **stance-UI-switch was scrapped this session** — it was decoration, not capability.)
- One highest-value next step, never a checklist.
- Calibrated confidence in words (POSSIBLE / LIKELY / STRONGLY_SUPPORTED). **A 4th CONFIRMED rung was TABLED this session** — an audit confirmed the engine genuinely caps at STRONGLY_SUPPORTED with no drift; the data-flywheel value already exists via the case-level "Confirmed Fix" action, leaving only modest in-session value against real over-claim risk. Evidence for AND against each hypothesis; honest about the OBD2 data ceiling.
- **Safety discipline:** Claude reasons freely but must NEVER state a numeric factory spec unless verified-injected; unverified specs flagged for the tech.
- Phone produces objective FACTS only; judgment stays with Claude.

**Staged build plan (test each on a real car before the next):**
- **Stage 1 — single-shot brain:** ✅ BUILT & VALIDATED. Validated on a real P0442 EVAP case.
- **Stage 2 — iterative loop + MODE RESTRUCTURE:** ✅ **COMPLETE & hardware-validated on a 2016 F-350 (2026-06-14).** Claude requests specific data under specific conditions, the phone auto-captures, the diagnosis evolves — all inside the unified diagnostic turn. Delivered as: the UI restructure (Diagnose + Smart Diagnose merged; OBD2 became an "escalate to diagnosis" instrument); **diagnostic session save/resume** (versioned case envelope, auto-save, VIN-match resume, different-vehicle safety guard); the capture loop (resolver + sustained-hold detector + forward-capture + `/api/evidence-update`); and the **unified-flow merge (SB1–SB4)** putting the whole thread on ONE brain at `/api/diagnose-turn` (each turn: ask / request-a-live-capture / conclude). Cost safeguards live.
- **Stage 3 — guided inspection + stance:** **PARTIALLY SHIPPED / partially scrapped.** The **guided result-capture** half SHIPPED (brain-authored inspection-outcome tap buttons via `finding_options` on PHYSICAL_INSPECTION steps — the "big tap buttons"). The **adaptive-stance-UI-switch** half was **SCRAPPED** (decoration, not capability). The stance *reasoning* (AUTOPILOT/GUIDED) was already live from Stage 2.
- **Stage 4 — confirmed-fix priors:** NOT STARTED. Inject banked confirmed fixes as starting context (ties to the confirmed-fix DB flywheel).
- **Stage 5 — voice:** NOT STARTED. Hands-free voice/TTS (device-native). Queued behind the iPhone fixes.

---

## THE UNIFIED DATA LAYER (Phase 4 — PAUSED in a known-good state; its real feed is a pre-launch track)
**This is the keystone that makes the AI trustworthy.** Core principle, learned from the Ask Vulcan failures: *verified data is the factual foundation; AI is the reasoning layer on top. The model must never be the source of truth for a fact it would recall from memory.* (See VULCAN_DATA_LAYER_STRATEGY.md for full detail.)

**Why it exists:** Vehicle Finder API was proven a dead end (covers only 3 spec types, sparse, returns wrong records silently). The fix is a proprietary database Vulcan owns. Five data types: DTC defs (✅ done, 18,805 codes), VIN decode (✅ mostly, NHTSA), PID defs (✅ done, OBDb), **service specs (the gap)**, **component/config facts (new gap)**.

**Strategy:** generate the DB by having Claude **extract from source documents** (NOT from memory — the hallucination trap). Verification standard = **Option C**: strict store (only doc-extracted, provenance-tracked data enters), honest live fallback for misses (guard-railed Claude answer, ephemeral, never stored), miss-logging to drive what to source next.

**Status:**
- **Supabase/Postgres foundation:** ✅ BUILT & VERIFIED LIVE. `pg` over transaction pooler (server/db.js, reads SUPABASE_DB_URL); tables source/vehicle_variant/spec/component_fact/spec_miss; provenance FK on every fact; numbered SQL migrations (`npm run migrate`); fail-soft; RLS on. Legacy JSON caches untouched.
- **Extraction engine:** ✅ PROVEN + **PRODUCTIONIZED in Batch A** (trim + widened vocab + persisted audit columns). Accurate, **zero hallucinations** (mandatory verbatim-quote gate). ~$2.2/manual after trimming to spec-bearing sections (the originally-assumed sub-$1 did not hold — specs span ~170 back-half pages — but a `--full` diff proved the trim drops zero core specs). Build-once economics still win vs pay-per-lookup-forever.

**Batch A ✅ DONE & validated.** Of five improvements, three done (trim-before-extract; widen spec_type vocab +8 types; persist page + verbatim_quote); two deferred (stronger dedup; richer-manual schema expansion — fuses/bulbs/towing/lights/TPMS/battery/octane).

**Tier 1 first feed (DEFERRED to near-launch, demand-ranked off the miss-log):** extract from a small set of manufacturer manuals + government data to validate end-to-end at small scale. The engine is ready; this is a content/operations effort in the **pre-launch** window — the data layer is paused here in a known-good state (the engine that reasons over its facts is complete). (All deferred items + windows in VULCAN_DATA_LAYER_STRATEGY.md §11.)

Sourcing tiers: Tier 1 = open/gov/manufacturer-published docs (start here). Tier 2 = retrieval-grounded generation via Claude web search + Citations API + domain allowlist. Tier 3 = crowdsource from techs (the long-game moat; builds on the confirmed-fix DB). Never scrape proprietary DBs (Identifix/AllData/Mitchell1/Innova).

---

## KEY DECISIONS & reasoning
- **Diagnostic engine architecture** — local-state + LLM-at-decision-points; adaptive stance; one-next-step; calibrated confidence; verified-data-only safety.
- **Ask Vulcan accuracy fix** — was confidently wrong on specs. Fixed: moved to Opus, hard provenance-based spec rule in shared APP_CONTEXT, internal-consistency rule, spec questions non-cacheable, version-keyed self-pruning cache. CONCLUSION: free-form mechanical fabrication is NOT fully fixable by prompt/model — the real fix is the verified database; the guardrail makes misses *honest* meanwhile.
- **Data layer** — generate-from-source-docs, strict store + honest fallback, Supabase foundation.
- **Claude-directed monitoring** (not autonomous anomaly detection); delivered via the unified diagnostic turn.
- **Escalation handoff is codes-only (this session)** — escalating to diagnosis now sends codes + vehicle only, NOT the passive key-on/engine-off PID snapshot (which used to mislead the brain into a visual-inspection default by looking like "no live data exists"). The OBD2 window still shows live PIDs locally; they just aren't handed to Claude. For a monitorable fault the brain **proactively offers** a live capture. Live data reaches Claude only via a Claude-requested capture (or the new `PULL_CODES` re-pull).
- **OBD2 parsing: harden in-house**, no adoptable third-party stack. Owning the parser = owning the failure mode.
- **BLE-only on iOS** (Apple MFi blocks Classic). OBDLink MX+/LX = Android only. iPhone needs BLE (Veepeak BLE+ confirmed). The Classic pod is now excluded from the iOS build.
- **Photos are local-only for now** (expo-file-system documentDirectory); cloud storage waits on the pending auth work. Photo offers from Claude are **invitational, never demanded** ("send one if you can"), and prose-only (no structured button).
- **VIN check digit is a SOFT signal**, not a hard reject — protects valid foreign-market VINs.
- **Video input DROPPED** — Claude can't process video natively; the "weird noise" case is audio (also unusable); marginal value over photos.
- **Legitimate data sources only.** Open/CC/gov/manufacturer-published + Claude extraction + confirmed-fix DB.
- **Scalability is a standing requirement** — flag non-scalable choices with the scalable solution noted.

## OBD2 data/protocol expansion (three tiers)
- **Tier 1 — harden generic OBD2** (highest priority). DTC multi-frame rewrite done. ATDP/ATH0 non-CAN handling integrated (verify during the pro-tool validation gate).
- **Tier 2 — manufacturer-specific PID/DTC defs** via NASTF (Right-to-Repair). Legitimate, slow, over time.
- **Tier 3 — deep non-engine module access (ABS/airbag/BCM) — OUT OF SCOPE.** Needs J2534 + Windows PC. Honest framing (great in the generic lane, truthful about the ceiling) is the right posture.

---

## RECENTLY SHIPPED (this session, 2026-06)
All OTA unless noted. The entire near-term diagnostic-flow queue was cleared:
- **Guided result-capture** (Stage 3 step 1) — brain-authored inspection-outcome tap buttons.
- **Photo evidence** in both Diagnose and Ask Vulcan; **photo-on-intake**; **proactive (invitational) photo offer**. (Diagnose photo forced one native rebuild; the rest OTA.)
- **Escalation handoff → codes-only** + proactive live-capture offer + a **WAITING-state per-condition readout** (live values vs targets, so "warming up" no longer reads as "broken").
- **OBD2 / code-pull bundle** — the **Connect-a-Device tab** (thin surface over existing connection/auto-reconnect) + an additive **`PULL_CODES`** next-step type (Claude can request a fresh code re-pull mid-session; degrades gracefully when disconnected; different-vehicle guarded).
- **Mobile bug batch** — keyboard avoidance (chat + forms), header crowding (Navbar), and a **VIN scanner overhaul** (removed the iOS bounds-gate that rejected ~90% of code39 scans; VIN extract + soft check digit in pure `lib/vin.ts`; widened barcode types).
- **iOS** — Classic-Bluetooth pod excluded from the iOS build; fresh ad-hoc build running on the new iPhone.
- **"CONFIRMED DIAGNOSIS"** legacy heading renamed to "Diagnosis" (over-claim fix).
- **Recall relevance** — investigated and found **already built** (Claude-judged via `relevant_recall_campaigns`); no work needed. A coverage gap was found and parked (below).

---

## ROADMAP / PHASE TRACKER
| Phase | Status |
|---|---|
| 1. Get off Expo Go | ✅ COMPLETE |
| 2. OBD2 Foundation | ✅ COMPLETE |
| 3a. Diagnostic engine Stage 1 | ✅ COMPLETE |
| 3b. Stage 2 (iterative loop + mode restructure) | ✅ COMPLETE & hardware-validated (2016 F-350, 2026-06-14) |
| 3c. Stage 3 (guided inspection + stance) | ✅ guided result-capture SHIPPED; ⛔ stance-UI-switch SCRAPPED (decoration) |
| 3d. Stages 4–5 (confirmed-fix priors; voice) | NOT STARTED (voice queued behind iPhone work) |
| 3e. Near-term diagnostic-flow refinement | ✅ COMPLETE this session (escalation handoff, photo bundle, OBD2/code-pull, bug batch) |
| 4. Pre-launch infrastructure | 🔄 IN PROGRESS (data layer paused known-good; iOS Classic-pod cleanup ✅ done) |
| 5. Testing & launch | NOT STARTED |

**Where things stand right now:** the **diagnostic engine is complete and hardware-validated**, and this session **refined the flow against real shop testing and cleared the entire near-term queue**. The **two remaining major tracks** are: **(1) the UI redesign** — the "cleaner, less clutter, easier to understand" pass, deliberately saved for LAST so it builds on a flow that already behaves; and **(2) Phase-4 pre-launch infrastructure** — the real bulk of the road to launch (auth, billing, analytics, error tracking, the data-layer real feed, self-hosted vPIC, the OBD2 trust gate, etc.). **Deferred engine polish** (not blocking): **baseline-poll-on-connect** (a light passive poll on connect so a Diagnose-first session has a live snapshot immediately); and **offline resilience** (a VIN-decode failure bit live during F-350 testing — graceful handling + local buffering, with the self-hosted NHTSA vPIC decoder as the durable fix).

### Phase 4 — Pre-launch infrastructure
- **Unified data layer** (in progress — replaces Vehicle Finder). Supabase foundation ✅; real feed deferred to near-launch.
- JSON→Postgres migration of the *existing* caches — deferred; via a "confidence gate" (one system at a time, DTC first, old kept as fallback until proven).
- Server-side cost monitoring → structured table + dashboard (replaces the in-app cost log).
- Real auth (Supabase) — replaces a PLACEHOLDER sign-in. Unblocks cloud photo storage + cloud-synced records. Apple Sign-In if social login on iOS.
- Billing (RevenueCat + Stripe, tiered). Sentry (errors). Mixpanel (analytics). Fallback AI provider (for 529s).
- **OBD2 trust gate** — cross-validate reads vs Autel/Snap-on across makes/protocols (capture raw hex). (Note: the *connect-a-device tab* shipped; this read-validation gate is the separate, still-pending piece.)
- **Offline resilience ⚠️ PRIORITY** — graceful VIN-decode-failure handling + local OBD2 buffering; durable fix is the self-hosted NHTSA vPIC decoder. Compatible-adapters screen.
- iOS native cleanup remainder (the Classic-pod exclusion is done; remaining TestFlight-prep items below).

### Legal/Business
- Form LLC (NH) + EIN before revenue; CPA/attorney. Switch Apple/Google to Organization after LLC. Consolidate Supabase under a business account. Trademark "Vulcan" (Class 9 & 42); "VulcanDX" backup; TESS search first.

### Phase 5 — Testing & launch
TestFlight + Google Play internal testing. **Hard release gate: strip `EXPO_PUBLIC_DEBUG_OBD2` / `EXPO_PUBLIC_DEBUG_UI` before any customer-facing build.** PrivacyInfo.xcprivacy manifest; tighten NSAllowsArbitraryLoads; remove the now-unused NSMicrophoneUsageDescription (voice dropped for now); populate submit.production.ios; App Store Connect record. Finalize tiered pricing. App Store listing. Premium UI redesign (after core locked).

### Decisions to revisit
- **Opus 4.8 vs 4.6 per-workload** — same headline rate, but a new tokenizer can inflate input tokens up to ~35%; extraction is 94% input, so MEASURE on extraction before switching. Likely worth it for reasoning modes.
- ~~Inspection Report removal~~ — **decided KEEP (2026-06-10)**; revisit at the premium UI redesign.
- ~~Video input~~ — **decided DROP** (this session).
- ~~Stance-UI-switch~~ — **decided SCRAP** (this session); ~~Confirmed gate~~ — **TABLED** (this session).
- **Diagnosis PDF** — promised in the early vision, never built (only the Inspection Report produces a PDF). Build or drop the line.

### Parked bugs / side quests
- ~~VIN scan inconsistent capture + check-digit rejection~~ — **FIXED this session** (iOS bounds-gate removed; pure `lib/vin.ts` extract + soft check digit; widened barcode types).
- ~~Keyboard fields hidden behind the keyboard~~ — **FIXED this session** (chat + forms).
- **Recall coverage gap (new)** — recall relevance filtering works, but recalls attach only on the `provide_diagnosis` conclusion path, not the `emit_diagnostic_assessment` conclusion path; depending on how the brain concludes, relevant recalls can silently not show. Small additive fix.
- **Classic-Bluetooth lib RC→stable pin (new)** — `react-native-bluetooth-classic` is on `^1.73.0-rc.17`; pin to stable eventually (touches Android, needs Android retest).
- **Ask→Diagnose photo handoff (new)** — a photo attached in Ask doesn't carry when switching to Diagnose (text-only handoff). Mitigated by photo-on-intake (re-attach on the Diagnose intake).
- **Records heading redundancy (new)** — "FINAL DIAGNOSIS" above "DIAGNOSIS" in the records view.
- **Confidence-on-card (new)** — optionally show "Strongly Supported" on the conclusion card (needs a saved field for records).
- 2015 Volvo XC70 read no PIDs at all (needs screenshots; modern/CAN).
- Pre-existing typecheck errors in ask.tsx/diagnose.tsx (the ~9 "Handoff" errors — known, harmless, non-blocking to builds).

---

## WORKING PREFERENCES
- Terminal: **Windows CMD**, not PowerShell.
- This chat generates **self-contained prompt blocks** for Claude Code. For big/complex work, prompts instruct Claude Code to **review and flag concerns BEFORE writing code** (the review-first pattern — has caught real issues repeatedly, including overturning wrong assumptions this session; keep using it).
- **Check which model Claude Code is on** at the start of important sessions — Opus for heavy reasoning, Sonnet fine for mechanical tasks. (A Sonnet default once caused a subtly-broken fix.)
- **Confirm BOTH `eas update` AND `git push`** happened when a task touches mobile + server. Server changes verified on the SERVER (Railway logs/CLI), not just locally.
- Founder prefers **phase-tracker / categorized** status formats.
- Founder is non-technical — **plain-English, no unexplained jargon**.
- **Keep responses reasonably concise.**
- Don't reference time-of-day.
- **Verify hardware/services/APIs/pricing via web search**, not memory.
- Keep CLAUDE.md (and this brief + the strategy doc) updated on major changes. (Reconcile CLAUDE.md against the actual code periodically — doc-update instructions in build prompts aren't independently verified.)
- For foundational/critical code, **build test fixtures** so logic validates without the physical vehicle (founder tests only on vehicles on hand).
- Secrets: tokens/keys/connection strings go in env vars by the founder's own hand, never pasted into Claude Code chat, never committed.

## KNOWN GOTCHAS / LESSONS
- Long Claude Code sessions degrade — reset periodically (`/clear`), rely on CLAUDE.md. Confirm server changes actually get PUSHED, not just OTA'd.
- **A stale OTA build can masquerade as a bug** — an OTA update sometimes needs a few force-closes to take; a "broken" fix was just an app that hadn't picked up the update (this session).
- **A new iPhone needs its UDID registered (`eas device:create`) before an ad-hoc/preview build will install** — registration doesn't carry over from old hardware; use `--refresh-ad-hoc-provisioning-profile` or `eas credentials` to fold it into the profile, then rebuild.
- **Investigation-first repeatedly overturns wrong assumptions** — this session the "VIN scan misses because code39 isn't enabled" theory and the "live monitoring is broken because polling is broken" theory were BOTH wrong (real causes: an iOS bounds-gate; and a misleading key-on/engine-off escalation snapshot). Map root cause before building.
- **A snapshot taken at the wrong moment misleads the brain** — a key-on/engine-off default snapshot made Claude default to visual inspection; escalation now sends codes-only so the brain offers live capture.
- Dev builds depend on the dev server over WiFi — handoff breaks them. Preview builds are standalone.
- .env edits are fragile (a missing newline once corrupted the API base URL).
- OBD2 parsing must handle multi-ECU/multi-frame CAN — parse by CAN ID first, never flatten (the phantom-code root cause).
- Validate OBD2 reads vs professional tools — the read layer was once confidently wrong (phantom DTCs, 115V O2) and only caught by cross-checking.
- OBD2 hard limits: no manufacturer-module access without OEM/J2534; odometer not reliably available; sub-second refresh only on batched Mode 01.
- **Confident-wrongness is the core AI risk** — proven repeatedly. The architectural answer is verified data + reasoning-over-facts, not a smarter guesser.
- Caches can mask fixes — when a fix "doesn't take," check whether a cache is serving stale data, at the right layer (server vs app).
- Showing Claude's reasoning to the user does NOT increase API cost.

## HARDWARE NOTES
- OBDLink MX+ (owned): Android (Classic) only, NOT iOS.
- OBDLink LX (owned): Classic, NOT iOS.
- Veepeak OBDCheck BLE+ (owned): BLE, works iOS AND Android. The validated iOS adapter.
- Test devices: ONN Android tablet (MX+) + **a new iPhone (Veepeak; UDID registered for ad-hoc builds)**. Founder also has shop access with many makes/models. Test vehicles to date: 2011 GMC Sierra (real codes: B1516 body code [OBD2-unreachable] + P0442 EVAP permanent), 2016 F-350 (engine validation), plus live shop cases (e.g. a 2016 VW Passat O2 case that surfaced the escalation-handoff and waiting-legibility fixes). Pro tools for validation: Autel + Snap-on.
- For users: recommend BLE adapters; Classic = Android only.
