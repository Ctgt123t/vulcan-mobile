// ============================================================================
// Light chat thread storage layer (Ask+Diagnose merge plan, Phase 3).
//
// Thin AsyncStorage orchestration over the pure core (lightThreadsCore.ts):
// per-thread body keys + one index key, a serialized write queue, and the
// public API the unified chat shell + chats list call. Mirrors
// diagnosticCases.ts exactly (incl. the never-deletes invariant and the
// injectable KVBackend test seam).
//
// SCALABILITY (standing requirement): per-device AsyncStorage, capped at
// LIGHT_CAP (25) threads. Same boundary as diagnostic cases — when auth + the
// backend user model land, threads move to a per-user server store and this
// layer becomes an offline cache.
// ============================================================================

import {
  LIGHT_BODY_KEY_PREFIX,
  LIGHT_CAP,
  LIGHT_INDEX_KEY,
  type LightThread,
  type LightThreadIndexEntry,
  deriveLightIndexEntry,
  lightBodyKey,
  migrateLightThread,
  reconcileLightIndex,
  selectLightPrune,
} from "./lightThreadsCore";

// ---- Backend seam (same shape as diagnosticCases.KVBackend) ----------------

export interface LightKVBackend {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  getAllKeys(): Promise<readonly string[]>;
}

let _backend: LightKVBackend | null = null;

function defaultBackend(): LightKVBackend {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const AsyncStorage = require("@react-native-async-storage/async-storage")
    .default as LightKVBackend;
  return AsyncStorage;
}

function backend(): LightKVBackend {
  if (!_backend) _backend = defaultBackend();
  return _backend;
}

// Test seam — inject an in-memory backend. Not used in app code.
export function setLightKVBackendForTests(b: LightKVBackend | null): void {
  _backend = b;
}

// ---- Serialized write queue --------------------------------------------------

let writeChain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// ---- Index I/O ----------------------------------------------------------------

async function readIndexRaw(): Promise<LightThreadIndexEntry[]> {
  const raw = await backend().getItem(LIGHT_INDEX_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is LightThreadIndexEntry =>
        !!e && typeof e === "object" && typeof e.id === "string",
    );
  } catch {
    return [];
  }
}

async function writeIndex(index: LightThreadIndexEntry[]): Promise<void> {
  await backend().setItem(LIGHT_INDEX_KEY, JSON.stringify(index));
}

// Public read of the thread list. Self-heals an empty/corrupt index when
// bodies exist on disk.
export async function loadLightIndex(): Promise<LightThreadIndexEntry[]> {
  const index = await readIndexRaw();
  if (index.length > 0) return index;
  const keys = await backend().getAllKeys();
  const hasBodies = keys.some((k) => k.startsWith(LIGHT_BODY_KEY_PREFIX));
  if (!hasBodies) return [];
  return rebuildLightIndexFromBodies();
}

// ---- Body I/O -------------------------------------------------------------------

// Load + migrate a thread body. A null result (missing / malformed / FUTURE
// version) NEVER removes the body key — the never-deletes invariant, so a
// later compatible app version can still read it.
export async function loadLightThread(id: string): Promise<LightThread | null> {
  const raw = await backend().getItem(lightBodyKey(id));
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // truncated / corrupt JSON — leave it on disk
  }
  return migrateLightThread(parsed);
}

// Write a thread body and update its index row. Serialized.
export async function upsertLightThread(body: LightThread): Promise<void> {
  return serialize(async () => {
    await backend().setItem(lightBodyKey(body.id), JSON.stringify(body));
    const index = await readIndexRaw();
    const entry = deriveLightIndexEntry(body);
    const next = index.filter((e) => e.id !== body.id);
    next.unshift(entry);
    await writeIndex(next);
  });
}

export async function deleteLightThread(id: string): Promise<void> {
  return serialize(async () => {
    await backend().removeItem(lightBodyKey(id));
    const index = await readIndexRaw();
    await writeIndex(index.filter((e) => e.id !== id));
  });
}

// ---- Prune (called before creating a new thread) --------------------------------
//
// Unlike cases, no consent path: at the cap the oldest thread is deleted
// automatically. Fire before creating a new thread.
export async function pruneForNewLightThread(): Promise<void> {
  const index = await loadLightIndex();
  const victimId = selectLightPrune(index, LIGHT_CAP);
  if (victimId) await deleteLightThread(victimId);
}

// ---- Index rebuild (self-heal) ----------------------------------------------------

export async function rebuildLightIndexFromBodies(): Promise<
  LightThreadIndexEntry[]
> {
  const keys = await backend().getAllKeys();
  const bodyKeys = keys.filter((k) => k.startsWith(LIGHT_BODY_KEY_PREFIX));
  const entries: LightThreadIndexEntry[] = [];
  for (const k of bodyKeys) {
    const raw = await backend().getItem(k);
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue; // unreadable body stays on disk but is omitted from the index
    }
    const body = migrateLightThread(parsed);
    if (body) entries.push(deriveLightIndexEntry(body));
  }
  const reconciled = reconcileLightIndex(entries);
  await writeIndex(reconciled);
  return reconciled;
}
