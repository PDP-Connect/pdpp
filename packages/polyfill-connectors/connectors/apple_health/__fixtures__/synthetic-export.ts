// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Generates a realistic, multi-year, multi-source synthetic export.xml —
 * used to FORMAT-CONFORMANCE-prove the connector against the real Apple
 * Health XML shape (see ai/research/apple-health-export-format/ for the
 * format research this is built from). This is NOT live proof: it proves
 * the parser handles the documented/observed shape, not that a real
 * iPhone export matches it exactly (Apple has never published a schema).
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface SyntheticExportStats {
  categoryRecords: number;
  quantityRecords: number;
  totalRecordElements: number;
  unknownTypeRecords: number;
  workoutsTotal: number;
  workoutsWithEvents: number;
  workoutsWithStatistics: number;
  zeroDurationWorkouts: number;
}

const SOURCES = [
  {
    name: "iPhone",
    version: "17.5",
    device: "<<HKDevice: 0x1>, name:iPhone, manufacturer:Apple, model:iPhone, hardware:iPhone16,2, software:17.5>",
  },
  {
    name: "Tim’s Apple Watch",
    version: "10.5",
    device: "<<HKDevice: 0x2>, name:Apple Watch, manufacturer:Apple, model:Watch, hardware:Watch7,1, software:10.5>",
  },
  { name: "Nike Run Club", version: "6.2", device: null },
];

function fmtDate(d: Date): string {
  // Apple Health format: "YYYY-MM-DD HH:mm:ss ±HHMM"
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const offH = pad(Math.floor(Math.abs(off) / 60));
  const offM = pad(Math.abs(off) % 60);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${sign}${offH}${offM}`
  );
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Picks a uniformly-random element from a known-non-empty array. `noUncheckedIndexedAccess` can't see the array is non-empty, so this centralizes the one assertion instead of repeating `?? arr[0]` at every call site. */
function pickRandom<T>(arr: readonly T[], rnd: () => number): T {
  const item = arr[Math.floor(rnd() * arr.length)];
  if (item === undefined) {
    throw new Error("pickRandom: array must be non-empty");
  }
  return item;
}

const QUANTITY_TYPES: { type: string; unit: string; range: [number, number] }[] = [
  { type: "HKQuantityTypeIdentifierStepCount", unit: "count", range: [1, 500] },
  { type: "HKQuantityTypeIdentifierHeartRate", unit: "count/min", range: [45, 180] },
  { type: "HKQuantityTypeIdentifierRestingHeartRate", unit: "count/min", range: [45, 70] },
  { type: "HKQuantityTypeIdentifierWalkingHeartRateAverage", unit: "count/min", range: [70, 120] },
  { type: "HKQuantityTypeIdentifierHeartRateVariabilitySDNN", unit: "ms", range: [20, 90] },
  { type: "HKQuantityTypeIdentifierActiveEnergyBurned", unit: "kcal", range: [1, 40] },
  { type: "HKQuantityTypeIdentifierBasalEnergyBurned", unit: "kcal", range: [30, 90] },
  { type: "HKQuantityTypeIdentifierDistanceWalkingRunning", unit: "km", range: [0.01, 2] },
  { type: "HKQuantityTypeIdentifierBodyMass", unit: "kg", range: [60, 95] },
  { type: "HKQuantityTypeIdentifierOxygenSaturation", unit: "%", range: [0.94, 0.99] },
  { type: "HKQuantityTypeIdentifierRespiratoryRate", unit: "count/min", range: [12, 20] },
  { type: "HKQuantityTypeIdentifierVO2Max", unit: "mL/min·kg", range: [30, 55] },
];

const CATEGORY_TYPES: { type: string; values: string[] }[] = [
  {
    type: "HKCategoryTypeIdentifierSleepAnalysis",
    values: [
      "HKCategoryValueSleepAnalysisAsleepCore",
      "HKCategoryValueSleepAnalysisAsleepDeep",
      "HKCategoryValueSleepAnalysisAsleepREM",
      "HKCategoryValueSleepAnalysisAwake",
    ],
  },
  { type: "HKCategoryTypeIdentifierMindfulSession", values: ["HKCategoryValueNotApplicable"] },
];

// Deterministic PRNG so the same recordCount always produces the same
// export.xml (reproducible ground-truth assertions), without bitwise ops
// (banned by this repo's lint config). A numerically-computed LCG (Park–
// Miller "minimal standard" generator) suffices for synthetic-fixture
// randomness — no cryptographic properties are needed here.
function deterministicRandom(seed: number): () => number {
  let state = seed % 2_147_483_647;
  if (state <= 0) {
    state += 2_147_483_646;
  }
  return () => {
    state = (state * 16_807) % 2_147_483_647;
    return (state - 1) / 2_147_483_646;
  };
}

/** The earliest year the generator places records in — `new Date().getFullYear() - 3`, exported so proof tests can compute expected timestamps without duplicating this arithmetic. */
export function syntheticExportStartYear(): number {
  return new Date().getFullYear() - 3;
}

/** Generates the ordinary quantity/category Record lines. Returns their XML lines and per-kind counts. */
function buildRecordLines(
  recordCount: number,
  startYear: number,
  rnd: () => number
): { categoryRecords: number; lines: string[]; quantityRecords: number } {
  const lines: string[] = [];
  let quantityRecords = 0;
  let categoryRecords = 0;

  for (let i = 0; i < recordCount; i += 1) {
    const src = pickRandom(SOURCES, rnd);
    const year = startYear + Math.floor(rnd() * 4);
    const d = new Date(
      year,
      Math.floor(rnd() * 12),
      1 + Math.floor(rnd() * 27),
      Math.floor(rnd() * 24),
      Math.floor(rnd() * 60)
    );
    const end = new Date(d.getTime() + 60_000);
    if (rnd() < 0.15) {
      const cat = pickRandom(CATEGORY_TYPES, rnd);
      const val = pickRandom(cat.values, rnd);
      const sleepEnd = new Date(d.getTime() + (cat.type.includes("Sleep") ? 3 * 3_600_000 : 600_000));
      lines.push(
        `<Record type="${cat.type}" sourceName="${esc(src.name)}" sourceVersion="${src.version}" ` +
          `startDate="${fmtDate(d)}" endDate="${fmtDate(sleepEnd)}" value="${val}">` +
          `<MetadataEntry key="HKWasUserEntered" value="0"/>` +
          "</Record>"
      );
      categoryRecords += 1;
      continue;
    }
    const q = pickRandom(QUANTITY_TYPES, rnd);
    const value = (q.range[0] + rnd() * (q.range[1] - q.range[0])).toFixed(2);
    const deviceAttr = src.device ? ` device="${esc(src.device)}"` : "";
    lines.push(
      `<Record type="${q.type}" sourceName="${esc(src.name)}" sourceVersion="${src.version}"${deviceAttr} ` +
        `unit="${q.unit}" startDate="${fmtDate(d)}" endDate="${fmtDate(end)}" value="${value}"/>`
    );
    quantityRecords += 1;
  }

  return { lines, quantityRecords, categoryRecords };
}

/** Fixed honesty-gate edge-case Record lines: missing unit, unrecognized type, missing startDate, a DST boundary. */
function buildEdgeCaseRecordLines(startYear: number): string[] {
  const lines: string[] = [];
  // 1. Missing unit (still valid — unit is optional per the DTD).
  lines.push(
    `<Record type="HKQuantityTypeIdentifierStepCount" sourceName="iPhone" startDate="${fmtDate(
      new Date(startYear, 0, 1)
    )}" endDate="${fmtDate(new Date(startYear, 0, 1))}" value="12"/>`
  );
  // 2. Unrecognized/future record type (a genuinely new HK*TypeIdentifier
  // prefix, not one of the four this connector already knows) — must tally
  // as a gap, not crash or vanish.
  lines.push(
    `<Record type="HKBiomarkerTypeIdentifierFutureBiomarkerNotYetInvented" sourceName="iPhone" unit="index" ` +
      `startDate="${fmtDate(new Date(startYear, 0, 2))}" endDate="${fmtDate(new Date(startYear, 0, 2))}" value="1"/>`
  );
  // 3. Malformed entry: missing startDate entirely — must be counted as a gap, not silently vanish.
  lines.push(`<Record type="HKQuantityTypeIdentifierStepCount" sourceName="iPhone" value="5"/>`);
  // 4. DST boundary: US spring-forward 2am->3am on the synthetic year's March DST date.
  const dstYear = startYear + 1;
  lines.push(
    `<Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Apple Watch" unit="count/min" ` +
      `startDate="${dstYear}-03-09 01:59:00 -0800" endDate="${dstYear}-03-09 03:01:00 -0700" value="88"/>`
  );
  return lines;
}

const WORKOUT_TYPES = ["HKWorkoutActivityTypeRunning", "HKWorkoutActivityTypeWalking", "HKWorkoutActivityTypeCycling"];

/** Builds one Workout element's XML, given whether it should carry MetadataEntry/WorkoutEvent/WorkoutStatistics children. */
function buildWorkoutLine(
  d: Date,
  durationMin: number,
  wType: string,
  src: (typeof SOURCES)[number],
  shape: { hasChildren: boolean; hasEvents: boolean; hasStats: boolean }
): string {
  const end = new Date(d.getTime() + durationMin * 60_000);
  if (!shape.hasChildren) {
    return (
      `<Workout workoutActivityType="${wType}" duration="${durationMin.toFixed(2)}" durationUnit="min" ` +
      `sourceName="${esc(src.name)}" sourceVersion="${src.version}" startDate="${fmtDate(d)}" endDate="${fmtDate(end)}"/>`
    );
  }
  const deviceAttr = src.device ? ` device="${esc(src.device)}"` : "";
  const eventsXml = shape.hasEvents
    ? `<WorkoutEvent type="HKWorkoutEventTypePause" date="${fmtDate(new Date(d.getTime() + 5 * 60_000))}"/>` +
      `<WorkoutEvent type="HKWorkoutEventTypeResume" date="${fmtDate(new Date(d.getTime() + 6 * 60_000))}"/>`
    : "";
  const statsXml = shape.hasStats
    ? `<WorkoutStatistics type="HKQuantityTypeIdentifierHeartRate" average="142" minimum="98" maximum="171" unit="count/min"/>`
    : "";
  return (
    `<Workout workoutActivityType="${wType}" duration="${durationMin.toFixed(2)}" durationUnit="min" ` +
    `totalDistance="${(durationMin / 6).toFixed(2)}" totalDistanceUnit="km" ` +
    `totalEnergyBurned="${(durationMin * 8).toFixed(1)}" totalEnergyBurnedUnit="kcal" ` +
    `sourceName="${esc(src.name)}" sourceVersion="${src.version}"${deviceAttr} startDate="${fmtDate(d)}" endDate="${fmtDate(end)}">` +
    `<MetadataEntry key="HKIndoorWorkout" value="0"/>` +
    `<MetadataEntry key="HKWeatherTemperature" value="58.0 degF"/>` +
    eventsXml +
    statsXml +
    "</Workout>"
  );
}

/** Generates the Workout elements: mostly self-closing, some with events/statistics/metadata, one zero-duration. */
function buildWorkoutSection(
  workoutCount: number,
  startYear: number,
  rnd: () => number
): { lines: string[]; workoutsWithEvents: number; workoutsWithStatistics: number; zeroDurationWorkouts: number } {
  const lines: string[] = [];
  let workoutsWithEvents = 0;
  let workoutsWithStatistics = 0;
  let zeroDurationWorkouts = 0;

  for (let i = 0; i < workoutCount; i += 1) {
    const src = pickRandom(SOURCES, rnd);
    const year = startYear + Math.floor(rnd() * 4);
    const d = new Date(year, Math.floor(rnd() * 12), 1 + Math.floor(rnd() * 27), Math.floor(rnd() * 24), 0);
    const isZeroDuration = i === 0;
    const durationMin = isZeroDuration ? 0 : 15 + rnd() * 60;
    if (isZeroDuration) {
      zeroDurationWorkouts += 1;
    }
    const wType = pickRandom(WORKOUT_TYPES, rnd);
    const hasChildren = i % 3 !== 0;
    const hasEvents = hasChildren && i % 2 === 0;
    const hasStats = hasChildren && i % 5 === 0;
    if (hasEvents) {
      workoutsWithEvents += 1;
    }
    if (hasStats) {
      workoutsWithStatistics += 1;
    }
    lines.push(buildWorkoutLine(d, durationMin, wType, src, { hasChildren, hasEvents, hasStats }));
  }

  return { lines, workoutsWithEvents, workoutsWithStatistics, zeroDurationWorkouts };
}

/**
 * Builds export.xml text plus the "ground truth" counts a proof test can
 * assert against. `recordCount` approximates the number of `<Record>`
 * elements generated (quantity + category, excluding deliberately
 * malformed/edge-case rows, which are added on top).
 */
export function buildSyntheticExportXml(recordCount: number): { stats: SyntheticExportStats; xml: string } {
  const rnd = deterministicRandom(20_260_901);
  const startYear = syntheticExportStartYear();
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(`<HealthData locale="en_US">`);
  lines.push(`<ExportDate value="${fmtDate(new Date())}"/>`);
  lines.push(
    `<Me HKCharacteristicTypeIdentifierDateOfBirth="1990-01-01" HKCharacteristicTypeIdentifierBiologicalSex="HKBiologicalSexNotSet" HKCharacteristicTypeIdentifierBloodType="HKBloodTypeNotSet" HKCharacteristicTypeIdentifierFitzpatrickSkinType="HKFitzpatrickSkinTypeNotSet"/>`
  );

  const { lines: recordLines, quantityRecords, categoryRecords } = buildRecordLines(recordCount, startYear, rnd);
  lines.push(...recordLines);
  lines.push(...buildEdgeCaseRecordLines(startYear));

  const workoutCount = Math.max(20, Math.floor(recordCount / 200));
  const {
    lines: workoutLines,
    workoutsWithEvents,
    workoutsWithStatistics,
    zeroDurationWorkouts,
  } = buildWorkoutSection(workoutCount, startYear, rnd);
  lines.push(...workoutLines);

  lines.push("</HealthData>");

  return {
    xml: lines.join("\n"),
    stats: {
      quantityRecords,
      categoryRecords,
      totalRecordElements: quantityRecords + categoryRecords + 4, // + the 4 edge-case rows
      unknownTypeRecords: 1,
      workoutsTotal: workoutCount,
      workoutsWithEvents,
      workoutsWithStatistics,
      zeroDurationWorkouts,
    },
  };
}

/** Write a synthetic export.xml into a fresh temp dir shaped like APPLE_HEALTH_EXPORT_DIR expects. */
export function buildSyntheticExportDir(recordCount: number): { dir: string; stats: SyntheticExportStats } {
  const dir = mkdtempSync(join(tmpdir(), "apple-health-synthetic-"));
  const { xml, stats } = buildSyntheticExportXml(recordCount);
  writeFileSync(join(dir, "export.xml"), xml, "utf8");
  return { dir, stats };
}
