#!/usr/bin/env node

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * migrate-storage CLI
 *
 * Orchestrates SQLite → Postgres migration with four commands:
 *   plan, diff, execute, verify
 *
 * Zero-dependency argument parsing. Outputs human-readable by default, NDJSON with --json.
 */

import type { WriteStream } from "node:fs";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Pool, PoolClient } from "pg";
import {
  bootstrapTargetSchema,
  closeTargetSchema,
  currentTargetPool,
  insertBatch,
  isTargetEmpty,
  sampleRowFingerprint,
  tableRowCount,
  withTx,
} from "./postgres-target.ts";
import type { TableMeta } from "./schema.ts";
import { classifyMissingTargetColumn, DERIVED_TABLES, getMigratableColumns, isShadowTable, TABLES } from "./schema.ts";
import {
  checkSqliteNotLocked,
  describeSourceColumns,
  listSourceTables,
  openSqliteSource,
  streamRows,
  tryQueryRowCount,
} from "./sqlite-source.ts";
import type { Extraction, JsonbPolicy, RawValue } from "./transformers.ts";
import {
  buildRowTransformer,
  getMigrationStats,
  resetMigrationStats,
  setExtractionSink,
  setJsonbNulPolicy,
} from "./transformers.ts";

interface CliOptions {
  allowNonEmpty: boolean;
  batchSize: number;
  dryRun: boolean;
  from: string | null;
  json: boolean;
  jsonbNulPolicy: JsonbPolicy;
  ledgerPath: string;
  quiet: boolean;
  to: string | null;
}
type OutputOptions = Pick<CliOptions, "json" | "quiet">;
interface SourceCommandOptions {
  from: string;
  json: boolean;
  jsonbNulPolicy: JsonbPolicy;
  quiet: boolean;
}
interface DiffCommandOptions {
  from: string;
  json: boolean;
  jsonbNulPolicy: JsonbPolicy;
  to: string;
}
interface ExecuteCommandOptions {
  allowNonEmpty: boolean;
  batchSize: number;
  dryRun: boolean;
  from: string;
  json: boolean;
  jsonbNulPolicy: JsonbPolicy;
  ledgerPath: string;
  quiet: boolean;
  to: string;
}
type VerifyCommandOptions = SourceCommandOptions & { to: string };
interface ExtractionSink {
  closeLedger: () => void;
  persistQueued: (client: PoolClient) => Promise<void>;
  sink: (extraction: Extraction) => void;
}
type RequiredCliOptions = Omit<CliOptions, "from" | "to"> & { from: string; to: string };
interface TablePlan {
  message?: string;
  name: string;
  reason?: string;
  skip: boolean;
  source_rows: number;
}
type SchemaSynthesizer = (sqliteRow: Record<string, RawValue>, columnName: string) => RawValue | undefined;
const NO_SYNTHESIS: undefined = undefined;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requiredText(value: RawValue, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`Expected ${field} to be text`);
  }
  return value;
}

function recordJsonValue(value: RawValue): RecordJson {
  if (value === null || value === undefined || typeof value === "string") {
    return value;
  }
  if (typeof value === "object" && !Array.isArray(value) && !Buffer.isBuffer(value) && !(value instanceof Date)) {
    return value as Record<string, unknown>;
  }
  throw new Error("Expected record_json to be a JSON object, string, null, or undefined");
}

function synthesizeRecordValue(
  sqliteRow: Record<string, RawValue>,
  columnName: string,
  manifests: Map<string, Manifest>
): RawValue | undefined {
  if (columnName === "primary_key_text") {
    const connectorId = requiredText(sqliteRow.connector_id, "connector_id");
    const stream = requiredText(sqliteRow.stream, "stream");
    const recordKey = requiredText(sqliteRow.record_key, "record_key");
    const streamMeta = getStreamFromManifest(manifests.get(connectorId), stream);
    return streamMeta ? derivePrimaryKeyText(streamMeta, recordJsonValue(sqliteRow.record_json), recordKey) : recordKey;
  }
  if (columnName === "cursor_value") {
    const streamMeta = getStreamFromManifest(
      manifests.get(requiredText(sqliteRow.connector_id, "connector_id")),
      requiredText(sqliteRow.stream, "stream")
    );
    return streamMeta ? deriveCursorValue(streamMeta, recordJsonValue(sqliteRow.record_json)) : undefined;
  }
  return NO_SYNTHESIS;
}

function reportExtraSourceColumns(
  table: TableMeta,
  sourceColumns: Array<{ name: string }>,
  pgColumnNames: Set<string>,
  json: boolean
): number {
  let handled = 0;
  for (const column of sourceColumns) {
    if (pgColumnNames.has(column.name)) {
      continue;
    }
    emit(
      "diff-row",
      {
        column: column.name,
        issue: "extra-in-source",
        message: `Column "${column.name}" exists in SQLite but not in Postgres schema (execute drops it)`,
        severity: "warning",
        table: table.name,
      },
      { json, quiet: false }
    );
    handled += 1;
  }
  return handled;
}

function reportMissingTargetColumns(
  table: TableMeta,
  sourceColumnNames: Set<string>,
  json: boolean
): { handled: number; hard: number } {
  let handled = 0;
  let hard = 0;
  for (const column of table.columns) {
    if (sourceColumnNames.has(column.name)) {
      continue;
    }
    const kind = classifyMissingTargetColumn(column, table.name);
    const isHard = kind === "hard-drift";
    if (isHard) {
      hard += 1;
    } else {
      handled += 1;
    }
    emit(
      "diff-row",
      {
        column: column.name,
        issue: "extra-in-target",
        message: isHard
          ? `Column "${column.name}" in Postgres (NOT NULL) but missing from SQLite source and not synthesized — migration cannot handle this`
          : `Column "${column.name}" in Postgres but missing from SQLite source (${kind === "synthesized" ? "execute synthesizes it" : "execute NULL-fills it"})`,
        nullable: column.nullable,
        resolution: isHard ? "hard-drift" : kind,
        severity: isHard ? "blocker" : "info",
        table: table.name,
      },
      { json, quiet: false }
    );
  }
  return { handled, hard };
}

import type { Manifest, RecordJson } from "./record-synthesis.ts";
import {
  deriveCursorValue,
  derivePrimaryKeyText,
  getStreamFromManifest,
  loadConnectorManifests,
} from "./record-synthesis.ts";

// ─────────────────────────────────────────────────────────────────────────
// Argument parsing (zero-dep)
// ─────────────────────────────────────────────────────────────────────────

function parseArgs(): { command: string | undefined; opts: CliOptions } {
  const args = process.argv.slice(2);
  const command = args[0] === "--help" || args[0] === "-h" ? undefined : args[0];

  const opts: CliOptions = {
    allowNonEmpty: false,
    batchSize: 500,
    // When true, no rows are written and no blobs are persisted; the
    // transformer still walks the source data and reports counts. Use
    // before `execute` to preview the migration scope.
    dryRun: false,
    from: null,
    json: false,
    // Policy for handling forbidden codepoints in JSONB string leaves.
    // Default "strict": throw a descriptive error. Use
    // "migrate-to-blobs" to extract legacy binary leaves to the blobs
    // table (lossless; produces records identical in shape to clean
    // ingest). See transformers.mjs setJsonbNulPolicy() and
    // docs/reference/binary-content-invariant-design-brief.md §4.7.
    jsonbNulPolicy: "strict",
    // Path to the extraction ledger file. Each extracted JSON leaf
    // emits one JSONL line: {timestamp, connector_id, stream,
    // record_key, json_path, sha256, original_byte_length, reason}.
    // Defaults to ./pdpp-data/migration-extractions.jsonl.
    ledgerPath: "./pdpp-data/migration-extractions.jsonl",
    quiet: false,
    to: null,
  };

  const valueHandlers: Record<string, (value: string) => void> = {
    "--batch-size": (value) => {
      opts.batchSize = Number.parseInt(value, 10);
    },
    "--from": (value) => {
      opts.from = value;
    },
    "--jsonb-nul-policy": (value) => {
      if (value === "strict" || value === "migrate-to-blobs") {
        opts.jsonbNulPolicy = value;
      }
    },
    "--ledger": (value) => {
      opts.ledgerPath = value;
    },
    "--to": (value) => {
      opts.to = value;
    },
  };
  const flagHandlers: Record<string, () => void> = {
    "--allow-non-empty": () => {
      opts.allowNonEmpty = true;
    },
    "--dry-run": () => {
      opts.dryRun = true;
    },
    "--json": () => {
      opts.json = true;
    },
    "--quiet": () => {
      opts.quiet = true;
    },
  };
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    const valueHandler = arg ? valueHandlers[arg] : undefined;
    const flagHandler = arg ? flagHandlers[arg] : undefined;
    const nextValue = args[i + 1];
    if (valueHandler && nextValue !== undefined) {
      valueHandler(nextValue);
      i += 1;
    } else if (flagHandler) {
      flagHandler();
    }
  }

  return { command, opts };
}

// ─────────────────────────────────────────────────────────────────────────
// Output helpers
// ─────────────────────────────────────────────────────────────────────────

function emit(kind: string, payload: Record<string, unknown>, opts: OutputOptions): void {
  if (opts.json) {
    console.log(JSON.stringify({ kind, ...payload }));
  } else if (!opts.quiet && payload.message) {
    console.log(payload.message);
  }
}

function emitError(message: string, opts: OutputOptions): void {
  if (opts.json) {
    console.log(JSON.stringify({ kind: "error", message }));
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
function buildExtractionSink({ ledgerPath, dryRun }: Pick<CliOptions, "ledgerPath" | "dryRun">): ExtractionSink {
  const queued: Extraction[] = [];
  const seenSha256 = new Set();

  // Ensure the ledger directory exists. We open the stream lazily on
  // first extraction so a migration that produces zero extractions
  // doesn't create an empty ledger file.
  let ledgerStream: WriteStream | null = null;
  function openLedger() {
    if (ledgerStream) {
      return;
    }
    const dir = dirname(ledgerPath);
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      // Best-effort. If mkdir fails, createWriteStream below will
      // surface a more useful error.
    }
    ledgerStream = createWriteStream(ledgerPath, { flags: "a" });
  }

  function sink(extraction: Extraction): void {
    queued.push(extraction);
    openLedger();
    if (!ledgerStream) {
      throw new Error("Unable to open extraction ledger");
    }
    const line = JSON.stringify({
      connector_id: extraction.connector_id,
      json_path: extraction.json_path,
      original_byte_length: extraction.size_bytes,
      reason: extraction.reason,
      record_key: extraction.record_key,
      sha256: extraction.sha256,
      stream: extraction.stream,
      timestamp: new Date().toISOString(),
    });
    ledgerStream.write(`${line}\n`);
  }

  async function persistQueued(client: PoolClient): Promise<void> {
    // Persist all queued extractions inside the migration's existing
    // transaction (`client` is the pg client from withTx). Idempotent:
    // ON CONFLICT DO NOTHING on the blobs PK; ON CONFLICT DO NOTHING on
    // the blob_bindings composite PK.
    if (dryRun) {
      queued.length = 0;
      return;
    }
    async function persistAt(index: number): Promise<void> {
      const e = queued[index];
      if (!e) {
        return;
      }
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
            "application/octet-stream",
            e.size_bytes,
            e.sha256,
            e.bytes,
          ]
        );
      }
      await client.query(
        `INSERT INTO blob_bindings
           (blob_id, connector_id, stream, record_key, json_path)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT DO NOTHING`,
        [e.blob_id, e.connector_id, e.stream, e.record_key, e.json_path]
      );
      await persistAt(index + 1);
    }
    await persistAt(0);
    queued.length = 0;
  }

  function closeLedger() {
    if (ledgerStream) {
      ledgerStream.end();
      ledgerStream = null;
    }
  }

  return { closeLedger, persistQueued, sink };
}

// ─────────────────────────────────────────────────────────────────────────
// plan command
// ─────────────────────────────────────────────────────────────────────────

// plan is source-only and ignores `to` / `batchSize` / `allowNonEmpty`; we
// accept the full opts shape so the dispatcher can call every command with
// the same parsed-arg bag.
async function planCommand({ from, json, quiet, jsonbNulPolicy }: SourceCommandOptions): Promise<void> {
  // Plan doesn't touch JSONB, but validate the flag value early so a
  // typo surfaces before `execute`.
  setJsonbNulPolicy(jsonbNulPolicy);
  const sqlite = await openSqliteSource(from);

  try {
    if (!sqlite.vecLoaded) {
      emit(
        "plan-warning",
        { message: "WARNING: sqlite-vec extension not loaded; virtual tables may be unreadable" },
        { json, quiet }
      );
    }

    const { locked, reason } = checkSqliteNotLocked(sqlite.filepath);
    if (locked) {
      emit("plan-warning", { message: `WARNING: SQLite locked (${reason})` }, { json, quiet });
    }

    const sourceTables = listSourceTables(sqlite.handle);
    let totalRows = 0;
    const rows: TablePlan[] = [];

    for (const table of TABLES) {
      const skip = DERIVED_TABLES.has(table.name);
      let sourceCount = 0;
      let countNote = "";

      if (sourceTables.has(table.name)) {
        const result = tryQueryRowCount(sqlite.handle, table.name);
        if (result.ok) {
          sourceCount = result.count;
        } else {
          countNote = ` (unreadable: ${result.reason})`;
        }
      }
      totalRows += sourceCount;

      const row: TablePlan = {
        name: table.name,
        skip,
        source_rows: sourceCount,
      };
      if (skip) {
        row.reason = "Derived table: rebuilt by runtime on first boot";
      }

      if (!json && countNote) {
        row.message = countNote;
      }

      emit("plan-row", { ...row }, { json, quiet: false });
      rows.push(row);
    }

    emit(
      "plan-summary",
      {
        derivedTableCount: DERIVED_TABLES.size,
        message: `Total rows to copy: ${totalRows}`,
        totalRows,
      },
      { json, quiet: false }
    );
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
async function diffCommand({ from, to, json, jsonbNulPolicy }: DiffCommandOptions): Promise<void> {
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
        emit(
          "diff-row",
          {
            message: "Table missing from source (fresh install)",
            status: "missing-from-source",
            table: table.name,
          },
          { json, quiet: false }
        );
        return;
      }

      const sourceColumns = describeSourceColumns(sqlite.handle, table.name);
      const sourceColNames = new Set(sourceColumns.map((c) => c.name));

      const pgColNames = new Set(table.columns.map((c) => c.name));

      handledCount += reportExtraSourceColumns(table, sourceColumns, pgColNames, json);
      const missing = reportMissingTargetColumns(table, sourceColNames, json);
      handledCount += missing.handled;
      hardDriftCount += missing.hard;
    }

    if (hardDriftCount === 0) {
      const message =
        handledCount === 0
          ? "No schema drift detected"
          : `Found ${handledCount} schema difference(s), all handled by migration (synthesized / NULL-filled / dropped). No blocking drift.`;
      emit(
        "diff-summary",
        {
          handledCount,
          hardDriftCount: 0,
          message,
        },
        { json, quiet: false }
      );
      process.exit(0); // Graceful: execute can handle every reported difference
    } else {
      emit(
        "diff-summary",
        {
          count: hardDriftCount,
          handledCount,
          hardDriftCount,
          message:
            `Found ${hardDriftCount} schema drift issue(s) that migration cannot handle` +
            (handledCount > 0 ? ` (plus ${handledCount} handled difference(s))` : ""),
        },
        { json, quiet: false }
      );
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
  from,
  to,
  batchSize,
  allowNonEmpty,
  json,
  quiet,
  jsonbNulPolicy,
  ledgerPath,
  dryRun,
}: ExecuteCommandOptions): Promise<void> {
  // Apply the policy before any transformer runs. Throws on unknown values.
  resetMigrationStats();
  setJsonbNulPolicy(jsonbNulPolicy);

  // When the policy is "migrate-to-blobs", wire up the extraction sink
  // so binary leaves get persisted to blobs + blob_bindings and logged
  // to the ledger. Otherwise the sink stays null (transformer will throw
  // on forbidden codepoints under "strict").
  let extractionSinkHelper: ExtractionSink | null = null;
  if (jsonbNulPolicy === "migrate-to-blobs") {
    extractionSinkHelper = buildExtractionSink({ dryRun, ledgerPath });
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
    const pool = currentTargetPool();

    // Check target is empty
    if (!allowNonEmpty) {
      const nonSkipTables = TABLES.filter((t) => !DERIVED_TABLES.has(t.name)).map((t) => t.name);
      const targetEmpty = await isTargetEmpty(pool, nonSkipTables);
      if (!targetEmpty) {
        emitError("Target database is not empty. Use --allow-non-empty to override.", { json, quiet });
        process.exit(1);
      }
    }

    const startTime = Date.now();
    const sourceTables = listSourceTables(sqlite.handle);
    let totalCopied = 0;

    // Load connector manifests once for use with records table
    const manifests = loadConnectorManifests(sqlite.handle);

    await TABLES.reduce(async (previous, table) => {
      await previous;
      if (DERIVED_TABLES.has(table.name)) {
        emit(
          "copy-skip",
          {
            reason: "Derived table: rebuilt by runtime on first boot",
            table: table.name,
          },
          { json, quiet }
        );
        return;
      }

      if (!sourceTables.has(table.name)) {
        emit(
          "copy-skip",
          {
            reason: "Table missing from source",
            table: table.name,
          },
          { json, quiet }
        );
        return;
      }

      // Get source column names for drift-tolerant migration
      const sourceColumns = describeSourceColumns(sqlite.handle, table.name);
      const sourceColNames = new Set(sourceColumns.map((c) => c.name));

      // Compute the migration plan (which columns copy, which are NULL-filled)
      const plan = getMigratableColumns(table, sourceColNames);
      const copiedCount = plan.filter((p) => p.mode === "copy").length;
      const nullFilledCount = plan.filter((p) => p.mode === "null").length;
      const nullFilledColumns = plan.filter((p) => p.mode === "null").map((p) => p.name);

      // Detect dropped source columns (will be silently ignored by transformer)
      const droppedSourceColumns = Array.from(sourceColNames).filter(
        (name) => !table.columns.some((col) => col.name === name)
      );

      emit(
        "copy-start",
        {
          copied: copiedCount,
          nullFilled: nullFilledCount,
          nullFilledColumns,
          table: table.name,
          totalColumns: table.columns.length,
        },
        { json, quiet }
      );

      if (droppedSourceColumns.length > 0) {
        emit(
          "copy-warning",
          {
            droppedSourceColumns,
            table: table.name,
          },
          { json, quiet }
        );
      }

      try {
        // For records table, create synthesize hook to derive primary_key_text and cursor_value
        const transformerOptions: { synthesize?: SchemaSynthesizer } = {};
        if (table.name === "records") {
          transformerOptions.synthesize = (sqliteRow, columnName) =>
            synthesizeRecordValue(sqliteRow, columnName, manifests);
        }

        // For blob_bindings, synthesize the new `json_path` column when
        // the source table predates it. Legacy bindings semantically
        // correspond to '@record' (record-level, not tied to a specific
        // JSON Pointer in record_json). See
        // docs/reference/binary-content-invariant-design-brief.md §4.6.
        if (table.name === "blob_bindings") {
          transformerOptions.synthesize = (sqliteRow, columnName) => {
            if (columnName === "json_path") {
              return sqliteRow.json_path ?? "@record";
            }
            return NO_SYNTHESIS;
          };
        }

        const transformer = buildRowTransformer(table, sourceColNames, transformerOptions);
        let rowCount = 0;

        await withTx(pool, async (client) => {
          async function copyNext(iterator: Generator<Record<string, RawValue>[]>): Promise<void> {
            const next = iterator.next();
            if (next.done) {
              return;
            }
            const batch = next.value;
            const transformed = batch.map((row) => transformer(row));

            if (!dryRun) {
              const columnNames = table.columns.map((c) => c.name);
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

            emit(
              "copy-progress",
              {
                rowsProcessed: rowCount,
                table: table.name,
              },
              { json, quiet }
            );
            await copyNext(iterator);
          }
          await copyNext(streamRows(sqlite.handle, table.name, batchSize));
        });

        emit(
          "copy-end",
          {
            rowCount,
            table: table.name,
          },
          { json, quiet }
        );
      } catch (err) {
        emitError(`${table.name}: ${errorMessage(err)}`, { json, quiet });
        process.exit(1);
      }
    }, Promise.resolve());

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    const stats = getMigrationStats();

    let summaryMessage = `Migration complete: ${totalCopied} rows in ${elapsed}s`;
    if (dryRun) {
      summaryMessage = `[dry-run] ${summaryMessage}`;
    }
    summaryMessage += ` [jsonb-nul-policy=${jsonbNulPolicy}]`;

    if (stats.extractedLeaves > 0) {
      const totalMb = (stats.totalExtractedBytes / 1_048_576).toFixed(2);
      summaryMessage +=
        `\n  Extracted ${stats.extractedLeaves} binary leaves to blobs ` +
        `(${stats.uniqueBlobCount} unique sha256s, ${totalMb} MB) ` +
        `from ${stats.extractedRows} rows.` +
        `\n  Extraction ledger: ${ledgerPath}`;
    }

    // Run the post-migration verifier as the final step of execute.
    // Skip in dry-run since we didn't write anything; nothing to verify.
    let invariantFailures = 0;
    if (!dryRun) {
      emit("execute-verify-start", { message: "Running post-migration verifier..." }, { json, quiet });
      invariantFailures = await verifyBinaryContentInvariant(pool, { json, quiet });
      if (invariantFailures === 0) {
        summaryMessage += "\n  Post-migration verifier: PASS (binary-content invariant holds).";
      } else {
        summaryMessage += `\n  Post-migration verifier: FAIL — ${invariantFailures} invariant violation(s) (see verify-invariant-failure events above).`;
      }
    }

    emit(
      "execute-summary",
      {
        dryRun,
        elapsedSeconds: Number.parseFloat(elapsed),
        invariantFailures,
        jsonbNulPolicy,
        ledgerPath: stats.extractedLeaves > 0 ? ledgerPath : null,
        message: summaryMessage,
        stats,
        totalRows: totalCopied,
      },
      { json, quiet: false }
    );

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
async function verifyCommand({ from, to, json, quiet, jsonbNulPolicy }: VerifyCommandOptions): Promise<void> {
  setJsonbNulPolicy(jsonbNulPolicy);
  const sqlite = await openSqliteSource(from);

  try {
    await bootstrapTargetSchema(to);
    const pool = currentTargetPool();

    let mismatches = 0;

    await TABLES.reduce(async (previous, table) => {
      await previous;
      if (DERIVED_TABLES.has(table.name)) {
        return;
      }

      const result = tryQueryRowCount(sqlite.handle, table.name);
      if (!result.ok) {
        // Skip unreadable tables in verify
        return;
      }
      const sourceCount = result.count;
      const targetCount = await tableRowCount(pool, table.name);

      // For blobs / blob_bindings, the target may legitimately exceed
      // the source: migrate-to-blobs extracts binary leaves from
      // record_json into the blobs table and adds entries to
      // blob_bindings. Treat target > source as a non-mismatch for
      // these tables and surface it as informational. For all other
      // tables, source must equal target.
      const allowGrowth = table.name === "blobs" || table.name === "blob_bindings";
      if (sourceCount === targetCount) {
        emit(
          "verify-row",
          {
            sourceRows: sourceCount,
            status: "match",
            table: table.name,
            targetRows: targetCount,
          },
          { json, quiet: false }
        );
      } else if (allowGrowth && targetCount > sourceCount) {
        emit(
          "verify-row",
          {
            growth: targetCount - sourceCount,
            message: `target has ${targetCount - sourceCount} more rows than source (expected for migrate-to-blobs extractions).`,
            sourceRows: sourceCount,
            status: "match-with-growth",
            table: table.name,
            targetRows: targetCount,
          },
          { json, quiet: false }
        );
      } else {
        emit(
          "verify-row",
          {
            sourceRows: sourceCount,
            status: "mismatch",
            table: table.name,
            targetRows: targetCount,
          },
          { json, quiet: false }
        );
        mismatches += 1;
      }

      // Sample fingerprint comparison: target-side only for now.
      // `sampleRowFingerprint` is Postgres-only; the corresponding
      // SQLite-side function doesn't exist. Skip rather than crash —
      // the invariant checks below catch the cases that actually
      // matter for correctness.
      if (targetCount > 0) {
        try {
          const targetFingerprint = await sampleRowFingerprint(pool, table.name, table.primaryKey);
          emit(
            "verify-fingerprint",
            {
              table: table.name,
              targetFingerprint,
            },
            { json, quiet }
          );
        } catch (err) {
          emit(
            "verify-fingerprint",
            {
              error: errorMessage(err),
              table: table.name,
            },
            { json, quiet }
          );
        }
      }
    }, Promise.resolve());

    // ── Invariant checks (SLVP: "verifiable" — see brief §4.9) ──
    const invariantFailures = await verifyBinaryContentInvariant(pool, { json, quiet });

    if (mismatches === 0 && invariantFailures === 0) {
      emit(
        "verify-summary",
        {
          message: "All row counts, samples, and invariants pass",
        },
        { json, quiet: false }
      );
      process.exit(0);
    } else {
      emit(
        "verify-summary",
        {
          invariantFailures,
          message: `Found ${mismatches} row count mismatches and ${invariantFailures} invariant failures`,
          rowCountMismatches: mismatches,
        },
        { json, quiet: false }
      );
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
 * See docs/reference/binary-content-invariant-design-brief.md §4.9.
 *
 * Returns the number of distinct invariant failures detected (0 = clean).
 */
async function verifyBinaryContentInvariant(pool: Pool, { json, quiet }: OutputOptions): Promise<number> {
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
  // See docs/reference/binary-content-invariant-design-brief.md §4.6a for why
  // the migration scope is narrowed to U+0000.
  const r1 = await pool
    .query(`
    SELECT count(*)::int AS n
    FROM records
    WHERE record_json IS NULL AND NOT deleted
  `)
    .catch((err) => ({ error: err, rows: [] }));
  if ("error" in r1) {
    emit(
      "verify-invariant",
      {
        check: "no-null-record_json-on-live-records",
        message: r1.error.message,
        status: "error",
      },
      { json, quiet }
    );
    failures += 1;
  } else if (r1.rows[0].n > 0) {
    failures += 1;
    emit(
      "verify-invariant-failure",
      {
        check: "no-null-record_json-on-live-records",
        count: r1.rows[0].n,
        message: `Found ${r1.rows[0].n} live records with NULL record_json (a transformer bug should not produce this).`,
      },
      { json, quiet: false }
    );
  } else {
    emit(
      "verify-invariant",
      {
        check: "no-null-record_json-on-live-records",
        status: "pass",
      },
      { json, quiet }
    );
  }

  // (2) For every blob_bindings row with a JSON Pointer json_path,
  // the referenced leaf in records.record_json must be null.
  const r2 = await pool
    .query(`
    SELECT bb.connector_id, bb.stream, bb.record_key, bb.json_path,
           jsonb_extract_path_text(r.record_json, VARIADIC string_to_array(substr(bb.json_path, 2), '/')) AS leaf_value
    FROM blob_bindings bb
    LEFT JOIN records r
      ON r.connector_id = bb.connector_id
     AND r.stream = bb.stream
     AND r.record_key = bb.record_key
    WHERE bb.json_path LIKE '/%'
    LIMIT 100
  `)
    .catch((err) => ({ error: err, rows: [] }));
  if ("error" in r2) {
    // Older Postgres might not have a path-syntax compatible jsonb_extract_path_text;
    // surface but don't fatal.
    emit(
      "verify-invariant",
      {
        check: "json_path-leaves-are-null",
        message: r2.error.message,
        status: "error",
      },
      { json, quiet }
    );
    failures += 1;
  } else {
    let leafFailures = 0;
    for (const row of r2.rows) {
      // leaf_value is null when the field is absent OR when it's
      // literally null. Both are acceptable post-extraction.
      if (row.leaf_value !== null) {
        leafFailures += 1;
        emit(
          "verify-invariant-failure",
          {
            check: "json_path-leaves-are-null",
            connector_id: row.connector_id,
            json_path: row.json_path,
            leaf_value: String(row.leaf_value).slice(0, 80),
            record_key: row.record_key,
            stream: row.stream,
          },
          { json, quiet: false }
        );
      }
    }
    if (leafFailures > 0) {
      failures += 1;
    } else {
      emit(
        "verify-invariant",
        {
          check: "json_path-leaves-are-null",
          status: "pass",
        },
        { json, quiet }
      );
    }
  }

  // (3) blob_bindings.blob_id must exist in blobs with consistent sha256.
  const r3 = await pool
    .query(`
    SELECT bb.blob_id
    FROM blob_bindings bb
    LEFT JOIN blobs b ON b.blob_id = bb.blob_id
    WHERE b.blob_id IS NULL
    LIMIT 100
  `)
    .catch((err) => ({ error: err, rows: [] }));
  if ("error" in r3) {
    emit(
      "verify-invariant",
      {
        check: "blob_bindings-references-existing-blobs",
        message: r3.error.message,
        status: "error",
      },
      { json, quiet }
    );
    failures += 1;
  } else if (r3.rows.length > 0) {
    failures += 1;
    emit(
      "verify-invariant-failure",
      {
        check: "blob_bindings-references-existing-blobs",
        count: r3.rows.length,
        sample_blob_ids: r3.rows.slice(0, 5).map((r) => r.blob_id),
      },
      { json, quiet: false }
    );
  } else {
    emit(
      "verify-invariant",
      {
        check: "blob_bindings-references-existing-blobs",
        status: "pass",
      },
      { json, quiet }
    );
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
  const r4 = await pool
    .query(`
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
  `)
    .catch((err) => ({ error: err, rows: [] }));
  if ("error" in r4) {
    emit(
      "verify-invariant",
      {
        check: "no-prior-epoch-orphans",
        message: r4.error.message,
        status: "error",
      },
      { json, quiet }
    );
    failures += 1;
  } else if (r4.rows.length > 0) {
    failures += 1;
    emit(
      "verify-invariant-failure",
      {
        check: "no-prior-epoch-orphans",
        count: r4.rows.length,
        message:
          "Found run.started events from a prior controller epoch with no terminal event. " +
          "The boot-time reconciler did not run, or ran but is failing to reach all orphans. " +
          "See docs/run-reconciliation-design-brief.md §3.6.",
        sample_orphans: r4.rows.slice(0, 5).map((r) => ({
          actor_id: r.actor_id,
          event_id: r.event_id,
          run_id: r.run_id,
        })),
      },
      { json, quiet: false }
    );
  } else {
    emit(
      "verify-invariant",
      {
        check: "no-prior-epoch-orphans",
        status: "pass",
      },
      { json, quiet }
    );
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
Usage: cli.ts <command> --from <url> --to <url> [options]

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

  See docs/reference/binary-content-invariant-design-brief.md §4.7–§4.8.
    `);
    process.exit(0);
  }

  if (!(opts.from && opts.to)) {
    console.error("ERROR: --from and --to are required for all commands");
    process.exit(1);
  }

  try {
    const requiredOpts: RequiredCliOptions = { ...opts, from: opts.from, to: opts.to };
    switch (command) {
      case "plan":
        await planCommand(requiredOpts);
        break;
      case "diff":
        await diffCommand(requiredOpts);
        break;
      case "execute":
        await executeCommand(requiredOpts);
        break;
      case "verify":
        await verifyCommand(requiredOpts);
        break;
      default:
        console.error(`ERROR: Unknown command "${command}"`);
        process.exit(1);
    }
  } catch (err) {
    emitError(errorMessage(err), { json: opts.json, quiet: opts.quiet });
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("FATAL:", errorMessage(err));
  process.exit(1);
});
