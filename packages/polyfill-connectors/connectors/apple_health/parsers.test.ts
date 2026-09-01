// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CATEGORY_RECORD,
  HEART_RATE_RECORD,
  NO_START_DATE_RECORD,
  NON_NUMERIC_VALUE_RECORD,
  STEP_COUNT_RECORD,
  UNKNOWN_TYPE_RECORD,
} from "./__fixtures__/record-step-count.ts";
import { BAD_DATE_WORKOUT, RUN_WORKOUT, WALK_WORKOUT_MIN } from "./__fixtures__/workout-run.ts";
import {
  APPLE_HEALTH_TAG_RE,
  advanceCursor,
  buildHealthRecord,
  buildWorkoutEvent,
  buildWorkoutRecord,
  hashId,
  healthTypeShort,
  isBeforeCursor,
  isoDate,
  newGapCounts,
  parseAttrs,
} from "./parsers.ts";
import type { AppleHealthAttrs, AppleHealthElement } from "./types.ts";

// Test-only helper: wraps raw attrs the way index.ts's streaming scanner
// would, so table-driven fixture tests can call buildHealthRecord/
// buildWorkoutRecord exactly as production does (element + children, not
// bare attrs).
function el(
  tag: "Record" | "Workout",
  attrs: AppleHealthAttrs,
  overrides: Partial<AppleHealthElement> = {}
): AppleHealthElement {
  return { tag, attrs, metadata: [], workoutEvents: [], workoutStatistics: [], ...overrides };
}

// ─── parseAttrs ─────────────────────────────────────────────────────────

test('parseAttrs: extracts key="value" pairs', () => {
  const attrs = parseAttrs('type="HKStep" value="42" sourceName="iPhone"');
  assert.deepEqual(attrs, {
    type: "HKStep",
    value: "42",
    sourceName: "iPhone",
  });
});

test("parseAttrs: empty string → empty object", () => {
  assert.deepEqual(parseAttrs(""), {});
});

test("parseAttrs: handles attributes with spaces in value", () => {
  const attrs = parseAttrs('sourceName="Apple Watch" unit="count/min"');
  assert.equal(attrs.sourceName, "Apple Watch");
  assert.equal(attrs.unit, "count/min");
});

// A real Apple Watch export XML-escapes `<`/`>`/`&` in attribute values
// (e.g. a device string embedding a Swift description, or a URL with `&`
// between query params). A prior version returned the escaped text
// unchanged — this dropped no characters and threw no error, so it was
// invisible to every test that only fed pre-escaped literal strings like
// "Apple Watch" straight through. Live-proof against real Withings/Apple
// export files caught it.
test("parseAttrs: decodes XML entities in attribute values (real device-string / URL shape)", () => {
  const attrs = parseAttrs(
    'device="&lt;&lt;HKDevice: 0x1&gt;, name:Apple Watch&gt;" link="a?x=1&amp;y=2" quote="&quot;hi&quot;" apos="&apos;lo&apos;" code="&#65;&#x42;"'
  );
  assert.equal(attrs.device, "<<HKDevice: 0x1>, name:Apple Watch>");
  assert.equal(attrs.link, "a?x=1&y=2");
  assert.equal(attrs.quote, '"hi"');
  assert.equal(attrs.apos, "'lo'");
  assert.equal(attrs.code, "AB");
});

// ─── APPLE_HEALTH_TAG_RE (against real serialized XML, not just parsed attrs) ──
//
// The fixtures above feed already-parsed AppleHealthAttrs objects straight to
// buildHealthRecord/buildWorkoutRecord — they never prove that
// APPLE_HEALTH_TAG_RE actually matches those attributes as XML text. A prior
// version of this regex used `[^/>]+` for the attribute span, which silently
// failed to match — and therefore silently dropped — any Record whose
// attribute VALUE contained a literal `/`, e.g. `unit="count/min"` on every
// HeartRate record. These tests scan real XML strings end-to-end so that
// regression cannot recur unnoticed.

function scanTags(xml: string): string[] {
  const re = new RegExp(APPLE_HEALTH_TAG_RE.source, "g");
  const out: string[] = [];
  let m: RegExpExecArray | null = re.exec(xml);
  while (m !== null) {
    out.push(m[1] ?? `/${m[4]}`);
    m = re.exec(xml);
  }
  return out;
}

test("APPLE_HEALTH_TAG_RE: matches a Record whose unit attribute contains a slash (count/min)", () => {
  const xml =
    '<Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Apple Watch" unit="count/min" startDate="2024-06-05 13:45:22 -0700" endDate="2024-06-05 13:45:23 -0700" value="72"/>';
  assert.deepEqual(scanTags(xml), ["Record"]);
});

test("APPLE_HEALTH_TAG_RE: matches a Record whose unit contains a slash and middle-dot (mL/min·kg, VO2max)", () => {
  const xml =
    '<Record type="HKQuantityTypeIdentifierVO2Max" sourceName="Apple Watch" unit="mL/min·kg" startDate="2024-06-05 13:45:22 -0700" endDate="2024-06-05 13:45:22 -0700" value="45.2"/>';
  assert.deepEqual(scanTags(xml), ["Record"]);
});

test("APPLE_HEALTH_TAG_RE: walks a non-self-closing Workout with MetadataEntry/WorkoutEvent/WorkoutStatistics children in order", () => {
  const xml =
    '<Workout workoutActivityType="HKWorkoutActivityTypeRunning" sourceName="Apple Watch" startDate="2024-06-05 06:30:00 -0700" endDate="2024-06-05 07:02:30 -0700">' +
    '<MetadataEntry key="HKAverageMETs" value="9.75 kcal/hr·kg"/>' +
    '<WorkoutEvent type="HKWorkoutEventTypePause" date="2024-06-05 06:40:00 -0700"/>' +
    '<WorkoutStatistics type="HKQuantityTypeIdentifierHeartRate" average="142" unit="count/min"/>' +
    "</Workout>";
  assert.deepEqual(scanTags(xml), ["Workout", "MetadataEntry", "WorkoutEvent", "WorkoutStatistics", "/Workout"]);
});

test("APPLE_HEALTH_TAG_RE: WorkoutStatistics is not shadowed by the shorter Workout alternative", () => {
  const xml = '<WorkoutStatistics type="HKQuantityTypeIdentifierHeartRate" average="120" unit="count/min"/>';
  assert.deepEqual(scanTags(xml), ["WorkoutStatistics"]);
});

// ─── healthTypeShort ────────────────────────────────────────────────────

test("healthTypeShort: strips HKQuantityTypeIdentifier prefix", () => {
  assert.equal(healthTypeShort("HKQuantityTypeIdentifierStepCount"), "StepCount");
});

test("healthTypeShort: strips HKCategoryTypeIdentifier prefix", () => {
  assert.equal(healthTypeShort("HKCategoryTypeIdentifierSleepAnalysis"), "SleepAnalysis");
});

test("healthTypeShort: strips HKDataType prefix", () => {
  assert.equal(healthTypeShort("HKDataTypeSleepDurationGoal"), "SleepDurationGoal");
});

test("healthTypeShort: undefined → null", () => {
  assert.equal(healthTypeShort(undefined), null);
});

test("healthTypeShort: unknown prefix passes through", () => {
  assert.equal(healthTypeShort("CustomType"), "CustomType");
});

// ─── isoDate ────────────────────────────────────────────────────────────

test("isoDate: parses Apple Health timestamp with offset", () => {
  // '2024-06-05 13:45:22 -0700' → 2024-06-05T20:45:22.000Z
  assert.equal(isoDate("2024-06-05 13:45:22 -0700"), "2024-06-05T20:45:22.000Z");
});

test("isoDate: undefined → null", () => {
  assert.equal(isoDate(undefined), null);
});

test("isoDate: garbage string → null", () => {
  assert.equal(isoDate("not-a-date"), null);
});

// ─── hashId ─────────────────────────────────────────────────────────────

test("hashId: deterministic 24-char hex output", () => {
  const id = hashId("a|b|c");
  assert.match(id, /^[0-9a-f]{24}$/);
  assert.equal(id, hashId("a|b|c"));
});

test("hashId: differs for different inputs", () => {
  assert.notEqual(hashId("a"), hashId("b"));
});

// ─── buildHealthRecord ──────────────────────────────────────────────────

test("buildHealthRecord: step count → fully populated record", () => {
  const rec = buildHealthRecord(el("Record", STEP_COUNT_RECORD), newGapCounts());
  assert.ok(rec, "expected a record");
  assert.equal(rec.type, "StepCount");
  assert.equal(rec.source_name, "iPhone");
  assert.equal(rec.source_version, "17.5");
  assert.match(rec.device ?? "", /iPhone16,2/);
  assert.equal(rec.creation_date, "2024-06-05T20:45:22.000Z");
  assert.equal(rec.unit, "count");
  assert.equal(rec.value, 42);
  assert.equal(rec.value_raw, null);
  assert.equal(rec.start_date, "2024-06-05T20:45:22.000Z");
  assert.equal(rec.end_date, "2024-06-05T20:50:10.000Z");
  assert.match(rec.id, /^[0-9a-f]{24}$/);
});

test("buildHealthRecord: heart rate carries numeric value (unit contains a slash)", () => {
  const rec = buildHealthRecord(el("Record", HEART_RATE_RECORD), newGapCounts());
  assert.ok(rec);
  assert.equal(rec.type, "HeartRate");
  assert.equal(rec.value, 72);
  assert.equal(rec.unit, "count/min");
});

test("buildHealthRecord: category record stores string in value_raw, null in value", () => {
  const rec = buildHealthRecord(el("Record", CATEGORY_RECORD), newGapCounts());
  assert.ok(rec);
  assert.equal(rec.type, "SleepAnalysis");
  assert.equal(rec.value, null);
  assert.equal(rec.value_raw, "HKCategoryValueSleepAnalysisAsleepCore");
});

test("buildHealthRecord: non-numeric value record → value_raw route", () => {
  const rec = buildHealthRecord(el("Record", NON_NUMERIC_VALUE_RECORD), newGapCounts());
  assert.ok(rec);
  assert.equal(rec.value, null);
  assert.equal(rec.value_raw, "HKCategoryValueSleepAnalysisAsleepCore");
});

test("buildHealthRecord: missing startDate → null (skip), tallied as a gap not silently dropped", () => {
  const gaps = newGapCounts();
  assert.equal(buildHealthRecord(el("Record", NO_START_DATE_RECORD), gaps), null);
  assert.equal(gaps.recordsMissingStartDate, 1);
});

test("buildHealthRecord: same key fields → same id (dedup stability)", () => {
  const a = buildHealthRecord(el("Record", STEP_COUNT_RECORD), newGapCounts());
  const b = buildHealthRecord(el("Record", STEP_COUNT_RECORD), newGapCounts());
  assert.ok(a && b);
  assert.equal(a.id, b.id);
});

test("buildHealthRecord: nested MetadataEntry children become a metadata map", () => {
  const rec = buildHealthRecord(
    el("Record", STEP_COUNT_RECORD, { metadata: [{ key: "HKWasUserEntered", value: "1" }] }),
    newGapCounts()
  );
  assert.ok(rec);
  assert.deepEqual(rec.metadata, { HKWasUserEntered: "1" });
});

test("buildHealthRecord: no metadata children → metadata is null, not an empty object", () => {
  const rec = buildHealthRecord(el("Record", STEP_COUNT_RECORD), newGapCounts());
  assert.ok(rec);
  assert.equal(rec.metadata, null);
});

test("buildHealthRecord: unrecognized type tallies a gap but still emits the record", () => {
  const gaps = newGapCounts();
  const rec = buildHealthRecord(el("Record", UNKNOWN_TYPE_RECORD), gaps);
  assert.ok(rec, "an unrecognized type is still a record, not dropped");
  assert.equal(gaps.unrecognizedRecordTypes.get("HKFutureTypeIdentifierSomethingNew"), 1);
});

// ─── buildWorkoutRecord ─────────────────────────────────────────────────

test("buildWorkoutRecord: populated run workout", () => {
  const w = buildWorkoutRecord(el("Workout", RUN_WORKOUT), newGapCounts());
  assert.ok(w);
  assert.equal(w.workout_activity_type, "Running");
  assert.equal(w.duration_minutes, 32.5);
  assert.equal(w.total_distance_km, 5.2);
  assert.equal(w.total_energy_burned_kcal, 345);
  assert.equal(w.source_name, "Apple Watch");
  assert.equal(w.source_version, "10.5");
  assert.equal(w.start_date, "2024-06-05T13:30:00.000Z");
});

test("buildWorkoutRecord: minimal walk workout leaves numeric fields null", () => {
  const w = buildWorkoutRecord(el("Workout", WALK_WORKOUT_MIN), newGapCounts());
  assert.ok(w);
  assert.equal(w.workout_activity_type, "Walking");
  assert.equal(w.duration_minutes, null);
  assert.equal(w.total_distance_km, null);
  assert.equal(w.total_energy_burned_kcal, null);
});

test("buildWorkoutRecord: unparseable start date → null (skip), tallied as a gap", () => {
  const gaps = newGapCounts();
  assert.equal(buildWorkoutRecord(el("Workout", BAD_DATE_WORKOUT), gaps), null);
  assert.equal(gaps.workoutsMissingStartDate, 1);
});

test("buildWorkoutRecord: nested WorkoutEvent children become an events array", () => {
  const w = buildWorkoutRecord(
    el("Workout", RUN_WORKOUT, {
      workoutEvents: [buildWorkoutEvent({ type: "HKWorkoutEventTypePause", date: "2024-06-05 13:40:00 -0700" })],
    }),
    newGapCounts()
  );
  assert.ok(w);
  assert.equal(w.events?.length, 1);
  assert.equal(w.events?.[0]?.type, "Pause");
  assert.equal(w.events?.[0]?.date, "2024-06-05T20:40:00.000Z");
});

test("buildWorkoutRecord: nested WorkoutStatistics children are preserved verbatim", () => {
  const stat = { type: "HKQuantityTypeIdentifierHeartRate", average: "142", unit: "count/min" };
  const w = buildWorkoutRecord(el("Workout", RUN_WORKOUT, { workoutStatistics: [stat] }), newGapCounts());
  assert.ok(w);
  assert.deepEqual(w.statistics, [stat]);
});

test("buildWorkoutRecord: no nested children → events/statistics/metadata are null, not empty arrays", () => {
  const w = buildWorkoutRecord(el("Workout", RUN_WORKOUT), newGapCounts());
  assert.ok(w);
  assert.equal(w.events, null);
  assert.equal(w.statistics, null);
  assert.equal(w.metadata, null);
});

// ─── buildWorkoutEvent ──────────────────────────────────────────────────

test("buildWorkoutEvent: strips HKWorkoutEventType prefix and parses duration", () => {
  const ev = buildWorkoutEvent({
    type: "HKWorkoutEventTypeSegment",
    date: "2024-06-05 13:40:00 -0700",
    duration: "7.5",
  });
  assert.equal(ev.type, "Segment");
  assert.equal(ev.date, "2024-06-05T20:40:00.000Z");
  assert.equal(ev.duration_minutes, 7.5);
});

// ─── Cursor helpers ─────────────────────────────────────────────────────

test("isBeforeCursor: no cursor → false (keep)", () => {
  assert.equal(isBeforeCursor("2024-06-05T00:00:00.000Z", undefined), false);
});

test("isBeforeCursor: equal → true (skip already-emitted)", () => {
  assert.equal(isBeforeCursor("2024-06-05T00:00:00.000Z", "2024-06-05T00:00:00.000Z"), true);
});

test("isBeforeCursor: strictly after cursor → false (keep)", () => {
  assert.equal(isBeforeCursor("2024-06-06T00:00:00.000Z", "2024-06-05T00:00:00.000Z"), false);
});

test("advanceCursor: undefined prev → takes next", () => {
  assert.equal(advanceCursor(undefined, "2024-06-05T00:00:00.000Z"), "2024-06-05T00:00:00.000Z");
});

test("advanceCursor: next > prev → takes next", () => {
  assert.equal(advanceCursor("2024-06-05T00:00:00.000Z", "2024-06-06T00:00:00.000Z"), "2024-06-06T00:00:00.000Z");
});

test("advanceCursor: next < prev → keeps prev (monotonic)", () => {
  assert.equal(advanceCursor("2024-06-06T00:00:00.000Z", "2024-06-05T00:00:00.000Z"), "2024-06-06T00:00:00.000Z");
});
