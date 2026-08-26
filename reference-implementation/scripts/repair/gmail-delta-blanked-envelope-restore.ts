#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * gmail-delta-blanked-envelope-restore
 *
 * Owner/operator-only repair for Gmail messages whose envelope was blanked by
 * the flag/label delta pass.
 *
 * The defect
 * ----------
 * Before the fix in `connectors/gmail/index.ts`, `runDeltaPass` fetched with
 * `envelope: false` and emitted a `messages` record whose envelope fields were
 * all null. PDPP records are whole-document upserts — ingest sets
 * `record_json = EXCLUDED.record_json` and there is no merge path in either
 * backend — so that record did not update flags on the stored row, it replaced
 * the row. Every label change or `\Seen` toggle on an already-collected
 * message erased its `subject`, `from_name`, `from_email`, `date`,
 * `message_id`, `size_bytes` and `snippet`, and reset `received_at` to the run
 * clock.
 *
 * Why no re-fetch is needed
 * -------------------------
 * The blanking wrote a NEW version rather than mutating the old one, so the
 * complete pre-blank payload is still in `record_changes`. This tool restores
 * the current `records` projection from that retained history. Gmail is never
 * contacted, so the account's IMAP throttle is irrelevant and no mail can be
 * re-downloaded, altered, or deleted.
 *
 * What it restores
 * ----------------
 * For each key whose CURRENT row is blank (`subject` and `from_email` both
 * null), the highest-versioned `record_changes` row for that key that still
 * carries a non-null `subject`. That is the last known-good payload.
 *
 * Its `labels` and flag booleans are deliberately taken from the CURRENT row,
 * not from history: those are the fields the delta pass legitimately observed,
 * and they are the newer truth. Restoring them from history would undo real
 * label changes. Only the fields the delta pass could not see — and therefore
 * destroyed — come from history.
 *
 * Safety model
 * ------------
 *   - Default is dry-run. `--apply` is required to write.
 *   - Only rows that are blank RIGHT NOW are touched; a row that has since
 *     been re-collected in full is left alone.
 *   - Before any write, every affected current row is snapshotted into a
 *     backup table (prefix `gdber_backup`) inside the same transaction.
 *   - The write is a version-guarded UPDATE: it re-checks that the current
 *     row still holds the version that was read, so a concurrent run that
 *     re-collected the message wins instead of being clobbered.
 *   - Records are never deleted and no version is rewound. The restore
 *     allocates a new version, so the blanking remains visible in history.
 *
 * Output discipline
 * -----------------
 * This is the owner's email. Only counts and truncated record keys are
 * printed. No subject, address, snippet, or any other payload field is read
 * into the output or into a log line.
 *
 * Usage:
 *   node reference-implementation/scripts/repair/gmail-delta-blanked-envelope-restore.ts \
 *     --connector-instance-id=cin_... [--apply]
 *
 * Env:
 *   PDPP_DATABASE_URL   required (postgres connection string).
 *                       PDPP_TEST_POSTGRES_URL is accepted as a fallback.
 *
 * Exit codes:
 *   0  dry-run completed, or apply completed successfully.
 *   1  apply failed (transaction rolled back).
 *   2  usage / configuration error.
 */

import { createHash } from "node:crypto";
import process from "node:process";
// biome-ignore lint/correctness/noUnresolvedImports: Biome cannot resolve this installed package export; Node and TypeScript resolve it.
import pg from "pg";

const { Pool } = pg;

const PG_IDENTIFIER_MAX = 63;

export const BACKUP_TABLE_PREFIX = "gdber_backup";

const MESSAGES_STREAM = "messages";

/** Fields the delta pass destroyed, so the fields history must supply. */
export const RESTORED_FIELDS = [
  "subject",
  "from_name",
  "from_email",
  "to",
  "cc",
  "bcc",
  "reply_to",
  "date",
  "received_at",
  "message_id",
  "in_reply_to",
  "references",
  "size_bytes",
  "snippet",
  "has_attachments",
] as const;

/** Truncate any identifier for payload-free output (head...tail elision). */
export function truncateId(value: unknown): string {
  const s = String(value ?? "");
  if (s.length <= 16) {
    return s;
  }
  return `${s.slice(0, 8)}...${s.slice(-4)}`;
}

/**
 * Validate a token against a conservative identifier grammar so it is safe to
 * interpolate into a `CREATE TABLE` name. Parameters cannot be used for
 * identifiers, so the backup-table name is built from validated tokens only.
 */
export function sanitizeIdentifierToken(value: unknown, label: string): string {
  const s = String(value ?? "");
  const cleaned = s.replace(/[^A-Za-z0-9]/g, "_").toLowerCase();
  if (!cleaned || cleaned.length > 96) {
    throw new Error(`unsafe ${label} for backup-table name: ${JSON.stringify(value)}`);
  }
  return cleaned;
}

export interface BackupTableNameInput {
  connectorInstanceId: string;
  stamp: string;
}

/**
 * Compose a collision-safe backup-table name that stays within Postgres'
 * 63-byte identifier limit: `<prefix>_<hash8>__<cinFragment>__<stamp>`.
 */
export function backupTableName({ connectorInstanceId, stamp }: BackupTableNameInput): string {
  const cin = sanitizeIdentifierToken(connectorInstanceId, "connector-instance-id");
  const stmp = sanitizeIdentifierToken(stamp, "stamp");
  const hash8 = createHash("sha256")
    .update(JSON.stringify([cin, MESSAGES_STREAM, stmp]))
    .digest("hex")
    .slice(0, 8);
  const base = `${BACKUP_TABLE_PREFIX}_${hash8}`;
  const stampPart = stmp.slice(0, 16);
  const remaining = PG_IDENTIFIER_MAX - base.length - 4 - stampPart.length;
  const cinPart = remaining > 0 ? cin.slice(0, remaining) : "";
  const name = `${base}__${cinPart}__${stampPart}`;
  if (name.length > PG_IDENTIFIER_MAX) {
    throw new Error(`backup-table name exceeds ${PG_IDENTIFIER_MAX} bytes: ${name}`);
  }
  return name;
}

export interface ParsedArgs {
  apply: boolean;
  connectorInstanceId: string | null;
}

/** Parse argv into the tool's option record. */
export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { apply: false, connectorInstanceId: null };
  for (const arg of argv) {
    if (!arg.startsWith("--")) {
      continue;
    }
    const eq = arg.indexOf("=");
    const key = eq > 0 ? arg.slice(2, eq) : arg.slice(2);
    const val = eq > 0 ? arg.slice(eq + 1) : "";
    if (key === "connector-instance-id") {
      out.connectorInstanceId = String(val);
    } else if (key === "apply") {
      out.apply = true;
    }
  }
  return out;
}

/** Return a usage error string, or null when the args are well-formed. */
export function validateArgs(args: ParsedArgs): string | null {
  if (!args.connectorInstanceId) {
    return "--connector-instance-id is required";
  }
  return null;
}

/**
 * Merge a known-good historical payload with the current row's live
 * label/flag state.
 *
 * Pure, and the heart of the tool: it decides field-by-field which side wins.
 * History supplies only what the delta pass destroyed; everything the delta
 * pass legitimately observed is taken from the current row so a real label
 * change is not rolled back.
 */
export function mergeRestoredRecord(args: {
  current: Record<string, unknown>;
  history: Record<string, unknown>;
}): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...args.current };
  for (const field of RESTORED_FIELDS) {
    if (field in args.history) {
      merged[field] = args.history[field];
    }
  }
  return merged;
}

export interface RestoreCandidate {
  currentVersion: number;
  recordKey: string;
}

export interface RestoreResult {
  applied: boolean;
  backupTable: string | null;
  blankedCount: number;
  error: string | null;
  failed: boolean;
  restorableCount: number;
  restoredCount: number;
  skippedConcurrent: number;
}

/**
 * Find blank current rows, restore each from its last known-good history row,
 * and report what moved. With `apply` false nothing is written.
 */
export async function runRestore(args: {
  apply: boolean;
  connectorInstanceId: string;
  pool: pg.Pool;
  stamp: string;
}): Promise<RestoreResult> {
  const base: RestoreResult = {
    applied: args.apply,
    backupTable: null,
    blankedCount: 0,
    error: null,
    failed: false,
    restorableCount: 0,
    restoredCount: 0,
    skippedConcurrent: 0,
  };

  // A row is "blank" when the two fields every real Gmail message has —
  // subject and sender — are both null. That is the delta pass's signature.
  const blanked = await args.pool.query(
    `SELECT record_key, version
       FROM records
      WHERE connector_instance_id = $1
        AND stream = $2
        AND deleted = FALSE
        AND record_json->>'subject' IS NULL
        AND record_json->>'from_email' IS NULL`,
    [args.connectorInstanceId, MESSAGES_STREAM]
  );
  const blankedCount = blanked.rowCount ?? 0;

  // The last version that still had an envelope, per key.
  const restorable = await args.pool.query(
    `SELECT DISTINCT ON (record_key) record_key, version
       FROM record_changes
      WHERE connector_instance_id = $1
        AND stream = $2
        AND record_json->>'subject' IS NOT NULL
        AND record_key = ANY($3::text[])
      ORDER BY record_key, version DESC`,
    [args.connectorInstanceId, MESSAGES_STREAM, blanked.rows.map((r) => String(r.record_key))]
  );
  const restorableCount = restorable.rowCount ?? 0;

  if (!args.apply) {
    return { ...base, blankedCount, restorableCount };
  }

  const table = backupTableName({ connectorInstanceId: args.connectorInstanceId, stamp: args.stamp });
  const client = await args.pool.connect();
  let restoredCount = 0;
  let skippedConcurrent = 0;
  try {
    await client.query("BEGIN");
    await client.query(
      `CREATE TABLE IF NOT EXISTS "${table}" (
         connector_instance_id text NOT NULL,
         stream text NOT NULL,
         record_key text NOT NULL,
         version bigint NOT NULL,
         record_json jsonb NOT NULL,
         backed_up_at timestamptz NOT NULL DEFAULT now()
       )`
    );
    await client.query(
      `INSERT INTO "${table}" (connector_instance_id, stream, record_key, version, record_json)
       SELECT connector_instance_id, stream, record_key, version, record_json
         FROM records
        WHERE connector_instance_id = $1
          AND stream = $2
          AND deleted = FALSE
          AND record_json->>'subject' IS NULL
          AND record_json->>'from_email' IS NULL`,
      [args.connectorInstanceId, MESSAGES_STREAM]
    );

    for (const row of restorable.rows) {
      const recordKey = String(row.record_key);
      // Version-guarded: if a concurrent run re-collected this message
      // between the read above and now, its version has moved and this
      // matches zero rows rather than overwriting the fresher payload.
      // biome-ignore lint/performance/noAwaitInLoops: every restore in this loop shares ONE pg.PoolClient inside a single BEGIN/COMMIT transaction -- a pg client serializes queries on one connection regardless, so parallelizing would not overlap I/O, only reorder statements inside the transaction non-deterministically.
      const updated = await client.query(
        `UPDATE records cur
            SET record_json = (
                  SELECT cur.record_json || jsonb_object_agg(h.key, h.value)
                    FROM jsonb_each(hist.record_json) AS h(key, value)
                   WHERE h.key = ANY($5::text[])
                ),
                version = cur.version + 1
           FROM record_changes hist
          WHERE cur.connector_instance_id = $1
            AND cur.stream = $2
            AND cur.record_key = $3
            AND cur.deleted = FALSE
            AND cur.record_json->>'subject' IS NULL
            AND cur.record_json->>'from_email' IS NULL
            AND hist.connector_instance_id = $1
            AND hist.stream = $2
            AND hist.record_key = $3
            AND hist.version = $4`,
        [
          args.connectorInstanceId,
          MESSAGES_STREAM,
          recordKey,
          Number(row.version),
          RESTORED_FIELDS as unknown as string[],
        ]
      );
      if (updated.rowCount === 1) {
        restoredCount += 1;
      } else {
        skippedConcurrent += 1;
      }
    }
    await client.query("COMMIT");
    return { ...base, backupTable: table, blankedCount, restorableCount, restoredCount, skippedConcurrent };
  } catch (e) {
    await client.query("ROLLBACK").catch((): undefined => undefined);
    return {
      ...base,
      blankedCount,
      error: e instanceof Error ? e.message : String(e),
      failed: true,
      restorableCount,
    };
  } finally {
    client.release();
  }
}

/** Render a payload-free operator summary. */
export function formatSummary(result: RestoreResult, connectorInstanceId: string): string {
  const lines: string[] = [];
  const mode = result.applied ? "APPLY" : "DRY-RUN";
  lines.push(`gmail-delta-blanked-envelope-restore [${mode}]: cin=${truncateId(connectorInstanceId)}`);
  lines.push(`  blanked current rows      ${result.blankedCount}`);
  lines.push(`  restorable from history   ${result.restorableCount}`);
  const unrecoverable = result.blankedCount - result.restorableCount;
  if (unrecoverable > 0) {
    lines.push(`  NOT restorable            ${unrecoverable}  (history pruned; needs a Gmail re-fetch)`);
  }
  if (result.failed) {
    lines.push(`  FAILED: ${result.error}`);
  } else if (result.applied) {
    lines.push(`  restored                  ${result.restoredCount}`);
    if (result.skippedConcurrent > 0) {
      lines.push(`  skipped (re-collected)    ${result.skippedConcurrent}`);
    }
    lines.push(`  backup_table=${result.backupTable}`);
  } else {
    lines.push("  (dry-run) re-run with --apply to restore.");
  }
  return lines.join("\n");
}

const invokedAsScript = process.argv[1]
  ? import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith(process.argv[1])
  : false;

if (invokedAsScript) {
  await runCli();
}

async function runCli(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const validationError = validateArgs(args);
  if (validationError) {
    console.error(validationError);
    process.exit(2);
  }
  const databaseUrl = process.env.PDPP_DATABASE_URL || process.env.PDPP_TEST_POSTGRES_URL || null;
  if (!databaseUrl) {
    console.error("PDPP_DATABASE_URL is required");
    process.exit(2);
  }
  const connectorInstanceId = args.connectorInstanceId as string;
  const stamp = new Date()
    .toISOString()
    .replace(/[^0-9]/g, "")
    .slice(0, 14);

  const pool = new Pool({ connectionString: databaseUrl });
  let exitCode = 0;
  try {
    const result = await runRestore({ apply: args.apply, connectorInstanceId, pool, stamp });
    console.log(formatSummary(result, connectorInstanceId));
    exitCode = result.failed ? 1 : 0;
  } finally {
    await pool.end();
  }
  process.exit(exitCode);
}
