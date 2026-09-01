// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * FORMAT-CONFORMANCE proof, NOT live proof. Runs the real connector
 * subprocess (exact protocol an orchestrator uses) against a large
 * synthetic export.xml built from the researched Apple Health export
 * shape (ai/research/apple-health-export-format/) — multi-year, multiple
 * sources/devices, sleep sessions, workouts with events/statistics/
 * metadata, and deliberate edge cases (missing unit, unknown type,
 * missing startDate, a DST boundary, a zero-duration workout).
 *
 * This proves the parser handles that documented/observed shape end to
 * end, streaming, with bounded memory. It does NOT prove a real iPhone
 * export matches this shape exactly — Apple has never published an
 * official schema, so only a real export (see local/APPLE-HEALTH-TEST.md)
 * can prove that.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { EmittedMessage } from "../../src/connector-runtime.ts";
import { runConnectorProtocolSubprocess } from "../../src/test-harness.ts";
import { buildSyntheticExportDir, syntheticExportStartYear } from "./__fixtures__/synthetic-export.ts";

const PACKAGE_ROOT = join(import.meta.dirname, "..", "..");
const ENTRYPOINT = join(PACKAGE_ROOT, "connectors", "apple_health", "index.ts");

function records(messages: readonly EmittedMessage[], stream: string): Record<string, unknown>[] {
  return messages
    .filter((m): m is Extract<EmittedMessage, { type: "RECORD" }> => m.type === "RECORD")
    .filter((m) => m.stream === stream)
    .map((m) => m.data);
}

function progressLines(messages: readonly EmittedMessage[]): string[] {
  return messages
    .filter((m): m is Extract<EmittedMessage, { type: "PROGRESS" }> => m.type === "PROGRESS")
    .map((m) => m.message);
}

function run(exportDir: string, opts: { peakRssPollIntervalMs?: number } = {}) {
  return runConnectorProtocolSubprocess({
    cwd: PACKAGE_ROOT,
    entrypoint: ENTRYPOINT,
    env: { APPLE_HEALTH_EXPORT_DIR: exportDir },
    ...(opts.peakRssPollIntervalMs === undefined ? {} : { peakRssPollIntervalMs: opts.peakRssPollIntervalMs }),
    start: {
      scope: { streams: [{ name: "records" }, { name: "workouts" }] },
      state: {},
      type: "START",
    },
    timeoutMs: 60_000,
  });
}

test("FORMAT-CONFORMANCE: synthetic multi-year, multi-source export.xml (~5k records) parses end to end with honest gap reporting", {
  timeout: 60_000,
}, async () => {
  const { dir, stats } = buildSyntheticExportDir(5000);
  try {
    const result = await run(dir);

    const done = result.messages.findLast((m) => m.type === "DONE");
    assert.ok(done && done.type === "DONE", "expected a DONE message");
    assert.equal(done.status, "succeeded");

    const recordRows = records(result.messages, "records");
    const workoutRows = records(result.messages, "workouts");

    // Ground truth from the generator: every Record element except the
    // one deliberately missing startDate should be emitted.
    const expectedRecords = stats.totalRecordElements - 1; // -1 for the missing-startDate row
    assert.equal(recordRows.length, expectedRecords, `expected ${expectedRecords} emitted records`);
    assert.equal(workoutRows.length, stats.workoutsTotal, "every workout has a parseable startDate");

    // Fidelity: heart rate (unit contains '/') actually made it through —
    // this is the exact case the tag-regex bug this session fixed would
    // have silently dropped.
    const heartRateRows = recordRows.filter((r) => r.type === "HeartRate");
    assert.ok(heartRateRows.length > 0, "HeartRate records (unit=count/min) must not be silently dropped");
    assert.ok(
      heartRateRows.every((r) => r.unit === "count/min"),
      "HeartRate unit must survive intact"
    );

    // Sleep (category) records: value_raw carries the HK token, value is null.
    const sleepRows = recordRows.filter((r) => r.type === "SleepAnalysis");
    assert.ok(sleepRows.length > 0, "expected sleep analysis rows");
    assert.ok(sleepRows.every((r) => r.value === null && typeof r.value_raw === "string"));
    assert.ok(
      sleepRows.every((r) => r.metadata && typeof r.metadata === "object"),
      "sleep rows carry MetadataEntry"
    );

    // Device provenance preserved for iPhone/Watch-sourced records.
    assert.ok(recordRows.some((r) => typeof r.device === "string" && (r.device as string).includes("iPhone")));

    // Workouts: events/statistics/metadata fidelity.
    const withEvents = workoutRows.filter((w) => Array.isArray(w.events) && (w.events as unknown[]).length > 0);
    const withStats = workoutRows.filter((w) => Array.isArray(w.statistics) && (w.statistics as unknown[]).length > 0);
    assert.equal(withEvents.length, stats.workoutsWithEvents, "workout event counts must match ground truth");
    assert.equal(withStats.length, stats.workoutsWithStatistics, "workout statistics counts must match ground truth");
    const zeroDuration = workoutRows.filter((w) => w.duration_minutes === 0);
    assert.equal(zeroDuration.length, stats.zeroDurationWorkouts, "zero-duration workout must still be captured");

    // Honesty gate: the unrecognized type and the missing-startDate row
    // must show up in the reported gap summary, not vanish silently.
    const gapsLine = progressLines(result.messages).find((l) => l.includes("gaps"));
    assert.ok(gapsLine, "expected a gap-summary PROGRESS line");
    assert.match(gapsLine ?? "", /records_dropped_missing_start_date=1/);
    assert.match(gapsLine ?? "", /unrecognized_record_types=HKBiomarkerTypeIdentifierFutureBiomarkerNotYetInvented:1/);

    // DST boundary record survived (a naive local-time parser could throw
    // or silently produce a wrong-by-an-hour value across the fold). The
    // generator writes a US spring-forward instant with an explicit
    // "-0800" offset, which `new Date(...).toISOString()` resolves the
    // same way regardless of the host's local timezone.
    const dstExpected = new Date(`${syntheticExportStartYear() + 1}-03-09T01:59:00-08:00`).toISOString();
    const dstRow = recordRows.find((r) => r.start_date === dstExpected);
    assert.ok(dstRow, `DST-boundary record must parse without throwing or vanishing (expected ${dstExpected})`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Found via live proof against a real dogsheep/Simon-Willison-hosted Apple
// Health export sample: a WorkoutRoute (GPS geometry) nested under a
// Workout matched no branch of the tag scanner and vanished with no trace
// in the gap tally — unlike an unrecognized Record `type`, which was
// always counted. This is real, common Apple Health content (any outdoor
// workout with location tracking), so it must show up as an honest gap,
// not silently disappear.
test("FORMAT-CONFORMANCE: WorkoutRoute (GPS geometry) is tallied as an honest gap, not silently dropped", async () => {
  const dir = await mkdtemp(join(tmpdir(), "apple-health-workout-route-"));
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n<HealthData locale="en_US">' +
    '<Workout workoutActivityType="HKWorkoutActivityTypeRunning" sourceName="Apple Watch" ' +
    'startDate="2024-06-05 06:30:00 -0700" endDate="2024-06-05 07:02:30 -0700">' +
    '<WorkoutRoute sourceName="iPhone" startDate="2024-06-05 06:30:00 -0700" endDate="2024-06-05 07:02:30 -0700">' +
    '<Location date="2024-06-05 06:30:01 -0700" latitude="37.7" longitude="-122.4" altitude="10" ' +
    'horizontalAccuracy="5" verticalAccuracy="3" course="-1" speed="2.5"/>' +
    "</WorkoutRoute>" +
    "</Workout>" +
    "</HealthData>";
  await writeFile(join(dir, "export.xml"), xml, "utf8");
  try {
    const result = await run(dir);
    const done = result.messages.findLast((m) => m.type === "DONE");
    assert.ok(done && done.type === "DONE" && done.status === "succeeded");

    const workoutRows = records(result.messages, "workouts");
    assert.equal(workoutRows.length, 1, "the Workout itself must still be emitted");

    const gapsLine = progressLines(result.messages).find((l) => l.includes("gaps"));
    assert.match(gapsLine ?? "", /workout_routes_uncaptured=1/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("FORMAT-CONFORMANCE: memory stays bounded (streaming, not whole-document) on a larger synthetic export", {
  timeout: 90_000,
}, async () => {
  const { dir } = buildSyntheticExportDir(40_000);
  try {
    const result = await run(dir, { peakRssPollIntervalMs: 200 });
    const done = result.messages.findLast((m) => m.type === "DONE");
    assert.ok(done && done.type === "DONE");
    assert.equal(done.status, "succeeded");
    assert.ok(result.peakRssBytes !== null, "expected a sampled peak RSS");
    // A generous bound: streaming parse of a many-MB XML file should stay
    // in the tens of MB, nowhere near loading the whole document into
    // memory as a DOM/array. 300MB is deliberately loose headroom for
    // process/runtime baseline overhead on CI.
    assert.ok(
      (result.peakRssBytes ?? 0) < 300 * 1024 * 1024,
      `peak RSS ${Math.round((result.peakRssBytes ?? 0) / 1024 / 1024)}MB exceeded the streaming-design bound`
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
