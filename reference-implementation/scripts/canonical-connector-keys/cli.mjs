#!/usr/bin/env node

/**
 * canonical-connector-keys CLI — dry-run and write migration for the
 * canonical connector-key migration (OpenSpec change
 * `canonicalize-connector-keys`, tasks §3.2 and §3.3).
 *
 * Usage:
 *   PDPP_STORAGE_BACKEND=postgres \
 *   PDPP_DATABASE_URL=postgres://... \
 *   node reference-implementation/scripts/canonical-connector-keys/cli.mjs <command> [flags]
 *
 * Commands:
 *   inspect  — read-only dry-run. Discovers every connector_id column +
 *              JSONB surface, classifies values, reports rewrite/unmapped
 *              counts by surface tier. Exits non-zero when active-tier
 *              tables contain unmapped values.
 *   write    — apply the canonical-key rewrite in a single transaction.
 *              Always runs `inspect` first and refuses to write when
 *              active tables contain unmapped rows. Pair with `--apply`
 *              to perform writes; without `--apply` the command prints
 *              the plan that would be applied but performs no writes.
 *
 * Flags:
 *   --json                   emit the full JSON report instead of the human summary
 *   --allow-unmapped         do NOT exit non-zero if unmapped values are found in
 *                            active tables (review/diagnostic only; MUST NOT be
 *                            paired with --apply on a production deployment)
 *   --include-backup-tables  include backup-tier tables in the plan and in the
 *                            fail-closed unmapped check. Scratch tables are
 *                            never rewritten. Default: off.
 *   --apply                  (write command only) actually perform writes inside
 *                            a single transaction. Without --apply the write
 *                            command prints the plan it would execute but writes
 *                            nothing.
 *
 * Exit code:
 *   0 — no unmapped rows in active tables (backup/scratch warnings are non-blocking)
 *   1 — unmapped rows found in active tables (or env error); bypass with --allow-unmapped
 *   2 — usage error
 *
 * The command opens one Postgres connection. `inspect` runs SELECT-only
 * queries; `write` opens a single client for BEGIN/COMMIT/ROLLBACK so
 * any mid-flight failure rolls the transaction back to the pre-migration
 * snapshot.
 */

import { inspect, formatHumanReport, makePostgresDriver } from './inspect.mjs';
import { formatApplyResult, makePostgresWriteDriver, migrate } from './writer.mjs';

export function parseArgs(argv) {
  const args = argv.slice(2);
  const command = args[0];
  const opts = {
    json: false,
    allowUnmapped: false,
    includeBackupTables: false,
    apply: false,
  };
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') opts.json = true;
    else if (a === '--allow-unmapped') opts.allowUnmapped = true;
    else if (a === '--include-backup-tables') opts.includeBackupTables = true;
    else if (a === '--apply') opts.apply = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return { command, opts };
}

function requireEnv() {
  const backend = process.env.PDPP_STORAGE_BACKEND;
  const url = process.env.PDPP_DATABASE_URL;
  if (backend !== 'postgres') {
    throw new Error(
      `PDPP_STORAGE_BACKEND must be 'postgres' for the dry-run (got ${backend ?? 'unset'})`,
    );
  }
  if (!url) {
    throw new Error('PDPP_DATABASE_URL is required');
  }
  return url;
}

async function loadPgPool() {
  const pg = await import('pg');
  return pg.default?.Pool ?? pg.Pool;
}

function formatPlanSummary(plan) {
  const lines = [];
  lines.push(`# canonical connector-key migration — plan (not applied)`);
  lines.push('');
  lines.push(`include_backup_tables: ${plan.options.includeBackupTables}`);
  lines.push('');
  lines.push(`column rewrites (${plan.columnRewrites.length} distinct):`);
  for (const r of plan.columnRewrites) {
    lines.push(
      `  ${r.surfaceClass.padEnd(7)} ${r.table}.${r.column}  ` +
        `rows=${r.expectedRows}  ${r.oldValue} → ${r.newValue}`,
    );
  }
  if (plan.skipped.backupRowsColumns > 0 || plan.skipped.scratchRowsColumns > 0) {
    lines.push('');
    lines.push(
      `skipped: backup_rows=${plan.skipped.backupRowsColumns} ` +
        `scratch_rows=${plan.skipped.scratchRowsColumns} ` +
        `(re-run with --include-backup-tables to include backup tables; ` +
        `scratch tables are always skipped)`,
    );
  }
  lines.push('');
  lines.push(`jsonb surfaces (per-row apply runs at execution time):`);
  for (const s of plan.jsonbSurfaces) {
    lines.push(`  ${s.table}.${s.column}  pk=[${s.primaryKey.join(',')}]`);
  }
  return lines.join('\n');
}

async function runInspect(opts) {
  const databaseUrl = requireEnv();
  const Pool = await loadPgPool();
  const pool = new Pool({ connectionString: databaseUrl });

  let report;
  try {
    const driver = makePostgresDriver(pool);
    report = await inspect(driver);
  } finally {
    await pool.end();
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write(formatHumanReport(report) + '\n');
  }

  if (report.summary.hasUnmappedActive && !opts.allowUnmapped) {
    process.stderr.write(
      `\nFAIL: ${report.summary.totalUnmappedRowsActive} unmapped connector_id rows in active tables. ` +
        `Run with --allow-unmapped to bypass for review.\n`,
    );
    process.exit(1);
  }
}

async function runWrite(opts) {
  const databaseUrl = requireEnv();
  const Pool = await loadPgPool();
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();

  let result;
  try {
    const driver = makePostgresWriteDriver(client);
    result = await migrate(driver, {
      apply: opts.apply,
      includeBackupTables: opts.includeBackupTables,
      allowUnmapped: opts.allowUnmapped,
    });
  } finally {
    client.release();
    await pool.end();
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }

  process.stdout.write(formatHumanReport(result.report) + '\n');
  process.stdout.write('\n');
  if (result.applied) {
    process.stdout.write(formatApplyResult(result.applied) + '\n');
  } else {
    process.stdout.write(formatPlanSummary(result.plan) + '\n');
    process.stdout.write('\n(no --apply flag: no writes performed)\n');
  }
}

async function main() {
  const { command, opts } = parseArgs(process.argv);
  if (command === 'inspect') {
    await runInspect(opts);
    return;
  }
  if (command === 'write') {
    await runWrite(opts);
    return;
  }
  process.stderr.write(
    'Usage: cli.mjs <inspect|write> [--json] [--allow-unmapped] [--include-backup-tables] [--apply]\n',
  );
  process.exit(2);
}

const isDirectInvocation = (() => {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    return import.meta.url === `file://${entry}` || import.meta.url.endsWith(entry);
  } catch {
    return false;
  }
})();

if (isDirectInvocation) {
  main().catch((err) => {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(1);
  });
}
