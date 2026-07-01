// ============================================================================
// Photo evidence — MODE-AGNOSTIC shared primitive (Photo Evidence, Step 1).
//
// Capture/resize/persist a photo and the PURE serialization helpers that decide
// how a photo turn rides the conversation history. Deliberately free of any
// Diagnose-specific imports so Ask Vulcan (next) reuses it unchanged.
//
// NODE-SAFE AT IMPORT: the native modules (expo-image-picker / -manipulator /
// -file-system) are lazy-`require`d INSIDE the impure functions only — same
// discipline as lib/obd2.ts's lazy Classic-Bluetooth require — so the pure
// helpers (imageBlockForTurn / serializePhotoPlaceholder) import cleanly into
// node-tested pure modules (turnHistory.ts) and lib/photoEvidence.test.ts.
//
// THE LEAN COST-IN-HISTORY RULE (load-bearing): the image bytes are sent to the
// model ONCE, on the turn the photo is attached (the final user turn, base64
// present). On every later turn the same turn is a TEXT PLACEHOLDER — the brain
// carries the visual information forward via its own prior interpretation. This
// mirrors captured-evidence (a text summary persists, not raw samples).
// ============================================================================

import type { ChatMessage, ImageAttachment } from "./types";

// Opus downscales anything over ~1.15 MP to the same ~1,560 tokens, so capping
// the LONG edge here is zero token-quality loss — pure upload/payload savings.
export const MAX_LONG_EDGE_PX = 1568;

// ---- PURE: history serialization decisions --------------------------------

// Whether a turn sends the actual image to the model, a text placeholder, or
// nothing. "block" ONLY for the final user turn carrying an image WITH base64
// (the just-attached turn). Any other image turn → "placeholder" (text only).
export function imageBlockForTurn(
  message: Pick<ChatMessage, "role" | "image">,
  isFinalUserTurn: boolean,
): "block" | "placeholder" | "none" {
  if (!message.image) return "none";
  const hasBase64 =
    typeof message.image.base64 === "string" && message.image.base64.length > 0;
  if (message.role === "user" && isFinalUserTurn && hasBase64) return "block";
  return "placeholder";
}

// The text a non-resent photo turn contributes to history: the caption (if any)
// plus a marker so the brain knows a photo was attached even though the bytes
// aren't re-sent. ONE place this wording lives.
export function serializePhotoPlaceholder(
  message: Pick<ChatMessage, "content">,
): string {
  const caption = (message.content ?? "").trim();
  return caption.length > 0 ? `${caption} [photo attached]` : "[photo attached]";
}

// ---- IMPURE: capture + durable local store (lazy native) ------------------

// Pick from the library or camera, resize to <= MAX_LONG_EDGE_PX long edge,
// JPEG-compress, and return an ImageAttachment WITH base64 (for the one outgoing
// turn). Returns null on cancel / denied permission / any failure (fail-soft —
// the caller keeps the turn text-only). EXIF orientation is normalized by the
// resize. The native modules are required lazily so this file is node-safe.
export async function pickAndResize(
  source: "camera" | "library" = "library",
): Promise<ImageAttachment | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ImagePicker = require("expo-image-picker");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ImageManipulator = require("expo-image-manipulator");

    const perm =
      source === "camera"
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm?.granted) return null;

    const picked =
      source === "camera"
        ? await ImagePicker.launchCameraAsync({ mediaTypes: "images", quality: 1 })
        : await ImagePicker.launchImageLibraryAsync({ mediaTypes: "images", quality: 1 });
    if (picked?.canceled || !picked?.assets?.[0]) return null;

    const asset = picked.assets[0];
    const longEdge = Math.max(asset.width ?? 0, asset.height ?? 0);
    const scale = longEdge > MAX_LONG_EDGE_PX ? MAX_LONG_EDGE_PX / longEdge : 1;
    const ops =
      scale < 1
        ? [
            {
              resize: {
                width: Math.round((asset.width ?? MAX_LONG_EDGE_PX) * scale),
                height: Math.round((asset.height ?? MAX_LONG_EDGE_PX) * scale),
              },
            },
          ]
        : [];

    const out = await ImageManipulator.manipulateAsync(asset.uri, ops, {
      compress: 0.8,
      format: ImageManipulator.SaveFormat.JPEG,
      base64: true,
    });
    if (!out?.base64) return null;
    return {
      uri: out.uri,
      mediaType: "image/jpeg",
      width: out.width,
      height: out.height,
      base64: out.base64,
    };
  } catch {
    return null; // fail-soft: attach quietly no-ops, the tech can retry or type
  }
}

// Copy the resized image out of the cache dir into documentDirectory so the
// thumbnail survives same-install resume. Fail-soft: on any error returns the
// source URI (still renders this session, just not durably). Lazy native.
export async function persistPhoto(srcUri: string): Promise<string> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const FileSystem = require("expo-file-system/legacy");
    const docDir = FileSystem.documentDirectory;
    if (!docDir) return srcUri;
    const dir = `${docDir}diagnose-photos/`;
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(
      () => {},
    );
    const ext = (srcUri.split(".").pop() ?? "jpg").split("?")[0] || "jpg";
    const dest = `${dir}${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}.${ext}`;
    await FileSystem.copyAsync({ from: srcUri, to: dest });
    return dest;
  } catch {
    return srcUri;
  }
}

// Re-read a persisted photo's bytes as base64 (merge-plan Phase-1 follow-up:
// re-attaching a carried Ask photo so the DIAGNOSTIC brain sees it once — the
// lean rule's carry-forward only works when the SAME brain saw the image, and
// across the Ask→Diagnose boundary it hasn't). Fail-soft: null on any error
// (missing/purged file, unreadable uri) — the caller skips the attach and the
// turn degrades to the placeholder. Lazy native, node-safe at import.
export async function readPhotoBase64(uri: string): Promise<string | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const FileSystem = require("expo-file-system/legacy");
    const b64 = await FileSystem.readAsStringAsync(uri, { encoding: "base64" });
    return typeof b64 === "string" && b64.length > 0 ? b64 : null;
  } catch {
    return null;
  }
}

// Strip the transient base64 from an attachment before persisting it to the
// case envelope (we never store image bytes — only the local URI reference).
export function withoutBase64(image: ImageAttachment): ImageAttachment {
  const { base64, ...rest } = image;
  void base64;
  return rest;
}
