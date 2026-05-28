# Vulcan Mobile

> **Note to Claude Code:** When a significant feature is added, a major architectural change is made, or a new dependency/service is introduced, update this CLAUDE.md file to reflect the change before finishing the task. Keep it current.

## Project Overview

Vulcan is an AI-powered automotive diagnostic app for professional technicians. Built with Expo/React Native, a Railway-hosted backend, and the Claude API. Targets iOS and Android.

## Tech Stack

- **Frontend:** Expo SDK 54, React Native, TypeScript
- **Backend:** Node.js/Express on Railway
- **AI:** Claude Opus 4.6 for Diagnose mode, Claude Sonnet 4.6 for Ask Vulcan mode
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
- **TSB and recall integration** via NHTSA API
- **Diagnostic hierarchy** — visual inspection first, simple checks before advanced tests
- **Confirmed fix recording system** for building proprietary diagnostic database

## Backend

- Hosted on Railway, auto-deploys from GitHub `main` branch
- Railway URL baked into EAS preview and production builds via `eas.json` env block
- DTC database in `server/dtcData.json` (~1.1 MB, sourced from the MIT-licensed [Wal33D/dtc-database](https://github.com/Wal33D/dtc-database) SQLite distribution and converted to JSON at integration time) — 18,805 entries across 33 manufacturers plus 9,415 generic SAE J2012 codes. Loaded into memory at server startup by `server/dtcDatabase.js`. JSON shape: `{ [code]: { [MANUFACTURER]: description } }`. We dropped the SQLite/`better-sqlite3` path because Railway's Nixpacks builder has no Python for `node-gyp` to compile native bindings — JSON keeps the deploy native-dep-free
- DTC endpoint `GET /api/dtc/:code` accepts optional `?make=Ford` to prefer a manufacturer-specific definition; falls back to the generic SAE entry, then to pattern handlers (cylinder/coil-specific copy), then to a Claude fallback (`server/dtcFallback.js`) that produces a structured definition via tool use (Sonnet 4.6) and persists it to `server/dtcCache.json` so each missed code only hits Claude once. Cache is keyed by `code:make`, gitignored, in-flight requests for the same key are deduped, and Claude failures are NOT cached
- The source database has no causes/urgency/system metadata, so `system` is derived from the code type letter (P/B/C/U), `urgency` defaults to `medium`, and `commonCauses` is `[]` — except where a pattern handler fires (those still produce rich copy)
- Response caching for Ask Vulcan factual queries
- Vehicle spec retrieval in `server/vehicleSpecs.js` — pattern-detects factual spec questions (oil capacity, torque, fluids, battery, maintenance intervals) and routes them through a provider chain BEFORE hitting Claude. Provider modules live in `server/specProviders/` and follow a `{ id, configured(), lookup(vehicle, specType, params, fetcher) }` shape; add new sources by dropping a file and importing it in `vehicleSpecs.js`. Active providers:
  - `vehicleFinder.js` — Vehicle Finder API (api.vehicle-finder.com/v1). Oil, torque, maintenance. Auth: `VEHICLE_FINDER_API_KEY` env var
  - `openLabor.js` — Open Labor Project. **Scaffolded but disabled** — flip `ENABLED=true` once docs are confirmed and key is issued. Expected coverage: fluids, battery, labor times
- Spec hits are cached forever (data doesn't change for a vehicle) in `vehicleSpecCache.json` (gitignored). Cache is keyed by normalized vehicle + spec type + params and is provider-agnostic — a hit from any provider serves all later lookups
- **Cache storage location** is resolved by `server/cacheDir.js`: reads `CACHE_DIR` env var, defaults to `server/` for local dev. On Railway, a Volume is mounted at `/data` and `CACHE_DIR=/data` is set, so `cache.json`, `dtcCache.json`, and `vehicleSpecCache.json` all live on the Volume and survive redeploys. Without the Volume, the caches reset on every redeploy and previously-answered Claude DTC questions get re-billed. See DEV_SETUP.md for the Railway dashboard walkthrough. A `[startup] cache rollup:` log line at server start shows the loaded entry counts per cache — if those reset to zero on every deploy, the Volume isn't wired correctly
- When a spec question goes to Claude (no provider hit OR no provider configured), the anti-hallucination preamble in `vehicleSpecs.SPEC_CAUTION_PREAMBLE` is prepended to the system context, instructing the model to admit uncertainty rather than guess values
- Diagnose mode scans the presenting complaint for spec mentions and proactively injects any verified specs as a system context block so Claude reasons against real data instead of recollection

## Development Workflow

- Use **Windows CMD** (not PowerShell) for all terminal commands
- Development builds connect to local Expo dev server via `npx expo start --dev-client`
- Preview builds are standalone, built with `eas build --profile preview --platform ios/android`
- OTA updates for JS-only changes: `eas update --channel development --message "description"`
- Native module changes require full EAS rebuild
- Push to GitHub for Railway backend deploys

## Current Development Priorities

- OBD2 feature refinement and real-world testing
- Expanding DTC database for manufacturer-specific codes
- Building toward TestFlight beta and eventual App Store launch
