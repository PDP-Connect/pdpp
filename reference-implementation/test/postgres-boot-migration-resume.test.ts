// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Convergence, crash-resume, and fail-closed evidence for the local-device
 * connector canonicalization boot migration.
 *
 * BEHAVIOR PROTECTED. A populated deployment must not pay the migration's
 * row-rewriting cost on every restart, and a crash mid-migration must not
 * lose or duplicate identity work.
 *
 * PLAUSIBLE DEFECT THIS CATCHES. The pre-fix implementation guarded on table
 * shape plus row presence, not on a completion receipt: every boot re-read
 * every `device_source_instances` row and re-issued an `UPDATE` per row per
 * table across 17 tables, two of which are the deployment's largest
 * (`lexical_search_index` 24 GB, `record_changes` 9.8 GB), inside one
 * pre-listen transaction that committed once at the end.
 *
 * Verified fail-before (grafting the pre-fix behavior back onto this file's
 * fixtures), these fail:
 *   - "derived projections are queued ... not rewritten inline"
 *   - "a complete receipt makes the boot skip the source-row scan entirely"
 *   - "a failure on a later batch keeps earlier committed batches durable"
 *   - "large-table query shape ..."
 *   - "the inlined dirty mark stays equivalent ..."
 *
 * ORACLE AND TRUTH SOURCE. Real PostgreSQL, not a double. Two independent
 * oracles are used deliberately, and the SECOND is the discriminating one:
 *   1. `pg_stat_user_tables.n_tup_upd` deltas — the engine's own mutation
 *      counter, which no application-side bookkeeping can fake.
 *   2. `pg_stat_user_tables` SCAN deltas (`seq_scan + idx_scan`). A rows-
 *      updated assertion alone is NOT sufficient and was measured not to
 *      be: after a first boot canonicalizes the rows, the pre-fix
 *      statement matches nothing and updates zero rows while still
 *      executing the scan that walks the instance-leading index. The scan
 *      is the incident cost, so the scan is what gets asserted.
 * The ledger receipt is asserted alongside these, never instead of them: it
 * is the implementation's own claim and would be circular as sole evidence.
 *
 * WHY NOTHING CHEAPER SUFFICES. The behavior at risk is transaction and
 * restart semantics against a real engine's planner and statistics. A
 * SQLite or in-memory stand-in has neither `pg_stat_user_tables` nor the
 * instance-leading index shapes that made the original statements expensive.
 *
 * REQUIRES. `PDPP_TEST_POSTGRES_URL` (real-Postgres profile). Skipped, and
 * declared as skipped, when unset.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { makeConnectorInstanceSourceBindingKey } from "../server/connector-instance-utils.ts";
import {
  bootstrapPostgresSchema,
  closePostgresStorage,
  getPostgresPool,
  initPostgresStorage,
  readPostgresLocalDeviceCanonicalizationReceipt,
} from "../server/postgres-storage.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

const OWNER = "owner_boot_migration";
const DEVICE = "dev_boot_migration";
const CONNECTOR_KEY = "codex";
const LEGACY_CONNECTOR_ID = "local-device:codex:src_a";

/**
 * The tables whose rewrite must survive the migration as authoritative
 * history. `record_changes` is on this list on purpose: the audit's
 * classification treats it as retained change-history authority, never a
 * rebuildable projection, so a fix that moved it to background repair would
 * be wrong and this test would still hold it in the transaction.
 */
const AUTHORITATIVE_TABLES = ["records", "record_changes", "version_counter"] as const;

/**
 * The tables whose rewrite must NOT happen on the readiness path. A second
 * boot touching any of these reproduces the incident.
 */
const PROJECTION_TABLES = ["lexical_search_index", "lexical_search_meta"] as const;

const RE_AMBIGUOUS_BINDING = /Ambiguous local-device connector instance migration/;
const RE_AMBIGUOUS = /Ambiguous/;
const RE_INSTANCE_LEADING_PLAN = /connector_instance_id/;

let tempCounter = 0;
function tempDbName(): string {
  tempCounter += 1;
  return `pdpp_boot_migration_${process.pid}_${tempCounter}`;
}

async function withTempDb(baseUrl: string, fn: (url: string) => Promise<void>): Promise<void> {
  await withTemporaryPostgresDatabase(
    { closeConnections: closePostgresStorage, connectionString: baseUrl, databaseName: tempDbName() },
    fn
  );
}

type Pool = ReturnType<typeof getPostgresPool>;

/**
 * Per-table `n_tup_upd` from the engine's own statistics. `pg_stat_*` is
 * collected asynchronously, so the caller must force a flush before reading
 * a delta that must be exact.
 */
async function updateCounts(pool: Pool, tables: readonly string[]): Promise<Map<string, number>> {
  await pool.query("SELECT pg_stat_force_next_flush()");
  const result = await pool.query<{ n_tup_upd: string; relname: string }>(
    `SELECT relname, n_tup_upd::text
       FROM pg_stat_user_tables
      WHERE schemaname = current_schema() AND relname = ANY($1)`,
    [[...tables]]
  );
  return new Map(result.rows.map((row) => [row.relname, Number(row.n_tup_upd)]));
}

/**
 * Per-table total scans (`seq_scan + idx_scan`).
 *
 * This is the discriminating oracle, and `n_tup_upd` alone is not. Once a
 * first boot canonicalizes the rows, the pre-fix boot's unguarded
 * `UPDATE ... WHERE connector_id = <legacy>` matches nothing on the second
 * boot and updates zero rows — while still PLANNING and EXECUTING the scan
 * that walks the instance-leading index. That scan is the incident: the
 * audit observed the statement active for ~63 s with
 * `wait_event=DataFileRead` against a 110 GB database, updating nothing.
 * A rows-updated assertion cannot see it; a scan-count assertion can.
 */
async function scanCounts(pool: Pool, tables: readonly string[]): Promise<Map<string, number>> {
  await pool.query("SELECT pg_stat_force_next_flush()");
  const result = await pool.query<{ idx_scan: string; relname: string; seq_scan: string }>(
    `SELECT relname, seq_scan::text, idx_scan::text
       FROM pg_stat_user_tables
      WHERE schemaname = current_schema() AND relname = ANY($1)`,
    [[...tables]]
  );
  return new Map(result.rows.map((row) => [row.relname, Number(row.seq_scan) + Number(row.idx_scan)]));
}

function delta(before: Map<string, number>, after: Map<string, number>, table: string): number {
  return (after.get(table) ?? 0) - (before.get(table) ?? 0);
}

/**
 * Discard the canonicalization receipt so the NEXT `bootstrapPostgresSchema`
 * runs the data phase.
 *
 * `initPostgresStorage` bootstraps against the empty scratch database, which
 * legitimately completes the migration with zero source rows. A test that
 * seeds afterwards would otherwise be describing a deployment that acquired
 * legacy rows AFTER its migration finished, which cannot happen: the legacy
 * shape predates the code that canonicalizes it. Clearing the receipt puts
 * the database in the real pre-migration state instead.
 */
async function resetCanonicalizationReceipt(pool: Pool): Promise<void> {
  await pool.query("DELETE FROM storage_migration_ledger WHERE migration_id = $1", [
    "local_device_connector_canonicalization_v1",
  ]);
}

/**
 * Seed one stale local-device identity with authoritative rows and derived
 * projection rows, all carrying the LEGACY connector id — the exact shape
 * the migration exists to canonicalize.
 */
async function seedStaleLocalDeviceIdentity(
  pool: Pool,
  { instanceId, recordCount, sourceInstanceId }: { instanceId: string; recordCount: number; sourceInstanceId: string }
): Promise<void> {
  const now = "2026-01-01T00:00:00.000Z";
  await pool.query(
    `INSERT INTO device_exporters(device_id, owner_subject_id, display_name, status, created_at, updated_at)
     VALUES ($1, $2, 'boot migration device', 'active', $3, $3)
     ON CONFLICT (device_id) DO NOTHING`,
    [DEVICE, OWNER, now]
  );
  await pool.query(
    `INSERT INTO device_source_instances(
       source_instance_id, device_id, connector_id, connector_instance_id, local_binding_id,
       display_name, status, created_at, updated_at)
     VALUES ($1, $2, $3, NULL, $4, 'Codex', 'active', $5, $5)`,
    [sourceInstanceId, DEVICE, CONNECTOR_KEY, `binding_${sourceInstanceId}`, now]
  );
  await pool.query(
    `INSERT INTO connectors(connector_id, manifest, created_at)
     VALUES ($1, '{"connector_id":"codex","streams":[]}'::jsonb, $2)
     ON CONFLICT (connector_id) DO NOTHING`,
    [CONNECTOR_KEY, now]
  );
  await pool.query(
    `INSERT INTO connector_instances(
       connector_instance_id, owner_subject_id, connector_id, display_name, status,
       source_kind, source_binding_key, source_binding_json, created_at, updated_at)
     VALUES ($1, $2, $3, 'Codex', 'active', 'local_device', $4, '{}'::jsonb, $5, $5)
     ON CONFLICT (connector_instance_id) DO NOTHING`,
    [instanceId, OWNER, CONNECTOR_KEY, `seed_${instanceId}`, now]
  );

  const legacyId = `local-device:${CONNECTOR_KEY}:${sourceInstanceId}`;
  await pool.query(
    `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json,
                         emitted_at, version, primary_key_text)
     SELECT $1, $2, 'messages', 'rk_' || g, '{}'::jsonb, $3, 1, 'rk_' || g
       FROM generate_series(1, $4) g`,
    [legacyId, instanceId, now, recordCount]
  );
  await pool.query(
    `INSERT INTO record_changes(connector_id, connector_instance_id, stream, record_key, version, emitted_at)
     SELECT $1, $2, 'messages', 'rk_' || g, g, $3 FROM generate_series(1, $4) g`,
    [legacyId, instanceId, now, recordCount]
  );
  await pool.query(
    `INSERT INTO version_counter(connector_id, connector_instance_id, stream, max_version)
     VALUES ($1, $2, 'messages', $3)`,
    [legacyId, instanceId, recordCount]
  );
  await pool.query(
    `INSERT INTO lexical_search_index(connector_id, connector_instance_id, stream, record_key, field, value)
     SELECT $1, $2, 'messages', 'rk_' || g, 'body', 'seeded text ' || g FROM generate_series(1, $3) g`,
    [legacyId, instanceId, recordCount]
  );
  await pool.query(
    `INSERT INTO lexical_search_meta(connector_id, connector_instance_id, stream, fields_fingerprint, updated_at)
     VALUES ($1, $2, 'messages', 'fp', $3)`,
    [legacyId, instanceId, now]
  );
  await resetCanonicalizationReceipt(pool);
}

if (POSTGRES_URL) {
  test("first boot canonicalizes authoritative rows and records a complete receipt", async () => {
    await withTempDb(POSTGRES_URL, async (url) => {
      await initPostgresStorage({ backend: "postgres", databaseUrl: url });
      const pool = getPostgresPool();
      await seedStaleLocalDeviceIdentity(pool, {
        instanceId: "cin_boot_a",
        recordCount: 40,
        sourceInstanceId: "src_a",
      });

      await bootstrapPostgresSchema();

      const records = await pool.query<{ connector_id: string; n: string }>(
        "SELECT connector_id, count(*)::text AS n FROM records GROUP BY connector_id"
      );
      assert.deepEqual(
        records.rows.map((row) => row.connector_id),
        [CONNECTOR_KEY],
        "records must carry only the canonical connector id after migration"
      );
      assert.equal(records.rows[0]?.n, "40", "no authoritative record may be lost by canonicalization");

      const changes = await pool.query<{ connector_id: string; n: string }>(
        "SELECT connector_id, count(*)::text AS n FROM record_changes GROUP BY connector_id"
      );
      assert.deepEqual(
        changes.rows.map((row) => row.connector_id),
        [CONNECTOR_KEY],
        "record_changes is retained-history authority and must be rewritten in the identity transaction"
      );
      assert.equal(changes.rows[0]?.n, "40", "retained change history must survive canonicalization intact");

      const receipt = await readPostgresLocalDeviceCanonicalizationReceipt();
      assert.equal(receipt?.status, "complete", "a converged migration must write a durable complete receipt");
      assert.equal(receipt?.cursor, "src_a", "the receipt must carry the durable resume boundary it reached");
      assert.ok(
        (receipt?.changedRows ?? 0) >= 81,
        `changed-row receipt must count the real rewrite (40 records + 40 changes + 1 counter), got ${receipt?.changedRows}`
      );
    });
  });

  test("derived projections are queued for post-readiness repair, not rewritten inline", async () => {
    await withTempDb(POSTGRES_URL, async (url) => {
      await initPostgresStorage({ backend: "postgres", databaseUrl: url });
      const pool = getPostgresPool();
      await seedStaleLocalDeviceIdentity(pool, {
        instanceId: "cin_boot_b",
        recordCount: 30,
        sourceInstanceId: "src_a",
      });

      const before = await updateCounts(pool, PROJECTION_TABLES);
      await bootstrapPostgresSchema();
      const after = await updateCounts(pool, PROJECTION_TABLES);

      for (const table of PROJECTION_TABLES) {
        assert.equal(
          delta(before, after, table),
          0,
          `${table} is a rebuildable projection; the readiness path must never UPDATE it`
        );
      }

      const stale = await pool.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM lexical_search_index WHERE connector_id = $1",
        [LEGACY_CONNECTOR_ID]
      );
      assert.equal(
        stale.rows[0]?.n,
        "0",
        "legacy-keyed projection rows are invisible to the connector_id-scoped search reads and must not survive"
      );

      const dirty = await pool.query<{ connector_id: string; dirty: number; stream: string }>(
        "SELECT stream, dirty, connector_id FROM search_index_dirty WHERE connector_instance_id = $1",
        ["cin_boot_b"]
      );
      assert.deepEqual(
        dirty.rows.map((row) => ({ connectorId: row.connector_id, dirty: Number(row.dirty), stream: row.stream })),
        [{ connectorId: CONNECTOR_KEY, dirty: 1, stream: "messages" }],
        "the dropped projection scope must be enqueued for the post-listen reconcile sweep under its CANONICAL id"
      );

      // The freshness seam. `countDirtySearchIndexScopes` is the EXACT
      // function the read surface calls to attach its
      // `meta.index_maintenance` disclosure (routes/rs-read.ts), so a
      // nonzero count here is what makes the deferral honest rather than
      // silent: the boot no longer rewrites these projections, and the read
      // says so instead of implying completeness. Asserted against the real
      // store function, not the raw table, so a change to that function's
      // eligibility rules that hid this backlog would fail here.
      const { countDirtySearchIndexScopes } = await import("../server/stores/search-index-dirty-store.ts");
      assert.equal(
        await countDirtySearchIndexScopes(),
        1,
        "the deferred projection repair must be visible to the read surface's freshness disclosure"
      );

      const receipt = await readPostgresLocalDeviceCanonicalizationReceipt();
      assert.equal(receipt?.status, "complete");
    });
  });

  test("second boot issues no canonicalization updates against authoritative or projection tables", async () => {
    await withTempDb(POSTGRES_URL, async (url) => {
      await initPostgresStorage({ backend: "postgres", databaseUrl: url });
      const pool = getPostgresPool();
      await seedStaleLocalDeviceIdentity(pool, {
        instanceId: "cin_boot_c",
        recordCount: 50,
        sourceInstanceId: "src_a",
      });
      await bootstrapPostgresSchema();

      const watched = [...AUTHORITATIVE_TABLES, ...PROJECTION_TABLES];
      const before = await updateCounts(pool, watched);
      const scansBefore = await scanCounts(pool, [...watched, "device_source_instances"]);
      await bootstrapPostgresSchema();
      const after = await updateCounts(pool, watched);
      const scansAfter = await scanCounts(pool, [...watched, "device_source_instances"]);

      for (const table of watched) {
        assert.equal(
          delta(before, after, table),
          0,
          `restart must not re-issue the canonicalization UPDATE against ${table}; the pre-fix boot did on every restart`
        );
      }
      // The assertion that actually discriminates. See `scanCounts`: a
      // second boot that still executes the canonicalization statement
      // updates zero rows but scans the table anyway, which is the cost the
      // incident paid before the server bound a listener.
      for (const table of [...watched, "device_source_instances"]) {
        assert.equal(
          delta(scansBefore, scansAfter, table),
          0,
          `restart must not SCAN ${table}; zero rows updated does not prove the scan was skipped`
        );
      }

      const receipt = await readPostgresLocalDeviceCanonicalizationReceipt();
      assert.equal(receipt?.status, "complete", "the receipt must stay complete across restarts");
      assert.equal(
        receipt?.attemptCount,
        1,
        "a complete receipt must not be re-claimed; a second attempt means the skip did not happen"
      );
    });
  });

  test("a complete receipt makes the boot skip the source-row scan entirely", async () => {
    await withTempDb(POSTGRES_URL, async (url) => {
      await initPostgresStorage({ backend: "postgres", databaseUrl: url });
      const pool = getPostgresPool();
      await seedStaleLocalDeviceIdentity(pool, {
        instanceId: "cin_boot_d",
        recordCount: 10,
        sourceInstanceId: "src_a",
      });
      await bootstrapPostgresSchema();

      // Sequential-scan count on the migration's INPUT table. A boot that
      // still enumerates source rows increments this; the zero-row-updated
      // oracle above cannot see that read, only its writes.
      await pool.query("SELECT pg_stat_force_next_flush()");
      const before = await pool.query<{ seq_scan: string }>(
        `SELECT seq_scan::text FROM pg_stat_user_tables
          WHERE schemaname = current_schema() AND relname = 'device_source_instances'`
      );
      await bootstrapPostgresSchema();
      await pool.query("SELECT pg_stat_force_next_flush()");
      const after = await pool.query<{ seq_scan: string }>(
        `SELECT seq_scan::text FROM pg_stat_user_tables
          WHERE schemaname = current_schema() AND relname = 'device_source_instances'`
      );
      assert.equal(
        Number(after.rows[0]?.seq_scan) - Number(before.rows[0]?.seq_scan),
        0,
        "a complete receipt must skip the data phase before it reads device_source_instances at all"
      );
    });
  });

  test("a complete receipt coalesces a post-enrollment duplicate without reading the migration input", async () => {
    await withTempDb(POSTGRES_URL, async (url) => {
      await initPostgresStorage({ backend: "postgres", databaseUrl: url });
      const pool = getPostgresPool();
      const completeReceipt = await readPostgresLocalDeviceCanonicalizationReceipt();
      assert.equal(completeReceipt?.status, "complete", "the duplicate must be introduced after the receipt completed");
      const now = "2026-01-01T00:00:00.000Z";
      const sourceInstanceId = "src_complete_duplicate";
      const canonicalId = "cin_complete_duplicate";
      const legacyId = "cin_complete_duplicate_legacy";
      const sourceBinding = {
        device_id: DEVICE,
        kind: "local_device",
        local_binding_name: "complete-duplicate",
        source_instance_id: sourceInstanceId,
      };
      const stableBindingKey = makeConnectorInstanceSourceBindingKey({
        kind: "local_device",
        local_binding_name: "complete-duplicate",
      });

      await pool.query(
        `INSERT INTO device_exporters(device_id, owner_subject_id, display_name, status, created_at, updated_at)
         VALUES ($1, $2, 'boot migration device', 'active', $3, $3)`,
        [DEVICE, OWNER, now]
      );
      await pool.query(
        `INSERT INTO connectors(connector_id, manifest, created_at)
         VALUES ($1, '{"connector_id":"codex","streams":[]}'::jsonb, $2)`,
        [CONNECTOR_KEY, now]
      );
      await pool.query(
        `INSERT INTO connector_instances(
           connector_instance_id, owner_subject_id, connector_id, display_name, status,
           source_kind, source_binding_key, source_binding_json, created_at, updated_at)
         VALUES ($1, $2, $3, 'Codex', 'active', 'local_device', $4, $5::jsonb, $6, $6),
                ($7, $2, $3, 'Codex', 'active', 'local_device', $8, $5::jsonb, $6, $6)`,
        [
          canonicalId,
          OWNER,
          CONNECTOR_KEY,
          stableBindingKey,
          JSON.stringify(sourceBinding),
          now,
          legacyId,
          makeConnectorInstanceSourceBindingKey(sourceBinding),
        ]
      );
      await pool.query(
        `INSERT INTO device_source_instances(
           source_instance_id, device_id, connector_id, connector_instance_id, local_binding_id,
           source_kind, display_name, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'complete-duplicate', 'local_device', 'Codex', 'active', $5, $5)`,
        [sourceInstanceId, DEVICE, CONNECTOR_KEY, canonicalId, now]
      );
      await pool.query(
        `INSERT INTO connector_state(connector_id, connector_instance_id, stream, state_json, updated_at)
         VALUES ($1, $2, 'messages', '{"cursor":"preserved"}'::jsonb, $3)`,
        [CONNECTOR_KEY, legacyId, now]
      );
      await pool.query(
        `INSERT INTO lexical_search_index(connector_id, connector_instance_id, stream, record_key, field, value)
         VALUES ($1, $2, 'messages', 'rk_complete_duplicate', 'body', 'legacy projection')`,
        [CONNECTOR_KEY, legacyId]
      );
      await pool.query(
        `INSERT INTO lexical_search_meta(connector_id, connector_instance_id, stream, fields_fingerprint, updated_at)
         VALUES ($1, $2, 'messages', 'legacy-fingerprint', $3)`,
        [CONNECTOR_KEY, legacyId, now]
      );

      const scansBefore = await scanCounts(pool, ["device_source_instances"]);
      await bootstrapPostgresSchema();
      const scansAfter = await scanCounts(pool, ["device_source_instances"]);

      assert.equal(
        delta(scansBefore, scansAfter, "device_source_instances"),
        0,
        "a COMPLETE boot must coalesce through connector_instances without reopening the migration input"
      );
      const instances = await pool.query<{ connector_instance_id: string }>(
        "SELECT connector_instance_id FROM connector_instances WHERE connector_instance_id = ANY($1::text[]) ORDER BY connector_instance_id",
        [[canonicalId, legacyId]]
      );
      assert.deepEqual(
        instances.rows,
        [{ connector_instance_id: canonicalId }],
        "the exact stale duplicate must still be coalesced on a COMPLETE boot"
      );
      const state = await pool.query<{ connector_instance_id: string }>(
        "SELECT connector_instance_id FROM connector_state WHERE connector_instance_id = $1",
        [canonicalId]
      );
      assert.deepEqual(
        state.rows,
        [{ connector_instance_id: canonicalId }],
        "legacy-owned state must survive the coalescence"
      );
      const projections = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM lexical_search_index WHERE connector_instance_id = $1",
        [legacyId]
      );
      assert.equal(
        projections.rows[0]?.count,
        "0",
        "legacy rebuildable projections must be discarded, never repointed"
      );
      const dirty = await pool.query<{ connector_id: string; dirty: number; revision: string; stream: string }>(
        "SELECT connector_id, stream, dirty, revision::text AS revision FROM search_index_dirty WHERE connector_instance_id = $1",
        [canonicalId]
      );
      assert.deepEqual(
        dirty.rows,
        [{ connector_id: CONNECTOR_KEY, dirty: 1, revision: "1", stream: "messages" }],
        "discarded post-receipt projections must queue canonical repair in the same transaction"
      );
    });
  });

  test("a failure on a later batch keeps earlier committed batches durable", async () => {
    // The strongest fail-before assertion in this file. The pre-fix
    // implementation wrapped EVERY source row in ONE transaction, so a
    // failure on the last row rolled back the work already done for the
    // first — the next boot then repeated the whole thing. Here the batch
    // size is forced to 1 so batch boundaries are observable, a real
    // collision is planted on the LAST source row, and the earlier row's
    // canonicalization is asserted to have survived the failure.
    const previousBatchSize = process.env.PDPP_LOCAL_DEVICE_MIGRATION_BATCH_SIZE;
    process.env.PDPP_LOCAL_DEVICE_MIGRATION_BATCH_SIZE = "1";
    try {
      await withTempDb(POSTGRES_URL, async (url) => {
        await initPostgresStorage({ backend: "postgres", databaseUrl: url });
        const pool = getPostgresPool();
        for (const suffix of ["a", "z"]) {
          // biome-ignore lint/performance/noAwaitInLoops: Fixture seeding must be sequential — the rows share a device_exporters parent and a deterministic source-instance order the cursor assertions depend on.
          await seedStaleLocalDeviceIdentity(pool, {
            instanceId: `cin_partial_${suffix}`,
            recordCount: 4,
            sourceInstanceId: `src_${suffix}`,
          });
        }
        // Ambiguity planted on src_z only: a second connector instance holding
        // rows under src_z's legacy connector id. src_a is untouched and must
        // migrate and STAY migrated.
        await pool.query(
          `INSERT INTO connector_instances(
           connector_instance_id, owner_subject_id, connector_id, display_name, status,
           source_kind, source_binding_key, source_binding_json, created_at, updated_at)
         VALUES ('cin_partial_conflict', $1, $2, 'Codex', 'active', 'local_device', 'seed_conflict', '{}'::jsonb, $3, $3)`,
          [OWNER, CONNECTOR_KEY, "2026-01-01T00:00:00.000Z"]
        );
        await pool.query(
          `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json,
                             emitted_at, version, primary_key_text)
         VALUES ($1, 'cin_partial_conflict', 'messages', 'rk_x', '{}'::jsonb, '2026-01-01T00:00:00.000Z', 1, 'rk_x')`,
          [`local-device:${CONNECTOR_KEY}:src_z`]
        );

        await assert.rejects(() => bootstrapPostgresSchema(), RE_AMBIGUOUS_BINDING);

        const survived = await pool.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM records WHERE connector_instance_id = 'cin_partial_a' AND connector_id = $1`,
          [CONNECTOR_KEY]
        );
        assert.equal(
          survived.rows[0]?.n,
          "4",
          "an earlier batch's committed canonicalization must survive a later batch's fail-closed rollback"
        );

        const receipt = await readPostgresLocalDeviceCanonicalizationReceipt();
        assert.equal(receipt?.status, "blocked", "the run must be blocked, not complete");
        assert.equal(
          receipt?.cursor,
          "src_a",
          "the durable cursor must point at the last COMMITTED source row so the retry resumes there"
        );

        const failedRow = await pool.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM records WHERE connector_instance_id = 'cin_partial_z' AND connector_id = $1`,
          [`local-device:${CONNECTOR_KEY}:src_z`]
        );
        assert.equal(failedRow.rows[0]?.n, "4", "the failing batch must roll back completely");
      });
    } finally {
      if (previousBatchSize === undefined) {
        delete process.env.PDPP_LOCAL_DEVICE_MIGRATION_BATCH_SIZE;
      } else {
        process.env.PDPP_LOCAL_DEVICE_MIGRATION_BATCH_SIZE = previousBatchSize;
      }
    }
  });

  test("crash mid-migration resumes from the durable cursor without duplicating or losing work", async () => {
    await withTempDb(POSTGRES_URL, async (url) => {
      await initPostgresStorage({ backend: "postgres", databaseUrl: url });
      const pool = getPostgresPool();
      // Three source rows; the batch size is larger, so a single boot would
      // finish them together. Forcing a partial cursor simulates the crash
      // boundary between two committed batches.
      for (const suffix of ["a", "b", "c"]) {
        // biome-ignore lint/performance/noAwaitInLoops: Fixture seeding must be sequential — the rows share a device_exporters parent and a deterministic source-instance order the cursor assertions depend on.
        await seedStaleLocalDeviceIdentity(pool, {
          instanceId: `cin_resume_${suffix}`,
          recordCount: 5,
          sourceInstanceId: `src_${suffix}`,
        });
      }
      await bootstrapPostgresSchema();

      // Rewind to the state a crash after the FIRST batch would have left:
      // a running claim, a cursor at src_a, and src_b/src_c still legacy.
      await pool.query(
        `UPDATE storage_migration_ledger
            SET status = 'running', cursor = 'src_a', changed_rows = 0, completed_at = NULL
          WHERE migration_id = 'local_device_connector_canonicalization_v1'`
      );
      const legacyB = `local-device:${CONNECTOR_KEY}:src_b`;
      await pool.query("UPDATE records SET connector_id = $1 WHERE connector_instance_id = $2", [
        legacyB,
        "cin_resume_b",
      ]);
      await pool.query("UPDATE record_changes SET connector_id = $1 WHERE connector_instance_id = $2", [
        legacyB,
        "cin_resume_b",
      ]);
      await pool.query(
        "UPDATE device_source_instances SET connector_instance_id = NULL WHERE source_instance_id = $1",
        ["src_b"]
      );

      await bootstrapPostgresSchema();

      const remaining = await pool.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM records WHERE connector_id <> $1",
        [CONNECTOR_KEY]
      );
      assert.equal(remaining.rows[0]?.n, "0", "the resumed boot must finish the rows the crash left behind");

      const total = await pool.query<{ n: string }>("SELECT count(*)::text AS n FROM record_changes");
      assert.equal(total.rows[0]?.n, "15", "resume must not duplicate or drop retained change history");

      const receipt = await readPostgresLocalDeviceCanonicalizationReceipt();
      assert.equal(receipt?.status, "complete", "a resumed migration that converges must complete");
      assert.equal(receipt?.cursor, "src_c", "the cursor must advance to the last committed source row");
    });
  });

  test("a resumed boot re-processes only rows after the cursor", async () => {
    await withTempDb(POSTGRES_URL, async (url) => {
      await initPostgresStorage({ backend: "postgres", databaseUrl: url });
      const pool = getPostgresPool();
      for (const suffix of ["a", "b"]) {
        // biome-ignore lint/performance/noAwaitInLoops: Fixture seeding must be sequential — the rows share a device_exporters parent and a deterministic source-instance order the cursor assertions depend on.
        await seedStaleLocalDeviceIdentity(pool, {
          instanceId: `cin_cursor_${suffix}`,
          recordCount: 20,
          sourceInstanceId: `src_${suffix}`,
        });
      }
      await bootstrapPostgresSchema();

      // Rewind the receipt but leave the cursor at src_a. Rows for src_a are
      // already canonical; a correct resume must not touch them again.
      await pool.query(
        `UPDATE storage_migration_ledger
            SET status = 'running', cursor = 'src_a', completed_at = NULL
          WHERE migration_id = 'local_device_connector_canonicalization_v1'`
      );

      const before = await updateCounts(pool, AUTHORITATIVE_TABLES);
      await bootstrapPostgresSchema();
      const after = await updateCounts(pool, AUTHORITATIVE_TABLES);

      for (const table of AUTHORITATIVE_TABLES) {
        assert.equal(
          delta(before, after, table),
          0,
          `resume from a cursor must not re-rewrite already-canonical rows in ${table}`
        );
      }
    });
  });

  test("an ambiguous binding fails closed: rollback, blocked receipt, no completion", async () => {
    await withTempDb(POSTGRES_URL, async (url) => {
      await initPostgresStorage({ backend: "postgres", databaseUrl: url });
      const pool = getPostgresPool();
      await seedStaleLocalDeviceIdentity(pool, {
        instanceId: "cin_ambig_a",
        recordCount: 5,
        sourceInstanceId: "src_a",
      });
      // A second, DIFFERENT connector instance also holding rows under the
      // same legacy connector id. `resolveLocalDeviceMigrationIdentity`
      // cannot decide which is the identity, so it must refuse.
      await pool.query(
        `INSERT INTO connector_instances(
           connector_instance_id, owner_subject_id, connector_id, display_name, status,
           source_kind, source_binding_key, source_binding_json, created_at, updated_at)
         VALUES ('cin_ambig_b', $1, $2, 'Codex', 'active', 'local_device', 'seed_ambig_b', '{}'::jsonb, $3, $3)`,
        [OWNER, CONNECTOR_KEY, "2026-01-01T00:00:00.000Z"]
      );
      await pool.query(
        `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json,
                             emitted_at, version, primary_key_text)
         VALUES ($1, 'cin_ambig_b', 'messages', 'rk_x', '{}'::jsonb, '2026-01-01T00:00:00.000Z', 1, 'rk_x')`,
        [LEGACY_CONNECTOR_ID]
      );

      await assert.rejects(
        () => bootstrapPostgresSchema(),
        RE_AMBIGUOUS_BINDING,
        "an ambiguous binding must fail closed, not pick a winner"
      );

      const receipt = await readPostgresLocalDeviceCanonicalizationReceipt();
      assert.equal(receipt?.status, "blocked", "a fail-closed stop must be recorded as blocked");
      assert.notEqual(receipt?.status, "complete", "a blocked migration must never be skippable by a later boot");
      assert.match(
        receipt?.lastError ?? "",
        RE_AMBIGUOUS,
        "the blocking reason must survive on the receipt for operator reconciliation"
      );

      const untouched = await pool.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM records WHERE connector_id = $1",
        [LEGACY_CONNECTOR_ID]
      );
      assert.equal(untouched.rows[0]?.n, "6", "the failed batch must roll back every row it touched");
    });
  });

  test("a stale running receipt from a hard crash is re-claimed, never treated as complete", async () => {
    // The failure mode with no rollback path: the process dies (OOM, SIGKILL,
    // node crash) between a batch commit and the next, so neither
    // `blockPostgresMigration` nor `completePostgresMigration` ever runs and
    // the ledger is left `running`. That row must be re-claimable and must
    // NOT short-circuit the data phase — a `running` row that a later boot
    // read as "someone else has this" would strand the migration forever.
    await withTempDb(POSTGRES_URL, async (url) => {
      await initPostgresStorage({ backend: "postgres", databaseUrl: url });
      const pool = getPostgresPool();
      await seedStaleLocalDeviceIdentity(pool, {
        instanceId: "cin_stale_running",
        recordCount: 6,
        sourceInstanceId: "src_a",
      });
      // A live-looking claim from a process that no longer exists: status
      // running, cursor unset, lease still in the future. Inserted rather
      // than updated because the seed helper clears the ledger row (see
      // `resetCanonicalizationReceipt`), so an UPDATE here would match
      // nothing and the test would silently assert the wrong thing.
      await pool.query(
        `INSERT INTO storage_migration_ledger(
           migration_id, status, cursor, lease_owner, lease_expires_at, attempt_count, changed_rows, started_at, updated_at)
         VALUES ('local_device_connector_canonicalization_v1', 'running', NULL, 'ghost@dead-process',
                 '2099-01-01T00:00:00.000Z', 1, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      );

      await bootstrapPostgresSchema();

      const rows = await pool.query<{ connector_id: string; n: string }>(
        "SELECT connector_id, count(*)::text AS n FROM records GROUP BY connector_id"
      );
      assert.deepEqual(
        rows.rows.map((row) => row.connector_id),
        [CONNECTOR_KEY],
        "a stale running claim must not stop the next boot from finishing the migration"
      );

      const receipt = await readPostgresLocalDeviceCanonicalizationReceipt();
      assert.equal(receipt?.status, "complete", "the re-claimed run must converge to a complete receipt");
      assert.ok(
        (receipt?.attemptCount ?? 0) >= 2,
        "re-claiming a stale running row must count as a new attempt, not silently reuse the dead one"
      );
    });
  });

  test("a blocked receipt is re-attempted and converges once the collision is reconciled", async () => {
    await withTempDb(POSTGRES_URL, async (url) => {
      await initPostgresStorage({ backend: "postgres", databaseUrl: url });
      const pool = getPostgresPool();
      await seedStaleLocalDeviceIdentity(pool, {
        instanceId: "cin_unblock_a",
        recordCount: 5,
        sourceInstanceId: "src_a",
      });
      await pool.query(
        `INSERT INTO connector_instances(
           connector_instance_id, owner_subject_id, connector_id, display_name, status,
           source_kind, source_binding_key, source_binding_json, created_at, updated_at)
         VALUES ('cin_unblock_b', $1, $2, 'Codex', 'active', 'local_device', 'seed_unblock_b', '{}'::jsonb, $3, $3)`,
        [OWNER, CONNECTOR_KEY, "2026-01-01T00:00:00.000Z"]
      );
      await pool.query(
        `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json,
                             emitted_at, version, primary_key_text)
         VALUES ($1, 'cin_unblock_b', 'messages', 'rk_x', '{}'::jsonb, '2026-01-01T00:00:00.000Z', 1, 'rk_x')`,
        [LEGACY_CONNECTOR_ID]
      );
      await assert.rejects(() => bootstrapPostgresSchema());
      assert.equal((await readPostgresLocalDeviceCanonicalizationReceipt())?.status, "blocked");

      // Operator reconciliation: remove the ambiguous second claimant.
      await pool.query(`DELETE FROM records WHERE connector_instance_id = 'cin_unblock_b'`);
      await bootstrapPostgresSchema();

      const receipt = await readPostgresLocalDeviceCanonicalizationReceipt();
      assert.equal(receipt?.status, "complete", "a reconciled collision must let the next boot converge");
      assert.ok(
        (receipt?.attemptCount ?? 0) >= 2,
        "the re-attempt must be visible on the receipt rather than erasing the earlier failure"
      );
    });
  });

  test("large-table query shape: the converged boot plans no scan of the projection tables", async () => {
    await withTempDb(POSTGRES_URL, async (url) => {
      await initPostgresStorage({ backend: "postgres", databaseUrl: url });
      const pool = getPostgresPool();
      // Large enough that the planner has real statistics and an index scan
      // over this instance is measurably distinct from a no-op. The incident
      // shape was ~2.5M rows for one instance; this keeps the same access
      // path at a size a test suite can afford.
      await seedStaleLocalDeviceIdentity(pool, {
        instanceId: "cin_shape",
        recordCount: 20_000,
        sourceInstanceId: "src_a",
      });
      await pool.query("ANALYZE");
      await bootstrapPostgresSchema();
      await pool.query("ANALYZE");

      const watched = [...AUTHORITATIVE_TABLES, ...PROJECTION_TABLES, "device_source_instances"];
      const before = await updateCounts(pool, watched);
      const scansBefore = await pool.query<{ idx_scan: string; relname: string; seq_scan: string }>(
        `SELECT relname, seq_scan::text, idx_scan::text FROM pg_stat_user_tables
          WHERE schemaname = current_schema() AND relname = ANY($1)`,
        [watched]
      );
      await bootstrapPostgresSchema();
      const after = await updateCounts(pool, watched);
      await pool.query("SELECT pg_stat_force_next_flush()");
      const scansAfter = await pool.query<{ idx_scan: string; relname: string; seq_scan: string }>(
        `SELECT relname, seq_scan::text, idx_scan::text FROM pg_stat_user_tables
          WHERE schemaname = current_schema() AND relname = ANY($1)`,
        [watched]
      );

      for (const table of watched) {
        assert.equal(delta(before, after, table), 0, `converged restart must not update ${table}`);
      }

      const scanBefore = new Map(
        scansBefore.rows.map((row) => [row.relname, Number(row.seq_scan) + Number(row.idx_scan)])
      );
      const scanAfter = new Map(
        scansAfter.rows.map((row) => [row.relname, Number(row.seq_scan) + Number(row.idx_scan)])
      );
      for (const table of [...AUTHORITATIVE_TABLES, ...PROJECTION_TABLES]) {
        assert.equal(
          (scanAfter.get(table) ?? 0) - (scanBefore.get(table) ?? 0),
          0,
          `converged restart must not SCAN ${table} at all; zero rows updated alone would not prove the scan was skipped`
        );
      }

      // The statement the incident observed running for ~63s against a
      // 110 GB database. Its plan is asserted, not just its absence: an
      // index scan filtering on connector_id is exactly the shape that
      // walks millions of entries for a zero-row result, which is why the
      // migration no longer issues it against these tables.
      const plan = await pool.query<{ "QUERY PLAN": string }>(
        `EXPLAIN UPDATE lexical_search_index SET connector_id = $1
          WHERE connector_id = $2 AND connector_instance_id = $3`,
        [CONNECTOR_KEY, LEGACY_CONNECTOR_ID, "cin_shape"]
      );
      const planText = plan.rows.map((row) => row["QUERY PLAN"]).join("\n");
      assert.match(
        planText,
        RE_INSTANCE_LEADING_PLAN,
        "the incident statement's plan is instance-leading with connector_id as a residual filter; this documents the shape the boot no longer runs"
      );
    });
  });

  test("the inlined dirty mark stays equivalent to the store's canonical statement", async () => {
    // The migration inlines `markSearchIndexDirtyPostgres`'s statement to keep
    // `postgres-storage.ts` a leaf module (the store imports it, not the
    // other way round). This asserts the two produce identical rows,
    // including the `revision` increment the reconcile clear CAS's on — a
    // drift there would silently strand the scope as permanently dirty.
    const { markSearchIndexDirtyPostgres } = await import("../server/stores/search-index-dirty-store.ts");
    await withTempDb(POSTGRES_URL, async (url) => {
      await initPostgresStorage({ backend: "postgres", databaseUrl: url });
      const pool = getPostgresPool();
      await seedStaleLocalDeviceIdentity(pool, {
        instanceId: "cin_equiv",
        recordCount: 3,
        sourceInstanceId: "src_a",
      });
      await bootstrapPostgresSchema();

      const migrationMark = await pool.query<{ dirty: number; revision: string }>(
        `SELECT dirty, revision::text FROM search_index_dirty WHERE connector_instance_id = $1 AND stream = 'messages'`,
        ["cin_equiv"]
      );
      assert.equal(Number(migrationMark.rows[0]?.dirty), 1);
      assert.equal(migrationMark.rows[0]?.revision, "1", "the migration's first mark must start the revision at 1");

      const client = await pool.connect();
      try {
        await markSearchIndexDirtyPostgres(
          client,
          { connectorId: CONNECTOR_KEY, connectorInstanceId: "cin_equiv", stream: "messages" },
          "2026-02-02T00:00:00.000Z"
        );
      } finally {
        client.release();
      }
      const storeMark = await pool.query<{ dirty: number; revision: string }>(
        `SELECT dirty, revision::text FROM search_index_dirty WHERE connector_instance_id = $1 AND stream = 'messages'`,
        ["cin_equiv"]
      );
      assert.equal(
        storeMark.rows[0]?.revision,
        "2",
        "the store's mark must increment the revision the migration's mark established"
      );
    });
  });
} else {
  test("Postgres boot-migration resume tests (skipped: PDPP_TEST_POSTGRES_URL unset)", { skip: true }, () => {
    // skip
  });
}
