import { cloneElement } from "react";
import { StyleSheet, Text, TextInput } from "react-native";
import { fonts } from "./theme";

// ============================================================================
// Global UI font (redesign foundation, step 1).
//
// React Native has no global default font, and the existing screens set only
// fontSize/fontWeight (no fontFamily) on their sans text — so the only way to
// make the whole app render in IBM Plex Sans WITHOUT editing every StyleSheet
// (step 2's job) is to intercept Text / TextInput rendering once at the root.
//
// A custom font has no synthetic bolding: a single fontFamily + fontWeight:600
// renders REGULAR weight (the 400 face has no bold). So this maps the resolved
// fontWeight to the correct Plex Sans FACE, preserving the existing visual
// hierarchy (headings stay heavy) under the new typeface.
//
// It is deliberately conservative:
//  - If a style already sets fontFamily, it is left untouched. This preserves
//    mono/data text (switched to fonts.mono) AND, critically, @expo/vector-icons
//    glyphs (Ionicons), which render as Text with their own icon fontFamily.
//  - It only prepends fontFamily; every other style property still wins.
// ============================================================================

const weightToSans: Record<string, string> = {
  "100": fonts.sans,
  "200": fonts.sans,
  "300": fonts.sans,
  "400": fonts.sans,
  normal: fonts.sans,
  "500": fonts.sansMedium,
  "600": fonts.sansSemibold,
  "700": fonts.sansBold,
  "800": fonts.sansBold,
  "900": fonts.sansBold,
  bold: fonts.sansBold,
};

let applied = false;

export function applyGlobalFont(): void {
  if (applied) return;
  applied = true;
  patch(Text as unknown as { render?: (...a: unknown[]) => unknown });
  patch(TextInput as unknown as { render?: (...a: unknown[]) => unknown });
}

function patch(Comp: { render?: (...a: unknown[]) => unknown }): void {
  const orig = Comp.render;
  if (typeof orig !== "function") return;
  Comp.render = function patched(...args: unknown[]) {
    const el = orig.apply(this, args) as
      | (React.ReactElement & { props: { style?: unknown } })
      | null;
    if (!el || !el.props) return el;
    const flat = (StyleSheet.flatten(el.props.style) || {}) as {
      fontFamily?: string;
      fontWeight?: string | number;
    };
    // Respect an explicit fontFamily — mono data text, icon glyph fonts, etc.
    if (flat.fontFamily) return el;
    const family =
      weightToSans[String(flat.fontWeight ?? "400")] ?? fonts.sans;
    return cloneElement(el, {
      style: [{ fontFamily: family }, el.props.style],
    } as Partial<typeof el.props>);
  };
}
