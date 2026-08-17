// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Discriminating test for the storage-generation fence (server/storage-generation.ts)
// and its generation-scoped index-work admission accounting (records.ts).
//
// Two invariants under test, both flagged as real risks by review before this
// test existed:
//
//  1. An old-generation deferred index job that is still computing when
//     storage closes/reinitializes must never touch the NEW generation's
//     storage, and its eventual release() must never decrement the NEW
//     generation's admission counter (a naive shared counter would let an
//     unrelated old job's completion silently free up "capacity" the new
//     generation never actually had free).
//  2. The durable per-scope dirty marker (search_index_dirty) survives a
//     close+reinit against the SAME on-disk file (not :memory:, so this is a
//     genuine persistence proof, not just an in-process state carryover) and
//     a bounded reconcile round on the NEW generation still converges it --
//     proving the fence drops the stale job WITHOUT losing crash-convergence.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerConnector } from "../server/auth.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import {
  ingestRecord,
  recordIndexWorkStatsForGenerationForTests,
  recordIndexWorkStatsForTests,
  withRecordIndexWorkForGenerationForTests,
} from "../server/records.ts";
import { runSearchIndexDirtyReconcileRound } from "../server/search-index-reconcile.ts";
import { bumpStorageGeneration, currentStorageGeneration } from "../server/storage-generation.ts";
import { countDirtySearchIndexScopes } from "../server/stores/search-index-dirty-store.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  assert.ok(resolve, "Promise executor runs synchronously, so resolve is always assigned here");
  return { promise, resolve };
}

test("generation-scoped admission: an old generation's release never decrements the new generation's counter", async () => {
  const oldGeneration = currentStorageGeneration();
  const oldHeld = deferred();
  const oldRelease = deferred();
  // Simulates a deferred index job that was scheduled under `oldGeneration`
  // and is still mid-flight (holding its admission permit) when storage
  // moves to a new generation.
  const oldJob = withRecordIndexWorkForGenerationForTests(oldGeneration, async () => {
    oldHeld.resolve();
    await oldRelease.promise;
  });
  await oldHeld.promise;
  assert.deepEqual(
    recordIndexWorkStatsForGenerationForTests(oldGeneration),
    { active: 1, queued: 0 },
    "old generation shows its own job as active"
  );

  const newGeneration = bumpStorageGeneration();
  assert.notEqual(newGeneration, oldGeneration, "bump actually advances the epoch");
  assert.deepEqual(
    recordIndexWorkStatsForTests(),
    { active: 0, queued: 0 },
    "the NEW generation starts with a clean admission bucket, unaffected by the old generation's in-flight job"
  );

  // A new-generation job acquires and holds its own permit concurrently
  // with the still-running old-generation job.
  const newHeld = deferred();
  const newRelease = deferred();
  const newJob = withRecordIndexWorkForGenerationForTests(newGeneration, async () => {
    newHeld.resolve();
    await newRelease.promise;
  });
  await newHeld.promise;
  assert.deepEqual(
    recordIndexWorkStatsForTests(),
    { active: 1, queued: 0 },
    "the new generation's own job is admitted independently of the old generation's state"
  );

  // Release the OLD job first. If accounting were a single shared counter,
  // this decrement would corrupt the NEW generation's bucket (e.g. driving
  // it to 0 while the new job is still genuinely running, or freeing a
  // slot the new generation never had taken).
  oldRelease.resolve();
  await oldJob;
  assert.deepEqual(
    recordIndexWorkStatsForGenerationForTests(oldGeneration),
    { active: 0, queued: 0 },
    "the old generation's own bucket drains to zero on its own job's completion"
  );
  assert.deepEqual(
    recordIndexWorkStatsForTests(),
    { active: 1, queued: 0 },
    "the NEW generation's admission count is UNCHANGED by the old generation's release -- no cross-generation decrement"
  );

  newRelease.resolve();
  await newJob;
  assert.deepEqual(recordIndexWorkStatsForTests(), { active: 0, queued: 0 }, "new generation drains on its own job");
});

test("close+reinit: a stale-generation deferred job never touches the new database, and its durable dirty marker still converges", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-storage-generation-fence-"));
  const dbPath = join(dir, "pdpp.sqlite");
  try {
    initDb(dbPath);
    const manifest = {
      capabilities: { human_interaction: [] },
      connector_id: "generation-fence-probe",
      display_name: "Generation fence probe",
      manifest_uri: "https://registry.pdpp.dev/connectors/generation-fence-probe",
      protocol_version: "0.1.0",
      streams: [
        {
          name: "items",
          primary_key: ["id"],
          query: { search: { lexical_fields: ["subject"] } },
          schema: {
            properties: { id: { type: "string" }, subject: { type: "string" } },
            required: ["id", "subject"],
            type: "object",
          },
          selection: { fields: true, resources: true },
          semantics: "append_only",
        },
      ],
      version: "0.1.0",
    };
    await registerConnector(manifest);

    const connectorInstanceId = "cin_generation_fence_a";
    const target = { connector_id: "generation-fence-probe", connector_instance_id: connectorInstanceId };

    // Ingest with the fire-and-forget index maintenance held open via the
    // shared admission gate at limit 1, so its scheduled deferred job is
    // guaranteed still queued/running when we close the DB out from under
    // it -- deterministic, not a timing race.
    const previousLimit = process.env.PDPP_INGEST_INDEX_WORK_LIMIT;
    process.env.PDPP_INGEST_INDEX_WORK_LIMIT = "1";
    const preGeneration = currentStorageGeneration();
    const heldPermit = deferred();
    const releasePermit = deferred();
    const blocker = withRecordIndexWorkForGenerationForTests(preGeneration, async () => {
      heldPermit.resolve();
      await releasePermit.promise;
    });
    await heldPermit.promise;

    await ingestRecord(target, {
      data: { id: "k1", subject: "never actually indexed before restart" },
      emitted_at: "2026-08-09T00:00:00.000Z",
      key: "k1",
      stream: "items",
    });

    // The durable dirty mark is written INSIDE the record's own commit
    // transaction (unconditional), so it exists now even though the
    // deferred index-maintenance job for this key is still queued behind
    // `blocker`'s held permit.
    assert.equal(await countDirtySearchIndexScopes(), 1, "the scope is durably marked dirty at commit time");

    // "Restart": close this database file and open a FRESH handle to the
    // SAME file, simulating a process crash/restart. The scheduled deferred
    // job for k1's index maintenance captured `preGeneration` and is still
    // sitting behind `blocker` in the per-instance FIFO tail.
    closeDb();
    const postGeneration = currentStorageGeneration();
    assert.notEqual(postGeneration, preGeneration, "closeDb() advanced the storage generation");
    initDb(dbPath);
    assert.notEqual(
      currentStorageGeneration(),
      preGeneration,
      "the record's deferred job's captured generation is now stale"
    );

    // Now let the old-generation blocker (and, transitively, the queued k1
    // deferred job behind it) proceed. The k1 job's own re-check inside
    // scheduleRecordIndexMaintenance must see the generation mismatch and
    // drop the work WITHOUT calling into records.ts's SQLite helpers against
    // the just-reopened handle.
    releasePermit.resolve();
    await blocker;

    // Give the FIFO-tail-queued k1 job a turn to run (and be fenced) before
    // asserting. It was scheduled via enqueueConnectorInstanceIndexWork
    // behind the same-instance blocker permit above.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    // The reopened database must be untouched by the stale job: it should
    // still show ZERO lexical index rows for k1 (the stale job never wrote
    // to it), while the record itself persisted on disk across the restart.
    const liveRecord = getDb()
      .prepare("SELECT record_json FROM records WHERE connector_instance_id = ? AND stream = ? AND record_key = ?")
      .get(connectorInstanceId, "items", "k1");
    assert.ok(liveRecord, "the durable record survived the close+reinit against the same file");
    const indexRowsBeforeReconcile = getDb()
      .prepare("SELECT COUNT(*) AS n FROM lexical_search_index WHERE connector_instance_id = ?")
      .get(connectorInstanceId) as { n: number };
    assert.equal(
      indexRowsBeforeReconcile.n,
      0,
      "the stale-generation job did not write to the reopened database's lexical index"
    );

    // The durable dirty marker survived the close+reinit (it is a normal
    // row in the same SQLite file, not process memory) -- this is what lets
    // the NEW generation's own reconcile converge k1 without ever needing
    // the dropped stale job to have run.
    assert.equal(
      await countDirtySearchIndexScopes(),
      1,
      "the durable dirty marker survived the close+reinit against the same on-disk file"
    );

    const round = await runSearchIndexDirtyReconcileRound({ maxDurationMs: 5000, pageSize: 10 });
    assert.equal(round.succeeded, 1, "the new generation's reconcile round processes the surviving dirty scope");
    assert.equal(await countDirtySearchIndexScopes(), 0, "reconcile clears the dirty flag once converged");

    const indexRowsAfterReconcile = getDb()
      .prepare("SELECT DISTINCT record_key FROM lexical_search_index WHERE connector_instance_id = ?")
      .all(connectorInstanceId) as { record_key: string }[];
    assert.deepEqual(
      indexRowsAfterReconcile.map((row) => row.record_key),
      ["k1"],
      "k1 converges into the lexical index via the NEW generation's reconcile, not the dropped stale job"
    );

    if (previousLimit === undefined) {
      delete process.env.PDPP_INGEST_INDEX_WORK_LIMIT;
    } else {
      process.env.PDPP_INGEST_INDEX_WORK_LIMIT = previousLimit;
    }
  } finally {
    closeDb();
    rmSync(dir, { force: true, recursive: true });
  }
});
