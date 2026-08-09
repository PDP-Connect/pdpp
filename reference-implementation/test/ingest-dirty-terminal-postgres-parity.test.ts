// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Invariant (6): SQLite/Postgres parity for the ingest -> search-index
// crash-convergence terminal design. Skips (does not fail) when no
// PDPP_TEST_POSTGRES_URL is configured, matching this repo's existing
// Postgres-profile test convention (see client-connector-postgres-path.test.ts).
//
// Run:
//   PDPP_TEST_POSTGRES_URL=postgresql://postgres:postgres@127.0.0.1:PORT/pdpp_test \
//     node --test --import tsx test/ingest-dirty-terminal-postgres-parity.test.ts

import assert from "node:assert/strict";
import test from "node:test";
import { registerConnector } from "../server/auth.ts";
import { closeDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { ingestRecord } from "../server/records.ts";
import { __setLexicalBackfillPhaseHookForTest } from "../server/search.ts";
import { runSearchIndexDirtyReconcileRound } from "../server/search-index-reconcile.ts";
import { countDirtySearchIndexScopes, isSearchIndexScopeDirty } from "../server/stores/search-index-dirty-store.ts";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

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
      },
    ],
  };
}

if (POSTGRES_URL) {
  test.before(async () => {
    initDb(":memory:");
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
  });

  test.after(async () => {
    await closePostgresStorage();
    closeDb();
  });

  test("Postgres: the write-time scope-dirty mark is written atomically inside postgresIngestRecord's own transaction", async () => {
    const connectorId = "inv-pg-write-time-mark";
    await registerConnector(manifestFor(connectorId));
    const connectorInstanceId = "cin_pg_write_time_mark";

    await ingestRecord(target(connectorId, connectorInstanceId), record("items", "k1", "postgres backend"));

    const dirtyRow = await postgresQuery<{ connector_id: string; dirty: number }>(
      "SELECT connector_id, dirty FROM search_index_dirty WHERE connector_instance_id = $1 AND stream = $2",
      [connectorInstanceId, "items"]
    );
    assert.equal(dirtyRow.rows.length, 1, "the scope-dirty row exists on Postgres, same schema as SQLite");
    assert.equal(dirtyRow.rows[0]?.dirty, 1);
    assert.equal(dirtyRow.rows[0]?.connector_id, connectorId);
  });

  test("Postgres: ack does not await the deferred indexer, and eventual convergence still happens", async () => {
    const connectorId = "inv-pg-ack-and-convergence";
    await registerConnector(manifestFor(connectorId));
    const connectorInstanceId = "cin_pg_ack_convergence";

    const start = performance.now();
    const outcome = await ingestRecord(target(connectorId, connectorInstanceId), record("items", "k1", "fast ack"));
    const elapsedMs = performance.now() - start;
    assert.equal(outcome.accepted, true);
    assert.ok(elapsedMs < 2000, `ack took ${elapsedMs.toFixed(1)}ms`);

    // Let the fire-and-forget deferred lane run, then confirm the lexical
    // index actually converged (same eventual-convergence invariant as
    // SQLite, invariant (3)).
    await new Promise((resolve) => setTimeout(resolve, 200));
    const indexRows = await postgresQuery<{ record_key: string }>(
      "SELECT DISTINCT record_key FROM lexical_search_index WHERE connector_instance_id = $1",
      [connectorInstanceId]
    );
    assert.deepEqual(
      indexRows.rows.map((r) => r.record_key),
      ["k1"],
      "the record converges into the Postgres lexical index without reconcile intervention"
    );
  });

  test("Postgres: crash-abandoned record (deferIndexes: true) converges via the bounded reconcile round", async () => {
    const connectorId = "inv-pg-crash-convergence";
    await registerConnector(manifestFor(connectorId));
    const connectorInstanceId = "cin_pg_crash_convergence";

    // Simulates a crash between durable commit and background index
    // maintenance: deferIndexes skips the inline call but the durable
    // scope-dirty mark still lands (unconditional, same transaction).
    await ingestRecord(target(connectorId, connectorInstanceId), record("items", "k1", "crash abandoned"), {
      deferIndexes: true,
    });

    assert.equal(
      await isSearchIndexScopeDirty({ connectorInstanceId, stream: "items" }),
      true,
      "this scope is durably dirty on Postgres"
    );

    // Loop bounded rounds until the whole backlog (this scope plus any
    // still-settling scopes from earlier tests sharing this DB) drains,
    // rather than assuming this is the only dirty scope in the database.
    // biome-ignore lint/performance/noAwaitInLoops: Draining a bounded backlog to completion for the assertion below.
    for (let round = 0; round < 10 && (await countDirtySearchIndexScopes()) > 0; round += 1) {
      await runSearchIndexDirtyReconcileRound({ maxDurationMs: 5000, pageSize: 10 });
    }
    assert.equal(
      await isSearchIndexScopeDirty({ connectorInstanceId, stream: "items" }),
      false,
      "reconcile clears THIS scope's dirty flag on Postgres"
    );

    const indexRows = await postgresQuery<{ record_key: string }>(
      "SELECT DISTINCT record_key FROM lexical_search_index WHERE connector_instance_id = $1",
      [connectorInstanceId]
    );
    assert.deepEqual(
      indexRows.rows.map((r) => r.record_key),
      ["k1"]
    );
  });

  test("Postgres: a permanently-failing dirty scope cannot starve a later healthy scope out of every page (backoff/starvation parity with SQLite)", async () => {
    const connectorId = "inv-pg-starvation-avoidance";
    await registerConnector(manifestFor(connectorId));

    const brokenInstanceId = "cin_pg_starvation_broken";
    const healthyInstanceId = "cin_pg_starvation_healthy";

    // The broken scope is ingested FIRST, so it is durably the OLDEST dirty
    // scope (lowest marked_at) on Postgres too -- exactly the position that
    // would starve everything behind it under a naive oldest-first-forever
    // ordering. Mirrors the SQLite adversarial test in
    // ingest-dirty-terminal-invariants.test.ts.
    await ingestRecord(target(connectorId, brokenInstanceId), record("items", "k1", "will never reconcile"), {
      deferIndexes: true,
    });
    await ingestRecord(target(connectorId, healthyInstanceId), record("items", "k1", "reconciles normally"), {
      deferIndexes: true,
    });

    assert.equal(await isSearchIndexScopeDirty({ connectorInstanceId: brokenInstanceId, stream: "items" }), true);
    assert.equal(await isSearchIndexScopeDirty({ connectorInstanceId: healthyInstanceId, stream: "items" }), true);

    // Make the backfill phase throw FOR THE BROKEN INSTANCE ONLY, every
    // single time, forever -- simulating a permanently-broken scope, not a
    // transient blip that would eventually clear on its own. This hook is
    // process-global (not backend-specific), so it applies to the Postgres
    // code path exactly as it does to SQLite.
    __setLexicalBackfillPhaseHookForTest((point, ctx) => {
      if (point === "before-instance-fence" && ctx.connectorInstanceId === brokenInstanceId) {
        throw new Error("permanently broken scope, by design of this test");
      }
    });

    try {
      // Page size 1 is deliberately adversarial: with NO starvation
      // avoidance, the broken scope (oldest marked_at) would occupy this
      // single slot on every round forever, and the healthy scope behind it
      // would never even be ATTEMPTED, let alone converge -- on Postgres's
      // own next_attempt_at/attempts columns and backoff CASE expression,
      // not just SQLite's.
      let healthyConverged = false;
      for (let round = 0; round < 10 && !healthyConverged; round += 1) {
        // biome-ignore lint/performance/noAwaitInLoops: Sequential rounds are the thing under test -- each round must observe the previous round's backoff state.
        await runSearchIndexDirtyReconcileRound({ maxDurationMs: 5000, pageSize: 1 });
        healthyConverged = !(await isSearchIndexScopeDirty({
          connectorInstanceId: healthyInstanceId,
          stream: "items",
        }));
      }

      assert.equal(
        healthyConverged,
        true,
        "the healthy scope must eventually be attempted and converge on Postgres despite a permanently-failing older scope"
      );
      assert.equal(
        await isSearchIndexScopeDirty({ connectorInstanceId: brokenInstanceId, stream: "items" }),
        true,
        "the broken scope legitimately never converges (it always throws) -- it is starved OUT of contention, not silently fixed"
      );

      const rows = await postgresQuery<{ record_key: string }>(
        "SELECT DISTINCT record_key FROM lexical_search_index WHERE connector_instance_id = $1",
        [healthyInstanceId]
      );
      assert.deepEqual(
        rows.rows.map((r) => r.record_key),
        ["k1"],
        "the healthy scope's record actually converged on Postgres"
      );

      const brokenRow = await postgresQuery<{ attempts: number; next_attempt_at: string | null }>(
        "SELECT attempts, next_attempt_at FROM search_index_dirty WHERE connector_instance_id = $1 AND stream = $2",
        [brokenInstanceId, "items"]
      );
      assert.ok((brokenRow.rows[0]?.attempts ?? 0) > 0, "the broken scope's attempts counter advanced on Postgres");
      assert.ok(
        brokenRow.rows[0]?.next_attempt_at,
        "the broken scope's next_attempt_at was set on Postgres, same atomic-backoff shape as SQLite"
      );
    } finally {
      __setLexicalBackfillPhaseHookForTest(null);
    }
  });
} else {
  test("SQLite/Postgres parity for the search-index dirty flag -- SKIPPED (set PDPP_TEST_POSTGRES_URL to run)", () => {
    // Intentionally passes without asserting anything: this repo's
    // Postgres-profile tests are opt-in, not a hard CI requirement, per
    // the existing client-connector-postgres-path.test.ts convention.
  });
}
