// ============================================================================
// Design tokens — DARK "technical instrument" language (redesign foundation,
// step 1). `colors` keeps its export NAME and every key it had (all 26 styled
// files import it), with values repointed to the dark palette; new keys were
// added for the straggler sweep + future primitives. New axes (`fonts`, `type`,
// `space`, `radii`) are additive — step 2 (component primitives + the home /
// Diagnose-intake redesigns) consumes them. Layouts are unchanged in step 1.
//
// NOTE: the Inspection Report PDF (`lib/inspection.ts`) deliberately does NOT
// import these tokens — it hardcodes its own light, print-appropriate palette
// so the dark theme never bleeds into a customer-facing document. Leave it so.
// ============================================================================

export const colors = {
  // ---- Surfaces (deep slate) ----
  bg: "#0A0F1A", // base background
  surface: "#141C29", // elevated surface (cards, navbar)
  surface2: "#1C2A3C", // raised element (chips, inputs, pressed)

  // ---- Accent (steel-blue) ----
  accent: "#7FB5E6", // primary accent — text/icon/active on dark
  accentHover: "#A6CDF0", // brighter on press
  accentFade: "rgba(127, 181, 230, 0.10)", // subtle accent wash

  // ---- Text ----
  text: "#F1F5FA", // primary body
  muted: "#8B97A8", // secondary
  heading: "#F4F8FC", // brightest — headings
  tertiary: "#5C6675", // tertiary / captions (new)
  faint: "#4A5667", // muted chevrons / disabled (new)
  dataText: "#9FB3CC", // mono / data readouts (new)

  // ---- Borders ----
  border: "#182230", // hairline / divider
  borderStrong: "#24364F", // input borders / stronger separators
  hairline: "#182230", // explicit hairline alias (new)

  // ---- Brand mark ----
  brandBg: "#143A63", // brand-mark backing (white bolt sits on this)

  // ---- Chat bubbles — user is a solid steel fill, so its text is white ----
  userBg: "#185FA5", // primary-button / user-bubble fill
  userBorder: "#185FA5",
  userText: "#FFFFFF",

  // ---- Status TINTS (re-tuned for dark: deep tinted fill + light text) ----
  dangerBg: "#2A1212",
  dangerBorder: "#6B2626",
  dangerText: "#F08A8A",
  warnBg: "#2A1F0A",
  warnBorder: "#6B5114",
  warnText: "#E8B95E",
  okBg: "#10241A",
  okBorder: "#1F6B3F",
  okText: "#6FD79A",
  infoBg: "#0E1F33",
  infoBorder: "#2A5586",
  infoText: "#8FC0F0",

  // ---- Solid status fills (vivid; carry white text/icons — read on dark) ----
  // Values preserved from the prior straggler literals so the inspection status
  // system is unchanged in meaning; centralized here so they're theme-owned.
  successFill: "#16A34A",
  successFillBorder: "#15803D",
  warnFill: "#F59E0B",
  warnFillBorder: "#B45309",
  dangerFill: "#DC2626",
  dangerFillBorder: "#991B1B",

  // ---- Overlays ----
  scrim: "rgba(0, 0, 0, 0.5)", // modal backdrop (theme-independent)
};

// ---- Typography — IBM Plex (loaded at root via runtime useFonts) ----
// Family-name tokens map to the @expo-google-fonts export names. A custom font
// has no synthetic bolding, so weight is selected by FAMILY (see
// lib/applyGlobalFont.ts, which maps fontWeight → the right Plex Sans face).
export const fonts = {
  sans: "IBMPlexSans_400Regular",
  sansMedium: "IBMPlexSans_500Medium",
  sansSemibold: "IBMPlexSans_600SemiBold",
  sansBold: "IBMPlexSans_700Bold",
  mono: "IBMPlexMono_400Regular",
  monoMedium: "IBMPlexMono_500Medium",
};

// Small size / lineHeight / weight scale (additive — primitives adopt it).
export const type = {
  size: {
    xs: 11,
    sm: 12,
    base: 13,
    md: 14,
    lg: 15,
    xl: 17,
    xxl: 20,
    display: 26,
  },
  line: {
    xs: 15,
    sm: 17,
    base: 19,
    md: 20,
    lg: 21,
    xl: 23,
    xxl: 26,
    display: 32,
  },
  weight: {
    regular: "400" as const,
    medium: "500" as const,
    semibold: "600" as const,
    bold: "700" as const,
  },
};

// 4/8-based spacing scale.
export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 28,
  xxxl: 40,
};

// Crisp / sharp corners (the new direction). Primitives adopt these in step 2.
export const radii = {
  none: 0,
  xs: 2,
  sm: 4,
  md: 6,
  lg: 8,
  pill: 999,
};

export const HIT_TARGET = 48;
