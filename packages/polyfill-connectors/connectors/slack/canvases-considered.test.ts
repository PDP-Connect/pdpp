/**
 * Unit tests for the Slack `canvases` stream's `considered` declaration
 * (OpenSpec `define-connector-progress-evidence-contract`, task 4.2).
 *
 * `canvases` is the ONE Slack stream where a `considered` denominator is
 * objectively honest: it full-syncs every run (it is NOT in
 * FINGERPRINTED_STREAMS, so unchanged records are never suppressed) and every
 * enumerated quip-file row is emitted unconditionally, so `collected` equals
 * the enumerated inventory rather than a churn-reduced subset. The runtime
 * reads the declared `considered` off a self-coverage DETAIL_COVERAGE
 * (state_stream === stream, empty key arrays) and the projection turns
 * collected-vs-considered into a real `complete` / `partial`.
 *
 * These tests drive `runCanvasesStream` against an in-memory sqlite shaped
 * like slackdump's FILE/CHANNEL tables and assert on the protocol message it
 * emits through the `emit` side-channel — they do NOT spawn slackdump.
 *
 * The companion absence + terminal-disposition proofs live in
 * reference-implementation/test/slack-collection-report.test.js (the
 * projection layer): a stream with no declaration stays `unknown`, and the
 * unsupported streams' existing SKIP_RESULT(reason: "not_available") reads a
 * `terminal` disposition.
 */

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { StreamScope } from "../../src/connector-runtime.ts";
import { makeRecordingEmit, type RecordingEmit } from "../../src/test-harness.ts";
import { runCanvasesStream, type StreamDeps } from "./index.ts";

/** Build an in-memory db with FILE + CHANNEL tables shaped like slackdump's
 *  archive sqlite. `canvasIds` become MODE='quip' FILE rows (the canvas
 *  inventory); `otherFileIds` become non-quip FILE rows that the canvas query
 *  filters out (proving `considered` counts only the quip inventory, not all
 *  files). Each canvas is inserted twice across two CHUNK_IDs to exercise the
 *  MAX(CHUNK_ID) dedup — the run enumerates ONE row per id, never two. */
function makeCanvasDb(canvasIds: readonly string[], otherFileIds: readonly string[] = []): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE FILE (ID TEXT, FILENAME TEXT, URL TEXT, MODE TEXT, CHANNEL_ID TEXT, MESSAGE_ID INTEGER, DATA TEXT, CHUNK_ID INTEGER)"
  );
  db.exec("CREATE TABLE CHANNEL (ID TEXT, DATA TEXT, CHUNK_ID INTEGER)");
  const insFile = db.prepare(
    "INSERT INTO FILE (ID, FILENAME, URL, MODE, CHANNEL_ID, MESSAGE_ID, DATA, CHUNK_ID) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  );
  for (const id of canvasIds) {
    const data = JSON.stringify({ title: `Canvas ${id}`, mimetype: "application/vnd.slack-docs", filetype: "quip" });
    // Same (id) across two chunks; the MAX(CHUNK_ID) dedup keeps the latest.
    insFile.run(id, `${id}.canvas`, `https://files.slack.com/${id}`, "quip", "C1", null, data, 1);
    insFile.run(id, `${id}.canvas`, `https://files.slack.com/${id}`, "quip", "C1", null, data, 2);
  }
  for (const id of otherFileIds) {
    const data = JSON.stringify({ mimetype: "image/png", filetype: "png" });
    insFile.run(id, `${id}.png`, `https://files.slack.com/${id}`, "hosted", "C1", null, data, 1);
  }
  db.prepare("INSERT INTO CHANNEL (ID, DATA, CHUNK_ID) VALUES (?, ?, ?)").run(
    "C1",
    JSON.stringify({ is_channel: true, name: "general" }),
    1
  );
  return db;
}

function makeDeps(db: DatabaseSync, harness: RecordingEmit): StreamDeps {
  const requested = new Map<string, StreamScope>([["canvases", { name: "canvases" }]]);
  return {
    db,
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    emittedAt: "2026-06-05T12:00:00.000Z",
    fingerprintCursors: new Map(),
    progress: () => Promise.resolve(),
    requested,
  };
}

/** Pull the single self-coverage DETAIL_COVERAGE for `canvases` from the
 *  protocol side-channel. Returns `null` when none was emitted. */
function canvasCoverage(harness: RecordingEmit): Record<string, unknown> | null {
  const msg = harness.protocolMessages.find(
    (m) => m.type === "DETAIL_COVERAGE" && (m as { stream?: string }).stream === "canvases"
  );
  return msg ? (msg as unknown as Record<string, unknown>) : null;
}

test("runCanvasesStream: declares considered === the enumerated quip inventory (a real complete denominator)", async () => {
  const db = makeCanvasDb(["F1", "F2", "F3"]);
  const harness = makeRecordingEmit();
  try {
    await runCanvasesStream(makeDeps(db, harness));
  } finally {
    db.close();
  }

  // Three distinct canvases enumerated (each deduped from two chunks) → three
  // RECORDs.
  assert.equal(harness.emitted.filter((r) => r.stream === "canvases").length, 3);

  const cov = canvasCoverage(harness);
  assert.ok(cov, "expected a self-coverage DETAIL_COVERAGE for canvases");
  const c = cov as Record<string, unknown>;
  assert.equal(c.type, "DETAIL_COVERAGE");
  assert.equal(c.stream, "canvases");
  assert.equal(c.state_stream, "canvases", "self-coverage: state_stream === stream");
  assert.equal(c.considered, 3, "considered is the deduped enumerated count");
  // Empty key arrays so the pre-commit coverage gate has nothing to mark
  // missing — the committed STATE still commits.
  assert.deepEqual(c.required_keys, []);
  assert.deepEqual(c.hydrated_keys, []);
});

test("runCanvasesStream: considered counts ONLY quip canvases, never all FILE rows (measured at the query site)", async () => {
  // Five FILE rows total, but only two are MODE='quip'. `considered` must be
  // the quip inventory the canvas query enumerates (2), never the full file
  // table (5) and never the emitted count by coincidence.
  const db = makeCanvasDb(["Q1", "Q2"], ["P1", "P2", "P3"]);
  const harness = makeRecordingEmit();
  try {
    await runCanvasesStream(makeDeps(db, harness));
  } finally {
    db.close();
  }

  assert.equal(harness.emitted.filter((r) => r.stream === "canvases").length, 2);
  const cov = canvasCoverage(harness);
  assert.equal(cov?.considered, 2, "considered is the quip-filtered enumeration, not the whole FILE table");
});

test("runCanvasesStream: an empty canvas inventory still declares considered: 0 (honest complete of nothing)", async () => {
  const db = makeCanvasDb([], ["P1"]);
  const harness = makeRecordingEmit();
  try {
    await runCanvasesStream(makeDeps(db, harness));
  } finally {
    db.close();
  }

  assert.equal(harness.emitted.filter((r) => r.stream === "canvases").length, 0, "no canvases to emit");
  const cov = canvasCoverage(harness);
  assert.ok(cov, "even an empty inventory declares its denominator");
  assert.equal(
    (cov as Record<string, unknown>).considered,
    0,
    "considered: 0 — an enumerated empty inventory, not unknown"
  );
});

test("runCanvasesStream: emits the considered DETAIL_COVERAGE AFTER the last canvas RECORD", async () => {
  // The denominator is the run's enumerated total, so it lands once the stream
  // is fully traversed — mirrors the GitHub list-stream ordering. Pin it so a
  // refactor that emits coverage mid-stream (before the count is final) fails.
  const db = makeCanvasDb(["F1", "F2"]);
  const harness = makeRecordingEmit();
  try {
    await runCanvasesStream(makeDeps(db, harness));
  } finally {
    db.close();
  }

  const lastRecordIdx = harness.events.findLastIndex((e) => e.kind === "record" && e.stream === "canvases");
  const coverageIdx = harness.events.findIndex((e) => e.kind === "message" && e.message.type === "DETAIL_COVERAGE");
  assert.notEqual(lastRecordIdx, -1, "expected canvas records");
  assert.notEqual(coverageIdx, -1, "expected a coverage message");
  assert.ok(coverageIdx > lastRecordIdx, "considered coverage lands after the last canvas RECORD");
});
