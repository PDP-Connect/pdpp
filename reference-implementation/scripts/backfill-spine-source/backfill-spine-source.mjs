#!/usr/bin/env node

/**
 * backfill-spine-source
 *
 * Owner/operator-only maintenance tool that backfills the denormalized
 * `spine_events.source_kind` / `source_id` columns (and the
 * `data_json.source` mirror) for legacy rows where they are NULL.
 *
 * Why this is a script and not a boot migration
 * ---------------------------------------------
 * The reference previously backfilled these columns inside
 * `initPostgresStorage()` on every boot: it `SELECT`ed every `spine_events`
 * row, derived a source per row in Node, and ran per-row `UPDATE`s inside one
 * long transaction. On a large spine (~361k rows) that stalled startup for
 * ~90–120s and held a transaction whose locks blocked owner reads. It could
 * never converge because a large fraction of events are legitimately
 * sourceless (authorization/disclosure events: `token.issued`,
 * `request.submitted`, `consent.approved`, `disclosure.served`, …) whose
 * `deriveSpineSource` correctly returns null. Those rows stayed NULL and the
 * full-table scan repeated every boot for ~0 steady-state writes.
 *
 * Boot now performs only the bounded, idempotent schema DDL (add columns,
 * drop the superseded `provider_id` column, create the source index). The
 * value backfill is this explicit, bounded, resumable operator script.
 *
 * Correctness note
 * ----------------
 * `source_kind`/`source_id` are a query-acceleration cache. Source-unfiltered
 * correlation summaries derive source from canonical event payloads or runtime
 * actor fallback when the columns are NULL. The columns matter for
 * source-*filtered* correlation queries, which under-count not-yet-backfilled
 * legacy rows until this script runs.
 *
 * Authorization is by direct database access — possession of
 * `PDPP_DATABASE_URL` (or `PDPP_TEST_POSTGRES_URL`). There is no HTTP route,
 * no scheduler, no automatic background job.
 *
 * Scope: Postgres only. The SQLite path is embedded/single-process and does
 * not exhibit the reader-blocking lock problem; its boot migration likewise
 * no longer backfills, but SQLite operators rarely have a large enough spine
 * for this to matter and can re-derive at read time.
 *
 * Boundedness / resumability
 * --------------------------
 *   - Pages through rows with a keyset cursor on the unique, monotonic
 *     `event_seq`, selecting only rows whose `source_kind`/`source_id` are
 *     NULL. The cursor advances PAST rows that cannot be resolved
 *     (genuinely-sourceless events), so the run terminates instead of
 *     looping over the unresolvable tail.
 *   - Each batch runs in its own short transaction. There is no single
 *     long-running transaction over the whole table.
 *   - Re-running is safe: it resumes from wherever NULL rows remain and is a
 *     no-op once every resolvable row is filled.
 *
 * Usage:
 *   node reference-implementation/scripts/backfill-spine-source/backfill-spine-source.mjs \
 *     [--batch-size=<positive-int, default 500>] \
 *     [--max-batches=<positive-int>] \
 *     [--apply]
 *
 * Env:
 *   PDPP_DATABASE_URL or PDPP_TEST_POSTGRES_URL    required
 *
 * Default is dry-run (reports the resolvable/unresolvable split, writes
 * nothing). Use --apply to perform writes.
 *
 * Spec: openspec/changes/harden-startup-data-backfills
 */

import process from 'node:process';
import { pathToFileURL } from 'node:url';

import pg from 'pg';

import { deriveSpineSource } from '../../server/connector-instance-utils.ts';

const { Pool } = pg;

const DEFAULT_BATCH_SIZE = 500;

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > 0) {
        out[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        out[arg.slice(2)] = true;
      }
    }
  }
  return out;
}

function parsePositiveInt(value, label) {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    return { error: `--${label} must be a positive integer` };
  }
  return n;
}

function coerceObjectPayload(dataJson) {
  // Postgres JSONB columns arrive as parsed objects via node-postgres. Defend
  // against unexpected string/array/null shapes so derivation matches the
  // boot-era behavior exactly.
  if (typeof dataJson === 'string') {
    try {
      const parsed = JSON.parse(dataJson);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return dataJson && typeof dataJson === 'object' && !Array.isArray(dataJson) ? dataJson : {};
}

/**
 * Resolve one batch of NULL-source rows after `afterSeq`. Returns the rows
 * with their derived source (or null) and the new cursor. Pure read; no
 * writes.
 */
async function fetchBatch(pool, afterSeq, batchSize) {
  const result = await pool.query(
    `SELECT event_id, event_seq, actor_type, actor_id, data_json, source_kind, source_id
       FROM spine_events
      WHERE event_seq > $1
        AND (source_kind IS NULL OR source_id IS NULL)
      ORDER BY event_seq
      LIMIT $2`,
    [afterSeq, batchSize],
  );
  return result.rows;
}

/**
 * Apply derived sources for one batch in a single short transaction. Only
 * rows whose source resolves and whose stored values actually differ are
 * updated. Returns the number of rows written.
 */
async function applyBatch(pool, resolvedRows) {
  if (!resolvedRows.length) return 0;
  const client = await pool.connect();
  let written = 0;
  try {
    await client.query('BEGIN');
    for (const { row, source, payload } of resolvedRows) {
      const dataJson = { ...payload, source };
      await client.query(
        `UPDATE spine_events
            SET source_kind = $1, source_id = $2, data_json = $3::jsonb
          WHERE event_id = $4`,
        [source.kind, source.id, JSON.stringify(dataJson), row.event_id],
      );
      written += 1;
    }
    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    throw err;
  } finally {
    client.release();
  }
  return written;
}

export async function backfillSpineSource({ pool, apply, batchSize, maxBatches }) {
  let afterSeq = 0;
  let scanned = 0;
  let resolved = 0;
  let unresolvable = 0;
  let written = 0;
  let batches = 0;

  for (;;) {
    if (maxBatches && batches >= maxBatches) break;
    const rows = await fetchBatch(pool, afterSeq, batchSize);
    if (!rows.length) break;
    batches += 1;

    const toApply = [];
    for (const row of rows) {
      scanned += 1;
      afterSeq = row.event_seq; // advance cursor past every scanned row
      const payload = coerceObjectPayload(row.data_json);
      const source = deriveSpineSource(payload, row);
      if (!source) {
        unresolvable += 1;
        continue;
      }
      // Already-correct rows are skipped (no churn). A row reaches this script
      // only when source_kind/source_id is NULL, so any resolvable source is
      // by definition a change worth writing.
      resolved += 1;
      toApply.push({ row, source, payload });
    }

    if (apply && toApply.length) {
      written += await applyBatch(pool, toApply);
    }
  }

  return { scanned, resolved, unresolvable, written, batches, apply };
}

function printSummary(summary) {
  const mode = summary.apply ? 'APPLY' : 'DRY-RUN';
  console.log(`backfill-spine-source: ${mode}`);
  console.log(`  scanned NULL-source rows: ${summary.scanned}`);
  console.log(`  resolvable (derivable source): ${summary.resolved}`);
  console.log(`  unresolvable (genuinely sourceless, left NULL): ${summary.unresolvable}`);
  console.log(`  batches processed: ${summary.batches}`);
  if (summary.apply) {
    console.log(`  rows written: ${summary.written}`);
    console.log(
      summary.resolved === summary.written
        ? '  APPLIED: all resolvable rows backfilled.'
        : `  APPLIED: wrote ${summary.written} of ${summary.resolved} resolvable rows.`,
    );
  } else {
    console.log('  DRY-RUN: no rows written. Re-run with --apply to backfill.');
  }
}

const invokedAsScript = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

export async function runCli() {
  const args = parseArgs(process.argv.slice(2));
  const apply = !!args.apply;

  const batchSizeParsed = parsePositiveInt(args['batch-size'], 'batch-size');
  if (batchSizeParsed && typeof batchSizeParsed === 'object') {
    console.error(batchSizeParsed.error);
    process.exit(2);
  }
  const batchSize = batchSizeParsed ?? DEFAULT_BATCH_SIZE;

  const maxBatchesParsed = parsePositiveInt(args['max-batches'], 'max-batches');
  if (maxBatchesParsed && typeof maxBatchesParsed === 'object') {
    console.error(maxBatchesParsed.error);
    process.exit(2);
  }
  const maxBatches = maxBatchesParsed ?? undefined;

  const databaseUrl =
    process.env.PDPP_DATABASE_URL || process.env.PDPP_TEST_POSTGRES_URL || null;
  if (!databaseUrl) {
    console.error(
      'PDPP_DATABASE_URL (or PDPP_TEST_POSTGRES_URL) is required — authorization is by direct database access',
    );
    process.exit(2);
  }

  const pool = new Pool({ connectionString: databaseUrl });
  let exitCode = 0;
  try {
    const summary = await backfillSpineSource({ pool, apply, batchSize, maxBatches });
    printSummary(summary);
  } catch (err) {
    console.error('backfill-spine-source failed:', err && err.message ? err.message : err);
    exitCode = 1;
  } finally {
    await pool.end();
  }
  process.exit(exitCode);
}

if (invokedAsScript) {
  await runCli();
}
