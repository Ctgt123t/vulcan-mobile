// ============================================================================
// Node gate for the Photo-Evidence (Step 1) image-aware message assembly.
//
// Side-effect-free import (server/diagnoseMessages.js never boots the server),
// same convention as verifyFindingOptions.js / verifyAssessPrompt.js.
//
// Run: node server/scripts/verifyDiagnoseTurnMessages.js   (exit 0 = pass)
// ============================================================================

import { buildTurnContent, lastUserIndex } from "../diagnoseMessages.js";

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

// ---- lastUserIndex ----
check("lastUserIndex → last user", lastUserIndex([{ role: "user" }, { role: "assistant" }, { role: "user" }]) === 2);
check("lastUserIndex → -1 when none", lastUserIndex([{ role: "assistant" }]) === -1);
check("lastUserIndex → -1 on non-array", lastUserIndex(null) === -1);

const jpg = { mediaType: "image/jpeg", base64: "B64" };

// ---- final user + image + base64 → multimodal [image, text] array ----
{
  const c = buildTurnContent("user", "look at this", jpg, true);
  check("final user image+base64 → array of 2", Array.isArray(c) && c.length === 2);
  check(
    "array[0] = base64 image block",
    c[0]?.type === "image" &&
      c[0]?.source?.type === "base64" &&
      c[0]?.source?.media_type === "image/jpeg" &&
      c[0]?.source?.data === "B64",
  );
  check("array[1] = text block", c[1]?.type === "text" && c[1]?.text === "look at this");
}

// ---- non-final image, image-without-base64, no-image, assistant ----
check(
  "non-final image → placeholder string",
  buildTurnContent("user", "earlier photo", jpg, false) === "earlier photo [photo attached]",
);
check(
  "image without base64 (even final) → placeholder string",
  buildTurnContent("user", "no bytes", { mediaType: "image/jpeg" }, true) === "no bytes [photo attached]",
);
check("no image → plain text", buildTurnContent("user", "hello", undefined, true) === "hello");
check("assistant never blocks", buildTurnContent("assistant", "x", jpg, true) === "x");
check(
  "missing mediaType defaults to image/jpeg",
  (() => {
    const c = buildTurnContent("user", "t", { base64: "B" }, true);
    return Array.isArray(c) && c[0]?.source?.media_type === "image/jpeg";
  })(),
);

// ---- never throws on junk image ----
{
  let threw = false;
  try {
    buildTurnContent("user", "t", "garbage", true);
    buildTurnContent("user", "t", 42, true);
    buildTurnContent("user", "t", null, true);
  } catch {
    threw = true;
  }
  check("never throws on junk image", threw === false);
}

if (failed === 0) {
  console.log(`PASS: diagnose-turn message assembly — ALL ${passed} checks`);
  process.exit(0);
}
console.error(`FAIL: ${failed} of ${passed + failed} checks`);
for (const f of failures) console.error(`  - ${f}`);
process.exit(1);
