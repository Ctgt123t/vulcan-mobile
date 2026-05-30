// ----------------------------------------------------------------------------
// Debug flags. Each category is OFF by default and turned on via an
// EXPO_PUBLIC_* env var. Expo inlines these at bundle time, so the flag
// reads as a literal `true` or `false` at every call site and the JS
// engine eliminates the dead branch — zero runtime cost in production
// builds where the env var isn't set.
//
// To enable verbose OBD2 logging during a dev session:
//   1. Add to vulcan-mobile/.env:
//        EXPO_PUBLIC_DEBUG_OBD2=1
//   2. Restart Expo (env vars are read once at dev-server start).
//   3. Inspect Metro console. Every poll tick, transport TX/RX, scan
//      ingestion event, and per-handshake-command exchange will print.
//
// Preview / production builds never set these vars, so production binaries
// stay silent regardless of what's in your local .env.
// ----------------------------------------------------------------------------

export const DEBUG_OBD2 = process.env.EXPO_PUBLIC_DEBUG_OBD2 === "1";
