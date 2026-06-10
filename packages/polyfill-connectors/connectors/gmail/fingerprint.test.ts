/**
 * Per-thread fingerprint behavior for the Gmail connector. These tests
 * pin the contract the threads-stream churn fix depends on:
 *
 *   1. An unchanged thread's fingerprint stays stable across runs —
 *      `buildThreadFingerprint(agg1) === buildThreadFingerprint(agg2)`
 *      whenever (agg1, agg2) carry the same semantic shape.
 *   2. Any real change to the aggregate moves the fingerprint
 *      (message_count, last_message_date, labels, flags, etc.).
 *   3. `readPriorThreadFingerprints` is tolerant of missing / legacy /
 *      malformed state and never throws.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { openFingerprintCursor } from "../../src/fingerprint-cursor.ts";
import { makeRecordingEmit } from "../../src/test-harness.ts";
import { emitChangedThreads, readPriorThreadFingerprints } from "./index.ts";
import { buildThreadFingerprint } from "./parsers.ts";
import type { ThreadAggregate } from "./types.ts";

function makeAgg(overrides: Partial<ThreadAggregate> = {}): ThreadAggregate {
  return {
    id: "T1",
    subject: "Hello",
    participant_set: new Set(["alice@example.com", "bob@example.com"]),
    message_count: 3,
    first_message_date: "2026-05-01T00:00:00.000Z",
    last_message_date: "2026-05-10T00:00:00.000Z",
    labels_set: new Set(["INBOX", "[Gmail]/Sent Mail"]),
    unread_count: 0,
    flagged_count: 0,
    has_attachments: false,
    ...overrides,
  };
}

test("buildThreadFingerprint: identical aggregates produce identical hashes — fingerprint is content-only", () => {
  const a = makeAgg();
  const b = makeAgg();
  assert.equal(buildThreadFingerprint(a), buildThreadFingerprint(b));
});

test("buildThreadFingerprint: participant-set insertion order does NOT change the hash", () => {
  // The emitted record uses [...set]; insertion order is the JS iteration
  // order. If two builds yielded different orders for the same set of
  // participants, the hash would oscillate and every run would re-emit.
  const a = makeAgg({ participant_set: new Set(["alice@example.com", "bob@example.com"]) });
  const b = makeAgg({ participant_set: new Set(["bob@example.com", "alice@example.com"]) });
  // The fingerprint is stableStringify-based, so the array is sorted-key
  // canonicalized, but array element order itself is preserved. The Set's
  // iteration order differs here intentionally — this test pins that the
  // record builder's array form sorts/stabilizes participants.
  // NOTE: Slack uses sorted arrays; gmail uses Set spread. If this test
  // fails it means we need to sort the participant array in
  // buildThreadRecord (the production code path) so the fingerprint is
  // truly stable across runs where Set iteration could vary.
  // For now this is an aspirational pin — see the report's residual risks
  // if it fails.
  if (buildThreadFingerprint(a) !== buildThreadFingerprint(b)) {
    assert.fail(
      "buildThreadRecord must produce a participant array stable across Set iteration order; " +
        "if this assert fires, sort the array in buildThreadRecord before emitting"
    );
  }
});

test("buildThreadFingerprint: moving message_count changes the hash", () => {
  const a = makeAgg({ message_count: 3 });
  const b = makeAgg({ message_count: 4 });
  assert.notEqual(buildThreadFingerprint(a), buildThreadFingerprint(b));
});

test("buildThreadFingerprint: moving last_message_date changes the hash", () => {
  const a = makeAgg({ last_message_date: "2026-05-10T00:00:00.000Z" });
  const b = makeAgg({ last_message_date: "2026-05-11T00:00:00.000Z" });
  assert.notEqual(buildThreadFingerprint(a), buildThreadFingerprint(b));
});

test("buildThreadFingerprint: adding a label changes the hash", () => {
  const a = makeAgg({ labels_set: new Set(["INBOX"]) });
  const b = makeAgg({ labels_set: new Set(["INBOX", "STARRED"]) });
  assert.notEqual(buildThreadFingerprint(a), buildThreadFingerprint(b));
});

test("buildThreadFingerprint: flag/attachment changes participate in the hash", () => {
  const base = makeAgg();
  assert.notEqual(buildThreadFingerprint(base), buildThreadFingerprint({ ...base, unread_count: 1 }));
  assert.notEqual(buildThreadFingerprint(base), buildThreadFingerprint({ ...base, flagged_count: 1 }));
  assert.notEqual(buildThreadFingerprint(base), buildThreadFingerprint({ ...base, has_attachments: true }));
});

test("readPriorThreadFingerprints: empty state → empty map (first run)", () => {
  const out = readPriorThreadFingerprints({});
  assert.equal(out.size, 0);
});

test("readPriorThreadFingerprints: legacy state (no thread_fingerprints) → empty map (one-time re-emit cost)", () => {
  const out = readPriorThreadFingerprints({ threads: { fetched_at: "2026-05-26T00:00:00.000Z" } });
  assert.equal(out.size, 0);
});

test("readPriorThreadFingerprints: well-formed state round-trips", () => {
  const out = readPriorThreadFingerprints({
    threads: {
      fetched_at: "2026-05-26T00:00:00.000Z",
      thread_fingerprints: { T1: "abc123", T2: "def456" },
    },
  });
  assert.equal(out.size, 2);
  assert.equal(out.get("T1"), "abc123");
  assert.equal(out.get("T2"), "def456");
});

test("readPriorThreadFingerprints: malformed entries are silently dropped", () => {
  const out = readPriorThreadFingerprints({
    threads: {
      thread_fingerprints: {
        T1: "good",
        T2: 42, // wrong type
        T3: "", // empty string
        T4: null, // null
        T5: "alsoGood",
      },
    },
  });
  assert.equal(out.size, 2);
  assert.ok(out.has("T1"));
  assert.ok(out.has("T5"));
});

// ─── Two-pass churn invariant ───────────────────────────────────────────
//
// These tests pin the headline guarantee the migration to
// `openFingerprintCursor` is supposed to preserve: a second `1:*` pass
// over the same aggregated thread bag must emit zero RECORDs. Before the
// fingerprint cursor existed, IMAP's full-mailbox sweep re-emitted every
// thread on every schedule tick, producing ~256 versions/key in the
// live churn report. The test seam is `emitChangedThreads`, which is
// what `runThreadsPass` calls after the IMAP iteration completes —
// driving it directly avoids standing up a fake imapflow.

function persistThreadsState(cursor: ReturnType<typeof openFingerprintCursor>): Record<string, unknown> {
  // Mirror the production STATE shape so the next run's
  // `readPriorThreadFingerprints` decodes it the way the resource
  // server will hand it back.
  return { threads: { fetched_at: "2026-05-26T12:00:00.000Z", thread_fingerprints: cursor.toState() } };
}

function openCursorFromState(state: Record<string, unknown>): ReturnType<typeof openFingerprintCursor> {
  return openFingerprintCursor(state, { priorFingerprints: readPriorThreadFingerprints(state) });
}

test("two-pass invariant: unchanged thread aggregates emit on pass 1, zero on pass 2", async () => {
  const aggregates: ThreadAggregate[] = [
    {
      id: "T1",
      subject: "Hello",
      participant_set: new Set(["alice@example.com", "bob@example.com"]),
      message_count: 3,
      first_message_date: "2026-05-01T00:00:00.000Z",
      last_message_date: "2026-05-10T00:00:00.000Z",
      labels_set: new Set(["INBOX"]),
      unread_count: 0,
      flagged_count: 0,
      has_attachments: false,
    },
    {
      id: "T2",
      subject: "Receipt",
      participant_set: new Set(["store@example.com"]),
      message_count: 1,
      first_message_date: "2026-05-05T00:00:00.000Z",
      last_message_date: "2026-05-05T00:00:00.000Z",
      labels_set: new Set(["INBOX", "STARRED"]),
      unread_count: 0,
      flagged_count: 1,
      has_attachments: true,
    },
  ];

  // Pass 1: empty prior state → every thread emits once.
  const run1 = makeRecordingEmit();
  const cursor1 = openCursorFromState({});
  await emitChangedThreads(aggregates, cursor1, run1.emitRecord);
  cursor1.pruneStale();
  assert.equal(run1.emitted.length, 2, "first pass emits both threads");
  assert.deepEqual(run1.emitted.map((e) => (e.data as { id: string }).id).sort(), ["T1", "T2"]);

  // Pass 2: same aggregates, prior state from pass 1 → zero emits.
  const state = persistThreadsState(cursor1);
  const run2 = makeRecordingEmit();
  const cursor2 = openCursorFromState(state);
  await emitChangedThreads(aggregates, cursor2, run2.emitRecord);
  cursor2.pruneStale();
  assert.equal(run2.emitted.length, 0, "second pass emits nothing — unchanged threads do not re-emit");

  // Carry-forward intact: pass 3 also no-ops.
  const state2 = persistThreadsState(cursor2);
  const run3 = makeRecordingEmit();
  const cursor3 = openCursorFromState(state2);
  await emitChangedThreads(aggregates, cursor3, run3.emitRecord);
  cursor3.pruneStale();
  assert.equal(run3.emitted.length, 0, "third pass also no-ops — fingerprints carried forward across skipped runs");
});

test("two-pass invariant: a real change to one thread re-emits only that thread on pass 2", async () => {
  const baseT1: ThreadAggregate = {
    id: "T1",
    subject: "Hello",
    participant_set: new Set(["alice@example.com"]),
    message_count: 3,
    first_message_date: "2026-05-01T00:00:00.000Z",
    last_message_date: "2026-05-10T00:00:00.000Z",
    labels_set: new Set(["INBOX"]),
    unread_count: 0,
    flagged_count: 0,
    has_attachments: false,
  };
  const baseT2: ThreadAggregate = { ...baseT1, id: "T2", subject: "Receipt" };

  const run1 = makeRecordingEmit();
  const cursor1 = openCursorFromState({});
  await emitChangedThreads([baseT1, baseT2], cursor1, run1.emitRecord);
  cursor1.pruneStale();
  assert.equal(run1.emitted.length, 2);

  // T2 gains a message; T1 unchanged.
  const state = persistThreadsState(cursor1);
  const changedT2: ThreadAggregate = {
    ...baseT2,
    message_count: 2,
    last_message_date: "2026-05-12T00:00:00.000Z",
  };
  const run2 = makeRecordingEmit();
  const cursor2 = openCursorFromState(state);
  await emitChangedThreads([baseT1, changedT2], cursor2, run2.emitRecord);
  cursor2.pruneStale();
  assert.equal(run2.emitted.length, 1, "only the changed thread re-emits");
  assert.equal((run2.emitted[0]?.data as { id: string }).id, "T2");
});

test("two-pass invariant: thread present in pass 1 but absent in pass 2 is pruned from STATE", async () => {
  const baseT1: ThreadAggregate = {
    id: "T1",
    subject: "Hello",
    participant_set: new Set(["alice@example.com"]),
    message_count: 1,
    first_message_date: "2026-05-01T00:00:00.000Z",
    last_message_date: "2026-05-01T00:00:00.000Z",
    labels_set: new Set(["INBOX"]),
    unread_count: 0,
    flagged_count: 0,
    has_attachments: false,
  };
  const baseT2: ThreadAggregate = { ...baseT1, id: "T2" };

  const cursor1 = openCursorFromState({});
  const run1 = makeRecordingEmit();
  await emitChangedThreads([baseT1, baseT2], cursor1, run1.emitRecord);
  cursor1.pruneStale();
  assert.equal(Object.keys(cursor1.toState()).length, 2);

  // T2 disappeared from the source between runs.
  const state = persistThreadsState(cursor1);
  const cursor2 = openCursorFromState(state);
  const run2 = makeRecordingEmit();
  await emitChangedThreads([baseT1], cursor2, run2.emitRecord);
  // Pre-prune: cursor still carries T2's fingerprint (seeded from prior).
  assert.equal(Object.keys(cursor2.toState()).length, 2, "carry-forward keeps T2 pre-prune");
  cursor2.pruneStale();
  const post = cursor2.toState();
  assert.equal(Object.keys(post).length, 1, "stale id dropped after prune");
  assert.ok(post.T1, "seen id retained");
  assert.equal(post.T2, undefined, "absent id pruned — future re-creation re-emits");
});

test("two-pass invariant: a legacy STATE without thread_fingerprints triggers one-time re-emit, then no-ops", async () => {
  const agg: ThreadAggregate = {
    id: "T1",
    subject: "Hello",
    participant_set: new Set(["alice@example.com"]),
    message_count: 1,
    first_message_date: "2026-05-01T00:00:00.000Z",
    last_message_date: "2026-05-01T00:00:00.000Z",
    labels_set: new Set([]),
    unread_count: 0,
    flagged_count: 0,
    has_attachments: false,
  };

  const legacyState = { threads: { fetched_at: "2026-05-01T00:00:00.000Z" } };
  const cursor1 = openCursorFromState(legacyState);
  const run1 = makeRecordingEmit();
  await emitChangedThreads([agg], cursor1, run1.emitRecord);
  cursor1.pruneStale();
  assert.equal(run1.emitted.length, 1, "legacy state forces one-time re-emit (cursor migration cost)");

  const state = persistThreadsState(cursor1);
  const cursor2 = openCursorFromState(state);
  const run2 = makeRecordingEmit();
  await emitChangedThreads([agg], cursor2, run2.emitRecord);
  cursor2.pruneStale();
  assert.equal(run2.emitted.length, 0, "after the migration emit, subsequent runs no-op");
});

test("shared helper hash matches buildThreadFingerprint — wire-compatible with pre-helper STATE", async () => {
  // Critical for migration: a STATE cursor written by a08d7a0a (pre-helper)
  // must continue to gate emits after the helper switch. If these two
  // hashes diverge, every thread re-emits exactly once on first post-deploy
  // run — recoverable but wasteful. They MUST stay equal.
  const agg: ThreadAggregate = {
    id: "T1",
    subject: "Hello",
    participant_set: new Set(["alice@example.com", "bob@example.com"]),
    message_count: 3,
    first_message_date: "2026-05-01T00:00:00.000Z",
    last_message_date: "2026-05-10T00:00:00.000Z",
    labels_set: new Set(["INBOX", "STARRED"]),
    unread_count: 1,
    flagged_count: 0,
    has_attachments: true,
  };
  const cursor = openFingerprintCursor({});
  const run = makeRecordingEmit();
  await emitChangedThreads([agg], cursor, run.emitRecord);
  const helperFp = cursor.toState().T1;
  assert.ok(helperFp, "cursor populated by emitChangedThreads");
  assert.equal(helperFp, buildThreadFingerprint(agg), "hash bytes match the local builder");
});
