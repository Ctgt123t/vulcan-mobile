// ============================================================================
// Light chat threads — node gate (Ask+Diagnose merge plan, Phase 3).
//
// Same discipline + invocation as diagnosticCases.test.ts:
//   npx ts-node --skipProject --compiler-options "{\"module\":\"CommonJS\",
//   \"moduleResolution\":\"node\",\"esModuleInterop\":true}" --transpile-only
//   lib/lightThreads.test.ts
//
// Gates: the tolerant migrator (never throws / never yields a bad object /
// FUTURE version → null), the never-deletes invariant at the storage layer,
// the Brave-ToS diagram strip + base64 strip on persist/restore, title/index
// derivation, the automatic (no-consent) prune, and index self-heal.
// ============================================================================

import {
  LIGHT_CAP,
  LIGHT_SCHEMA_VERSION,
  type LightThread,
  type LightThreadIndexEntry,
  deriveLightIndexEntry,
  lightBodyKey,
  makeThreadId,
  migrateLightThread,
  reconcileLightIndex,
  selectLightPrune,
  threadTitle,
} from "./lightThreadsCore";
import {
  type LightKVBackend,
  deleteLightThread,
  loadLightIndex,
  loadLightThread,
  pruneForNewLightThread,
  rebuildLightIndexFromBodies,
  setLightKVBackendForTests,
  upsertLightThread,
} from "./lightThreads";
import type { ChatMessage } from "./types";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${name}`);
  }
}

function makeMemoryBackend(): LightKVBackend & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async getItem(k) {
      return store.has(k) ? (store.get(k) as string) : null;
    },
    async setItem(k, v) {
      store.set(k, v);
    },
    async removeItem(k) {
      store.delete(k);
    },
    async getAllKeys() {
      return [...store.keys()];
    },
  };
}

function makeThread(overrides: Partial<LightThread> = {}): LightThread {
  const now = new Date().toISOString();
  return {
    schemaVersion: LIGHT_SCHEMA_VERSION,
    id: makeThreadId(),
    vehicle: { year: "2019", make: "Ford", model: "F-150", mileage: "" },
    vin: "1FTEW1EP5KFA00001",
    messages: [
      { role: "user", content: "what oil does it take" },
      { role: "assistant", content: "5W-30, about 6 quarts." },
    ],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function run(): Promise<void> {
  // ---- Migrator tolerance (never throws, never yields a bad object) ----
  check("migrate: null → null", migrateLightThread(null) === null);
  check("migrate: string → null", migrateLightThread("junk") === null);
  check("migrate: array → null", migrateLightThread([]) === null);
  check("migrate: empty object → null", migrateLightThread({}) === null);
  check(
    "migrate: unversioned → null",
    migrateLightThread({ id: "x", messages: [] }) === null,
  );
  check(
    "migrate: FUTURE version → null",
    migrateLightThread({ schemaVersion: 99, id: "x", messages: [] }) === null,
  );
  check(
    "migrate: missing id → null",
    migrateLightThread({ schemaVersion: 1, messages: [] }) === null,
  );

  const authored = makeThread();
  const roundTripped = migrateLightThread(
    JSON.parse(JSON.stringify(authored)),
  );
  check("migrate: round-trip non-null", roundTripped !== null);
  check(
    "migrate: round-trip messages preserved",
    roundTripped !== null &&
      roundTripped.messages.length === 2 &&
      roundTripped.messages[0].content === "what oil does it take" &&
      roundTripped.messages[1].role === "assistant",
  );
  check(
    "migrate: round-trip vehicle + vin preserved",
    roundTripped !== null &&
      roundTripped.vehicle?.make === "Ford" &&
      roundTripped.vin === "1FTEW1EP5KFA00001",
  );

  // Diagrams (Brave ToS) + base64 (lean rule) must NOT survive persistence.
  const dirty = makeThread({
    messages: [
      {
        role: "user",
        content: "photo",
        image: {
          uri: "file:///a.jpg",
          mediaType: "image/jpeg",
          base64: "AAAA",
        },
      },
      {
        role: "assistant",
        content: "fuse diagram below",
        diagrams: { images: [{ url: "https://x" }] },
      } as unknown as ChatMessage,
    ],
  });
  const cleaned = migrateLightThread(JSON.parse(JSON.stringify(dirty)));
  check("migrate: image kept without base64",
    cleaned !== null &&
      cleaned.messages[0].image?.uri === "file:///a.jpg" &&
      cleaned.messages[0].image?.base64 === undefined,
  );
  check(
    "migrate: diagrams stripped (Brave ToS)",
    cleaned !== null &&
      (cleaned.messages[1] as { diagrams?: unknown }).diagrams === undefined,
  );
  check(
    "migrate: junk vehicle tolerated → null vehicle",
    migrateLightThread({ schemaVersion: 1, id: "x", vehicle: "junk" })
      ?.vehicle === null,
  );

  // ---- Title + index derivation ----
  check("title: first user message", threadTitle(authored.messages) === "what oil does it take");
  check("title: empty thread → New chat", threadTitle([]) === "New chat");
  check(
    "title: photo-only opener → Photo question",
    threadTitle([
      {
        role: "user",
        content: "",
        image: { uri: "file:///a.jpg", mediaType: "image/jpeg" },
      },
    ]) === "Photo question",
  );
  const entry = deriveLightIndexEntry(authored);
  check(
    "index entry fields",
    entry.id === authored.id &&
      entry.titlePreview === "what oil does it take" &&
      entry.vehicleLabel === "2019 Ford F-150 · …A00001",
  );

  // ---- Prune selection (automatic, oldest by updatedAt) ----
  const idx: LightThreadIndexEntry[] = Array.from({ length: LIGHT_CAP }, (_, i) =>
    deriveLightIndexEntry(
      makeThread({
        id: `t${i}`,
        updatedAt: new Date(2026, 0, i + 1).toISOString(),
      }),
    ),
  );
  check("prune: under cap → null", selectLightPrune(idx.slice(0, 5)) === null);
  check("prune: at cap → oldest", selectLightPrune(idx) === "t0");

  // ---- Reconcile ----
  const rec = reconcileLightIndex([idx[3], idx[1], idx[3], idx[2]]);
  check(
    "reconcile: dedup + newest first",
    rec.length === 3 && rec[0].id === "t3" && rec[2].id === "t1",
  );

  // ---- Storage layer (in-memory backend) ----
  const mem = makeMemoryBackend();
  setLightKVBackendForTests(mem);

  const a = makeThread({ id: "aaa" });
  await upsertLightThread(a);
  const loadedA = await loadLightThread("aaa");
  check("storage: upsert + load round-trip", loadedA !== null && loadedA.id === "aaa");
  const idx1 = await loadLightIndex();
  check("storage: index has entry", idx1.length === 1 && idx1[0].id === "aaa");

  // Never-deletes: a FUTURE-version body loads as null but stays on disk.
  mem.store.set(
    lightBodyKey("future"),
    JSON.stringify({ schemaVersion: 99, id: "future", messages: [] }),
  );
  const fut = await loadLightThread("future");
  check("storage: future version loads null", fut === null);
  check(
    "storage: future body NOT deleted",
    mem.store.has(lightBodyKey("future")),
  );
  // Corrupt JSON: loads null, stays on disk.
  mem.store.set(lightBodyKey("corrupt"), "{truncated");
  check("storage: corrupt loads null", (await loadLightThread("corrupt")) === null);
  check("storage: corrupt body NOT deleted", mem.store.has(lightBodyKey("corrupt")));

  // Delete removes body + index row.
  await deleteLightThread("aaa");
  check("storage: delete removes body", !mem.store.has(lightBodyKey("aaa")));
  check("storage: delete removes index row", (await loadLightIndex()).length === 0);

  // Self-heal: bodies exist, index empty → rebuilt (unreadable bodies omitted
  // but left on disk).
  const b = makeThread({ id: "bbb" });
  const c = makeThread({ id: "ccc" });
  mem.store.set(lightBodyKey("bbb"), JSON.stringify(b));
  mem.store.set(lightBodyKey("ccc"), JSON.stringify(c));
  const healed = await loadLightIndex();
  check(
    "storage: self-heal rebuilds from bodies",
    healed.length === 2 && healed.some((e) => e.id === "bbb") && healed.some((e) => e.id === "ccc"),
  );
  check(
    "storage: self-heal leaves unreadables on disk",
    mem.store.has(lightBodyKey("future")) && mem.store.has(lightBodyKey("corrupt")),
  );
  const healedAgain = await rebuildLightIndexFromBodies();
  check("storage: explicit rebuild consistent", healedAgain.length === 2);

  // Automatic prune: fill to cap, prune deletes the oldest.
  mem.store.clear();
  await Promise.all(
    Array.from({ length: LIGHT_CAP }, (_, i) =>
      upsertLightThread(
        makeThread({
          id: `p${i}`,
          updatedAt: new Date(2026, 0, i + 1).toISOString(),
        }),
      ),
    ),
  );
  check("storage: filled to cap", (await loadLightIndex()).length === LIGHT_CAP);
  await pruneForNewLightThread();
  const afterPrune = await loadLightIndex();
  check(
    "storage: prune deleted the oldest automatically",
    afterPrune.length === LIGHT_CAP - 1 && !afterPrune.some((e) => e.id === "p0"),
  );
  check("storage: prune removed the body too", !mem.store.has(lightBodyKey("p0")));

  setLightKVBackendForTests(null);

  console.log("================================================");
  if (failed === 0) {
    console.log(`[light-threads-test] ALL ${passed} PASSED`);
  } else {
    console.error(`[light-threads-test] ${failed} FAILED, ${passed} passed`);
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("[light-threads-test] CRASHED:", err);
  process.exit(1);
});
