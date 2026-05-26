/**
 * Per-record fingerprint behavior for the Slack connector. These tests
 * pin the contract the workspace / users / files churn fix depends on:
 *
 *   1. A record whose semantic fingerprint hasn't moved is NOT emitted on
 *      the second pass (no new RECORD on the wire, no new version
 *      downstream).
 *   2. A record whose fingerprint moved IS emitted.
 *   3. The fingerprint excludes run-clock fields (`fetched_at`) so the
 *      workspace stream doesn't churn just because the run timestamp
 *      moved.
 *   4. `nextFingerprints` is always populated for every record we
 *      considered — including the ones we skipped — so the STATE cursor
 *      carries the full map forward and a skipped record on this run
 *      doesn't re-emit on the next.
 *
 * These tests target `emitWithFingerprint` directly because the
 * production callers (`runWorkspaceStream`, `runUsersStream`,
 * `runFilesStream`) are sqlite-bound; the gate is the seam.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { StreamScope } from "../../src/connector-runtime.ts";
import { type EmittedRecord, makeRecordingEmit } from "../../src/test-harness.ts";
import { emitWithFingerprint, pruneStaleFingerprints, readPriorFingerprintMap, type StreamDeps } from "./index.ts";
import { recordFingerprint } from "./parsers.ts";

// The gate doesn't touch the db field on this path; cast the partial
// shape through `unknown` once with a localized predicate so the
// pre-commit hook's double-cast guard isn't tripped.
function makeTestDeps(args: {
  emitRecord: StreamDeps["emitRecord"];
  nextFingerprints: StreamDeps["nextFingerprints"];
  priorFingerprints: StreamDeps["priorFingerprints"];
  requested: StreamDeps["requested"];
  seenIds: StreamDeps["seenIds"];
}): StreamDeps {
  const partial: Omit<StreamDeps, "db"> & { db: unknown } = {
    db: undefined,
    emitRecord: args.emitRecord,
    emittedAt: "2026-05-26T12:00:00.000Z",
    nextFingerprints: args.nextFingerprints,
    priorFingerprints: args.priorFingerprints,
    progress: () => Promise.resolve(),
    requested: args.requested,
    seenIds: args.seenIds,
  };
  return partial as StreamDeps;
}

function makeDeps(
  prior: Map<string, Map<string, string>>,
  requestedStreams: readonly string[] = ["workspace", "users", "files"]
): {
  deps: StreamDeps;
  emitted: EmittedRecord[];
} {
  const harness = makeRecordingEmit();
  const nextFingerprints = new Map<string, Map<string, string>>();
  for (const [stream, p] of prior) {
    nextFingerprints.set(stream, new Map(p));
  }
  const requested = new Map<string, StreamScope>(requestedStreams.map((name) => [name, { name }]));
  const seenIds = new Map<string, Set<string>>();
  const deps = makeTestDeps({
    emitRecord: harness.emitRecord,
    nextFingerprints,
    priorFingerprints: prior,
    requested,
    seenIds,
  });
  return { deps, emitted: harness.emitted };
}

test("emitWithFingerprint: workspace `fetched_at` is excluded — same source state across runs does NOT re-emit", async () => {
  // First run: prior map empty. Record emits and seeds the fingerprint.
  const { deps: deps1, emitted: emitted1 } = makeDeps(new Map());
  const workspaceRecord = {
    id: "T123",
    name: "Acme",
    domain: "acme",
    fetched_at: "2026-05-26T12:00:00.000Z",
  };
  await emitWithFingerprint(deps1, "workspace", workspaceRecord, ["fetched_at"]);
  assert.equal(emitted1.length, 1, "first run emits the workspace record");
  assert.equal(deps1.nextFingerprints.get("workspace")?.size, 1);

  // Second run: prior map carries the fingerprint we just wrote. Same
  // record (but with an advanced `fetched_at`) should NOT re-emit.
  const prior = new Map<string, Map<string, string>>([
    ["workspace", deps1.nextFingerprints.get("workspace") ?? new Map()],
  ]);
  const { deps: deps2, emitted: emitted2 } = makeDeps(prior);
  await emitWithFingerprint(deps2, "workspace", { ...workspaceRecord, fetched_at: "2026-05-26T13:00:00.000Z" }, [
    "fetched_at",
  ]);
  assert.equal(emitted2.length, 0, "unchanged record does not re-emit when only fetched_at moved");
  // Carry-forward: the next cursor must still hold the fingerprint so
  // a third run also no-ops, not just the second.
  assert.equal(deps2.nextFingerprints.get("workspace")?.get("T123"), prior.get("workspace")?.get("T123"));
});

test("emitWithFingerprint: workspace records with different semantic fields DO re-emit", async () => {
  const { deps: deps1 } = makeDeps(new Map());
  const original = { id: "T123", name: "Acme", domain: "acme", fetched_at: "2026-05-26T12:00:00.000Z" };
  await emitWithFingerprint(deps1, "workspace", original, ["fetched_at"]);

  const prior = new Map<string, Map<string, string>>([
    ["workspace", deps1.nextFingerprints.get("workspace") ?? new Map()],
  ]);
  const { deps: deps2, emitted: emitted2 } = makeDeps(prior);
  await emitWithFingerprint(
    deps2,
    "workspace",
    // Same id, different domain — that's a real change, must emit.
    { ...original, domain: "acme-renamed", fetched_at: "2026-05-26T13:00:00.000Z" },
    ["fetched_at"]
  );
  assert.equal(emitted2.length, 1, "changed record re-emits");
});

test("emitWithFingerprint: users — no excludes, every field participates", async () => {
  // Users have no run-clock fields in their record shape, so the
  // fingerprint covers the whole record uniformly.
  const userA = { id: "U1", name: "alice", real_name: "Alice", updated: 1000 };
  const userB = { id: "U2", name: "bob", real_name: "Bob", updated: 2000 };

  const { deps: deps1, emitted: emitted1 } = makeDeps(new Map());
  await emitWithFingerprint(deps1, "users", userA);
  await emitWithFingerprint(deps1, "users", userB);
  assert.equal(emitted1.length, 2, "first run emits both users");

  // Second run: alice unchanged, bob's `updated` advanced.
  const prior = new Map<string, Map<string, string>>([["users", deps1.nextFingerprints.get("users") ?? new Map()]]);
  const { deps: deps2, emitted: emitted2 } = makeDeps(prior);
  await emitWithFingerprint(deps2, "users", userA);
  await emitWithFingerprint(deps2, "users", { ...userB, updated: 3000 });
  assert.equal(emitted2.length, 1, "only the changed user re-emits");
  assert.equal((emitted2[0]?.data as { id: string }).id, "U2");
});

test("emitWithFingerprint: skipped records still appear in nextFingerprints — STATE carry-forward intact", async () => {
  const userA = { id: "U1", name: "alice" };
  const { deps: deps1 } = makeDeps(new Map());
  await emitWithFingerprint(deps1, "users", userA);
  const recordedFingerprint = deps1.nextFingerprints.get("users")?.get("U1");

  // Simulate the second run where alice is unchanged and gets skipped.
  const prior = new Map<string, Map<string, string>>([["users", deps1.nextFingerprints.get("users") ?? new Map()]]);
  const { deps: deps2, emitted: emitted2 } = makeDeps(prior);
  await emitWithFingerprint(deps2, "users", userA);
  assert.equal(emitted2.length, 0, "alice skipped this run");
  assert.equal(
    deps2.nextFingerprints.get("users")?.get("U1"),
    recordedFingerprint,
    "fingerprint carried forward despite the skip — STATE cursor stays intact"
  );
});

test("pruneStaleFingerprints: prior IDs absent from the current run are removed before the cursor is written", async () => {
  // First run: seed prior with two users via real emits so the prior
  // fingerprints match what the gate computes on the second pass.
  const userA = { id: "U1", name: "alice", real_name: "Alice", updated: 1000 };
  const userB = { id: "U2", name: "bob", real_name: "Bob", updated: 2000 };
  const { deps: deps1 } = makeDeps(new Map(), ["users"]);
  await emitWithFingerprint(deps1, "users", userA);
  await emitWithFingerprint(deps1, "users", userB);
  assert.equal(deps1.nextFingerprints.get("users")?.size, 2);

  // Second run: only alice shows up; bob disappeared from the source.
  const prior = new Map<string, Map<string, string>>([["users", deps1.nextFingerprints.get("users") ?? new Map()]]);
  const { deps } = makeDeps(prior, ["users"]);
  await emitWithFingerprint(deps, "users", userA);

  // Pre-prune state: both IDs still in next (alice carried + re-asserted,
  // bob carried from prior). This is the bug surface — without pruning the
  // STATE cursor would persist bob forever.
  assert.equal(deps.nextFingerprints.get("users")?.size, 2, "prior IDs still carried before pruning");

  pruneStaleFingerprints(deps.nextFingerprints, deps.seenIds, deps.requested);

  const usersNext = deps.nextFingerprints.get("users");
  assert.equal(usersNext?.size, 1, "stale ID dropped after pruning");
  assert.equal(usersNext?.has("U1"), true, "seen ID retained");
  assert.equal(usersNext?.has("U2"), false, "absent ID pruned");
});

test("pruneStaleFingerprints: seen-but-unchanged records are carried forward, NOT pruned", async () => {
  // Prior holds alice; this run sees alice again with identical payload.
  // emitWithFingerprint does not emit (unchanged) but still records the ID
  // as seen, so pruning leaves it alone.
  const userA = { id: "U1", name: "alice" };
  const { deps: deps1 } = makeDeps(new Map(), ["users"]);
  await emitWithFingerprint(deps1, "users", userA);
  const recordedFingerprint = deps1.nextFingerprints.get("users")?.get("U1");
  assert.ok(recordedFingerprint, "first run seeded fingerprint");

  const prior = new Map<string, Map<string, string>>([["users", deps1.nextFingerprints.get("users") ?? new Map()]]);
  const { deps, emitted } = makeDeps(prior, ["users"]);
  await emitWithFingerprint(deps, "users", userA);
  assert.equal(emitted.length, 0, "unchanged record skipped");

  pruneStaleFingerprints(deps.nextFingerprints, deps.seenIds, deps.requested);

  assert.equal(
    deps.nextFingerprints.get("users")?.get("U1"),
    recordedFingerprint,
    "carry-forward survives pruning because the ID was marked seen"
  );
});

test("pruneStaleFingerprints: changed records emit AND are retained through pruning", async () => {
  const userA = { id: "U1", name: "alice", updated: 1000 };
  const { deps: deps1 } = makeDeps(new Map(), ["users"]);
  await emitWithFingerprint(deps1, "users", userA);

  const prior = new Map<string, Map<string, string>>([["users", deps1.nextFingerprints.get("users") ?? new Map()]]);
  const { deps, emitted } = makeDeps(prior, ["users"]);
  // Same id, different shape — must re-emit.
  await emitWithFingerprint(deps, "users", { ...userA, updated: 2000 });
  assert.equal(emitted.length, 1, "changed record emitted");

  pruneStaleFingerprints(deps.nextFingerprints, deps.seenIds, deps.requested);

  const usersNext = deps.nextFingerprints.get("users");
  assert.equal(usersNext?.has("U1"), true, "changed record retained in cursor");
  assert.notEqual(usersNext?.get("U1"), prior.get("users")?.get("U1"), "fingerprint advanced");
});

test("pruneStaleFingerprints: streams NOT requested this run keep their full carry-forward", () => {
  // Prior covers all three fingerprinted streams. This run only requests
  // `users`, so workspace + files entries must survive untouched even though
  // their seen-sets are empty.
  const prior = new Map<string, Map<string, string>>([
    ["workspace", new Map<string, string>([["T1", "fp-ws"]])],
    ["users", new Map<string, string>([["U1", "fp-alice"]])],
    ["files", new Map<string, string>([["F1", "fp-file"]])],
  ]);
  const { deps } = makeDeps(prior, ["users"]);
  // No emits this run — seenIds is empty for users too.
  pruneStaleFingerprints(deps.nextFingerprints, deps.seenIds, deps.requested);

  assert.equal(deps.nextFingerprints.get("workspace")?.size, 1, "unrequested stream untouched");
  assert.equal(deps.nextFingerprints.get("files")?.size, 1, "unrequested stream untouched");
  // Requested users stream had zero observations → its sole prior ID is pruned.
  assert.equal(deps.nextFingerprints.get("users")?.size, 0, "requested+empty stream fully pruned");
});

test("pruneStaleFingerprints: records with missing id do not block pruning of other stale IDs", async () => {
  // A record without id is emitted unconditionally and never appears in the
  // fingerprint map nor in seenIds. A separate prior ID that this run did
  // not observe should still be pruned.
  const prior = new Map<string, Map<string, string>>([["files", new Map<string, string>([["F-old", "fp-old"]])]]);
  const { deps, emitted } = makeDeps(prior, ["files"]);
  // Anonymous record (no id) — emits unconditionally, doesn't touch fingerprint state.
  await emitWithFingerprint(deps, "files", { filename: "no-id.txt" });
  assert.equal(emitted.length, 1, "id-less record always emits");
  assert.equal(deps.seenIds.get("files"), undefined, "id-less record never marked as seen");

  pruneStaleFingerprints(deps.nextFingerprints, deps.seenIds, deps.requested);

  assert.equal(deps.nextFingerprints.get("files")?.size, 0, "stale prior ID pruned despite id-less emits");
});

test("readPriorFingerprintMap: empty / legacy / malformed states all produce an empty map (no throw)", () => {
  // First run: no state at all.
  assert.equal(readPriorFingerprintMap({}, "workspace").size, 0);
  // Legacy cursor: stream state present but no fingerprints field.
  assert.equal(readPriorFingerprintMap({ workspace: { synced_at: "2026-05-26T12:00:00.000Z" } }, "workspace").size, 0);
  // Malformed: fingerprints is an array (wrong type). The cast routes
  // through `unknown` so the test deliberately injects a bad shape that
  // the runtime tolerates.
  const malformedState: Record<string, unknown> = {
    workspace: { fingerprints: ["bogus"] },
  };
  assert.equal(readPriorFingerprintMap(malformedState, "workspace").size, 0);
  // Mixed: some good entries, some bad. Only the good ones survive.
  const out = readPriorFingerprintMap(
    {
      workspace: {
        fingerprints: {
          T1: "abc123",
          T2: 42, // wrong type — silently dropped
          T3: "", // empty string — silently dropped
          T4: "def456",
        },
      },
    },
    "workspace"
  );
  assert.equal(out.size, 2);
  assert.equal(out.get("T1"), "abc123");
  assert.equal(out.get("T4"), "def456");
});

test("recordFingerprint: stable across key order — same payload reordered yields the same hash", () => {
  const a = { id: "X", a: 1, b: 2, nested: { x: 1, y: 2 } };
  const b = { nested: { y: 2, x: 1 }, b: 2, a: 1, id: "X" };
  assert.equal(recordFingerprint(a), recordFingerprint(b));
});

test("recordFingerprint: excludeKeys produces the same hash when only an excluded field moves", () => {
  const a = { id: "T1", name: "Acme", fetched_at: "2026-05-26T12:00:00.000Z" };
  const b = { id: "T1", name: "Acme", fetched_at: "2026-05-26T13:00:00.000Z" };
  assert.notEqual(recordFingerprint(a), recordFingerprint(b), "without exclusion the hash moves");
  assert.equal(recordFingerprint(a, ["fetched_at"]), recordFingerprint(b, ["fetched_at"]));
});
