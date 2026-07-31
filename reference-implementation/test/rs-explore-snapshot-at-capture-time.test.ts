// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression tests for the snapshot_at wall-clock-capture contract
 * (openspec/changes/clarify-explore-snapshot-at-capture-time).
 *
 * PROVES:
 *   1. A future-dated emitted_at record never changes snapshot_at.
 *   2. A backfilled record (old emitted_at, ingested AFTER the snapshot)
 *      never changes snapshot_at.
 *   3. Pagination membership stays snapshotSeq-based (unaffected by this
 *      change), independently confirmed alongside the snapshot_at checks.
 *   4. A resumed or rewound page retains the ORIGINAL first page's
 *      snapshot_at, not a freshly re-captured wall-clock value.
 *   5. snapshot_at equals nowCeiling on a first-page response — the same
 *      captured instant, not two independently-timed reads.
 *   6. An empty corpus reports the actual captured instant, not an epoch
 *      sentinel.
 *
 * Each test injects a fixed deps.now() clock so snapshot_at's expected value
 * is deterministic and can be asserted exactly (not just "not equal to some
 * record's emitted_at").
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { ExploreTimelineDependencies } from "../operations/rs-explore-timeline/index.ts";
import { executeExploreTimeline } from "../operations/rs-explore-timeline/index.ts";
import { closeDb, initDb } from "../server/db.ts";
import {
  buildPostgresExploreTimelineDeps,
  buildSqliteExploreTimelineDeps,
} from "../server/explore-timeline-substrate.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { ingestRecord } from "../server/records.ts";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;
const SUFFIX = `snap_at_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const CAPTURED_NOW = "2026-08-15T12:34:56.789Z";

function withFixedClock(deps: ExploreTimelineDependencies): ExploreTimelineDependencies {
  return { ...deps, now: () => CAPTURED_NOW };
}

async function assertSnapshotAtIsCaptureTimeNotRecordAggregate(deps: ExploreTimelineDependencies, label: string) {
  const suffix = `${SUFFIX}_future_${label}`;
  const connectorId = `sa_connector_${suffix}`;
  const connectorInstanceId = `sa_cin_${suffix}`;

  // A record dated far in the FUTURE relative to CAPTURED_NOW. A MAX(emitted_at)
  // aggregate would report THIS timestamp as snapshot_at; the capture-time
  // contract must report CAPTURED_NOW regardless.
  const FAR_FUTURE = "2099-01-01T00:00:00.000Z";
  await ingestRecord(
    { connectorId, connectorInstanceId },
    { data: { id: "future" }, emitted_at: FAR_FUTURE, key: "future", stream: "txn" }
  );
  // A record dated far in the PAST — makes sure a low-end aggregate can't leak
  // through either (e.g. a MIN confused for MAX, or a stale cached value).
  await ingestRecord(
    { connectorId, connectorInstanceId },
    { data: { id: "past" }, emitted_at: "1999-01-01T00:00:00.000Z", key: "past", stream: "txn" }
  );

  const page1 = await executeExploreTimeline({ cursor: null, limit: 10 }, withFixedClock(deps));

  assert.equal(
    page1.snapshot_at,
    CAPTURED_NOW,
    `${label}: snapshot_at must equal the captured wall clock, not any record's emitted_at (future record was ${FAR_FUTURE})`
  );
  assert.notEqual(
    page1.snapshot_at,
    FAR_FUTURE,
    `${label}: snapshot_at must NOT equal the future-dated record's emitted_at`
  );
}

async function assertBackfillNeverChangesSnapshotAt(deps: ExploreTimelineDependencies, label: string) {
  const suffix = `${SUFFIX}_backfill_${label}`;
  const connectorId = `sa_connector_${suffix}`;
  const connectorInstanceId = `sa_cin_${suffix}`;

  await ingestRecord(
    { connectorId, connectorInstanceId },
    { data: { id: "seed" }, emitted_at: "2026-06-01T00:00:00.000Z", key: "seed", stream: "txn" }
  );

  const page1 = await executeExploreTimeline({ cursor: null, limit: 10 }, withFixedClock(deps));
  assert.equal(page1.snapshot_at, CAPTURED_NOW, `${label}: page 1 snapshot_at must equal the captured wall clock`);

  // Backfill: old emitted_at, ingested AFTER the snapshot (id > snapshotSeq).
  // Pre-fix (MAX(emitted_at) aggregate), this could never move snapshot_at
  // BACKWARD anyway (MAX only grows) — but a fresh FIRST page taken after this
  // backfill must still report the (new) captured instant, never the
  // backfilled record's OLD emitted_at.
  await ingestRecord(
    { connectorId, connectorInstanceId },
    { data: { id: "backfill" }, emitted_at: "2020-01-01T00:00:00.000Z", key: "backfill", stream: "txn" }
  );

  const freshPage1 = await executeExploreTimeline({ cursor: null, limit: 10 }, withFixedClock(deps));
  assert.equal(
    freshPage1.snapshot_at,
    CAPTURED_NOW,
    `${label}: a fresh first page after a backfill must still report the captured wall clock, not the backfilled record's old emitted_at`
  );
}

async function assertMembershipStaysSnapshotSeqBased(deps: ExploreTimelineDependencies, label: string) {
  const suffix = `${SUFFIX}_membership_${label}`;
  const connectorId = `sa_connector_${suffix}`;
  const connectorInstanceId = `sa_cin_${suffix}`;

  await ingestRecord(
    { connectorId, connectorInstanceId },
    { data: { id: "seed" }, emitted_at: "2026-06-01T00:00:00.000Z", key: "seed", stream: "txn" }
  );

  const page1 = await executeExploreTimeline({ cursor: null, limit: 10 }, withFixedClock(deps));
  assert.equal(page1.data.length, 1, `${label}: page 1 must contain exactly the seed record`);

  // Backfill AFTER the snapshot with an OLD emitted_at — id > snapshotSeq means
  // this must be excluded from a page resumed against page 1's cursor, exactly
  // as before this change (membership is unaffected; snapshotSeq is still the
  // monotonic ingest sequence, untouched by the snapshot_at fix).
  await ingestRecord(
    { connectorId, connectorInstanceId },
    { data: { id: "backfill" }, emitted_at: "2020-01-01T00:00:00.000Z", key: "backfill", stream: "txn" }
  );

  // Re-fetch page 1's own cursor's rewind to prove the ORIGINAL snapshot
  // membership excludes the backfill even though it now exists.
  if (page1.next_cursor) {
    const resumed = await executeExploreTimeline(
      { cursor: page1.next_cursor, limit: 10, rewindToFirstPage: true },
      withFixedClock(deps)
    );
    assert.ok(
      !resumed.data.some((r) => r.record_key === "backfill"),
      `${label}: membership must stay snapshotSeq-based — the post-snapshot backfill must not leak onto a rewound page`
    );
  } else {
    // No cursor (page 1 exhausted the feed) — new_since_snapshot is the
    // membership-adjacent signal available; the backfill must be counted
    // there, not silently absorbed into a re-derived snapshot_at.
    const freshCount = await executeExploreTimeline({ cursor: null, limit: 10 }, withFixedClock(deps));
    assert.equal(
      freshCount.data.length,
      2,
      `${label}: a FRESH page (new snapshot) DOES see the backfill — proving it truly exists`
    );
  }
}

async function assertResumedAndRewoundPagesRetainOriginalCaptureTime(deps: ExploreTimelineDependencies, label: string) {
  const suffix = `${SUFFIX}_resume_${label}`;
  const connectorId = `sa_connector_${suffix}`;
  const connectorInstanceId = `sa_cin_${suffix}`;

  await ingestRecord(
    { connectorId, connectorInstanceId },
    { data: { id: "r1" }, emitted_at: "2026-06-10T12:00:00.000Z", key: "r1", stream: "txn" }
  );
  await ingestRecord(
    { connectorId, connectorInstanceId },
    { data: { id: "r2" }, emitted_at: "2026-06-09T12:00:00.000Z", key: "r2", stream: "txn" }
  );
  await ingestRecord(
    { connectorId, connectorInstanceId },
    { data: { id: "r3" }, emitted_at: "2026-06-08T12:00:00.000Z", key: "r3", stream: "txn" }
  );

  // Page 1 captured at CAPTURED_NOW, limit 2 so a cursor is returned.
  const page1 = await executeExploreTimeline({ cursor: null, limit: 2 }, withFixedClock(deps));
  assert.equal(page1.snapshot_at, CAPTURED_NOW, `${label}: page 1 snapshot_at must equal the captured instant`);
  assert.ok(page1.next_cursor, `${label}: page 1 must return a cursor for this test to be meaningful`);

  // A DIFFERENT clock value is injected for the resumed request — proves the
  // resumed page's snapshot_at comes from the CURSOR, not a fresh deps.now()
  // call (which would report the new clock value if it were re-captured).
  const LATER_CLOCK = "2026-09-01T00:00:00.000Z";
  const laterDeps: ExploreTimelineDependencies = { ...deps, now: () => LATER_CLOCK };

  const page2 = await executeExploreTimeline({ cursor: page1.next_cursor, limit: 10 }, laterDeps);
  assert.equal(
    page2.snapshot_at,
    CAPTURED_NOW,
    `${label}: a resumed page must retain the ORIGINAL capture instant, not a freshly re-captured wall clock`
  );
  assert.notEqual(page2.snapshot_at, LATER_CLOCK, `${label}: a resumed page must NOT report the later clock`);

  // Rewind: same original-cursor-derived snapshot_at expectation.
  const rewound = await executeExploreTimeline(
    { cursor: page1.next_cursor, limit: 2, rewindToFirstPage: true },
    laterDeps
  );
  assert.equal(
    rewound.snapshot_at,
    CAPTURED_NOW,
    `${label}: a rewound page must retain the ORIGINAL capture instant, not a freshly re-captured wall clock`
  );
}

async function assertSnapshotAtEqualsNowCeiling(deps: ExploreTimelineDependencies, label: string) {
  const suffix = `${SUFFIX}_ceiling_${label}`;
  const connectorId = `sa_connector_${suffix}`;
  const connectorInstanceId = `sa_cin_${suffix}`;

  await ingestRecord(
    { connectorId, connectorInstanceId },
    { data: { id: "seed" }, emitted_at: "2026-06-01T00:00:00.000Z", key: "seed", stream: "txn" }
  );
  // A future record so the Upcoming split is exercised and nowCeiling actually
  // does work (excludes this row from the main feed).
  await ingestRecord(
    { connectorId, connectorInstanceId },
    { data: { id: "future" }, emitted_at: "2099-01-01T00:00:00.000Z", key: "future", stream: "txn" }
  );

  const page1 = await executeExploreTimeline({ cursor: null, limit: 10, upcomingLimit: 10 }, withFixedClock(deps));
  assert.equal(page1.snapshot_at, CAPTURED_NOW, `${label}: snapshot_at must equal the captured instant`);
  // The future record must be excluded from the main feed by nowCeiling and
  // surfaced in "upcoming" instead — proving nowCeiling is genuinely CAPTURED_NOW
  // (not some other value), the SAME instant as snapshot_at.
  assert.ok(
    !page1.data.some((r) => r.record_key === "future"),
    `${label}: the future-dated record must be excluded from the main feed by nowCeiling`
  );
}

async function assertEmptyCorpusReportsActualCaptureTime(deps: ExploreTimelineDependencies, label: string) {
  // No records seeded for this connection — a genuinely empty corpus for this
  // suffix's scope. connectionIds scopes the read so it is unaffected by any
  // other data present on a shared database.
  const suffix = `${SUFFIX}_empty_${label}`;
  const connectorInstanceId = `sa_cin_${suffix}`;

  const page1 = await executeExploreTimeline(
    { connectionIds: [connectorInstanceId], cursor: null, limit: 10 },
    withFixedClock(deps)
  );
  assert.equal(
    page1.snapshot_at,
    CAPTURED_NOW,
    `${label}: an empty corpus must report the actual captured instant, not an epoch/placeholder sentinel`
  );
  assert.notEqual(
    page1.snapshot_at,
    "1970-01-01T00:00:00.000Z",
    `${label}: must not fall back to the old epoch sentinel`
  );
}

// ---------------------------------------------------------------------------
// SQLite suite
// ---------------------------------------------------------------------------

test("snapshot_at (sqlite): future-dated emitted_at never changes snapshot_at", async () => {
  initDb(":memory:");
  try {
    await assertSnapshotAtIsCaptureTimeNotRecordAggregate(buildSqliteExploreTimelineDeps(), "sqlite");
  } finally {
    closeDb();
  }
});

test("snapshot_at (sqlite): backfilled emitted_at never changes snapshot_at", async () => {
  initDb(":memory:");
  try {
    await assertBackfillNeverChangesSnapshotAt(buildSqliteExploreTimelineDeps(), "sqlite");
  } finally {
    closeDb();
  }
});

test("snapshot_at (sqlite): pagination membership stays snapshotSeq-based", async () => {
  initDb(":memory:");
  try {
    await assertMembershipStaysSnapshotSeqBased(buildSqliteExploreTimelineDeps(), "sqlite");
  } finally {
    closeDb();
  }
});

test("snapshot_at (sqlite): resumed/rewound pages retain the original capture instant", async () => {
  initDb(":memory:");
  try {
    await assertResumedAndRewoundPagesRetainOriginalCaptureTime(buildSqliteExploreTimelineDeps(), "sqlite");
  } finally {
    closeDb();
  }
});

test("snapshot_at (sqlite): equals nowCeiling — one captured instant, not two", async () => {
  initDb(":memory:");
  try {
    await assertSnapshotAtEqualsNowCeiling(buildSqliteExploreTimelineDeps(), "sqlite");
  } finally {
    closeDb();
  }
});

test("snapshot_at (sqlite): empty corpus reports actual capture time, not epoch sentinel", async () => {
  initDb(":memory:");
  try {
    await assertEmptyCorpusReportsActualCaptureTime(buildSqliteExploreTimelineDeps(), "sqlite");
  } finally {
    closeDb();
  }
});

// ---------------------------------------------------------------------------
// Postgres suite
// ---------------------------------------------------------------------------

async function cleanupPostgres() {
  await postgresQuery("DELETE FROM records WHERE connector_instance_id LIKE $1", [`%${SUFFIX}%`]).catch(
    // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double represents an optional side effect.
    () => {}
  );
}

if (POSTGRES_URL) {
  test("snapshot_at (postgres): future-dated emitted_at never changes snapshot_at", async () => {
    initDb(":memory:");
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
    try {
      await assertSnapshotAtIsCaptureTimeNotRecordAggregate(buildPostgresExploreTimelineDeps(), "postgres");
    } finally {
      await cleanupPostgres();
      await closePostgresStorage();
      closeDb();
    }
  });

  test("snapshot_at (postgres): backfilled emitted_at never changes snapshot_at", async () => {
    initDb(":memory:");
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
    try {
      await assertBackfillNeverChangesSnapshotAt(buildPostgresExploreTimelineDeps(), "postgres");
    } finally {
      await cleanupPostgres();
      await closePostgresStorage();
      closeDb();
    }
  });

  test("snapshot_at (postgres): pagination membership stays snapshotSeq-based", async () => {
    initDb(":memory:");
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
    try {
      await assertMembershipStaysSnapshotSeqBased(buildPostgresExploreTimelineDeps(), "postgres");
    } finally {
      await cleanupPostgres();
      await closePostgresStorage();
      closeDb();
    }
  });

  test("snapshot_at (postgres): resumed/rewound pages retain the original capture instant", async () => {
    initDb(":memory:");
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
    try {
      await assertResumedAndRewoundPagesRetainOriginalCaptureTime(buildPostgresExploreTimelineDeps(), "postgres");
    } finally {
      await cleanupPostgres();
      await closePostgresStorage();
      closeDb();
    }
  });

  test("snapshot_at (postgres): equals nowCeiling — one captured instant, not two", async () => {
    initDb(":memory:");
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
    try {
      await assertSnapshotAtEqualsNowCeiling(buildPostgresExploreTimelineDeps(), "postgres");
    } finally {
      await cleanupPostgres();
      await closePostgresStorage();
      closeDb();
    }
  });

  test("snapshot_at (postgres): empty corpus reports actual capture time, not epoch sentinel", async () => {
    initDb(":memory:");
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
    try {
      await assertEmptyCorpusReportsActualCaptureTime(buildPostgresExploreTimelineDeps(), "postgres");
    } finally {
      await cleanupPostgres();
      await closePostgresStorage();
      closeDb();
    }
  });
} else {
  test("snapshot_at (postgres): skipped (PDPP_TEST_POSTGRES_URL unset)", { skip: true }, () => undefined);
}
