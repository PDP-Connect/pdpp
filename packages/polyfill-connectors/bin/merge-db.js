#!/usr/bin/env node
/**
 * Merge records + spine_events + state rows from a source sqlite file into
 * the main polyfill sqlite. Used after running a parallel orchestrator with
 * PDPP_DB_PATH against its own DB (e.g. Codex) to bring those records into
 * the unified store.
 *
 * Usage:
 *   node bin/merge-db.js <source.sqlite> [--into <target.sqlite>] [--dry-run] [--delete-source]
 *
 * Default target: packages/polyfill-connectors/.pdpp-data/polyfill.sqlite
 *
 * Strategy: ATTACH the source DB, INSERT OR IGNORE everything row-shaped
 * (records, spine_events, state_rows, etc.). Conflicts on records are
 * expected and fine — the target already has the authoritative copy if
 * they're cross-populated.
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync, unlinkSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const DEFAULT_TARGET = join(REPO_ROOT, 'packages/polyfill-connectors/.pdpp-data/polyfill.sqlite');

function parseArgs(argv) {
  const out = { source: null, target: DEFAULT_TARGET, dryRun: false, deleteSource: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--delete-source') out.deleteSource = true;
    else if (a === '--into') out.target = resolve(argv[++i]);
    else if (!a.startsWith('--')) out.source = resolve(a);
  }
  return out;
}

function tableExists(db, name) {
  const r = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name);
  return !!r;
}

function tableColumns(db, name) {
  return db.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.source) {
    console.error('Usage: merge-db.js <source.sqlite> [--into <target.sqlite>] [--dry-run] [--delete-source]');
    process.exit(2);
  }
  if (!existsSync(args.source)) {
    console.error(`source not found: ${args.source}`);
    process.exit(1);
  }
  if (!existsSync(args.target)) {
    console.error(`target not found: ${args.target}`);
    process.exit(1);
  }
  if (resolve(args.source) === resolve(args.target)) {
    console.error('source and target are the same file; refusing to merge');
    process.exit(1);
  }

  const srcSize = statSync(args.source).size;
  const tgtSize = statSync(args.target).size;
  console.error(`source: ${args.source} (${(srcSize / 1e6).toFixed(1)} MB)`);
  console.error(`target: ${args.target} (${(tgtSize / 1e6).toFixed(1)} MB)`);
  console.error(`dry-run: ${args.dryRun}, delete-source: ${args.deleteSource}`);

  const db = new DatabaseSync(args.target);
  db.exec(`ATTACH DATABASE '${args.source.replace(/'/g, "''")}' AS src`);

  const srcTables = db.prepare(
    `SELECT name FROM src.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`
  ).all().map((r) => r.name);
  console.error(`source tables: ${srcTables.join(', ')}`);

  // Build a plan of table → INSERT OR IGNORE SELECT using intersection of columns
  // so schema drift between source/target doesn't abort the merge.
  const plan = [];
  for (const t of srcTables) {
    if (!tableExists(db, t)) {
      console.error(`  WARN: target missing table '${t}'; skipping`);
      continue;
    }
    const srcCols = new Set(db.prepare(`PRAGMA src.table_info(${t})`).all().map((c) => c.name));
    const tgtCols = tableColumns(db, t);
    const shared = tgtCols.filter((c) => srcCols.has(c));
    if (!shared.length) {
      console.error(`  WARN: table '${t}' has no shared columns; skipping`);
      continue;
    }
    const colList = shared.join(', ');
    const sql = `INSERT OR IGNORE INTO main.${t} (${colList}) SELECT ${colList} FROM src.${t}`;
    plan.push({ table: t, sql });
  }

  if (args.dryRun) {
    console.error('\nDry run — would execute:');
    for (const p of plan) {
      const srcCount = db.prepare(`SELECT COUNT(*) AS n FROM src.${p.table}`).get().n;
      const tgtCount = db.prepare(`SELECT COUNT(*) AS n FROM main.${p.table}`).get().n;
      console.error(`  ${p.table.padEnd(22)} src=${srcCount} tgt=${tgtCount}`);
    }
    db.close();
    return;
  }

  db.exec('BEGIN');
  const mergedCounts = {};
  try {
    for (const p of plan) {
      const before = db.prepare(`SELECT COUNT(*) AS n FROM main.${p.table}`).get().n;
      db.prepare(p.sql).run();
      const after = db.prepare(`SELECT COUNT(*) AS n FROM main.${p.table}`).get().n;
      mergedCounts[p.table] = { added: after - before, tgt_total: after };
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    console.error('merge failed, rolled back:', err.message);
    process.exit(1);
  }

  console.error('\nMerge summary:');
  for (const [t, c] of Object.entries(mergedCounts)) {
    console.error(`  ${t.padEnd(22)} +${c.added.toString().padStart(6)} new (target total now ${c.tgt_total})`);
  }

  if (tableExists(db, 'records')) {
    console.error('\nRecords per connector after merge:');
    const rows = db.prepare(
      `SELECT connector_id, stream, COUNT(*) AS n FROM main.records GROUP BY 1, 2 ORDER BY 1, 2`
    ).all();
    for (const r of rows) {
      console.error(`  ${r.connector_id.padEnd(52)} ${r.stream.padEnd(20)} ${r.n}`);
    }
  }

  db.close();

  if (args.deleteSource) {
    unlinkSync(args.source);
    console.error(`\nDeleted source: ${args.source}`);
    for (const ext of ['-journal', '-wal', '-shm']) {
      const sibling = args.source + ext;
      if (existsSync(sibling)) { unlinkSync(sibling); console.error(`  also deleted ${sibling}`); }
    }
  }
}

main();
