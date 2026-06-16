// ============================================================================
// Photo evidence — NODE TEST GATE (Photo Evidence, Step 1).
//
// Proves the PURE helpers that govern how a photo turn rides history: the
// block/placeholder decision (the lean cost-in-history rule) and the placeholder
// text. The native pick/persist are NOT tested here (they require a device);
// this file imports only the pure surface, which is node-safe because the native
// modules are lazy-required inside the impure functions. Same harness as
// turnHistory.test.ts.
//
// Run from project root:
//   npx ts-node --skipProject --compiler-options "{\"module\":\"CommonJS\",\"moduleResolution\":\"node\",\"esModuleInterop\":true}" --transpile-only lib/photoEvidence.test.ts
// ============================================================================

import type { ChatMessage, ImageAttachment } from "./types";
import {
  imageBlockForTurn,
  serializePhotoPlaceholder,
  withoutBase64,
} from "./photoEvidence";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(cond: boolean, msg: string) {
  if (cond) passed++;
  else {
    failed++;
    failures.push(msg);
    console.log(`  FAIL: ${msg}`);
  }
}
function eq(a: unknown, b: unknown, msg: string) {
  ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)})`);
}
function section(n: string) {
  console.log(`\n=== ${n} ===`);
}

const img = (base64?: string): ImageAttachment => ({
  uri: "file:///doc/diagnose-photos/x.jpg",
  mediaType: "image/jpeg",
  width: 1200,
  height: 900,
  ...(base64 ? { base64 } : {}),
});
const userMsg = (content: string, image?: ImageAttachment): ChatMessage =>
  image ? { role: "user", content, image } : { role: "user", content };

// ---------------------------------------------------------------------------
section("imageBlockForTurn — the lean send-once rule");
ok(
  imageBlockForTurn(userMsg("look", img("B64")), true) === "block",
  "final user turn + image + base64 → block (bytes sent once)",
);
ok(
  imageBlockForTurn(userMsg("look", img("B64")), false) === "placeholder",
  "non-final image turn → placeholder (bytes NOT re-sent)",
);
ok(
  imageBlockForTurn(userMsg("look", img()), true) === "placeholder",
  "final image turn WITHOUT base64 → placeholder (fail-soft / already sent)",
);
ok(
  imageBlockForTurn(userMsg("look", img("")), true) === "placeholder",
  "empty base64 → placeholder",
);
ok(
  imageBlockForTurn(userMsg("hello"), true) === "none",
  "no image → none",
);
ok(
  imageBlockForTurn(
    { role: "assistant", content: "x", image: img("B64") } as ChatMessage,
    true,
  ) === "placeholder",
  "assistant turn never blocks (placeholder even with base64)",
);

// ---------------------------------------------------------------------------
section("serializePhotoPlaceholder — text the non-resent photo contributes");
eq(
  serializePhotoPlaceholder({ content: "Inspection result: Stuck open" }),
  "Inspection result: Stuck open [photo attached]",
  "caption + marker",
);
eq(
  serializePhotoPlaceholder({ content: "" }),
  "[photo attached]",
  "empty caption → bare marker",
);
eq(
  serializePhotoPlaceholder({ content: "   " }),
  "[photo attached]",
  "whitespace caption → bare marker",
);

// ---------------------------------------------------------------------------
section("withoutBase64 — never persist the transient bytes");
eq(
  withoutBase64(img("B64")),
  { uri: "file:///doc/diagnose-photos/x.jpg", mediaType: "image/jpeg", width: 1200, height: 900 },
  "strips base64, keeps the durable reference",
);
ok(withoutBase64(img("B64")).base64 === undefined, "base64 is gone");

// ---------------------------------------------------------------------------
console.log(`\n${"=".repeat(48)}`);
if (failed === 0) {
  console.log(`[photo-evidence-test] ALL ${passed} PASSED`);
} else {
  console.log(`[photo-evidence-test] ${failed} FAILED, ${passed} passed`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
