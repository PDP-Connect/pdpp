#!/usr/bin/env node

/**
 * canonical-connector-keys CLI — read-only dry-run for the
 * canonical connector-key migration (OpenSpec change
 * `canonicalize-connector-keys`, tasks §3.2).
 *
 * Usage:
 *   PDPP_STORAGE_BACKEND=postgres \
 *   PDPP_DATABASE_URL=postgres://... \
 *   node reference-implementation/scripts/canonical-connector-keys/cli.mjs inspect [--json] [--allow-unmapped]
 *
 * Flags:
 *   --json             emit the full JSON report instead of the human summary
 *   --allow-unmapped   do NOT exit non-zero if unmapped values are found
 *                      (useful while reviewing a problem instance; the
 *                      default behavior fails closed per design §3)
 *
 * The command opens one Postgres connection, runs SELECT-only queries
 * (information_schema discovery, GROUP BY counts), and exits. No table
 * is written.
 */

import { inspect, formatHumanReport, makePostgresDriver } from './inspect.mjs';

export function parseArgs(argv) {
  const args = argv.slice(2);
  const command = args[0];
  const opts = { json: false, allowUnmapped: false };
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') opts.json = true;
    else if (a === '--allow-unmapped') opts.allowUnmapped = true;
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

async function main() {
  const { command, opts } = parseArgs(process.argv);
  if (command !== 'inspect') {
    process.stderr.write('Usage: cli.mjs inspect [--json] [--allow-unmapped]\n');
    process.exit(2);
  }

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

  if (report.summary.hasUnmapped && !opts.allowUnmapped) {
    process.stderr.write(
      `\nFAIL: ${report.summary.totalUnmappedRows} unmapped connector_id rows. ` +
        `Run with --allow-unmapped to bypass for review.\n`,
    );
    process.exit(1);
  }
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
