// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * OpenSpec task 6.1 (openspec/changes/reconcile-active-summary-evidence
 * design.md "Acceptance Strategy"): production-entry-point proof that
 * connector-wide invalidation and manifest/backfill registration ordering
 * preserve BOTH throughput fencing (already proven independently by
 * `record-reset-generation-checkpoint.test.js` and
 * `device-ingest-conformance.test.js`'s `runManifestRegistrationOracle`) AND
 * summary convergence — the two named cases in task 6.1's list that were not
 * yet directly asserted against `connector_summary_evidence`.
 *
 * `test/record-reset-generation-checkpoint.test.js` exercises
 * `deleteAllRecordsForConnector` and proves the reset-generation checkpoint
 * mechanics, but never asserts the summary primitive actually converges
 * afterward. `device-ingest-conformance.test.js`'s manifest-registration
 * oracle proves durable-prefix/registration ordering at the device-driver
 * layer, but likewise never touches `connector_summary_evidence`. This file
 * closes exactly that gap using the real production entry points
 * (`deleteAllRecordsForConnector`, `registerConnector`, `ingestRecord`),
 * which internally take the same `withConnectorInstanceWrite` fence every
 * other production write path uses — no bypass.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { registerConnector } from "../server/auth.ts";
import { reconcileConnectorSummaryEvidence } from "../server/connector-summary-evidence-engine.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { deleteAllRecordsForConnector, ingestRecord } from "../server/records.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const OWNER = "owner_local";
const NOW = "2026-07-17T00:00:00.000Z";
const DEDICATED_POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);

function requireDedicatedPostgresUrl(): string {
  const url = DEDICATED_POSTGRES_URL;
  if (url === null) {
    throw new Error("dedicated Postgres test URL is required for this fixture");
  }
  return url;
}

async function withTempDb<T>(fn: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-summary-throughput-"));
  try {
    initDb(join(dir, "pdpp.sqlite"));
    return await fn();
  } finally {
    closeDb();
    rmSync(dir, { force: true, recursive: true });
  }
}

// `registerConnector` (server/auth.ts's `normalizeConnectorManifestForStorage`)
// derives the stored connector_key from `canonicalConnectorKeyFromManifest`,
// which only canonicalizes known first-party registry URLs and falls back to
// the raw `connector_id` otherwise — an arbitrary test URL then fails
// `isConnectorKey`'s "not a URL" check on the next read-time re-validation.
// A slug-shaped `connector_key` plus `manifest_uri` (the registry/document
// provenance) is the real production shape for a non-first-party connector.
function manifestFor(connectorKey: string, streams: readonly string[]) {
  return {
    capabilities: {
      public_listing: { listed: true, status: "test" },
    },
    connector_id: connectorKey,
    connector_key: connectorKey,
    display_name: connectorKey,
    manifest_uri: `https://test.pdpp.dev/connectors/${connectorKey}`,
    protocol_version: "0.1.0",
    streams: streams.map((name: string) => ({
      coverage_strategy: "full_inventory",
      name,
      primary_key: ["id"],
      schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
      selection: { fields: true, resources: true },
      semantics: "mutable_state",
    })),
    version: "1.0.0",
  };
}

function seedInstance(connectorInstanceId: string, connectorId: string): void {
  getDb()
    .prepare(
      `INSERT INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
       ) VALUES (?, ?, ?, ?, 'active', 'account', ?, '{}', ?, ?, NULL)`
    )
    .run(connectorInstanceId, OWNER, connectorId, connectorId, connectorInstanceId, NOW, NOW);
}

async function seedInstancePostgres(connectorInstanceId: string, connectorId: string): Promise<void> {
  await postgresQuery(
    `INSERT INTO connector_instances(
       connector_instance_id, owner_subject_id, connector_id, display_name, status,
       source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
     ) VALUES ($1, $2, $3, $4, 'active', 'account', $1, '{}'::jsonb, $5, $5, NULL)`,
    [connectorInstanceId, OWNER, connectorId, connectorId, NOW]
  );
}

let uniquePgDb = 0;

/**
 * Provision and tear down a real disposable PostgreSQL database, matching
 * the pattern `device-ingest-conformance.test.js` and
 * `reconcile-active-summary-evidence-oracle.test.js`'s Postgres-gated test
 * both use: a fresh database per test run against the dedicated
 * loopback-only test listener, dropped again on the way out.
 */
async function withTemporaryPostgres(fn: () => Promise<void>): Promise<void> {
  const dedicatedUrl = requireDedicatedPostgresUrl();
  uniquePgDb += 1;
  const database = `pdpp_summary_throughput_${process.pid}_${Date.now()}_${uniquePgDb}`;
  await withTemporaryPostgresDatabase(
    { closeConnections: closePostgresStorage, connectionString: dedicatedUrl, databaseName: database },
    async (databaseUrl) => {
      await initPostgresStorage({ backend: "postgres", databaseUrl });
      await fn();
    }
  );
}

function storageTargetFor(connectorId: string, connectorInstanceId: string) {
  return { connector_id: connectorId, connector_instance_id: connectorInstanceId };
}

test("connector-wide invalidation (deleteAllRecordsForConnector) is detected and repaired by the summary primitive without a per-record dirty hook", () =>
  withTempDb(async () => {
    const connectorId = await registerConnector(manifestFor("connector-invalidation", ["messages"]), {
      backfillRetrievalIndexes: false,
    });
    seedInstance("cin_invalidation_a", connectorId);
    seedInstance("cin_invalidation_b", connectorId);

    const targetA = storageTargetFor(connectorId, "cin_invalidation_a");
    const targetB = storageTargetFor(connectorId, "cin_invalidation_b");
    await ingestRecord(targetA, { data: { id: "a_1" }, emitted_at: NOW, key: "a_1", stream: "messages" });
    await ingestRecord(targetA, { data: { id: "a_2" }, emitted_at: NOW, key: "a_2", stream: "messages" });
    await ingestRecord(targetB, { data: { id: "b_1" }, emitted_at: NOW, key: "b_1", stream: "messages" });

    const warm = await reconcileConnectorSummaryEvidence(null);
    assert.equal(warm.repaired, 2, "fixture premise: both sibling connections converge before invalidation");

    // Connector-wide invalidation takes one instance fence at a time (in
    // stable id order — see records.js's deleteAllRecordsForConnector) and
    // marks each instance's summary evidence dirty as it goes, but the
    // primitive must ALSO converge correctly from the checkpoint alone if
    // that marker were ever missed.
    const invalidation = await deleteAllRecordsForConnector(connectorId);
    assert.equal(
      invalidation.deletedCount,
      3,
      "fixture premise: all 3 records across both sibling connections are invalidated"
    );

    const result = await reconcileConnectorSummaryEvidence(null);
    assert.equal(result.repaired, 2, "both sibling connections converge on the post-invalidation zero state");

    for (const instanceId of ["cin_invalidation_a", "cin_invalidation_b"]) {
      const row = getDb()
        .prepare("SELECT total_records FROM connector_summary_evidence WHERE connector_instance_id = ?")
        .get<{ total_records: number }>(instanceId);
      assert.ok(row, `evidence row exists for ${instanceId}`);
      assert.equal(row.total_records, 0, `${instanceId} reads zero records after connector-wide invalidation`);
    }

    // A second reconcile pass is idempotent: invalidation must not leave the
    // primitive perpetually "dirty" once genuinely converged.
    const secondPass = await reconcileConnectorSummaryEvidence(null);
    assert.equal(secondPass.repaired, 0, "a second pass after convergence repairs nothing further");
  }));

test("manifest registration/backfill ordering does not desynchronize the summary primitive from canonical state", () =>
  withTempDb(async () => {
    // M1: register a manifest with one stream, ingest under it, and let the
    // summary primitive converge — establishing a baseline before the
    // manifest is re-registered (an ordering scenario mirroring
    // device-ingest-conformance.test.js's runManifestRegistrationOracle,
    // but asserting summary convergence rather than durable-prefix ordering).
    const connectorId = await registerConnector(manifestFor("manifest-backfill-ordering", ["messages"]), {
      backfillRetrievalIndexes: false,
    });
    seedInstance("cin_manifest_ordering", connectorId);
    const target = storageTargetFor(connectorId, "cin_manifest_ordering");
    await ingestRecord(target, { data: { id: "m1_msg" }, emitted_at: NOW, key: "m1_msg", stream: "messages" });

    const afterM1 = await reconcileConnectorSummaryEvidence(null);
    assert.equal(afterM1.repaired, 1, "fixture premise: the connection converges under the M1 manifest");

    // M2: the manifest is re-registered (e.g. a new stream declared) BEFORE
    // the next ingest lands, mirroring registration/backfill racing ahead of
    // a still-in-flight or about-to-resume writer. Real production entry
    // point: registerConnector goes through the exact same manifest-storage
    // + backfill path a live registration takes.
    await registerConnector(manifestFor("manifest-backfill-ordering", ["messages", "files"]), {
      backfillRetrievalIndexes: false,
    });
    await ingestRecord(target, { data: { id: "m2_file" }, emitted_at: NOW, key: "m2_file", stream: "files" });

    const afterM2 = await reconcileConnectorSummaryEvidence(null);
    assert.equal(afterM2.repaired, 1, "the connection re-converges under the M2 manifest after the new stream lands");

    const row = getDb()
      .prepare("SELECT total_records, stream_count FROM connector_summary_evidence WHERE connector_instance_id = ?")
      .get<{ stream_count: number; total_records: number }>("cin_manifest_ordering");
    assert.ok(row, "summary evidence row exists after manifest re-registration");
    assert.equal(
      row.total_records,
      2,
      "both the pre- and post-registration records are reflected, none dropped by the manifest swap"
    );
    assert.equal(row.stream_count, 2, "both streams (declared under M1 and M2) are visible after re-registration");
  }));

// ---------------------------------------------------------------------------
// Real disposable PostgreSQL coverage (design.md "Acceptance Strategy": every
// forced fixture runs against SQLite AND a real disposable Postgres
// database). These two cases — accepted replay and connector-wide
// invalidation — are the two simplest, highest-value forced fixtures from
// this file and from device-batch-summary-evidence-convergence.test.js,
// ported here against the SAME production entry points
// (ingestRecord/deleteAllRecordsForConnector/registerConnector/
// reconcileConnectorSummaryEvidence), with storage routed to a real
// Postgres database via initPostgresStorage rather than SQLite's initDb.
// ---------------------------------------------------------------------------

test(
  "PostgreSQL: connector-wide invalidation (deleteAllRecordsForConnector) is detected and repaired by the summary primitive without a per-record dirty hook",
  { skip: !DEDICATED_POSTGRES_URL },
  () =>
    withTemporaryPostgres(async () => {
      const connectorId = await registerConnector(manifestFor("pg-connector-invalidation", ["messages"]), {
        backfillRetrievalIndexes: false,
      });
      await seedInstancePostgres("cin_pg_invalidation_a", connectorId);
      await seedInstancePostgres("cin_pg_invalidation_b", connectorId);

      const targetA = storageTargetFor(connectorId, "cin_pg_invalidation_a");
      const targetB = storageTargetFor(connectorId, "cin_pg_invalidation_b");
      await ingestRecord(targetA, { data: { id: "a_1" }, emitted_at: NOW, key: "a_1", stream: "messages" });
      await ingestRecord(targetA, { data: { id: "a_2" }, emitted_at: NOW, key: "a_2", stream: "messages" });
      await ingestRecord(targetB, { data: { id: "b_1" }, emitted_at: NOW, key: "b_1", stream: "messages" });

      const warm = await reconcileConnectorSummaryEvidence(null);
      assert.equal(warm.repaired, 2, "fixture premise: both sibling connections converge before invalidation");

      const invalidation = await deleteAllRecordsForConnector(connectorId);
      assert.equal(
        invalidation.deletedCount,
        3,
        "fixture premise: all 3 records across both sibling connections are invalidated"
      );

      const result = await reconcileConnectorSummaryEvidence(null);
      assert.equal(
        result.repaired,
        2,
        "both sibling connections converge on the post-invalidation zero state against real PostgreSQL"
      );

      const rowsByInstance = await Promise.all(
        ["cin_pg_invalidation_a", "cin_pg_invalidation_b"].map(async (instanceId) => {
          const { rows } = await postgresQuery<{ total_records: number | string }>(
            "SELECT total_records FROM connector_summary_evidence WHERE connector_instance_id = $1",
            [instanceId]
          );
          const [row] = rows;
          assert.ok(row, `evidence row exists for ${instanceId}`);
          return { instanceId, row };
        })
      );
      for (const { instanceId, row } of rowsByInstance) {
        assert.equal(
          Number(row.total_records),
          0,
          `${instanceId} reads zero records after connector-wide invalidation`
        );
      }

      const secondPass = await reconcileConnectorSummaryEvidence(null);
      assert.equal(secondPass.repaired, 0, "a second pass after convergence repairs nothing further");
    })
);

test(
  "PostgreSQL: an accepted replay of an already-committed batch prefix advances neither the checkpoint nor repair work",
  { skip: !DEDICATED_POSTGRES_URL },
  () =>
    withTemporaryPostgres(async () => {
      const connectorId = await registerConnector(manifestFor("pg-accepted-replay", ["messages"]), {
        backfillRetrievalIndexes: false,
      });
      await seedInstancePostgres("cin_pg_accepted_replay", connectorId);
      const target = storageTargetFor(connectorId, "cin_pg_accepted_replay");

      await ingestRecord(target, { data: { id: "msg_1" }, emitted_at: NOW, key: "msg_1", stream: "messages" });
      await ingestRecord(target, { data: { id: "msg_2" }, emitted_at: NOW, key: "msg_2", stream: "messages" });
      await reconcileConnectorSummaryEvidence(null);
      const checkpointAfterBatch = (
        await postgresQuery(
          "SELECT record_checkpoint_json::text AS record_checkpoint_json FROM connector_summary_evidence WHERE connector_instance_id = $1",
          ["cin_pg_accepted_replay"]
        )
      ).rows[0]?.record_checkpoint_json;

      const replay1 = await ingestRecord(target, {
        data: { id: "msg_1" },
        emitted_at: NOW,
        key: "msg_1",
        stream: "messages",
      });
      const replay2 = await ingestRecord(target, {
        data: { id: "msg_2" },
        emitted_at: NOW,
        key: "msg_2",
        stream: "messages",
      });
      assert.equal(replay1.changed, false);
      assert.equal(replay2.changed, false);

      const result = await reconcileConnectorSummaryEvidence(null);
      assert.equal(result.repaired, 0, "an accepted replay triggers zero repair work against real PostgreSQL");
      const checkpointAfterReplay = (
        await postgresQuery(
          "SELECT record_checkpoint_json::text AS record_checkpoint_json FROM connector_summary_evidence WHERE connector_instance_id = $1",
          ["cin_pg_accepted_replay"]
        )
      ).rows[0]?.record_checkpoint_json;
      assert.equal(checkpointAfterReplay, checkpointAfterBatch, "the composite checkpoint is unchanged by the replay");

      const { rows } = await postgresQuery<{ total_records: number | string }>(
        "SELECT total_records FROM connector_summary_evidence WHERE connector_instance_id = $1",
        ["cin_pg_accepted_replay"]
      );
      const [row] = rows;
      assert.ok(row, "summary evidence row exists after accepted replay");
      assert.equal(Number(row.total_records), 2, "the replay does not double-count the two records");
    })
);
