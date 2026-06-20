// ============================================================================
// v2 "steel glass" atmosphere generator (DEV/BUILD ONLY).
//
// Programmatically bakes the lit-scene background to a static PNG so the app
// renders it as one cheap GPU texture (no runtime gradient math, smooth behind
// scrolling). Re-run to re-tune the atmosphere, then ship the new PNG OTA:
//     node scripts/genAtmosphere.mjs
//
// The rasterizer (@resvg/resvg-js) is a devDependency — it is NOT an app
// runtime dependency. The app only ships the resulting assets/atmosphere.png.
//
// Recipe (v2): graphite base, cool key bloom top-right, warm fill bottom-left +
// a warm bloom from the top-left corner (light from the brand mark), dark edge
// vignette. Oversized square so `resizeMode:"cover"` covers portrait AND
// landscape; glows are broad/soft so any cover-crop still reads as the scene.
// ============================================================================
import { Resvg } from "@resvg/resvg-js";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SIZE = 2400; // square; broad soft glows make cover-cropping forgiving
const OUT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "assets",
  "atmosphere.png",
);

const GRAPHITE = "#191B1E";
const COOL = "206,220,234"; // cool key light (steel/silver)
const WARM = "232,162,76"; // warm fill / brand light (amber)

// A soft radial glow as a full-canvas rect (userSpaceOnUse so cx/cy/r are px).
function glow(id, cx, cy, r, rgb, alpha) {
  return {
    def: `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${cx}" cy="${cy}" r="${r}">
      <stop offset="0%" stop-color="rgba(${rgb},${alpha})"/>
      <stop offset="55%" stop-color="rgba(${rgb},${(alpha * 0.35).toFixed(3)})"/>
      <stop offset="100%" stop-color="rgba(${rgb},0)"/>
    </radialGradient>`,
    rect: `<rect width="${SIZE}" height="${SIZE}" fill="url(#${id})"/>`,
  };
}

const keyLight = glow("key", SIZE * 0.8, SIZE * 0.16, SIZE * 0.85, COOL, 0.36); // top-right cool
const warmFill = glow("warmfill", SIZE * 0.14, SIZE * 0.9, SIZE * 0.8, WARM, 0.15); // bottom-left warm
const warmCorner = glow("warmcorner", SIZE * 0.04, SIZE * 0.02, SIZE * 0.6, WARM, 0.15); // top-left brand bloom

// Edge vignette: transparent center → dark at the corners.
const vignette = `<radialGradient id="vig" gradientUnits="userSpaceOnUse" cx="${SIZE / 2}" cy="${SIZE / 2}" r="${SIZE * 0.72}">
  <stop offset="0%" stop-color="rgba(0,0,0,0)"/>
  <stop offset="62%" stop-color="rgba(0,0,0,0)"/>
  <stop offset="100%" stop-color="rgba(0,0,0,0.44)"/>
</radialGradient>`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <defs>
    ${keyLight.def}
    ${warmFill.def}
    ${warmCorner.def}
    ${vignette}
  </defs>
  <rect width="${SIZE}" height="${SIZE}" fill="${GRAPHITE}"/>
  ${warmCorner.rect}
  ${warmFill.rect}
  ${keyLight.rect}
  <rect width="${SIZE}" height="${SIZE}" fill="url(#vig)"/>
</svg>`;

const png = new Resvg(svg, { fitTo: { mode: "width", value: SIZE } })
  .render()
  .asPng();

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, png);
console.log(`[atmosphere] wrote ${OUT} (${SIZE}x${SIZE}, ${(png.length / 1024).toFixed(0)} KB)`);
