// ============================================================================
// Capture detector + resolver — NODE TEST GATE (Stage 2C-2).
//
// Same discipline as lib/dtcParser.test.ts / lib/diagnosticCases.test.ts: a
// standalone, framework-free runner. The stage is NOT done until this is green.
//
// Run from project root:
//   npx ts-node --skipProject --compiler-options "{\"module\":\"CommonJS\",\"moduleResolution\":\"node\",\"esModuleInterop\":true}" --transpile-only lib/captureDetector.test.ts
//
// (--transpile-only: types are not enforced here, so fixtures cast loosely.)
// ============================================================================

import type { PidDescriptor } from "./obd2";
import type { RequestedDataItem } from "./assessmentTypes";
import {
  type ResolveContext,
  collectUnavailable,
  resolvePlan,
  resolveSignalId,
} from "./captureResolver";

// ---- tiny test harness ----------------------------------------------------

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(cond: boolean, msg: string) {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(msg);
    console.log(`  FAIL: ${msg}`);
  }
}
function eq(actual: unknown, expected: unknown, msg: string) {
  ok(actual === expected, `${msg} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}
function section(name: string) {
  console.log(`\n=== ${name} ===`);
}

// ---- fixture builders -----------------------------------------------------

function mk(id: string, mode: string, pid: string, extra?: Partial<PidDescriptor>): PidDescriptor {
  const code = `${mode} ${pid}`;
  const d = {
    code,
    command: { mode, pid },
    id,
    name: id,
    unit: "%",
    category: "Test",
    min: 0,
    max: 100,
    decode: { length: 8, multiplier: 1, divisor: 1, offset: 0, signed: false, startBit: null },
    signalKey: `${code}@${id}`,
    ...extra,
  };
  return d as unknown as PidDescriptor;
}

function ctx(over?: Partial<ResolveContext>): ResolveContext {
  return {
    catalog: [],
    selectedKeys: new Set<string>(),
    supportedMode01: new Set<number>(), // empty = "unknown" → no bitmask exclusion
    unsupportedKeys: new Set<string>(),
    ...over,
  };
}

function item(capturePlan: RequestedDataItem["capture_plan"]): RequestedDataItem {
  return {
    signal_id: capturePlan?.measured_target.signal_id ?? "?",
    operating_condition: "test",
    duration_seconds: capturePlan?.capture_window_seconds ?? 15,
    capture_plan: capturePlan,
  };
}

const RPM = mk("RPM", "01", "0C");
const ECT = mk("ECT", "01", "05", { unit: "degC", min: -40, max: 215 });
const SHRTFT1 = mk("SHRTFT1", "01", "06");
const LONGFT1 = mk("LONGFT1", "01", "07");
// The 2C-1 collision: same id at two commands.
const SHRTFT11_14 = mk("SHRTFT11", "01", "14");
const SHRTFT11_15 = mk("SHRTFT11", "01", "15");

// ===========================================================================
// RESOLVER
// ===========================================================================

section("resolver — id matching tiers");
{
  const c = ctx({ catalog: [RPM, ECT, SHRTFT1, LONGFT1] });

  const exact = resolveSignalId("RPM", c);
  eq(exact.status, "resolved", "exact id resolves");
  if (exact.status === "resolved") eq(exact.signalKey, "01 0C@RPM", "exact id -> right key");

  const ci = resolveSignalId("rpm", c);
  eq(ci.status, "resolved", "case-insensitive exact resolves");

  const norm = resolveSignalId("SHRTFT_1", c);
  eq(norm.status, "resolved", "normalized id (separators) resolves");
  if (norm.status === "resolved") eq(norm.signalKey, "01 06@SHRTFT1", "normalized -> SHRTFT1");

  const aliasSt = resolveSignalId("STFT_B1", c);
  eq(aliasSt.status, "resolved", "alias STFT_B1 resolves");
  if (aliasSt.status === "resolved") eq(aliasSt.signalKey, "01 06@SHRTFT1", "STFT_B1 -> SHRTFT1 (01 06)");

  const aliasLt = resolveSignalId("LTFT_B1", c);
  eq(aliasLt.status, "resolved", "alias LTFT_B1 resolves");
  if (aliasLt.status === "resolved") eq(aliasLt.signalKey, "01 07@LONGFT1", "LTFT_B1 -> LONGFT1 (01 07)");

  const none = resolveSignalId("NOTASIGNAL", c);
  eq(none.status, "unavailable", "unknown id is unavailable");
  if (none.status === "unavailable") eq(none.reason, "no_match", "unknown id -> no_match");
}

section("resolver — collision (prefer-selected / else ambiguous / never guess)");
{
  const cat = [RPM, SHRTFT11_14, SHRTFT11_15];

  // none selected, both available -> ambiguous, NOT a silent first-pick.
  const amb = resolveSignalId("SHRTFT11", ctx({ catalog: cat }));
  eq(amb.status, "unavailable", "collision with none selected is unavailable");
  if (amb.status === "unavailable") eq(amb.reason, "ambiguous", "collision -> ambiguous");

  // one selected -> prefer it.
  const pref = resolveSignalId(
    "SHRTFT11",
    ctx({ catalog: cat, selectedKeys: new Set(["01 15@SHRTFT11"]) }),
  );
  eq(pref.status, "resolved", "collision with one selected resolves");
  if (pref.status === "resolved") eq(pref.signalKey, "01 15@SHRTFT11", "prefers the selected command");

  // bitmask narrows to exactly one supported -> pick it (no ambiguity).
  const narrowed = resolveSignalId(
    "SHRTFT11",
    ctx({ catalog: cat, supportedMode01: new Set([0x14]) }),
  );
  eq(narrowed.status, "resolved", "bitmask narrows collision to one supported");
  if (narrowed.status === "resolved") eq(narrowed.signalKey, "01 14@SHRTFT11", "narrowed -> 01 14");
}

section("resolver — support / unsupported filtering");
{
  // bitmask known and lacks RPM's pid (0x0C) -> unsupported.
  const unsup = resolveSignalId("RPM", ctx({ catalog: [RPM], supportedMode01: new Set([0x06]) }));
  eq(unsup.status, "unavailable", "RPM not in bitmask is unavailable");
  if (unsup.status === "unavailable") eq(unsup.reason, "unsupported", "not-in-bitmask -> unsupported");

  // empty bitmask = unknown -> do NOT exclude.
  const unknown = resolveSignalId("RPM", ctx({ catalog: [RPM] }));
  eq(unknown.status, "resolved", "empty bitmask does not exclude (unknown)");

  // unsupportedKeys excludes the only candidate -> unsupported.
  const flaky = resolveSignalId(
    "RPM",
    ctx({ catalog: [RPM], unsupportedKeys: new Set(["01 0C@RPM"]) }),
  );
  eq(flaky.status, "unavailable", "unsupportedKeys excludes candidate");
  if (flaky.status === "unavailable") eq(flaky.reason, "unsupported", "flaky -> unsupported");
}

section("resolver — plan-item runnability");
{
  const c = ctx({ catalog: [RPM, ECT, SHRTFT1] });

  const runnable = resolvePlan(
    [
      item({
        context_gate: [
          { signal_id: "RPM", range: { min: 600, max: 900, unit: "rpm" } },
          { signal_id: "ECT", range: { min: 80, max: null, unit: "degC" } },
        ],
        measured_target: { signal_id: "SHRTFT1", range: { min: 10, max: null, unit: "%" } },
        sustained_seconds: 10,
        capture_window_seconds: 15,
      }),
    ],
    c,
  );
  eq(runnable.length, 1, "one plan item resolved");
  ok(runnable[0].runnable === true, "item is runnable");
  if (runnable[0].runnable) {
    eq(runnable[0].gate.length, 2, "both gate signals resolved");
    eq(runnable[0].degraded.length, 0, "no degraded gate signals");
  }

  // target unavailable -> unrunnable
  const unrunnable = resolvePlan(
    [
      item({
        context_gate: [{ signal_id: "RPM", range: { min: 600, max: 900, unit: "rpm" } }],
        measured_target: { signal_id: "NOPE", range: { min: 10, max: null, unit: "%" } },
        sustained_seconds: 10,
        capture_window_seconds: 15,
      }),
    ],
    c,
  );
  ok(unrunnable[0].runnable === false, "unresolved target -> unrunnable");
  if (!unrunnable[0].runnable) eq(unrunnable[0].reason, "target_unavailable", "reason target_unavailable");

  // gate unavailable but target resolved -> degraded but runnable
  const degraded = resolvePlan(
    [
      item({
        context_gate: [
          { signal_id: "RPM", range: { min: 600, max: 900, unit: "rpm" } },
          { signal_id: "NOPE", range: { min: 0, max: 0, unit: "x" } },
        ],
        measured_target: { signal_id: "SHRTFT1", range: { min: 10, max: null, unit: "%" } },
        sustained_seconds: 10,
        capture_window_seconds: 15,
      }),
    ],
    c,
  );
  ok(degraded[0].runnable === true, "missing gate signal -> still runnable (degraded)");
  if (degraded[0].runnable) {
    eq(degraded[0].gate.length, 1, "one gate resolved");
    eq(degraded[0].degraded.length, 1, "one gate degraded");
  }

  // item without capture_plan is skipped
  const skipped = resolvePlan(
    [{ signal_id: "RPM", operating_condition: "prose only", duration_seconds: 10 }],
    c,
  );
  eq(skipped.length, 0, "prose-only item (no capture_plan) skipped");

  const un = collectUnavailable([...unrunnable, ...degraded]);
  ok(
    un.some((u) => u.signal_id === "NOPE" && u.reason === "no_match"),
    "collectUnavailable includes NOPE as no_match",
  );
  ok(un.length >= 1, "collectUnavailable aggregates unavailable signals");
}

// ===========================================================================
// DETECTOR — fixtures
// ===========================================================================

import {
  CaptureDetector,
  type DetectorEvent,
  type MonitorTick,
  CAPTURE_COOLDOWN_MS,
  INACTIVITY_PAUSE_MS,
  SESSION_FIRE_BUDGET,
} from "./captureDetector";

const RPMKEY = "01 0C@RPM";
const FTKEY = "01 06@SHRTFT1";

// Build runnable items from a plan against a catalog with RPM + SHRTFT1.
function runnableFor(
  capturePlan: NonNullable<RequestedDataItem["capture_plan"]>,
): Extract<ReturnType<typeof resolvePlan>[number], { runnable: true }>[] {
  const resolved = resolvePlan([item(capturePlan)], ctx({ catalog: [RPM, SHRTFT1] }));
  return resolved.filter((r): r is Extract<typeof r, { runnable: true }> => r.runnable);
}

// A tick with given signalKey->value (timestamps fresh = tick time).
function tk(
  timestamp: number,
  vals: Record<string, number | null>,
  ranges?: Record<string, { min: number; max: number | null }>,
): MonitorTick {
  const values: Record<string, unknown> = {};
  for (const k of Object.keys(vals)) {
    values[k] = {
      value: vals[k],
      name: k,
      unit: "",
      category: "",
      min: ranges?.[k]?.min ?? 0,
      max: ranges?.[k]?.max ?? 100,
      timestamp,
    };
  }
  return { timestamp, values: values as MonitorTick["values"] };
}

// Standard lean plan: gate RPM 600-900, target SHRTFT1 >= 10, sustained 2s, window 1s.
function leanPlan(sustained = 2, window = 1) {
  return {
    context_gate: [{ signal_id: "RPM", range: { min: 600, max: 900, unit: "rpm" } }],
    measured_target: { signal_id: "SHRTFT1", range: { min: 10, max: null, unit: "%" } },
    sustained_seconds: sustained,
    capture_window_seconds: window,
  };
}

function firstCapturingAt(events: { t: number; ev: DetectorEvent }[]): number | null {
  const c = events.find((e) => e.ev.type === "card" && e.ev.state === "capturing");
  return c ? c.t : null;
}
function fires(events: { t: number; ev: DetectorEvent }[]) {
  return events.filter((e) => e.ev.type === "fire").map((e) => e.ev) as Extract<DetectorEvent, { type: "fire" }>[];
}

// Drive a detector across a tick stream produced by `valueAt(t)`; cadence 250ms.
function run(
  det: CaptureDetector,
  fromT: number,
  toT: number,
  valueAt: (t: number) => Record<string, number | null>,
  step = 250,
): { t: number; ev: DetectorEvent }[] {
  const all: { t: number; ev: DetectorEvent }[] = [];
  for (let t = fromT; t <= toT; t += step) {
    for (const ev of det.ingestTick(tk(t, valueAt(t)))) all.push({ t, ev });
  }
  return all;
}

section("detector — fire timing (sustained hold)");
{
  const det = new CaptureDetector(runnableFor(leanPlan(2, 1)));
  const ev = run(det, 0, 4000, () => ({ [RPMKEY]: 720, [FTKEY]: 16 }));
  const capAt = firstCapturingAt(ev);
  eq(capAt, 2000, "capture begins at exactly sustained_seconds (2000ms)");
  const f = fires(ev);
  eq(f.length, 1, "exactly one fire");
  if (f[0]) {
    eq(f[0].window.outcome, "completed", "fire outcome completed");
    eq(f[0].window.trigger.targetValueAtFire, 16, "trigger records target value at fire");
    ok(f[0].window.window.length >= 4, "window has ~1s of ticks at 250ms");
    ok(f[0].window.signalKeys.includes(FTKEY) && f[0].window.signalKeys.includes(RPMKEY), "window lists plan signals");
  }
}

section("detector — noise: single-frame spikes never fire");
{
  // Target mostly out of range (2%), with a single in-range spike (16%) every 2s.
  const det = new CaptureDetector(runnableFor(leanPlan(2, 1)));
  const ev = run(det, 0, 8000, (t) => ({
    [RPMKEY]: 720,
    [FTKEY]: t % 2000 === 0 ? 16 : 2,
  }));
  eq(fires(ev).length, 0, "noisy single-frame spikes do not fire");
  eq(firstCapturingAt(ev), null, "no capture begins on noise");
}

section("detector — dropout tolerance");
{
  // Continuous hold EXCEPT one missing tick (a brief <1s glitch) — must still fire.
  const det = new CaptureDetector(runnableFor(leanPlan(2, 1)));
  const ev = run(det, 0, 4000, (t) => {
    if (t === 1000) return { [RPMKEY]: 720, [FTKEY]: null }; // one missed read mid-hold
    return { [RPMKEY]: 720, [FTKEY]: 16 };
  });
  eq(fires(ev).length, 1, "single missed tick within tolerance still fires");
  eq(firstCapturingAt(ev), 2000, "brief glitch does not delay the hold");
}

section("detector — sustained departure resets the hold");
{
  // Out of range for 1.5s (> tolerance) mid-hold → timer resets → fire later.
  const det = new CaptureDetector(runnableFor(leanPlan(2, 1)));
  const ev = run(det, 0, 8000, (t) => {
    const out = t >= 1000 && t < 2500; // 1.5s sustained departure
    return { [RPMKEY]: 720, [FTKEY]: out ? 2 : 16 };
  });
  const capAt = firstCapturingAt(ev);
  ok(capAt != null && capAt >= 4500, `hold restarts after departure (capture at ${capAt}, expected >= 4500)`);
  eq(fires(ev).length, 1, "fires once, after the restart");
}

section("detector — gate must also hold");
{
  // Target in range the whole time but RPM out of the gate band → no fire.
  const det = new CaptureDetector(runnableFor(leanPlan(2, 1)));
  const ev = run(det, 0, 4000, () => ({ [RPMKEY]: 2500, [FTKEY]: 16 }));
  eq(fires(ev).length, 0, "gate out of band prevents fire");
}

section("detector — stale in-band value does not sustain");
{
  // Values are in range but their timestamp never advances (frozen) → treated
  // as missing → no sustained hold.
  const det = new CaptureDetector(runnableFor(leanPlan(2, 1)));
  const stale: MonitorTick["values"] = {
    [RPMKEY]: { value: 720, name: "", unit: "", category: "", min: 0, max: 8000, timestamp: 0 } as never,
    [FTKEY]: { value: 16, name: "", unit: "", category: "", min: 0, max: 100, timestamp: 0 } as never,
  };
  const all: DetectorEvent[] = [];
  for (let t = 0; t <= 4000; t += 250) {
    for (const e of det.ingestTick({ timestamp: t, values: stale })) all.push(e);
  }
  eq(all.filter((e) => e.type === "fire").length, 0, "frozen (stale) values never fire");
}

// ===========================================================================
// SAFEGUARDS (each gate in isolation)
// ===========================================================================

section("safeguard G2 — per-item cooldown");
{
  // Continuously satisfied. First fire ~2000ms; the cooldown then blocks a
  // refire until firstFire + CAPTURE_COOLDOWN_MS, so exactly 2 fires across a
  // window slightly longer than one cooldown.
  const det = new CaptureDetector(runnableFor(leanPlan(2, 1)));
  const horizon = 2000 + CAPTURE_COOLDOWN_MS + 4000;
  const ev = run(det, 0, horizon, () => ({ [RPMKEY]: 720, [FTKEY]: 16 }), 1000);
  const f = fires(ev);
  eq(f.length, 2, "cooldown limits a continuously-satisfied stream to 2 fires over ~1 cooldown");
  if (f.length === 2) {
    eq(f[0].window.trigger.firedAt, 2000, "first fire at ~sustained");
    ok(
      f[1].window.trigger.firedAt >= 2000 + CAPTURE_COOLDOWN_MS,
      `second fire only after cooldown (got ${f[1].window.trigger.firedAt})`,
    );
  }
}

section("safeguard G3 — per-session budget");
{
  // Six independent always-true items fire simultaneously; budget caps at 5.
  const sigs = Array.from({ length: 6 }, (_, i) =>
    mk(`SIG${i}`, "01", (0xa0 + i).toString(16).toUpperCase().padStart(2, "0")),
  );
  const items: RequestedDataItem[] = sigs.map((s) => ({
    signal_id: s.id,
    operating_condition: "x",
    duration_seconds: 1,
    capture_plan: {
      context_gate: [],
      measured_target: { signal_id: s.id, range: { min: null, max: null, unit: "" } },
      sustained_seconds: 0,
      capture_window_seconds: 1,
    },
  }));
  const resolved = resolvePlan(items, ctx({ catalog: sigs })).filter(
    (r): r is Extract<typeof r, { runnable: true }> => r.runnable,
  );
  eq(resolved.length, 6, "all six items runnable");
  const det = new CaptureDetector(resolved);

  const vals: Record<string, number> = {};
  for (const s of sigs) vals[`${s.code}@${s.id}`] = 50;
  const all: DetectorEvent[] = [];
  for (let t = 0; t <= 2000; t += 250) {
    for (const e of det.ingestTick(tk(t, vals))) all.push(e);
  }
  eq(all.filter((e) => e.type === "fire").length, SESSION_FIRE_BUDGET, "budget caps fires at 5");
  eq(all.filter((e) => e.type === "budget_exhausted").length, 1, "budget_exhausted emitted once");
  eq(det.getBudgetRemaining(), 0, "budget fully spent");
}

section("safeguard G4 — auto-pause on inactivity (fresh-read based)");
{
  const det = new CaptureDetector(runnableFor(leanPlan(2, 1)));
  const all: { t: number; ev: DetectorEvent }[] = [];
  const feed = (tickT: number, valueTs: number) => {
    const values: MonitorTick["values"] = {
      [RPMKEY]: { value: 720, name: "", unit: "", category: "", min: 0, max: 8000, timestamp: valueTs } as never,
      [FTKEY]: { value: 16, name: "", unit: "", category: "", min: 0, max: 100, timestamp: valueTs } as never,
    };
    for (const ev of det.ingestTick({ timestamp: tickT, values })) all.push({ t: tickT, ev });
  };
  // Active phase: fresh reads (value ts advances with tick).
  for (let t = 0; t <= 1000; t += 250) feed(t, t);
  ok(!det.isPaused(), "not paused while reads are fresh");
  // Stall: tick time advances but value timestamps frozen at 1000.
  for (let t = 1250; t <= 1000 + INACTIVITY_PAUSE_MS + 2000; t += 5000) feed(t, 1000);
  ok(det.isPaused(), "paused after INACTIVITY_PAUSE_MS with no fresh reads");
  ok(all.some((e) => e.ev.type === "paused"), "paused event emitted");
  // Resume: fresh reads return.
  const resumeT = 1000 + INACTIVITY_PAUSE_MS + 10000;
  feed(resumeT, resumeT);
  ok(!det.isPaused(), "resumes when fresh reads return");
  ok(all.some((e) => e.ev.type === "resumed"), "resumed event emitted");
}

section("safeguard G4 — steady-state capture is NOT paused (the flagged fix)");
{
  // Flat values but FRESH reads every tick (steady warm idle) for > pause window
  // → must remain active and still fire (sustained 2s, window 1s).
  const det = new CaptureDetector(runnableFor(leanPlan(2, 1)));
  const ev = run(det, 0, INACTIVITY_PAUSE_MS + 5000, () => ({ [RPMKEY]: 720, [FTKEY]: 16 }), 250);
  ok(!det.isPaused(), "steady-but-fresh stream stays active (no false pause)");
  ok(fires(ev).length >= 1, "steady-state condition still fires");
  eq(ev.filter((e) => e.ev.type === "paused").length, 0, "no pause on a steady fresh stream");
}

section("executor/cancel — in-flight capture aborts as cancelled");
{
  const det = new CaptureDetector(runnableFor(leanPlan(2, 5))); // long 5s window
  // Drive into the capturing state.
  run(det, 0, 2250, () => ({ [RPMKEY]: 720, [FTKEY]: 16 }));
  const cancelEvents = det.cancel({ timestamp: 2300, values: {} as MonitorTick["values"] });
  const f = cancelEvents.filter((e) => e.type === "fire") as Extract<DetectorEvent, { type: "fire" }>[];
  eq(f.length, 1, "cancel during capture emits one fire");
  if (f[0]) eq(f[0].window.outcome, "cancelled", "aborted capture outcome is cancelled");
}

// ===========================================================================
// EVIDENCE OBJECT (window -> EvidenceCaptureEntry)
// ===========================================================================

import { buildEvidenceEntry } from "./captureEvidence";

section("evidence — window maps onto EvidenceCaptureEntry");
{
  const det = new CaptureDetector(runnableFor(leanPlan(2, 1)));
  const ev = run(det, 0, 4000, () => ({ [RPMKEY]: 720, [FTKEY]: 16 }));
  const win = fires(ev)[0].window;

  const MAF = mk("MAF", "01", "10"); // a plan-adjacent descriptor absent from the window
  const entry = buildEvidenceEntry(win, {
    requested: [item(leanPlan(2, 1))],
    descriptors: [RPM, SHRTFT1, MAF],
    operatingCondition: "WARM_IDLE",
    dtcs: ["P0171"],
    pendingDtcs: [],
    permanentDtcs: [],
    freezeFrame: null,
    unavailableSignals: [{ signal_id: "EVAP_VP", reason: "no_match" }],
  });

  eq(entry.outcome, "completed", "entry outcome completed");
  eq(entry.operatingCondition, "WARM_IDLE", "operating condition carried");
  eq(entry.requested.length, 1, "requested item carried");
  ok(Array.isArray(entry.observed.signals), "observed is a DiagnosticSnapshot");
  const names = entry.observed.signals.map((s) => s.name);
  ok(names.includes("RPM") && names.includes("SHRTFT1"), "observed includes present plan signals");
  ok(entry.observed.absentSignalNames.includes("MAF"), "in-window-absent signal in absentSignalNames");
  eq(entry.observed.dtcs[0], "P0171", "dtcs carried into observed snapshot");

  // trigger context
  ok(!!entry.trigger, "trigger present");
  if (entry.trigger) {
    eq(entry.trigger.firedItemIndex, 0, "trigger.firedItemIndex");
    eq(entry.trigger.targetSignalId, "SHRTFT1", "trigger.targetSignalId");
    eq(entry.trigger.targetValueAtFire, 16, "trigger.targetValueAtFire");
    eq(entry.trigger.gateValuesAtFire.length, 1, "trigger has the gate value");
    eq(entry.trigger.gateValuesAtFire[0].signal_id, "RPM", "gate value signal");
    eq(entry.trigger.gateValuesAtFire[0].value, 720, "gate value at fire");
    ok(typeof entry.trigger.firedAt === "string", "firedAt is an ISO string");
  }

  // unavailableSignals distinct from absentSignalNames
  ok(
    !!entry.unavailableSignals && entry.unavailableSignals[0].signal_id === "EVAP_VP",
    "resolver-unavailable signals reported separately",
  );
}

section("evidence — cancelled window yields a cancelled entry");
{
  const det = new CaptureDetector(runnableFor(leanPlan(2, 5)));
  run(det, 0, 2250, () => ({ [RPMKEY]: 720, [FTKEY]: 16 }));
  const cancelEv = det.cancel({ timestamp: 2300, values: {} as MonitorTick["values"] });
  const win = (cancelEv.find((e) => e.type === "fire") as Extract<DetectorEvent, { type: "fire" }>).window;
  const entry = buildEvidenceEntry(win, {
    requested: [item(leanPlan(2, 5))],
    descriptors: [RPM, SHRTFT1],
    operatingCondition: "WARM_IDLE",
    dtcs: [],
    pendingDtcs: [],
    permanentDtcs: [],
    freezeFrame: null,
  });
  eq(entry.outcome, "cancelled", "cancelled capture -> cancelled entry");
  ok(entry.observed.signals.length >= 1, "partial window still summarized");
}

section("Fix 2 — WAITING per-condition readout (current vs target + met)");
{
  // Gate RPM in-range (720 ∈ 600-900 → met), target SHRTFT1 out-of-range
  // (2 < 10 → not met) → stays WAITING; the card carries the live readout.
  const det = new CaptureDetector(runnableFor(leanPlan(2, 1)));
  const ev = run(det, 0, 1000, () => ({ [RPMKEY]: 720, [FTKEY]: 2 }));
  const waiting = ev
    .map((e) => e.ev)
    .filter(
      (e): e is Extract<DetectorEvent, { type: "card" }> =>
        e.type === "card" && e.state === "waiting",
    );
  ok(waiting.length > 0, "a WAITING card is emitted");
  const conds = waiting[0]?.conditions ?? [];
  eq(conds.length, 2, "readout has both conditions (gate + target)");
  // Order: gates first, then the measured target.
  const rpm = conds.find((c) => c.label === "RPM");
  const ft = conds.find((c) => c.label === "SHRTFT1");
  ok(!!rpm && rpm.current === 720 && rpm.met === true, "gate RPM: current 720, met ✓");
  eq(rpm?.range.min, 600, "gate carries its target range (min 600)");
  ok(!!ft && ft.current === 2 && ft.met === false, "target SHRTFT1: current 2, NOT met");
  eq(ft?.range.min, 10, "target carries its range (>= 10)");
}

section("Fix 2 — readout refreshes as the value warms toward target");
{
  // SHRTFT1 climbs 2 → 6 → 9 (still < 10): each is a distinct readout, so the
  // coalesce-on-change lets the WAITING card update instead of being suppressed.
  const det = new CaptureDetector(runnableFor(leanPlan(2, 1)));
  const climb: Record<number, number> = { 0: 2, 250: 6, 500: 9 };
  const ev = run(det, 0, 500, (t) => ({ [RPMKEY]: 720, [FTKEY]: climb[t] ?? 9 }));
  const targetCurrents = ev
    .map((e) => e.ev)
    .filter(
      (e): e is Extract<DetectorEvent, { type: "card" }> =>
        e.type === "card" && e.state === "waiting",
    )
    .map((e) => e.conditions.find((c) => c.label === "SHRTFT1")?.current);
  // Distinct changing values appear across the waiting cards (not one frozen card).
  ok(
    targetCurrents.includes(2) && targetCurrents.includes(6) && targetCurrents.includes(9),
    `WAITING readout tracks the climbing value (saw ${JSON.stringify(targetCurrents)})`,
  );
}

// ===========================================================================
// MULTI-SIGNAL RECORD + ARM-ON-GATE (the warm-idle fix)
// ===========================================================================

section("multi-signal — open targets record-only, gate-only label (warm-idle fix)");
{
  // The exact warm-idle bug: the gate IS satisfiable (warm idle), and the
  // signals to record (MAF, SHRTFT1) carry OPEN ranges. A fault-band on the
  // target would never be met at a healthy idle; an open range must arm on the
  // GATE alone and record whatever the signals read.
  const MAF = mk("MAF", "01", "10", { unit: "g/s" });
  const MAFKEY = "01 10@MAF";
  const ECTKEY = "01 05@ECT";
  const SFTKEY = "01 06@SHRTFT1";
  const plan = {
    context_gate: [
      { signal_id: "RPM", range: { min: 600, max: 900, unit: "rpm" } },
      { signal_id: "ECT", range: { min: 70, max: null, unit: "degC" } },
    ],
    measured_target: { signal_id: "MAF", range: { min: null, max: null, unit: "g/s" } },
    measured_targets: [
      { signal_id: "MAF", range: { min: null, max: null, unit: "g/s" } },
      { signal_id: "SHRTFT1", range: { min: null, max: null, unit: "%" } },
    ],
    sustained_seconds: 2,
    capture_window_seconds: 1,
  };
  const runnable = resolvePlan([item(plan)], ctx({ catalog: [RPM, ECT, SHRTFT1, MAF] })).filter(
    (r): r is Extract<typeof r, { runnable: true }> => r.runnable,
  );
  eq(runnable.length, 1, "multi-target plan resolves runnable");
  if (runnable[0].runnable) eq(runnable[0].targets.length, 2, "two recorded targets");

  const det = new CaptureDetector(runnable);
  // Warm idle: RPM 720, ECT 85degC, MAF ~5 g/s (NOT 0-1), SHRTFT1 ~0% (NOT >=20).
  const ev = run(det, 0, 4000, () => ({ [RPMKEY]: 720, [ECTKEY]: 85, [MAFKEY]: 5, [SFTKEY]: 0 }));
  const f = fires(ev);
  eq(f.length, 1, "open-range targets DO NOT block the start — capture fires on the gate");

  const card = ev
    .map((e) => e.ev)
    .find((e): e is Extract<DetectorEvent, { type: "card" }> => e.type === "card");
  ok(!!card, "a card is emitted");
  if (card) {
    ok(
      !card.conditionLabel.includes("MAF") && !card.conditionLabel.includes("SHRTFT1"),
      `arming label is gate-only (got "${card.conditionLabel}")`,
    );
    ok(
      card.conditionLabel.includes("RPM") && card.conditionLabel.includes("ECT"),
      "arming label shows the gates",
    );
    ok(
      card.recordedSignalIds.includes("MAF") && card.recordedSignalIds.includes("SHRTFT1"),
      "recorded signals listed separately from the gate",
    );
    eq(card.conditions.length, 2, "readout shows only the 2 arming gates (open targets excluded)");
  }
  if (f[0])
    ok(
      f[0].window.signalKeys.includes(MAFKEY) && f[0].window.signalKeys.includes(SFTKEY),
      "captured window records both measured signals",
    );
}

section("multi-signal — open target absent still arms (presence not required)");
{
  const MAF = mk("MAF", "01", "10", { unit: "g/s" });
  const plan = {
    context_gate: [{ signal_id: "RPM", range: { min: 600, max: 900, unit: "rpm" } }],
    measured_target: { signal_id: "MAF", range: { min: null, max: null, unit: "g/s" } },
    sustained_seconds: 2,
    capture_window_seconds: 1,
  };
  const runnable = resolvePlan([item(plan)], ctx({ catalog: [RPM, MAF] })).filter(
    (r): r is Extract<typeof r, { runnable: true }> => r.runnable,
  );
  const det = new CaptureDetector(runnable);
  // RPM in band; MAF NEVER reported (absent). An open record-only target must
  // not require presence to arm — the capture still fires on the gate.
  const ev = run(det, 0, 4000, () => ({ [RPMKEY]: 720 }));
  eq(fires(ev).length, 1, "open record-only target absent → still arms+fires on the gate");
}

section("multi-signal — a BOUNDED measured target still gates (wait-for-event preserved)");
{
  const plan = {
    context_gate: [{ signal_id: "RPM", range: { min: 600, max: 900, unit: "rpm" } }],
    measured_target: { signal_id: "SHRTFT1", range: { min: 10, max: null, unit: "%" } },
    measured_targets: [{ signal_id: "SHRTFT1", range: { min: 10, max: null, unit: "%" } }],
    sustained_seconds: 2,
    capture_window_seconds: 1,
  };
  const runnable = resolvePlan([item(plan)], ctx({ catalog: [RPM, SHRTFT1] })).filter(
    (r): r is Extract<typeof r, { runnable: true }> => r.runnable,
  );
  // SHRTFT1 stays at 2 (< 10) with the gate satisfied → a bounded target must
  // still block the capture (it is a deliberate wait condition).
  const det = new CaptureDetector(runnable);
  eq(fires(run(det, 0, 4000, () => ({ [RPMKEY]: 720, [FTKEY]: 2 }))).length, 0,
    "bounded target out of band blocks the capture");
  // Enters the band → arms + fires, and shows in the arming label.
  const det2 = new CaptureDetector(runnable);
  const above = run(det2, 0, 4000, () => ({ [RPMKEY]: 720, [FTKEY]: 16 }));
  eq(fires(above).length, 1, "bounded target in band → capture fires");
  const card = above
    .map((e) => e.ev)
    .find((e): e is Extract<DetectorEvent, { type: "card" }> => e.type === "card");
  if (card)
    ok(
      card.conditionLabel.includes("SHRTFT1"),
      "a bounded target IS shown in the arming label (it's a wait condition)",
    );
}

// ===========================================================================
// FRESHNESS — cycle-delayed vs. genuinely stale (the 2026-06-29 capture fix)
// ===========================================================================

section("freshness — fresh-but-cycle-delayed gate value still arms (the fix)");
{
  // The on-vehicle bug: gate signals (RPM/ECT) are polled EARLY in a poll cycle
  // and ARE refreshed every cycle, but a slow sibling PID (a Mode-22 misfire
  // counter timing out ~2.5s) pushes the cycle-end tick.timestamp far past the
  // gate values' arrival time. The OLD age-vs-tick.timestamp guard wrongly
  // flagged those fresh reads stale → readValue null → "—" → permanent WAITING.
  //
  // Here every value ADVANCES each tick but lags tick.timestamp by LAG=2000ms
  // (> STALE_VALUE_MS=600). OLD code: age 2000 > 600 → stale → never fires (the
  // bug). NEW code: advance-tracked as fresh → arms + fires.
  const LAG = 2000;
  const det = new CaptureDetector(runnableFor(leanPlan(2, 1)));
  const all: { t: number; ev: DetectorEvent }[] = [];
  for (let t = 0; t <= 4000; t += 250) {
    const values: MonitorTick["values"] = {
      [RPMKEY]: { value: 720, name: "", unit: "", category: "", min: 0, max: 8000, timestamp: t - LAG } as never,
      [FTKEY]: { value: 16, name: "", unit: "", category: "", min: 0, max: 100, timestamp: t - LAG } as never,
    };
    for (const ev of det.ingestTick({ timestamp: t, values })) all.push({ t, ev });
  }
  // The gate must read its live value (not "—") while waiting/capturing.
  const card = all
    .map((e) => e.ev)
    .find((e): e is Extract<DetectorEvent, { type: "card" }> => e.type === "card");
  const rpmReadout = card?.conditions.find((c) => c.label === "RPM");
  ok(
    !!rpmReadout && rpmReadout.current === 720 && rpmReadout.met === true,
    `cycle-delayed gate reads its live value, not "—" (got ${JSON.stringify(rpmReadout)})`,
  );
  eq(firstCapturingAt(all), 2000, "cycle-delayed-but-advancing gate arms at sustained_seconds");
  eq(fires(all).length, 1, "a fresh-but-cycle-delayed stream FIRES (old code would stall in WAITING)");
}

section("freshness — genuinely stale (non-advancing) value still rejected + blocks arming");
{
  // The safety contract MUST hold: a value whose timestamp NEVER advances (sensor
  // dropped / PID stopped answering) is genuinely stale → rejected → the gate is
  // blocked and nothing arms, no matter how long it sits in-band.
  const det = new CaptureDetector(runnableFor(leanPlan(2, 1)));
  const frozen: MonitorTick["values"] = {
    [RPMKEY]: { value: 720, name: "", unit: "", category: "", min: 0, max: 8000, timestamp: 0 } as never,
    [FTKEY]: { value: 16, name: "", unit: "", category: "", min: 0, max: 100, timestamp: 0 } as never,
  };
  const all: { t: number; ev: DetectorEvent }[] = [];
  for (let t = 0; t <= 6000; t += 250) {
    for (const ev of det.ingestTick({ timestamp: t, values: frozen })) all.push({ t, ev });
  }
  eq(fires(all).length, 0, "genuinely stale (frozen) value never fires");
  eq(firstCapturingAt(all), null, "genuinely stale value never begins a capture (gate blocked)");
  const rpmReadouts = all
    .map((e) => e.ev)
    .filter((e): e is Extract<DetectorEvent, { type: "card" }> => e.type === "card")
    .map((c) => c.conditions.find((cc) => cc.label === "RPM")?.current);
  ok(rpmReadouts.includes(null), 'stale gate eventually reads "—" (null) — proving rejection still works');
}

// ===========================================================================
// SUMMARY
// ===========================================================================

console.log(`\n${"=".repeat(48)}`);
if (failed === 0) {
  console.log(`[capture-test] ALL ${passed} PASSED`);
} else {
  console.log(`[capture-test] ${failed} FAILED, ${passed} passed`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
