// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Concurrency oracle for the transaction-native connector-instance write
 * fence (harden-connector-instance-write-fence-transaction-native).
 *
 * The defect this replaces: `withConnectorInstanceWrite` used to hold a
 * SESSION-scoped `pg_try_advisory_lock` on a DEDICATED connection
 * (`getPostgresLockPool()`, default 4 connections) for the ENTIRE duration
 * of a batch/blob-write callback — including every `afterRecord` await.
 * Under concurrent same-instance ingest/blob pressure, or a slow/large
 * batch, other writers for the SAME instance (and, because the dedicated
 * pool's capacity clamped `activeLimit()`, writers for OTHER instances too)
 * queued behind `PDPP_INGEST_LOCK_WAIT_MS` and 503'd
 * (`ConnectorInstanceAdmissionError`) — the live incident shape: GroupMe
 * run_1786382625843_1 (4,551 records then `ingest_http_error`, checkpoints
 * `not_staged`) and GitHub run_1786382759095 (503 after 2.19s on the FIRST
 * record).
 *
 * The fix: `pg_advisory_xact_lock`, acquired inside `withPostgresTransaction`
 * (`lockConnectorInstanceId` option) as the first statement of each
 * PER-RECORD/PER-UNIT durable transaction — never held for a whole batch,
 * rides the transaction's own connection (zero extra pool connections).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { connectorInstanceWriteCoordinatorStatsForTests } from "../server/connector-instance-write-coordinator.ts";
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from "../server/owner-auth.ts";
import {
  closePostgresStorage,
  getPostgresPool,
  initPostgresStorage,
  postgresQuery,
} from "../server/postgres-storage.ts";
// biome-ignore lint/performance/noNamespaceImport: matches the established convention for this untyped-boundary module (see connector-instance-delete-vs-queued-write-fence.test.ts).
import * as recordsModule from "../server/records.ts";
import { createPostgresConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";

const DEDICATED_POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);

const NOW = "2026-08-10T00:00:00.000Z";

interface StorageTarget {
  connector_id: string;
  connector_instance_id: string;
}

type IngestRecordsFn = (
  storageTarget: StorageTarget,
  records: Array<{ data: Record<string, unknown>; emitted_at: string; key: string; stream: string }>,
  afterRecord?: (record: unknown, outcome: unknown) => Promise<void>,
  options?: { requireConnectionAdmission?: boolean; runId?: string | null }
) => Promise<Array<{ accepted: boolean; changed: boolean }>>;

type PersistBlobFn = (args: {
  connectorId: string;
  connectorInstanceId?: string | null;
  data: Buffer;
  mimeType: string;
  recordKey: string;
  stream: string;
}) => Promise<{ blob_id: string }>;

const ingestRecords = recordsModule.ingestRecords as unknown as IngestRecordsFn;

function manifest(connectorId: string) {
  return {
    capabilities: { human_interaction: [] },
    connector_id: connectorId,
    display_name: "Transaction Lock Probe Connector",
    protocol_version: "0.1.0",
    streams: [
      {
        name: "events",
        primary_key: ["id"],
        schema: {
          properties: { id: { type: "string" }, value: { type: ["string", "null"] } },
          required: ["id"],
          type: "object",
        },
      },
    ],
    version: "1.0.0",
  };
}

function recordEnvelope(id: string, delayMarker?: string) {
  return {
    data: { id, value: delayMarker ?? "probe" },
    emitted_at: NOW,
    key: id,
    stream: "events",
  };
}

async function seedInstance(connectorId: string, connectorInstanceId: string) {
  await postgresQuery(
    "INSERT INTO connectors(connector_id, manifest, created_at) VALUES($1, $2::jsonb, $3) ON CONFLICT(connector_id) DO NOTHING",
    [connectorId, JSON.stringify(manifest(connectorId)), NOW]
  );
  const store = createPostgresConnectorInstanceStore();
  await store.upsert({
    connectorId,
    connectorInstanceId,
    createdAt: NOW,
    displayName: "Probe",
    ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    sourceBinding: { account: `${connectorInstanceId}@example.com` },
    sourceBindingKey: `probe-${connectorInstanceId}@example.com`,
    sourceKind: "account",
    status: "active",
    updatedAt: NOW,
  });
}

async function cleanupIdentity(connectorInstanceId: string) {
  await postgresQuery("DELETE FROM connector_instance_tombstones WHERE connector_instance_id = $1", [
    connectorInstanceId,
  ]);
  await postgresQuery("DELETE FROM records WHERE connector_instance_id = $1", [connectorInstanceId]);
  await postgresQuery("DELETE FROM record_changes WHERE connector_instance_id = $1", [connectorInstanceId]);
  await postgresQuery("DELETE FROM version_counter WHERE connector_instance_id = $1", [connectorInstanceId]);
  await postgresQuery("DELETE FROM blob_bindings WHERE connector_instance_id = $1", [connectorInstanceId]);
  await postgresQuery("DELETE FROM blobs WHERE connector_instance_id = $1", [connectorInstanceId]);
  await postgresQuery("DELETE FROM connector_instances WHERE connector_instance_id = $1", [connectorInstanceId]);
}

// Deletes the shared `connectors` row only after EVERY instance sharing it
// has already been cleaned up via `cleanupIdentity` — the FK from
// `connector_instances.connector_id` would otherwise refuse a premature
// delete when more than one instance shares one `connectorId` (as the
// hot/cold unrelated-instance test below does).
async function cleanupConnector(connectorId: string) {
  await postgresQuery("DELETE FROM connectors WHERE connector_id = $1", [connectorId]);
}

function recordCount(rows: Array<{ accepted: boolean }>) {
  return rows.filter((row) => row.accepted).length;
}

test("Postgres: a slow same-instance batch (afterRecord holds each record) does NOT block a concurrent same-instance blob write — the blob completes almost immediately, not after the whole batch (skipped: PDPP_TEST_POSTGRES_URL unset or non-dedicated)", {
  skip: !DEDICATED_POSTGRES_URL,
}, async () => {
  const databaseUrl = DEDICATED_POSTGRES_URL;
  assert.ok(databaseUrl, "dedicated Postgres test URL is configured when this test runs");
  await initPostgresStorage({ backend: "postgres", databaseUrl });
  const connectorId = "txn_lock_batch_probe";
  const connectorInstanceId = "cin_txn_lock_batch_probe";
  try {
    await cleanupIdentity(connectorInstanceId);
    await cleanupConnector(connectorId);
    await seedInstance(connectorId, connectorInstanceId);
    const storageTarget = { connector_id: connectorId, connector_instance_id: connectorInstanceId };

    // A batch of 8 records, each held for 200ms in `afterRecord` (~1.6s
    // total) — mirrors the GroupMe/GitHub live-incident shape of a slow
    // record-by-record batch. THIS IS THE EXACT PRODUCTION PATH:
    // `ingestRecords` (server/records.ts), not a synthetic reproduction.
    // The terminal requirement: lifecycle exclusion is TRANSACTION-SIZED,
    // not batch-sized — a concurrent same-instance blob write must contend
    // only with EACH record's own short-lived fence/lock, never with a
    // lease held for the whole batch's duration (including `afterRecord`).
    // A same-instance blob write queued behind a batch-long lease would
    // take roughly the batch's remaining duration (>1s here); a blob write
    // contending only with each record's short fence completes in single-
    // digit milliseconds, regardless of how many records remain or how
    // long `afterRecord` holds.
    const pool = getPostgresPool();
    const totalCountBefore = pool.totalCount;

    const batchRecords = Array.from({ length: 8 }, (_, index) => recordEnvelope(`batch-${index}`));
    const batchPromise = ingestRecords(
      storageTarget,
      batchRecords,
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
      },
      { requireConnectionAdmission: true }
    );

    // Let the batch start and enter its first afterRecord hold.
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Concurrent same-instance blob write, racing the still-in-flight
    // batch — the EXACT production function (postgresPersistContentAddressedBlob),
    // not a mock. Must complete almost immediately: it may briefly queue
    // behind whichever ONE record is mid-transaction at this instant, but
    // never behind the batch's remaining ~1.4s.
    const { postgresPersistContentAddressedBlob } = (await import("../server/postgres-records.ts")) as {
      postgresPersistContentAddressedBlob: PersistBlobFn;
    };
    const blobStarted = performance.now();
    const blobResult = await postgresPersistContentAddressedBlob({
      connectorId,
      connectorInstanceId,
      data: Buffer.from("probe-blob-bytes"),
      mimeType: "text/plain",
      recordKey: "blob-probe-1",
      stream: "events",
    });
    const blobElapsedMs = performance.now() - blobStarted;
    assert.ok(blobResult.blob_id, "the concurrent same-instance blob write must succeed");
    assert.ok(
      blobElapsedMs < 500,
      `a same-instance blob write must contend only with ONE record's short transaction-scoped lock, never the whole batch's duration (~1.4s remaining) — took ${blobElapsedMs}ms`
    );

    const outcomes = await batchPromise;
    assert.equal(recordCount(outcomes), 8, "every batch record must still be accepted");

    const totalCountAfter = pool.totalCount;
    assert.ok(
      totalCountAfter <= totalCountBefore + 2,
      `no extra dedicated connection should have been held for the blob write's brief wait — before=${totalCountBefore}, after=${totalCountAfter}`
    );
  } finally {
    await cleanupIdentity(connectorInstanceId);
    await cleanupConnector(connectorId);
    await closePostgresStorage();
  }
});

test("Postgres: an unrelated connector instance's write is not starved by a saturated hot instance (skipped: PDPP_TEST_POSTGRES_URL unset or non-dedicated)", {
  skip: !DEDICATED_POSTGRES_URL,
}, async () => {
  const databaseUrl = DEDICATED_POSTGRES_URL;
  assert.ok(databaseUrl, "dedicated Postgres test URL is configured when this test runs");
  await initPostgresStorage({ backend: "postgres", databaseUrl });
  const connectorId = "txn_lock_unrelated_probe";
  const hotInstanceId = "cin_txn_lock_hot";
  const coldInstanceId = "cin_txn_lock_cold";
  try {
    await cleanupIdentity(hotInstanceId);
    await cleanupIdentity(coldInstanceId);
    await cleanupConnector(connectorId);
    await seedInstance(connectorId, hotInstanceId);
    await seedInstance(connectorId, coldInstanceId);

    const hotTarget = { connector_id: connectorId, connector_instance_id: hotInstanceId };
    const coldTarget = { connector_id: connectorId, connector_instance_id: coldInstanceId };

    // A sustained, slow batch on the HOT instance — models a stalled/large
    // ingest (GroupMe run_1786382625843_1's shape) that would previously
    // have saturated the global admission gate (activeLimit() clamped to
    // the now-removed dedicated lock pool's capacity) for every OTHER
    // instance's writers too, not just this one's.
    const hotRecords = Array.from({ length: 4 }, (_, index) => recordEnvelope(`hot-${index}`));
    const hotBatch = ingestRecords(
      hotTarget,
      hotRecords,
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
      },
      { requireConnectionAdmission: true }
    );
    await new Promise((resolve) => setTimeout(resolve, 30));

    // The cold, unrelated instance's write — models a concurrent unrelated
    // run (GitHub run_1786382759095's shape) that must complete promptly.
    const started = performance.now();
    const coldOutcomes = await ingestRecords(coldTarget, [recordEnvelope("cold-0")], undefined, {
      requireConnectionAdmission: true,
    });
    const elapsedMs = performance.now() - started;
    assert.equal(recordCount(coldOutcomes), 1, "the unrelated instance's write must be accepted");
    assert.ok(
      elapsedMs < 1000,
      `an unrelated instance's write must not queue behind a hot instance's batch — took ${elapsedMs}ms`
    );

    const hotOutcomes = await hotBatch;
    assert.equal(recordCount(hotOutcomes), 4, "the hot instance's batch must still fully complete");
  } finally {
    await cleanupIdentity(hotInstanceId);
    await cleanupIdentity(coldInstanceId);
    await cleanupConnector(connectorId);
    await closePostgresStorage();
  }
});

test("Postgres: connector-instance write coordination consumes zero extra pool connections beyond the main pool (skipped: PDPP_TEST_POSTGRES_URL unset or non-dedicated)", {
  skip: !DEDICATED_POSTGRES_URL,
}, async () => {
  const databaseUrl = DEDICATED_POSTGRES_URL;
  assert.ok(databaseUrl, "dedicated Postgres test URL is configured when this test runs");
  await initPostgresStorage({ backend: "postgres", databaseUrl });
  const connectorId = "txn_lock_pool_probe";
  const connectorInstanceId = "cin_txn_lock_pool_probe";
  try {
    await cleanupIdentity(connectorInstanceId);
    await cleanupConnector(connectorId);
    await seedInstance(connectorId, connectorInstanceId);
    const storageTarget = { connector_id: connectorId, connector_instance_id: connectorInstanceId };

    const pool = getPostgresPool();
    const totalCountBefore = pool.totalCount;

    // 5 concurrent same-instance writes: under the OLD design, each would
    // ALSO check out a connection from a separate dedicated lock pool for
    // the duration of its advisory-lock hold — a genuine second live
    // connection per in-flight coordinated writer. Under the NEW design,
    // the advisory lock rides the SAME connection the write's own
    // transaction already checked out from the main pool.
    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        ingestRecords(storageTarget, [recordEnvelope(`pool-${index}`)], undefined, {
          requireConnectionAdmission: true,
        })
      )
    );

    // No dedicated lock pool exists anymore to grow at all — the only pool
    // in play is the main one, and it never needs more live connections
    // than the concurrency actually in flight (bounded by
    // PDPP_INGEST_ACTIVE_BATCH_LIMIT, default 4).
    const totalCountAfter = pool.totalCount;
    assert.ok(
      totalCountAfter <= totalCountBefore + 5,
      `main pool connection count must not grow by more than the concurrent writer count (a second pool would double this) — before=${totalCountBefore}, after=${totalCountAfter}`
    );
    assert.equal(
      connectorInstanceWriteCoordinatorStatsForTests().activeOwnerships,
      0,
      "no ownership capability should remain live after all writes complete"
    );
  } finally {
    await cleanupIdentity(connectorInstanceId);
    await cleanupConnector(connectorId);
    await closePostgresStorage();
  }
});
