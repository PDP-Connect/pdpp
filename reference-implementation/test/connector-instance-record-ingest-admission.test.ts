// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
// biome-ignore lint/performance/noNamespaceImport: legacy JS boundary; local recasts keep this focused integration test typed.
import * as authModule from "../server/auth.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from "../server/owner-auth.ts";
// biome-ignore lint/performance/noNamespaceImport: test drives the explicit Postgres transaction seam.
import * as postgresRecordsModule from "../server/postgres-records.ts";
import {
  closePostgresStorage,
  initPostgresStorage,
  postgresQuery,
  withPostgresTransaction,
} from "../server/postgres-storage.ts";
// biome-ignore lint/performance/noNamespaceImport: test exercises the real ingest and delete primitives.
import * as recordsModule from "../server/records.ts";
import {
  createPostgresConnectorInstanceStore,
  createSqliteConnectorInstanceStore,
} from "../server/stores/connector-instance-store.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";

const CONNECTOR_ID = "record_ingest_admission_probe";
const DEDICATED_POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
const NOW = "2026-08-13T00:00:00.000Z";
const STREAM = "events";

interface StorageTarget {
  connector_id: string;
  connector_instance_id: string;
}

type IngestRecord = (
  target: StorageTarget,
  record: { data: Record<string, unknown>; emitted_at: string; key: string; stream: string },
  options?: { requireConnectionAdmission?: boolean }
) => Promise<{ accepted: boolean; changed: boolean }>;

const ingestRecord = recordsModule.ingestRecord as unknown as IngestRecord;
const registerConnector = authModule.registerConnector as unknown as (manifest: object) => Promise<string>;

function manifest() {
  return {
    capabilities: { human_interaction: [] },
    connector_id: CONNECTOR_ID,
    display_name: "Record ingest admission probe",
    protocol_version: "0.1.0",
    streams: [
      {
        name: STREAM,
        primary_key: ["id"],
        schema: {
          properties: { id: { type: "string" }, value: { type: "string" } },
          required: ["id", "value"],
          type: "object",
        },
      },
    ],
    version: "1.0.0",
  };
}

function record(id: string) {
  return { data: { id, value: "probe" }, emitted_at: NOW, key: id, stream: STREAM };
}

function target(connectorInstanceId: string): StorageTarget {
  return { connector_id: CONNECTOR_ID, connector_instance_id: connectorInstanceId };
}

async function seedSqlite(connectorInstanceId: string, status = "active") {
  const store = createSqliteConnectorInstanceStore();
  await store.upsert({
    connectorId: CONNECTOR_ID,
    connectorInstanceId,
    createdAt: NOW,
    displayName: "Probe",
    ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    sourceBinding: { account: connectorInstanceId },
    sourceBindingKey: connectorInstanceId,
    sourceKind: "account",
    status,
    updatedAt: NOW,
  });
  return store;
}

function sqlitePurge() {
  return {
    deleteRecordRowsPostgres: () => {
      throw new Error("Postgres purge must not run for SQLite");
    },
    deleteRecordRowsSqlite: (connectorInstanceId: string) =>
      recordsModule.deleteConnectionRecordRowsSqlite(connectorInstanceId),
    enumerateStreams: (storageTarget: StorageTarget) => recordsModule.enumerateConnectionStreams(storageTarget),
    teardownProjection: (args: Parameters<typeof recordsModule.teardownConnectionSearchProjection>[0]) =>
      recordsModule.teardownConnectionSearchProjection(args),
  };
}

function sqliteRecordCount(connectorInstanceId: string): number {
  return (
    getDb()
      .prepare("SELECT COUNT(*) AS count FROM records WHERE connector_instance_id = ?")
      .get(connectorInstanceId) as { count: number }
  ).count;
}

test("SQLite: direct callers retain connector-agnostic ingest unless they opt into admission", async () => {
  initDb();
  try {
    await registerConnector(manifest());
    const outcome = await ingestRecord(target("unregistered_compatibility_instance"), record("compatibility"));
    assert.deepEqual(outcome, { accepted: true, changed: true });
  } finally {
    closeDb();
  }
});

test("SQLite: delete-first record ingest is refused and cannot create a zombie row", async () => {
  initDb();
  try {
    await registerConnector(manifest());
    const connectorInstanceId = "cin_sqlite_deleted";
    const store = await seedSqlite(connectorInstanceId);
    await store.deleteConnection(connectorInstanceId, {
      now: NOW,
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      purge: sqlitePurge(),
    });

    await assert.rejects(
      ingestRecord(target(connectorInstanceId), record("deleted"), { requireConnectionAdmission: true }),
      { code: "connector_instance_not_found" }
    );
    assert.equal(sqliteRecordCount(connectorInstanceId), 0);
  } finally {
    closeDb();
  }
});

test("SQLite: a revoke that lands after the early check is refused by the durable transaction", async () => {
  initDb();
  try {
    await registerConnector(manifest());
    const connectorInstanceId = "cin_sqlite_revoked_race";
    const store = await seedSqlite(connectorInstanceId);
    let releaseWriter: (() => void) | undefined;
    const writerPaused = new Promise<void>((resolve) => {
      recordsModule.__setAdmissionPreCheckPhaseHookForTest(async (point: string, context: Record<string, unknown>) => {
        if (point !== "after-admission-pre-check" || context.connectorInstanceId !== connectorInstanceId) {
          return;
        }
        resolve();
        await new Promise<void>((resume) => {
          releaseWriter = resume;
        });
      });
    });

    try {
      const writer = ingestRecord(target(connectorInstanceId), record("revoked-race"), {
        requireConnectionAdmission: true,
      });
      await writerPaused;
      store.updateStatus(connectorInstanceId, { revokedAt: NOW, status: "revoked", updatedAt: NOW });
      assert.ok(releaseWriter, "the writer must be paused after its early admission check");
      releaseWriter();
      await assert.rejects(writer, { code: "connector_instance_not_writable" });
      assert.equal(sqliteRecordCount(connectorInstanceId), 0);
    } finally {
      recordsModule.__setAdmissionPreCheckPhaseHookForTest(null);
    }
  } finally {
    closeDb();
  }
});

for (const status of ["active", "draft", "paused"]) {
  test(`SQLite: a ${status} connector instance remains writable when admitted`, async () => {
    initDb();
    try {
      await registerConnector(manifest());
      const connectorInstanceId = `cin_sqlite_${status}`;
      await seedSqlite(connectorInstanceId, status);
      const outcome = await ingestRecord(target(connectorInstanceId), record(status), {
        requireConnectionAdmission: true,
      });
      assert.deepEqual(outcome, { accepted: true, changed: true });
    } finally {
      closeDb();
    }
  });
}

async function seedPostgres(connectorInstanceId: string) {
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
    sourceBinding: { account: connectorInstanceId },
    sourceBindingKey: connectorInstanceId,
    sourceKind: "account",
    status: "active",
    updatedAt: NOW,
  });
  return store;
}

async function cleanupPostgres(connectorInstanceId: string): Promise<void> {
  await postgresQuery("DELETE FROM record_changes WHERE connector_instance_id = $1", [connectorInstanceId]);
  await postgresQuery("DELETE FROM records WHERE connector_instance_id = $1", [connectorInstanceId]);
  await postgresQuery("DELETE FROM version_counter WHERE connector_instance_id = $1", [connectorInstanceId]);
  await postgresQuery("DELETE FROM connector_instances WHERE connector_instance_id = $1", [connectorInstanceId]);
  await postgresQuery("DELETE FROM connectors WHERE connector_id = $1", [CONNECTOR_ID]);
}

test("Postgres: a revoke after the early check is refused by the transaction-native row lock (skipped: dedicated PDPP_TEST_POSTGRES_URL unset)", {
  skip: !DEDICATED_POSTGRES_URL,
}, async () => {
  const databaseUrl = DEDICATED_POSTGRES_URL;
  assert.ok(databaseUrl, "a dedicated Postgres URL is available when this lane runs");
  const connectorInstanceId = "cin_postgres_revoked_race";
  await initPostgresStorage({ backend: "postgres", databaseUrl });
  try {
    await cleanupPostgres(connectorInstanceId);
    const store = await seedPostgres(connectorInstanceId);
    let releaseWriter: (() => void) | undefined;
    const writerPaused = new Promise<void>((resolve) => {
      recordsModule.__setAdmissionPreCheckPhaseHookForTest(async (point: string, context: Record<string, unknown>) => {
        if (point !== "after-admission-pre-check" || context.connectorInstanceId !== connectorInstanceId) {
          return;
        }
        resolve();
        await new Promise<void>((resume) => {
          releaseWriter = resume;
        });
      });
    });
    try {
      const writer = ingestRecord(target(connectorInstanceId), record("postgres-revoked-race"), {
        requireConnectionAdmission: true,
      });
      await writerPaused;
      await store.updateStatus(connectorInstanceId, { revokedAt: NOW, status: "revoked", updatedAt: NOW });
      assert.ok(releaseWriter, "the writer must be paused after its early admission check");
      releaseWriter();
      await assert.rejects(writer, { code: "connector_instance_not_writable" });
      const count = await postgresQuery<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM records WHERE connector_instance_id = $1",
        [connectorInstanceId]
      );
      assert.equal(Number(count.rows[0]?.count ?? 0), 0);
    } finally {
      recordsModule.__setAdmissionPreCheckPhaseHookForTest(null);
    }
  } finally {
    await cleanupPostgres(connectorInstanceId);
    await closePostgresStorage();
  }
});

test("Postgres: transaction-native admission holds the connector row against a concurrent revoke (skipped: dedicated PDPP_TEST_POSTGRES_URL unset)", {
  skip: !DEDICATED_POSTGRES_URL,
}, async () => {
  const databaseUrl = DEDICATED_POSTGRES_URL;
  assert.ok(databaseUrl, "a dedicated Postgres URL is available when this lane runs");
  const connectorInstanceId = "cin_postgres_admission_lock";
  await initPostgresStorage({ backend: "postgres", databaseUrl });
  try {
    await cleanupPostgres(connectorInstanceId);
    const store = await seedPostgres(connectorInstanceId);
    let releaseWriter: (() => void) | undefined;
    const writerLocked = new Promise<void>((resolve) => {
      postgresRecordsModule.__setPostgresAdmissionLockedPhaseHookForTest(
        async (point: string, context: Record<string, unknown>) => {
          if (
            point !== "after-connector-instance-admission-lock" ||
            context.connectorInstanceId !== connectorInstanceId
          ) {
            return;
          }
          resolve();
          await new Promise<void>((resume) => {
            releaseWriter = resume;
          });
        }
      );
    });
    try {
      const writer = ingestRecord(target(connectorInstanceId), record("postgres-lock"), {
        requireConnectionAdmission: true,
      });
      await writerLocked;
      await assert.rejects(
        withPostgresTransaction(async (client) => {
          await client.query("SET LOCAL lock_timeout = '50ms'");
          await client.query(
            "UPDATE connector_instances SET status = 'revoked', updated_at = $1 WHERE connector_instance_id = $2",
            [NOW, connectorInstanceId]
          );
        }),
        { code: "55P03" }
      );
      assert.ok(releaseWriter, "the writer must hold the connector-instance row lock");
      releaseWriter();
      const outcome = await writer;
      assert.equal(outcome.accepted, true);
      assert.equal(outcome.changed, true);
      await store.updateStatus(connectorInstanceId, { revokedAt: NOW, status: "revoked", updatedAt: NOW });
    } finally {
      postgresRecordsModule.__setPostgresAdmissionLockedPhaseHookForTest(null);
    }
  } finally {
    await cleanupPostgres(connectorInstanceId);
    await closePostgresStorage();
  }
});
