// ============================================================================
// Node gate for the Ask-Vulcan photo cache bypass (Photo Evidence).
//
// Side-effect-free import (server/diagnoseMessages.js never boots the server),
// same convention as verifyFindingOptions.js. Proves the predicate that gates
// /api/ask cache-eligibility: an image-bearing ask is excluded (so it is neither
// READ from nor WRITTEN to the text-only response cache), while a text-only ask
// is unchanged.
//
// Run: node server/scripts/verifyAskCacheBypass.js   (exit 0 = pass)
// ============================================================================

import { messageHasImage } from "../diagnoseMessages.js";

let passed = 0;
let failed = 0;
const failures = [];
function check(name, cond) {
  if (cond) passed++;
  else {
    failed++;
    failures.push(name);
  }
}

const jpg = { uri: "file:///doc/p.jpg", mediaType: "image/jpeg" };

// ---- image-bearing ask → predicate true → cacheEligible becomes false ----
check(
  "user turn with image → true (bypass cache: no read, no write)",
  messageHasImage({ role: "user", content: "what is this?", image: jpg }) === true,
);
check(
  "image with base64 → true",
  messageHasImage({ role: "user", content: "x", image: { ...jpg, base64: "B" } }) === true,
);

// ---- text-only ask → predicate false → cache behavior UNCHANGED ----
check(
  "text-only user turn → false (cache unchanged)",
  messageHasImage({ role: "user", content: "oil capacity?" }) === false,
);
check("undefined image → false", messageHasImage({ role: "user", content: "x", image: undefined }) === false);
check("null image → false", messageHasImage({ role: "user", content: "x", image: null }) === false);

// ---- malformed (non-object) image → treated as text (cacheable, safe) ----
check("string image → false (treated as text-only)", messageHasImage({ role: "user", content: "x", image: "garbage" }) === false);
check("number image → false", messageHasImage({ role: "user", content: "x", image: 42 }) === false);

// ---- junk messages → false, never throws ----
check("null message → false", messageHasImage(null) === false);
check("undefined message → false", messageHasImage(undefined) === false);
check("non-object message → false", messageHasImage("nope") === false);
{
  let threw = false;
  try {
    messageHasImage(null);
    messageHasImage({});
    messageHasImage({ image: {} });
  } catch {
    threw = true;
  }
  check("never throws on junk", threw === false);
}

if (failed === 0) {
  console.log(`PASS: ask cache-bypass predicate — ALL ${passed} checks`);
  process.exit(0);
}
console.error(`FAIL: ${failed} of ${passed + failed} checks`);
for (const f of failures) console.error(`  - ${f}`);
process.exit(1);
