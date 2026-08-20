// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Focused invariant suite for the ingest -> search-index crash-convergence
// terminal design (see /tmp/ingest-dirty-terminal-0809.md). Covers the
// required invariant set (1)-(3) and (5); invariant (4) (crash/restart
// converges both indexes) is covered by
// semantic-startup-backfill-catches-crash-abandoned-record.test.ts /
// probe-lexical-crash-gap.test.ts, and the generation-fence-specific half of
// (5)/(6) by storage-generation-fence.test.ts.

import assert from "node:assert/strict";
import test from "node:test";
import { registerConnector } from "../server/auth.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { __setRecordIndexFaultHookForTest, ingestRecord, ingestRecords } from "../server/records.ts";
import { __setLexicalBackfillPhaseHookForTest } from "../server/search.ts";
import { runSearchIndexDirtyReconcileRound } from "../server/search-index-reconcile.ts";
import { countDirtySearchIndexScopes, isSearchIndexScopeDirty } from "../server/stores/search-index-dirty-store.ts";

function target(connectorId: string, connectorInstanceId: string) {
  return { connector_id: connectorId, connector_instance_id: connectorInstanceId };
}

function record(stream: string, key: string, subject: string) {
  return {
    data: { id: key, subject },
    emitted_at: "2026-08-09T00:00:00.000Z",
    key,
    stream,
  };
}

function manifestFor(connectorId: string) {
  return {
    capabilities: { human_interaction: [] },
    connector_id: connectorId,
    display_name: connectorId,
    manifest_uri: `https://sources.example/${connectorId}`,
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
        semantics: "mutable_state",
      },
    ],
    version: "0.1.0",
  };
}

test("invariant (2): ack latency does not await a blocked indexer -- single-record path", async () => {
  initDb(":memory:");
  try {
    const connectorId = "inv-ack-latency-single";
    await registerConnector(manifestFor(connectorId));
    const connectorInstanceId = "cin_ack_latency_single";

    // Block the deferred index-maintenance seam indefinitely.
    let unblock: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    __setRecordIndexFaultHookForTest(async (point: string) => {
      if (point === "after-lexical-index") {
        await blocked;
      }
    });

    const start = performance.now();
    const outcome = await ingestRecord(
      target(connectorId, connectorInstanceId),
      record("items", "k1", "should not block the ack")
    );
    const elapsedMs = performance.now() - start;

    assert.equal(outcome.accepted, true, "the durable write is accepted");
    assert.ok(
      elapsedMs < 500,
      `ack returned in ${elapsedMs.toFixed(1)}ms while the indexer was blocked indefinitely -- it must not have awaited it`
    );

    unblock?.();
    __setRecordIndexFaultHookForTest(null);
  } finally {
    __setRecordIndexFaultHookForTest(null);
    closeDb();
  }
});

test("invariant (1): a batch's accepted outcomes are never retroactively rejected by a derived-index failure", async () => {
  initDb(":memory:");
  try {
    const connectorId = "inv-no-retroactive-reject-batch";
    await registerConnector(manifestFor(connectorId));
    const connectorInstanceId = "cin_no_retro_reject_batch";

    __setRecordIndexFaultHookForTest((point: string) => {
      if (point === "after-lexical-index") {
        throw new Error("injected index failure");
      }
    });

    const outcomes = await ingestRecords(target(connectorId, connectorInstanceId), [
      record("items", "k1", "one"),
      record("items", "k2", "two"),
      record("items", "k3", "three"),
    ]);

    assert.deepEqual(
      outcomes.map((o) => o.accepted),
      [true, true, true],
      "every durably-committed record stays accepted even though its derived index write failed"
    );

    __setRecordIndexFaultHookForTest(null);
    // Let the fire-and-forget deferred lane finish (it will fail again with
    // the hook cleared -- no, hook is cleared, so it should now succeed on
    // any retry the reconcile performs; here we just drain the immediate
    // queue microtasks used by the FIFO tail).
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    __setRecordIndexFaultHookForTest(null);
    closeDb();
  }
});

test("invariant (1): a single record's accepted outcome is never retroactively rejected by a derived-index failure", async () => {
  initDb(":memory:");
  try {
    const connectorId = "inv-no-retroactive-reject-single";
    await registerConnector(manifestFor(connectorId));
    const connectorInstanceId = "cin_no_retro_reject_single";

    __setRecordIndexFaultHookForTest((point: string) => {
      if (point === "after-lexical-index") {
        throw new Error("injected index failure");
      }
    });

    const outcome = await ingestRecord(target(connectorId, connectorInstanceId), record("items", "k1", "one"));
    assert.equal(outcome.accepted, true, "the durable write is accepted despite the injected index failure");

    __setRecordIndexFaultHookForTest(null);
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    __setRecordIndexFaultHookForTest(null);
    closeDb();
  }
});

test("invariant (3): normal eventual lexical+semantic convergence with no injected fault", async () => {
  initDb(":memory:");
  try {
    const connectorId = "inv-eventual-convergence";
    await registerConnector(manifestFor(connectorId));
    const connectorInstanceId = "cin_eventual_convergence";

    await ingestRecord(target(connectorId, connectorInstanceId), record("items", "k1", "converges normally"));

    // Deferred index work runs on a per-instance FIFO tail; give it a turn.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const rows = getDb()
      .prepare("SELECT DISTINCT record_key FROM lexical_search_index WHERE connector_instance_id = ?")
      .all(connectorInstanceId) as { record_key: string }[];
    assert.deepEqual(
      rows.map((r) => r.record_key),
      ["k1"],
      "the record converges into the lexical index without any reconcile intervention needed"
    );
  } finally {
    closeDb();
  }
});

test("invariant (5): dirty work is idempotent -- reconciling an already-clean scope is a safe no-op", async () => {
  initDb(":memory:");
  try {
    const connectorId = "inv-idempotent-reconcile";
    await registerConnector(manifestFor(connectorId));
    const connectorInstanceId = "cin_idempotent_reconcile";

    await ingestRecord(target(connectorId, connectorInstanceId), record("items", "k1", "one"));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    // First reconcile round converges (or confirms) the scope.
    const first = await runSearchIndexDirtyReconcileRound({ maxDurationMs: 2000, pageSize: 10 });
    assert.ok(first.attempted >= 0);
    assert.equal(await countDirtySearchIndexScopes(), 0, "scope is clean after the first reconcile round");

    // A second reconcile round over an already-clean backlog must be a
    // pure no-op: nothing to attempt, no error, no re-dirtying.
    const second = await runSearchIndexDirtyReconcileRound({ maxDurationMs: 2000, pageSize: 10 });
    assert.equal(second.attempted, 0, "an empty backlog has nothing to reconcile");
    assert.equal(await countDirtySearchIndexScopes(), 0, "still clean after a no-op reconcile round");

    assert.equal(
      await isSearchIndexScopeDirty({ connectorInstanceId, stream: "items" }),
      false,
      "the scope reports clean via the same store the ack/reconcile paths use"
    );
  } finally {
    closeDb();
  }
});

test("invariant (5): dirty work is BOUNDED -- a reconcile round respects pageSize even with a larger backlog", async () => {
  initDb(":memory:");
  try {
    const connectorId = "inv-bounded-reconcile";
    await registerConnector(manifestFor(connectorId));

    // Three separate connector instances (three separate scopes), each
    // durably dirty from its own ingest, deferred index work never allowed
    // to run (fault hook always throws) so all three stay dirty.
    __setRecordIndexFaultHookForTest(() => {
      throw new Error("keep every scope dirty for this bound test");
    });
    for (const suffix of ["a", "b", "c"]) {
      // biome-ignore lint/performance/noAwaitInLoops: Sequential setup, not the code under test.
      await ingestRecord(target(connectorId, `cin_bounded_${suffix}`), record("items", "k1", "one"));
    }
    __setRecordIndexFaultHookForTest(null);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(await countDirtySearchIndexScopes(), 3, "three independent scopes are dirty");

    const round = await runSearchIndexDirtyReconcileRound({ maxDurationMs: 2000, pageSize: 2 });
    assert.ok(round.attempted <= 2, `bounded round attempted ${round.attempted}, expected <= pageSize (2)`);
    assert.equal(round.incomplete, true, "a backlog larger than pageSize is reported incomplete, not silently dropped");
  } finally {
    __setRecordIndexFaultHookForTest(null);
    closeDb();
  }
});

test("invariant (5): a permanently-failing dirty scope cannot starve a later healthy scope out of every page", async () => {
  initDb(":memory:");
  try {
    const connectorId = "inv-starvation-avoidance";
    await registerConnector(manifestFor(connectorId));

    const brokenInstanceId = "cin_starvation_broken";
    const healthyInstanceId = "cin_starvation_healthy";

    // The broken scope is ingested FIRST, so it is durably the OLDEST dirty
    // scope (lowest marked_at) -- exactly the position that would starve
    // everything behind it under a naive oldest-first-forever ordering.
    await ingestRecord(target(connectorId, brokenInstanceId), record("items", "k1", "will never reconcile"));
    await ingestRecord(target(connectorId, healthyInstanceId), record("items", "k1", "reconciles normally"));

    // Prevent deferred ack-path indexing from clearing the healthy scope's
    // own convergence path from under the assertions below -- both scopes
    // stay dirty until the reconcile round below runs.
    assert.equal(await countDirtySearchIndexScopes(), 2, "both scopes start dirty");

    // Make the backfill phase throw FOR THE BROKEN INSTANCE ONLY, every
    // single time, forever -- simulating a permanently-broken scope (e.g. a
    // structurally invalid stored field value that always throws when
    // reconciled), not a transient blip that would eventually clear on its
    // own.
    __setLexicalBackfillPhaseHookForTest((point, ctx) => {
      if (point === "before-instance-fence" && ctx.connectorInstanceId === brokenInstanceId) {
        throw new Error("permanently broken scope, by design of this test");
      }
    });

    // Page size 1 is deliberately adversarial: with NO starvation
    // avoidance, the broken scope (oldest marked_at) would occupy this
    // single slot on every round forever, and the healthy scope behind it
    // would never even be ATTEMPTED, let alone converge.
    let healthyConverged = false;
    for (let round = 0; round < 10 && !healthyConverged; round += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: Sequential rounds are the thing under test -- each round must observe the previous round's backoff state.
      await runSearchIndexDirtyReconcileRound({ maxDurationMs: 2000, pageSize: 1 });
      healthyConverged = !(await isSearchIndexScopeDirty({ connectorInstanceId: healthyInstanceId, stream: "items" }));
    }

    assert.equal(
      healthyConverged,
      true,
      "the healthy scope must eventually be attempted and converge despite a permanently-failing older scope"
    );
    assert.equal(
      await isSearchIndexScopeDirty({ connectorInstanceId: brokenInstanceId, stream: "items" }),
      true,
      "the broken scope legitimately never converges (it always throws) -- it is starved OUT of contention, not silently fixed"
    );

    const rows = getDb()
      .prepare("SELECT DISTINCT record_key FROM lexical_search_index WHERE connector_instance_id = ?")
      .all(healthyInstanceId) as { record_key: string }[];
    assert.deepEqual(
      rows.map((r) => r.record_key),
      ["k1"],
      "the healthy scope's record actually converged"
    );
  } finally {
    __setLexicalBackfillPhaseHookForTest(null);
    closeDb();
  }
});

test("invariant (5): dirty work does not lie to search while pending -- no partial/uncommitted rows are ever visible", async () => {
  initDb(":memory:");
  try {
    const connectorId = "inv-no-lying-to-search";
    await registerConnector(manifestFor(connectorId));
    const connectorInstanceId = "cin_no_lying_to_search";

    // Block the deferred lexical index write indefinitely.
    let unblock: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    __setRecordIndexFaultHookForTest(async (point: string) => {
      if (point === "after-lexical-index") {
        await blocked;
      }
    });

    await ingestRecord(target(connectorId, connectorInstanceId), record("items", "k1", "pending indexing"));

    // While the deferred job is blocked mid-flight, the lexical index table
    // must show EITHER nothing for this key (not yet written) or the
    // complete row (already written) -- never a partial/uncommitted
    // intermediate state a concurrent /v1/search read could observe.
    const rowsWhilePending = getDb()
      .prepare("SELECT record_key, field, text FROM lexical_search_index WHERE connector_instance_id = ?")
      .all(connectorInstanceId) as { field: string; record_key: string; text: string }[];
    for (const row of rowsWhilePending) {
      assert.equal(row.record_key, "k1");
      assert.equal(row.field, "subject");
      assert.equal(row.text, "pending indexing", "any visible row is the COMPLETE value, never a partial write");
    }

    unblock?.();
    __setRecordIndexFaultHookForTest(null);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const rowsAfter = getDb()
      .prepare("SELECT record_key, text FROM lexical_search_index WHERE connector_instance_id = ?")
      .all(connectorInstanceId) as { record_key: string; text: string }[];
    assert.deepEqual(rowsAfter, [{ record_key: "k1", text: "pending indexing" }]);
  } finally {
    __setRecordIndexFaultHookForTest(null);
    closeDb();
  }
});
