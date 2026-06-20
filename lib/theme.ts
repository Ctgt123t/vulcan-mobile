// ============================================================================
// Design tokens — v2 "STEEL GLASS" language (graphite base, steel structure,
// warm-amber identity/life). `colors` keeps its export NAME and every key it
// had (all styled files import it), so every screen auto-recolors to v2; screens
// stay FLAT (no glass) until they adopt the v2 primitives in their own passes.
//
// Color rule: steel/silver = structure (surfaces, icons, UI); warm amber =
// identity + life (the brand mark always; anything live/active — connected
// adapter, running capture, live data).
//
// NOTE: the Inspection Report PDF (`lib/inspection.ts`) deliberately does NOT
// import these tokens — it hardcodes its own light, print-appropriate palette.
// Leave it so.
// ============================================================================

export const colors = {
  // ---- Surfaces (graphite, lifted off black; neutral) ----
  bg: "#191B1E", // base graphite
  surface: "#212429", // flat card (un-migrated screens)
  surface2: "#2A2E34", // raised element / pressed

  // ---- Accent = STEEL/SILVER (structure, UI) ----
  accent: "#C8D6E4",
  accentHover: "#E0E8F0",
  accentFade: "rgba(200, 214, 228, 0.10)",

  // ---- Text ----
  text: "#F0F2F5", // primary
  muted: "#AAB2BA", // secondary
  heading: "#F4F6F8", // headings (brightest)
  tertiary: "#71777E", // tertiary / captions
  faint: "#6A7178", // chevrons / disabled
  dataText: "#9FB3CC", // mono / data readouts

  // ---- Borders / hairline rims ----
  border: "#2E3238",
  borderStrong: "#3A3F47",
  hairline: "#2E3238",

  // ---- Brand mark backing (fallback; BrandMark uses the warm chip tokens) ----
  brandBg: "#3A2A18",

  // ---- Chat bubbles — user is a steel fill with light text ----
  userBg: "#283440",
  userBorder: "#36444F",
  userText: "#F4F6F8",

  // ---- Status TINTS (deep tinted fill + light text, tuned for graphite) ----
  dangerBg: "#2E1616",
  dangerBorder: "#6E2B2B",
  dangerText: "#F0928E",
  warnBg: "#2E2310", // verify/amber — aligns with the warm identity
  warnBorder: "#6E5320",
  warnText: "#E8B97A",
  okBg: "#15291E",
  okBorder: "#2A6B47",
  okText: "#7BD9A2",
  infoBg: "#182530", // steel-blue info (TSBs etc.)
  infoBorder: "#335778",
  infoText: "#9CC3E6",

  // ---- Solid status fills (vivid; carry white text/icons) ----
  successFill: "#16A34A",
  successFillBorder: "#15803D",
  warnFill: "#E8A24C", // shifted to the v2 identity amber
  warnFillBorder: "#B4781E",
  dangerFill: "#DC2626",
  dangerFillBorder: "#991B1B",

  // ---- Overlays ----
  scrim: "rgba(0, 0, 0, 0.5)",

  // ---- v2 WARM (life / active) ----
  warm: "#E8A24C", // connected adapter, running capture, live data
  warmText: "#D9C3A0",
  warmFade: "rgba(232, 162, 76, 0.14)",

  // ---- v2 GLASS panel (flat approximations of the recipe's linear sheens;
  // expo-linear-gradient is not installed and adding it would force a rebuild,
  // so a flat tint + a top highlight stands in for the 180deg sheen. The tint
  // is the LEGIBILITY FLOOR — opaque enough to read with blur OFF / bright sun)
  glassFill: "rgba(244, 247, 250, 0.07)",
  glassRim: "rgba(244, 247, 250, 0.18)",
  glassHighlight: "rgba(244, 247, 250, 0.14)", // top sheen line

  // ---- v2 STEEL icon chip (structure) ----
  steelChip: "rgba(200, 214, 228, 0.14)",
  steelChipBorder: "rgba(200, 214, 228, 0.32)",
  steelGlyph: "#CBD6E0",

  // ---- v2 WARM brand chip (identity) ----
  brandChip: "rgba(232, 162, 76, 0.20)",
  brandChipBorder: "rgba(232, 162, 76, 0.44)",
  brandGlyph: "#F2BA6A",
};

// ---- Typography — IBM Plex (loaded at root via runtime useFonts) ----
// Family-name tokens map to the @expo-google-fonts export names. v2 screens set
// these EXPLICITLY (proper handling); un-migrated screens still get Plex via the
// weight-aware patch in lib/applyGlobalFont.ts (kept until all screens migrate).
export const fonts = {
  sans: "IBMPlexSans_400Regular",
  sansMedium: "IBMPlexSans_500Medium",
  sansSemibold: "IBMPlexSans_600SemiBold",
  sansBold: "IBMPlexSans_700Bold",
  mono: "IBMPlexMono_400Regular",
  monoMedium: "IBMPlexMono_500Medium",
};

// Small size / lineHeight / weight scale.
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

// Crisp / sharp corners (the v2 direction).
export const radii = {
  none: 0,
  xs: 2,
  sm: 4,
  md: 6,
  lg: 8,
  pill: 999,
};

export const HIT_TARGET = 48;
