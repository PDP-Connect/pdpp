// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression tests for B1, B2, B3 backend findings in the rs.explore.timeline
 * merged-timeline endpoint.
 *
 * Each test is designed to FAIL against the original (buggy) code and PASS after
 * the fix. The test names explain the pre-fix failure mode.
 *
 * B1 (P0) - SILENT 1024 PARTITION CAP
 *   Pre-fix: sqliteListPartitions/postgresListPartitions LIMIT 1024 silently
 *   drops overflow partitions. Records in those partitions are never returned.
 *   Test: seed PARTITION_THRESHOLD+1 distinct (connector_instance_id, stream)
 *   partitions (the threshold is lowered by mocking listPartitions to simulate
 *   the cap behavior), assert the overflow record IS returned. Because we cannot
 *   lower the cap in source without the fix, we instead seed 1025 real partitions
 *   in SQLite (fast, in-memory) and verify all records reach the feed.
 *
 * B2 (P0) - SNAPSHOT STABILITY BROKEN FOR BACKFILLS
 *   Pre-fix: snapshot anchored on MAX(emitted_at). A connector that backfills
 *   older records after page 1 produces rows with emitted_at BELOW the snapshot
 *   but ingest id ABOVE it. Those rows leak onto page 2 and are visible despite
 *   appearing to be pre-snapshot.
 *   Test: page 1 (captures snapshot), then insert a record with emitted_at BEFORE
 *   the snapshot anchor but ingest id AFTER it. Page 2 must NOT contain it.
 *
 * B3 (P1) - ENDPOINT IDENTITY SHAPE
 *   Pre-fix: connector_instance_id returned as connector_id, conflating type with
 *   instance. connector_id (the type, e.g. "amazon") was never returned.
 *   Test: ingest a record where connector_id != connector_instance_id, assert the
 *   merged feed returns BOTH connector_id (type) and connector_instance_id (instance)
 *   as distinct fields with the correct values.
 *
 * Runs on SQLite (in-memory). Postgres is skipped when PDPP_TEST_POSTGRES_URL is unset.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { ExploreTimelineDependencies, ExploreTimelineRecord } from "../operations/rs-explore-timeline/index.ts";
import { executeExploreTimeline } from "../operations/rs-explore-timeline/index.ts";
import { closeDb, initDb } from "../server/db.ts";
import {
  buildPostgresExploreTimelineDeps,
  buildSqliteExploreTimelineDeps,
} from "../server/explore-timeline-substrate.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { ingestRecord } from "../server/records.ts";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

// Unique suffix to prevent collisions with other test runs.
const SUFFIX = `b1b2b3_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

// ---------------------------------------------------------------------------
// B1: Partition cap regression
// ---------------------------------------------------------------------------
// We seed OVER_CAP_COUNT = 1025 distinct partitions. Each partition has exactly
// one record. After the fix (no LIMIT), all 1025 records must be returned.
// Before the fix (LIMIT 1024), the 1025th record is silently invisible.
// SQLite in-memory makes this fast (~1025 rows, cheap DISTINCT scan).
const OVER_CAP_COUNT = 1025;

async function seedOverCapPartitions() {
  // Use a single connector type but distinct connector_instance_id values.
  // biome-ignore lint/style/noIncrementDecrement: the loop counter is local, unambiguous test setup state.
  for (let i = 0; i < OVER_CAP_COUNT; i++) {
    const cin = `b1_cin_${SUFFIX}_${i}`;
    const connectorId = `b1_connector_${SUFFIX}`;
    // biome-ignore lint/performance/noAwaitInLoops: ordered setup is intentionally sequential because each iteration advances shared test state.
    await ingestRecord(
      { connectorId, connectorInstanceId: cin },
      {
        data: { idx: i },
        emitted_at: "2026-01-01T00:00:00.000Z",
        key: `rec_${i}`,
        stream: "orders",
      }
    );
  }
}

async function assertAllPartitionsReachable(deps: ExploreTimelineDependencies, label: string) {
  await seedOverCapPartitions();

  // Page through the entire feed collecting all records.
  const allRecords: ExploreTimelineRecord[] = [];
  let cursor: string | null = null;
  let pageCount = 0;
  // biome-ignore lint/suspicious/noUnnecessaryConditions: the runtime fixture deliberately exercises an absent or nullable boundary value.
  while (true) {
    // biome-ignore lint/performance/noAwaitInLoops: ordered setup is intentionally sequential because each iteration advances shared test state.
    const page = await executeExploreTimeline({ cursor, limit: 100 }, deps);
    allRecords.push(...page.data);
    // biome-ignore lint/style/noIncrementDecrement: the loop counter is local, unambiguous test setup state.
    pageCount++;
    if (!page.has_more) {
      break;
    }
    cursor = page.next_cursor;
    if (pageCount > 200) {
      throw new Error(`${label}: too many pages, possible infinite loop`);
    }
  }

  // Filter to only the B1 records seeded by this test.
  const b1Records = allRecords.filter((r) => r.connector_id === `b1_connector_${SUFFIX}`);

  assert.equal(
    b1Records.length,
    OVER_CAP_COUNT,
    `${label} B1: expected ${OVER_CAP_COUNT} records across ${OVER_CAP_COUNT} partitions but got ${b1Records.length}. ` +
      `A silent partition cap (e.g. LIMIT 1024) would cause this to be 1024 instead of ${OVER_CAP_COUNT}.`
  );
}

// ---------------------------------------------------------------------------
// B2: Backfill snapshot stability regression
// ---------------------------------------------------------------------------

async function seedB2Records(suffix: string) {
  // Seed two records with emitted_at values that are "known" so the snapshot
  // anchor is predictable.
  await ingestRecord(
    { connectorId: `b2_connector_${suffix}`, connectorInstanceId: `b2_cin_${suffix}` },
    {
      data: { id: "r1" },
      emitted_at: "2026-06-10T12:00:00.000Z",
      key: "r1",
      stream: "txn",
    }
  );
  await ingestRecord(
    { connectorId: `b2_connector_${suffix}`, connectorInstanceId: `b2_cin_${suffix}` },
    {
      data: { id: "r2" },
      emitted_at: "2026-06-09T12:00:00.000Z",
      key: "r2",
      stream: "txn",
    }
  );
}

// REWIND: re-fetching page 1 with rewindToFirstPage MUST pin to the original
// snapshot (snapshotSeq), so an after-snapshot backfill whose emitted_at lands
// INSIDE page 1's window can never displace an original page-1 row. This is the
// exact "Load more hides records above" class caught in review in the console
// accumulator (which used emitted_at <= snapshot_at as a membership proxy).
async function assertRewindPinsOriginalPage1(deps: ExploreTimelineDependencies, label: string) {
  const suffix = `${SUFFIX}_rw`;
  const connectorId = `rw_connector_${suffix}`;
  const connectorInstanceId = `rw_cin_${suffix}`;
  const ingest = (key: string, emitted_at: string) =>
    ingestRecord({ connectorId, connectorInstanceId }, { data: { id: key }, emitted_at, key, stream: "txn" });

  // Three original records so page 1 (limit 2) has MORE pages and returns a
  // cursor. Page 1 = [r-newest, r-older]; r-oldest is on page 2.
  await ingest("r-newest", "2026-06-10T12:00:00.000Z");
  await ingest("r-older", "2026-06-09T12:00:00.000Z");
  await ingest("r-oldest", "2026-06-08T12:00:00.000Z");

  const page1 = await executeExploreTimeline({ cursor: null, limit: 2 }, deps);
  const originalPage1Keys = page1.data.map((r) => r.record_key);
  assert.deepEqual(
    originalPage1Keys,
    ["r-newest", "r-older"],
    `${label} rewind: original page 1 must be [r-newest, r-older]`
  );
  assert.ok(page1.next_cursor, `${label} rewind: page 1 must return a cursor`);

  // After the snapshot, ingest a BACKFILL whose emitted_at lands BETWEEN the two
  // originals — recent enough to be inside page 1's top-2 window, but its ingest
  // id is > snapshotSeq. A fresh cursor:null re-fetch would return
  // [r-newest, r-displace] and DROP r-older (the displacement bug).
  await ingest("r-displace", "2026-06-09T18:00:00.000Z");

  // Control: a FRESH first page (new snapshot) DOES include the backfill and
  // displaces r-older — proving the scenario is real.
  const freshPage1 = await executeExploreTimeline({ cursor: null, limit: 2 }, deps);
  assert.deepEqual(
    freshPage1.data.map((r) => r.record_key),
    ["r-newest", "r-displace"],
    `${label} rewind: control — a fresh snapshot DOES displace r-older with the backfill`
  );

  // REWIND: re-fetch page 1 pinned to the ORIGINAL snapshot via the page-1 cursor.
  const rewound = await executeExploreTimeline({ cursor: page1.next_cursor, limit: 2, rewindToFirstPage: true }, deps);
  assert.deepEqual(
    rewound.data.map((r) => r.record_key),
    ["r-newest", "r-older"],
    `${label} rewind: page 1 re-rendered against the ORIGINAL snapshot must be ` +
      "[r-newest, r-older] — the after-snapshot backfill must NOT appear and must NOT " +
      "displace r-older (snapshotSeq pin, not emitted_at proxy)"
  );
  assert.ok(
    !rewound.data.some((r) => r.record_key === "r-displace"),
    `${label} rewind: the after-snapshot backfill must be excluded from the rewound page 1`
  );
}

async function assertBackfillExcludedFromPage2(deps: ExploreTimelineDependencies, label: string) {
  const suffix = `${SUFFIX}_b2`;

  await seedB2Records(suffix);

  // Page 1 captures the snapshot (ingest seq anchored here).
  const page1 = await executeExploreTimeline({ cursor: null, limit: 1 }, deps);
  assert.ok(page1.has_more, `${label} B2: page 1 must have more records`);
  assert.ok(page1.next_cursor, `${label} B2: page 1 must return cursor`);

  // Now insert a backfill record: emitted_at is BEFORE the snapshot's
  // emitted_at (older than both seeded records), but its ingest id will be
  // AFTER the snapshot anchor because it is ingested now.
  const BACKFILL_KEY = "r_backfill";
  await ingestRecord(
    { connectorId: `b2_connector_${suffix}`, connectorInstanceId: `b2_cin_${suffix}` },
    {
      data: { id: BACKFILL_KEY },
      // Deliberately OLD emitted_at — this is the backfill scenario.
      // Pre-fix (anchor on emitted_at): emitted_at < snapshot anchor means
      // the emitted_at filter passes and this record leaks onto page 2.
      // Post-fix (anchor on ingest seq): id > snapshotSeq excludes this row.
      emitted_at: "2026-01-01T00:00:00.000Z",
      key: BACKFILL_KEY,
      stream: "txn",
    }
  );

  // Page 2 using the SAME cursor from page 1.
  const page2 = await executeExploreTimeline({ cursor: page1.next_cursor, limit: 10 }, deps);

  const page2Keys = page2.data.map((r) => r.record_key);
  assert.ok(
    !page2Keys.includes(BACKFILL_KEY),
    `${label} B2: backfill record "${BACKFILL_KEY}" (emitted_at before snapshot, ingested after) ` +
      "must NOT appear on page 2. Pre-fix behavior: anchor on MAX(emitted_at) passes this record " +
      "through because its emitted_at is below the anchor. Post-fix behavior: anchor on MAX(id) " +
      "correctly excludes it."
  );

  // The backfill record MUST be counted in new_since_snapshot.
  // (It is a newly-ingested record even though its authored time is old.)
  assert.ok(
    page2.new_since_snapshot >= 1,
    `${label} B2: new_since_snapshot must be >= 1 after ingesting a post-snapshot record`
  );
}

// ---------------------------------------------------------------------------
// B3: Identity shape regression
// ---------------------------------------------------------------------------

async function assertBothIdentitiesReturned(deps: ExploreTimelineDependencies, label: string) {
  const suffix = `${SUFFIX}_b3`;
  // connector_id (type) and connector_instance_id (instance) are deliberately
  // different so we can verify neither is swapped.
  const CONNECTOR_TYPE = `b3_type_${suffix}`; // connector_id in records table
  const CONNECTOR_INSTANCE = `b3_cin_${suffix}`; // connector_instance_id in records table

  await ingestRecord(
    { connectorId: CONNECTOR_TYPE, connectorInstanceId: CONNECTOR_INSTANCE },
    {
      data: { id: "ev1" },
      emitted_at: "2026-05-01T12:00:00.000Z",
      key: "ev1",
      stream: "events",
    }
  );

  const page = await executeExploreTimeline({ cursor: null, limit: 100 }, deps);

  // Filter to just the B3 record.
  const b3Records = page.data.filter(
    (r) => r.connector_instance_id === CONNECTOR_INSTANCE || r.connector_id === CONNECTOR_TYPE
  );
  assert.ok(
    b3Records.length >= 1,
    `${label} B3: expected at least one record for connector_instance_id=${CONNECTOR_INSTANCE}`
  );

  // biome-ignore lint/style/useDestructuring: the property access names the fixture value at its point of use.
  const rec = b3Records[0];
  assert.ok(rec, `${label} B3: expected b3Records[0] to be defined`);

  assert.ok(
    "connector_instance_id" in rec,
    `${label} B3: response must carry connector_instance_id field. Pre-fix: only connector_id ` +
      "(set to connector_instance_id value) was present."
  );
  assert.ok("connector_id" in rec, `${label} B3: response must carry connector_id (type) field.`);

  assert.equal(
    rec.connector_id,
    CONNECTOR_TYPE,
    `${label} B3: connector_id must be the TYPE ("${CONNECTOR_TYPE}"), not the instance. ` +
      `Pre-fix: connector_id was set to connector_instance_id value ("${CONNECTOR_INSTANCE}").`
  );
  assert.equal(
    rec.connector_instance_id,
    CONNECTOR_INSTANCE,
    `${label} B3: connector_instance_id must be the INSTANCE ("${CONNECTOR_INSTANCE}").`
  );

  // The two fields must be different (they are meaningfully distinct).
  assert.notEqual(
    rec.connector_id,
    rec.connector_instance_id,
    `${label} B3: connector_id and connector_instance_id must differ (type vs instance). ` +
      `Pre-fix: both would be "${CONNECTOR_INSTANCE}" because connector_instance_id was aliased as connector_id.`
  );
}

// ---------------------------------------------------------------------------
// SQLite suite
// ---------------------------------------------------------------------------

test("B1 (sqlite): records in partitions beyond 1024 are reachable (no silent cap)", async () => {
  initDb(":memory:");
  try {
    const deps = buildSqliteExploreTimelineDeps();
    await assertAllPartitionsReachable(deps, "sqlite");
  } finally {
    closeDb();
  }
});

test("B2 (sqlite): backfill record with old emitted_at does not leak onto page 2 (ingest-seq snapshot)", async () => {
  initDb(":memory:");
  try {
    const deps = buildSqliteExploreTimelineDeps();
    await assertBackfillExcludedFromPage2(deps, "sqlite");
  } finally {
    closeDb();
  }
});

test("B3 (sqlite): merged feed returns distinct connector_id (type) and connector_instance_id (instance)", async () => {
  initDb(":memory:");
  try {
    const deps = buildSqliteExploreTimelineDeps();
    await assertBothIdentitiesReturned(deps, "sqlite");
  } finally {
    closeDb();
  }
});

test("REWIND (sqlite): re-fetching page 1 pins to the original snapshot, not emitted_at (Load-more displacement)", async () => {
  initDb(":memory:");
  try {
    const deps = buildSqliteExploreTimelineDeps();
    await assertRewindPinsOriginalPage1(deps, "sqlite");
  } finally {
    closeDb();
  }
});

// ---------------------------------------------------------------------------
// Postgres suite
// ---------------------------------------------------------------------------

async function cleanupPostgresB1B2B3() {
  const patterns = [`b1_cin_${SUFFIX}`, `b2_cin_${SUFFIX}`, `b3_cin_${SUFFIX}`];
  for (const _pattern of patterns) {
    // connector_instance_id for b1 has the suffix embedded; use LIKE
    // biome-ignore lint/performance/noAwaitInLoops: ordered setup is intentionally sequential because each iteration advances shared test state.
    await postgresQuery("DELETE FROM records WHERE connector_instance_id LIKE $1", [
      `%${SUFFIX}%`,
      // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double represents an optional side effect.
    ]).catch(() => {});
    await postgresQuery("DELETE FROM record_changes WHERE connector_instance_id LIKE $1", [`%${SUFFIX}%`]).catch(
      // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double represents an optional side effect.
      () => {}
    );
    await postgresQuery("DELETE FROM version_counter WHERE connector_instance_id LIKE $1", [`%${SUFFIX}%`]).catch(
      // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double represents an optional side effect.
      () => {}
    );
  }
}

if (POSTGRES_URL) {
  test("B1 (postgres): records in partitions beyond 1024 are reachable (no silent cap)", async () => {
    initDb(":memory:");
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
    try {
      await cleanupPostgresB1B2B3();
      const deps = buildPostgresExploreTimelineDeps();
      await assertAllPartitionsReachable(deps, "postgres");
    } finally {
      await cleanupPostgresB1B2B3();
      await closePostgresStorage();
      closeDb();
    }
  });

  test("B2 (postgres): backfill record with old emitted_at does not leak onto page 2 (ingest-seq snapshot)", async () => {
    initDb(":memory:");
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
    try {
      await cleanupPostgresB1B2B3();
      const deps = buildPostgresExploreTimelineDeps();
      await assertBackfillExcludedFromPage2(deps, "postgres");
    } finally {
      await cleanupPostgresB1B2B3();
      await closePostgresStorage();
      closeDb();
    }
  });

  test("B3 (postgres): merged feed returns distinct connector_id (type) and connector_instance_id (instance)", async () => {
    initDb(":memory:");
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
    try {
      await cleanupPostgresB1B2B3();
      const deps = buildPostgresExploreTimelineDeps();
      await assertBothIdentitiesReturned(deps, "postgres");
    } finally {
      await cleanupPostgresB1B2B3();
      await closePostgresStorage();
      closeDb();
    }
  });
} else {
  // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double represents an optional side effect.
  test("B1/B2/B3 (postgres): skipped (PDPP_TEST_POSTGRES_URL unset)", { skip: true }, () => {});
}
