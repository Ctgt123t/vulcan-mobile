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

**Open action items (near-term):**

- **iOS native cleanup:** exclude `react-native-bluetooth-classic` pod from iOS build via Expo config plugin (latent crash risk; requires full iOS rebuild; do before TestFlight)
- **Offline resilience:** graceful handling when connectivity drops during connect/VIN-decode (currently fails silently into a degraded PID list); plus offline data buffering for road tests

**Next major feature:**

- **Claude-directed live monitoring** (the "autopilot" diagnostic vision) — Claude specifies which PIDs/thresholds to watch, phone monitors locally for free, Claude is only called when a condition triggers. Cost safeguards: sustained-condition requirement, per-PID cooldowns, per-session monitoring budget cap, auto-pause on inactivity. Folds in the deferred Claude-auto-applies-PIDs capability (`PidDescriptor.aiSelected` path already wired).

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
| 3. OBD2 Advanced (live monitoring, intelligent PID selection) | IN PROGRESS / NEXT |
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

## Current Development Priorities

- **Claude-directed live monitoring** — see roadmap section above
- **Offline resilience** — graceful VIN-decode-failure handling + local OBD2 buffering
- **iOS native cleanup** — Expo config plugin to exclude the Classic Bluetooth pod from iOS builds (see Known Platform Issues)
- **Pre-launch infrastructure** — Supabase/Postgres migration to replace JSON-file caches; auth; billing; analytics; error/crash tracking (Sentry or similar)
- **TestFlight beta + App Store launch prep**
