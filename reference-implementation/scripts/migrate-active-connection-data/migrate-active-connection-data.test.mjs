/**
 * Static checks for the migration script: argument parser, plan shape,
 * table classification invariants, and — most importantly — assertions
 * against the live postgres-storage.js schema so the snapshot-table
 * regression (DELETE … WHERE connector_instance_id against a table that
 * has no such column) cannot recur.
 *
 * Does not connect to a database.
 *
 * Run: node --test reference-implementation/scripts/migrate-active-connection-data/migrate-active-connection-data.test.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MIGRATION_PAIRS,
  AUTHORITATIVE_INSTANCE_TABLES,
  TARGET_REBUILD_PER_STREAM_TABLES,
  SOURCE_CLEAR_ONLY_TABLES,
  SOURCE_TOUCHED_TABLES,
  DEVICE_BINDING_TABLES,
  SCHEMA_TABLES_WITHOUT_CONNECTOR_INSTANCE_ID,
} from './plan.mjs';
import { parseArgs, makeRunId } from './cli.mjs';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const POSTGRES_STORAGE = path.join(REPO_ROOT, 'reference-implementation', 'server', 'postgres-storage.js');
const CLI_PATH = path.join(__dirname, 'cli.mjs');

function readPostgresStorageSource() {
  if (!fs.existsSync(POSTGRES_STORAGE)) {
    throw new Error(`postgres-storage.js not found at ${POSTGRES_STORAGE}`);
  }
  return fs.readFileSync(POSTGRES_STORAGE, 'utf8');
}

function parseTableBodies(src) {
  // Capture `CREATE TABLE IF NOT EXISTS <name> ( ... )` blocks. We use a
  // permissive regex: the table body ends at the first ')' followed by a
  // backtick or semicolon at the outer template-literal/statement level.
  // postgres-storage.js consistently emits each CREATE TABLE inside its
  // own template literal so this works in practice; if the layout changes
  // the assertion below will fail loudly.
  const out = {};
  const re = /CREATE TABLE IF NOT EXISTS ([a-z_]+)\s*\(([\s\S]*?)\)\s*[`;]/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    out[m[1]] = m[2];
  }
  return out;
}

function readCliSource() {
  return fs.readFileSync(CLI_PATH, 'utf8');
}

// ──────────────────────────────────────────────────────────────────────
// Plan-shape invariants
// ──────────────────────────────────────────────────────────────────────

test('plan: every pair has at least one source', () => {
  for (const pair of MIGRATION_PAIRS) {
    assert.ok(pair.sources.length > 0, `${pair.label} has zero sources`);
  }
});

test('plan: every source spec is well-formed', () => {
  for (const pair of MIGRATION_PAIRS) {
    for (const s of pair.sources) {
      assert.match(s.sourceInstanceId, /^cin_/, `bad sourceInstanceId: ${s.sourceInstanceId}`);
      assert.equal(typeof s.purgeSourceInstance, 'boolean');
      assert.equal(typeof (s.skipMigration ?? false), 'boolean');
    }
  }
});

test('plan: targetInstanceId either null (retire) or cin_ prefixed', () => {
  for (const pair of MIGRATION_PAIRS) {
    if (pair.targetInstanceId !== null) {
      assert.match(pair.targetInstanceId, /^cin_/);
      assert.equal(typeof pair.targetDisplayName, 'string');
    }
  }
});

test('plan: target ids are distinct across pairs', () => {
  const targets = MIGRATION_PAIRS.map((p) => p.targetInstanceId).filter(Boolean);
  assert.equal(new Set(targets).size, targets.length);
});

test('plan: source ids appear at most once across all pairs', () => {
  const sources = MIGRATION_PAIRS.flatMap((p) => p.sources.map((s) => s.sourceInstanceId));
  assert.equal(new Set(sources).size, sources.length);
});

test('plan: source ids do not overlap target ids', () => {
  const sources = new Set(MIGRATION_PAIRS.flatMap((p) => p.sources.map((s) => s.sourceInstanceId)));
  for (const pair of MIGRATION_PAIRS) {
    if (pair.targetInstanceId) {
      assert.equal(sources.has(pair.targetInstanceId), false,
        `target ${pair.targetInstanceId} also appears as a source`);
    }
  }
});

// ──────────────────────────────────────────────────────────────────────
// Table-list shape invariants
// ──────────────────────────────────────────────────────────────────────

test('table lists: authoritative/rebuild/source-clear/binding/without-cii are pairwise disjoint', () => {
  const lists = [
    ['AUTHORITATIVE_INSTANCE_TABLES', AUTHORITATIVE_INSTANCE_TABLES],
    ['TARGET_REBUILD_PER_STREAM_TABLES', TARGET_REBUILD_PER_STREAM_TABLES],
    ['SOURCE_CLEAR_ONLY_TABLES', SOURCE_CLEAR_ONLY_TABLES],
    ['DEVICE_BINDING_TABLES', DEVICE_BINDING_TABLES],
    ['SCHEMA_TABLES_WITHOUT_CONNECTOR_INSTANCE_ID', SCHEMA_TABLES_WITHOUT_CONNECTOR_INSTANCE_ID],
  ];
  for (let i = 0; i < lists.length; i++) {
    for (let j = i + 1; j < lists.length; j++) {
      const a = new Set(lists[i][1]);
      for (const t of lists[j][1]) {
        assert.equal(a.has(t), false,
          `table "${t}" appears in both ${lists[i][0]} and ${lists[j][0]}`);
      }
    }
  }
});

test('table lists: identifiers look like Postgres identifiers', () => {
  const all = [
    ...AUTHORITATIVE_INSTANCE_TABLES,
    ...TARGET_REBUILD_PER_STREAM_TABLES,
    ...SOURCE_CLEAR_ONLY_TABLES,
    ...DEVICE_BINDING_TABLES,
    ...SCHEMA_TABLES_WITHOUT_CONNECTOR_INSTANCE_ID,
  ];
  for (const t of all) {
    assert.match(t, /^[a-z][a-z0-9_]+$/, `suspicious table identifier: ${t}`);
  }
});

test('table lists: SOURCE_TOUCHED_TABLES is the union of source-side categories', () => {
  const expected = new Set([
    ...AUTHORITATIVE_INSTANCE_TABLES,
    ...SOURCE_CLEAR_ONLY_TABLES,
    ...TARGET_REBUILD_PER_STREAM_TABLES,
    ...DEVICE_BINDING_TABLES,
  ]);
  assert.equal(SOURCE_TOUCHED_TABLES.length, expected.size,
    'SOURCE_TOUCHED_TABLES has duplicates or missing entries');
  for (const t of SOURCE_TOUCHED_TABLES) {
    assert.ok(expected.has(t), `unexpected entry in SOURCE_TOUCHED_TABLES: ${t}`);
  }
});

// ──────────────────────────────────────────────────────────────────────
// Schema assertions — read postgres-storage.js, classify each CREATE TABLE
// ──────────────────────────────────────────────────────────────────────

test('schema: every table in SOURCE_TOUCHED_TABLES actually has connector_instance_id', () => {
  const bodies = parseTableBodies(readPostgresStorageSource());
  for (const t of SOURCE_TOUCHED_TABLES) {
    assert.ok(bodies[t], `postgres-storage.js does not declare CREATE TABLE IF NOT EXISTS ${t}`);
    assert.match(bodies[t], /connector_instance_id/,
      `table "${t}" is listed as per-instance but its CREATE TABLE has no connector_instance_id column`);
  }
});

test('schema: every table in TARGET_REBUILD_PER_STREAM_TABLES has connector_instance_id AND a stream column', () => {
  const bodies = parseTableBodies(readPostgresStorageSource());
  for (const t of TARGET_REBUILD_PER_STREAM_TABLES) {
    assert.ok(bodies[t], `missing CREATE TABLE for ${t}`);
    assert.match(bodies[t], /connector_instance_id/, `${t} has no connector_instance_id`);
    // Either a "stream" column or a "scope_key" column — semantic_search_blob
    // uses scope_key in place of stream, but our cli targets only the
    // canonical stream-keyed ones. Allow scope_key for parity with the
    // semantic blob table.
    assert.ok(
      /\bstream\b/.test(bodies[t]) || /\bscope_key\b/.test(bodies[t]),
      `${t} has neither a stream nor scope_key column — cannot be safely per-stream invalidated`,
    );
  }
});

test('schema: tables we omit from per-instance ops do NOT have connector_instance_id (or are intentional)', () => {
  const bodies = parseTableBodies(readPostgresStorageSource());
  // These are explicitly listed as having no CII column.
  const mustNotHaveCII = ['lexical_search_snapshots', 'semantic_search_snapshots'];
  for (const t of mustNotHaveCII) {
    assert.ok(bodies[t], `missing CREATE TABLE for ${t}`);
    assert.equal(/connector_instance_id/.test(bodies[t]), false,
      `${t} unexpectedly has a connector_instance_id column — re-evaluate classification`);
  }
});

test('schema regression: cli.mjs MUST NOT mention snapshot tables in any DML against connector_instance_id', () => {
  const cli = readCliSource();
  // The bug we are guarding against: any code path that issues
  //   DELETE/SELECT/COUNT FROM lexical_search_snapshots WHERE connector_instance_id = …
  // The snapshot tables have no such column. Forbid any reference in cli.mjs.
  for (const t of ['lexical_search_snapshots', 'semantic_search_snapshots']) {
    assert.equal(cli.includes(t) && /WHERE connector_instance_id/.test(cli) && new RegExp(`${t}[^a-z_]`).test(cli.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')), false,
      `cli.mjs references ${t} outside of comments — this caused the per-instance DELETE bug`);
  }
});

test('schema: SOURCE_CLEAR_ONLY_TABLES are tables we want to drop on source, never copy', () => {
  // controller_active_runs has connector_instance_id as PRIMARY KEY — copying
  // a source row to the target would collide if the target had its own
  // active run. Clear-only is the correct classification.
  const bodies = parseTableBodies(readPostgresStorageSource());
  for (const t of SOURCE_CLEAR_ONLY_TABLES) {
    assert.ok(bodies[t], `missing CREATE TABLE for ${t}`);
    assert.match(bodies[t], /connector_instance_id/, `${t} has no connector_instance_id`);
  }
});

test('schema completeness: every CII-keyed table in postgres-storage.js is classified somewhere', () => {
  const bodies = parseTableBodies(readPostgresStorageSource());
  const ciiKeyed = Object.entries(bodies)
    .filter(([, body]) => /connector_instance_id/.test(body))
    .map(([name]) => name);
  // Explicitly-ignored CII-keyed tables. `blobs` declares
  // connector_instance_id as denormalised metadata, but the row itself
  // is content-addressed by sha256 / blob_id and shared across
  // instances — blob_bindings is the per-instance owner table. We must
  // not delete from `blobs` during instance purge, and we don't copy it
  // either.
  const intentionallyIgnored = new Set([
    'blobs',
    ...SCHEMA_TABLES_WITHOUT_CONNECTOR_INSTANCE_ID,
  ]);
  const classified = new Set([
    ...AUTHORITATIVE_INSTANCE_TABLES,
    ...TARGET_REBUILD_PER_STREAM_TABLES,
    ...SOURCE_CLEAR_ONLY_TABLES,
    ...DEVICE_BINDING_TABLES,
    'connector_instances', // identity row, handled specially
    ...intentionallyIgnored,
  ]);
  const missing = ciiKeyed.filter((t) => !classified.has(t));
  assert.equal(missing.length, 0,
    `postgres-storage.js has CII-keyed tables not classified by plan.mjs: ${missing.join(', ')}`);
});

// ──────────────────────────────────────────────────────────────────────
// CLI behavior tests
// ──────────────────────────────────────────────────────────────────────

test('cli: only uses backup-then-delete sequencing (no DELETE before CREATE TABLE backup)', () => {
  const cli = readCliSource();
  // Sanity check that backup tables are created before any delete pass.
  // The backup statement uses a dynamic `${backupName}` identifier built
  // from `mig_<runId>_…`, so we match the literal prefix string.
  const firstBackup = cli.indexOf('mig_${tableSuffix}');
  const firstDelete = cli.search(/DELETE FROM\s+"/);
  assert.ok(firstBackup > 0, 'expected mig_<runId> backup-table creation in cli.mjs');
  assert.ok(firstDelete > 0, 'expected DELETE FROM statements in cli.mjs');
  assert.ok(firstBackup < firstDelete,
    'first DELETE appears before first backup CREATE TABLE — backup-then-delete ordering broken');
});

test('cli: target-side per-stream invalidation is scoped to invalidated streams only', () => {
  const cli = readCliSource();
  // We expect the invalidation block to use `stream = ANY(...)` against
  // targetInstanceId — not a blanket `DELETE FROM lexical_search_index`.
  assert.match(cli, /stream\s*=\s*ANY\(\$2::text\[\]\)/,
    'expected target search-derived invalidation to be scoped by stream array');
});

test('parseArgs: defaults', () => {
  const original = process.argv;
  process.argv = ['node', 'cli.mjs', 'preview'];
  try {
    const { command, opts } = parseArgs();
    assert.equal(command, 'preview');
    assert.deepEqual(opts, { dryRun: false, confirm: false, json: false });
  } finally {
    process.argv = original;
  }
});

test('parseArgs: --dry-run and --confirm and --json', () => {
  const original = process.argv;
  process.argv = ['node', 'cli.mjs', 'apply', '--dry-run', '--confirm', '--json'];
  try {
    const { command, opts } = parseArgs();
    assert.equal(command, 'apply');
    assert.deepEqual(opts, { dryRun: true, confirm: true, json: true });
  } finally {
    process.argv = original;
  }
});

test('parseArgs: rejects unknown flag', () => {
  const original = process.argv;
  process.argv = ['node', 'cli.mjs', 'apply', '--nope'];
  try {
    assert.throws(() => parseArgs(), /Unknown argument/);
  } finally {
    process.argv = original;
  }
});

test('makeRunId: yyyymmdd_hhmmss UTC shape', () => {
  const id = makeRunId();
  assert.match(id, /^\d{8}_\d{6}$/);
});
