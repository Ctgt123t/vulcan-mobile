# VULCAN — ASK + DIAGNOSE UNIFIED-CHAT MERGE PLAN

> **Purpose of this document.** Source-of-truth for merging Vulcan's two chat channels — **Ask Vulcan** and **Diagnose** — into one fluid chat interface, **without degrading the diagnostic engine or its safeguards.** It captures the read-only architecture investigation's findings, the locked decisions, the open decisions still needing founder ratification, and the phased build plan. Written so a fresh session (no prior chat context) can pick this up fully oriented. Companion to `CLAUDE.md`, `VULCAN_PROJECT_BRIEF.md`, and `VULCAN_DATA_LAYER_STRATEGY.md`.
>
> **Status: DECISIONS RATIFIED (founder, 2026-07-01) — Phase 0 complete; build phase active starting at Phase 1.** The investigation was strictly read-only (nothing in the fenced engine was modified). All formerly-open decisions in §8 are now locked (see §1); a **persistent-chats requirement was added by founder directive** (§1.9, Phase 3).
>
> **Created: 2026-07-01.** Investigation performed on Opus 4.8. All file:line references below were verified first-hand against the code on this date (line numbers may drift as the code changes — treat the symbol names as the durable anchors).

---

## 0. THE REQUIREMENT (why this project exists)

Today the app has **two separate chat channels** that look nearly identical to the user — both are back-and-forth chat windows with a "Switch to [other] mode" toggle:

- **Ask Vulcan** — "ask anything automotive": specs, diagrams, general knowledge, light tooling. Conversational, no VIN required, cheap.
- **Diagnose** — the structured diagnostic engine: assessment schema, live capture / monitoring, multiple safeguards. Heavier, VIN-based, persistent cases.

**The goal:** merge them into **one fluid chat** where the brain intuitively handles a simple query or a full diagnostic session in the same thread, with fluid movement between the two — and where **usage-based pricing (credits / weighted usage) falls out naturally.**

**The overriding constraint (the #1 rule of this project):** the diagnostic / live-monitor brain is the most carefully-built, most fenced part of the whole system (byte-frozen `ASSESS_BODY`, the assessment schema, capture machinery, and multiple safeguards). **Any merge must not degrade that engine or its safeguards.** Priorities, in order: **(1) diagnostic-engine integrity → (2) a clean metering boundary → (3) fluid UX.**

---

## 1. LOCKED DECISIONS (the direction — do not re-litigate)

1. **Priority order is fixed:** engine integrity **>** clean metering **>** fluid UX. Every trade-off is resolved in that order.
2. **Recommended & adopted architecture = Option 3 (escalation / hybrid).** One chat thread that **starts light (Ask) and escalates into the structured engine as a single, visible event**, carrying context. **Both engines are left byte-for-byte unchanged behind the shell.** (Full options analysis in §5.)
3. **Escalation is the billable "diagnosis" event.** Pre-escalation Ask turns are light/free; escalation mints the diagnosis credit; the capture loop rides inside it. This is the cleanest and only user-explainable metering boundary. (§6)
4. **The engine's frozen invariants and safeguards are non-negotiable and must survive intact** (§4). A change that would edit a byte-frozen prompt section, weaken a safeguard, or make a soft-validator throw is out of bounds — flag before touching. New capability goes in **additive `UNIFIED_*`-only prompt sections + appended tools**, never by mutating the frozen spine.
5. **Investigation was read-only; the build is separately gated.** Each build phase has an investigate → build → verify gate (§7). The engine is never exposed to a big-bang change.
6. **Scope:** merge **only Ask + Diagnose.** OBD2 Scan and Inspection Report stay as separate instruments (they are not chat). *(Confirmed by founder 2026-07-01.)*
7. **Escalation trigger (locked 2026-07-01):** a **manual "Diagnose this" action, always available**, PLUS a **gentle, invitational, never-forced brain-suggested offer** (mirrors the existing photo-offer pattern — "we could run a full diagnosis on this if you want", never a command, never implying it's stuck without one).
8. **Billing unit (locked 2026-07-01):** a **flat "diagnosis credit" minted at the escalation event.** Pre-escalation Ask stays cheap/free via the existing zero-cost fast-paths (DTC direct-answer, spec fast-path, cache). The capture loop rides inside the credit.
9. **Thread behavior (locked 2026-07-01):** **once escalated, a thread stays diagnostic** (matches the case model); a fresh casual question starts a **new thread**. Casual side-questions inside a diagnosis are served by the deferred in-diagnosis retrieval (final phase).
10. **Persistent chats are a REQUIRED part of this merge, not optional (founder directive 2026-07-01).** A user must be able to **leave any thread (diagnosis or casual query) mid-flight, open or continue another** (e.g. a spec lookup on a different vehicle), **and return where they left off.** Today the two separate screens ARE the app's crude multitasking; collapsing both channels into one window removes it. Therefore **multi-thread persistence + a chat list must land WITH or BEFORE the unified shell — never after.** A unified shell without it is a regression and must not ship. (Diagnose already persists via `DiagnosticCaseV1`; the gap is the Ask/light channel — ephemeral `useState` today — and a unified thread list over both.)

**The one architecture explicitly rejected: Option 1 (a single unified brain that does casual Q&A and diagnosis implicitly).** It's the only path that re-tunes the *validated diagnostic behavior* and makes pricing incoherent. Do not drift toward "just let one brain do everything."

---

## 2. INVESTIGATION FINDINGS — CURRENT-STATE MAP

### 2A. Ask Vulcan channel

| Piece | Location | Notes |
|---|---|---|
| Mobile screen | `app/ask.tsx` (~1,079 ln) | Ephemeral chat; `messages` in `useState` only — **no save/resume**. |
| Client call | `lib/api.ts` `ask()` | POST `{messages, vehicle?, recalls, tsbs, sessionId}` → `{text, cost, diagrams}`. |
| Endpoint | `server/index.js` `/api/ask` (~724–1035) | Plain-text answer + optional diagram results. |
| Tool loop | `server/askToolLoop.js` `runAskToolLoop` (~324–407) | Agentic; cap 3 iters, then forced text-only. |
| Prompt | `ASK_SYSTEM_PROMPT` (~708–722) = `APP_CONTEXT` + conversational body | "Colleague, not a formal diagnostic system." **No structured output.** |
| Tools | `ASK_TOOLS = [spec_lookup, diagram_lookup]` (`askToolLoop.js` ~262) | Vehicle injected server-side, never a tool param. |
| Model | `ASK_MODEL = "claude-opus-4-6"` (index.js:82) | **Same model as Diagnose.** `max_tokens: 2048`. |
| Vehicle | `useVehicle()` (shared `VehicleContext`) | **VIN not required.** |
| Zero-cost fast-paths | index.js: DTC direct-answer (~813), spec fast-path hit (~882), cache hit (~940) — all `return {..., cost:null}` | `detectSpecIntent()` → `lookupSpec()` DB hit → **no Claude call.** Spec-shaped + photo questions never cached. |
| Discipline | `APP_CONTEXT` factory-spec rule (~131–147) | **Label-not-suppress:** likely value + "verify against OEM," never assert an unverified number. + internal-consistency rule. |

### 2B. Diagnose channel (the fenced engine)

| Piece | Location | Notes |
|---|---|---|
| Mobile screen | `app/diagnose.tsx` (~3,781 ln) | Phases `intake` → `chat`; thread interleaves `ChatMessage` + `AssessmentEntry` cards anchored by `afterMessageIndex`. |
| The brain | `/api/diagnose-turn` (~2046–2156) | **One brain, one move/turn.** `tool_choice:"any"`. Returns `turn: {kind: question\|assessment\|diagnosis}`. |
| Prompt | `UNIFIED_SYSTEM_PROMPT` = `APP_CONTEXT` + `UNIFIED_BODY` (`assessPrompt.js` ~309–310) | Frozen spine + additive `UNIFIED_*` sections. |
| Tools | `UNIFIED_TURN_TOOLS = [ask_followup_question, emit_diagnostic_assessment, provide_diagnosis]` (index.js ~1554–1558) | **No retrieval tools** — the diagnostic brain can't look up a spec or a diagram. |
| Structured tool | `ASSESS_TOOL` `emit_diagnostic_assessment` (index.js ~1144–1464) | `stance`, ranked `hypotheses`, `next_step` (`DATA_CAPTURE`/`PHYSICAL_INSPECTION`/`QUESTION`/`PULL_CODES` + `capture_plan`/`finding_options`), `unverified_specs_needed` (**required**), `decisive_reasons`, conclusion-only recall/TSB fields. |
| Capture loop | `/api/evidence-update` (~1945–2027) + `lib/capture{Resolver,Detector,Executor,Evidence}.ts` | Phone watches live data locally (**zero API cost**), fires on sustained gate → one evidence-update call → evolved assessment. |
| Model | `DIAGNOSE_MODEL = "claude-opus-4-6"` (index.js:81), `max_tokens: 8192` | Heavier context (snapshot/DTC/spec/recall). |
| State | `messages`/`assessments`/`evidenceLedger`/`caseState` (ref-mirrored, auto-saved) | Persistent **case envelope** `DiagnosticCaseV1` (`lib/diagnosticCasesCore.ts`) — VIN-keyed save/resume. |

**Why it's heavier than Ask despite the same model:** more calls per session + more injected context per call + the capture/evidence loop — **not** a pricier model. This is what makes "diagnosis-weight" a real, meterable thing.

### 2C. Overlap & seams

**Genuinely shared:** vehicle identity + recalls/TSBs (`contexts/VehicleContext.tsx`, one global provider used by both), OBD2 connection + ground-truth `connectedVin` (`contexts/Obd2Context.tsx`), `ChatMessage` type, retrieval backends (`diagramLookup.js`, `vehicleSpecs.js`/`supabaseSpecs.js`, `canonicalVehicle.js`), shared UI (`VehicleBar`, `DiagramResults`, `ImageZoomViewer`, photo pipeline), and **cost logging** (`costLogger.js`, bucketed by `callType` AND `sessionId`).

**Separate:** conversation state (each screen owns its `messages`), assessment/capture/case (Diagnose-only), the brains + endpoints, and — critically — **the toolsets** (Ask = retrieval + plain text; Diagnose = structured tools + no retrieval).

**The "Switch to [mode]" toggle** (`lib/handoff.ts`, AsyncStorage) is **asymmetric and lossy:**
- **Diagnose → Ask** carries the full `messages[]` (flattened to text).
- **Ask → Diagnose** carries only a `symptom` **string** — drops the whole Ask conversation **and any photo**. Hard `router.replace`, not a fluid continuation. **(Fixing this is Phase 1.)**

**Known asymmetry:** `diagram_lookup` is an **Ask brain tool**; Diagnose reaches diagrams via a **`FindDiagramModal`** that hits `/api/diagram-lookup` **directly, outside the brain** (fence-respecting). Specs are similar — Diagnose can't *ask* for a spec mid-turn; specs are pre-injected server-side from the complaint.

**Already unified under the hood:** vehicle context, OBD2 connection, retrieval backends, cost logging, and the **"one brain picks one of N tools per turn"** pattern that `/api/diagnose-turn` already embodies (this is the precedent the merge extends).

---

## 3. THE KEY INSIGHT

**This exact merge was already solved once, and it left the frozen engine untouched.** Folding conversational `/api/diagnose` + structured `/api/assess` into one brain (`/api/diagnose-turn`) used the pattern: **reuse the byte-frozen prompt spine verbatim, wrap it in new additive sections, let the brain pick one tool per turn.** The Ask+Diagnose merge is that same move one layer up: **one outer layer (casual ⇄ diagnostic) on top of the proven inner router (ask / assess / diagnose).** No new routing paradigm is invented.

---

## 4. ENGINE-INTEGRITY GUARDRAILS (a fresh session MUST NOT break these)

1. **The byte-freeze.** `server/scripts/verifyAssessPrompt.js` asserts `ASSESS_BODY` (`assessPrompt.js` ~149–150 = `ASSESS_HEAD + REASONING + MONITORING + SAFETY + FREEZE + OUTPUT`, ~4,487 bytes) is **byte-identical** to `assessBody.snapshot.txt`. Those spine sections are **reused verbatim** by `UNIFIED_BODY` and `EVIDENCE_UPDATE_BODY`. **Editing any spine section to improve the merged flow silently breaks Stage-1 parity.** New prompt text goes in `UNIFIED_*`-only sections. **Gate: `node server/scripts/verifyAssessPrompt.js` must PASS.**
2. **Numeric-vs-physical spec guard** — `SAFETY_SECTION` (`assessPrompt.js` ~82–100, **FROZEN**): never state an unverified factory number; route to `unverified_specs_needed` (a **required** schema field). The "a capture range is not a spec" carve-out lives here.
3. **Freeze-frame sentinel guard** — `UNIFIED_FREEZEFRAME_SECTION` (~268–277, editable): don't reason from engine-off default values (−40 °C / ~0 RPM).
4. **Wrong-vehicle guard** (client, structural) — `liveVehicleMatchesCase()` (`app/diagnose.tsx` ~429–436) reads **ground-truth `obd2.getConnectedVin()`** (never the overridable context VIN); `captureConnectionOk` (~737) gates every live-data send. **Never route the capture/live path through the overridable context VIN.**
5. **Recall-not-evidence guard** — `UNIFIED_RECALL_ADVISORY_SECTION` (~255–266, editable): recalls are advisory-only, surfaced at conclusion.
6. **`STRONGLY_SUPPORTED` ceiling** — frozen prompt + schema enum (no `CONFIRMED`).
7. **Fail-soft** — `validateCapturePlan` / `softValidateFindingOptions` drop malformed model output and **never throw**. Any new optional field needs the same treatment.

**Rule of thumb:** the engine's frozen invariants (1, 2, 6) are protected by the automated gate. Its behavioral discipline (2B–2C above) lives in the editable `UNIFIED_*` head and is only as safe as whatever a merge re-tunes — so the chosen architecture is the one that **does not force re-tuning it** (see §5).

---

## 5. ARCHITECTURE OPTIONS (assessment; Option 3 chosen)

| | **Opt 1 — Unified brain** | **Opt 2 — Router in front** | **Opt 3 — Escalation / hybrid (CHOSEN)** |
|---|---|---|---|
| One prompt+toolset does both, chooses depth implicitly | A classifier routes each msg/session to the unchanged `/api/ask` or `/api/diagnose-turn` | Thread starts as Ask; a trigger escalates it into the unchanged structured engine, carrying context |
| **Engine integrity** | **Weakest** — re-tunes validated diagnostic behavior (byte-safe but behaviorally risky) | **Best** — both engines untouched | **Best** — engine *entered* unchanged; escalation is a transition, not a modification |
| **Misclassification** | **Worst & undetectable** — happens inside one brain, no signal to log/bill | Concentrated & observable at the router; per-msg routing is jumpy | **Best-balanced** — only risk is under-escalation, fully recoverable (escalate any later turn; brain can offer it) |
| **State/transitions** | No transition (superficially simplest) | Router decides with limited context; may thrash per-message | Cleanest — escalation opens a case, carrying thread+vehicle+photos |
| **Capture integration** | Brain must decide capture-vs-chat every turn (widens misfire surface) | Unchanged (only in the diagnostic engine) | Unchanged (capture exists only post-escalation — today's boundary) |
| **Metering** | **Messy** (meter by tokens/tool-calls; oscillates) | **Clean but not user-explainable** (route = event) | **Cleanest + user-explainable** (escalation = the diagnosis credit) |
| **UI / Server scope** | L / L | M / S | M–L / S |
| **Risk to engine** | **High (behavioral)** | Low | Low |

**Chosen synthesis:** Option 3 with an Option-2-style lightweight detector = **a router that collapses to a single escalation decision.** One chat screen; default brain `/api/ask` (unchanged); a trigger (manual button + gentle brain-suggested offer) promotes the thread into `/api/diagnose-turn` + capture + case (unchanged). The escalation moment is simultaneously the UX beat and the pricing beat.

---

## 6. METERING BOUNDARY

The substrate already exists: `costLogger.js` logs every call by `callType` (`ask-vulcan`, `diagnose-turn`, `assessment`, `evidence-update`) **and** `sessionId`, with a per-session `byType` rollup; `/api/costs/summary` exposes it. Because **Ask and Diagnose run the same model** (`claude-opus-4-6`; note `server/costConfig.js`'s "Ask = Sonnet" comment is **stale** — the live model is opus at index.js:82), "diagnosis-weight" = **call count + context volume + the capture/evidence loop**, not model price.

- **Escalation = the billable diagnosis event.** Pre-escalation Ask turns stay light (DTC/spec/cache fast-paths genuinely free); escalation mints one "diagnosis" credit; the local capture loop (already $0 API) rides inside it.
- This is the only boundary a customer intuitively understands: *"you asked a question (cheap/free); then we ran a full diagnosis (one diagnosis credit)."*
- Option 2's per-message routing also gives a clean *internal* event but isn't user-explainable; Option 1 has no clean event at all.

---

## 7. PHASED BUILD PLAN (I own this sequencing)

Each phase = investigate → build → verify. **Phases 1–4 change nothing inside the fence** (`verifyAssessPrompt.js` stays trivially green). Phase 5 is the only fence-adjacent work and uses the proven additive pattern.

| Phase | Scope | Touches engine? | Verify gate |
|---|---|---|---|
| **0 — Decision lock** | ~~Founder ratifies §8 open decisions.~~ **DONE (2026-07-01)** — all §8 decisions locked into §1; persistent-chats requirement added (§1.10). | No | Founder sign-off. ✓ |
| **1 — Fix lossy escalation + context carry** | Upgrade the Ask→Diagnose handoff to carry the **full thread + photos** into a diagnostic case (today it collapses to a `symptom` string and drops photos). Screens still separate; engines unchanged. Mobile + `lib/handoff.ts` only. **BUILT 2026-07-01** (`to_diagnose.messages` carry; seeded before the complaint at intake submit; tolerant `sanitizeMessages` read + leading-assistant trim; consume-once, cleared on resume/reset; photos as uri-metadata per the lean-history rule, `diagrams` dropped). Local gates PASS (typecheck Handoff errors 9→7, node gates 118/80/109/23, byte guard, export build). **Awaiting founder on-device validation + OTA.** | No | Escalation preserves full context on a real device; existing gates pass. ◐ (local gates ✓; on-device pending) |
| **2 — Metering foundation (additive)** | Define weighted-usage credits on the existing cost data; mark the escalation as the "diagnosis started" event; expose a usage rollup. **BUILT + DEPLOYED 2026-07-01.** Investigation corrected two plan assumptions: (a) `sessionId` cannot key metering (it's per-OBD2-connect and NULL for disconnected diagnoses — most Ask escalations; cost rollups skip null sessions) — **the metering key is the CASE ID**; (b) NOT server-only — a small additive mobile piece was required (fire the escalation event from `onSubmitIntake`, the one choke point all three doors funnel through; send `caseId` on diagnose-turn). Delivered: `server/usageMeter.js` (credit events + aggregate, idempotent by caseId, fail-soft), `POST /api/usage/diagnosis-start`, `GET /api/usage/summary` (per-credit cost join + reconciliation), `caseId` attribution in `costLogger` entries, `entrySourceRef` source tagging (`direct`/`ask`/`obd2` — feeds the §9 under-escalation metric). Credit weights/tiers stay a later pricing exercise. | No | Usage reconciles with the cost aggregate; escalation events logged. ◐ (local endpoint validation ✓; deployed reconciliation fills in with the first real credited diagnosis) |
| **3 — Persistent chats (REQUIRED pre-shell — §1.10)** | Multi-thread persistence + a chat list. Give the light/Ask channel save/leave/return (today: ephemeral `useState`), and a **thread list spanning both channels** (open diagnostic cases already persist as `DiagnosticCaseV1`; light threads get their own lightweight envelope following the same versioned/tolerant-migrator discipline). Leave a thread mid-flight, open another (different vehicle OK), return where you left off. Mobile-only; engines unchanged. **BUILT 2026-07-02:** `lib/lightThreadsCore.ts` (versioned `LightThreadV1`, tolerant migrator, auto-prune oldest at cap 25 — no consent UX, a chat is not a patient chart) + `lib/lightThreads.ts` (storage, never-deletes invariant, KV test seam) + `lib/lightThreads.test.ts` (34-assertion node gate) + `app/chats.tsx` (unified list spanning both stores). **Brave ToS honored: `diagrams` payloads are never persisted** (stripped by the shared sanitizer); image base64 likewise. **The light-channel WRITER + the home entry ship WITH the shell (Phase 4)** — §1.10 allows "with"; building persistence into the old `ask.tsx` only to delete it in the same train would be throwaway. | No | Leave/return round-trips on a real device across both thread kinds; case save/resume gates still pass. ◐ (storage node-gated ✓; on-device round-trip in the consolidated end-of-Phase-4 checklist) |
| **4 — The unified shell (real screen merge)** | Merge `app/ask.tsx` + `app/diagnose.tsx` into one chat screen that starts light and escalates **in place**; still two endpoints underneath. Lands **ON the Phase-3 chat list** — **hard gate: the shell must not ship without multi-thread persistence (§1.10)**, since it removes the two-screen multitasking. **BUILT + DEPLOYED 2026-07-02 (with Phase 3 — §1.10's "with" satisfied):** `diagnose.tsx` RENAMED `chat.tsx` (engine machinery unchanged, byte guard green); phase machine `light|intake|chat`; default entry light, `?mode=diagnose` → intake; **"Diagnose this"** always available in light (locked §1.7) + the invitational `ASK_SYSTEM_PROMPT` offer (photo-offer discipline); escalation carries the light thread in-memory through the Phase-1 seeding (incl. photo re-attach) and mints the Phase-2 credit (source "ask"); **no chat→light path (locked §1.9)** — "Switch to Ask" removed, `to_ask` handoff writer-less; light threads auto-save + resume (`?thread=`), chats list linked from home; redirect stubs preserve `/ask` + `/diagnose?resume`. Deployed to preview per the continuous-mode directive (not flag-gated); the consolidated on-device checklist is the validation gate. | No | On-vehicle: a diagnosis behaves identically to today; Ask zero-cost paths intact; capture unaffected; leave/return works from the merged shell. ◐ (all automated gates ✓; on-device checklist pending) |
| **5 — (Optional, LAST) In-diagnosis retrieval (Tier-2)** | Fold `spec_lookup`/`diagram_lookup` into the diagnostic turn so a tech can ask a spec/diagram question mid-diagnosis. Additive: append tools to `UNIFIED_TURN_TOOLS` + a new `UNIFIED_*`-only prompt section; frozen spine untouched. (Already noted as "Tier-2" in `CLAUDE.md`.) **BUILT + DEPLOYED 2026-07-02 (inside the founder-approved A+ build):** `runTurnToolLoop` (execute-then-continue, retrieval cap 2 → forced-move final call, extensible terminal-tool-names semantics), `UNIFIED_RETRIEVAL_SECTION` (spec-safety bridge: VERIFIED rows = verified-in-context, miss verifies nothing, only the 9 `SPEC_TYPE_ENUM` categories lookup-able — the rest still route to `unverified_specs_needed`), one-sentence `UNIFIED_HEAD`/`UNIFIED_OUTPUT` amendments, diagram scope broadened via the new `parts` type (NARROW rule, `yearVerified` mandatory — trust unchanged), diagrams ride conversational turns only (assessment move → drop-with-log), Find-a-diagram button/modal removed. The A+ build also shipped the `spoken_summary` voice + the confirm-beat intake (see `CLAUDE.md`). | **Additive only** | `verifyAssessPrompt` PASS ✓ (byte-identical); diagram no-fabrication text verbatim ✓; **deployed-call validation BEFORE mobile wiring done (SB3 method) ✓** — retrieve-then-one-move, spec routing incl. un-lookupable specs, voice honesty, parts + year guard all green (2026-07-02). Founder on-device checklist pending. |

**Rationale for ordering:** front-load the low-risk, independently-valuable UX + pricing wins (1–2); land the multitasking substrate (3) so the big UI lift (4) can't ship as a regression; do the screen merge once contracts are settled (4); defer the only fence-adjacent work to last behind the automated byte gate (5). Phase 3 before the shell is a hard ordering constraint (§1.10), not a preference.

---

## 8. OPEN DECISIONS — ALL RATIFIED BY FOUNDER (2026-07-01)

Every decision below is **locked** as stated (the former working defaults were confirmed). The authoritative versions live in §1 — do not re-litigate.

1. **Escalation trigger — LOCKED:** **both** an explicit "Diagnose this" action (always available) **and** a gentle, invitational, never-forced brain-suggested offer (mirrors the photo-offer pattern). → §1.7
2. **Billing unit — LOCKED:** **flat "diagnosis credit" minted at escalation**; pre-escalation Ask stays cheap/free via the zero-cost fast-paths. (Credit weights / tier alignment with RevenueCat/Stripe remain a later pricing exercise — the *unit* is settled.) → §1.8
3. **Thread behavior — LOCKED:** an escalated thread **stays diagnostic**; a fresh casual question starts a **new thread**; casual side-questions inside a diagnosis go through the final-phase retrieval. → §1.9
4. **Routing philosophy — LOCKED:** **Option 3 (escalation-hybrid)** — NOT the auto-router (Option 2), NOT the unified brain (Option 1). → §1.2
5. **Merge scope — LOCKED:** **only Ask + Diagnose**; OBD2 Scan + Inspection stay separate instruments. → §1.6
6. **In-diagnosis retrieval timing — LOCKED:** deferred to the **last, optional phase** (the only fence-adjacent work). → §7 Phase 5
7. **ADDED by founder directive (2026-07-01): persistent chats are REQUIRED** — multi-thread persistence + a chat list must land **with or before** the unified shell, never after. → §1.10, §7 Phase 3

---

## 9. BIGGEST RISKS / HARDEST UNKNOWNS

- **Option 1 is the trap.** Broadening the diagnostic *brain* into a general assistant re-tunes validated behavior. The chosen architecture exists to avoid this — if anyone drifts toward "one brain does everything," stop and re-confirm.
- **Under-escalation** (a real fault handled as shallow Ask) is Option 3's characteristic failure — mitigate with always-available manual escalation + invitational brain-suggested offers; measure how often Ask threads later escalate.
- **Screen-merge regressions** (Phase 4) — merging a ~1,079-line and a ~3,781-line screen is real UI risk independent of the engine; stage behind a preview build and validate a full on-vehicle diagnosis before promoting.
- **The shell-without-chats regression trap** — a merged single-window shell shipped before multi-thread persistence + the chat list (Phase 3) silently deletes the app's only multitasking (two separate screens). §1.10 makes the ordering a hard gate; don't let schedule pressure invert it.
- **Metering is a product/pricing decision, not just code** — the clean technical boundary (escalation) still needs business answers for credit weights and heavy-session handling.
- **Context-carry fidelity across escalation** — photos are dropped today; the flattened diagnostic-history text must round-trip cleanly. Phase 1 de-risks this before the big merge.

---

## 10. KEY FILE MAP (for the next session)

| Area | Files |
|---|---|
| Ask | `app/ask.tsx`, `lib/api.ts` (`ask()`), `server/index.js` `/api/ask`, `server/askToolLoop.js`, `ASK_SYSTEM_PROMPT`/`ASK_TOOLS`/`ASK_MODEL` (index.js) |
| Diagnose brain | `app/diagnose.tsx`, `server/index.js` `/api/diagnose-turn` + `ASSESS_TOOL` + `UNIFIED_TURN_TOOLS` + `buildAssessmentContextBlocks`/`runStructuredAssessment`, `server/assessPrompt.js` |
| Byte-freeze | `server/assessPrompt.js` (`ASSESS_BODY`, `UNIFIED_BODY`), `server/scripts/verifyAssessPrompt.js`, `assessBody.snapshot.txt` |
| Capture / evidence | `server/index.js` `/api/evidence-update`, `lib/captureResolver.ts`, `lib/captureDetector.ts`, `lib/captureExecutor.ts`, `lib/captureEvidence.ts`, `lib/diagnosticSnapshot.ts` |
| Seams / state | `lib/handoff.ts`, `lib/obd2Handoff.ts`, `lib/turnHistory.ts`, `lib/diagnosticCasesCore.ts`, `contexts/VehicleContext.tsx`, `contexts/Obd2Context.tsx` |
| Retrieval / metering | `server/vehicleSpecs.js`, `server/specProviders/supabaseSpecs.js`, `server/canonicalVehicle.js`, `server/diagramLookup.js`, `server/costLogger.js`, `server/costConfig.js` |
| Shared UI | `components/VehicleBar.tsx`, `components/DiagramResults.tsx`, `components/ImageZoomViewer.tsx`, `components/FindDiagramModal.tsx`, `components/assessment/*` |

---

## 11. STATUS / NEXT STEP

- **Done:** read-only architecture investigation (engine untouched); direction locked (§1); phasing owned (§7); **Phase 0 complete — founder ratified all §8 decisions and added the persistent-chats requirement (2026-07-01).**
- **Phase 1 COMPLETE (2026-07-01):** full-context escalation shipped + founder-validated on-device (thread carry, brain references prior context, photo re-attach with same-photo labeling, no stale-thread leaks). Two on-device findings fixed in follow-ups: carried-photo visibility (re-attach bytes on the complaint turn) and same-photo labeling.
- **Phase 2 BUILT + DEPLOYED (2026-07-01):** metering foundation live (see §7 row 2 — caseId-keyed credits, escalation events, usage summary + cost reconciliation). Deployed reconciliation fills in with the first real credited diagnosis.
- **Phases 3+4 BUILT + DEPLOYED together (2026-07-02, continuous mode):** persistent chats + the unified `/chat` shell (see §7 rows 3–4). All automated gates green; **founder's consolidated on-device checklist is the outstanding validation gate.**
- **Phase 5 BUILT + DEPLOYED (2026-07-02, explicitly approved inside the founder's A+ build):** in-diagnosis retrieval live (see §7 row 5). Deployed-call validation green; the A+ build also delivered the `spoken_summary` voice + the confirm-beat intake (details in `CLAUDE.md`).
- **Next:** founder runs the consolidated on-device checklist (now including the A+ items: voice bubble + details drawer, mid-diagnosis spec/diagram lookup, parts diagrams, slim intake, Find-a-diagram button gone).
- **Standing rule for every phase:** run `node server/scripts/verifyAssessPrompt.js` (must PASS), keep the four safeguards intact, keep soft-validators non-throwing, and never route the live/capture path through the overridable context VIN.
