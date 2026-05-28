import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ----------------------------------------------------------------------------
// Cache directory resolver. All persistent cache files (cache.json,
// dtcCache.json, vehicleSpecCache.json) write into the directory returned
// by getCacheDir().
//
// Local dev: no env var, files land alongside the server source under
// vulcan-mobile/server/. Gitignored.
//
// Railway: attach a Volume to the service (Railway dashboard → Variables &
// Volumes → New Volume → Mount path `/data`), then set CACHE_DIR=/data in
// the service's Variables. The Volume persists across deploys, so cache
// data survives redeploys. Until both are configured, the server still
// runs — it just writes into the ephemeral container filesystem and loses
// cache on every redeploy.
// ----------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let resolved = null;

export function getCacheDir() {
  if (resolved !== null) return resolved;
  const envDir = (process.env.CACHE_DIR ?? "").trim();
  const dir = envDir.length > 0 ? envDir : __dirname;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    console.warn(
      `[cacheDir] couldn't create ${dir}: ${err.message} — falling back to server/`,
    );
    resolved = __dirname;
    return resolved;
  }
  resolved = dir;
  if (envDir.length > 0) {
    console.log(`[cacheDir] using CACHE_DIR=${dir}`);
  }
  return resolved;
}

export function cacheFile(filename) {
  return path.join(getCacheDir(), filename);
}
