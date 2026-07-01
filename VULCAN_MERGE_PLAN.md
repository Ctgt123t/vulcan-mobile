# VULCAN — ASK + DIAGNOSE UNIFIED-CHAT MERGE PLAN

> **Purpose of this document.** Source-of-truth for merging Vulcan's two chat channels — **Ask Vulcan** and **Diagnose** — into one fluid chat interface, **without degrading the diagnostic engine or its safeguards.** It captures the read-only architecture investigation's findings, the locked decisions, the open decisions still needing founder ratification, and the phased build plan. Written so a fresh session (no prior chat context) can pick this up fully oriented. Companion to `CLAUDE.md`, `VULCAN_PROJECT_BRIEF.md`, and `VULCAN_DATA_LAYER_STRATEGY.md`.
>
> **Status: INVESTIGATION COMPLETE — architecture recommended and direction locked; NO build started; engine untouched.** The investigation was strictly read-only (nothing in the fenced engine was modified). The next session begins at **Phase 0 → 1** below, after the founder ratifies the open decisions.
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
6. **Scope:** merge **only Ask + Diagnose.** OBD2 Scan and Inspection Report stay as separate instruments (they are not chat). *(Pending explicit confirmation — see §8, but this is the working assumption.)*

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

Each phase = investigate → build → verify. **Phases 1–3 change nothing inside the fence** (`verifyAssessPrompt.js` stays trivially green). Phase 4 is the only fence-adjacent work and uses the proven additive pattern.

| Phase | Scope | Touches engine? | Verify gate |
|---|---|---|---|
| **0 — Decision lock** | Founder ratifies §8 open decisions. No code. | No | Founder sign-off. |
| **1 — Fix lossy escalation + context carry** | Upgrade the Ask→Diagnose handoff to carry the **full thread + photos** into a diagnostic case (today it collapses to a `symptom` string and drops photos). Screens still separate; engines unchanged. Mobile + `lib/handoff.ts` only. | No | Escalation preserves full context on a real device; existing gates pass. |
| **2 — Metering foundation (server-only, additive)** | Define weighted-usage credits on the existing per-`callType`/`sessionId` cost data; mark the escalation as the "diagnosis started" event; expose a per-session usage rollup. | No | Usage reconciles with the cost aggregate; escalation events logged. |
| **3 — The unified shell (real screen merge)** | Merge `app/ask.tsx` + `app/diagnose.tsx` into one chat screen that starts light and escalates **in place**; still two endpoints underneath. Behind a preview flag. | No | On-vehicle: a diagnosis behaves identically to today; Ask zero-cost paths intact; capture unaffected. |
| **4 — (Optional, LAST) In-diagnosis retrieval (Tier-2)** | Fold `spec_lookup`/`diagram_lookup` into the diagnostic turn so a tech can ask a spec/diagram question mid-diagnosis. Additive: append tools to `UNIFIED_TURN_TOOLS` + a new `UNIFIED_*`-only prompt section; frozen spine untouched. (Already noted as "Tier-2" in `CLAUDE.md`.) | **Additive only** | `verifyAssessPrompt` PASS; diagram tool stays no-fabrication; deployed-call validation *before* mobile wiring (the SB3 method). |

**Rationale for ordering:** front-load the low-risk, independently-valuable UX + pricing wins (1–2); do the big UI lift once contracts are settled (3); defer the only fence-adjacent work to last behind the automated byte gate (4).

---

## 8. OPEN DECISIONS (need founder yes/no before/at build time)

Working defaults in **bold** — a fresh session should confirm these before building the affected phase.

1. **Escalation trigger** — **both** an explicit "Diagnose this" button (always) **and** a gentle, invitational brain-suggested offer (never forced, mirrors the photo-offer pattern). *(vs. manual-only or auto-only.)*
2. **Billing unit** — **flat "diagnosis" credit at escalation** (most explainable), with heavy sessions optionally surfacing incremental usage. *(vs. metered per diagnostic turn/capture.)* This is also a pricing/business decision (align with RevenueCat/Stripe tiering).
3. **Does an escalated thread stay diagnostic, or drop back to casual Ask?** — **stays diagnostic** once escalated (matches the case model); casual side-questions handled inside the diagnostic brain via Phase-4 retrieval; a fresh casual question starts a new thread.
4. **Routing philosophy** — confirm **Option 3 (escalation)**, not a fully-automatic per-message router (Option 2: cleaner internal metering, jumpier UX, needs a classifier call per message).
5. **Merge scope** — confirm **only Ask + Diagnose** merge; **OBD2 Scan + Inspection stay separate instruments.**
6. **Phase-4 timing** — **defer** in-diagnosis retrieval until Phases 1–3 are validated (it's the only fence-adjacent work).

---

## 9. BIGGEST RISKS / HARDEST UNKNOWNS

- **Option 1 is the trap.** Broadening the diagnostic *brain* into a general assistant re-tunes validated behavior. The chosen architecture exists to avoid this — if anyone drifts toward "one brain does everything," stop and re-confirm.
- **Under-escalation** (a real fault handled as shallow Ask) is Option 3's characteristic failure — mitigate with always-available manual escalation + invitational brain-suggested offers; measure how often Ask threads later escalate.
- **Screen-merge regressions** (Phase 3) — merging a ~1,079-line and a ~3,781-line screen is real UI risk independent of the engine; stage behind a preview build and validate a full on-vehicle diagnosis before promoting.
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

- **Done:** read-only architecture investigation (engine untouched); direction locked (§1); phasing owned (§7).
- **Next:** founder ratifies §8 → begin **Phase 1** (fix the lossy escalation + full context carry). Do **not** start any server/prompt work until Phases 1–3 contracts are settled; Phase 4 is the only fence-adjacent change and is gated last.
- **Standing rule for every phase:** run `node server/scripts/verifyAssessPrompt.js` (must PASS), keep the four safeguards intact, keep soft-validators non-throwing, and never route the live/capture path through the overridable context VIN.
