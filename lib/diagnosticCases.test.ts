// ============================================================================
// Diagnostic case store — gate tester (Stage 2B, Batch 1).
//
// Node-runnable, same discipline as lib/dtcParser.test.ts. Two halves:
//   GATE   — the migrator's non-negotiable contract: malformed / truncated /
//            future-version input NEVER throws and NEVER yields a bad object.
//   STORE  — the orchestration: round-trip, index upkeep, the "never deletes"
//            invariant for unreadable/future bodies, prune selection, self-heal.
//
// Run from project root:
//   npx ts-node --skipProject --compiler-options "{\"module\":\"CommonJS\",\"moduleResolution\":\"node\",\"esModuleInterop\":true}" --transpile-only lib/diagnosticCases.test.ts
//
// Batch 1 is NOT done until this prints ALL ... PASSED and exits 0.
// ============================================================================

import {
  CASE_CAP,
  CASE_SCHEMA_VERSION,
  type DiagnosticCase,
  caseBodyKey,
  deriveIndexEntry,
  makeCaseId,
  migrateCase,
  selectPrune,
} from "./diagnosticCasesCore";
import {
  type KVBackend,
  closeCase,
  deleteCase,
  findOpenCasesByVin,
  loadCase,
  loadIndex,
  pruneForNewCase,
  rebuildIndexFromBodies,
  setKVBackendForTests,
  upsertCase,
} from "./diagnosticCases";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean): void {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  FAIL  ${name}`);
  }
}

// migrateCase must NEVER throw — wrap so a throw becomes a visible failure
// rather than aborting the run.
function migrateNoThrow(input: unknown): {
  threw: boolean;
  result: DiagnosticCase | null;
} {
  try {
    return { threw: false, result: migrateCase(input) };
  } catch {
    return { threw: true, result: null };
  }
}

function makeMemBackend(): KVBackend & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: async (k) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: async (k, v) => {
      map.set(k, v);
    },
    removeItem: async (k) => {
      map.delete(k);
    },
    getAllKeys: async () => [...map.keys()],
  };
}

function validBody(overrides: Partial<DiagnosticCase> = {}): DiagnosticCase {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: makeCaseId(),
    status: "open",
    closeReason: null,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    vehicle: {
      vehicle: {
        year: "2011",
        make: "GMC",
        model: "Sierra",
        mileage: "120000",
      },
      vin: "1GT120000B0000000",
      source: "obd2-auto",
    },
    complaint: "P0442 small evap leak, MIL on",
    mileage: "120000",
    operatingCondition: "WARM_IDLE",
    messages: [
      { role: "user", content: "P0442 small evap leak" },
      {
        role: "assistant",
        content: JSON.stringify({ kind: "question", question: "Cap tight?", diagnosis: null }),
      },
    ],
    assessments: [],
    linkedRecordIds: [],
    loggerSessionIds: [],
    evidenceLedger: [],
    caseState: null,
    ...overrides,
  };
}

async function main(): Promise<void> {
  console.log("\n[1] GATE — migrateCase contract (never throws, never bad object)\n");

  // --- Valid input round-trips ---
  {
    const body = validBody();
    const r = migrateNoThrow(body);
    check("valid v1 → returns a case", !r.threw && r.result !== null);
    check("valid v1 → id preserved", r.result?.id === body.id);
    check("valid v1 → schemaVersion is current", r.result?.schemaVersion === CASE_SCHEMA_VERSION);
  }

  // --- Forward-fill: v1 body missing the 2C slots still loads ---
  {
    const partial: Record<string, unknown> = {
      schemaVersion: 1,
      id: "legacy1",
      status: "open",
      messages: [{ role: "user", content: "hi" }],
      // no evidenceLedger, no caseState, no linkedRecordIds, no vehicle, etc.
    };
    const r = migrateNoThrow(partial);
    check("v1 missing 2C slots → still loads", r.result !== null);
    check("v1 missing evidenceLedger → defaulted to []", Array.isArray(r.result?.evidenceLedger) && r.result?.evidenceLedger.length === 0);
    check("v1 missing caseState → defaulted to null", r.result?.caseState === null);
    check("v1 missing vehicle → safe default object", !!r.result?.vehicle && r.result?.vehicle.vin === null);
    check("v1 missing operatingCondition → WARM_IDLE", r.result?.operatingCondition === "WARM_IDLE");
  }

  // --- Required-invariant failures → null (never a half-built object) ---
  check("v1 missing id → null", migrateNoThrow({ schemaVersion: 1, status: "open", messages: [] }).result === null);
  check("v1 empty id → null", migrateNoThrow({ schemaVersion: 1, id: "", status: "open", messages: [] }).result === null);
  check("v1 bad status → null", migrateNoThrow({ schemaVersion: 1, id: "x", status: "archived", messages: [] }).result === null);
  check("v1 messages not array → null", migrateNoThrow({ schemaVersion: 1, id: "x", status: "open", messages: "nope" }).result === null);

  // --- Version handling ---
  check("FUTURE version (99) → null, no throw", (() => { const r = migrateNoThrow({ schemaVersion: 99, id: "x", status: "open", messages: [] }); return !r.threw && r.result === null; })());
  check("version 0 → null", migrateNoThrow({ schemaVersion: 0, id: "x", status: "open", messages: [] }).result === null);
  check("negative version → null", migrateNoThrow({ schemaVersion: -1, id: "x", status: "open", messages: [] }).result === null);
  check("missing schemaVersion → null", migrateNoThrow({ id: "x", status: "open", messages: [] }).result === null);
  check("non-numeric schemaVersion → null", migrateNoThrow({ schemaVersion: "1", id: "x", status: "open", messages: [] }).result === null);

  // --- Non-object / malformed / truncated-shape input → null, never throws ---
  for (const [label, input] of [
    ["null", null],
    ["undefined", undefined],
    ["number", 42],
    ["string", "garbage"],
    ["array", [1, 2, 3]],
    ["empty object", {}],
    ["boolean", true],
  ] as [string, unknown][]) {
    const r = migrateNoThrow(input);
    check(`${label} input → null, no throw`, !r.threw && r.result === null);
  }

  // --- Malformed nested data is sanitized, not fatal ---
  {
    const r = migrateNoThrow({
      schemaVersion: 1,
      id: "mixed",
      status: "open",
      messages: [
        { role: "user", content: "ok" },
        { role: "bogus", content: "drop me" },
        { role: "assistant" }, // no content → drop
        "not an object", // drop
        { role: "assistant", content: "keep" },
      ],
      assessments: [
        { afterMessageIndex: 0, result: { status: "done", assessment: { stance: "AUTOPILOT" } }, completedAt: "t" },
        { afterMessageIndex: 1, result: { status: "bogus" } }, // drop
        "garbage", // drop
      ],
      linkedRecordIds: ["r1", 5, "r2"], // 5 dropped
    });
    check("malformed messages sanitized (2 of 5 kept)", r.result?.messages.length === 2);
    check("malformed assessments sanitized (1 of 3 kept)", r.result?.assessments.length === 1);
    check("malformed linkedRecordIds filtered to strings", JSON.stringify(r.result?.linkedRecordIds) === JSON.stringify(["r1", "r2"]));
  }

  // --- Stage 3 (Step 1): finding_options ride through the migrator untouched ---
  // Raw object straight to migrateNoThrow (param is `unknown`), matching the
  // malformed-fixture pattern above so partial/loose fixtures don't trip tsc.
  {
    const r = migrateNoThrow({
      schemaVersion: 1,
      id: "finding1",
      status: "open",
      messages: [{ role: "user", content: "P0442 evap" }],
      assessments: [
        {
          afterMessageIndex: 0,
          result: {
            status: "done",
            assessment: {
              stance: "GUIDED",
              next_step: {
                action: "Check the EVAP purge valve",
                rationale: "Distinguishes stuck-open from stuck-closed.",
                type: "PHYSICAL_INSPECTION",
                finding_options: {
                  outcomes: ["Stuck open", "Stuck closed", "Holds vacuum / OK"],
                },
              },
            },
          },
          completedAt: "t",
        },
      ],
    });
    const ns = (
      r.result?.assessments[0]?.result as {
        assessment?: { next_step?: { finding_options?: { outcomes?: string[] } } };
      }
    )?.assessment?.next_step;
    check(
      "finding_options survives migrateCase round-trip unchanged",
      JSON.stringify(ns?.finding_options?.outcomes) ===
        JSON.stringify(["Stuck open", "Stuck closed", "Holds vacuum / OK"]),
    );
    check(
      "assessment carrying finding_options still loads",
      r.result?.assessments.length === 1,
    );
  }
  // A malformed finding_options must not break migration (client re-reads it
  // defensively via readFindingOptions); the migrator casts the assessment
  // wholesale, so it passes through without throwing.
  {
    const r = migrateNoThrow({
      schemaVersion: 1,
      id: "finding2",
      status: "open",
      messages: [{ role: "user", content: "x" }],
      assessments: [
        {
          afterMessageIndex: 0,
          result: {
            status: "done",
            assessment: {
              next_step: {
                action: "x",
                rationale: "y",
                type: "PHYSICAL_INSPECTION",
                finding_options: "garbage",
              },
            },
          },
          completedAt: "t",
        },
      ],
    });
    check(
      "malformed finding_options → migrates without throwing",
      !r.threw && r.result !== null,
    );
    check(
      "malformed finding_options → assessment still loads",
      r.result?.assessments.length === 1,
    );
  }

  // --- Photo Evidence (Step 1): sanitizeMessages preserves a valid image, ---
  // drops a malformed one without losing the message, never restores base64.
  {
    const r = migrateNoThrow({
      schemaVersion: 1,
      id: "photo1",
      status: "open",
      messages: [
        {
          role: "user",
          content: "Here's the boot",
          image: {
            uri: "file:///doc/p.jpg",
            mediaType: "image/jpeg",
            width: 1200,
            height: 900,
            base64: "SHOULD_NOT_PERSIST",
          },
        },
      ],
    });
    const m = r.result?.messages[0] as {
      image?: { uri?: string; mediaType?: string; width?: number; height?: number; base64?: string };
    };
    check(
      "valid image preserved through migrateCase",
      m?.image?.uri === "file:///doc/p.jpg" && m?.image?.mediaType === "image/jpeg",
    );
    check(
      "image dimensions preserved",
      m?.image?.width === 1200 && m?.image?.height === 900,
    );
    check("base64 is NEVER restored (transient)", m?.image?.base64 === undefined);
  }
  {
    const r = migrateNoThrow({
      schemaVersion: 1,
      id: "photo2",
      status: "open",
      messages: [
        { role: "user", content: "bad image", image: "garbage" },
        { role: "user", content: "bad uri", image: { uri: 123, mediaType: "image/jpeg" } },
        { role: "user", content: "non-jpeg", image: { uri: "file:///x.jpg", mediaType: "image/png" } },
      ],
    });
    const msgs = r.result?.messages as { image?: unknown }[] | undefined;
    check(
      "malformed image → message still loads (3 kept), never throws",
      !r.threw && msgs?.length === 3,
    );
    check(
      "malformed image fields dropped, not the message",
      msgs?.[0]?.image === undefined &&
        msgs?.[1]?.image === undefined &&
        msgs?.[2]?.image === undefined,
    );
  }
  {
    const r = migrateNoThrow({
      schemaVersion: 1,
      id: "photo3",
      status: "open",
      messages: [
        { role: "user", content: "gone", image: { uri: "file:///deleted.jpg", mediaType: "image/jpeg" } },
      ],
    });
    const m = r.result?.messages[0] as { image?: { uri?: string } };
    check(
      "dangling uri survives migration (render degrades, not a crash)",
      m?.image?.uri === "file:///deleted.jpg",
    );
  }

  console.log("\n[2] STORE — orchestration + 'never deletes' invariant\n");

  // --- Round-trip + index ---
  {
    setKVBackendForTests(makeMemBackend());
    const body = validBody();
    await upsertCase(body);
    const loaded = await loadCase(body.id);
    check("upsert → loadCase round-trips id", loaded?.id === body.id);
    check("upsert → loadCase round-trips complaint", loaded?.complaint === body.complaint);
    const index = await loadIndex();
    check("upsert → index has one entry", index.length === 1);
    check("index entry has vin for lookup", index[0]?.vin === body.vehicle.vin);
    check("index entry derived label", index[0]?.vehicleLabel.includes("Sierra"));
    check("open index entry → closeReason null", index[0]?.closeReason === null);
  }

  // --- Index closeReason distinguishes fix_confirmed from user close ---
  {
    setKVBackendForTests(makeMemBackend());
    await upsertCase(validBody({ id: "fixed1" }));
    await upsertCase(validBody({ id: "userclosed1" }));
    await closeCase("fixed1", "fix_confirmed", "rec_fix");
    await closeCase("userclosed1", "closed_by_user");
    const idx = await loadIndex();
    const fixed = idx.find((e) => e.id === "fixed1");
    const userClosed = idx.find((e) => e.id === "userclosed1");
    check("index closeReason → fix_confirmed surfaced", fixed?.closeReason === "fix_confirmed");
    check("index closeReason → closed_by_user surfaced", userClosed?.closeReason === "closed_by_user");
    check("deriveIndexEntry → closeReason from a closed body", deriveIndexEntry(validBody({ status: "closed", closeReason: "fix_confirmed" })).closeReason === "fix_confirmed");
  }

  // --- NEVER DELETES: future-version body survives an unreadable load ---
  {
    const be = makeMemBackend();
    setKVBackendForTests(be);
    const futureRaw = JSON.stringify({ schemaVersion: 99, id: "future1", status: "open", messages: [] });
    be.map.set(caseBodyKey("future1"), futureRaw);
    const loaded = await loadCase("future1");
    check("future-version body → loadCase null", loaded === null);
    check("future-version body → NOT deleted from disk", be.map.get(caseBodyKey("future1")) === futureRaw);
  }

  // --- NEVER DELETES: truncated JSON body survives ---
  {
    const be = makeMemBackend();
    setKVBackendForTests(be);
    const truncated = '{"schemaVersion":1,"id":"trunc1","status":"open"'; // cut off
    be.map.set(caseBodyKey("trunc1"), truncated);
    const loaded = await loadCase("trunc1");
    check("truncated body → loadCase null", loaded === null);
    check("truncated body → NOT deleted from disk", be.map.get(caseBodyKey("trunc1")) === truncated);
  }

  // --- deleteCase removes body + index row ---
  {
    const be = makeMemBackend();
    setKVBackendForTests(be);
    const body = validBody();
    await upsertCase(body);
    await deleteCase(body.id);
    check("deleteCase → body gone", be.map.get(caseBodyKey(body.id)) === undefined);
    check("deleteCase → index empty", (await loadIndex()).length === 0);
  }

  // --- closeCase transitions + links a record ---
  {
    setKVBackendForTests(makeMemBackend());
    const body = validBody();
    await upsertCase(body);
    await closeCase(body.id, "fix_confirmed", "rec_123");
    const loaded = await loadCase(body.id);
    check("closeCase → status closed", loaded?.status === "closed");
    check("closeCase → closeReason set", loaded?.closeReason === "fix_confirmed");
    check("closeCase → closedAt set", typeof loaded?.closedAt === "string");
    check("closeCase → record linked", loaded?.linkedRecordIds.includes("rec_123") === true);
    const idx = await loadIndex();
    check("closeCase → index reflects closed status", idx[0]?.status === "closed");
  }

  // --- Prune selection (pure) ---
  {
    const mk = (id: string, status: "open" | "closed", updatedAt: string) =>
      deriveIndexEntry(validBody({ id, status, updatedAt }));
    const under = [mk("a", "open", "2026-01-01T00:00:00Z")];
    check("under cap → not needed", selectPrune(under, 3).needed === false);

    const atCapMixed = [
      mk("a", "open", "2026-01-03T00:00:00Z"),
      mk("b", "closed", "2026-01-01T00:00:00Z"), // oldest closed
      mk("c", "closed", "2026-01-02T00:00:00Z"),
    ];
    const d1 = selectPrune(atCapMixed, 3);
    check("at cap, closed exist → needed", d1.needed === true);
    check("at cap → picks OLDEST closed (b)", d1.victimId === "b");
    check("at cap, closed exist → not blocked", d1.blocked === false);

    const atCapAllOpen = [
      mk("a", "open", "2026-01-01T00:00:00Z"),
      mk("b", "open", "2026-01-02T00:00:00Z"),
      mk("c", "open", "2026-01-03T00:00:00Z"),
    ];
    const d2 = selectPrune(atCapAllOpen, 3);
    check("at cap, all open → blocked", d2.blocked === true && d2.victimId === null);
    check("at cap, all open → openEntries surfaced", d2.openEntries.length === 3);
  }

  // --- pruneForNewCase deletes oldest closed; never an open one ---
  {
    setKVBackendForTests(makeMemBackend());
    // Fill to CASE_CAP: one closed (oldest), rest open.
    await upsertCase(validBody({ id: "closed_old", status: "closed", updatedAt: "2026-01-01T00:00:00Z" }));
    for (let i = 1; i < CASE_CAP; i++) {
      await upsertCase(validBody({ id: `open_${i}`, status: "open", updatedAt: `2026-02-${String(i).padStart(2, "0")}T00:00:00Z` }));
    }
    const before = await loadIndex();
    check(`filled to cap (${CASE_CAP})`, before.length === CASE_CAP);
    const decision = await pruneForNewCase();
    check("pruneForNewCase → deleted oldest closed", decision.victimId === "closed_old");
    check("pruneForNewCase → closed body removed", (await loadCase("closed_old")) === null);
    check("pruneForNewCase → back under cap", (await loadIndex()).length === CASE_CAP - 1);
    const openStill = await loadCase("open_1");
    check("pruneForNewCase → open case untouched", openStill?.id === "open_1");
  }

  // --- pruneForNewCase blocks (deletes nothing) when all open ---
  {
    setKVBackendForTests(makeMemBackend());
    for (let i = 0; i < CASE_CAP; i++) {
      await upsertCase(validBody({ id: `o_${i}`, status: "open", updatedAt: `2026-03-${String(i + 1).padStart(2, "0")}T00:00:00Z` }));
    }
    const decision = await pruneForNewCase();
    check("all-open at cap → blocked", decision.blocked === true);
    check("all-open at cap → nothing deleted", (await loadIndex()).length === CASE_CAP);
    check("all-open at cap → openEntries returned for UX", decision.openEntries.length === CASE_CAP);
  }

  // --- Index self-heal: corrupt index, bodies present ---
  {
    const be = makeMemBackend();
    setKVBackendForTests(be);
    await upsertCase(validBody({ id: "heal1", updatedAt: "2026-01-01T00:00:00Z" }));
    await upsertCase(validBody({ id: "heal2", updatedAt: "2026-01-02T00:00:00Z" }));
    // Corrupt the index key (bodies remain intact).
    be.map.set("vulcan:cases:index:v1", "{ broken json");
    const healed = await rebuildIndexFromBodies();
    check("rebuild → both bodies indexed", healed.length === 2);
    check("rebuild → newest-updated first", healed[0]?.id === "heal2");
    // A future-version body present is skipped in the rebuilt index but kept on disk.
    be.map.set(caseBodyKey("fut"), JSON.stringify({ schemaVersion: 99, id: "fut" }));
    const healed2 = await rebuildIndexFromBodies();
    check("rebuild → future body omitted from index", healed2.find((e) => e.id === "fut") === undefined);
    check("rebuild → future body still on disk", be.map.has(caseBodyKey("fut")));
  }

  // --- loadIndex self-heals from empty index when bodies exist ---
  {
    const be = makeMemBackend();
    setKVBackendForTests(be);
    await upsertCase(validBody({ id: "orphan1" }));
    be.map.delete("vulcan:cases:index:v1"); // index lost, body remains
    const index = await loadIndex();
    check("loadIndex → self-heals from orphan body", index.length === 1 && index[0].id === "orphan1");
  }

  // --- findOpenCasesByVin: open + matching only ---
  {
    setKVBackendForTests(makeMemBackend());
    const vin = "1HGBH41JXMN109186";
    await upsertCase(validBody({ id: "v_open1", status: "open", vehicle: { vehicle: { year: "2021", make: "Honda", model: "Civic", mileage: "" }, vin, source: "obd2-auto" } }));
    await upsertCase(validBody({ id: "v_open2", status: "open", vehicle: { vehicle: { year: "2021", make: "Honda", model: "Civic", mileage: "" }, vin, source: "obd2-auto" } }));
    await upsertCase(validBody({ id: "v_closed", status: "closed", vehicle: { vehicle: { year: "2021", make: "Honda", model: "Civic", mileage: "" }, vin, source: "obd2-auto" } }));
    await upsertCase(validBody({ id: "v_other", status: "open", vehicle: { vehicle: { year: "2021", make: "Honda", model: "Civic", mileage: "" }, vin: "OTHERVIN000000000", source: "obd2-auto" } }));
    const matches = await findOpenCasesByVin(vin.toLowerCase()); // case-insensitive
    check("findOpenCasesByVin → 2 open matches", matches.length === 2);
    check("findOpenCasesByVin → excludes closed", matches.find((e) => e.id === "v_closed") === undefined);
    check("findOpenCasesByVin → excludes other VIN", matches.find((e) => e.id === "v_other") === undefined);
    check("findOpenCasesByVin → empty for blank vin", (await findOpenCasesByVin("")).length === 0);
  }

  setKVBackendForTests(null); // restore default for any later importer

  // --- Report ---
  console.log("\n────────────────────────────────────────────────────────────");
  if (failed === 0) {
    console.log(`ALL ${passed} TESTS PASSED`);
    console.log("────────────────────────────────────────────────────────────");
    process.exit(0);
  } else {
    console.log(`${failed} FAILED, ${passed} passed`);
    console.log("Failures:\n  - " + failures.join("\n  - "));
    console.log("────────────────────────────────────────────────────────────");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[diagnosticCases.test] runner threw:", err);
  process.exit(1);
});
