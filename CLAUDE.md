# Vulcan Mobile

> **Note to Claude Code:** When a significant feature is added, a major architectural change is made, or a new dependency/service is introduced, update this CLAUDE.md file to reflect the change before finishing the task. Keep it current.

## Project Overview

Vulcan is an AI-powered automotive diagnostic app for professional technicians. Built with Expo/React Native, a Railway-hosted backend, and the Claude API. Targets iOS and Android.

## Current State & Next Steps

> Keep this section current as work progresses — update it when a feature lands, an action item closes, or priorities shift. New sessions read this first to understand momentum, not just architecture.

**Working and validated:**

- All four modes functional (Ask Vulcan, Diagnose, Inspection Report, OBD2 Scan)
- OBD2 core validated on BOTH platforms: Android (OBDLink MX+ over Bluetooth Classic) and iOS (Veepeak OBDCheck BLE+ over BLE) — connects fast, reads DTCs, streams live data
- Live data tracking is responsive and real-time; full per-vehicle PID selection with categorized picker, presets, US/imperial units, and a status panel for bit-level signals
- DTC database (18,805 codes) with manufacturer-specific lookups, config-mismatch detection, Claude fallback + caching
- Auto-VIN populate across all modes, auto-reconnect for saved adapters
- Vehicle specs hybrid retrieval (Vehicle Finder API live; Open Labor Project scaffolded/disabled pending key)
- OBDb PID database, persistent Railway Volume storage (confirmed surviving redeploys)
- iOS startup crash resolved (reanimated v4 / worklets misconfig)
- Debug logging gated behind `EXPO_PUBLIC_DEBUG_OBD2`
- **DTC parsing verified accurate on 2011 GMC Sierra 4.8L** — multi-ECU CAN responses correctly parsed (0 phantom codes), P0442 surfaces correctly under Permanent Codes, O2 sensors read ~0.45V (not 115V). See DTC Parsing Architecture section.
- **Diagnostic engine Stage 1 (single-shot assessment):** OBD2 screen → Smart Diagnose → structured differential with stance, hypotheses + evidence, single next step. New route `/smart-diagnose`, new endpoint `/api/assess`, ring buffer in `Obd2Manager`. See architecture section below.

**Open action items (near-term):**

- **iOS native cleanup:** exclude `react-native-bluetooth-classic` pod from iOS build via Expo config plugin (latent crash risk; requires full iOS rebuild; do before TestFlight)
- **Offline resilience:** graceful handling when connectivity drops during connect/VIN-decode (currently fails silently into a degraded PID list); plus offline data buffering for road tests
- **Diagnostic engine Stage 2:** iterative evidence loop — Claude requests specific data under specific conditions, phone captures automatically via monitoring loop, sends back for an evidence-update call

**Next major feature:**

- **Diagnostic engine Stage 2 / Claude-directed live monitoring** — Claude's DATA_CAPTURE next-step already includes `requested_data` in the Stage 1 schema. Stage 2 auto-executes those requests: phone waits for the condition, captures the window, sends one Claude call with the captured evidence for an evidence-update. Cost safeguards: sustained-condition requirement, per-PID cooldowns, per-session monitoring budget cap, auto-pause on inactivity. Folds in `PidDescriptor.aiSelected` (already wired).

**Pre-launch work not yet started:**

- **Infrastructure:** migrate JSON-file storage to Postgres/Supabase (bundle in self-hosted NHTSA vPIC VIN decoder + NHTSA recall/TSB caching); fallback AI provider (Claude → GPT-4o for 529s); real auth (Supabase); billing (RevenueCat + Stripe); Sentry; Mixpanel; API cost monitoring + usage limits; build proprietary spec database; move confirmed-fix database to cloud
- **Product:** UI redesign for premium feel; decide whether to remove Inspection Report; speech-to-text; compatible-adapters screen
- **Legal/business:** form LLC + EIN; trademark Vulcan (Class 9 & 42, VulcanDX backup); switch Apple/Google accounts to Organization; CPA/attorney consult
- **Launch:** TestFlight + Google Play internal testing; finalize tiered pricing ($40-50/mo target); App Store listing prep

**Phase tracker:**

| Phase | Status |
|---|---|
| 1. Get off Expo Go | COMPLETE |
| 2. OBD2 Foundation | COMPLETE |
| 3a. Diagnostic engine — Stage 1 (single-shot assessment) | COMPLETE |
| 3b. Diagnostic engine — Stage 2 (iterative evidence loop) | NEXT |
| 3c. Diagnostic engine — Stage 3 (adaptive stance UI, guided checklists) | NOT STARTED |
| 4. Pre-launch infrastructure | NOT STARTED |
| 5. Testing & launch | NOT STARTED |

## Scalability Requirements

**This is a permanent project requirement, not a one-time note.** Vulcan is being built to support thousands of concurrent users at launch and beyond. Every piece of code written must be evaluated for scalability.

- Whenever you write or modify code, consider whether it will hold up at thousands of concurrent users. If it won't, flag it explicitly and explain what the scalable solution would be, even if we implement a simpler version for now.
- Avoid architectural decisions that would require a complete overhaul to scale. Prefer solutions that can grow.
- **Current known scaling considerations:** JSON-file caching on the Railway Volume works for now but will likely need to migrate to a proper database (Supabase/Postgres) before launch. Flag any new feature that adds to file-based storage load.
- When a current implementation is a temporary simplification, leave a clear code comment marking it as such and noting the scalable replacement.
- Backend API endpoints should be stateless where possible so they can scale horizontally.
- Do not introduce per-user data stored in ways that won't scale (e.g. growing single files).

## Tech Stack

- **Frontend:** Expo SDK 54, React Native, TypeScript
- **Backend:** Node.js/Express on Railway
- **AI:** Claude Opus 4.6 for Diagnose mode, Claude Sonnet 4.6 for Ask Vulcan mode. Both system prompts begin with a shared `APP_CONTEXT` block (`server/index.js`) so Claude reasons as an integrated diagnostic tool — aware that the app retrieves VIN/DTCs/live data through the Vulcan OBD2 connection, knows the four app modes, and treats codes appearing in conversation as confirmed scans rather than hypothetical. Updates to the shared identity belong in `APP_CONTEXT` so both modes stay consistent
- **OBD2:** `react-native-ble-plx` for BLE, `react-native-bluetooth-classic` for Classic Bluetooth
- **DTC parsing:** Three modes queried on every scan — Mode 03 (stored), Mode 07 (pending), Mode 0A (permanent/confirmed). See DTC Parsing Architecture section below.
- **Protocol detection:** `ATDPN` queried after the `0100` handshake pass. CAN (codes 6–9): ATH1 stays, frame-aware parser, multi-PID batching. Non-CAN (codes 1–5): ATH0 applied, flat-scan parser, single-PID polling. Protocol name shown in status bar.
- **Builds:** EAS Build for iOS and Android

## App Structure — Four Main Modes

1. **Ask Vulcan** — open-ended automotive conversation, no VIN required
2. **Diagnose** — structured diagnostic flow with VIN, ends with confirmed diagnosis
3. **Inspection Report** — multi-point vehicle inspection with PDF export
4. **OBD2 Scan** — Bluetooth connection to vehicle, DTC reading, live data

## Key Architecture Details

- **Hybrid retrieval system** — DTC database lookup, vehicle spec providers, and response caching on backend before calling Claude API to reduce costs and prevent hallucinated values
- **Dual Bluetooth transport** — BLE for iOS, Classic for Android, unified abstraction layer in `lib/obd2.ts`
- **Auto-reconnect** for saved OBD2 adapters — adapter identity (id, name, transport, last-connected timestamp) is persisted to AsyncStorage in `lib/savedAdapter.ts` after a successful handshake. On opening the OBD2 screen, `Obd2Manager.connectDirect()` attempts a silent reconnect; on failure the UI falls back to the manual device picker. Only one adapter is remembered at a time
- **Auto-VIN + global vehicle context** (`contexts/VehicleContext.tsx`) — when the OBD2 adapter handshakes successfully, `Obd2Manager.getVin()` issues Mode 09 PID 02 and parses the multi-frame ISO-TP response (`parseVinFromResponse` in `lib/obd2.ts` tokenizes hex bytes, skips CAN IDs and ISO-TP markers, walks the bytes after the `49 02 01` header and keeps only valid VIN characters). The 17-char VIN feeds `decodeVin()` (NHTSA) which populates the global vehicle. Ask Vulcan, Diagnose, and the OBD2 screen all read from this context, so the vehicle bar reflects the connected vehicle everywhere. If the tech had manually entered a different vehicle before connecting, an alert offers a choice between the two. Vehicles older than ~2008 may not expose Mode 09 PID 02 — `getVin()` returns null and the tech falls back to manual entry silently. The context persists the current vehicle + VIN + source (`"manual" | "vin-decoded" | "obd2-auto"`) to AsyncStorage so the same vehicle is restored on app launch. On vehicle change, the context backgrounds-fetches recalls/TSBs and prefetches `/api/pids/:make/:model/:year` so the live-diagnostic feature has warm cache. **Scaling:** all vehicle state is per-user and client-side (AsyncStorage); no backend per-user storage was added
- **TSB and recall integration** via NHTSA API
- **Diagnostic hierarchy** — visual inspection first, simple checks before advanced tests
- **Confirmed fix recording system** for building proprietary diagnostic database

## Backend

- Hosted on Railway, auto-deploys from GitHub `main` branch
- Railway URL baked into EAS preview and production builds via `eas.json` env block
- DTC database in `server/dtcData.json` (~1.1 MB, sourced from the MIT-licensed [Wal33D/dtc-database](https://github.com/Wal33D/dtc-database) SQLite distribution and converted to JSON at integration time) — 18,805 entries across 33 manufacturers plus 9,415 generic SAE J2012 codes. Loaded into memory at server startup by `server/dtcDatabase.js`. JSON shape: `{ [code]: { [MANUFACTURER]: description } }`. We dropped the SQLite/`better-sqlite3` path because Railway's Nixpacks builder has no Python for `node-gyp` to compile native bindings — JSON keeps the deploy native-dep-free
- DTC endpoint `GET /api/dtc/:code` accepts optional `?make=Ford&engineType=3.5L 6-cyl Turbocharged` — `make` prefers a manufacturer-specific definition; `engineType` feeds the config-mismatch detector (see below). Falls back to the generic SAE entry, then to pattern handlers (cylinder/coil-specific copy), then to a Claude fallback (`server/dtcFallback.js`) that produces a structured definition via tool use (Sonnet 4.6) and persists it to `server/dtcCache.json` so each missed code only hits Claude once. Cache is keyed by `code:make`, gitignored, in-flight requests for the same key are deduped, and Claude failures are NOT cached
- **Diagnose mode runs the same DTC enrichment server-side** (`server/index.js` `/api/diagnose`) — extracts codes from the presenting complaint, looks each one up via `lookupDtc(code, vehicle.make)`, attaches any config-mismatch flag, and injects the verified definitions into Claude's system context via `formatDtcContextBlock`. This means manufacturer-aware lookups and mismatch warnings benefit Diagnose mode too, not just the OBD2 screen and Ask Vulcan
- **Config-mismatch detector** in `server/dtcMismatch.js` — extensible rules engine that flags codes whose described system doesn't match the decoded vehicle. Current rules: forced-induction codes on non-FI engines (turbocharger/supercharger/wastegate/boost references on engineType lacking turbo/ecoboost/supercharged/etc.) and diesel-specific subsystem codes on gas engines. Add new rules by appending a `{id, matchEntry, matchVehicle, message, severity}` object to the `RULES` array. The flag rides on the DTC response as `configMismatch: {id, message, severity}`, rendered in the OBD2 DTC card as a small warning banner and injected into the Diagnose system context so Claude treats the code with appropriate skepticism. The VIN decoder (`lib/api.ts:decodeVin`) surfaces NHTSA's `Turbo`, `FuelTypePrimary`, and `OtherEngineInfo` fields into the `engineType` string so the keyword-match rules can fire
- The source database has no causes/urgency/system metadata, so `system` is derived from the code type letter (P/B/C/U), `urgency` defaults to `medium`, and `commonCauses` is `[]` — except where a pattern handler fires (those still produce rich copy)
- Response caching for Ask Vulcan factual queries
- Vehicle spec retrieval in `server/vehicleSpecs.js` — pattern-detects factual spec questions (oil capacity, torque, fluids, battery, maintenance intervals) and routes them through a provider chain BEFORE hitting Claude. Provider modules live in `server/specProviders/` and follow a `{ id, configured(), lookup(vehicle, specType, params, fetcher) }` shape; add new sources by dropping a file and importing it in `vehicleSpecs.js`. Active providers:
  - `vehicleFinder.js` — Vehicle Finder API (api.vehicle-finder.com/v1). Oil, torque, maintenance. Auth: `VEHICLE_FINDER_API_KEY` env var
  - `openLabor.js` — Open Labor Project. **Scaffolded but disabled** — flip `ENABLED=true` once docs are confirmed and key is issued. Expected coverage: fluids, battery, labor times
- Spec hits are cached forever (data doesn't change for a vehicle) in `vehicleSpecCache.json` (gitignored). Cache is keyed by normalized vehicle + spec type + params and is provider-agnostic — a hit from any provider serves all later lookups
- **Cache storage location** is resolved by `server/cacheDir.js`: reads `CACHE_DIR` env var, defaults to `server/` for local dev. On Railway, a Volume is mounted at `/data` and `CACHE_DIR=/data` is set, so `cache.json`, `dtcCache.json`, and `vehicleSpecCache.json` all live on the Volume and survive redeploys. Without the Volume, the caches reset on every redeploy and previously-answered Claude DTC questions get re-billed. See DEV_SETUP.md for the Railway dashboard walkthrough. A `[startup] cache rollup:` log line at server start shows the loaded entry counts per cache — if those reset to zero on every deploy, the Volume isn't wired correctly
- When a spec question goes to Claude (no provider hit OR no provider configured), the anti-hallucination preamble in `vehicleSpecs.SPEC_CAUTION_PREAMBLE` is prepended to the system context, instructing the model to admit uncertainty rather than guess values
- Diagnose mode scans the presenting complaint for spec mentions and proactively injects any verified specs as a system context block so Claude reasons against real data instead of recollection
- **Selectable live PID monitoring** (`app/obd2.tsx` + `app/obd2-pids.tsx`) — the OBD2 screen's live data view polls only the signals the technician has selected. Selection is keyed by OBDb **signal id** (e.g. `RPM`, `MIL`, `DTC_CNT`), not command code, so signals sharing a command response (MIL + DTC_CNT + 22 readiness bits all live at `01 01`) can be selected and decoded independently. The selection screen at `/obd2-pids` groups signals by category (Engine / Fuel System / Air-Intake / Oxygen Sensors / Emissions / Speed-Transmission / Electrical / Other) — categories are assigned server-side in `pidDatabase.js:categorizeSignal`. Status signals (bit-level / enum) get a `STATUS` badge in the picker. Saved presets and per-vehicle selected/unsupported sets live in AsyncStorage under `vulcan:pids:*:v2:<vehicleKey>`. **Scaling:** all preference storage is per-device, no backend per-user state added
- **PID polling driver** (`lib/obd2.ts`) — `startPolling(selectedPids, options)` drives the tick loop. Selected signals are grouped by command code; each unique command is sent ONCE per cycle and every selected signal at that code is decoded from the shared response using its own bit-range (`startBit`, `length`). Mode 01 commands batched up to 6 per request via ELM327 multi-PID syntax. Mode 22 manufacturer commands poll sequentially every Nth tick. **Critical detail:** `LiveValues` is keyed by signal id and updated immutably (`{...liveData, [id]: {...}}`) — in-place mutation would short-circuit React's `prevState === nextState` check and gauges would never re-render. Single-command fallback fires automatically when a multi-PID batch returns partial results (common on GM ECUs that only answer the first PID). Per-signal consecutive-miss counter promotes to `unsupportedPids` only after `MAX_CONSECUTIVE_MISSES`. All `sendCommand` IO is serialized via a Promise mutex inside `Obd2Manager` so bitmask queries / VIN reads / poll commands can't race on the shared CommandBuffer. `getSupportedMode01Pids()` walks PID 00/20/40/60/80/A0/C0/E0 support bitmasks for selection-UI filtering
- **`decodePidGeneric` byte-slicing fix:** When `startBit=null` and `length=N` (byte-aligned signal), the function slices the input to `ceil(N/8)` bytes before computing `raw`. Without this, a command returning multiple signals (e.g. PID `0x14` returns [O2 voltage, STFT B1S1]) would fold all bytes into `raw` before applying the divisor, producing ~115V instead of ~0.45V. The fix is in `lib/obd2.ts:decodePidGeneric`. Signals with `startBit != null` (bit-field extraction path) are unaffected.
- **Live data display** has two sub-sections driven by `isLiveMonitorable` / `isStatusSignal`. Byte-aligned scalar readings (RPM, coolant temp, throttle, fuel trims) render as numeric gauges. Bit-level + enum signals (MIL, readiness flags, DTC count) render in a separate Status panel as colored `MIL: ON` / `Catalyst Ready: Ready` / `Stored DTCs: 3` rows. Both sub-sections update on the same polling loop
- **Units handling** lives in `lib/units.ts`. `formatLiveValue(raw, obdbUnit, {system, signalName, signalId})` and `formatStatusValue(raw, unit, enum)` are pure display-layer conversions that take raw OBDb-unit values (celsius / kPa / km/h / kilometers) and return US-imperial output by default (°F / psi / mph / mi). Internal `LiveValue.value` stays in the raw decoded units so any downstream consumer (Diagnose-mode injection when that lands, records export) has a single source of truth. `UnitSystem` is `"imperial"` by default — a future user preference reads from AsyncStorage and passes the alternate system into the formatters without any API change. Signal-aware overrides: barometric pressure (BARO / signal name contains "baromet") stays in **kPa** to match scan-tool convention and stay comparable to MAP; EVAP vapor pressure (EVAP_VP / EVAP_VPA / EVAP_VP_WIDE / signal name contains "vapor pressure") converts to **inH₂O** since the values are tiny and US service literature uses inH₂O for EVAP leak diagnosis. MAF stays in g/s in both systems (universal tech convention)
- PID definitions live in `server/pidDatabase.js`:
  - **Standard SAE J1979 PIDs** (294 signals, modes 01-09) bundled at deploy time as `server/pidStandard.json`, sourced from [OBDb/SAEJ1979](https://github.com/OBDb/SAEJ1979). Returned by `GET /api/pids/standard`
  - **Vehicle-specific PIDs** lazy-fetched from `https://raw.githubusercontent.com/OBDb/<Make>-<Model>/main/signalsets/v3/default.json` on first request per vehicle, cached forever in `pidCache.json` on the Volume. Returned by `GET /api/pids/:make/:model/:year` merged with the standard set and filtered by year via OBDb's `filter.from`/`filter.to` per command. Vehicles OBDb doesn't cover return the standard-only response (source: `"standard-only"`) — caller still gets the SAE baseline
  - Each PID exposes: `command: {mode, pid}`, `code`, `id`, `name`, `description`, `path`, `unit`, `min`, `max`, `suggestedMetric`, and a `decode: {length, multiplier, divisor, offset, signed, startBit, enum}` block for raw-byte interpretation
  - OBDb is CC-BY-SA-4.0; attribution lives in the repo-root `NOTICE` and every API response carries `source`/`license` fields

## Debug Logging

Mobile uses bundle-time-inlined debug flags in `lib/debug.ts`. High-frequency
logs (per-poll-tick, transport TX/RX, BLE scan ingestion, per-handshake
commands) are wrapped in `if (DEBUG_OBD2)` and stay silent unless
`EXPO_PUBLIC_DEBUG_OBD2=1` is set in `.env`. Preview / production builds
never set the flag so production binaries never produce verbose logs.
Rare/informational events (connection PASS/FAIL, marked-unsupported,
disconnect, errors, the duplicate-signalKey assertion warning) always log.

## Development Workflow

- Use **Windows CMD** (not PowerShell) for all terminal commands
- Development builds connect to local Expo dev server via `npx expo start --dev-client`
- Preview builds are standalone, built with `eas build --profile preview --platform ios/android`
- OTA updates for JS-only changes: `eas update --channel development --message "description"`
- Native module changes require full EAS rebuild
- Push to GitHub for Railway backend deploys

**Deploying changes — Claude Code's responsibility:** When a task involves backend/server changes, Claude Code must commit and push to GitHub `main` as the final step so Railway redeploys — this is not the user's job to do manually. Backend changes do NOT reach the live server via OTA updates (`eas update` only ships the mobile JS bundle to devices; server code only deploys when pushed to GitHub). A task that changes both mobile and server code requires BOTH an `eas update` (for mobile) AND a `git push` (for server) — these are always separate steps and both must be completed. Never consider a task with server changes finished until the push to GitHub is done. Always confirm to the user that both the OTA update and the GitHub push were completed.

## Known Platform Issues

### iOS startup crash — reanimated v4 / worklets babel plugin (RESOLVED)

For a window in development, the app crashed on iOS ~200ms after launch (Swift `_assertionFailure(_:_:file:line:flags:)` from `EXC_BREAKPOINT / brk 1`) before any UI appeared. Initial suspect was `react-native-bluetooth-classic` under the New Architecture; the crash log ruled that out (its iOS native code is Objective-C, not Swift). Actual cause: `babel.config.js` referenced `"react-native-reanimated/plugin"` — the v3-style name — while the project is on reanimated 4.1.1 + `react-native-worklets` 0.5.1, which **moved the babel plugin into the worklets package**. The correct name is `"react-native-worklets/plugin"`. With the wrong plugin loaded, worklet callbacks (`useSharedValue`, `useAnimatedStyle`, `runOnUI`, etc.) were never transformed at build time, and the reanimated runtime asserted on first attempt to execute one on the UI thread. Android tolerated the same misconfig because the Android worklets runtime has softer assertions than iOS Swift preconditions. **Don't regress this — if you upgrade reanimated/worklets in the future, keep the babel plugin name in sync with whichever package owns it in that version.**

### iOS Classic Bluetooth — pending native cleanup

Apple's MFi restriction blocks Bluetooth Classic on iOS for non-licensed peripherals, so `react-native-bluetooth-classic` cannot function on iOS at all. The app already routes platform-dependent: **iOS → BLE only, Android → BLE + Classic** (see `Obd2Manager.connect()` and `connectDirect()`). The JS-side import is platform-gated via a lazy `require()` in `lib/obd2.ts` (only loads on Android), and `BluetoothDevice` comes in as a type-only import so iOS bundles never reference the runtime module.

**Open action item before TestFlight:** the Classic library's iOS Pod still autolinks into the binary on iOS even though the JS layer never touches it. It's dead weight on iOS plus a latent native-init crash risk if a future RN/Expo update breaks the library's iOS shim. Fix is an **Expo config plugin** that excludes the pod from the iOS build (`react-native-bluetooth-classic` removed from the iOS Podfile via the config plugin). Requires a full `eas build --profile development --platform ios` afterward, not OTA. The JS-side lazy-require gate is in place as partial defense for now.

## Hardware Compatibility

| Adapter | Android | iOS | Notes |
|---|---|---|---|
| **OBDLink MX+** | ✓ (Classic) | ✗ | MFi-locked. Used on the ONN Android test tablet |
| **OBDLink LX** | ✓ (Classic) | ✗ | Same MFi restriction as MX+ |
| **Veepeak OBDCheck BLE+** | ✓ (BLE) | ✓ (BLE) | Confirmed working on iPhone test device |

**For end-user recommendations:** Vulcan should prefer BLE-capable adapters in marketing/onboarding copy. Classic Bluetooth adapters work on Android only — be explicit about this when guiding users to a purchase.

## Known Gaps

### Offline resilience

The connect-and-decode-VIN sequence fails ungracefully when connectivity drops mid-flow (e.g. WiFi-to-cell handoff while in a shop): `decodeVin()` (NHTSA API) silently returns null, the global vehicle stays empty/partial, and the PID list falls back to the SAE-only "standard-only" path with no error surface to the technician. Adapter connection itself succeeds — the symptom is a thin / degraded experience downstream of the failed network call.

**Planned fix has two parts:**

1. **Graceful VIN-decode-failure handling** — when NHTSA returns null or times out, keep the raw VIN string, prompt the tech to retry once connectivity returns, or offer manual vehicle entry. Don't silently degrade.
2. **Offline data buffering** — local OBD2 collection continues working without network (everything except backend lookups already does); buffer any DTCs / live snapshots / Claude-ready context locally, sync when reconnected. This pairs with the Claude-directed monitoring roadmap item below since that feature relies on local capture by design.

## Roadmap — Next Major Features

### Claude-directed live monitoring

Cost-aware deep OBD2 integration that folds in the deferred "Claude auto-applies PID selections" capability. Design:

1. Technician describes the problem in Diagnose mode (e.g. "stalls at idle when warm").
2. Claude analyzes the complaint + vehicle context and emits a structured **monitoring plan** via tool call: a list of PIDs to watch, expected ranges, and trigger conditions (e.g. "STFT1 sustained > +10% for 30s while RPM 600-900").
3. Phone applies the plan to the OBD2 polling driver via `PidDescriptor.aiSelected = true` (data path is already wired through `lib/units.ts`, `lib/pidCatalog.ts`, and the gauge highlight style). Monitoring runs **locally on the device — zero API cost** while the technician drives or operates the vehicle.
4. When a trigger condition fires, the phone packages the captured window of live data + the trigger context and sends ONE Claude call to interpret the event and recommend next steps.

**Cost safeguards (load-bearing — without these the feature is unbounded API spend):**

- **Sustained-condition requirement** — a trigger must hold for N seconds (per-PID, configurable) before firing. Prevents noisy single-frame spikes from triggering Claude.
- **Per-PID cooldown timers** — once a trigger fires, that condition can't refire for M minutes. Prevents oscillating sensors from spamming.
- **Per-session monitoring budget** — hard cap on Claude calls per monitoring session (e.g. 5). Session ends; budget resets on the next explicit "start monitoring" action.
- **Auto-pause on inactivity** — if no PID values change meaningfully for X minutes (vehicle off, adapter idle), polling pauses and the monitoring session is paused. Resumes on activity.

**Scaling implication:** the LOCAL polling + trigger logic is per-device with zero backend load. The Claude calls when triggers fire ARE backend load but bounded by the safeguards above to dozens of calls per session at most.

## Protocol Detection Architecture

After the `0100` sanity check passes in `runHandshake()`, the handshake issues `ATDPN` to query the protocol the ELM327 locked onto during auto-detection.

### Classification

| Code | Protocol | Family | Handling |
|------|----------|--------|---------|
| 1 | J1850 PWM | Non-CAN | ATH0, single-PID polling |
| 2 | J1850 VPW | Non-CAN | ATH0, single-PID polling |
| 3 | ISO 9141-2 | Non-CAN | ATH0, single-PID polling |
| 4 | KWP2000 (5-baud) | Non-CAN | ATH0, single-PID polling |
| 5 | KWP2000 (fast) | Non-CAN | ATH0, single-PID polling |
| 6–9 | ISO 15765-4 CAN variants | **CAN** | ATH1 unchanged, frame-aware parser, multi-PID batching |
| parse fail | unknown | CAN | Treated as CAN (safe fallback) |

### Key invariants

- **CAN path is completely unchanged.** ATDPN adds one query to the handshake; if the result is CAN, no further action is taken. ATH1, the frame-aware dtcParser pipeline, and multi-PID batching (up to 6) are all untouched.
- **ATH0 for non-CAN.** Strips non-CAN 3-byte headers from responses. `parseDtcResponse` already falls back to flat-scan when no 3-char tokens are found. `extractPidDataBytes` and `parseMultiPidResponse` both tokenize to 2-char hex and work identically with headers off.
- **VIN decode (Mode 09)** works with ATH0 — `parseVinFromResponse` filters to 2-char hex tokens regardless of headers. Older vehicles without Mode 09 support return NO DATA → `getVin()` returns null → silent fallback to manual entry (already handled).
- **Single-PID polling on non-CAN.** Batch size is 1 vs 6 for CAN. Older protocols handle multi-PID requests inconsistently; single-PID avoids the fallback noise during first contact with an unknown vehicle.
- **Protocol in status bar.** The `setStatus("connected", ...)` message includes the detected protocol name: "Connected · ISO 9141", "Connected · CAN", etc.
- **Protocol in diagnostic log.** Session start entries (per `diagnosticLogger.startSession`) include `protocol` and `protocolType` so every shop visit is tagged with the vehicle's protocol.

### Storage

`Obd2Manager.protocolType` and `protocolName` are set during handshake and cleared to "unknown" on disconnect.

## DTC Parsing Architecture

### Modes queried

Every `obd2.scanDtcs()` call queries three modes and returns all three arrays:

| Mode | Echo byte | Returns | Description |
|------|-----------|---------|-------------|
| `03` | `0x43` | `dtcs[]` | Stored / confirmed codes |
| `07` | `0x47` | `pending[]` | Pending (not yet confirmed) |
| `0A` | `0x4A` | `permanent[]` | Permanent — survive code clear, require drive cycle to extinguish |

**B-codes (body codes)** are stored by GM BCMs in proprietary mode ($19), not in Mode 03/07/0A. They are unreachable via generic SAE OBD II. Vulcan cannot read them; professional factory-protocol scan tools (Autel, Snap-on GM mode) can. This is an expected data ceiling, not a parsing bug.

### Multi-ECU CAN response format

Modern CAN vehicles have multiple ECUs (PCM, BCM, EBCM…) all responding to a DTC query simultaneously. With `ATH1` (headers on), the ELM327 concatenates all responses:

```
7E8 02 43 00   ← PCM:  PCI=02 (2 data bytes), mode echo 43, count=00 (0 stored DTCs)
7EB 02 43 00   ← EBCM: same
7EA 02 43 00   ← BCM:  same
```

After the tokenizer drops 3-char CAN IDs, the byte stream is: `02 43 00 02 43 00 02 43 00`

**The parser must bound each decode to its CAN frame** using the ISO-TP PCI byte (always the byte immediately before the mode echo in the filtered stream). For a single-frame response `0x0N`, `N-1` bytes of data follow the mode echo.

### Count-byte detection (GM format)

Some ECUs (confirmed on 2011 GMC Sierra PCM) prepend a count byte `B` before the DTC pairs: `[MODE_ECHO] [COUNT] [PAIR1_A] [PAIR1_B] ...`. The count-byte format is detected when `frameData[0] * 2 === frameData.length - 1`. SAE no-count format (pairs directly after echo until `00 00`) is the fallback.

### Multi-frame responses

For >3 DTCs a vehicle uses ISO-TP multi-frame. The three-pass pipeline in `lib/dtcParser.ts` handles this fully:
- **First Frame (FF)**: PCI `0x10–0x1F`. Total payload length = `((PCI & 0x0F) << 8) | data[1]`. First 6 payload bytes carried in the FF.
- **Consecutive Frames (CF)**: PCI `0x20–0x2F`. Each CF carries 7 more payload bytes. CFs from the same CAN ID are appended to the FF accumulator regardless of interleaving with other ECUs' frames.
- **Flow control**: handled automatically by the ELM327. We never send FC frames in application code.
- Payload is trimmed to the total length declared in the FF after all CFs are collected.

### Module structure

The DTC parsing layer is isolated in `lib/dtcParser.ts` — a standalone pure module with zero React Native / Expo dependencies. This allows it to be imported and run in Node.js directly for testing.

| File | Role |
|---|---|
| `lib/dtcParser.ts` | All parsing logic: `parseCanFrames`, `assemblePayloads`, `decodePayloadDtcs`, `parseDtcResponse`, `runDtcParserSelfTest` |
| `lib/dtcParser.fixtures.ts` | Test fixtures — real Sierra captures + synthetic multi-frame + pathological cases |
| `lib/dtcParser.test.ts` | Node.js runnable test script (46 tests). Run from project root: `npx ts-node --skipProject --compiler-options "{\"module\":\"CommonJS\",\"moduleResolution\":\"node\",\"esModuleInterop\":true}" --transpile-only lib/dtcParser.test.ts` |
| `lib/obd2.ts` | Delegates `parseDtcResponse` to `dtcParser.ts` via a private shim. Runs `runDtcParserSelfTest()` on module load when `DEBUG_OBD2=1`. |

### Multi-frame ISO-TP reassembly (Priority 1 — COMPLETE)

The three-pass pipeline correctly handles interleaved multi-ECU CAN responses:

**Pass 1 — `parseCanFrames`**: Splits on 3-char hex tokens (CAN IDs as delimiters). Each ECU's frames are collected separately regardless of arrival order. Returns `null` for non-CAN / ATH0 responses (fallback to flat scan).

**Pass 2 — `assemblePayloads`**: Per CAN ID: SF → payload direct; FF → starts an accumulator; CF → appends to accumulator. After all frames processed, trims each multi-frame payload to the total length declared in the FF. Correctly handles `7E8 FF, 7EB SF, 7E8 CF1, 7EA SF, 7E8 CF2` interleaving as confirmed in the real Sierra live-data log.

**Pass 3 — `decodePayloadDtcs`**: Decodes GM count-byte format or SAE no-count format from the clean, reassembled payload. No framing bytes can contaminate the DTC pairs.

### Debug assertions (DEBUG_OBD2=1)

The parser (prefix `[dtc-parser]`) emits `WARN:` or `SUSPICIOUS:` messages when:
- Non-CAN / ATH0 path taken (no 3-char CAN ID tokens found)
- SF frame declares a length but the frame is shorter than declared
- FF assembled fewer bytes than the declared total (missing CFs)
- Orphan CF arrived with no preceding FF from that CAN ID
- Count-byte claimed N codes but fewer bytes were available
- Unconsumed non-null bytes after no-count decode stop
- Decoded code count exceeds 20 (implausibly high — indicates format mismatch)
- Unknown PCI type encountered

Keep `EXPO_PUBLIC_DEBUG_OBD2=1` set during first-run testing on any new vehicle make/model. The self-test also runs at app startup and logs `[dtc-test] ALL N PASSED` — if it fails, do not proceed to vehicle testing.

## Diagnostic Engine Architecture

The diagnostic engine is a local-state + LLM-reasoning hybrid. Core principles (all settled and implemented):

- **Never stream raw sensor data to Claude.** The phone summarizes live data into objective facts; Claude reasons on the summary. This is the central cost-control decision.
- **Phone produces facts, Claude produces judgment.** The snapshot builder (`lib/diagnosticSnapshot.ts`) outputs averaged values and ranges — it never infers "lean condition" or "misfiring." That's Claude's job.
- **Structured output via tool use.** The `/api/assess` endpoint forces Claude to call `emit_diagnostic_assessment` with a strict schema. No prompt-and-pray JSON.
- **Verified data injected before Claude.** Same pipeline as `/api/diagnose`: DTC enrichment, config-mismatch detection, spec injection, recall/TSB blocks — all server-side before the Claude call.
- **Confidence ladder without CONFIRMED.** Stage 1 schema allows POSSIBLE / LIKELY / STRONGLY_SUPPORTED only. CONFIRMED re-added in Stage 3 when a real confirmation gate exists.

### Key files

| File | Role |
|---|---|
| `lib/assessmentTypes.ts` | All types: `OperatingCondition`, `DiagnosticSnapshot`, `DiagnosticAssessment`, `Hypothesis`, `NextStep`, etc. |
| `lib/diagnosticSnapshot.ts` | Snapshot builder — averages ring buffer entries per signal, records absent signals, packages freeze frame. Objective facts only. |
| `lib/obd2.ts` (Obd2Manager) | Rolling 10-second ring buffer maintained after each poll tick. `captureSnapshot(durationMs)` and `getRingBufferAge()` for assessment. Cleared on disconnect. |
| `server/index.js` `/api/assess` | Assessment endpoint: enriches DTCs from snapshot.dtcs, injects specs from complaint, formats snapshot block, calls Opus with `emit_diagnostic_assessment` tool. |
| `app/smart-diagnose.tsx` | Route `/smart-diagnose`. Intake (complaint + condition selector + mileage) → assessing → structured result display. Exports `setSmartDiagnoseHandoff()`. |
| `app/obd2.tsx` | "Smart Diagnose" button in LIVE DATA section. Calls `setSmartDiagnoseHandoff()` then navigates. |

### Data flow (Stage 1)

```
Tech taps "Smart Diagnose" on OBD2 screen
  ↓
obd2.tsx calls setSmartDiagnoseHandoff({selectedDescriptors, dtcs, pendingDtcs, permanentDtcs, freezeFrame})
  ↓
Navigate to /smart-diagnose
  ↓
Tech selects operating condition, optionally adds complaint
  ↓
Tech taps "Run Assessment"
  ↓
obd2.captureSnapshot(5000) → last 5s of ring buffer entries
  ↓
buildDiagnosticSnapshot(ringBuffer, descriptors, condition, dtcs, ...) → DiagnosticSnapshot
  ↓
POST /api/assess {vehicle, vin, mileage, complaint, snapshot, recalls, tsbs}
  ↓
Server: enrich DTCs, inject specs, format snapshot block, build system context
  ↓
Claude Opus: emit_diagnostic_assessment tool call
  ↓
Return { assessment: DiagnosticAssessment }
  ↓
UI: stance banner → leading hypothesis → next step → full differential → ceiling note → unverified specs
```

### Stage 2 hook

The `NextStep` type includes `requested_data?: RequestedDataItem[]` (present when `type === "DATA_CAPTURE"`). Stage 1 surfaces this to the tech as text. Stage 2 will auto-execute it: phone detects the operating condition, captures the window, sends an evidence-update call. The data model is ready; the execution loop is not yet built.

### Safety discipline (non-negotiable)

Claude may apply diagnostic logic freely from its training. It may NOT state specific numeric factory specifications (torque, pressures, capacities, expected sensor ranges) unless that value was injected in the verified data blocks. Any needed but unavailable spec must be listed in `unverified_specs_needed` with parameter name and purpose. This rule is in the system prompt and enforced by making `unverified_specs_needed` a required schema field.

## API Cost Measurement

Every Claude API call is instrumented on the server. Cost data is captured from `response.usage`, computed against verified per-token rates, and persisted to the Railway Volume.

### Pricing config (`server/costConfig.js`)

Single file with all per-token rates. **Verify rates before making pricing decisions** — the file header shows the last-verified date and source URL. Update the date when rates change.

| Model | Input | Cache Write (5m) | Cache Read | Output |
|-------|-------|-----------------|------------|--------|
| claude-opus-4-6 | $5/MTok | $6.25/MTok | $0.50/MTok | $25/MTok |
| claude-sonnet-4-6 | $3/MTok | $3.75/MTok | $0.30/MTok | $15/MTok |
| claude-haiku-4-5-20251001 | $1/MTok | $1.25/MTok | $0.10/MTok | $5/MTok |

### Cost logger (`server/costLogger.js`)

- **Per-call**: `logApiCost(usage, model, { sessionId, callType })` — fire-and-forget, zero latency impact
- **Aggregates**: today / this week / all-time, by call type, by model
- **Cost breakdown**: uncached input vs cache-write vs cache-read vs output (tells you which optimisation lever matters)
- **Persists**: `costEntries.json` (last 500 calls) + `costAggregate.json` on the Railway Volume
- **Startup log**: prints today's cost + all-time total on every Railway deploy
- **Periodic log**: prints a summary line to Railway logs every 10 API calls

### Reading the results

**Railway logs** (during a session): look for `[cost]` lines showing per-call breakdown and `[cost] summary` lines every 10 calls.

**Aggregate endpoint**: `GET /api/costs/summary` returns the full aggregate + per-session breakdown + 50 most recent calls. Example:
```
curl https://vulcan-backend-production.up.railway.app/api/costs/summary | python -m json.tool
```

**On-device diagnostic log** (shop testing): every Smart Diagnose assessment entry shows the full cost breakdown. Open Diagnostic Log → expand a session → expand an assessment entry to see tokens and dollar cost.

**Cost breakdown fields explained:**
- `input`: tokens NOT served from cache — full price
- `cacheWrite`: tokens written to 5-min ephemeral cache — 1.25× input price (one-time cost)
- `cacheRead`: tokens served from cache — 0.1× input price (very cheap)
- `output`: generated tokens — most expensive per token at Opus pricing

If `cacheRead` is large relative to `input`, caching is working well. If `output` dominates, model tiering (Haiku for lightweight steps) is the lever to pull.

### Call types logged

| callType | Endpoint | Model |
|----------|----------|-------|
| `assessment` | `/api/assess` (Smart Diagnose) | claude-opus-4-6 |
| `diagnose` | `/api/diagnose` (conversational Diagnose) | claude-opus-4-6 |
| `ask-vulcan` | `/api/ask` | claude-sonnet-4-6 |
| `dtc-fallback` | background DTC lookup | claude-sonnet-4-6 |

## Current Development Priorities

- **Claude-directed live monitoring** — see roadmap section above
- **Offline resilience** — graceful VIN-decode-failure handling + local OBD2 buffering
- **iOS native cleanup** — Expo config plugin to exclude the Classic Bluetooth pod from iOS builds (see Known Platform Issues)
- **Pre-launch infrastructure** — Supabase/Postgres migration to replace JSON-file caches; auth; billing; analytics; error/crash tracking (Sentry or similar)
- **TestFlight beta + App Store launch prep**
