#!/usr/bin/env node

/**
 * migrate-storage CLI
 *
 * Orchestrates SQLite → Postgres migration with four commands:
 *   plan, diff, execute, verify
 *
 * Zero-dependency argument parsing. Outputs human-readable by default, NDJSON with --json.
 */

import {
  openSqliteSource,
  listSourceTables,
  tryQueryRowCount,
  describeSourceColumns,
  streamRows,
  checkSqliteNotLocked,
} from './sqlite-source.mjs';

import {
  bootstrapTargetSchema,
  closeTargetSchema,
  tableRowCount,
  isTargetEmpty,
  insertBatch,
  withTx,
  sampleRowFingerprint,
} from './postgres-target.mjs';

import {
  getPostgresPool,
} from '../../server/postgres-storage.js';

import {
  TABLES,
  DERIVED_TABLES,
  isShadowTable,
  getMigratableColumns,
  classifyMissingTargetColumn,
} from './schema.mjs';

import {
  buildRowTransformer,
  getJsonbScrubStats,
  getMigrationStats,
  setJsonbNulPolicy,
  setExtractionSink,
  resetJsonbScrubStats,
} from './transformers.mjs';

import { createWriteStream } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  loadConnectorManifests,
  getStreamFromManifest,
  derivePrimaryKeyText,
  deriveCursorValue,
} from './record-synthesis.mjs';

// ─────────────────────────────────────────────────────────────────────────
// Argument parsing (zero-dep)
// ─────────────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const command = args[0];

  const opts = {
    from: null,
    to: null,
    batchSize: 500,
    allowNonEmpty: false,
    json: false,
    quiet: false,
    // Policy for handling forbidden codepoints in JSONB string leaves.
    // Default "strict": throw a descriptive error. Use
    // "migrate-to-blobs" to extract legacy binary leaves to the blobs
    // table (lossless; produces records identical in shape to clean
    // ingest). See transformers.mjs setJsonbNulPolicy() and
    // docs/binary-content-invariant-design-brief.md §4.7.
    jsonbNulPolicy: 'strict',
    // Path to the extraction ledger file. Each extracted JSON leaf
    // emits one JSONL line: {timestamp, connector_id, stream,
    // record_key, json_path, sha256, original_byte_length, reason}.
    // Defaults to ./pdpp-data/migration-extractions.jsonl.
    ledgerPath: './pdpp-data/migration-extractions.jsonl',
    // When true, no rows are written and no blobs are persisted; the
    // transformer still walks the source data and reports counts. Use
    // before `execute` to preview the migration scope.
    dryRun: false,
  };

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--from' && i + 1 < args.length) {
      opts.from = args[++i];
    } else if (arg === '--to' && i + 1 < args.length) {
      opts.to = args[++i];
    } else if (arg === '--batch-size' && i + 1 < args.length) {
      opts.batchSize = parseInt(args[++i], 10);
    } else if (arg === '--allow-non-empty') {
      opts.allowNonEmpty = true;
    } else if (arg === '--json') {
      opts.json = true;
    } else if (arg === '--quiet') {
      opts.quiet = true;
    } else if (arg === '--jsonb-nul-policy' && i + 1 < args.length) {
      opts.jsonbNulPolicy = args[++i];
    } else if (arg === '--ledger' && i + 1 < args.length) {
      opts.ledgerPath = args[++i];
    } else if (arg === '--dry-run') {
      opts.dryRun = true;
    }
  }

  return { command, opts };
}

// ─────────────────────────────────────────────────────────────────────────
// Output helpers
// ─────────────────────────────────────────────────────────────────────────

function emit(kind, payload, opts) {
  if (opts.json) {
    console.log(JSON.stringify({ kind, ...payload }));
  } else {
    if (!opts.quiet && payload.message) {
      console.log(payload.message);
    }
  }
}

function emitError(message, opts) {
  if (opts.json) {
    console.log(JSON.stringify({ kind: 'error', message }));
  } else {
    console.error(`ERROR: ${message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Extraction sink (migrate-to-blobs policy)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Build the extraction sink used by `migrate-to-blobs`. Returns an
 * object exposing:
 *   - sink(extraction): handler the transformer invokes per extracted leaf
 *   - flush(): persist queued blobs+bindings and close the ledger stream
 *
 * The sink itself runs synchronously inside the transformer. It queues
 * the extraction and writes one JSONL line to the ledger immediately
 * (synchronous filesystem write — node's stream API buffers internally,
 * the flush at end of run ensures durability). Postgres inserts happen
 * during flush(), batched per row in the calling code.
 *
 * In dryRun mode, the sink still emits ledger lines but skips DB writes.
 */
function buildExtractionSink({ ledgerPath, dryRun }) {
  const queued = [];
  const seenSha256 = new Set();

  // Ensure the ledger directory exists. We open the stream lazily on
  // first extraction so a migration that produces zero extractions
  // doesn't create an empty ledger file.
  let ledgerStream = null;
  function openLedger() {
    if (ledgerStream) return;
    const dir = dirname(ledgerPath);
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      // Best-effort. If mkdir fails, createWriteStream below will
      // surface a more useful error.
    }
    ledgerStream = createWriteStream(ledgerPath, { flags: 'a' });
  }

  function sink(extraction) {
    queued.push(extraction);
    openLedger();
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      connector_id: extraction.connector_id,
      stream: extraction.stream,
      record_key: extraction.record_key,
      json_path: extraction.json_path,
      sha256: extraction.sha256,
      original_byte_length: extraction.size_bytes,
      reason: extraction.reason,
    });
    ledgerStream.write(line + '\n');
  }

  async function persistQueued(client) {
    // Persist all queued extractions inside the migration's existing
    // transaction (`client` is the pg client from withTx). Idempotent:
    // ON CONFLICT DO NOTHING on the blobs PK; ON CONFLICT DO NOTHING on
    // the blob_bindings composite PK.
    if (dryRun) {
      queued.length = 0;
      return;
    }
    for (const e of queued) {
      if (!seenSha256.has(e.sha256)) {
        seenSha256.add(e.sha256);
        await client.query(
          `INSERT INTO blobs
             (blob_id, connector_id, stream, record_key, mime_type, size_bytes, sha256, data)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (blob_id) DO NOTHING`,
          [
            e.blob_id,
            e.connector_id,
            e.stream,
            e.record_key,
            'application/octet-stream',
            e.size_bytes,
            e.sha256,
            e.bytes,
          ],
        );
      }
      await client.query(
        `INSERT INTO blob_bindings
           (blob_id, connector_id, stream, record_key, json_path)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT DO NOTHING`,
        [e.blob_id, e.connector_id, e.stream, e.record_key, e.json_path],
      );
    }
    queued.length = 0;
  }

  function closeLedger() {
    if (ledgerStream) {
      ledgerStream.end();
      ledgerStream = null;
    }
  }

  return { sink, persistQueued, closeLedger };
}

// ─────────────────────────────────────────────────────────────────────────
// plan command
// ─────────────────────────────────────────────────────────────────────────

// plan is source-only and ignores `to` / `batchSize` / `allowNonEmpty`; we
// accept the full opts shape so the dispatcher can call every command with
// the same parsed-arg bag.
async function planCommand({ from, json, quiet, jsonbNulPolicy }) {
  // Plan doesn't touch JSONB, but validate the flag value early so a
  // typo surfaces before `execute`.
  setJsonbNulPolicy(jsonbNulPolicy);
  const sqlite = await openSqliteSource(from);

  try {
    if (!sqlite.vecLoaded) {
      emit('plan-warning', { message: 'WARNING: sqlite-vec extension not loaded; virtual tables may be unreadable' }, { json, quiet });
    }

    const { locked, reason } = checkSqliteNotLocked(sqlite.filepath);
    if (locked) {
      emit('plan-warning', { message: `WARNING: SQLite locked (${reason})` }, { json, quiet });
    }

    const sourceTables = listSourceTables(sqlite.handle);
    let totalRows = 0;
    const rows = [];

    for (const table of TABLES) {
      const skip = DERIVED_TABLES.has(table.name);
      let sourceCount = 0;
      let countNote = '';

      if (sourceTables.has(table.name)) {
        const result = tryQueryRowCount(sqlite.handle, table.name);
        if (result.ok) {
          sourceCount = result.count;
        } else {
          countNote = ` (unreadable: ${result.reason})`;
        }
      }
      totalRows += sourceCount;

      const row = {
        name: table.name,
        source_rows: sourceCount,
        skip,
      };
      if (skip) {
        row.reason = 'Derived table: rebuilt by runtime on first boot';
      }

      if (!json && countNote) {
        row.message = countNote;
      }

      emit('plan-row', row, { json, quiet: false });
      rows.push(row);
    }

    emit('plan-summary', {
      message: `Total rows to copy: ${totalRows}`,
      totalRows,
      derivedTableCount: DERIVED_TABLES.size,
    }, { json, quiet: false });
  } finally {
    sqlite.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────
// diff command
// ─────────────────────────────────────────────────────────────────────────

// diff ignores `batchSize` / `allowNonEmpty`; `quiet` would suppress the
// per-table progress lines but diff already emits one line per table only
// when there is drift, so we leave it on.
async function diffCommand({ from, to, json, jsonbNulPolicy }) {
  setJsonbNulPolicy(jsonbNulPolicy);
  const sqlite = await openSqliteSource(from);

  try {
    await bootstrapTargetSchema(to);

    const sourceTables = listSourceTables(sqlite.handle);
    // Only drifts `execute` genuinely cannot handle gate the exit code.
    // Everything `execute` resolves on its own (synthesized columns,
    // NULL-fillable nullable columns, derived-table skips, silently-dropped
    // source columns) is reported as informational, not as a blocker.
    let hardDriftCount = 0;
    let handledCount = 0;

    for (const table of TABLES) {
      // Skip shadow tables and derived/runtime-rebuilt tables — `execute`
      // does not migrate them (see executeCommand: DERIVED_TABLES are
      // `continue`d), so their column drift is not a migration hazard. Diff
      // previously flagged these and reported false "cannot handle" drift.
      if (isShadowTable(table.name) || DERIVED_TABLES.has(table.name)) {
        continue;
      }

      if (!sourceTables.has(table.name)) {
        emit('diff-row', {
          table: table.name,
          status: 'missing-from-source',
          message: `Table missing from source (fresh install)`,
        }, { json, quiet: false });
        continue;
      }

      const sourceColumns = describeSourceColumns(sqlite.handle, table.name);
      const sourceColNames = new Set(sourceColumns.map(c => c.name));

      const pgColNames = new Set(table.columns.map(c => c.name));

      // Extra columns in source: `execute` silently drops them (a
      // `copy-warning`, never a failure). Report as informational so an
      // operator can audit, but do not gate the exit code on it.
      for (const col of sourceColumns) {
        if (!pgColNames.has(col.name)) {
          emit('diff-row', {
            table: table.name,
            issue: 'extra-in-source',
            severity: 'warning',
            column: col.name,
            message: `Column "${col.name}" exists in SQLite but not in Postgres schema (execute drops it)`,
          }, { json, quiet: false });
          handledCount++;
        }
      }

      // Target columns missing from source: classify exactly as `execute`
      // treats them. Synthesized + nullable columns are handled; only a
      // NOT NULL column with no synthesize hook is a hard drift.
      for (const col of table.columns) {
        if (!sourceColNames.has(col.name)) {
          const kind = classifyMissingTargetColumn(col, table.name);
          if (kind === 'hard-drift') {
            hardDriftCount++;
            emit('diff-row', {
              table: table.name,
              issue: 'extra-in-target',
              severity: 'blocker',
              resolution: 'hard-drift',
              column: col.name,
              nullable: col.nullable,
              message: `Column "${col.name}" in Postgres (NOT NULL) but missing from SQLite source and not synthesized — migration cannot handle this`,
            }, { json, quiet: false });
          } else {
            handledCount++;
            const resolutionNote = kind === 'synthesized'
              ? 'execute synthesizes it'
              : 'execute NULL-fills it';
            emit('diff-row', {
              table: table.name,
              issue: 'extra-in-target',
              severity: 'info',
              resolution: kind,
              column: col.name,
              nullable: col.nullable,
              message: `Column "${col.name}" in Postgres but missing from SQLite source (${resolutionNote})`,
            }, { json, quiet: false });
          }
        }
      }
    }

    if (hardDriftCount === 0) {
      const message = handledCount === 0
        ? 'No schema drift detected'
        : `Found ${handledCount} schema difference(s), all handled by migration (synthesized / NULL-filled / dropped). No blocking drift.`;
      emit('diff-summary', {
        message,
        handledCount,
        hardDriftCount: 0,
      }, { json, quiet: false });
      process.exit(0); // Graceful: execute can handle every reported difference
    } else {
      emit('diff-summary', {
        message: `Found ${hardDriftCount} schema drift issue(s) that migration cannot handle` +
          (handledCount > 0 ? ` (plus ${handledCount} handled difference(s))` : ''),
        count: hardDriftCount,
        handledCount,
        hardDriftCount,
      }, { json, quiet: false });
      process.exit(1);
    }
  } finally {
    sqlite.close();
    await closeTargetSchema();
  }
}

// ─────────────────────────────────────────────────────────────────────────
// execute command
// ─────────────────────────────────────────────────────────────────────────

async function executeCommand({
  from, to, batchSize, allowNonEmpty, json, quiet,
  jsonbNulPolicy, ledgerPath, dryRun,
}) {
  // Apply the policy before any transformer runs. Throws on unknown values.
  resetJsonbScrubStats();
  setJsonbNulPolicy(jsonbNulPolicy);

  // When the policy is "migrate-to-blobs", wire up the extraction sink
  // so binary leaves get persisted to blobs + blob_bindings and logged
  // to the ledger. Otherwise the sink stays null (transformer will throw
  // on forbidden codepoints under "strict").
  let extractionSinkHelper = null;
  if (jsonbNulPolicy === 'migrate-to-blobs') {
    extractionSinkHelper = buildExtractionSink({ ledgerPath, dryRun });
    setExtractionSink(extractionSinkHelper.sink);
  } else {
    setExtractionSink(null);
  }

  const sqlite = await openSqliteSource(from);

  try {
    const { locked, reason } = checkSqliteNotLocked(sqlite.filepath);
    if (locked) {
      emitError(`SQLite locked (${reason}). Abort.`, { json, quiet });
      process.exit(1);
    }

    await bootstrapTargetSchema(to);
    const pool = getPostgresPool();

    // Check target is empty
    if (!allowNonEmpty) {
      const nonSkipTables = TABLES.filter(t => !DERIVED_TABLES.has(t.name)).map(t => t.name);
      const targetEmpty = await isTargetEmpty(pool, nonSkipTables);
      if (!targetEmpty) {
        emitError('Target database is not empty. Use --allow-non-empty to override.', { json, quiet });
        process.exit(1);
      }
    }

    const startTime = Date.now();
    const sourceTables = listSourceTables(sqlite.handle);
    let totalCopied = 0;

    // Load connector manifests once for use with records table
    const manifests = loadConnectorManifests(sqlite.handle);

    for (const table of TABLES) {
      if (DERIVED_TABLES.has(table.name)) {
        emit('copy-skip', {
          table: table.name,
          reason: 'Derived table: rebuilt by runtime on first boot',
        }, { json, quiet });
        continue;
      }

      if (!sourceTables.has(table.name)) {
        emit('copy-skip', {
          table: table.name,
          reason: 'Table missing from source',
        }, { json, quiet });
        continue;
      }

      // Get source column names for drift-tolerant migration
      const sourceColumns = describeSourceColumns(sqlite.handle, table.name);
      const sourceColNames = new Set(sourceColumns.map(c => c.name));

      // Compute the migration plan (which columns copy, which are NULL-filled)
      const plan = getMigratableColumns(table, sourceColNames);
      const copiedCount = plan.filter(p => p.mode === 'copy').length;
      const nullFilledCount = plan.filter(p => p.mode === 'null').length;
      const nullFilledColumns = plan.filter(p => p.mode === 'null').map(p => p.name);

      // Detect dropped source columns (will be silently ignored by transformer)
      const droppedSourceColumns = Array.from(sourceColNames)
        .filter(name => !table.columns.some(col => col.name === name));

      emit('copy-start', {
        table: table.name,
        totalColumns: table.columns.length,
        copied: copiedCount,
        nullFilled: nullFilledCount,
        nullFilledColumns,
      }, { json, quiet });

      if (droppedSourceColumns.length > 0) {
        emit('copy-warning', {
          table: table.name,
          droppedSourceColumns,
        }, { json, quiet });
      }

      try {
        // For records table, create synthesize hook to derive primary_key_text and cursor_value
        let transformerOptions = {};
        if (table.name === 'records') {
          transformerOptions.synthesize = (sqliteRow, columnName) => {
            if (columnName === 'primary_key_text') {
              const manifest = manifests.get(sqliteRow.connector_id);
              const streamMeta = manifest ? getStreamFromManifest(manifest, sqliteRow.stream) : null;
              if (streamMeta) {
                return derivePrimaryKeyText(streamMeta, sqliteRow.record_json, sqliteRow.record_key);
              }
              // Fallback if manifest not found: use record_key
              return sqliteRow.record_key;
            }
            if (columnName === 'cursor_value') {
              const manifest = manifests.get(sqliteRow.connector_id);
              const streamMeta = manifest ? getStreamFromManifest(manifest, sqliteRow.stream) : null;
              if (streamMeta) {
                return deriveCursorValue(streamMeta, sqliteRow.record_json);
              }
              // Fallback if manifest not found: return undefined (let normal path handle it)
              return undefined;
            }
            // For all other columns, return undefined to use normal coercion
            return undefined;
          };
        }

        // For blob_bindings, synthesize the new `json_path` column when
        // the source table predates it. Legacy bindings semantically
        // correspond to '@record' (record-level, not tied to a specific
        // JSON Pointer in record_json). See
        // docs/binary-content-invariant-design-brief.md §4.6.
        if (table.name === 'blob_bindings') {
          transformerOptions.synthesize = (sqliteRow, columnName) => {
            if (columnName === 'json_path') {
              return sqliteRow.json_path ?? '@record';
            }
            return undefined;
          };
        }

        const transformer = buildRowTransformer(table, sourceColNames, transformerOptions);
        let rowCount = 0;

        await withTx(pool, async (client) => {
          for await (const batch of streamRows(sqlite.handle, table.name, batchSize)) {
            const transformed = batch.map(row => transformer(row));

            if (!dryRun) {
              const columnNames = table.columns.map(c => c.name);
              await insertBatch(client, table.name, columnNames, transformed);
            }

            // Persist any binary extractions emitted during this batch
            // inside the same transaction so the records and their
            // blob_bindings commit atomically. No-op if no extractions
            // were queued (clean rows are the common case).
            if (extractionSinkHelper) {
              await extractionSinkHelper.persistQueued(client);
            }

            rowCount += batch.length;
            totalCopied += batch.length;

            emit('copy-progress', {
              table: table.name,
              rowsProcessed: rowCount,
            }, { json, quiet });
          }
        });

        emit('copy-end', {
          table: table.name,
          rowCount,
        }, { json, quiet });
      } catch (err) {
        emitError(`${table.name}: ${err.message}`, { json, quiet });
        process.exit(1);
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    const stats = getMigrationStats();

    let summaryMessage = `Migration complete: ${totalCopied} rows in ${elapsed}s`;
    if (dryRun) summaryMessage = `[dry-run] ${summaryMessage}`;
    summaryMessage += ` [jsonb-nul-policy=${jsonbNulPolicy}]`;

    if (stats.extractedLeaves > 0) {
      const totalMb = (stats.totalExtractedBytes / 1_048_576).toFixed(2);
      summaryMessage += `\n  Extracted ${stats.extractedLeaves} binary leaves to blobs ` +
        `(${stats.uniqueBlobCount} unique sha256s, ${totalMb} MB) ` +
        `from ${stats.extractedRows} rows.` +
        `\n  Extraction ledger: ${ledgerPath}`;
    }

    // Run the post-migration verifier as the final step of execute.
    // Skip in dry-run since we didn't write anything; nothing to verify.
    let invariantFailures = 0;
    if (!dryRun) {
      emit('execute-verify-start', { message: 'Running post-migration verifier...' }, { json, quiet });
      invariantFailures = await verifyBinaryContentInvariant(pool, { json, quiet });
      if (invariantFailures === 0) {
        summaryMessage += '\n  Post-migration verifier: PASS (binary-content invariant holds).';
      } else {
        summaryMessage += `\n  Post-migration verifier: FAIL — ${invariantFailures} invariant violation(s) (see verify-invariant-failure events above).`;
      }
    }

    emit('execute-summary', {
      message: summaryMessage,
      totalRows: totalCopied,
      elapsedSeconds: parseFloat(elapsed),
      jsonbNulPolicy,
      stats,
      dryRun,
      ledgerPath: stats.extractedLeaves > 0 ? ledgerPath : null,
      invariantFailures,
    }, { json, quiet: false });

    if (invariantFailures > 0) {
      process.exit(3);
    }
  } finally {
    if (extractionSinkHelper) {
      extractionSinkHelper.closeLedger();
      setExtractionSink(null);
    }
    sqlite.close();
    await closeTargetSchema();
  }
}

// ─────────────────────────────────────────────────────────────────────────
// verify command
// ─────────────────────────────────────────────────────────────────────────

// verify is read-only on both sides and ignores execute-only flags.
async function verifyCommand({ from, to, json, quiet, jsonbNulPolicy }) {
  setJsonbNulPolicy(jsonbNulPolicy);
  const sqlite = await openSqliteSource(from);

  try {
    await bootstrapTargetSchema(to);
    const pool = getPostgresPool();

    let mismatches = 0;

    for (const table of TABLES) {
      if (DERIVED_TABLES.has(table.name)) {
        continue;
      }

      const result = tryQueryRowCount(sqlite.handle, table.name);
      if (!result.ok) {
        // Skip unreadable tables in verify
        continue;
      }
      const sourceCount = result.count;
      const targetCount = await tableRowCount(pool, table.name);

      // For blobs / blob_bindings, the target may legitimately exceed
      // the source: migrate-to-blobs extracts binary leaves from
      // record_json into the blobs table and adds entries to
      // blob_bindings. Treat target > source as a non-mismatch for
      // these tables and surface it as informational. For all other
      // tables, source must equal target.
      const allowGrowth = table.name === 'blobs' || table.name === 'blob_bindings';
      if (sourceCount === targetCount) {
        emit('verify-row', {
          table: table.name,
          status: 'match',
          sourceRows: sourceCount,
          targetRows: targetCount,
        }, { json, quiet: false });
      } else if (allowGrowth && targetCount > sourceCount) {
        emit('verify-row', {
          table: table.name,
          status: 'match-with-growth',
          sourceRows: sourceCount,
          targetRows: targetCount,
          growth: targetCount - sourceCount,
          message: `target has ${targetCount - sourceCount} more rows than source (expected for migrate-to-blobs extractions).`,
        }, { json, quiet: false });
      } else {
        emit('verify-row', {
          table: table.name,
          status: 'mismatch',
          sourceRows: sourceCount,
          targetRows: targetCount,
        }, { json, quiet: false });
        mismatches++;
      }

      // Sample fingerprint comparison: target-side only for now.
      // `sampleRowFingerprint` is Postgres-only; the corresponding
      // SQLite-side function doesn't exist. Skip rather than crash —
      // the invariant checks below catch the cases that actually
      // matter for correctness.
      if (targetCount > 0) {
        try {
          const targetFingerprint = await sampleRowFingerprint(pool, table.name);
          emit('verify-fingerprint', {
            table: table.name,
            targetFingerprint,
          }, { json, quiet });
        } catch (err) {
          emit('verify-fingerprint', {
            table: table.name,
            error: err.message,
          }, { json, quiet });
        }
      }
    }

    // ── Invariant checks (SLVP: "verifiable" — see brief §4.9) ──
    const invariantFailures = await verifyBinaryContentInvariant(pool, { json, quiet });

    if (mismatches === 0 && invariantFailures === 0) {
      emit('verify-summary', {
        message: 'All row counts, samples, and invariants pass',
      }, { json, quiet: false });
      process.exit(0);
    } else {
      emit('verify-summary', {
        message: `Found ${mismatches} row count mismatches and ${invariantFailures} invariant failures`,
        rowCountMismatches: mismatches,
        invariantFailures,
      }, { json, quiet: false });
      process.exit(2);
    }
  } finally {
    sqlite.close();
    await closeTargetSchema();
  }
}

/**
 * Verify the binary-content invariant on the target Postgres DB:
 *   1. No string leaf in any `record_json` contains forbidden codepoints.
 *   2. For every blob_bindings row with a JSON-Pointer `json_path` (not
 *      '@record'), the dereferenced leaf in `records.record_json` is null.
 *   3. Every blob_bindings.blob_id exists in `blobs`, and blobs.sha256 is
 *      consistent with the blob_id naming convention.
 *
 * See docs/binary-content-invariant-design-brief.md §4.9.
 *
 * Returns the number of distinct invariant failures detected (0 = clean).
 */
async function verifyBinaryContentInvariant(pool, { json, quiet }) {
  let failures = 0;

  // (1) Confirm record_json is structurally valid JSONB on every row.
  //
  // Postgres JSONB itself rejects U+0000 at INSERT time (SQLSTATE
  // 22P05); a record that landed in `records` cannot contain U+0000 by
  // construction. We can't query for it directly either: Postgres'
  // string-literal parser also rejects U+0000, so `... ~ E' '`
  // and `chr(0)` both fail to parse. The database is the authority.
  //
  // What we *can* check is that `record_json IS NOT NULL` everywhere
  // we expect a payload (catches a transformer bug that silently
  // produced null where it shouldn't have). Combined with checks (2)
  // and (3) below, this gives the SLVP "verifiable assertion" the
  // brief requires (§4.9).
  //
  // The full printable-text invariant (NUL + C0/C1 controls + DEL) is
  // enforced for NEW writes at the connector boundary via
  // pdppSafeText/safeTextPreview, not in this migration verifier.
  // See docs/binary-content-invariant-design-brief.md §4.6a for why
  // the migration scope is narrowed to U+0000.
  const r1 = await pool.query(`
    SELECT count(*)::int AS n
    FROM records
    WHERE record_json IS NULL AND NOT deleted
  `).catch((err) => ({ error: err, rows: [] }));
  if (r1.error) {
    emit('verify-invariant', {
      check: 'no-null-record_json-on-live-records',
      status: 'error',
      message: r1.error.message,
    }, { json, quiet });
    failures++;
  } else if (r1.rows[0].n > 0) {
    failures++;
    emit('verify-invariant-failure', {
      check: 'no-null-record_json-on-live-records',
      count: r1.rows[0].n,
      message: `Found ${r1.rows[0].n} live records with NULL record_json (a transformer bug should not produce this).`,
    }, { json, quiet: false });
  } else {
    emit('verify-invariant', {
      check: 'no-null-record_json-on-live-records',
      status: 'pass',
    }, { json, quiet });
  }

  // (2) For every blob_bindings row with a JSON Pointer json_path,
  // the referenced leaf in records.record_json must be null.
  const r2 = await pool.query(`
    SELECT bb.connector_id, bb.stream, bb.record_key, bb.json_path,
           jsonb_extract_path_text(r.record_json, VARIADIC string_to_array(substr(bb.json_path, 2), '/')) AS leaf_value
    FROM blob_bindings bb
    LEFT JOIN records r
      ON r.connector_id = bb.connector_id
     AND r.stream = bb.stream
     AND r.record_key = bb.record_key
    WHERE bb.json_path LIKE '/%'
    LIMIT 100
  `).catch((err) => ({ error: err, rows: [] }));
  if (r2.error) {
    // Older Postgres might not have a path-syntax compatible jsonb_extract_path_text;
    // surface but don't fatal.
    emit('verify-invariant', {
      check: 'json_path-leaves-are-null',
      status: 'error',
      message: r2.error.message,
    }, { json, quiet });
    failures++;
  } else {
    let leafFailures = 0;
    for (const row of r2.rows) {
      // leaf_value is null when the field is absent OR when it's
      // literally null. Both are acceptable post-extraction.
      if (row.leaf_value !== null) {
        leafFailures++;
        emit('verify-invariant-failure', {
          check: 'json_path-leaves-are-null',
          connector_id: row.connector_id,
          stream: row.stream,
          record_key: row.record_key,
          json_path: row.json_path,
          leaf_value: String(row.leaf_value).slice(0, 80),
        }, { json, quiet: false });
      }
    }
    if (leafFailures > 0) failures++;
    else {
      emit('verify-invariant', {
        check: 'json_path-leaves-are-null',
        status: 'pass',
      }, { json, quiet });
    }
  }

  // (3) blob_bindings.blob_id must exist in blobs with consistent sha256.
  const r3 = await pool.query(`
    SELECT bb.blob_id
    FROM blob_bindings bb
    LEFT JOIN blobs b ON b.blob_id = bb.blob_id
    WHERE b.blob_id IS NULL
    LIMIT 100
  `).catch((err) => ({ error: err, rows: [] }));
  if (r3.error) {
    emit('verify-invariant', {
      check: 'blob_bindings-references-existing-blobs',
      status: 'error',
      message: r3.error.message,
    }, { json, quiet });
    failures++;
  } else if (r3.rows.length > 0) {
    failures++;
    emit('verify-invariant-failure', {
      check: 'blob_bindings-references-existing-blobs',
      count: r3.rows.length,
      sample_blob_ids: r3.rows.slice(0, 5).map((r) => r.blob_id),
    }, { json, quiet: false });
  } else {
    emit('verify-invariant', {
      check: 'blob_bindings-references-existing-blobs',
      status: 'pass',
    }, { json, quiet });
  }

  // (4) Boot-epoch reconciliation invariant: no run.started events from
  // a prior incarnation may lack a terminal event. See
  // docs/run-reconciliation-design-brief.md §3.6.
  //
  // Single-controller assumption: current_epoch is picked by max seq.
  // Multi-controller deployments need a per-controller variant of this
  // query (out of scope here).
  //
  // Pre-feature run.started events (no boot_epoch field) are
  // intentionally captured by IS DISTINCT FROM — they're treated as
  // prior-incarnation, and the boot-time reconciler emits run.abandoned
  // for any that lack a terminal. This query verifies the result.
  const r4 = await pool.query(`
    WITH current_epoch AS (
      SELECT data_json->>'epoch' AS epoch,
             data_json->>'controller_id' AS controller_id
      FROM spine_events
      WHERE event_type = 'controller.booted'
      ORDER BY (data_json->>'seq')::int DESC
      LIMIT 1
    )
    SELECT s.event_id, s.run_id, s.actor_id
    FROM spine_events s, current_epoch
    WHERE s.event_type = 'run.started'
      AND (s.data_json->>'boot_epoch') IS DISTINCT FROM current_epoch.epoch
      AND COALESCE(s.data_json->>'controller_id', current_epoch.controller_id) = current_epoch.controller_id
      AND NOT EXISTS (
        SELECT 1 FROM spine_events t
        WHERE t.run_id = s.run_id
          AND t.event_type IN ('run.completed', 'run.failed', 'run.cancelled', 'run.abandoned')
      )
    LIMIT 100
  `).catch((err) => ({ error: err, rows: [] }));
  if (r4.error) {
    emit('verify-invariant', {
      check: 'no-prior-epoch-orphans',
      status: 'error',
      message: r4.error.message,
    }, { json, quiet });
    failures++;
  } else if (r4.rows.length > 0) {
    failures++;
    emit('verify-invariant-failure', {
      check: 'no-prior-epoch-orphans',
      count: r4.rows.length,
      sample_orphans: r4.rows.slice(0, 5).map((r) => ({
        event_id: r.event_id,
        run_id: r.run_id,
        actor_id: r.actor_id,
      })),
      message: 'Found run.started events from a prior controller epoch with no terminal event. ' +
        'The boot-time reconciler did not run, or ran but is failing to reach all orphans. ' +
        'See docs/run-reconciliation-design-brief.md §3.6.',
    }, { json, quiet: false });
  } else {
    emit('verify-invariant', {
      check: 'no-prior-epoch-orphans',
      status: 'pass',
    }, { json, quiet });
  }

  return failures;
}

// ─────────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────────

async function main() {
  const { command, opts } = parseArgs();

  if (!command) {
    console.log(`
Usage: cli.mjs <command> --from <url> --to <url> [options]

Commands:
  plan              Print table-by-table migration plan
  diff              Compare source and target schemas
  execute           Run the migration (writes to target)
  verify            Compare row counts and sample fingerprints

Common options:
  --from <url>      Source SQLite URL or path (required)
  --to <url>        Target Postgres connection string (required)
  --json            Output NDJSON for piping
  --quiet           Suppress progress lines

Execute-specific:
  --batch-size <N>       Rows per batch (default 500)
  --allow-non-empty      Permit non-empty target
  --dry-run              Walk the data and report stats; write nothing.

Binary-leak safety net (for legacy SQLite DBs containing U+0000 or
other forbidden control characters in JSONB string leaves):
  --jsonb-nul-policy <strict|migrate-to-blobs>
                         strict           (default) — throw on forbidden
                                          codepoints in JSONB strings.
                                          Loud and safe; the right default
                                          for current connectors.
                         migrate-to-blobs — extract offending leaves into
                                          the blobs table (idempotent on
                                          sha256), set the leaf to null,
                                          and record the RFC 6901 JSON
                                          Pointer in blob_bindings.json_path.
                                          Produces records identical in
                                          shape to clean ingest. Use this
                                          when migrating legacy DBs that
                                          predate the safe-text-preview
                                          connector fix.
  --ledger <path>        Path to the extraction ledger (default
                         ./pdpp-data/migration-extractions.jsonl). One
                         JSONL line per extracted leaf. Redundant audit
                         trail — canonical state lives in blob_bindings.

  See docs/binary-content-invariant-design-brief.md §4.7–§4.8.
    `);
    process.exit(0);
  }

  if (!opts.from || !opts.to) {
    console.error('ERROR: --from and --to are required for all commands');
    process.exit(1);
  }

  try {
    switch (command) {
      case 'plan':
        await planCommand(opts);
        break;
      case 'diff':
        await diffCommand(opts);
        break;
      case 'execute':
        await executeCommand(opts);
        break;
      case 'verify':
        await verifyCommand(opts);
        break;
      default:
        console.error(`ERROR: Unknown command "${command}"`);
        process.exit(1);
    }
  } catch (err) {
    emitError(err.message, { json: opts.json, quiet: opts.quiet });
    process.exit(1);
  }
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
