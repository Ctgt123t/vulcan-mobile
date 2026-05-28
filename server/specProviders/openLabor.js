// ----------------------------------------------------------------------------
// Open Labor Project provider (https://openlaborproject.com/developers).
//
// SCAFFOLDING ONLY — the docs URL currently returns 403 to non-browser
// requests, so we couldn't pin down the exact endpoint paths or response
// shapes at integration time. The key is also issued manually (hobbyist
// tier, may take days). Until both are resolved, configured() returns false
// even if the env var is set, and lookup() throws an "unimplemented" error
// that the orchestrator catches and treats as a miss.
//
// To finish wiring this up once the docs and key are in hand:
//   1. Set OPEN_LABOR_API_KEY in server/.env.
//   2. Flip ENABLED below to true (or remove the guard).
//   3. Fill in BASE_URL + RESOURCE_BY_SPEC_TYPE with the real endpoint paths.
//   4. Adjust the mappers if Open Labor's response shape differs from what
//      we're guessing here.
//
// Capabilities expected (per the user's spec): labor times, torque specs,
// fluid specs, battery specs. Of those, this provider is the only source
// for fluid specs (Vehicle Finder doesn't expose coolant/transmission/
// brake fluid as documented endpoints).
// ----------------------------------------------------------------------------

export const id = "open-labor-project";

const ENABLED = false; // ← flip to true once docs are confirmed and key works
const BASE_URL = "https://api.openlaborproject.com"; // TODO: verify
const API_KEY = process.env.OPEN_LABOR_API_KEY ?? "";

export function configured() {
  return ENABLED && API_KEY.length > 0;
}

if (API_KEY.length > 0 && !ENABLED) {
  console.log(
    "[open-labor] API key detected but provider is gated off — set ENABLED=true in specProviders/openLabor.js once endpoint paths are verified",
  );
} else if (!configured()) {
  console.log(
    "[open-labor] disabled — set OPEN_LABOR_API_KEY and enable the provider once docs are confirmed",
  );
}

// TODO: confirm these resource paths against the real docs.
// eslint-disable-next-line no-unused-vars
const RESOURCE_BY_SPEC_TYPE = {
  oil: null, // Vehicle Finder handles oil — leave null unless Open Labor has it too
  coolant: "fluids/coolant",
  transmissionFluid: "fluids/transmission",
  brakeFluid: "fluids/brake",
  powerSteeringFluid: "fluids/power-steering",
  torque: "torque-specs",
  battery: "battery",
};

// eslint-disable-next-line no-unused-vars
export async function lookup(_vehicle, _specType, _params, _fetcher) {
  if (!configured()) return null;
  // Once endpoint paths are confirmed, implement the two-call pattern
  // (resolve vehicle → id, then fetch resource) similar to vehicleFinder.js.
  throw new Error(
    "open-labor provider scaffolded but not yet implemented — see TODO in specProviders/openLabor.js",
  );
}
