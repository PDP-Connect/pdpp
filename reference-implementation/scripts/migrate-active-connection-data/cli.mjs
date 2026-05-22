#!/usr/bin/env node

/**
 * migrate-active-connection-data
 *
 * Move all useful Claude/Codex connector_instance data into the active
 * target rows, then purge obsolete sources. Owner decision is encoded in
 * plan.mjs::MIGRATION_PAIRS — this file only mechanises it.
 *
 * Commands:
 *   preview   Read-only counts per (source, target) pair plus a write/purge
 *             schedule. No backup tables, no row writes.
 *   apply     Run the full migration:
 *               1. Snapshot affected rows into backup tables prefixed
 *                  mig_<runId>_<table>. Backups live inside the same
 *                  transaction as the writes — on COMMIT they persist
 *                  alongside the migrated data; on ROLLBACK (dry-run or
 *                  failure) they vanish together with everything else.
 *               2. Copy unique (stream, record_key) rows from source to
 *                  target, re-allocating version per target stream.
 *               3. Copy connector_state / grant_connector_state /
 *                  scheduler_* / blob_bindings rows that don't exist on
 *                  target (no overwrite).
 *               4. Invalidate target's per-stream search-derived rows
 *                  for any stream we copied records into, so search
 *                  results cannot stay stale.
 *               5. Delete source rows from authoritative + source-clear-
 *                  only tables, and the source's own per-stream search-
 *                  derived rows.
 *               6. Retarget or drop device_source_instances bindings.
 *               7. Update target display_name on connector_instances and
 *                  any device_source_instances pointing at the target.
 *               8. Delete the source connector_instances row when
 *                  purgeSourceInstance is true.
 *             All steps run inside one transaction per pair. --dry-run runs
 *             the full transaction but ROLLBACKs at the end, which also
 *             drops the in-transaction backup tables.
 *   verify    Re-runs the preview after apply and checks every source row
 *             count is zero in the authoritative tables and target row
 *             counts have grown by the migrated delta. Read-only.
 *
 * Safety:
 *   - Never deletes a row unless a backup row was inserted in the same tx.
 *   - Refuses to run if any id in plan.mjs is missing from connector_instances.
 *   - Refuses to run if PDPP_STORAGE_BACKEND != 'postgres'.
 *   - Refuses to run if PDPP_DATABASE_URL is unset.
 *   - Honours --dry-run: opens tx, performs every write, then ROLLBACK.
 *   - Never references lexical_search_snapshots or semantic_search_snapshots
 *     by connector_instance_id — those tables have no such column. They
 *     are snapshot_id-keyed pagination cursors, TTL-bounded, with a
 *     plan_hash that auto-invalidates stale cursors.
 *
 * Usage:
 *   node reference-implementation/scripts/migrate-active-connection-data/cli.mjs preview
 *   node reference-implementation/scripts/migrate-active-connection-data/cli.mjs apply --dry-run
 *   node reference-implementation/scripts/migrate-active-connection-data/cli.mjs apply --confirm
 *   node reference-implementation/scripts/migrate-active-connection-data/cli.mjs verify
 */

import {
  MIGRATION_PAIRS,
  AUTHORITATIVE_INSTANCE_TABLES,
  TARGET_REBUILD_STREAM_KEYED_TABLES,
  TARGET_REBUILD_SCOPE_KEYED_TABLES,
  TARGET_REBUILD_ALL_TABLES,
  SOURCE_CLEAR_ONLY_TABLES,
  SOURCE_TOUCHED_TABLES,
  DEVICE_BINDING_TABLES,
} from './plan.mjs';

// Mirror of search-semantic.js::scopeKeyPrefixForStream. The semantic-search
// blob table is keyed by (connector_instance_id, scope_key, record_key) where
// scope_key is a JSON-encoded scope tuple whose first element is the stream
// name. The prefix `["posts",` matches every scope_key in the `posts` stream.
// `[`, `"`, `,` are not LIKE metacharacters in Postgres, so this is a safe
// literal LIKE pattern.
function scopeKeyLikePrefixForStream(stream) {
  return `${JSON.stringify([stream]).slice(0, -1)},%`;
}

function recordStorageConnectorIdForInstance(instance) {
  if (!instance) return null;
  if (instance.source_kind === 'local_device') {
    return `local-device:${encodeURIComponent(instance.connector_id)}`;
  }
  return instance.connector_id;
}

// `pg` is loaded lazily so the module is importable in environments where
// the dependency is not yet installed (e.g. CI scripts hitting parseArgs).
async function loadPgPool() {
  const pg = await import('pg');
  return pg.default?.Pool ?? pg.Pool;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const command = args[0];
  const opts = { dryRun: false, confirm: false, json: false };
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--confirm') opts.confirm = true;
    else if (a === '--json') opts.json = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return { command, opts };
}

function requireEnv() {
  const backend = process.env.PDPP_STORAGE_BACKEND;
  const url = process.env.PDPP_DATABASE_URL;
  if (backend !== 'postgres') {
    throw new Error(`PDPP_STORAGE_BACKEND must be 'postgres' (got ${backend ?? 'unset'})`);
  }
  if (!url) {
    throw new Error('PDPP_DATABASE_URL is required');
  }
  return url;
}

function makeRunId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}_${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

// ──────────────────────────────────────────────────────────────────────
// Preview — read-only
// ──────────────────────────────────────────────────────────────────────

async function previewCommand(pool, opts) {
  const summary = [];
  for (const pair of MIGRATION_PAIRS) {
    const target = pair.targetInstanceId
      ? await fetchInstance(pool, pair.targetInstanceId)
      : null;
    if (pair.targetInstanceId && !target) {
      throw new Error(`Target instance not found: ${pair.targetInstanceId} (${pair.label})`);
    }
    const sources = [];
    for (const s of pair.sources) {
      const src = await fetchInstance(pool, s.sourceInstanceId);
      if (!src) {
        throw new Error(`Source instance not found: ${s.sourceInstanceId} (${pair.label})`);
      }
      const counts = await instanceRowCounts(pool, s.sourceInstanceId);
      const targetCounts = pair.targetInstanceId
        ? await instanceRowCounts(pool, pair.targetInstanceId)
        : null;
      const uniqueRecordCount = pair.targetInstanceId && !s.skipMigration
        ? await countUniqueRecords(pool, s.sourceInstanceId, pair.targetInstanceId)
        : 0;
      sources.push({
        sourceInstanceId: s.sourceInstanceId,
        sourceConnectorId: src.connector_id,
        sourceStatus: src.status,
        sourceDisplayName: src.display_name,
        purgeSourceInstance: !!s.purgeSourceInstance,
        skipMigration: !!s.skipMigration,
        sourceCounts: counts,
        targetCounts,
        uniqueRecordsToCopy: uniqueRecordCount,
      });
    }
    summary.push({
      label: pair.label,
      targetInstanceId: pair.targetInstanceId,
      targetConnectorId: target?.connector_id ?? null,
      targetStorageConnectorId: recordStorageConnectorIdForInstance(target),
      targetCurrentDisplayName: target?.display_name ?? null,
      targetDesiredDisplayName: pair.targetDisplayName,
      sources,
    });
  }
  if (opts.json) {
    console.log(JSON.stringify({ kind: 'preview', summary }, null, 2));
  } else {
    printPreview(summary);
  }
  return summary;
}

async function fetchInstance(pool, instanceId) {
  const r = await pool.query(
    `SELECT connector_instance_id, owner_subject_id, connector_id, source_kind, display_name, status
       FROM connector_instances WHERE connector_instance_id = $1`,
    [instanceId],
  );
  return r.rows[0] || null;
}

async function instanceRowCounts(pool, instanceId) {
  const out = {};
  for (const table of SOURCE_TOUCHED_TABLES) {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS count FROM "${table}" WHERE connector_instance_id = $1`,
      [instanceId],
    );
    out[table] = r.rows[0]?.count ?? 0;
  }
  return out;
}

async function countUniqueRecords(pool, sourceId, targetId) {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS count
       FROM records src
       WHERE src.connector_instance_id = $1
         AND NOT EXISTS (
           SELECT 1 FROM records tgt
            WHERE tgt.connector_instance_id = $2
              AND tgt.stream = src.stream
              AND tgt.record_key = src.record_key
         )`,
    [sourceId, targetId],
  );
  return r.rows[0]?.count ?? 0;
}

function printPreview(summary) {
  for (const pair of summary) {
    console.log(`\n=== ${pair.label} ===`);
    console.log(`  target: ${pair.targetInstanceId ?? '(retire only)'}`);
    if (pair.targetInstanceId) {
      console.log(`    connector_id:   ${pair.targetConnectorId}`);
      if (pair.targetStorageConnectorId !== pair.targetConnectorId) {
        console.log(`    storage_id:     ${pair.targetStorageConnectorId}`);
      }
      console.log(`    display_name:   "${pair.targetCurrentDisplayName}" → "${pair.targetDesiredDisplayName}"`);
    }
    for (const s of pair.sources) {
      console.log(`  source: ${s.sourceInstanceId}`);
      console.log(`    connector_id:   ${s.sourceConnectorId}`);
      console.log(`    display_name:   "${s.sourceDisplayName}"`);
      console.log(`    status:         ${s.sourceStatus}`);
      console.log(`    purge_after:    ${s.purgeSourceInstance}`);
      console.log(`    skip_migration: ${s.skipMigration}`);
      console.log(`    unique records to copy: ${s.uniqueRecordsToCopy}`);
      console.log(`    source row counts:`);
      for (const [t, c] of Object.entries(s.sourceCounts)) {
        if (c > 0) console.log(`      ${t}: ${c}`);
      }
    }
  }
}

// ──────────────────────────────────────────────────────────────────────
// Apply
// ──────────────────────────────────────────────────────────────────────

async function applyCommand(pool, opts) {
  if (!opts.confirm && !opts.dryRun) {
    throw new Error('apply requires --confirm (or --dry-run for a tx-rollback rehearsal)');
  }
  const runId = makeRunId();
  const report = { runId, dryRun: opts.dryRun, pairs: [] };
  await previewCommand(pool, { json: false }); // validates ids exist
  console.log(`\n--- ${opts.dryRun ? 'DRY RUN' : 'APPLY'} (runId=${runId}) ---`);

  for (const pair of MIGRATION_PAIRS) {
    console.log(`\n>>> ${pair.label}`);
    const pairReport = await applyPair(pool, pair, runId, opts);
    report.pairs.push(pairReport);
  }
  console.log(`\nDone. runId=${runId} dryRun=${opts.dryRun}`);
  return report;
}

async function applyPair(pool, pair, runId, opts) {
  const client = await pool.connect();
  const pairReport = { label: pair.label, sources: [] };
  try {
    await client.query('BEGIN');

    const target = pair.targetInstanceId
      ? (await client.query(
          `SELECT connector_id, source_kind FROM connector_instances WHERE connector_instance_id = $1`,
          [pair.targetInstanceId],
        )).rows[0]
      : null;
    if (pair.targetInstanceId && !target) {
      throw new Error(`Target row vanished: ${pair.targetInstanceId}`);
    }

    for (const sourceSpec of pair.sources) {
      const sourceReport = await drainSource({
        client,
        runId,
        sourceInstanceId: sourceSpec.sourceInstanceId,
        targetInstanceId: pair.targetInstanceId,
        targetStorageConnectorId: recordStorageConnectorIdForInstance(target),
        purgeSourceInstance: !!sourceSpec.purgeSourceInstance,
        skipMigration: !!sourceSpec.skipMigration,
      });
      pairReport.sources.push(sourceReport);
    }

    if (pair.targetInstanceId && pair.targetDisplayName) {
      const r = await client.query(
        `UPDATE connector_instances
            SET display_name = $2, updated_at = (now() AT TIME ZONE 'utc')::text
          WHERE connector_instance_id = $1
            AND display_name IS DISTINCT FROM $2`,
        [pair.targetInstanceId, pair.targetDisplayName],
      );
      pairReport.targetDisplayNameUpdated = r.rowCount;

      const dr = await client.query(
        `UPDATE device_source_instances
            SET display_name = $2, updated_at = (now() AT TIME ZONE 'utc')::text
          WHERE connector_instance_id = $1
            AND (display_name IS NULL OR display_name IS DISTINCT FROM $2)`,
        [pair.targetInstanceId, pair.targetDisplayName],
      );
      pairReport.deviceSourceInstanceLabelsUpdated = dr.rowCount;
    }

    if (opts.dryRun) {
      await client.query('ROLLBACK');
      console.log('  (dry-run: ROLLBACK — backup tables created in this tx are dropped too)');
    } else {
      await client.query('COMMIT');
      console.log('  COMMIT');
    }
  } catch (err) {
    // ROLLBACK drops the backup tables created in the same transaction
    // along with every other change — the database returns to its
    // pre-pair state, which is exactly what we want on a failed apply.
    try { await client.query('ROLLBACK'); } catch {}
    pairReport.error = err.message;
    throw err;
  } finally {
    client.release();
  }
  return pairReport;
}

async function drainSource({ client, runId, sourceInstanceId, targetInstanceId, targetStorageConnectorId, purgeSourceInstance, skipMigration }) {
  const report = {
    sourceInstanceId,
    targetInstanceId,
    copied: {},
    deleted: {},
    backedUp: {},
    targetStreamsInvalidated: [],
  };
  const tableSuffix = `${runId}_${sourceInstanceId.slice(0, 16)}`;

  // 1. Backup every per-instance row keyed by this source. SOURCE_TOUCHED_TABLES
  //    is the verified allow-list — every name here has a connector_instance_id
  //    column (see plan.mjs::IGNORED_PER_INSTANCE_TABLES for the negative list).
  //    Backup tables created here are scoped to the pair's transaction:
  //    COMMIT persists them, ROLLBACK drops them.
  for (const table of SOURCE_TOUCHED_TABLES) {
    const backupName = `mig_${tableSuffix}_${table}`;
    const bk = await client.query(
      `CREATE TABLE "${backupName}" AS
         SELECT * FROM "${table}" WHERE connector_instance_id = $1`,
      [sourceInstanceId],
    );
    report.backedUp[table] = bk.rowCount ?? 0;
  }

  // Also backup the connector_instances row itself, so a purge can be reversed.
  const ciBackup = `mig_${tableSuffix}_connector_instances`;
  await client.query(
    `CREATE TABLE "${ciBackup}" AS
       SELECT * FROM connector_instances WHERE connector_instance_id = $1`,
    [sourceInstanceId],
  );
  report.backedUp.connector_instances = 1;

  // Track which target streams need search-derived rebuild.
  const targetStreamsTouched = new Set();

  if (!skipMigration && targetInstanceId) {
    // 2. records — copy unique (stream, record_key). Allocate a fresh
    //    version per (target_instance, stream) so we don't collide with
    //    target's existing version_counter.
    const streamsToTouch = await client.query(
      `SELECT DISTINCT stream FROM records WHERE connector_instance_id = $1
        UNION SELECT DISTINCT stream FROM record_changes WHERE connector_instance_id = $1
        UNION SELECT DISTINCT stream FROM connector_state WHERE connector_instance_id = $1
        UNION SELECT DISTINCT stream FROM grant_connector_state WHERE connector_instance_id = $1`,
      [sourceInstanceId],
    );
    const streams = streamsToTouch.rows.map((r) => r.stream);

    let recordsCopied = 0;
    let changesCopied = 0;
    for (const stream of streams) {
      // a) ensure target version_counter row exists for this stream.
      await client.query(
        `INSERT INTO version_counter (connector_id, connector_instance_id, stream, max_version)
         VALUES ($1, $2, $3, 0)
         ON CONFLICT (connector_instance_id, stream) DO NOTHING`,
        [targetStorageConnectorId, targetInstanceId, stream],
      );

      // b) For each unique source record (stream, record_key) not on target,
      //    insert a new record with a fresh version. We bump max_version by
      //    the number of unique rows we'll insert, then assign versions via
      //    row_number().
      const uniqueRows = await client.query(
        `SELECT src.record_key, src.record_json, src.emitted_at,
                src.deleted, src.deleted_at, src.cursor_value, src.primary_key_text
           FROM records src
          WHERE src.connector_instance_id = $1
            AND src.stream = $2
            AND NOT EXISTS (
              SELECT 1 FROM records tgt
               WHERE tgt.connector_instance_id = $3
                 AND tgt.stream = $2
                 AND tgt.record_key = src.record_key
            )
          ORDER BY src.version`,
        [sourceInstanceId, stream, targetInstanceId],
      );

      if (uniqueRows.rows.length > 0) {
        targetStreamsTouched.add(stream);
        const bump = await client.query(
          `UPDATE version_counter
              SET max_version = max_version + $3
            WHERE connector_instance_id = $1 AND stream = $2
            RETURNING max_version`,
          [targetInstanceId, stream, uniqueRows.rows.length],
        );
        const newMax = Number(bump.rows[0].max_version);
        const baseVersion = newMax - uniqueRows.rows.length;

        for (let i = 0; i < uniqueRows.rows.length; i++) {
          const r = uniqueRows.rows[i];
          const newVersion = baseVersion + i + 1;
          await client.query(
            `INSERT INTO records
               (connector_id, connector_instance_id, stream, record_key, record_json,
                emitted_at, version, deleted, deleted_at, cursor_value, primary_key_text)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11)`,
            [
              targetStorageConnectorId, targetInstanceId, stream, r.record_key,
              JSON.stringify(r.record_json),
              r.emitted_at, newVersion, r.deleted, r.deleted_at,
              r.cursor_value, r.primary_key_text,
            ],
          );
          await client.query(
            `INSERT INTO record_changes
               (connector_id, connector_instance_id, stream, record_key, version,
                record_json, emitted_at, deleted, deleted_at)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)`,
            [
              targetStorageConnectorId, targetInstanceId, stream, r.record_key, newVersion,
              JSON.stringify(r.record_json),
              r.emitted_at, r.deleted, r.deleted_at,
            ],
          );
          recordsCopied++;
          changesCopied++;
        }
      }

      // c) connector_state — only fill if target has no row for this stream.
      const csResult = await client.query(
        `INSERT INTO connector_state (connector_id, connector_instance_id, stream, state_json, updated_at)
         SELECT $4, $3, src.stream, src.state_json, src.updated_at
           FROM connector_state src
          WHERE src.connector_instance_id = $1 AND src.stream = $2
         ON CONFLICT (connector_instance_id, stream) DO NOTHING`,
        [sourceInstanceId, stream, targetInstanceId, targetStorageConnectorId],
      );
      report.copied.connector_state = (report.copied.connector_state || 0) + (csResult.rowCount || 0);

      // d) grant_connector_state — same idea, but keyed by (grant_id, instance, stream).
      const gcsResult = await client.query(
        `INSERT INTO grant_connector_state (grant_id, connector_id, connector_instance_id, stream, state_json, updated_at)
         SELECT src.grant_id, $4, $3, src.stream, src.state_json, src.updated_at
           FROM grant_connector_state src
          WHERE src.connector_instance_id = $1 AND src.stream = $2
         ON CONFLICT (grant_id, connector_instance_id, stream) DO NOTHING`,
        [sourceInstanceId, stream, targetInstanceId, targetStorageConnectorId],
      );
      report.copied.grant_connector_state = (report.copied.grant_connector_state || 0) + (gcsResult.rowCount || 0);
    }
    report.copied.records = recordsCopied;
    report.copied.record_changes = changesCopied;

    // e) blob_bindings — bind any blobs that were attached to source records
    //    that we just copied. Blob rows themselves are content-addressed by
    //    sha256 / blob_id (PK), so the bytes are NOT duplicated. The owning
    //    `blobs` row's metadata (connector_id/CII/stream/record_key) is
    //    reattributed below.
    const bbResult = await client.query(
      `INSERT INTO blob_bindings (blob_id, connector_id, connector_instance_id, stream, record_key, json_path)
       SELECT src.blob_id, $3, $2, src.stream, src.record_key, src.json_path
         FROM blob_bindings src
        WHERE src.connector_instance_id = $1
          AND EXISTS (
            SELECT 1 FROM records tgt
             WHERE tgt.connector_instance_id = $2
               AND tgt.stream = src.stream
               AND tgt.record_key = src.record_key
          )
       ON CONFLICT (blob_id, connector_instance_id, stream, record_key, json_path) DO NOTHING`,
      [sourceInstanceId, targetInstanceId, targetStorageConnectorId],
    );
    report.copied.blob_bindings = bbResult.rowCount || 0;

    // f) blobs — content-addressed by `blob_id` PK, so bytes are never
    //    duplicated. BUT the `blobs` row also carries origin metadata
    //    (connector_id, connector_instance_id, stream, record_key) which:
    //      - Is summed by `get-retained-by-connector-instance.sql` for
    //        per-(connector_id, CII) byte accounting.
    //      - Acts as one of the rows returned by `postgresListBlobBindings`
    //        (see queries/blobs/list-bindings-by-id.sql), participating in
    //        the visibility decision for GET /v1/blobs/:blob_id.
    //    After source purge, leaving the row attributed to the deleted
    //    source breaks both: bytes vanish from target retention totals,
    //    and the UNION row points at a CII that no longer exists.
    //
    //    Backup source-owned blobs metadata first, then reattribute the
    //    metadata for any blob_id we just bound to target. We pick the
    //    smallest (stream, record_key) target binding deterministically.
    //    Blob bytes are NOT moved — only the metadata pointer.
    const blobBackupName = `mig_${tableSuffix}_blobs`;
    const blobBk = await client.query(
      `CREATE TABLE "${blobBackupName}" AS
         SELECT * FROM blobs WHERE connector_instance_id = $1`,
      [sourceInstanceId],
    );
    report.backedUp.blobs = blobBk.rowCount ?? 0;

    const blobReattrResult = await client.query(
      `UPDATE blobs b
          SET connector_id = $3,
              connector_instance_id = $2,
              stream = pick.stream,
              record_key = pick.record_key
         FROM (
           SELECT DISTINCT ON (bb.blob_id) bb.blob_id, bb.stream, bb.record_key
             FROM blob_bindings bb
            WHERE bb.connector_instance_id = $2
            ORDER BY bb.blob_id, bb.stream, bb.record_key
         ) pick
        WHERE b.blob_id = pick.blob_id
          AND b.connector_instance_id = $1`,
      [sourceInstanceId, targetInstanceId, targetStorageConnectorId],
    );
    report.reattributed = report.reattributed || {};
    report.reattributed.blobs = blobReattrResult.rowCount || 0;

    // Count any source-origin blobs we did NOT reattribute (no target
    // binding picked them up). Their bytes survive — we never DELETE FROM
    // blobs anywhere in the codebase, matching production retention
    // semantics — but their metadata still points at a CII that will be
    // purged below. Surface the count so verify/preview can flag it.
    const blobStrandedResult = await client.query(
      `SELECT COUNT(*)::int AS count, COALESCE(SUM(size_bytes), 0)::bigint AS bytes
         FROM blobs
        WHERE connector_instance_id = $1`,
      [sourceInstanceId],
    );
    report.strandedSourceBlobs = {
      count: blobStrandedResult.rows[0]?.count ?? 0,
      bytes: Number(blobStrandedResult.rows[0]?.bytes ?? 0),
    };

    // f) scheduler_run_history — append-only audit, copy verbatim with
    //    instance/connector rewritten. (id is BIGSERIAL, auto-assigned.)
    const srhResult = await client.query(
      `INSERT INTO scheduler_run_history
         (connector_instance_id, connector_id, source_json, status, records_emitted,
          reported_records_emitted, checkpoint_summary_json, known_gaps_json,
          connector_error_json, run_id, trace_id, failure_reason, terminal_reason,
          started_at, completed_at, error, attempt)
       SELECT $2, $3, source_json, status, records_emitted,
              reported_records_emitted, checkpoint_summary_json, known_gaps_json,
              connector_error_json, run_id, trace_id, failure_reason, terminal_reason,
              started_at, completed_at, error, attempt
         FROM scheduler_run_history
        WHERE connector_instance_id = $1`,
      [sourceInstanceId, targetInstanceId, targetStorageConnectorId],
    );
    report.copied.scheduler_run_history = srhResult.rowCount || 0;

    // g) scheduler_last_run_times — pick the later of source vs target.
    const slrtResult = await client.query(
      `INSERT INTO scheduler_last_run_times (connector_instance_id, connector_id, last_run_time_ms, updated_at)
       SELECT $2, $3, last_run_time_ms, updated_at FROM scheduler_last_run_times WHERE connector_instance_id = $1
       ON CONFLICT (connector_instance_id) DO UPDATE
         SET last_run_time_ms = GREATEST(scheduler_last_run_times.last_run_time_ms, EXCLUDED.last_run_time_ms),
             updated_at = EXCLUDED.updated_at`,
      [sourceInstanceId, targetInstanceId, targetStorageConnectorId],
    );
    report.copied.scheduler_last_run_times = slrtResult.rowCount || 0;
  }

  // 3. Invalidate target's search-derived rows for any stream we copied
  //    records into. The runtime rebuilds these lazily
  //    (search.js::rebuildLexicalIndexForStream,
  //    search-semantic.js::rebuildSemanticIndexForStream) on next query.
  //
  //    Two different keying shapes, and we MUST use the right WHERE clause
  //    for each — semantic_search_blob is keyed by (CII, scope_key,
  //    record_key), not by stream. Issuing `AND stream = ANY(...)` against
  //    semantic_search_blob would 42703 "column does not exist".
  //
  //    NOTE: lexical_search_snapshots and semantic_search_snapshots are
  //    NOT touched here — they have no connector_instance_id column.
  //    Stale pagination cursors are handled by their plan_hash mismatch
  //    and TTL.
  if (targetInstanceId && targetStreamsTouched.size > 0) {
    const streamsArr = [...targetStreamsTouched];
    report.targetRebuildCleared = report.targetRebuildCleared || {};

    for (const table of TARGET_REBUILD_STREAM_KEYED_TABLES) {
      const r = await client.query(
        `DELETE FROM "${table}"
          WHERE connector_instance_id = $1
            AND stream = ANY($2::text[])`,
        [targetInstanceId, streamsArr],
      );
      report.targetRebuildCleared[table] = r.rowCount || 0;
    }

    // semantic_search_blob: derive scope_key LIKE prefixes from the touched
    // streams. One DELETE per table, OR'd across prefixes via ANY(array_of_likes).
    // Postgres' `scope_key LIKE ANY(ARRAY[...])` is the standard way to match
    // multiple LIKE patterns in one statement.
    if (TARGET_REBUILD_SCOPE_KEYED_TABLES.length > 0) {
      const scopePrefixes = streamsArr.map(scopeKeyLikePrefixForStream);
      for (const table of TARGET_REBUILD_SCOPE_KEYED_TABLES) {
        const r = await client.query(
          `DELETE FROM "${table}"
            WHERE connector_instance_id = $1
              AND scope_key LIKE ANY($2::text[])`,
          [targetInstanceId, scopePrefixes],
        );
        report.targetRebuildCleared[table] = r.rowCount || 0;
      }
    }

    report.targetStreamsInvalidated = streamsArr;
  }

  // 4. Delete source rows.
  //    - AUTHORITATIVE_INSTANCE_TABLES: we just copied them; safe to clear.
  //    - SOURCE_CLEAR_ONLY_TABLES: runtime/in-flight data that must not be
  //      carried over. controller_active_runs especially must be cleared,
  //      otherwise a row pointing at a purged instance would block a new
  //      run from claiming the (connector_instance_id) PK on the target.
  //    - TARGET_REBUILD_ALL_TABLES (source side): the source's own
  //      search-derived rows — both stream-keyed and scope-keyed. The
  //      bulk source-side clear here filters by connector_instance_id
  //      alone, so the keying-shape difference doesn't matter; every
  //      source-owned row is dropped. The runtime would otherwise be
  //      asked to rebuild against a missing instance.
  const sourceClearTables = [
    ...AUTHORITATIVE_INSTANCE_TABLES,
    ...SOURCE_CLEAR_ONLY_TABLES,
    ...TARGET_REBUILD_ALL_TABLES,
  ];
  for (const table of sourceClearTables) {
    const r = await client.query(
      `DELETE FROM "${table}" WHERE connector_instance_id = $1`,
      [sourceInstanceId],
    );
    report.deleted[table] = r.rowCount || 0;
  }

  // 5. device_source_instances — drop bindings tied to the source instance.
  //    These are device-local pointers; if a device still represents the
  //    active connection it already has a separate binding pointing at
  //    targetInstanceId. If not, the operator re-enrolls.
  for (const table of DEVICE_BINDING_TABLES) {
    const dsiResult = await client.query(
      `DELETE FROM "${table}" WHERE connector_instance_id = $1`,
      [sourceInstanceId],
    );
    report.deleted[table] = dsiResult.rowCount || 0;
  }

  // 6. Purge the connector_instances row if requested.
  if (purgeSourceInstance) {
    const ciResult = await client.query(
      `DELETE FROM connector_instances WHERE connector_instance_id = $1`,
      [sourceInstanceId],
    );
    report.deleted.connector_instances = ciResult.rowCount || 0;
  }

  return report;
}

// ──────────────────────────────────────────────────────────────────────
// Verify — read-only post-apply check
// ──────────────────────────────────────────────────────────────────────

async function verifyCommand(pool) {
  const findings = [];
  for (const pair of MIGRATION_PAIRS) {
    for (const s of pair.sources) {
      const counts = await instanceRowCounts(pool, s.sourceInstanceId);
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      const ciRow = await fetchInstance(pool, s.sourceInstanceId);
      findings.push({
        sourceInstanceId: s.sourceInstanceId,
        residualRowsByTable: counts,
        residualRowsTotal: total,
        connectorInstanceRowPresent: ciRow != null,
        expectedConnectorInstancePresent: !s.purgeSourceInstance,
        ok:
          total === 0 &&
          (ciRow != null) === !s.purgeSourceInstance,
      });
    }
    if (pair.targetInstanceId && pair.targetDisplayName) {
      const t = await fetchInstance(pool, pair.targetInstanceId);
      findings.push({
        targetInstanceId: pair.targetInstanceId,
        displayName: t?.display_name,
        expected: pair.targetDisplayName,
        ok: t?.display_name === pair.targetDisplayName,
      });
    }
  }
  const allOk = findings.every((f) => f.ok);
  console.log(JSON.stringify({ kind: 'verify', allOk, findings }, null, 2));
  return { allOk, findings };
}

// ──────────────────────────────────────────────────────────────────────
// Entry point
// ──────────────────────────────────────────────────────────────────────

async function main() {
  const { command, opts } = parseArgs();
  if (!command || command === '--help' || command === '-h') {
    console.log('Usage: cli.mjs <preview|apply|verify> [--dry-run] [--confirm] [--json]');
    process.exit(command ? 0 : 1);
  }
  const databaseUrl = requireEnv();
  const Pool = await loadPgPool();
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    if (command === 'preview') {
      await previewCommand(pool, opts);
    } else if (command === 'apply') {
      await applyCommand(pool, opts);
    } else if (command === 'verify') {
      await verifyCommand(pool);
    } else {
      throw new Error(`Unknown command: ${command}`);
    }
  } finally {
    await pool.end();
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(`ERROR: ${err.message}`);
    if (process.env.PDPP_MIGRATE_VERBOSE) console.error(err);
    process.exit(1);
  });
}

export { parseArgs, makeRunId, previewCommand, applyCommand, verifyCommand, drainSource, recordStorageConnectorIdForInstance };
