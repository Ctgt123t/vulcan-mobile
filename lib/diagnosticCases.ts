// ============================================================================
// Diagnostic case storage layer (Stage 2B).
//
// Thin AsyncStorage orchestration over the pure core (diagnosticCasesCore.ts):
// per-case body keys + one index key, a serialized write queue, and a public
// API the diagnose screen + saved-cases list call. All migration / prune /
// index logic lives in the core; this file does I/O only.
//
// SCALABILITY (standing requirement): per-device AsyncStorage, hard-capped at
// CASE_CAP (25) cases. This does NOT scale to a multi-device / shared-shop
// model — server-side case sync is the post-auth migration path. When auth +
// the backend user model land, cases move to a per-user server store with this
// AsyncStorage layer becoming an offline cache. Flagged here so the boundary is
// explicit, per the project Scalability Requirements section.
//
// BACKEND SEAM: storage goes through an injectable KVBackend. The default
// lazily binds AsyncStorage on first use (so merely importing this module in a
// Node test does not touch RN), and setKVBackendForTests() swaps in an
// in-memory backend for the gate tester.
// ============================================================================

import {
  CASE_BODY_KEY_PREFIX,
  CASE_CAP,
  CASE_INDEX_KEY,
  type CaseCloseReason,
  type CaseIndexEntry,
  type DiagnosticCase,
  type PruneDecision,
  caseBodyKey,
  deriveIndexEntry,
  migrateCase,
  reconcileIndex,
  selectPrune,
} from "./diagnosticCasesCore";

// ---- Backend seam ----------------------------------------------------------

export interface KVBackend {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  getAllKeys(): Promise<readonly string[]>;
}

let _backend: KVBackend | null = null;

// Default backend: lazily require AsyncStorage so a Node import of this module
// (with a test backend injected first) never evaluates the native module.
function defaultBackend(): KVBackend {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const AsyncStorage = require("@react-native-async-storage/async-storage")
    .default as KVBackend;
  return AsyncStorage;
}

function backend(): KVBackend {
  if (!_backend) _backend = defaultBackend();
  return _backend;
}

// Test seam — inject an in-memory backend. Not used in app code.
export function setKVBackendForTests(b: KVBackend | null): void {
  _backend = b;
}

// ---- Serialized write queue ------------------------------------------------
//
// Auto-save fires up to twice per turn (user turn + assistant reply) and an
// assessment can resolve concurrently. Each mutation is a read-modify-write of
// the shared index, so they must not interleave. Every public mutation runs
// through serialize(); reads do not need the queue.
let writeChain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  // Swallow rejection on the chain itself so one failed write can't poison the
  // queue; the returned `run` still rejects to its own caller.
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// ---- Index I/O -------------------------------------------------------------

async function readIndexRaw(): Promise<CaseIndexEntry[]> {
  const raw = await backend().getItem(CASE_INDEX_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is CaseIndexEntry =>
        !!e && typeof e === "object" && typeof e.id === "string",
    );
  } catch {
    return [];
  }
}

async function writeIndex(index: CaseIndexEntry[]): Promise<void> {
  await backend().setItem(CASE_INDEX_KEY, JSON.stringify(index));
}

// Public read of the saved-cases list. If the index is empty/corrupt but case
// bodies exist on disk, self-heal by rebuilding from bodies.
export async function loadIndex(): Promise<CaseIndexEntry[]> {
  const index = await readIndexRaw();
  if (index.length > 0) return index;
  // Empty index — confirm there are no orphan bodies before trusting it.
  const keys = await backend().getAllKeys();
  const hasBodies = keys.some((k) => k.startsWith(CASE_BODY_KEY_PREFIX));
  if (!hasBodies) return [];
  return rebuildIndexFromBodies();
}

// ---- Body I/O --------------------------------------------------------------

// Load + migrate a case body. On a null result (missing / malformed /
// truncated / FUTURE version) the body key is NEVER removed — an unreadable
// body (e.g. a newer schema after an OTA rollback) survives untouched so a
// later compatible app version can read it. This is the "never deletes"
// invariant, enforced here at the I/O boundary.
export async function loadCase(id: string): Promise<DiagnosticCase | null> {
  const raw = await backend().getItem(caseBodyKey(id));
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // truncated / corrupt JSON — leave it on disk
  }
  return migrateCase(parsed); // null for unknown/future — leave it on disk
}

// Write a case body and update its index row. Serialized. Always writes the
// current schema version (we only ever author the current shape).
export async function upsertCase(body: DiagnosticCase): Promise<void> {
  return serialize(async () => {
    await backend().setItem(caseBodyKey(body.id), JSON.stringify(body));
    const index = await readIndexRaw();
    const entry = deriveIndexEntry(body);
    const next = index.filter((e) => e.id !== body.id);
    next.unshift(entry);
    await writeIndex(next);
  });
}

export async function deleteCase(id: string): Promise<void> {
  return serialize(async () => {
    await backend().removeItem(caseBodyKey(id));
    const index = await readIndexRaw();
    await writeIndex(index.filter((e) => e.id !== id));
  });
}

// Status transition helpers. Read-migrate-mutate-write, serialized.
export async function closeCase(
  id: string,
  reason: CaseCloseReason,
  recordId?: string,
): Promise<void> {
  return serialize(async () => {
    const body = await loadCase(id);
    if (!body) return; // gone / unreadable — nothing to close
    const now = new Date().toISOString();
    const next: DiagnosticCase = {
      ...body,
      status: "closed",
      closeReason: reason,
      closedAt: now,
      updatedAt: now,
      linkedRecordIds: recordId
        ? [...body.linkedRecordIds, recordId]
        : body.linkedRecordIds,
    };
    await backend().setItem(caseBodyKey(next.id), JSON.stringify(next));
    const index = await readIndexRaw();
    const rebuilt = index.filter((e) => e.id !== next.id);
    rebuilt.unshift(deriveIndexEntry(next));
    await writeIndex(rebuilt);
  });
}

// Append a linked DiagnosticRecord id (e.g. on reject, where the case stays
// open). Serialized.
export async function linkRecord(id: string, recordId: string): Promise<void> {
  return serialize(async () => {
    const body = await loadCase(id);
    if (!body) return;
    if (body.linkedRecordIds.includes(recordId)) return;
    const next: DiagnosticCase = {
      ...body,
      linkedRecordIds: [...body.linkedRecordIds, recordId],
      updatedAt: new Date().toISOString(),
    };
    await backend().setItem(caseBodyKey(next.id), JSON.stringify(next));
    const index = await readIndexRaw();
    const rebuilt = index.filter((e) => e.id !== next.id);
    rebuilt.unshift(deriveIndexEntry(next));
    await writeIndex(rebuilt);
  });
}

// ---- Prune (called before creating a new case) -----------------------------
//
// Returns the pure decision AFTER performing any non-consent-required deletion.
// - under cap → { needed:false } (caller proceeds)
// - at cap, a closed case exists → deletes oldest closed, returns { needed:true,
//   victimId } (caller proceeds; deletion already done)
// - at cap, all open → returns { blocked:true, openEntries } and deletes
//   NOTHING (caller must get explicit consent — the all-25-open UX)
export async function pruneForNewCase(): Promise<PruneDecision> {
  const index = await loadIndex();
  const decision = selectPrune(index, CASE_CAP);
  if (decision.needed && decision.victimId) {
    await deleteCase(decision.victimId);
  }
  return decision;
}

// ---- Index rebuild (self-heal) ---------------------------------------------

export async function rebuildIndexFromBodies(): Promise<CaseIndexEntry[]> {
  const keys = await backend().getAllKeys();
  const bodyKeys = keys.filter((k) => k.startsWith(CASE_BODY_KEY_PREFIX));
  const entries: CaseIndexEntry[] = [];
  for (const k of bodyKeys) {
    const raw = await backend().getItem(k);
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue; // unreadable body is left on disk but omitted from the index
    }
    const body = migrateCase(parsed);
    if (body) entries.push(deriveIndexEntry(body));
  }
  const reconciled = reconcileIndex(entries);
  await writeIndex(reconciled);
  return reconciled;
}

// ---- VIN resume lookup -----------------------------------------------------
//
// OPEN cases whose VIN matches (the resume-by-VIN path). Case-insensitive,
// exact 17-char match expected but compared loosely on trimmed/upper. Returns
// index rows (no body loads) so the auto-prompt and picker are cheap.
export async function findOpenCasesByVin(
  vin: string,
): Promise<CaseIndexEntry[]> {
  const want = vin.trim().toUpperCase();
  if (!want) return [];
  const index = await loadIndex();
  return index.filter(
    (e) =>
      e.status === "open" &&
      e.vin != null &&
      e.vin.trim().toUpperCase() === want,
  );
}
