/**
 * Unit tests for the steady-state `considered` + `covered` declaration on Slack's
 * fingerprint-suppressed full-sync streams (OpenSpec
 * `define-connector-progress-evidence-contract`, task 4.4).
 *
 * These streams (`workspace`, `users`, `files`, `channels`,
 * `channel_memberships`) re-enumerate their whole source boundary every run and
 * suppress the records they determine to be unchanged via `emitWithFingerprint`.
 * Before task 4.4 they declared NO `considered` denominator at all, because the
 * gate compared `considered` against the post-suppression emitted count
 * (`collected`), so a steady-state run (nothing changed → nothing emitted) would
 * have read a FALSE `partial`.
 *
 * Task 4.4 adds an objective `covered` count — the in-boundary items the run
 * accounted for: emitted PLUS suppressed-because-unchanged. The gate compares
 * `considered` against `covered` when present, so:
 *   - a steady-state run reads `complete` (covered === considered, collected 0);
 *   - a one-changed run still reads `complete` (covered === considered);
 *   - a run that drops a weighed row reads `partial` (covered < considered),
 *     because a dropped row is in NEITHER the collected NOR the covered count.
 *
 * These tests drive the real sqlite-bound stream runners against an in-memory db
 * shaped like slackdump's archive and assert on the self-coverage DETAIL_COVERAGE
 * the connector emits through the `emit` side-channel. The projection half (the
 * gate turning covered-vs-considered into complete/partial) is pinned in
 * reference-implementation/test/collection-report-projection.test.js.
 */

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { StreamScope } from "../../src/connector-runtime.ts";
import { type FingerprintCursor, openFingerprintCursor } from "../../src/fingerprint-cursor.ts";
import { makeRecordingEmit, type RecordingEmit } from "../../src/test-harness.ts";
import {
  emitWithFingerprint,
  FINGERPRINT_EXCLUDE,
  FINGERPRINTED_STREAMS,
  runChannelsStream,
  runUsersStream,
  type StreamDeps,
} from "./index.ts";

/** Build an in-memory db with an S_USER table shaped like slackdump's archive.
 *  Each user is inserted twice across two CHUNK_IDs to exercise MAX(CHUNK_ID)
 *  dedup — the run enumerates ONE row per id. */
function makeUserDb(users: ReadonlyArray<{ id: string; username: string; updated: number }>): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE S_USER (ID TEXT, USERNAME TEXT, DATA TEXT, CHUNK_ID INTEGER)");
  const ins = db.prepare("INSERT INTO S_USER (ID, USERNAME, DATA, CHUNK_ID) VALUES (?, ?, ?, ?)");
  for (const u of users) {
    const data = JSON.stringify({ name: u.username, updated: u.updated });
    ins.run(u.id, u.username, data, 1);
    ins.run(u.id, u.username, data, 2);
  }
  return db;
}

/** Build an in-memory db with a CHANNEL table shaped like slackdump's archive. */
function makeChannelDb(channels: ReadonlyArray<{ id: string; name: string }>): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE CHANNEL (ID TEXT, NAME TEXT, DATA TEXT, CHUNK_ID INTEGER)");
  const ins = db.prepare("INSERT INTO CHANNEL (ID, NAME, DATA, CHUNK_ID) VALUES (?, ?, ?, ?)");
  for (const c of channels) {
    const data = JSON.stringify({ is_channel: true, name: c.name });
    ins.run(c.id, c.name, data, 1);
  }
  return db;
}

/** Open one fingerprint cursor per fingerprinted stream, seeded from `prior`. */
function makeCursors(
  prior: Partial<Record<(typeof FINGERPRINTED_STREAMS)[number], Record<string, string>>> = {}
): Map<string, FingerprintCursor> {
  const cursors = new Map<string, FingerprintCursor>();
  for (const stream of FINGERPRINTED_STREAMS) {
    cursors.set(
      stream,
      openFingerprintCursor(
        { fingerprints: prior[stream] ?? {} },
        { excludeFromFingerprint: FINGERPRINT_EXCLUDE[stream] }
      )
    );
  }
  return cursors;
}

function makeDeps(
  db: DatabaseSync,
  harness: RecordingEmit,
  cursors: Map<string, FingerprintCursor>,
  requestedStreams: readonly string[]
): StreamDeps {
  return {
    db,
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    emittedAt: "2026-06-05T12:00:00.000Z",
    fingerprintCursors: cursors,
    progress: () => Promise.resolve(),
    requested: new Map<string, StreamScope>(requestedStreams.map((n) => [n, { name: n }])),
  };
}

/** Pull the self-coverage DETAIL_COVERAGE for `stream` from the side-channel. */
function coverageFor(harness: RecordingEmit, stream: string): Record<string, unknown> | null {
  const msg = harness.protocolMessages.find(
    (m) => m.type === "DETAIL_COVERAGE" && (m as { stream?: string }).stream === stream
  );
  return msg ? (msg as unknown as Record<string, unknown>) : null;
}

test("users: a fresh run declares considered === covered === enumerated (all emitted, a real complete)", async () => {
  const db = makeUserDb([
    { id: "U1", username: "alice", updated: 100 },
    { id: "U2", username: "bob", updated: 100 },
    { id: "U3", username: "carol", updated: 100 },
  ]);
  const harness = makeRecordingEmit();
  try {
    await runUsersStream(makeDeps(db, harness, makeCursors(), ["users"]));
  } finally {
    db.close();
  }

  // No prior cursor → every enumerated user emits.
  assert.equal(harness.emitted.filter((r) => r.stream === "users").length, 3, "all three users emitted");
  const cov = coverageFor(harness, "users");
  assert.ok(cov, "expected a self-coverage DETAIL_COVERAGE for users");
  assert.equal(cov?.state_stream, "users", "self-coverage: state_stream === stream");
  assert.equal(cov?.considered, 3, "considered is the enumerated inventory");
  assert.equal(cov?.covered, 3, "covered === considered: every item accounted for (emitted)");
  assert.deepEqual(cov?.required_keys, []);
  assert.deepEqual(cov?.hydrated_keys, []);
});

test("users: a STEADY-STATE run suppresses every unchanged record yet declares covered === considered", async () => {
  const users = [
    { id: "U1", username: "alice", updated: 100 },
    { id: "U2", username: "bob", updated: 100 },
    { id: "U3", username: "carol", updated: 100 },
  ];
  // Run 1: seed the cursor with every user's fingerprint.
  const cursors1 = makeCursors();
  const db1 = makeUserDb(users);
  const h1 = makeRecordingEmit();
  try {
    await runUsersStream(makeDeps(db1, h1, cursors1, ["users"]));
  } finally {
    db1.close();
  }
  const priorState = cursors1.get("users")?.toState() ?? {};

  // Run 2: identical source state → fingerprint matches → every record suppressed.
  const db2 = makeUserDb(users);
  const h2 = makeRecordingEmit();
  try {
    await runUsersStream(makeDeps(db2, h2, makeCursors({ users: priorState }), ["users"]));
  } finally {
    db2.close();
  }

  // The load-bearing assertion: collected is 0 (everything unchanged), but the
  // run still ENUMERATED and ACCOUNTED FOR all three → covered === considered.
  assert.equal(h2.emitted.filter((r) => r.stream === "users").length, 0, "steady-state run emits nothing");
  const cov = coverageFor(h2, "users");
  assert.equal(cov?.considered, 3, "still enumerated the full inventory");
  assert.equal(cov?.covered, 3, "all three accounted for as suppressed-unchanged → complete, not a false partial");
});

test("users: a one-changed run still declares covered === considered (changed emit + unchanged suppressed both covered)", async () => {
  const users = [
    { id: "U1", username: "alice", updated: 100 },
    { id: "U2", username: "bob", updated: 100 },
    { id: "U3", username: "carol", updated: 100 },
  ];
  const cursors1 = makeCursors();
  const db1 = makeUserDb(users);
  const h1 = makeRecordingEmit();
  try {
    await runUsersStream(makeDeps(db1, h1, cursors1, ["users"]));
  } finally {
    db1.close();
  }
  const priorState = cursors1.get("users")?.toState() ?? {};

  // Run 2: one user changed (updated moved), two unchanged.
  const db2 = makeUserDb(users.map((u, i) => (i === 0 ? { ...u, updated: 200 } : u)));
  const h2 = makeRecordingEmit();
  try {
    await runUsersStream(makeDeps(db2, h2, makeCursors({ users: priorState }), ["users"]));
  } finally {
    db2.close();
  }

  assert.equal(h2.emitted.filter((r) => r.stream === "users").length, 1, "only the changed user re-emits");
  const cov = coverageFor(h2, "users");
  assert.equal(cov?.considered, 3);
  assert.equal(cov?.covered, 3, "1 emitted + 2 suppressed-unchanged === considered → complete");
});

test("channels: requested-only — covered tracks the channels pass, considered is the enumerated channel inventory", async () => {
  const db = makeChannelDb([
    { id: "C1", name: "general" },
    { id: "C2", name: "random" },
  ]);
  const harness = makeRecordingEmit();
  try {
    // Request channels (fingerprinted) but NOT channel_stats — only the
    // fingerprinted entity pass should drive covered.
    await runChannelsStream(makeDeps(db, harness, makeCursors(), ["channels"]));
  } finally {
    db.close();
  }

  assert.equal(
    harness.emitted.filter((r) => r.stream === "channels").length,
    2,
    "both channels emitted on a fresh run"
  );
  const cov = coverageFor(harness, "channels");
  assert.ok(cov, "channels declares its considered/covered denominator");
  assert.equal(cov?.considered, 2);
  assert.equal(cov?.covered, 2);
});

test("channels: NOT requested → no considered/covered declaration (no denominator for an unexercised stream)", async () => {
  const db = makeChannelDb([{ id: "C1", name: "general" }]);
  const harness = makeRecordingEmit();
  try {
    // Only channel_stats requested; the channels entity pass never runs.
    await runChannelsStream(makeDeps(db, harness, makeCursors(), ["channel_stats"]));
  } finally {
    db.close();
  }

  assert.equal(harness.emitted.filter((r) => r.stream === "channels").length, 0, "no channel entity records");
  assert.equal(coverageFor(harness, "channels"), null, "an unrequested channels pass declares no denominator");
});

test("emitWithFingerprint: reports emit vs suppress so covered counts both, never aliasing rows.length", async () => {
  // Directly pin the emit/suppress signal the covered count is built from: a
  // changed (or new) record returns true (emitted), an unchanged one returns
  // false (suppressed) — but BOTH are covered. A row that never reaches this
  // helper (a future malformed-row drop) is in neither count, so covered would
  // fall below considered and read an honest partial.
  const cursors1 = makeCursors();
  const deps1 = makeDeps(new DatabaseSync(":memory:"), makeRecordingEmit(), cursors1, ["users"]);
  const rec = { id: "U1", name: "alice", updated: 100 };
  const firstEmit = await emitWithFingerprint(deps1, "users", rec);
  assert.equal(firstEmit, true, "first sight of a record emits (covered via emit)");

  const priorState = cursors1.get("users")?.toState() ?? {};
  const deps2 = makeDeps(new DatabaseSync(":memory:"), makeRecordingEmit(), makeCursors({ users: priorState }), [
    "users",
  ]);
  const suppressed = await emitWithFingerprint(deps2, "users", rec);
  assert.equal(suppressed, false, "an unchanged record is suppressed (covered via suppression, NOT a drop)");

  const changed = await emitWithFingerprint(deps2, "users", { ...rec, updated: 200 });
  assert.equal(changed, true, "a changed record re-emits (covered via emit)");
});
