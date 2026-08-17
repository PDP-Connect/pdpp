// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Scheduler owner-identity discriminator.
 *
 * This is intentionally provider-neutral: GitHub is only the static-secret
 * fixture used to prove that two owners receive two different stored secrets.
 * The test exercises the real encrypted store, resolver, scheduler launch,
 * and child environment rather than a resolver stub.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildConnectionScopedSecretEnv,
  isStaticSecretCaptureOptional,
  isStaticSecretConnector,
  type RecoveredStaticSecret,
} from "../../packages/polyfill-connectors/src/static-secret-injection.ts";
import { createScheduler } from "../runtime/scheduler.ts";
import type { ConnectorSchedule, RunRecord } from "../runtime/scheduler-domain-types.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import {
  createPostgresConnectorInstanceCredentialStore,
  createSqliteConnectorInstanceCredentialStore,
} from "../server/stores/connector-instance-credential-store.ts";
import {
  admitOwnerRunConnection,
  createPostgresConnectorInstanceStore,
  createSqliteConnectorInstanceStore,
  makeDefaultAccountConnectorInstanceId,
} from "../server/stores/connector-instance-store.ts";
import {
  createPostgresSchedulerStore,
  createSqliteSchedulerStore,
  type SchedulerStore,
} from "../server/stores/scheduler-store.ts";
import { resolveStaticSecretRunEnv } from "../server/stores/static-secret-run-credentials.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const CONNECTOR_ID = "github";
const OWNER_A = "owner_scheduler_a";
const OWNER_B = "owner_scheduler_b";
const INSTANCE_A = "cin_scheduler_owner_a";
const INSTANCE_B = "cin_scheduler_owner_b";
const SECRET_A = "github-secret-owner-a";
const SECRET_B = "github-secret-owner-b";
const NOW = "2026-08-11T12:00:00.000Z";
const CREDENTIAL_KEY = "scheduler-owner-isolation-test-key";
const WRONG_CREDENTIAL_KEY = "scheduler-owner-isolation-wrong-key";
const BLANK_OWNER_FAILURE_RE = /ownerSubjectId is required and must be nonblank/u;
const OWNER_MISMATCH_FAILURE_RE = /does not belong to owner/u;
const DECRYPT_FAILURE_RE = /credential_decrypt_failed/u;
const MARKER_DEFAULT_INSTANCE = makeDefaultAccountConnectorInstanceId("owner_local", CONNECTOR_ID);
const MARKER_PREFIX = "schedule.back_off.started:";
const MARKER_REASON = "terminal:authentication_error";
const MARKER_COMPLETED_AT = "2026-08-11T12:00:10.000Z";
const BACKGROUND_SAFE_MANIFEST = {
  capabilities: { refresh_policy: { background_safe: true, recommended_mode: "automatic" } },
  streams: [{ name: "items" }],
};

type CredentialStore =
  | ReturnType<typeof createPostgresConnectorInstanceCredentialStore>
  | ReturnType<typeof createSqliteConnectorInstanceCredentialStore>;
type OwnerIsolationConnectorInstanceStore = Parameters<typeof admitOwnerRunConnection>[0]["connectorInstanceStore"];

interface SeedConnection {
  connectorInstanceId: string;
  ownerSubjectId: string;
}

interface OwnerScenarioResult {
  records: RunRecord[];
  resolverCalls: { connectorInstanceId: string; ownerSubjectId: string }[];
}

function credentialEnv(key = CREDENTIAL_KEY): { PDPP_CREDENTIAL_ENCRYPTION_KEY: string } {
  return { PDPP_CREDENTIAL_ENCRYPTION_KEY: key };
}

function seedSqliteConnection({ connectorInstanceId, ownerSubjectId }: SeedConnection): void {
  const db = getDb();
  db.prepare("INSERT OR IGNORE INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)").run(
    CONNECTOR_ID,
    JSON.stringify({ connector_id: CONNECTOR_ID, streams: [] }),
    NOW
  );
  db.prepare(
    `INSERT INTO connector_instances(
       connector_instance_id, owner_subject_id, connector_id, display_name, status,
       source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
     ) VALUES (?, ?, ?, ?, 'active', 'account', ?, '{}', ?, ?, NULL)`
  ).run(connectorInstanceId, ownerSubjectId, CONNECTOR_ID, connectorInstanceId, connectorInstanceId, NOW, NOW);
}

async function seedPostgresConnection({ connectorInstanceId, ownerSubjectId }: SeedConnection): Promise<void> {
  await postgresQuery(
    "INSERT INTO connectors(connector_id, manifest, created_at) VALUES($1, $2::jsonb, $3) ON CONFLICT(connector_id) DO NOTHING",
    [CONNECTOR_ID, JSON.stringify({ connector_id: CONNECTOR_ID, streams: [] }), NOW]
  );
  await postgresQuery(
    `INSERT INTO connector_instances(
       connector_instance_id, owner_subject_id, connector_id, display_name, status,
       source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
     ) VALUES ($1, $2, $3, $4, 'active', 'account', $5, '{}'::jsonb, $6, $6, NULL)`,
    [connectorInstanceId, ownerSubjectId, CONNECTOR_ID, connectorInstanceId, connectorInstanceId, NOW]
  );
}

async function captureTwoOwnerSecrets(store: CredentialStore): Promise<void> {
  await store.capture({
    connectorInstanceId: INSTANCE_A,
    credentialKind: "personal_access_token",
    now: NOW,
    ownerSubjectId: OWNER_A,
    secret: SECRET_A,
  });
  await store.capture({
    connectorInstanceId: INSTANCE_B,
    credentialKind: "personal_access_token",
    now: NOW,
    ownerSubjectId: OWNER_B,
    secret: SECRET_B,
  });
}

function writeSnapshotConnector(tmpDir: string, name: string, snapshotPath: string, spawnMarkerPath: string): string {
  const connectorPath = join(tmpDir, `${name}.mjs`);
  writeFileSync(
    connectorPath,
    `
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  writeFileSync(${JSON.stringify(spawnMarkerPath)}, 'spawned', 'utf8');
  writeFileSync(${JSON.stringify(snapshotPath)}, JSON.stringify({
    githubToken: process.env.GITHUB_PERSONAL_ACCESS_TOKEN ?? null,
    ownerToken: process.env.PDPP_OWNER_TOKEN ?? null,
  }), 'utf8');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 0 }) + '\\n');
  rl.close();
  setTimeout(() => process.exit(0), 10);
});
`,
    "utf8"
  );
  return connectorPath;
}

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    // biome-ignore lint/performance/noAwaitInLoops: polling is intentionally sequential so the timeout bounds one observation loop.
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function makeSchedule(
  connectorInstanceId: string,
  ownerSubjectId: string,
  connectorPath: string,
  ownerToken = `token-${ownerSubjectId}`
): ConnectorSchedule {
  return {
    connectorId: CONNECTOR_ID,
    connectorInstanceId,
    connectorPath,
    intervalMs: 60_000,
    manifest: BACKGROUND_SAFE_MANIFEST,
    ownerSubjectId,
    ownerToken,
  };
}

async function runSchedules({
  connectors,
  credentialStore,
  connectorInstanceStore,
}: {
  connectors: readonly ConnectorSchedule[];
  connectorInstanceStore: OwnerIsolationConnectorInstanceStore;
  credentialStore: CredentialStore;
}): Promise<OwnerScenarioResult> {
  const records: RunRecord[] = [];
  const resolverCalls: OwnerScenarioResult["resolverCalls"] = [];
  const scheduler = createScheduler({
    admitRunConnection: async ({ connectorId, connectorInstanceId, ownerSubjectId }) => {
      if (typeof ownerSubjectId !== "string") {
        throw new Error("test admission requires a scheduler ownerSubjectId");
      }
      const namespace = await admitOwnerRunConnection({
        connectorId,
        connectorInstanceId,
        connectorInstanceStore,
        ownerSubjectId,
      });
      return {
        connectorId: namespace.connectorId,
        connectorInstanceId: namespace.connectorInstanceId,
        ownerSubjectId: namespace.ownerSubjectId,
      };
    },
    connectors,
    getState: async () => null,
    onInteraction: async () => ({ status: "cancelled", type: "INTERACTION_RESPONSE" }),
    onRunComplete: (record) => records.push(record),
    resolveStaticSecretRunEnv: ({ connectorId, connectorInstanceId, ownerSubjectId }) => {
      resolverCalls.push({ connectorInstanceId, ownerSubjectId });
      return resolveStaticSecretRunEnv({
        buildConnectionScopedSecretEnv: (id, recovered, sourceBinding) =>
          buildConnectionScopedSecretEnv(id, recovered as RecoveredStaticSecret, sourceBinding),
        connectorId,
        connectorInstanceId,
        credentialStore,
        isStaticSecretCaptureOptional,
        isStaticSecretConnector,
        ownerSubjectId,
        sourceBinding: null,
      });
    },
    rsUrl: "http://localhost.invalid",
    setState: async () => undefined,
  });

  try {
    scheduler.start();
    try {
      await waitFor(() => records.length >= connectors.length);
    } catch (error) {
      throw new Error(
        `scheduled runs did not complete: ${JSON.stringify({
          completed: records.length,
          expected: connectors.length,
          resolverCalls,
        })}`,
        { cause: error }
      );
    }
    return { records, resolverCalls };
  } finally {
    scheduler.stop();
  }
}

async function assertOwnerIsolation(
  credentialStore: CredentialStore,
  connectorInstanceStore: OwnerIsolationConnectorInstanceStore
): Promise<void> {
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-scheduler-owner-isolation-"));
  try {
    const snapshotA = join(tmpDir, "owner-a.json");
    const snapshotB = join(tmpDir, "owner-b.json");
    const connectorA = writeSnapshotConnector(tmpDir, "owner-a", snapshotA, join(tmpDir, "owner-a.spawned"));
    const connectorB = writeSnapshotConnector(tmpDir, "owner-b", snapshotB, join(tmpDir, "owner-b.spawned"));
    const result = await runSchedules({
      connectorInstanceStore,
      connectors: [makeSchedule(INSTANCE_A, OWNER_A, connectorA), makeSchedule(INSTANCE_B, OWNER_B, connectorB)],
      credentialStore,
    });

    assert.deepEqual(
      result.resolverCalls.sort((left, right) => left.connectorInstanceId.localeCompare(right.connectorInstanceId)),
      [
        { connectorInstanceId: INSTANCE_A, ownerSubjectId: OWNER_A },
        { connectorInstanceId: INSTANCE_B, ownerSubjectId: OWNER_B },
      ]
    );
    assert.deepEqual(
      result.records.map((record) => record.status).sort((left, right) => left.localeCompare(right)),
      ["succeeded", "succeeded"],
      "both owners should complete their own scheduled run"
    );
    assert.deepEqual(JSON.parse(readFileSync(snapshotA, "utf8")), {
      githubToken: SECRET_A,
      ownerToken: `token-${OWNER_A}`,
    });
    assert.deepEqual(JSON.parse(readFileSync(snapshotB, "utf8")), {
      githubToken: SECRET_B,
      ownerToken: `token-${OWNER_B}`,
    });
    assert.notEqual(
      JSON.parse(readFileSync(snapshotA, "utf8")).githubToken,
      JSON.parse(readFileSync(snapshotB, "utf8")).githubToken
    );
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
  }
}

async function assertBlankOwnerFailsBeforeResolveAndSpawn(
  credentialStore: CredentialStore,
  connectorInstanceStore: OwnerIsolationConnectorInstanceStore
): Promise<void> {
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-scheduler-owner-blank-"));
  const snapshotPath = join(tmpDir, "blank.json");
  const spawnMarkerPath = join(tmpDir, "blank.spawned");
  try {
    const connectorPath = writeSnapshotConnector(tmpDir, "blank-owner", snapshotPath, spawnMarkerPath);
    const result = await runSchedules({
      connectorInstanceStore,
      connectors: [makeSchedule(INSTANCE_A, "   ", connectorPath)],
      credentialStore,
    });

    assert.deepEqual(result.resolverCalls, [], "blank scheduler owner must be rejected before credential resolution");
    assert.equal(result.records[0]?.status, "failed");
    assert.match(result.records[0]?.error ?? "", BLANK_OWNER_FAILURE_RE);
    assert.equal(existsSync(spawnMarkerPath), false, "blank scheduler owner must not spawn a child");
    assert.equal(existsSync(snapshotPath), false, "blank scheduler owner must not write child output");
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
  }
}

async function assertWrongOwnerFailsBeforeDecryptAndSpawn(
  credentialStore: CredentialStore,
  connectorInstanceStore: OwnerIsolationConnectorInstanceStore
): Promise<void> {
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-scheduler-owner-wrong-"));
  const snapshotPath = join(tmpDir, "wrong.json");
  const spawnMarkerPath = join(tmpDir, "wrong.spawned");
  try {
    const connectorPath = writeSnapshotConnector(tmpDir, "wrong-owner", snapshotPath, spawnMarkerPath);
    await assert.rejects(
      credentialStore.recoverSecret({ connectorInstanceId: INSTANCE_A, ownerSubjectId: OWNER_B }),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: unknown }).code === "credential_owner_mismatch"
    );
    const result = await runSchedules({
      connectorInstanceStore,
      connectors: [makeSchedule(INSTANCE_A, OWNER_B, connectorPath)],
      credentialStore,
    });

    assert.deepEqual(result.resolverCalls, [], "wrong owner must be rejected before the credential resolver");
    assert.equal(result.records[0]?.status, "failed");
    assert.match(result.records[0]?.error ?? "", OWNER_MISMATCH_FAILURE_RE);
    assert.doesNotMatch(result.records[0]?.error ?? "", DECRYPT_FAILURE_RE);
    assert.equal(existsSync(spawnMarkerPath), false, "wrong owner must not spawn a child");
    assert.equal(existsSync(snapshotPath), false, "wrong owner must not write child output");
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
  }
}

async function runBackendOwnerIsolationScenarios({
  connectorInstanceStore,
  credentialStore,
  wrongKeyCredentialStore,
}: {
  connectorInstanceStore: OwnerIsolationConnectorInstanceStore;
  credentialStore: CredentialStore;
  wrongKeyCredentialStore: CredentialStore;
}): Promise<void> {
  await captureTwoOwnerSecrets(credentialStore);
  await assertOwnerIsolation(credentialStore, connectorInstanceStore);
  await assertBlankOwnerFailsBeforeResolveAndSpawn(credentialStore, connectorInstanceStore);
  await assertWrongOwnerFailsBeforeDecryptAndSpawn(wrongKeyCredentialStore, connectorInstanceStore);
}

function legacyMarkerRecord({
  completedAt,
  error,
  runId = null,
}: {
  completedAt: string;
  error: string;
  runId?: string | null;
}): Parameters<SchedulerStore["appendRunHistory"]>[0] {
  return {
    attempt: 0,
    checkpointSummary: null,
    completedAt,
    connectorId: CONNECTOR_ID,
    connectorInstanceId: MARKER_DEFAULT_INSTANCE,
    error,
    knownGaps: [],
    recordsEmitted: 0,
    runId,
    source: { id: CONNECTOR_ID, kind: "connector" },
    startedAt: completedAt,
    status: "skipped",
  };
}

async function assertLegacyMarkerProbe(store: SchedulerStore): Promise<void> {
  if (!store.hasLegacySchedulerEventMarker) {
    throw new Error("SchedulerStore marker probe is required for this regression suite");
  }
  const probe = store.hasLegacySchedulerEventMarker;
  const validPayload = JSON.stringify({
    consecutive_failures: 3,
    next_attempt_at: "2026-08-11T12:05:00.000Z",
    reason_class: MARKER_REASON,
  });
  for (let index = 0; index < 501; index += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: the ordered 501-row prefix proves the uncapped durable scan.
    await store.appendRunHistory(
      legacyMarkerRecord({
        completedAt: "2026-08-11T12:00:00.000Z",
        error: `${MARKER_PREFIX} malformed-${index}`,
      })
    );
  }
  await store.appendRunHistory(
    legacyMarkerRecord({ completedAt: MARKER_COMPLETED_AT, error: `${MARKER_PREFIX} ${validPayload}` })
  );
  await store.appendRunHistory(
    legacyMarkerRecord({
      completedAt: "2026-08-11T12:00:11.000Z",
      error: `${MARKER_PREFIX} not-json "reason_class":"payload-only"`,
    })
  );
  await store.appendRunHistory(
    legacyMarkerRecord({
      completedAt: "2026-08-11T12:00:12.000Z",
      error: `${MARKER_PREFIX} ${JSON.stringify({ reason_class: "run-id-filter" })}`,
      runId: "run_marker_non_null",
    })
  );

  assert.equal(
    await probe(CONNECTOR_ID, MARKER_DEFAULT_INSTANCE, MARKER_PREFIX, MARKER_REASON, null),
    true,
    "an uncapped marker scan must find a valid payload after 501 matching malformed rows"
  );
  assert.equal(
    await probe(CONNECTOR_ID, MARKER_DEFAULT_INSTANCE, MARKER_PREFIX, "payload-only", null),
    false,
    "prefix text containing reason_class is not a JSON marker payload"
  );
  assert.equal(
    await probe(CONNECTOR_ID, MARKER_DEFAULT_INSTANCE, MARKER_PREFIX, "run-id-filter", null),
    false,
    "a marker with a non-null run id is not legacy evidence"
  );
  assert.equal(
    await probe(CONNECTOR_ID, `${MARKER_DEFAULT_INSTANCE}-other`, MARKER_PREFIX, MARKER_REASON, null),
    false,
    "non-default instance requests must not read the default marker"
  );
  assert.equal(
    await probe(CONNECTOR_ID, MARKER_DEFAULT_INSTANCE, MARKER_PREFIX, MARKER_REASON, MARKER_COMPLETED_AT),
    false,
    "completed_at comparison is strict committed-text ordering"
  );
}

test("scheduler owner identity isolates distinct encrypted secrets on SQLite", async () => {
  initDb(":memory:");
  try {
    seedSqliteConnection({ connectorInstanceId: INSTANCE_A, ownerSubjectId: OWNER_A });
    seedSqliteConnection({ connectorInstanceId: INSTANCE_B, ownerSubjectId: OWNER_B });
    await runBackendOwnerIsolationScenarios({
      connectorInstanceStore: createSqliteConnectorInstanceStore(),
      credentialStore: createSqliteConnectorInstanceCredentialStore({ env: credentialEnv() }),
      wrongKeyCredentialStore: createSqliteConnectorInstanceCredentialStore({
        env: credentialEnv(WRONG_CREDENTIAL_KEY),
      }),
    });
  } finally {
    closeDb();
  }
});

test("scheduler legacy marker probes use the representable default row on SQLite", async () => {
  initDb(":memory:");
  try {
    seedSqliteConnection({ connectorInstanceId: MARKER_DEFAULT_INSTANCE, ownerSubjectId: "owner_local" });
    await assertLegacyMarkerProbe(createSqliteSchedulerStore());
  } finally {
    closeDb();
  }
});

const RAW_POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;
const POSTGRES_URL = dedicatedPostgresTestUrl(RAW_POSTGRES_URL);
if (RAW_POSTGRES_URL && !POSTGRES_URL) {
  throw new Error(
    "PDPP_TEST_POSTGRES_URL must target the dedicated loopback PostgreSQL test listener on 127.0.0.1:55447"
  );
}

let postgresDatabaseCounter = 0;
function postgresDatabaseName(): string {
  postgresDatabaseCounter += 1;
  return `pdpp_test_scheduler_owner_${process.pid}_${Date.now()}_${postgresDatabaseCounter}`;
}

test("scheduler owner identity isolates distinct encrypted secrets on disposable Postgres", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
}, async () => {
  assert.ok(POSTGRES_URL);
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: POSTGRES_URL,
      databaseName: postgresDatabaseName(),
    },
    async (databaseUrl) => {
      await initPostgresStorage({ backend: "postgres", databaseUrl });
      try {
        await seedPostgresConnection({ connectorInstanceId: INSTANCE_A, ownerSubjectId: OWNER_A });
        await seedPostgresConnection({ connectorInstanceId: INSTANCE_B, ownerSubjectId: OWNER_B });
        await runBackendOwnerIsolationScenarios({
          connectorInstanceStore: createPostgresConnectorInstanceStore(),
          credentialStore: createPostgresConnectorInstanceCredentialStore({ env: credentialEnv() }),
          wrongKeyCredentialStore: createPostgresConnectorInstanceCredentialStore({
            env: credentialEnv(WRONG_CREDENTIAL_KEY),
          }),
        });
      } finally {
        await closePostgresStorage();
      }
    }
  );
});

test("scheduler legacy marker probes use the representable default row on disposable Postgres", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
}, async () => {
  assert.ok(POSTGRES_URL);
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: POSTGRES_URL,
      databaseName: postgresDatabaseName(),
    },
    async (databaseUrl) => {
      await initPostgresStorage({ backend: "postgres", databaseUrl });
      try {
        await seedPostgresConnection({ connectorInstanceId: MARKER_DEFAULT_INSTANCE, ownerSubjectId: "owner_local" });
        await assertLegacyMarkerProbe(createPostgresSchedulerStore());
      } finally {
        await closePostgresStorage();
      }
    }
  );
});
