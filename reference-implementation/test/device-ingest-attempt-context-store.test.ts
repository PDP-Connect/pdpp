// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { closeDb, getDb, initDb } from "../server/db.ts";
import { fingerprintDeviceAttemptManifest } from "../server/device-ingest-attempt-context.ts";
import {
  closePostgresStorage,
  initPostgresStorage,
  postgresQuery,
  withPostgresTransaction,
} from "../server/postgres-storage.ts";
import {
  advancePostgresDeviceIngestPrefix,
  advanceSqliteDeviceIngestPrefix,
  createPostgresDeviceExporterStore,
  createSqliteDeviceExporterStore,
} from "../server/stores/device-exporter-store.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";

const DEDICATED_POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
const NOW = "2026-07-16T00:00:00.000Z";
const OLD_MANIFEST = {
  connector_id: "attempt-context-test",
  streams: [{ consent_time_field: "updated_at", cursor_field: "updated_at", name: "records", primary_key: ["id"] }],
  version: "1.0.0",
};
const NEW_MANIFEST = {
  ...OLD_MANIFEST,
  streams: [{ consent_time_field: "changed_at", cursor_field: "changed_at", name: "records", primary_key: ["id"] }],
};

function dedicatedPostgresUrlForTest(): string {
  const databaseUrl = DEDICATED_POSTGRES_URL;
  assert.ok(databaseUrl, "DEDICATED_POSTGRES_URL is required for this test");
  return databaseUrl;
}

function mustExist<T>(value: T | null | undefined, description: string): T {
  assert.ok(value, description);
  return value;
}

function reservation(overrides: Record<string, unknown> = {}) {
  return {
    batchId: "batch_attempt_context",
    batchSeq: 1,
    bodyHash: "a".repeat(64),
    connectorId: "attempt-context-test",
    connectorInstanceId: "cin_attempt_context",
    createdAt: NOW,
    deviceId: "dev_attempt_context",
    manifestFingerprint: fingerprintDeviceAttemptManifest(OLD_MANIFEST),
    recordCount: 1,
    semanticCapabilityIdentity: "model=attempt-a;dimensions=3;metric=cosine",
    sourceInstanceId: "src_attempt_context",
    ...overrides,
  };
}

async function expectRetryable(fn: () => unknown) {
  await assert.rejects(
    async () => await fn(),
    (err) => (err as { code?: string } | undefined)?.code === "device_ingest_retryable"
  );
}

type ReservationRecord = ReturnType<typeof reservation>;
type SqliteDeviceExporterStore = ReturnType<typeof createSqliteDeviceExporterStore>;
type PostgresDeviceExporterStore = ReturnType<typeof createPostgresDeviceExporterStore>;

interface ProveAttemptFencesOptions {
  readonly advancePrefix: (record: ReservationRecord) => Promise<void>;
  readonly replaceManifest: (manifest: typeof OLD_MANIFEST) => Promise<void>;
  readonly store: PostgresDeviceExporterStore | SqliteDeviceExporterStore;
}

async function proveAttemptFences({ store, replaceManifest, advancePrefix }: ProveAttemptFencesOptions) {
  const first = reservation();
  await store.ensureProcessingBatch(first);
  await advancePrefix(first);

  await replaceManifest(NEW_MANIFEST);
  await expectRetryable(() =>
    store.completeProcessingBatch({
      ...first,
      acceptedAt: NOW,
      getCurrentSemanticCapabilityIdentity: () => first.semanticCapabilityIdentity,
      httpStatus: 201,
      response: { accepted_record_count: 1, rejected_record_count: 0 },
    })
  );
  const stale = mustExist(await store.getBatchOutcome(first.deviceId, first.batchId), "batch outcome exists");
  assert.equal(stale.status, "processing");
  assert.equal(stale.durablePrefixCount, 1);

  const rebuilt = {
    ...first,
    manifestFingerprint: fingerprintDeviceAttemptManifest(NEW_MANIFEST),
  };
  await store.refreshProcessingAttemptContext(rebuilt);
  const accepted = mustExist(
    await store.completeProcessingBatch({
      ...rebuilt,
      acceptedAt: NOW,
      getCurrentSemanticCapabilityIdentity: () => rebuilt.semanticCapabilityIdentity,
      httpStatus: 201,
      response: { accepted_record_count: 1, rejected_record_count: 0 },
    }),
    "accepted batch outcome exists"
  );
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.durablePrefixCount, 1);
  assert.equal(accepted.recordCount, 1);

  const semantic = reservation({
    batchId: "batch_attempt_semantic",
    manifestFingerprint: fingerprintDeviceAttemptManifest(NEW_MANIFEST),
  });
  await store.ensureProcessingBatch(semantic);
  await advancePrefix(semantic);
  await expectRetryable(() =>
    store.completeProcessingBatch({
      ...semantic,
      acceptedAt: NOW,
      getCurrentSemanticCapabilityIdentity: () => "model=attempt-b;dimensions=3;metric=cosine",
      httpStatus: 201,
      response: { accepted_record_count: 1, rejected_record_count: 0 },
    })
  );
  const semanticRebuilt = {
    ...semantic,
    semanticCapabilityIdentity: "model=attempt-b;dimensions=3;metric=cosine",
  };
  await store.refreshProcessingAttemptContext(semanticRebuilt);
  const semanticAccepted = mustExist(
    await store.completeProcessingBatch({
      ...semanticRebuilt,
      acceptedAt: NOW,
      getCurrentSemanticCapabilityIdentity: () => semanticRebuilt.semanticCapabilityIdentity,
      httpStatus: 201,
      response: { accepted_record_count: 1, rejected_record_count: 0 },
    }),
    "semantic accepted batch outcome exists"
  );
  assert.equal(semanticAccepted.status, "accepted");
}

test("SQLite processing reservation acceptance is fenced by current manifest and semantic identity", async () => {
  initDb(":memory:");
  try {
    getDb()
      .prepare("INSERT INTO connectors(connector_id, manifest) VALUES(?, ?)")
      .run("attempt-context-test", JSON.stringify(OLD_MANIFEST));
    getDb()
      .prepare(`
      INSERT INTO device_exporters(device_id, owner_subject_id, display_name, created_at, updated_at)
      VALUES('dev_attempt_context', 'owner_attempt_context', 'Attempt context', ?, ?)
    `)
      .run(NOW, NOW);
    await proveAttemptFences({
      advancePrefix: async (record) => advanceSqliteDeviceIngestPrefix(record, 0),
      replaceManifest: (manifest) => {
        getDb()
          .prepare("UPDATE connectors SET manifest = ? WHERE connector_id = ?")
          .run(JSON.stringify(manifest), "attempt-context-test");
        return Promise.resolve();
      },
      store: createSqliteDeviceExporterStore(),
    });
  } finally {
    closeDb();
  }
});

test("dedicated Postgres processing reservation acceptance locks and fences current manifest and semantic identity", {
  skip: !DEDICATED_POSTGRES_URL,
}, async () => {
  await initPostgresStorage({ backend: "postgres", databaseUrl: dedicatedPostgresUrlForTest() });
  try {
    await postgresQuery("DELETE FROM device_ingest_batch_outcomes WHERE device_id = 'dev_attempt_context'");
    await postgresQuery("DELETE FROM device_exporters WHERE device_id = 'dev_attempt_context'");
    await postgresQuery("DELETE FROM connectors WHERE connector_id = 'attempt-context-test'");
    await postgresQuery("INSERT INTO connectors(connector_id, manifest, created_at) VALUES($1, $2::jsonb, $3)", [
      "attempt-context-test",
      JSON.stringify(OLD_MANIFEST),
      NOW,
    ]);
    await postgresQuery(
      `INSERT INTO device_exporters(device_id, owner_subject_id, display_name, created_at, updated_at)
         VALUES($1, $2, $3, $4, $5)`,
      ["dev_attempt_context", "owner_attempt_context", "Attempt context", NOW, NOW]
    );
    await proveAttemptFences({
      advancePrefix: async (record) =>
        withPostgresTransaction((client: Parameters<typeof advancePostgresDeviceIngestPrefix>[0]) =>
          advancePostgresDeviceIngestPrefix(client, record, 0)
        ),
      replaceManifest: async (manifest) => {
        await postgresQuery("UPDATE connectors SET manifest = $1::jsonb WHERE connector_id = $2", [
          JSON.stringify(manifest),
          "attempt-context-test",
        ]);
      },
      store: createPostgresDeviceExporterStore(),
    });
  } finally {
    await postgresQuery("DELETE FROM device_ingest_batch_outcomes WHERE device_id = 'dev_attempt_context'");
    await postgresQuery("DELETE FROM device_exporters WHERE device_id = 'dev_attempt_context'");
    await postgresQuery("DELETE FROM connectors WHERE connector_id = 'attempt-context-test'");
    await closePostgresStorage();
  }
});
