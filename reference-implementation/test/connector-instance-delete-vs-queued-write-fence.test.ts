// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PR #84 red-team claim: connection deletion versus a queued record/blob
 * write for the SAME connector_instance_id.
 *
 * `deleteConnection` and `ingestRecord`/`ingestRecords` both serialize
 * through the identical per-instance gate (`withConnectorInstanceWrite` in
 * `connector-instance-write-coordinator.ts`), so the two operations can
 * never run concurrently for one identity. What this test isolates is the
 * ORDERING once they are serialized:
 *
 *   A) write-first: the write acquires the gate, runs to completion, THEN
 *      the delete acquires the gate and purges everything. Expected/sane:
 *      the write's rows exist transiently, then the delete leaves a clean
 *      terminal state (no `records`/`record_changes`/`blobs`/`blob_bindings`
 *      rows, no `connector_instances` row, a tombstone present).
 *
 *   B) delete-first: the delete acquires the gate first, purges the
 *      connection (including any records the write's caller believed were
 *      already ingested is irrelevant here — the write hasn't run yet), and
 *      releases. The queued write THEN acquires the same gate afterward and
 *      runs `ingestRecord` against the now-deleted `connector_instance_id`.
 *
 * The coordinator only provides MUTUAL EXCLUSION, not an ordering-aware
 * REJECTION. `ingestSqliteRecord`/`ingestPostgresRecord` (server/records.ts)
 * perform zero existence/active-state check against `connector_instances`
 * before writing `records`/`record_changes`/`version_counter`. Neither the
 * SQLite schema (server/db.ts) nor the Postgres schema
 * (server/postgres-storage.ts) declares a foreign key from
 * `records`/`record_changes`/`blobs`/`blob_bindings` to
 * `connector_instances` (Postgres DOES declare FKs with ON DELETE CASCADE
 * for `connector_instance_credentials`, `acquisition_batches`, and
 * `record_acquisition_provenance` — the record/blob family is conspicuously
 * NOT among them). So ordering B is hypothesized to silently resurrect a
 * live `records` row (and, transitively, `blobs`/`blob_bindings`) for a
 * connector_instance_id that has a tombstone and no owning
 * `connector_instances` row — a zombie record invisible to
 * `deleteConnection`'s own purge (which already ran) and to any owner UI
 * that resolves connections by joining through `connector_instances`.
 *
 * The fix (`RecordIngestOptions.requireConnectionAdmission`) is opt-in:
 * `ingestRecord`/`ingestRecords` stay a connector-agnostic durable storage
 * primitive for direct callers (dozens of existing tests, internal repair
 * paths) that never enroll a `connector_instances` row. Only HTTP routes
 * that admit an external caller after resolving a real connection set
 * `requireConnectionAdmission: true` — this test exercises that opted-in
 * path directly, matching how `server/routes/rs-mutation.ts` calls it.
 *
 * Both orderings are driven deterministically in a single process via
 * `__setConnectorInstanceWritePhaseHookForTest`, which fires immediately
 * before the per-instance gate is acquired — the same seam
 * `connector-instance-write-coordinator.test.ts` uses for deterministic
 * interleaving. This is a genuine production-path exercise (the real
 * `deleteConnection` store method, the real `ingestRecord` ingest path, the
 * real coordinator, the real schema) — not a source-text assertion.
 */

import assert from "node:assert/strict";
import test from "node:test";
// biome-ignore lint/performance/noNamespaceImport: `server/auth.ts` is untyped-boundary legacy JS at several call sites; matches the records.ts import convention below.
import * as authModule from "../server/auth.ts";
import { __setConnectorInstanceWritePhaseHookForTest } from "../server/connector-instance-write-coordinator.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from "../server/owner-auth.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
// biome-ignore lint/performance/noNamespaceImport: `server/records.ts` is untyped-boundary legacy JS at several call sites; the namespace-import + local-type-recast pattern matches the established convention (see aggregate-time-buckets.test.ts).
import * as recordsModule from "../server/records.ts";
import {
  createPostgresConnectorInstanceStore,
  createSqliteConnectorInstanceStore,
} from "../server/stores/connector-instance-store.ts";
import {
  deletePostgresRecordRejectionsForConnectionWithClient,
  deleteSqliteRecordRejectionsForConnectionWithinTransaction,
} from "../server/stores/record-rejection-store.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";

const DEDICATED_POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);

const CONNECTOR_ID = "delete_fence_probe";
const STREAM = "events";
const NOW = "2026-08-07T00:00:00.000Z";

interface StorageTarget {
  connector_id: string;
  connector_instance_id: string;
}

type IngestRecordFn = (
  storageTarget: StorageTarget,
  record: { data: Record<string, unknown>; emitted_at: string; key: string; stream: string },
  options?: { requireConnectionAdmission?: boolean }
) => Promise<{ accepted: boolean; changed: boolean }>;

const ingestRecord = recordsModule.ingestRecord as unknown as IngestRecordFn;
const registerConnector = authModule.registerConnector as unknown as (manifest: object) => Promise<string>;

/**
 * Drives `first` to full completion (acquiring and releasing the
 * per-instance gate) BEFORE `second` even attempts to acquire it. This
 * deterministically produces the "queued write" ordering under test: since
 * `deleteConnection` and `ingestRecord` both serialize through the SAME
 * `withConnectorInstanceWrite` gate for one `connector_instance_id`, a
 * strict await-then-await sequence on the SAME identity is equivalent (for
 * outcome purposes) to `second` having been queued behind `first` and
 * dequeued only once `first` released — the coordinator provides no other
 * ordering-sensitive behavior between a released gate and a fresh
 * acquisition. `__setConnectorInstanceWritePhaseHookForTest` (the same seam
 * `connector-instance-write-coordinator.test.ts` uses) instruments both
 * acquisitions so the recorded order is asserted, not merely assumed.
 */
async function sequenceThroughGate<A, B>(
  connectorInstanceId: string,
  first: () => Promise<A>,
  second: () => Promise<B>
): Promise<{ acquisitionOrder: string[]; firstResult: A; secondResult: B }> {
  const acquisitionOrder: string[] = [];
  let phase: "first" | "second" = "first";

  __setConnectorInstanceWritePhaseHookForTest((stage, context) => {
    if (context.connectorInstanceId !== connectorInstanceId || stage !== "before_key_acquire") {
      return;
    }
    acquisitionOrder.push(phase);
  });

  try {
    const firstResult = await first();
    phase = "second";
    const secondResult = await second();
    return { acquisitionOrder, firstResult, secondResult };
  } finally {
    __setConnectorInstanceWritePhaseHookForTest(null);
  }
}

function recordEnvelope(id: string) {
  return {
    data: { id, value: "probe" },
    emitted_at: NOW,
    key: id,
    stream: STREAM,
  };
}

function manifest() {
  return {
    capabilities: { human_interaction: [] },
    connector_id: CONNECTOR_ID,
    display_name: "Delete Fence Probe Connector",
    manifest_uri: `https://sources.example/${CONNECTOR_ID}`,
    protocol_version: "0.1.0",
    streams: [
      {
        name: STREAM,
        primary_key: ["id"],
        schema: {
          properties: { id: { type: "string" }, value: { type: ["string", "null"] } },
          required: ["id"],
          type: "object",
        },
        selection: { fields: true, resources: true },
        semantics: "mutable_state",
      },
    ],
    version: "1.0.0",
  };
}

function sqlitePurge() {
  return {
    deleteRecordRejectionsPostgres: () => {
      throw new Error("deleteRecordRejectionsPostgres must not be called by the SQLite store");
    },
    deleteRecordRejectionsSqlite: (connectorInstanceId: string, ownerSubjectId: string) =>
      deleteSqliteRecordRejectionsForConnectionWithinTransaction({ connectorInstanceId, ownerSubjectId }),
    deleteRecordRowsPostgres: () => {
      throw new Error("deleteRecordRowsPostgres must not be called by the SQLite store");
    },
    deleteRecordRowsSqlite: (connectorInstanceId: string) =>
      recordsModule.deleteConnectionRecordRowsSqlite(connectorInstanceId),
    enumerateStreams: (storageTarget: StorageTarget) => recordsModule.enumerateConnectionStreams(storageTarget),
    teardownProjection: (args: {
      connectorId: string;
      connectorInstanceId: string;
      streams: string[];
      deletedRecordCount: number;
    }) => recordsModule.teardownConnectionSearchProjection(args),
  };
}

function postgresPurge() {
  return {
    deleteRecordRejectionsPostgres: (client: unknown, connectorInstanceId: string, ownerSubjectId: string) =>
      deletePostgresRecordRejectionsForConnectionWithClient(
        client as Parameters<typeof deletePostgresRecordRejectionsForConnectionWithClient>[0],
        { connectorInstanceId, ownerSubjectId }
      ),
    deleteRecordRejectionsSqlite: () => {
      throw new Error("deleteRecordRejectionsSqlite must not be called by the Postgres store");
    },
    deleteRecordRowsPostgres: (client: unknown, connectorInstanceId: string) =>
      recordsModule.deleteConnectionRecordRowsPostgres(client as never, connectorInstanceId),
    deleteRecordRowsSqlite: () => {
      throw new Error("deleteRecordRowsSqlite must not be called by the Postgres store");
    },
    enumerateStreams: (storageTarget: StorageTarget) => recordsModule.enumerateConnectionStreams(storageTarget),
    teardownProjection: (args: {
      connectorId: string;
      connectorInstanceId: string;
      streams: string[];
      deletedRecordCount: number;
    }) => recordsModule.teardownConnectionSearchProjection(args),
  };
}

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

async function seedSqliteInstance(connectorInstanceId: string) {
  const store = createSqliteConnectorInstanceStore();
  await store.upsert({
    connectorId: CONNECTOR_ID,
    connectorInstanceId,
    createdAt: NOW,
    displayName: "Probe",
    ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    sourceBinding: { account: "probe@example.com" },
    sourceBindingKey: `probe-${connectorInstanceId}@example.com`,
    sourceKind: "account",
    status: "active",
    updatedAt: NOW,
  });
}

function sqliteRowCounts(connectorInstanceId: string) {
  const db = getDb();
  const count = (table: string) =>
    (
      db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE connector_instance_id = ?`).get(connectorInstanceId) as {
        n: number;
      }
    ).n;
  return {
    blobBindings: count("blob_bindings"),
    blobs: count("blobs"),
    connectorInstance: (
      db
        .prepare("SELECT COUNT(*) AS n FROM connector_instances WHERE connector_instance_id = ?")
        .get(connectorInstanceId) as { n: number }
    ).n,
    recordChanges: count("record_changes"),
    records: count("records"),
    tombstone: (
      db
        .prepare("SELECT COUNT(*) AS n FROM connector_instance_tombstones WHERE connector_instance_id = ?")
        .get(connectorInstanceId) as { n: number }
    ).n,
  };
}

test("SQLite: write-admitted-first then delete leaves a clean terminal state (ordering A)", async () => {
  initDb();
  try {
    await registerConnector(manifest());
    const connectorInstanceId = "cin_delete_fence_a";
    await seedSqliteInstance(connectorInstanceId);
    const storageTarget = { connector_id: CONNECTOR_ID, connector_instance_id: connectorInstanceId };
    const store = createSqliteConnectorInstanceStore();

    const { acquisitionOrder } = await sequenceThroughGate(
      connectorInstanceId,
      () => ingestRecord(storageTarget, recordEnvelope("rec_a"), { requireConnectionAdmission: true }),
      () =>
        store.deleteConnection(connectorInstanceId, {
          now: NOW,
          ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
          purge: sqlitePurge(),
        })
    );
    assert.deepEqual(acquisitionOrder, ["first", "second"], "the write must acquire the gate before the delete");

    const counts = sqliteRowCounts(connectorInstanceId);
    assert.deepEqual(
      counts,
      {
        blobBindings: 0,
        blobs: 0,
        connectorInstance: 0,
        recordChanges: 0,
        records: 0,
        tombstone: 1,
      },
      `ordering A must leave a clean terminal state — got ${JSON.stringify(counts)}`
    );
  } finally {
    closeDb();
  }
});

test("SQLite: delete-commits-first then a queued write is refused, never creating post-delete zombie state (ordering B)", async () => {
  initDb();
  try {
    await registerConnector(manifest());
    const connectorInstanceId = "cin_delete_fence_b";
    await seedSqliteInstance(connectorInstanceId);
    const storageTarget = { connector_id: CONNECTOR_ID, connector_instance_id: connectorInstanceId };
    const store = createSqliteConnectorInstanceStore();

    const acquisitionOrder: string[] = [];
    let phase: "first" | "second" = "first";
    __setConnectorInstanceWritePhaseHookForTest((stage, context) => {
      if (context.connectorInstanceId === connectorInstanceId && stage === "before_key_acquire") {
        acquisitionOrder.push(phase);
      }
    });

    let deleteOutcome: Awaited<ReturnType<typeof store.deleteConnection>> | undefined;
    let writeError: unknown;
    try {
      deleteOutcome = await store.deleteConnection(connectorInstanceId, {
        now: NOW,
        ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
        purge: sqlitePurge(),
      });
      phase = "second";
      await ingestRecord(storageTarget, recordEnvelope("rec_b"), { requireConnectionAdmission: true });
    } catch (err) {
      writeError = err;
    } finally {
      __setConnectorInstanceWritePhaseHookForTest(null);
    }
    assert.deepEqual(acquisitionOrder, ["first", "second"], "the delete must acquire the gate before the queued write");
    assert.ok(deleteOutcome, "delete must complete and report a summary before the queued write runs");

    // Without `assertConnectorInstanceWritable` in server/records.ts, this
    // queued write silently succeeds (accepted=true, changed=true) and
    // inserts a live `records` + `record_changes` row for a
    // connector_instance_id with no `connector_instances` row — a zombie
    // record. WITH the fix, it must throw the same typed
    // `connector_instance_not_found` the delete route's own ownership check
    // raises.
    assert.ok(writeError instanceof Error, "the queued write must throw, not silently succeed");
    assert.equal(
      (writeError as { code?: string }).code,
      "connector_instance_not_found",
      `queued write must be refused with connector_instance_not_found — got ${String(writeError)}`
    );

    const counts = sqliteRowCounts(connectorInstanceId);
    assert.deepEqual(
      counts,
      { blobBindings: 0, blobs: 0, connectorInstance: 0, recordChanges: 0, records: 0, tombstone: 1 },
      `no zombie row may exist after the refused write — got ${JSON.stringify(counts)}`
    );
  } finally {
    closeDb();
  }
});

test("SQLite negative control: generic ingest remains ungated unless a lifecycle-aware caller opts in", async () => {
  initDb();
  try {
    await registerConnector(manifest());
    const connectorInstanceId = "cin_delete_fence_negative_control";
    await seedSqliteInstance(connectorInstanceId);
    const storageTarget = { connector_id: CONNECTOR_ID, connector_instance_id: connectorInstanceId };
    const store = createSqliteConnectorInstanceStore();

    await store.deleteConnection(connectorInstanceId, {
      now: NOW,
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      purge: sqlitePurge(),
    });
    const outcome = await ingestRecord(storageTarget, recordEnvelope("rec_negative_control"));

    assert.deepEqual(outcome, { accepted: true, changed: true, version: 1 });
    assert.equal(sqliteRowCounts(connectorInstanceId).records, 1);
  } finally {
    closeDb();
  }
});

// ---------------------------------------------------------------------------
// Postgres (skipped unless PDPP_TEST_POSTGRES_URL targets the dedicated,
// loopback-only test listener — see test/helpers/dedicated-postgres-test-url.ts)
// ---------------------------------------------------------------------------

async function seedPostgresInstance(connectorInstanceId: string) {
  await postgresQuery(
    "INSERT INTO connectors(connector_id, manifest, created_at) VALUES($1, $2::jsonb, $3) ON CONFLICT(connector_id) DO NOTHING",
    [CONNECTOR_ID, JSON.stringify(manifest()), NOW]
  );
  const store = createPostgresConnectorInstanceStore();
  await store.upsert({
    connectorId: CONNECTOR_ID,
    connectorInstanceId,
    createdAt: NOW,
    displayName: "Probe",
    ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    sourceBinding: { account: "probe@example.com" },
    sourceBindingKey: `probe-${connectorInstanceId}@example.com`,
    sourceKind: "account",
    status: "active",
    updatedAt: NOW,
  });
}

async function postgresRowCounts(connectorInstanceId: string) {
  const count = async (table: string) => {
    const result = await postgresQuery<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM ${table} WHERE connector_instance_id = $1`,
      [connectorInstanceId]
    );
    return Number(result.rows[0]?.n ?? 0);
  };
  return {
    blobBindings: await count("blob_bindings"),
    blobs: await count("blobs"),
    connectorInstance: await count("connector_instances"),
    recordChanges: await count("record_changes"),
    records: await count("records"),
    tombstone: await count("connector_instance_tombstones"),
  };
}

async function cleanupPostgresIdentity(connectorInstanceId: string) {
  await postgresQuery("DELETE FROM connector_instance_tombstones WHERE connector_instance_id = $1", [
    connectorInstanceId,
  ]);
  await postgresQuery("DELETE FROM records WHERE connector_instance_id = $1", [connectorInstanceId]);
  await postgresQuery("DELETE FROM record_changes WHERE connector_instance_id = $1", [connectorInstanceId]);
  await postgresQuery("DELETE FROM version_counter WHERE connector_instance_id = $1", [connectorInstanceId]);
  await postgresQuery("DELETE FROM connector_instances WHERE connector_instance_id = $1", [connectorInstanceId]);
  await postgresQuery("DELETE FROM connectors WHERE connector_id = $1", [CONNECTOR_ID]);
}

test("Postgres: write-admitted-first then delete leaves a clean terminal state (ordering A) (skipped: PDPP_TEST_POSTGRES_URL unset or non-dedicated)", {
  skip: !DEDICATED_POSTGRES_URL,
}, async () => {
  const databaseUrl = DEDICATED_POSTGRES_URL;
  assert.ok(databaseUrl, "dedicated Postgres test URL is configured when this test runs");
  await initPostgresStorage({ backend: "postgres", databaseUrl });
  const connectorInstanceId = "cin_delete_fence_pg_a";
  try {
    await cleanupPostgresIdentity(connectorInstanceId);
    await seedPostgresInstance(connectorInstanceId);
    const storageTarget = { connector_id: CONNECTOR_ID, connector_instance_id: connectorInstanceId };
    const store = createPostgresConnectorInstanceStore();

    const { acquisitionOrder } = await sequenceThroughGate(
      connectorInstanceId,
      () => ingestRecord(storageTarget, recordEnvelope("rec_pg_a"), { requireConnectionAdmission: true }),
      () =>
        store.deleteConnection(connectorInstanceId, {
          now: NOW,
          ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
          purge: postgresPurge(),
        })
    );
    assert.deepEqual(acquisitionOrder, ["first", "second"], "the write must acquire the gate before the delete");

    const counts = await postgresRowCounts(connectorInstanceId);
    assert.deepEqual(
      counts,
      { blobBindings: 0, blobs: 0, connectorInstance: 0, recordChanges: 0, records: 0, tombstone: 1 },
      `ordering A must leave a clean terminal state — got ${JSON.stringify(counts)}`
    );
  } finally {
    await cleanupPostgresIdentity(connectorInstanceId);
    await closePostgresStorage();
  }
});

test("Postgres: delete-commits-first then a queued write is refused, never creating post-delete zombie state (ordering B) (skipped: PDPP_TEST_POSTGRES_URL unset or non-dedicated)", {
  skip: !DEDICATED_POSTGRES_URL,
}, async () => {
  const databaseUrl = DEDICATED_POSTGRES_URL;
  assert.ok(databaseUrl, "dedicated Postgres test URL is configured when this test runs");
  await initPostgresStorage({ backend: "postgres", databaseUrl });
  const connectorInstanceId = "cin_delete_fence_pg_b";
  try {
    await cleanupPostgresIdentity(connectorInstanceId);
    await seedPostgresInstance(connectorInstanceId);
    const storageTarget = { connector_id: CONNECTOR_ID, connector_instance_id: connectorInstanceId };
    const store = createPostgresConnectorInstanceStore();

    const acquisitionOrder: string[] = [];
    let phase: "first" | "second" = "first";
    __setConnectorInstanceWritePhaseHookForTest((stage, context) => {
      if (context.connectorInstanceId === connectorInstanceId && stage === "before_key_acquire") {
        acquisitionOrder.push(phase);
      }
    });

    let deleteOutcome: Awaited<ReturnType<typeof store.deleteConnection>> | undefined;
    let writeError: unknown;
    try {
      deleteOutcome = await store.deleteConnection(connectorInstanceId, {
        now: NOW,
        ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
        purge: postgresPurge(),
      });
      phase = "second";
      await ingestRecord(storageTarget, recordEnvelope("rec_pg_b"), { requireConnectionAdmission: true });
    } catch (err) {
      writeError = err;
    } finally {
      __setConnectorInstanceWritePhaseHookForTest(null);
    }
    assert.deepEqual(acquisitionOrder, ["first", "second"], "the delete must acquire the gate before the queued write");
    assert.ok(deleteOutcome, "delete must complete and report a summary before the queued write runs");

    assert.ok(writeError instanceof Error, "the queued write must throw, not silently succeed");
    assert.equal(
      (writeError as { code?: string }).code,
      "connector_instance_not_found",
      `queued write must be refused with connector_instance_not_found — got ${String(writeError)}`
    );

    const counts = await postgresRowCounts(connectorInstanceId);
    assert.deepEqual(
      counts,
      { blobBindings: 0, blobs: 0, connectorInstance: 0, recordChanges: 0, records: 0, tombstone: 1 },
      `no zombie row may exist after the refused write — got ${JSON.stringify(counts)}`
    );
  } finally {
    await cleanupPostgresIdentity(connectorInstanceId);
    await closePostgresStorage();
  }
});
