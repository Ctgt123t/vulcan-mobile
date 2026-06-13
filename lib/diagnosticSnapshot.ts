// ============================================================================
// Snapshot builder — transforms the Obd2Manager ring buffer into a serializable
// DiagnosticSnapshot. Runs entirely on the device; produces objective facts only.
//
// Critical discipline: this module must NOT interpret the data. It averages,
// ranges, and labels — it does not infer "lean condition" or "misfiring."
// Judgment is Claude's job. Phone-side interpretation would feed Claude bad
// premises and defeat the purpose of having a reasoning engine.
// ============================================================================

import type { FreezeFrame, PidDescriptor, RingBufferEntry } from "./obd2";
import type { DiagnosticSnapshot, OperatingCondition, SnapshotSignal } from "./assessmentTypes";

// Globally-unique signal key, identical to obd2.signalKeyOf. Inlined (not
// imported as a value) so this module stays pure — a value import from ./obd2
// pulls in the React Native transport stack and breaks node test runs
// (captureDetector.test.ts exercises buildDiagnosticSnapshot via the 2C-2
// evidence builder). Same type-only discipline as diagnosticCasesCore.ts.
function signalKeyOf(s: { code: string; id: string }): string {
  return `${s.code}@${s.id}`;
}

export function buildDiagnosticSnapshot(
  ringBuffer: RingBufferEntry[],
  descriptors: PidDescriptor[],
  operatingCondition: OperatingCondition,
  dtcs: string[],
  pendingDtcs: string[],
  permanentDtcs: string[],
  freezeFrame: FreezeFrame | null,
): DiagnosticSnapshot {
  const now = Date.now();

  // Compute the actual time span covered by the provided entries.
  const durationMs =
    ringBuffer.length > 1
      ? ringBuffer[ringBuffer.length - 1].timestamp - ringBuffer[0].timestamp
      : ringBuffer.length === 1
        ? 0
        : 0;

  const signals: SnapshotSignal[] = [];
  const absentSignalNames: string[] = [];

  for (const descriptor of descriptors) {
    const key = descriptor.signalKey ?? signalKeyOf(descriptor);
    const samples: number[] = [];

    for (const entry of ringBuffer) {
      const lv = entry.values[key];
      if (lv && lv.value != null) {
        samples.push(lv.value);
      }
    }

    if (samples.length === 0) {
      absentSignalNames.push(descriptor.name);
      continue;
    }

    let sum = 0;
    let min = samples[0];
    let max = samples[0];
    for (const v of samples) {
      sum += v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const avg = sum / samples.length;

    signals.push({
      name: descriptor.name,
      signalId: descriptor.id,
      averageValue: round3(avg),
      minSample: round3(min),
      maxSample: round3(max),
      unit: descriptor.unit,
      encodingMin: descriptor.min,
      encodingMax: descriptor.max,
      category: descriptor.category,
      sampleCount: samples.length,
    });
  }

  return {
    capturedAt: now,
    durationMs,
    operatingCondition,
    signals,
    absentSignalNames,
    dtcs: [...dtcs],
    pendingDtcs: [...pendingDtcs],
    permanentDtcs: [...permanentDtcs],
    freezeFrame: freezeFrame
      ? {
          dtc: freezeFrame.dtc,
          rpm: freezeFrame.rpm,
          speedKph: freezeFrame.speedKph,
          coolantC: freezeFrame.coolantC,
          fuelPressure: freezeFrame.fuelPressure,
        }
      : null,
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
