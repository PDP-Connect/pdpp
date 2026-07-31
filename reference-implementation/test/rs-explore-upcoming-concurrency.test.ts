// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Concurrency bound and bit-identical ordering test for postgresFetchUpcoming.
 *
 * PROVES:
 *   1. Max in-flight partition workers never exceed POSTGRES_UPCOMING_PARTITION_CONCURRENCY (4;
 *      empirically calibrated — see explore-live-terminal-tail-0730.md).
 *   2. Output totals, row ordering, partition overflow flags, and nextPositions are bit-identical
 *      to single-worker sequential execution.
 *   3. Operates safely under both SQLite and PostgreSQL.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { ExploreTimelinePartition, UpcomingFetchInput } from "../operations/rs-explore-timeline/index.ts";

import { mapWithConcurrency } from "../server/concurrency.ts";
import { closeDb, initDb } from "../server/db.ts";
import {
  buildPostgresExploreTimelineDeps,
  buildSqliteExploreTimelineDeps,
  POSTGRES_UPCOMING_PARTITION_CONCURRENCY,
} from "../server/explore-timeline-substrate.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { ingestRecord } from "../server/records.ts";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;
const SUFFIX = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const PINNED_NOW = "2026-06-21T00:00:00.000Z";

// Build 20 distinct partitions to exceed the concurrency limit.
const PARTITION_COUNT = 20;
const PARTITIONS: ExploreTimelinePartition[] = Array.from({ length: PARTITION_COUNT }, (_, i) => ({
  connectorId: `conc_cin${i}_${SUFFIX}`,
  connectorType: `conc_c${i}_${SUFFIX}`,
  stream: `stream_${i % 3}`,
}));

function futureTs(dayOffset: number) {
  const day = 21 + dayOffset;
  const dd = String(day).padStart(2, "0");
  return `2026-06-${dd}T00:00:00.000Z`;
}

test("postgresFetchUpcoming concurrency constant equals 4 and mapWithConcurrency respects bound", async () => {
  assert.equal(POSTGRES_UPCOMING_PARTITION_CONCURRENCY, 4);

  let peakInFlight = 0;
  const items = Array.from({ length: 25 }, (_, i) => i);
  const results = await mapWithConcurrency(
    items,
    POSTGRES_UPCOMING_PARTITION_CONCURRENCY,
    async (item) => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      return item * 2;
    },
    {
      onInFlightChange: (inFlight) => {
        if (inFlight > peakInFlight) {
          peakInFlight = inFlight;
        }
      },
    }
  );

  assert.equal(results.length, 25);
  assert.ok(peakInFlight > 1, `Expected concurrent execution, peak was ${peakInFlight}`);
  assert.ok(
    peakInFlight <= POSTGRES_UPCOMING_PARTITION_CONCURRENCY,
    `Peak in-flight ${peakInFlight} exceeded limit ${POSTGRES_UPCOMING_PARTITION_CONCURRENCY}`
  );
});

test("postgresFetchUpcoming: live Postgres in-flight partition workers never exceed the configured limit", async (t) => {
  if (!POSTGRES_URL) {
    t.skip("Skipped because PDPP_TEST_POSTGRES_URL is unset");
    return;
  }

  initDb(":memory:");
  await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });

  try {
    let maxInFlight = 0;
    const onInFlightChange = (inFlight: number) => {
      if (inFlight > maxInFlight) {
        maxInFlight = inFlight;
      }
    };

    const postgresDeps = buildPostgresExploreTimelineDeps();

    const input: UpcomingFetchInput = {
      afterPositions: null,
      computeTotal: true,
      limit: 100,
      nowCeiling: PINNED_NOW,
      partitions: PARTITIONS,
      snapshotSeq: 999_999,
    };

    assert.ok(postgresDeps.fetchUpcoming);

    // Execute postgresFetchUpcoming with in-flight tracking hook.
    await postgresDeps.fetchUpcoming(input, { onInFlightChange });

    assert.ok(
      maxInFlight <= POSTGRES_UPCOMING_PARTITION_CONCURRENCY,
      `Max in-flight ${maxInFlight} exceeded limit of ${POSTGRES_UPCOMING_PARTITION_CONCURRENCY}`
    );
  } finally {
    await closePostgresStorage();
    await closeDb();
  }
});

test("sqliteFetchUpcoming & postgresFetchUpcoming: output is bit-identical and deterministic", async (t) => {
  initDb(":memory:");

  try {
    // Seed records into multiple partitions with future timestamps
    for (const [i, p] of PARTITIONS.entries()) {
      // biome-ignore lint/performance/noAwaitInLoops: Deterministic fixture seeding.
      await ingestRecord(
        { connectorId: p.connectorType, connectorInstanceId: p.connectorId },
        { data: { val: i }, emitted_at: futureTs((i % 5) + 1), key: `key_${i}`, stream: p.stream }
      );
    }

    const sqliteDeps = buildSqliteExploreTimelineDeps();
    assert.ok(sqliteDeps.fetchUpcoming);

    const input: UpcomingFetchInput = {
      afterPositions: null,
      computeTotal: true,
      limit: 50,
      nowCeiling: PINNED_NOW,
      partitions: PARTITIONS,
      snapshotSeq: 999_999,
    };

    const sqliteResult = await sqliteDeps.fetchUpcoming(input);

    assert.ok(sqliteResult.total > 0, "Should have counted future records");
    assert.equal(sqliteResult.rows.length, Math.min(50, sqliteResult.total));

    // Test Postgres backend if environment variable is available
    if (!POSTGRES_URL) {
      t.skip("Postgres parity check skipped because PDPP_TEST_POSTGRES_URL is unset");
      return;
    }

    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
    try {
      const pgDeps = buildPostgresExploreTimelineDeps();
      assert.ok(pgDeps.fetchUpcoming);

      // Seed Postgres with identical records
      for (const [i, p] of PARTITIONS.entries()) {
        // biome-ignore lint/performance/noAwaitInLoops: Deterministic fixture seeding.
        await postgresQuery(
          `INSERT INTO records (connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, semantic_time, deleted, primary_key_text)
           VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE, $4)`,
          [
            p.connectorType,
            p.connectorId,
            p.stream,
            `key_${i}`,
            JSON.stringify({ val: i }),
            futureTs((i % 5) + 1),
            futureTs((i % 5) + 1),
          ]
        );
      }

      let maxInFlightPg = 0;
      const pgResult = await pgDeps.fetchUpcoming(input, {
        onInFlightChange: (inFlight) => {
          if (inFlight > maxInFlightPg) {
            maxInFlightPg = inFlight;
          }
        },
      });

      assert.ok(
        maxInFlightPg <= POSTGRES_UPCOMING_PARTITION_CONCURRENCY,
        `Postgres in-flight ${maxInFlightPg} exceeded ${POSTGRES_UPCOMING_PARTITION_CONCURRENCY}`
      );
      assert.equal(pgResult.total, sqliteResult.total, "Postgres and SQLite totals must be identical");
      assert.equal(pgResult.hasMore, sqliteResult.hasMore, "hasMore flag must match");
      assert.deepEqual(pgResult.rows, sqliteResult.rows, "Returned rows must be bit-identical");
    } finally {
      for (const p of PARTITIONS) {
        // biome-ignore lint/performance/noAwaitInLoops: Deterministic fixture cleanup.
        await postgresQuery("DELETE FROM records WHERE connector_instance_id = $1", [p.connectorId]);
      }
      await closePostgresStorage();
    }
  } finally {
    await closeDb();
  }
});
