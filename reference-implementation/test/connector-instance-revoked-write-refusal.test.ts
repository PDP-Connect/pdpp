// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Red-team follow-up (2026-08-10, harden-connector-instance-write-fence-transaction-native
 * REVISE): `assertConnectorInstanceWritable`/`assertPostgresConnectorInstanceWritable`
 * previously checked only that the `connector_instances` row EXISTS, never
 * its `status`. The commit that introduced the Postgres per-transaction
 * re-check claimed it "backs revoke/delete's status flip," but only the
 * delete half was actually closed — a revoked connector instance still
 * admitted new record/blob writes.
 *
 * This proves, on both backends, that a write racing a concurrent revoke
 * (same ordering shape as connector-instance-delete-vs-queued-write-fence.test.ts's
 * ordering B, but with `updateStatus({ status: "revoked" })` in place of
 * `deleteConnection`) is refused with the typed `connector_instance_not_writable`
 * code, while `active` and `draft` — the two states a genuine setup/ingest
 * flow must be able to write through — remain unaffected. `draft` matters
 * specifically because `activateDraft`'s own flip to `active` only happens
 * AFTER a write succeeds (server/stores/connector-instance-store.ts); a
 * writable-check that rejected `draft` would make that connect path unable
 * to ever complete.
 */

import assert from "node:assert/strict";
import test from "node:test";
// biome-ignore lint/performance/noNamespaceImport: `server/auth.ts` is untyped-boundary legacy JS at several call sites; matches records.ts's import convention below.
import * as authModule from "../server/auth.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from "../server/owner-auth.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
// biome-ignore lint/performance/noNamespaceImport: `server/records.ts` is untyped-boundary legacy JS at several call sites; the namespace-import + local-type-recast pattern matches the established convention (see connector-instance-delete-vs-queued-write-fence.test.ts).
import * as recordsModule from "../server/records.ts";
import {
  createPostgresConnectorInstanceStore,
  createSqliteConnectorInstanceStore,
} from "../server/stores/connector-instance-store.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";

const DEDICATED_POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);

const CONNECTOR_ID = "revoked_write_refusal_probe";
const STREAM = "events";
const NOW = "2026-08-10T00:00:00.000Z";

interface StorageTarget {
  connector_id: string;
  connector_instance_id: string;
}

type IngestRecordFn = (
  storageTarget: StorageTarget,
  record: { data: Record<string, unknown>; emitted_at: string; key: string; stream: string },
  options?: { requireConnectionAdmission?: boolean }
) => Promise<{ accepted: boolean; changed: boolean; version?: number }>;

const ingestRecord = recordsModule.ingestRecord as unknown as IngestRecordFn;
const registerConnector = authModule.registerConnector as unknown as (manifest: object) => Promise<string>;

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
    display_name: "Revoked Write Refusal Probe Connector",
    manifest_uri: `https://registry.pdpp.dev/connectors/${CONNECTOR_ID}`,
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

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

async function seedSqliteInstance(connectorInstanceId: string, status: string) {
  const store = createSqliteConnectorInstanceStore();
  await store.upsert({
    connectorId: CONNECTOR_ID,
    connectorInstanceId,
    createdAt: NOW,
    displayName: "Probe",
    ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    sourceBinding: { account: `probe-${connectorInstanceId}@example.com` },
    sourceBindingKey: `probe-${connectorInstanceId}@example.com`,
    sourceKind: "account",
    status: "active",
    updatedAt: NOW,
  });
  if (status !== "active") {
    store.updateStatus(connectorInstanceId, { status, updatedAt: NOW });
  }
}

for (const status of ["active", "draft"]) {
  test(`SQLite: a ${status} connector instance still admits a write`, async () => {
    initDb();
    try {
      await registerConnector(manifest());
      const connectorInstanceId = `cin_revoked_refusal_sqlite_${status}`;
      await seedSqliteInstance(connectorInstanceId, status);
      const storageTarget = { connector_id: CONNECTOR_ID, connector_instance_id: connectorInstanceId };

      const outcome = await ingestRecord(storageTarget, recordEnvelope(`rec_${status}`), {
        requireConnectionAdmission: true,
      });
      assert.deepEqual(outcome, { accepted: true, changed: true, version: 1 });
    } finally {
      closeDb();
    }
  });
}

test("SQLite: a write against an already-revoked connector instance is refused with connector_instance_not_writable", async () => {
  initDb();
  try {
    await registerConnector(manifest());
    const connectorInstanceId = "cin_revoked_refusal_sqlite";
    await seedSqliteInstance(connectorInstanceId, "active");
    const storageTarget = { connector_id: CONNECTOR_ID, connector_instance_id: connectorInstanceId };
    const store = createSqliteConnectorInstanceStore();

    // `updateStatus` (unlike `deleteConnection`/`upsert`) is not wrapped in
    // `withConnectorInstanceWrite` on either backend, so there is no
    // in-process gate hook to instrument an ordering assertion against here
    // (see the interleaving test below for that). This sequential case only
    // proves the boring half: a revoke that has ALREADY fully committed
    // before the write even starts is refused.
    store.updateStatus(connectorInstanceId, { revokedAt: NOW, status: "revoked", updatedAt: NOW });

    let writeError: unknown;
    try {
      await ingestRecord(storageTarget, recordEnvelope("rec_revoked"), { requireConnectionAdmission: true });
    } catch (err) {
      writeError = err;
    }

    assert.ok(writeError instanceof Error, "the write must throw, not silently succeed against a revoked row");
    assert.equal(
      (writeError as { code?: string }).code,
      "connector_instance_not_writable",
      `write must be refused with connector_instance_not_writable — got ${String(writeError)}`
    );

    const db = getDb();
    const recordCount = (
      db.prepare("SELECT COUNT(*) AS n FROM records WHERE connector_instance_id = ?").get(connectorInstanceId) as {
        n: number;
      }
    ).n;
    assert.equal(recordCount, 0, "no record row may exist after a write refused against a revoked instance");
  } finally {
    closeDb();
  }
});

test("SQLite: a revoke that commits AFTER the pre-check but BEFORE the write transaction opens is still refused — the in-transaction re-check closes the gap the pre-check cannot", async () => {
  initDb();
  try {
    await registerConnector(manifest());
    const connectorInstanceId = "cin_revoked_refusal_interleaved";
    await seedSqliteInstance(connectorInstanceId, "active");
    const storageTarget = { connector_id: CONNECTOR_ID, connector_instance_id: connectorInstanceId };
    const store = createSqliteConnectorInstanceStore();

    // `assertConnectorInstanceWritable`'s pre-check (a separate `await` from
    // the durable write transaction) passes here, observing the
    // still-`active` row. The hook then fires in the genuine async gap
    // between that passing check and `writeTransaction` opening — exactly
    // where a concurrent revoke could land undetected if the pre-check were
    // the only guard. The revoke below runs and fully commits INSIDE the
    // hook callback, before the writer resumes.
    recordsModule.__setAdmissionPreCheckPhaseHookForTest((_point: string, context: { connectorInstanceId: string }) => {
      if (context.connectorInstanceId !== connectorInstanceId) {
        return;
      }
      store.updateStatus(connectorInstanceId, { revokedAt: NOW, status: "revoked", updatedAt: NOW });
    });

    let writeError: unknown;
    try {
      await ingestRecord(storageTarget, recordEnvelope("rec_interleaved"), { requireConnectionAdmission: true });
    } catch (err) {
      writeError = err;
    } finally {
      recordsModule.__setAdmissionPreCheckPhaseHookForTest(null);
    }

    // Fails on f43f80ea3 (before this fix): the pre-check passed while the
    // row was still active, and nothing re-reads status inside
    // `writeTransaction`, so the write silently succeeds despite the
    // revoke having fully committed before the transaction opened.
    assert.ok(
      writeError instanceof Error,
      "the write must throw once the in-transaction re-check is in place, even though the earlier pre-check observed an active row"
    );
    assert.equal(
      (writeError as { code?: string }).code,
      "connector_instance_not_writable",
      `write must be refused with connector_instance_not_writable — got ${String(writeError)}`
    );

    const db = getDb();
    const recordCount = (
      db.prepare("SELECT COUNT(*) AS n FROM records WHERE connector_instance_id = ?").get(connectorInstanceId) as {
        n: number;
      }
    ).n;
    assert.equal(recordCount, 0, "no record row may exist after a write refused by the in-transaction re-check");
    const lexicalCount = (
      db
        .prepare("SELECT COUNT(*) AS n FROM lexical_search_index WHERE connector_instance_id = ?")
        .get(connectorInstanceId) as { n: number }
    ).n;
    assert.equal(lexicalCount, 0, "no derived-index row may exist either — the write never durably committed");
  } finally {
    closeDb();
  }
});

// ---------------------------------------------------------------------------
// Postgres (skipped unless PDPP_TEST_POSTGRES_URL targets the dedicated,
// loopback-only test listener — see test/helpers/dedicated-postgres-test-url.ts)
// ---------------------------------------------------------------------------

async function seedPostgresInstance(connectorInstanceId: string, status: string) {
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
    sourceBinding: { account: `probe-${connectorInstanceId}@example.com` },
    sourceBindingKey: `probe-${connectorInstanceId}@example.com`,
    sourceKind: "account",
    status: "active",
    updatedAt: NOW,
  });
  if (status !== "active") {
    await store.updateStatus(connectorInstanceId, { status, updatedAt: NOW });
  }
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

for (const status of ["active", "draft"]) {
  test(`Postgres: a ${status} connector instance still admits a write (skipped: PDPP_TEST_POSTGRES_URL unset or non-dedicated)`, {
    skip: !DEDICATED_POSTGRES_URL,
  }, async () => {
    const databaseUrl = DEDICATED_POSTGRES_URL;
    assert.ok(databaseUrl, "dedicated Postgres test URL is configured when this test runs");
    await initPostgresStorage({ backend: "postgres", databaseUrl });
    const connectorInstanceId = `cin_revoked_refusal_pg_${status}`;
    try {
      await cleanupPostgresIdentity(connectorInstanceId);
      await seedPostgresInstance(connectorInstanceId, status);
      const storageTarget = { connector_id: CONNECTOR_ID, connector_instance_id: connectorInstanceId };

      const outcome = await ingestRecord(storageTarget, recordEnvelope(`rec_pg_${status}`), {
        requireConnectionAdmission: true,
      });
      assert.equal(outcome.accepted, true);
      assert.equal(outcome.changed, true);
      assert.equal(outcome.version, 1);
    } finally {
      await cleanupPostgresIdentity(connectorInstanceId);
      await closePostgresStorage();
    }
  });
}

test("Postgres: a write against an already-revoked connector instance is refused with connector_instance_not_writable (skipped: PDPP_TEST_POSTGRES_URL unset or non-dedicated)", {
  skip: !DEDICATED_POSTGRES_URL,
}, async () => {
  const databaseUrl = DEDICATED_POSTGRES_URL;
  assert.ok(databaseUrl, "dedicated Postgres test URL is configured when this test runs");
  await initPostgresStorage({ backend: "postgres", databaseUrl });
  const connectorInstanceId = "cin_revoked_refusal_pg";
  try {
    await cleanupPostgresIdentity(connectorInstanceId);
    await seedPostgresInstance(connectorInstanceId, "active");
    const storageTarget = { connector_id: CONNECTOR_ID, connector_instance_id: connectorInstanceId };
    const store = createPostgresConnectorInstanceStore();

    // `updateStatus` (unlike `deleteConnection`/`upsert`) is not wrapped in
    // `withConnectorInstanceWrite` on either backend — its own
    // transaction-scoped advisory lock is sufficient, so there is no
    // in-process gate hook to instrument here. A plain sequential await
    // already proves the ordering under test: the revoke's transaction has
    // fully committed before the write's own transaction opens and
    // re-reads status.
    await store.updateStatus(connectorInstanceId, { revokedAt: NOW, status: "revoked", updatedAt: NOW });

    let writeError: unknown;
    try {
      await ingestRecord(storageTarget, recordEnvelope("rec_pg_revoked"), { requireConnectionAdmission: true });
    } catch (err) {
      writeError = err;
    }

    assert.ok(writeError instanceof Error, "the write must throw, not silently succeed against a revoked row");
    assert.equal(
      (writeError as { code?: string }).code,
      "connector_instance_not_writable",
      `write must be refused with connector_instance_not_writable — got ${String(writeError)}`
    );

    const result = await postgresQuery<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM records WHERE connector_instance_id = $1",
      [connectorInstanceId]
    );
    assert.equal(
      Number(result.rows[0]?.n ?? 0),
      0,
      "no record row may exist after a write refused against a revoked instance"
    );
  } finally {
    await cleanupPostgresIdentity(connectorInstanceId);
    await closePostgresStorage();
  }
});
