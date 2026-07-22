// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { executeExploreRecordBuckets } from "../operations/rs-explore-record-buckets/index.ts";
import { closeDb, initDb } from "../server/db.js";
import {
  buildPostgresExploreRecordBucketsDeps,
  buildSqliteExploreRecordBucketsDeps,
} from "../server/explore-timeline-substrate.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.js";
import { ingestRecord } from "../server/records.js";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;
const SUFFIX = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

const PARTITION_A = {
  connectorId: `bucket_connector_a_${SUFFIX}`,
  connectorInstanceId: `bucket_instance_a_${SUFFIX}`,
};
const PARTITION_B = {
  connectorId: `bucket_connector_b_${SUFFIX}`,
  connectorInstanceId: `bucket_instance_b_${SUFFIX}`,
};

const RECORDS = [
  { partition: PARTITION_A, stream: "alpha", key: "a-jan", emitted_at: "2024-01-15T12:00:00.000Z" },
  { partition: PARTITION_A, stream: "alpha", key: "a-mar", emitted_at: "2024-03-20T12:00:00.000Z" },
  { partition: PARTITION_B, stream: "beta", key: "b-jul", emitted_at: "2025-07-04T12:00:00.000Z" },
  { partition: PARTITION_A, stream: "gamma", key: "a-may", emitted_at: "2026-05-10T12:00:00.000Z" },
  { partition: PARTITION_B, stream: "beta", key: "b-future", emitted_at: "2027-01-01T12:00:00.000Z" },
];

async function seedRecords() {
  for (const record of RECORDS) {
    await ingestRecord(
      {
        connectorId: record.partition.connectorId,
        connectorInstanceId: record.partition.connectorInstanceId,
      },
      {
        stream: record.stream,
        key: record.key,
        data: { id: record.key, stream: record.stream },
        emitted_at: record.emitted_at,
      }
    );
  }
}

function bucketMap(result) {
  return new Map(result.buckets.map((bucket) => [bucket.start, bucket.count]));
}

async function assertBucketBehavior(label, deps) {
  await seedRecords();

  const result = await executeExploreRecordBuckets(
    {
      now: "2026-06-24T00:00:00.000Z",
    },
    deps
  );

  assert.equal(result.object, "explore_record_buckets", label);
  assert.equal(result.time_zone, "UTC", label);
  assert.equal(result.granularity, "month", `${label}: multi-year extent auto-snaps to month`);
  assert.deepEqual(result.extent, {
    start: "2024-01-15T12:00:00.000Z",
    end: "2026-05-10T12:00:00.000Z",
    count: 4,
  });
  assert.equal(result.buckets.length, 29, `${label}: returns dense Jan 2024 through May 2026 months`);

  const counts = bucketMap(result);
  assert.equal(counts.get("2024-01-01T00:00:00.000Z"), 1, `${label}: January populated`);
  assert.equal(counts.get("2024-02-01T00:00:00.000Z"), 0, `${label}: February zero-filled`);
  assert.equal(counts.get("2024-03-01T00:00:00.000Z"), 1, `${label}: March populated`);
  assert.equal(counts.get("2025-07-01T00:00:00.000Z"), 1, `${label}: cross-partition record counted`);
  assert.equal(counts.get("2026-05-01T00:00:00.000Z"), 1, `${label}: final populated month counted`);
  assert.equal(counts.has("2027-01-01T00:00:00.000Z"), false, `${label}: future records above now are excluded`);

  const scoped = await executeExploreRecordBuckets(
    {
      connectionIds: [PARTITION_A.connectorInstanceId],
      streams: ["alpha"],
      granularity: "month",
      now: "2026-06-24T00:00:00.000Z",
    },
    deps
  );
  assert.equal(scoped.extent.count, 2, `${label}: scoped count excludes other streams and connections`);
  assert.equal(scoped.buckets.length, 3, `${label}: scoped dense extent stays populated-window bound`);
  assert.deepEqual(scoped.buckets.map((bucket) => bucket.count), [1, 0, 1]);
}

test("rs.explore.record_buckets: SQLite returns dense extent-aware exact buckets", async () => {
  initDb(":memory:");
  try {
    await assertBucketBehavior("sqlite", buildSqliteExploreRecordBucketsDeps());
  } finally {
    closeDb();
  }
});

test("rs.explore.record_buckets: bucket SQL does not read record_json", () => {
  const source = fs.readFileSync(new URL("../server/explore-timeline-substrate.ts", import.meta.url), "utf8");
  const start = source.indexOf("// Explore bucket aggregate substrate");
  const end = source.indexOf("// Factory", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  assert.doesNotMatch(source.slice(start, end), /record_json/i);
});

async function cleanupPostgres() {
  const ids = [PARTITION_A.connectorInstanceId, PARTITION_B.connectorInstanceId];
  await postgresQuery("DELETE FROM records WHERE connector_instance_id = ANY($1::text[])", [ids]).catch(() => {});
  await postgresQuery("DELETE FROM record_changes WHERE connector_instance_id = ANY($1::text[])", [ids]).catch(() => {});
  await postgresQuery("DELETE FROM version_counter WHERE connector_instance_id = ANY($1::text[])", [ids]).catch(() => {});
}

if (!POSTGRES_URL) {
  test("rs.explore.record_buckets: Postgres returns dense extent-aware exact buckets (skipped: PDPP_TEST_POSTGRES_URL unset)", {
    skip: "PDPP_TEST_POSTGRES_URL unset",
  });
} else {
  test("rs.explore.record_buckets: Postgres returns dense extent-aware exact buckets", async () => {
    initDb(":memory:");
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
    await cleanupPostgres();
    try {
      await assertBucketBehavior("postgres", buildPostgresExploreRecordBucketsDeps());
    } finally {
      await cleanupPostgres();
      await closePostgresStorage();
      closeDb();
    }
  });
}
