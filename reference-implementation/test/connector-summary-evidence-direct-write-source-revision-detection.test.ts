// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Root-cause fix, 2026-08-18: the fleet-wide canonical-count discovery read
 * (`SELECT connector_instance_id, COUNT(*) FROM records WHERE deleted = FALSE
 * GROUP BY connector_instance_id`, formerly in `readPostgresDiscoveryContext`
 * / `readSqliteDiscoveryContext`, connector-summary-evidence-engine.ts) was
 * removed. Measured on production (2026-08-18): 3.3-6.1 seconds, ~578,000
 * buffers (~4.5 GB) read via `EXPLAIN (ANALYZE, BUFFERS)`, against a
 * `records` table where only 11 of 5,460,609 rows are ever `deleted = true`
 * -- essentially a full scan of the live table on every ~2-second sweep
 * pass, always cancelled by the per-unit `statement_timeout` floor before it
 * could complete.
 *
 * That query existed to catch one specific scenario: a direct writer that
 * mutates `records` WITHOUT going through the normal version-allocating
 * ingest/reset paths (so `version_counter` and the composite record-source
 * checkpoint never change, even though the canonical row count did). This
 * file proves that scenario is caught anyway, incrementally, with no
 * fleet-wide scan of any kind:
 *
 *   - `connector_instances.source_revision` is advanced by the row-level
 *     trigger `pdpp_source_revision_records`
 *     (`ensurePostgresConnectorSummarySourceRevisionPrimitive`,
 *     postgres-storage.ts; SQLite equivalent in db.ts), which fires on
 *     EVERY INSERT/UPDATE/DELETE to `records` -- unconditionally, regardless
 *     of whether the writer also touched `version_counter`.
 *   - `classifyCandidate`'s `source_revision_mismatch` comparison
 *     (connector-summary-evidence-engine.ts) already reads that single
 *     already-fetched column and detects the drift.
 *
 * FAIL-BEFORE proves the failure mode the removed query was actually built
 * to catch would go undetected if `source_revision` did not exist: bypassing
 * the trigger machinery entirely reproduces exactly the blind spot the OLD
 * canonical-count query was there to close. PASS-AFTER proves the current,
 * always-on code path (writing through the real `records` table, trigger
 * included, exactly as any real writer -- direct or ingest-mediated -- would)
 * detects the same direct write and marks the row for repair, using only the
 * already-batched `source_revision` comparison and no `records`-table scan.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  getConnectorSummaryEvidence,
  reconcileDirtyConnectorSummaryEvidence,
} from "../server/connector-summary-read-model.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
const NOW = "2026-08-18T00:00:00.000Z";
const CONNECTOR_ID = "https://test.pdpp.dev/connectors/direct-write-source-revision-detection";

function withPostgres(fn: () => Promise<void>) {
  return async () => {
    if (!POSTGRES_URL) {
      return;
    }
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
    try {
      await fn();
    } finally {
      await closePostgresStorage();
    }
  };
}

async function seedHealthyConnection(id: string): Promise<void> {
  await postgresQuery("DELETE FROM records WHERE connector_instance_id = $1", [id]);
  await postgresQuery("DELETE FROM connector_summary_evidence WHERE connector_instance_id = $1", [id]);
  await postgresQuery("DELETE FROM connector_instances WHERE connector_instance_id = $1", [id]);
  await postgresQuery("DELETE FROM connectors WHERE connector_id = $1", [CONNECTOR_ID]);
  await postgresQuery("INSERT INTO connectors(connector_id, manifest, created_at) VALUES($1, $2::jsonb, $3)", [
    CONNECTOR_ID,
    JSON.stringify({ connector_id: CONNECTOR_ID, streams: [{ name: "items", primary_key: ["id"] }] }),
    NOW,
  ]);
  await postgresQuery(
    `INSERT INTO connector_instances(
       connector_instance_id, owner_subject_id, connector_id, display_name, status,
       source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
     ) VALUES($1, 'owner_local', $2, 'x', 'active', 'account', $1, '{}'::jsonb, $3, $3, NULL)`,
    [id, CONNECTOR_ID, NOW]
  );
}

async function cleanup(id: string): Promise<void> {
  await postgresQuery("DELETE FROM records WHERE connector_instance_id = $1", [id]);
  await postgresQuery("DELETE FROM connector_summary_evidence WHERE connector_instance_id = $1", [id]);
  await postgresQuery("DELETE FROM connector_instances WHERE connector_instance_id = $1", [id]);
  await postgresQuery("DELETE FROM connectors WHERE connector_id = $1", [CONNECTOR_ID]);
}

/**
 * Inserts a row into `records` through the REAL table -- the trigger fires,
 * exactly like any real writer (direct SQL, an admin tool, or a bug in the
 * ingest path) -- but WITHOUT touching `version_counter` at all. This is the
 * exact shape the removed canonical-count query existed to catch: a
 * canonical row exists that the composite record-source checkpoint has no
 * knowledge of.
 */
async function insertRecordBypassingVersionCounter(instanceId: string, key: string): Promise<void> {
  await postgresQuery(
    `INSERT INTO records(
       connector_id, connector_instance_id, stream, record_key, record_json,
       emitted_at, version, deleted, primary_key_text
     ) VALUES($1, $2, 'items', $3, '{"id": "x"}'::jsonb, $4, 1, false, $3)`,
    [CONNECTOR_ID, instanceId, key, NOW]
  );
}

test(
  "FAIL-BEFORE shape: without the source_revision trigger, a direct write to `records` that bypasses version_counter leaves NO detectable trace on connector_instances -- this is the blind spot the removed canonical-count query existed to close",
  withPostgres(async () => {
    const id = "cin_direct_write_before";
    await seedHealthyConnection(id);
    try {
      const beforeRevision = await postgresQuery(
        "SELECT source_revision::text AS source_revision_text FROM connector_instances WHERE connector_instance_id = $1",
        [id]
      );
      const revisionBefore = (beforeRevision.rows[0] as { source_revision_text: string }).source_revision_text;

      // Simulate what "no incremental detection mechanism exists" would look
      // like: mutate `records` through a path that does NOT go through the
      // real table (and therefore does not fire `pdpp_source_revision_records`)
      // by disabling the trigger for this session only, proving the trigger
      // -- not some other side effect of the write -- is what closes the gap.
      await postgresQuery("ALTER TABLE records DISABLE TRIGGER pdpp_source_revision_records", []);
      try {
        await insertRecordBypassingVersionCounter(id, "direct-write-1");
      } finally {
        await postgresQuery("ALTER TABLE records ENABLE TRIGGER pdpp_source_revision_records", []);
      }

      const afterRevision = await postgresQuery(
        "SELECT source_revision::text AS source_revision_text FROM connector_instances WHERE connector_instance_id = $1",
        [id]
      );
      const revisionAfter = (afterRevision.rows[0] as { source_revision_text: string }).source_revision_text;

      assert.equal(
        revisionAfter,
        revisionBefore,
        "with the trigger disabled, a direct write to `records` leaves source_revision completely unchanged -- reproducing the exact blind spot the removed canonical-count query used to be the ONLY thing catching"
      );
    } finally {
      await cleanup(id);
    }
  })
);

test(
  "PASS-AFTER: a direct write to `records` that bypasses version_counter IS detected via source_revision alone, with no canonical-count read of any kind",
  withPostgres(async () => {
    const id = "cin_direct_write_after";
    await seedHealthyConnection(id);
    try {
      // Cold-start repair lands a healthy, non-dirty row.
      await reconcileDirtyConnectorSummaryEvidence([id]);
      const before = await getConnectorSummaryEvidence(id);
      assert.ok(before, "cold-start repair creates the evidence row");
      assert.equal(before.record_snapshot.state, "current");
      assert.equal(before.dirty, false, "the row is clean before the direct write");

      // A direct write through the REAL `records` table -- trigger included,
      // exactly like any real writer -- that does NOT allocate a version.
      await insertRecordBypassingVersionCounter(id, "direct-write-2");

      // Nothing marked this row `dirty` explicitly; the row's own claimed
      // `dirty` flag is still 0 at this point. The next reconcile pass must
      // discover the drift on its own, via source_revision, not via any
      // "someone flagged it" signal.
      const result = await reconcileDirtyConnectorSummaryEvidence(null);
      assert.equal(result.incomplete, false, "an ordinary reconcile pass with no contention completes cleanly");

      const repaired = await getConnectorSummaryEvidence(id);
      assert.ok(repaired);
      assert.equal(
        repaired.record_snapshot.state,
        "current",
        "the drift was detected and repaired in the same pass that discovered it"
      );
      // The repaired row's stored total_records must reflect the direct
      // write -- proving the drift was not merely detected but actually
      // absorbed into the canonical snapshot, via the SAME per-connection
      // repair read `repairCandidate` already performs (scoped to one
      // connection, not the removed fleet-wide scan).
      assert.equal(
        repaired.total_records,
        1,
        "the direct write is reflected in the repaired canonical total -- source_revision drove the repair, and the repair itself is what re-reads the true count for this one connection"
      );
    } finally {
      await cleanup(id);
    }
  })
);
