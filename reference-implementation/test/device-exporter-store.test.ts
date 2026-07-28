// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { closeDb, getDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import {
  createPostgresConnectorInstanceStore,
  createSqliteConnectorInstanceStore,
} from "../server/stores/connector-instance-store.ts";
import {
  createPostgresDeviceExporterStore,
  createSqliteDeviceExporterStore,
  DeviceBatchConflictError,
} from "../server/stores/device-exporter-store.ts";

const NOW = "2026-04-30T12:00:00.000Z";
const LATER = "2026-04-30T12:01:00.000Z";

type SqliteDeviceExporterStore = ReturnType<typeof createSqliteDeviceExporterStore>;
type PostgresDeviceExporterStore = ReturnType<typeof createPostgresDeviceExporterStore>;
type SqliteConnectorInstanceStore = ReturnType<typeof createSqliteConnectorInstanceStore>;
type PostgresConnectorInstanceStore = ReturnType<typeof createPostgresConnectorInstanceStore>;

interface RevokeCascadeOptions {
  readonly makeConnectorInstanceStore: () =>
    | Promise<PostgresConnectorInstanceStore | SqliteConnectorInstanceStore>
    | PostgresConnectorInstanceStore
    | SqliteConnectorInstanceStore;
  readonly makeDeviceStore: () =>
    | Promise<PostgresDeviceExporterStore | SqliteDeviceExporterStore>
    | PostgresDeviceExporterStore
    | SqliteDeviceExporterStore;
  readonly now: string;
  readonly seedConnector: (connectorId: string) => Promise<void>;
}

type DynamicStore = Record<string, (...args: never[]) => unknown>;

function makeDriver(store: DynamicStore) {
  return {
    async call(method: string, ...args: unknown[]) {
      const fn = store[method];
      if (!fn) {
        throw new TypeError(`store.${method} is not a function`);
      }
      return await (fn as (...fnArgs: unknown[]) => unknown)(...args);
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null, "expected a record");
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  assert.ok(Array.isArray(value), "expected an array");
  return value;
}

function mustExist<T>(value: T | null | undefined, description: string): T {
  assert.ok(value, description);
  return value;
}

function mustRow<T extends Record<string, unknown>>(value: T | undefined, description: string): T {
  assert.ok(value, description);
  return value;
}

function configuredPostgresUrl(): string {
  const databaseUrl = process.env.PDPP_TEST_POSTGRES_URL;
  assert.ok(databaseUrl, "PDPP_TEST_POSTGRES_URL is required for this test");
  return databaseUrl;
}

async function runConformance(
  makeStore: () =>
    | Promise<PostgresDeviceExporterStore | SqliteDeviceExporterStore>
    | PostgresDeviceExporterStore
    | SqliteDeviceExporterStore
) {
  const driver = makeDriver(await makeStore());

  await driver.call("createEnrollmentCode", {
    codeHash: "sha256:enrollment-code",
    createdAt: NOW,
    enrollmentCodeId: "enroll_1",
    expiresAt: "2026-05-01T12:00:00.000Z",
    ownerSubjectId: "owner_1",
  });

  assert.equal(await driver.call("findEnrollmentByCodeHash", "plaintext-enrollment-code"), null);
  assert.equal(asRecord(await driver.call("findEnrollmentByCodeHash", "sha256:enrollment-code")).status, "pending");

  await driver.call("createDevice", {
    createdAt: NOW,
    deviceId: "dev_1",
    displayName: "the owner MacBook",
    ownerSubjectId: "owner_1",
    updatedAt: NOW,
  });
  assert.equal(await driver.call("consumeEnrollmentCode", "enroll_1", "dev_1", LATER), true);
  assert.equal(await driver.call("consumeEnrollmentCode", "enroll_1", "dev_1", LATER), false);
  assert.equal(asRecord(await driver.call("findEnrollmentByCodeHash", "sha256:enrollment-code")).deviceId, "dev_1");

  await driver.call("createCredential", {
    createdAt: NOW,
    credentialId: "cred_1",
    deviceId: "dev_1",
    tokenHash: "sha256:device-token",
  });
  assert.equal(await driver.call("findCredentialByTokenHash", "plaintext-device-token"), null);
  assert.equal(asRecord(await driver.call("findCredentialByTokenHash", "sha256:device-token")).deviceId, "dev_1");

  await driver.call("markCredentialUsed", "cred_1", LATER);
  assert.equal(asRecord(await driver.call("findCredentialByTokenHash", "sha256:device-token")).lastUsedAt, LATER);
  assert.equal(await driver.call("markDeviceHeartbeat", "dev_1", { lastError: null, receivedAt: LATER }), 1);
  assert.equal(asRecord(await driver.call("getDevice", "dev_1")).lastHeartbeatAt, LATER);
  const devicesList = asArray(await driver.call("listDevices", "owner_1"));
  assert.equal(asRecord(devicesList[0]).lastHeartbeatAt, LATER);

  await driver.call("upsertSourceInstance", {
    connectorId: "local.files",
    connectorInstanceId: "cin_local_files_dev_1",
    createdAt: NOW,
    deviceId: "dev_1",
    displayName: "Photos Folder",
    localBindingId: "photos",
    sourceInstanceId: "src_1",
    updatedAt: NOW,
  });
  assert.equal(asRecord(await driver.call("getSourceInstance", "dev_1", "src_1")).connectorId, "local.files");
  assert.equal(
    asRecord(await driver.call("getSourceInstance", "dev_1", "src_1")).connectorInstanceId,
    "cin_local_files_dev_1"
  );
  assert.equal(
    asRecord(await driver.call("getSourceInstanceByBinding", "dev_1", "local.files", "photos")).sourceInstanceId,
    "src_1"
  );
  assert.equal(await driver.call("getSourceInstance", "dev_2", "src_1"), null);

  const first = asRecord(
    await driver.call("recordBatchOutcome", {
      batchId: "batch_1",
      bodyHash: "sha256:body-a",
      createdAt: NOW,
      deviceId: "dev_1",
      httpStatus: 202,
      response: { recordsAccepted: 2 },
      sourceInstanceId: "src_1",
      status: "accepted",
    })
  );
  assert.equal(first.kind, "created");

  const replay = asRecord(
    await driver.call("recordBatchOutcome", {
      batchId: "batch_1",
      bodyHash: "sha256:body-a",
      createdAt: LATER,
      deviceId: "dev_1",
      httpStatus: 202,
      response: { ignored: true },
      sourceInstanceId: "src_1",
      status: "accepted",
    })
  );
  assert.equal(replay.kind, "replayed");
  assert.deepEqual(asRecord(replay.outcome).response, { recordsAccepted: 2 });

  await assert.rejects(
    () =>
      driver.call("recordBatchOutcome", {
        batchId: "batch_1",
        bodyHash: "sha256:body-b",
        createdAt: LATER,
        deviceId: "dev_1",
        httpStatus: 202,
        response: {},
        sourceInstanceId: "src_1",
        status: "accepted",
      }),
    DeviceBatchConflictError
  );

  // Heartbeat evidence persistence: the operator console's outbox axis
  // needs heartbeat status + records_pending on the source-instance row.
  // The mark call must accept (and round-trip) these fields without
  // leaking secrets or arbitrary payload.
  assert.equal(
    await driver.call("markSourceInstanceHeartbeat", "dev_1", "src_1", {
      lastError: null,
      receivedAt: LATER,
      recordsPending: 7,
      status: "healthy",
    }),
    1
  );
  const heartbeated = asRecord(await driver.call("getSourceInstance", "dev_1", "src_1"));
  assert.equal(heartbeated.lastHeartbeatAt, LATER);
  assert.equal(heartbeated.lastHeartbeatStatus, "healthy");
  assert.equal(heartbeated.recordsPending, 7);

  // Unrecognized status values must NOT be persisted: only the enum we
  // accept on the heartbeat contract is stored.
  await driver.call("markSourceInstanceHeartbeat", "dev_1", "src_1", {
    lastError: null,
    receivedAt: LATER,
    recordsPending: -3,
    status: "totally_made_up",
  });
  const sanitized = asRecord(await driver.call("getSourceInstance", "dev_1", "src_1"));
  assert.equal(sanitized.lastHeartbeatStatus, null);
  assert.equal(sanitized.recordsPending, null);

  const byConnector = asArray(await driver.call("listSourceInstanceHeartbeatsByConnector", "local.files"));
  assert.equal(byConnector.length, 1);
  const byConnectorFirst = asRecord(byConnector[0]);
  assert.equal(byConnectorFirst.sourceInstanceId, "src_1");
  assert.equal(byConnectorFirst.deviceStatus, "active");
  assert.equal(byConnectorFirst.sourceStatus, "active");
  assert.equal(byConnectorFirst.connectorInstanceId, "cin_local_files_dev_1");
  assert.equal(byConnectorFirst.lastIngestAt, NOW);

  // Instance-scoped query must not leak rows from a different
  // connector_instance_id. This is the foundation of per-connection
  // dashboard health for connectors (e.g. two Claude Code laptops) that
  // share a `connector_id` but project independent rows.
  const byInstance = asArray(
    await driver.call("listSourceInstanceHeartbeatsByConnector", "local.files", {
      connectorInstanceId: "cin_local_files_dev_1",
    })
  );
  assert.equal(byInstance.length, 1);
  const byInstanceFirst = asRecord(byInstance[0]);
  assert.equal(byInstanceFirst.connectorInstanceId, "cin_local_files_dev_1");
  assert.equal(byInstanceFirst.lastIngestAt, NOW);
  const byOtherInstance = asArray(
    await driver.call("listSourceInstanceHeartbeatsByConnector", "local.files", {
      connectorInstanceId: "cin_local_files_nonexistent",
    })
  );
  assert.equal(byOtherInstance.length, 0);

  await driver.call("revokeDevice", "dev_1", LATER);
  assert.equal(asRecord(await driver.call("getDevice", "dev_1")).status, "revoked");
  assert.equal(asRecord(await driver.call("findCredentialByTokenHash", "sha256:device-token")).status, "revoked");
}

test("SQLite DeviceExporterStore conforms to enrollment, credential, source, and batch semantics", async () => {
  initDb();
  try {
    await runConformance(() => createSqliteDeviceExporterStore());

    const db = getDb();
    const credentialCount = mustRow(
      db
        .prepare("SELECT COUNT(*) AS count FROM device_ingest_credentials WHERE token_hash = ?")
        .get("plaintext-device-token"),
      "credential count row exists"
    ).count;
    assert.equal(credentialCount, 0);
    const enrollmentCount = mustRow(
      db
        .prepare("SELECT COUNT(*) AS count FROM device_enrollment_codes WHERE code_hash = ?")
        .get("plaintext-enrollment-code"),
      "enrollment count row exists"
    ).count;
    assert.equal(enrollmentCount, 0);
  } finally {
    closeDb();
  }
});

// Revoking a device exporter must cascade revoke status to the
// device_source_instances bound to it AND to the connector_instances those
// source instances reference. Otherwise the operator surfaces
// (/_ref/connectors, device-exporter diagnostics) keep listing revoked local
// collectors as live records rows, including zero-record duplicates.
async function runRevokeCascade({
  makeDeviceStore,
  makeConnectorInstanceStore,
  seedConnector,
  now,
}: RevokeCascadeOptions) {
  await seedConnector("local.files");

  const deviceStore = await makeDeviceStore();
  const instanceStore = await makeConnectorInstanceStore();

  await instanceStore.upsert({
    connectorId: "local.files",
    connectorInstanceId: "cin_dev_revoked",
    createdAt: now,
    displayName: "Revoked laptop binding",
    ownerSubjectId: "owner_1",
    sourceBinding: { kind: "local_device", label: "revoked" },
    sourceBindingKey: "revoked",
    sourceKind: "local_device",
    status: "active",
    updatedAt: now,
  });
  await instanceStore.upsert({
    connectorId: "local.files",
    connectorInstanceId: "cin_dev_kept",
    createdAt: now,
    displayName: "Kept laptop binding",
    ownerSubjectId: "owner_1",
    sourceBinding: { kind: "local_device", label: "kept" },
    sourceBindingKey: "kept",
    sourceKind: "local_device",
    status: "active",
    updatedAt: now,
  });

  await deviceStore.createDevice({
    createdAt: now,
    deviceId: "dev_revoke",
    displayName: "Device to revoke",
    ownerSubjectId: "owner_1",
    updatedAt: now,
  });
  await deviceStore.createDevice({
    createdAt: now,
    deviceId: "dev_keep",
    displayName: "Device to keep",
    ownerSubjectId: "owner_1",
    updatedAt: now,
  });

  await deviceStore.upsertSourceInstance({
    connectorId: "local.files",
    connectorInstanceId: "cin_dev_revoked",
    createdAt: now,
    deviceId: "dev_revoke",
    displayName: "Photos on revoked device",
    localBindingId: "photos",
    sourceInstanceId: "src_revoke",
    updatedAt: now,
  });
  await deviceStore.upsertSourceInstance({
    connectorId: "local.files",
    connectorInstanceId: "cin_dev_kept",
    createdAt: now,
    deviceId: "dev_keep",
    displayName: "Photos on kept device",
    localBindingId: "photos",
    sourceInstanceId: "src_keep",
    updatedAt: now,
  });

  await deviceStore.revokeDevice("dev_revoke", LATER);

  assert.equal(mustExist(await deviceStore.getDevice("dev_revoke"), "dev_revoke exists").status, "revoked");
  const revokedSource = mustExist(await deviceStore.getSourceInstance("dev_revoke", "src_revoke"), "src_revoke exists");
  assert.equal(revokedSource.status, "revoked");
  assert.equal(revokedSource.revokedAt, LATER);
  const revokedInstance = mustExist(await instanceStore.get("cin_dev_revoked"), "cin_dev_revoked exists");
  assert.equal(revokedInstance.status, "revoked");
  assert.equal(revokedInstance.revokedAt, LATER);
  assert.equal(revokedInstance.updatedAt, LATER);

  // The other device, its source instance, and its connector_instance must
  // remain untouched. Revoke is per-device, not global.
  assert.equal(mustExist(await deviceStore.getDevice("dev_keep"), "dev_keep exists").status, "active");
  const keptSource = mustExist(await deviceStore.getSourceInstance("dev_keep", "src_keep"), "src_keep exists");
  assert.equal(keptSource.status, "active");
  assert.equal(keptSource.revokedAt, null);
  const keptInstance = mustExist(await instanceStore.get("cin_dev_kept"), "cin_dev_kept exists");
  assert.equal(keptInstance.status, "active");
  assert.equal(keptInstance.revokedAt, null);
}

// Shared connector_instance case: the stable-binding re-enrollment lane lets
// two devices (e.g. an old laptop re-enrolled as a new device) reference the
// same connector_instance via separate device_source_instances. Revoking one
// device must leave the connector_instance active while the other device's
// source instance still references it. Only after the last referencing source
// instance is revoked may the connector_instance flip to revoked.
async function runRevokeCascadeShared({
  makeDeviceStore,
  makeConnectorInstanceStore,
  seedConnector,
  now,
}: RevokeCascadeOptions) {
  await seedConnector("local.files");

  const deviceStore = await makeDeviceStore();
  const instanceStore = await makeConnectorInstanceStore();

  await instanceStore.upsert({
    connectorId: "local.files",
    connectorInstanceId: "cin_shared",
    createdAt: now,
    displayName: "Shared stable binding",
    ownerSubjectId: "owner_1",
    sourceBinding: { kind: "local_device", label: "shared" },
    sourceBindingKey: "shared",
    sourceKind: "local_device",
    status: "active",
    updatedAt: now,
  });

  await deviceStore.createDevice({
    createdAt: now,
    deviceId: "dev_old",
    displayName: "Old laptop enrollment",
    ownerSubjectId: "owner_1",
    updatedAt: now,
  });
  await deviceStore.createDevice({
    createdAt: now,
    deviceId: "dev_new",
    displayName: "Re-enrolled laptop",
    ownerSubjectId: "owner_1",
    updatedAt: now,
  });

  await deviceStore.upsertSourceInstance({
    connectorId: "local.files",
    connectorInstanceId: "cin_shared",
    createdAt: now,
    deviceId: "dev_old",
    displayName: "Photos (old enrollment)",
    localBindingId: "photos",
    sourceInstanceId: "src_old",
    updatedAt: now,
  });
  await deviceStore.upsertSourceInstance({
    connectorId: "local.files",
    connectorInstanceId: "cin_shared",
    createdAt: now,
    deviceId: "dev_new",
    displayName: "Photos (new enrollment)",
    localBindingId: "photos",
    sourceInstanceId: "src_new",
    updatedAt: now,
  });

  // Revoking the old device must revoke its own source instance but MUST NOT
  // revoke the shared connector_instance — the new device's source instance
  // is still active and references it.
  await deviceStore.revokeDevice("dev_old", LATER);

  const oldSource = mustExist(await deviceStore.getSourceInstance("dev_old", "src_old"), "src_old exists");
  assert.equal(oldSource.status, "revoked");
  assert.equal(oldSource.revokedAt, LATER);

  const newSource = mustExist(await deviceStore.getSourceInstance("dev_new", "src_new"), "src_new exists");
  assert.equal(newSource.status, "active");
  assert.equal(newSource.revokedAt, null);

  const sharedAfterFirst = mustExist(await instanceStore.get("cin_shared"), "cin_shared exists");
  assert.equal(
    sharedAfterFirst.status,
    "active",
    "shared connector_instance must remain active while another device references it"
  );
  assert.equal(sharedAfterFirst.revokedAt, null);

  // Now revoke the second device. With no remaining non-revoked source
  // instances referencing it, the shared connector_instance must flip to
  // revoked.
  const EVEN_LATER = "2026-04-30T12:02:00.000Z";
  await deviceStore.revokeDevice("dev_new", EVEN_LATER);

  const sharedAfterSecond = mustExist(await instanceStore.get("cin_shared"), "cin_shared exists");
  assert.equal(sharedAfterSecond.status, "revoked");
  assert.equal(sharedAfterSecond.revokedAt, EVEN_LATER);
}

test("SQLite revokeDevice cascades revoked status to device source instances and their connector_instances", async () => {
  initDb();
  try {
    await runRevokeCascade({
      makeConnectorInstanceStore: () => createSqliteConnectorInstanceStore(),
      makeDeviceStore: () => createSqliteDeviceExporterStore(),
      now: NOW,
      seedConnector: (connectorId) => {
        getDb()
          .prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
          .run(connectorId, JSON.stringify({ connector_id: connectorId, streams: [], version: "1.0.0" }), NOW);
        return Promise.resolve();
      },
    });
  } finally {
    closeDb();
  }
});

test("SQLite revokeDevice spares connector_instance shared with another active device source", async () => {
  initDb();
  try {
    await runRevokeCascadeShared({
      makeConnectorInstanceStore: () => createSqliteConnectorInstanceStore(),
      makeDeviceStore: () => createSqliteDeviceExporterStore(),
      now: NOW,
      seedConnector: (connectorId) => {
        getDb()
          .prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
          .run(connectorId, JSON.stringify({ connector_id: connectorId, streams: [], version: "1.0.0" }), NOW);
        return Promise.resolve();
      },
    });
  } finally {
    closeDb();
  }
});

test("Postgres revokeDevice cascades revoked status when PDPP_TEST_POSTGRES_URL is set", {
  skip: !process.env.PDPP_TEST_POSTGRES_URL,
}, async () => {
  await initPostgresStorage({ backend: "postgres", databaseUrl: configuredPostgresUrl() });
  const cleanup = async () => {
    await postgresQuery(`DELETE FROM device_source_instances WHERE device_id IN ('dev_revoke', 'dev_keep')`);
    await postgresQuery(`DELETE FROM device_exporters WHERE device_id IN ('dev_revoke', 'dev_keep')`);
    await postgresQuery(
      `DELETE FROM connector_instances WHERE connector_instance_id IN ('cin_dev_revoked', 'cin_dev_kept')`
    );
    await postgresQuery(`DELETE FROM connectors WHERE connector_id = 'local.files'`);
  };
  try {
    await cleanup();
    await runRevokeCascade({
      makeConnectorInstanceStore: () => createPostgresConnectorInstanceStore(),
      makeDeviceStore: () => createPostgresDeviceExporterStore(),
      now: NOW,
      seedConnector: async (connectorId) => {
        await postgresQuery("INSERT INTO connectors(connector_id, manifest, created_at) VALUES ($1, $2::jsonb, $3)", [
          connectorId,
          JSON.stringify({ connector_id: connectorId, streams: [], version: "1.0.0" }),
          NOW,
        ]);
      },
    });
  } finally {
    await cleanup();
    await closePostgresStorage();
  }
});

test("Postgres revokeDevice spares shared connector_instance when PDPP_TEST_POSTGRES_URL is set", {
  skip: !process.env.PDPP_TEST_POSTGRES_URL,
}, async () => {
  await initPostgresStorage({ backend: "postgres", databaseUrl: configuredPostgresUrl() });
  const cleanup = async () => {
    await postgresQuery(`DELETE FROM device_source_instances WHERE device_id IN ('dev_old', 'dev_new')`);
    await postgresQuery(`DELETE FROM device_exporters WHERE device_id IN ('dev_old', 'dev_new')`);
    await postgresQuery(`DELETE FROM connector_instances WHERE connector_instance_id = 'cin_shared'`);
    await postgresQuery(`DELETE FROM connectors WHERE connector_id = 'local.files'`);
  };
  try {
    await cleanup();
    await runRevokeCascadeShared({
      makeConnectorInstanceStore: () => createPostgresConnectorInstanceStore(),
      makeDeviceStore: () => createPostgresDeviceExporterStore(),
      now: NOW,
      seedConnector: async (connectorId) => {
        await postgresQuery("INSERT INTO connectors(connector_id, manifest, created_at) VALUES ($1, $2::jsonb, $3)", [
          connectorId,
          JSON.stringify({ connector_id: connectorId, streams: [], version: "1.0.0" }),
          NOW,
        ]);
      },
    });
  } finally {
    await cleanup();
    await closePostgresStorage();
  }
});

test("Postgres DeviceExporterStore conforms when PDPP_TEST_POSTGRES_URL is set", {
  skip: !process.env.PDPP_TEST_POSTGRES_URL,
}, async () => {
  await initPostgresStorage({ backend: "postgres", databaseUrl: configuredPostgresUrl() });
  try {
    await postgresQuery(`DELETE FROM device_ingest_batch_outcomes WHERE device_id = 'dev_1'`);
    await postgresQuery(`DELETE FROM device_source_instances WHERE device_id = 'dev_1'`);
    await postgresQuery(`DELETE FROM device_ingest_credentials WHERE device_id = 'dev_1'`);
    await postgresQuery(`DELETE FROM device_enrollment_codes WHERE enrollment_code_id = 'enroll_1'`);
    await postgresQuery(`DELETE FROM device_exporters WHERE device_id = 'dev_1'`);
    await runConformance(() => createPostgresDeviceExporterStore());
  } finally {
    await postgresQuery(`DELETE FROM device_ingest_batch_outcomes WHERE device_id = 'dev_1'`);
    await postgresQuery(`DELETE FROM device_source_instances WHERE device_id = 'dev_1'`);
    await postgresQuery(`DELETE FROM device_ingest_credentials WHERE device_id = 'dev_1'`);
    await postgresQuery(`DELETE FROM device_enrollment_codes WHERE enrollment_code_id = 'enroll_1'`);
    await postgresQuery(`DELETE FROM device_exporters WHERE device_id = 'dev_1'`);
    await closePostgresStorage();
  }
});
