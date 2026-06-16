// ============================================================================
// /api/diagnose-turn message assembly — image-aware (Photo Evidence, Step 1).
//
// Side-effect-free (no client, no env, no server boot) so
// server/scripts/verifyDiagnoseTurnMessages.js imports it as a node gate — same
// discipline as findingOptions.js / assessPrompt.js.
//
// THE LEAN RULE: an image content block is emitted ONLY for a FINAL user turn
// carrying an image WITH base64 (the just-attached turn; the phone strips base64
// from every other turn before sending). Any other image-bearing turn becomes a
// text placeholder so the bytes are never re-sent. Opus 4.6 vision needs only
// the standard image content block — no header, no beta flag, no model change.
// ============================================================================

// Index of the last user turn (the "final user turn"), or -1.
export function lastUserIndex(messages) {
  if (!Array.isArray(messages)) return -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role === "user") return i;
  }
  return -1;
}

// Build the Anthropic `content` for one turn. `text` is the already-composed
// text (first user turn = vehicle-context-prefixed; assistant = unwrapped).
// Returns a multimodal [image, text] array for a final user image-with-base64
// turn; otherwise a string (placeholder-annotated when an image was attached but
// is not being re-sent). Never throws on a malformed image (degrades to text).
export function buildTurnContent(role, text, image, isFinalUserTurn) {
  const hasImage = !!image && typeof image === "object";
  const hasBase64 =
    hasImage && typeof image.base64 === "string" && image.base64.length > 0;
  if (role === "user" && isFinalUserTurn && hasBase64) {
    return [
      {
        type: "image",
        source: {
          type: "base64",
          media_type:
            typeof image.mediaType === "string" ? image.mediaType : "image/jpeg",
          data: image.base64,
        },
      },
      { type: "text", text },
    ];
  }
  if (role === "user" && hasImage) {
    // Image referenced but not re-sent (lean history) → note it in text.
    return `${text} [photo attached]`;
  }
  return text;
}
