// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Production incident, 2026-08-21: the owner's source-detail page took 44.5s
 * while a Google Maps re-ingest ran concurrently.
 *
 * The keyset-pagination shape both the source-detail page and the semantic
 * backfill's coverage scan issue --
 *
 *   SELECT id, record_key, ... FROM records
 *    WHERE connector_instance_id = $1 AND stream = $2 AND deleted = FALSE
 *      AND id > $3
 *    ORDER BY id ASC LIMIT $4
 *
 * -- had NO index able to serve it. All seven of `records`' pre-existing
 * indexes lead with `connector_instance_id`, but none carries `id` as the
 * column immediately following the equality predicates, so none can satisfy
 * the ORDER BY. The closest, `idx_pg_records_stream_cursor`, is
 * `(connector_instance_id, stream, deleted, cursor_value, primary_key_text)`
 * -- its fourth column is `cursor_value`, not `id`.
 *
 * So the planner fell back to `records_pkey`: already `id`-ordered (free
 * sort), then filtered every non-matching row away one at a time. Measured
 * READ-ONLY against production for `cin_12407c1afb78d56848fe0b20`/`messages`
 * (140,689 live rows in a 5.61M-row table): 27.4 SECONDS for 50 rows,
 * `Rows Removed by Filter: 3,031,420`.
 *
 * The same shape is ALSO the bulk path. `postgresSemanticRecordsPage`
 * (postgres-search.ts) issues it with `LIMIT 500`, and live
 * `pg_stat_activity` sampling during a real re-ingest caught successive
 * pages at 1.2s, 1.6s, 1.9s, 7.0s, 12.2s, 17.2s, 22.3s and 27.4s. The bulk
 * job was not merely competing for resources with the page -- it was hitting
 * the identical missing index from a second call site.
 *
 * This file proves, against REAL PostgreSQL:
 *   - FAIL-BEFORE: with `idx_pg_records_instance_stream_id` dropped
 *     (reproducing the exact pre-fix schema), the planner picks
 *     `records_pkey` and reports a large non-zero `Rows Removed by Filter`
 *     -- the production defect's signature.
 *   - PASS-AFTER: with the index present (the migration's default state),
 *     the same query plans an `Index Scan using
 *     idx_pg_records_instance_stream_id`, absorbs all four predicates into
 *     `Index Cond`, and removes ZERO rows by filter.
 *
 * UNLIKE this repo's canonical-count index test (which deliberately avoids
 * plan-shape assertions), asserting the plan is the RIGHT proof here,
 * because the defect IS a plan defect: the wrong plan is not a cost-model
 * tie-break, it is the planner having no candidate index that can produce
 * `id` order under these predicates. That property holds at any row count.
 * The fixture below still seeds enough interleaved rows that a `records_pkey`
 * walk must genuinely discard thousands of rows, so the FAIL-BEFORE
 * signature is the production one and not an artifact of an empty table.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  bootstrapPostgresSchema,
  closePostgresStorage,
  initPostgresStorage,
  postgresQuery,
} from "../server/postgres-storage.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
const NOW = "2026-08-21T00:00:00.000Z";
const CONNECTOR_ID = "https://test.pdpp.dev/connectors/keyset-index";
const STREAM_INDEX_NAME = "idx_pg_records_instance_stream_id";
const SUMMARY_REPAIR_INDEX_NAME = "idx_pg_records_instance_deleted_id";
const TARGET_ID = "cin_keyset_index_target";
const FILLER_ID = "cin_keyset_index_filler";

/** The exact shape `postgresSemanticRecordsPage` and the source-detail page issue. */
const KEYSET_SQL = `SELECT id, record_key, version
     FROM records
     WHERE connector_instance_id = $1
       AND stream = $2
       AND deleted = FALSE
       AND id > $3
     ORDER BY id ASC
     LIMIT $4`;

/** The exact summary-evidence repair shape: one connection, every stream. */
const SUMMARY_REPAIR_KEYSET_SQL = `SELECT id, stream, emitted_at
     FROM records
     WHERE connector_instance_id = $1
       AND deleted = FALSE
       AND id > $2
     ORDER BY connector_instance_id ASC, deleted ASC, id ASC
     LIMIT $3`;

function withPostgres(fn: () => Promise<void>) {
  return async () => {
    if (!POSTGRES_URL) {
      return;
    }
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
    try {
      await fn();
    } finally {
      await closePostgresStorage();
    }
  };
}

/**
 * Seeds the production shape that makes this defect visible: filler rows
 * belonging to OTHER connections occupy the low `id` range, and only then do
 * the target connection's rows appear. A `records_pkey` walk must therefore
 * discard every filler row before it can return a single target row -- which
 * is precisely why production reported `Rows Removed by Filter: 3,031,420`.
 */
async function seedInterleavedRecords(fillerRows: number, targetRows: number): Promise<void> {
  await postgresQuery("DELETE FROM records WHERE connector_instance_id = ANY($1)", [[TARGET_ID, FILLER_ID]]);
  await postgresQuery("DELETE FROM connector_instances WHERE connector_instance_id = ANY($1)", [
    [TARGET_ID, FILLER_ID],
  ]);
  await postgresQuery("DELETE FROM connectors WHERE connector_id = $1", [CONNECTOR_ID]);
  await postgresQuery("INSERT INTO connectors(connector_id, manifest, created_at) VALUES($1, $2::jsonb, $3)", [
    CONNECTOR_ID,
    JSON.stringify({ connector_id: CONNECTOR_ID, streams: [{ name: "messages", primary_key: ["id"] }] }),
    NOW,
  ]);
  await postgresQuery(
    `INSERT INTO connector_instances(
       connector_instance_id, owner_subject_id, connector_id, display_name, status,
       source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
     )
     SELECT id, 'owner_local', $1, 'x', 'active', 'account', id, '{}'::jsonb, $2, $2, NULL
       FROM unnest($3::text[]) AS t(id)`,
    [CONNECTOR_ID, NOW, [TARGET_ID, FILLER_ID]]
  );

  // Filler first, so it occupies the LOW id range -- the whole point.
  await postgresQuery(
    `INSERT INTO records(connector_id, stream, record_key, record_json, emitted_at, version, deleted, primary_key_text, connector_instance_id)
     SELECT $1, 'messages', 'f' || g, '{}'::jsonb, $2, 1, false, 'f' || g, $3
       FROM generate_series(1, $4::int) g`,
    [CONNECTOR_ID, NOW, FILLER_ID, fillerRows]
  );
  await postgresQuery(
    `INSERT INTO records(connector_id, stream, record_key, record_json, emitted_at, version, deleted, primary_key_text, connector_instance_id)
     SELECT $1, 'messages', 't' || g, '{}'::jsonb, $2, 1, false, 't' || g, $3
       FROM generate_series(1, $4::int) g`,
    [CONNECTOR_ID, NOW, TARGET_ID, targetRows]
  );
  await postgresQuery("ANALYZE records", []);
}

async function cleanup(): Promise<void> {
  await postgresQuery("DELETE FROM records WHERE connector_instance_id = ANY($1)", [[TARGET_ID, FILLER_ID]]);
  await postgresQuery("DELETE FROM connector_instances WHERE connector_instance_id = ANY($1)", [
    [TARGET_ID, FILLER_ID],
  ]);
  await postgresQuery("DELETE FROM connectors WHERE connector_id = $1", [CONNECTOR_ID]);
}

async function explainKeyset(limit: number): Promise<string> {
  const result = await postgresQuery<{ "QUERY PLAN": string }>(`EXPLAIN (ANALYZE, BUFFERS) ${KEYSET_SQL}`, [
    TARGET_ID,
    "messages",
    0,
    limit,
  ]);
  return result.rows.map((row) => row["QUERY PLAN"]).join("\n");
}

async function explainSummaryRepairKeyset(limit: number): Promise<string> {
  const result = await postgresQuery<{ "QUERY PLAN": string }>(
    `EXPLAIN (ANALYZE, BUFFERS) ${SUMMARY_REPAIR_KEYSET_SQL}`,
    [TARGET_ID, 0, limit]
  );
  return result.rows.map((row) => row["QUERY PLAN"]).join("\n");
}

const ROWS_REMOVED_BY_FILTER = /Rows Removed by Filter:\s*(\d+)/;
const INDEX_COND_LINE = /Index Cond:.*/;

function rowsRemovedByFilter(plan: string): number {
  const match = plan.match(ROWS_REMOVED_BY_FILTER);
  return match ? Number(match[1]) : 0;
}

/**
 * The post-fix contract, asserted for both call sites: the matching index is
 * chosen, every query predicate is absorbed into `Index Cond`, and nothing
 * is discarded by a Filter. Partial absorption would leave a Filter behind
 * and reintroduce the defect at production volume, so the predicate check is
 * the load-bearing one -- "uses the index" alone is not enough.
 */
function assertKeysetIndexPlan(plan: string, indexName: string, predicates: readonly string[], limit: number): void {
  assert.ok(
    plan.includes(`Index Scan using ${indexName}`) || plan.includes(`Index Only Scan using ${indexName}`),
    `LIMIT ${limit} must plan an index or index-only scan on ${indexName}; got:\n${plan}`
  );
  // Postgres renders the bound cursor parameter as `id > '0'::bigint`, so
  // match the column and operator rather than a literal value.
  const indexCond = plan.match(INDEX_COND_LINE)?.[0] ?? "";
  for (const predicate of predicates) {
    assert.ok(
      indexCond.includes(predicate),
      `LIMIT ${limit} must absorb \`${predicate}\` into Index Cond; got:\n${plan}`
    );
  }
  assert.equal(
    rowsRemovedByFilter(plan),
    0,
    `LIMIT ${limit} must discard no rows -- the defect was discarding 3,031,420; got:\n${plan}`
  );
}

test(
  "FAIL-BEFORE: without the keyset index the planner falls back to records_pkey and filters the whole low id range",
  withPostgres(async () => {
    await seedInterleavedRecords(20_000, 2000);
    try {
      // Reproduce the exact pre-fix schema.
      await postgresQuery(`DROP INDEX IF EXISTS ${STREAM_INDEX_NAME}`, []);
      await postgresQuery(`DROP INDEX IF EXISTS ${SUMMARY_REPAIR_INDEX_NAME}`, []);

      const plan = await explainKeyset(50);

      assert.ok(!plan.includes(STREAM_INDEX_NAME), `pre-fix schema must not use ${STREAM_INDEX_NAME}; got:\n${plan}`);
      assert.ok(
        plan.includes("records_pkey"),
        `pre-fix planner falls back to the id-ordered primary key; got:\n${plan}`
      );
      // The production signature: rows discarded one at a time. With 20k
      // filler rows ahead of the target's first row, a records_pkey walk
      // must discard all of them to return 50.
      assert.ok(
        rowsRemovedByFilter(plan) >= 20_000,
        `pre-fix plan discards the entire filler range (production saw 3,031,420); got:\n${plan}`
      );
    } finally {
      await cleanup();
    }
  })
);

test(
  "PASS-AFTER: matching keyset indexes serve source and summary queries without filtered rows",
  withPostgres(async () => {
    await seedInterleavedRecords(20_000, 2000);
    try {
      // Prove the MIGRATION builds this index, not merely that the index
      // happens to exist. Dropping it and re-running bootstrap is the load-
      // bearing step: an existence check alone passes on an index some
      // earlier test built by hand, so deleting the migration call would go
      // undetected (confirmed by mutation -- that exact hole let a deleted
      // migration stay green until this drop-and-rebootstrap replaced it).
      await postgresQuery(`DROP INDEX IF EXISTS ${STREAM_INDEX_NAME}`, []);
      await postgresQuery(`DROP INDEX IF EXISTS ${SUMMARY_REPAIR_INDEX_NAME}`, []);
      const droppedRows = await postgresQuery(
        "SELECT indexname FROM pg_indexes WHERE tablename = 'records' AND indexname = ANY($1)",
        [[STREAM_INDEX_NAME, SUMMARY_REPAIR_INDEX_NAME]]
      );
      assert.equal(
        droppedRows.rowCount,
        0,
        "precondition: both keyset indexes are genuinely absent before re-bootstrap"
      );

      await bootstrapPostgresSchema();

      const indexRows = await postgresQuery(
        "SELECT indexname FROM pg_indexes WHERE tablename = 'records' AND indexname = ANY($1)",
        [[STREAM_INDEX_NAME, SUMMARY_REPAIR_INDEX_NAME]]
      );
      assert.deepEqual(
        indexRows.rows.map((row) => row.indexname).sort(),
        [STREAM_INDEX_NAME, SUMMARY_REPAIR_INDEX_NAME].sort(),
        "bootstrapPostgresSchema must build both keyset indexes"
      );

      // The source-detail page uses the stream-qualified shape (LIMIT 50 and
      // 500); summary-evidence repair uses the connection-wide shape below.
      // Checked sequentially and deliberately -- these run EXPLAIN ANALYZE
      // against a shared table, so overlapping them would let one plan's
      // buffer state perturb the other's.
      assertKeysetIndexPlan(
        await explainKeyset(50),
        STREAM_INDEX_NAME,
        ["connector_instance_id =", "stream =", "deleted =", "id >"],
        50
      );
      assertKeysetIndexPlan(
        await explainKeyset(500),
        STREAM_INDEX_NAME,
        ["connector_instance_id =", "stream =", "deleted =", "id >"],
        500
      );
      assertKeysetIndexPlan(
        await explainSummaryRepairKeyset(500),
        SUMMARY_REPAIR_INDEX_NAME,
        ["connector_instance_id =", "deleted =", "id >"],
        500
      );
    } finally {
      await cleanup();
    }
  })
);
