/**
 * Slack-level integration of the shared per-record fingerprint cursor. The
 * generic cursor behavior is covered exhaustively in
 * `src/fingerprint-cursor.test.ts`; this file pins the Slack-specific wiring:
 *
 *   1. Workspace excludes `fetched_at` from change detection so the run
 *      timestamp moving does NOT re-emit the workspace record.
 *   2. Users/files cover the full record (no excludes) and re-emit on any
 *      source-field change.
 *   3. The per-stream emit helper carries the fingerprint forward even when
 *      it suppresses the emit (STATE carry-forward intact across no-op
 *      runs).
 *   4. Prune happens per-stream and only for streams the run requested.
 *      An unrequested stream's cursor keeps its full carry-forward.
 *   5. Anonymous records (no id) always emit and never touch cursor state.
 *
 * These tests target `emitWithFingerprint` directly because the production
 * callers (`runWorkspaceStream`, `runUsersStream`, `runFilesStream`) are
 * sqlite-bound; the gate is the seam.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { StreamScope } from "../../src/connector-runtime.ts";
import { type FingerprintCursor, openFingerprintCursor } from "../../src/fingerprint-cursor.ts";
import { type EmittedRecord, makeRecordingEmit } from "../../src/test-harness.ts";
import { emitWithFingerprint, FINGERPRINT_EXCLUDE, FINGERPRINTED_STREAMS, type StreamDeps } from "./index.ts";

interface SlackTestHarness {
  cursors: Map<string, FingerprintCursor>;
  deps: StreamDeps;
  emitted: EmittedRecord[];
}

function makeHarness(
  priorCursors: Partial<Record<(typeof FINGERPRINTED_STREAMS)[number], Record<string, string>>> = {},
  requestedStreams: readonly string[] = ["workspace", "users", "files"]
): SlackTestHarness {
  const recording = makeRecordingEmit();
  const cursors = new Map<string, FingerprintCursor>();
  for (const stream of FINGERPRINTED_STREAMS) {
    cursors.set(
      stream,
      openFingerprintCursor(
        { fingerprints: priorCursors[stream] ?? {} },
        { excludeFromFingerprint: FINGERPRINT_EXCLUDE[stream] }
      )
    );
  }
  const requested = new Map<string, StreamScope>(requestedStreams.map((n) => [n, { name: n }]));
  // The gate doesn't touch the db field on this path; cast the partial
  // shape through `unknown` once so the pre-commit hook's double-cast
  // guard isn't tripped.
  const partial: Omit<StreamDeps, "db"> & { db: unknown } = {
    db: undefined,
    emitRecord: recording.emitRecord,
    emittedAt: "2026-05-26T12:00:00.000Z",
    fingerprintCursors: cursors,
    progress: () => Promise.resolve(),
    requested,
  };
  return { cursors, deps: partial as StreamDeps, emitted: recording.emitted };
}

function pruneRequested(harness: SlackTestHarness): void {
  for (const stream of FINGERPRINTED_STREAMS) {
    if (harness.deps.requested.has(stream)) {
      harness.cursors.get(stream)?.pruneStale();
    }
  }
}

test("workspace: fetched_at is excluded — same source state across runs does NOT re-emit", async () => {
  const workspaceRecord = {
    id: "T123",
    name: "Acme",
    domain: "acme",
    fetched_at: "2026-05-26T12:00:00.000Z",
  };

  const run1 = makeHarness();
  await emitWithFingerprint(run1.deps, "workspace", workspaceRecord);
  assert.equal(run1.emitted.length, 1, "first run emits the workspace record");
  const priorState = run1.cursors.get("workspace")?.toState() ?? {};

  const run2 = makeHarness({ workspace: priorState });
  await emitWithFingerprint(run2.deps, "workspace", { ...workspaceRecord, fetched_at: "2026-05-26T13:00:00.000Z" });
  assert.equal(run2.emitted.length, 0, "unchanged record does not re-emit when only fetched_at moved");
  // Carry-forward: next cursor still holds the fingerprint so a third
  // run also no-ops.
  assert.equal(run2.cursors.get("workspace")?.toState().T123, priorState.T123);
});

test("workspace: real source change DOES re-emit", async () => {
  const original = { id: "T123", name: "Acme", domain: "acme", fetched_at: "2026-05-26T12:00:00.000Z" };
  const run1 = makeHarness();
  await emitWithFingerprint(run1.deps, "workspace", original);
  const priorState = run1.cursors.get("workspace")?.toState() ?? {};

  const run2 = makeHarness({ workspace: priorState });
  await emitWithFingerprint(run2.deps, "workspace", {
    ...original,
    domain: "acme-renamed",
    fetched_at: "2026-05-26T13:00:00.000Z",
  });
  assert.equal(run2.emitted.length, 1, "changed record re-emits");
});

test("wiring: channel_memberships is in the production fingerprinted set with fetched_at excluded", () => {
  // This pins the production wiring, not just the gate logic. The gate
  // (`emitWithFingerprint`) is generic over any stream that has a cursor;
  // the load-bearing fact is that `runChannelMembershipsStream` routes
  // through it AND the bootstrap/STATE loops include the stream. Dropping
  // `channel_memberships` from FINGERPRINTED_STREAMS (the original deferral)
  // resurfaces the per-run `fetched_at` churn — this assertion fails first.
  assert.ok(
    (FINGERPRINTED_STREAMS as readonly string[]).includes("channel_memberships"),
    "channel_memberships must be fingerprinted to stop per-run fetched_at churn"
  );
  assert.deepEqual(
    FINGERPRINT_EXCLUDE.channel_memberships,
    ["fetched_at"],
    "channel_memberships must exclude the run-clock field from change detection"
  );
});

test("wiring: channels is in the production fingerprinted set (no excludes — structural fields gate cleanly)", () => {
  // pins the point-in-time-streams split: channels entity record no longer
  // contains num_members, so its fingerprint covers only structural fields.
  // Dropping channels from FINGERPRINTED_STREAMS re-enables full-resync churn.
  assert.ok(
    (FINGERPRINTED_STREAMS as readonly string[]).includes("channels"),
    "channels must be fingerprinted after the point-in-time-streams split"
  );
  assert.deepEqual(
    FINGERPRINT_EXCLUDE.channels,
    [],
    "channels has no run-clock fields — full-record fingerprint is correct"
  );
});

test("channel_memberships: fetched_at is excluded — a stable membership does NOT re-emit", async () => {
  // The record body is `{id, channel_id, user_id, fetched_at}` where
  // fetched_at is the run clock. Before this stream was fingerprinted, the
  // moving fetched_at forced a brand-new version of every membership on
  // every run — this stream grew into the largest churn stream by absolute
  // history volume. With fetched_at excluded the fingerprint is stable, so
  // an unchanged membership set produces zero re-emits.
  const membership = {
    id: "C1:U1",
    channel_id: "C1",
    user_id: "U1",
    fetched_at: "2026-05-26T12:00:00.000Z",
  };

  const run1 = makeHarness({}, ["channel_memberships"]);
  await emitWithFingerprint(run1.deps, "channel_memberships", membership);
  assert.equal(run1.emitted.length, 1, "first run emits the membership");
  const priorState = run1.cursors.get("channel_memberships")?.toState() ?? {};

  const run2 = makeHarness({ channel_memberships: priorState }, ["channel_memberships"]);
  await emitWithFingerprint(run2.deps, "channel_memberships", {
    ...membership,
    fetched_at: "2026-05-27T12:00:00.000Z",
  });
  assert.equal(run2.emitted.length, 0, "an unchanged membership does not re-emit when only fetched_at moved");
});

test("channel_memberships: a newly-added membership DOES emit", async () => {
  // The membership set is the source fact. A new (channel, user) pair is a
  // real change and must produce a version; only redundant re-emits of the
  // same pair are suppressed.
  const existing = { id: "C1:U1", channel_id: "C1", user_id: "U1", fetched_at: "2026-05-26T12:00:00.000Z" };
  const run1 = makeHarness({}, ["channel_memberships"]);
  await emitWithFingerprint(run1.deps, "channel_memberships", existing);
  const priorState = run1.cursors.get("channel_memberships")?.toState() ?? {};

  const run2 = makeHarness({ channel_memberships: priorState }, ["channel_memberships"]);
  await emitWithFingerprint(run2.deps, "channel_memberships", {
    ...existing,
    fetched_at: "2026-05-27T12:00:00.000Z",
  });
  await emitWithFingerprint(run2.deps, "channel_memberships", {
    id: "C1:U2",
    channel_id: "C1",
    user_id: "U2",
    fetched_at: "2026-05-27T12:00:00.000Z",
  });
  assert.equal(run2.emitted.length, 1, "only the newly-added membership re-emits");
  assert.equal((run2.emitted[0]?.data as { id: string }).id, "C1:U2");
});

test("channel_memberships: a removed membership is pruned from carry-forward", async () => {
  // When a user leaves a channel the pair disappears from CHANNEL_USER.
  // Prune drops the stale fingerprint so the cursor reflects the live set
  // and the pair re-emits if the user rejoins later.
  const prior = { "C1:U1": "fp-1", "C1:U2": "fp-2" };
  const run = makeHarness({ channel_memberships: prior }, ["channel_memberships"]);
  // Only C1:U1 observed this run; C1:U2 left the channel.
  await emitWithFingerprint(run.deps, "channel_memberships", {
    id: "C1:U1",
    channel_id: "C1",
    user_id: "U1",
    fetched_at: "2026-05-27T12:00:00.000Z",
  });
  pruneRequested(run);
  const post = run.cursors.get("channel_memberships")?.toState() ?? {};
  assert.equal(post["C1:U1"] !== undefined, true, "still-present membership retained");
  assert.equal(post["C1:U2"], undefined, "departed membership pruned");
});

test("users: no excludes — every field participates in the fingerprint", async () => {
  const userA = { id: "U1", name: "alice", real_name: "Alice", updated: 1000 };
  const userB = { id: "U2", name: "bob", real_name: "Bob", updated: 2000 };

  const run1 = makeHarness();
  await emitWithFingerprint(run1.deps, "users", userA);
  await emitWithFingerprint(run1.deps, "users", userB);
  assert.equal(run1.emitted.length, 2, "first run emits both users");

  const prior = run1.cursors.get("users")?.toState() ?? {};
  const run2 = makeHarness({ users: prior });
  await emitWithFingerprint(run2.deps, "users", userA);
  await emitWithFingerprint(run2.deps, "users", { ...userB, updated: 3000 });
  assert.equal(run2.emitted.length, 1, "only the changed user re-emits");
  assert.equal((run2.emitted[0]?.data as { id: string }).id, "U2");
});

test("skipped records still appear in the cursor — STATE carry-forward intact", async () => {
  const userA = { id: "U1", name: "alice" };

  const run1 = makeHarness();
  await emitWithFingerprint(run1.deps, "users", userA);
  const seededFp = run1.cursors.get("users")?.toState().U1;
  assert.ok(seededFp);

  const run2 = makeHarness({ users: run1.cursors.get("users")?.toState() ?? {} });
  await emitWithFingerprint(run2.deps, "users", userA);
  assert.equal(run2.emitted.length, 0, "alice skipped this run");
  assert.equal(
    run2.cursors.get("users")?.toState().U1,
    seededFp,
    "fingerprint carried forward despite the skip — STATE cursor stays intact"
  );
});

test("prune: prior IDs absent from the current run are removed when the stream was requested", async () => {
  // Seed: two users.
  const userA = { id: "U1", name: "alice", real_name: "Alice", updated: 1000 };
  const userB = { id: "U2", name: "bob", real_name: "Bob", updated: 2000 };
  const run1 = makeHarness({}, ["users"]);
  await emitWithFingerprint(run1.deps, "users", userA);
  await emitWithFingerprint(run1.deps, "users", userB);
  assert.equal(Object.keys(run1.cursors.get("users")?.toState() ?? {}).length, 2);

  // Second run: only alice. Bob disappeared from the source.
  const prior = run1.cursors.get("users")?.toState() ?? {};
  const run2 = makeHarness({ users: prior }, ["users"]);
  await emitWithFingerprint(run2.deps, "users", userA);
  // Pre-prune: both IDs still in the cursor.
  assert.equal(Object.keys(run2.cursors.get("users")?.toState() ?? {}).length, 2, "carry-forward keeps bob pre-prune");

  pruneRequested(run2);

  const post = run2.cursors.get("users")?.toState() ?? {};
  assert.equal(Object.keys(post).length, 1, "stale ID dropped");
  assert.equal(post.U1 !== undefined, true, "seen ID retained");
  assert.equal(post.U2, undefined, "absent ID pruned");
});

test("prune: streams NOT requested this run keep their full carry-forward", () => {
  // Prior covers all three fingerprinted streams; this run only requests
  // `users`, so workspace + files entries must survive untouched.
  const run = makeHarness(
    {
      workspace: { T1: "fp-ws" },
      users: { U1: "fp-alice" },
      files: { F1: "fp-file" },
    },
    ["users"]
  );
  // No emits this run — seen set is empty for users too.
  pruneRequested(run);

  assert.equal(
    Object.keys(run.cursors.get("workspace")?.toState() ?? {}).length,
    1,
    "unrequested workspace stream untouched"
  );
  assert.equal(Object.keys(run.cursors.get("files")?.toState() ?? {}).length, 1, "unrequested files stream untouched");
  // Requested users stream had zero observations → its sole prior ID is pruned.
  assert.equal(Object.keys(run.cursors.get("users")?.toState() ?? {}).length, 0, "requested+empty stream fully pruned");
});

test("anonymous records (no id) emit unconditionally and do not touch the cursor", async () => {
  const run = makeHarness({ files: { "F-old": "fp-old" } }, ["files"]);
  await emitWithFingerprint(run.deps, "files", { filename: "no-id.txt" });
  assert.equal(run.emitted.length, 1, "id-less record always emits");

  pruneRequested(run);
  assert.equal(
    Object.keys(run.cursors.get("files")?.toState() ?? {}).length,
    0,
    "stale prior ID pruned despite id-less emits"
  );
});
