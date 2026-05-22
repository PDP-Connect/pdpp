/**
 * Static checks for the migration script: argument parser, plan shape,
 * and table-name invariants. Does not connect to a database.
 *
 * Run: node --test reference-implementation/scripts/migrate-active-connection-data/migrate-active-connection-data.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { MIGRATION_PAIRS, AUTHORITATIVE_INSTANCE_TABLES, DERIVED_INSTANCE_TABLES } from './plan.mjs';
import { parseArgs, makeRunId } from './cli.mjs';

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

test('table lists: authoritative and derived sets are disjoint', () => {
  const a = new Set(AUTHORITATIVE_INSTANCE_TABLES);
  for (const t of DERIVED_INSTANCE_TABLES) {
    assert.equal(a.has(t), false, `${t} is in both AUTHORITATIVE and DERIVED lists`);
  }
});

test('table lists: authoritative table names look like Postgres identifiers', () => {
  for (const t of [...AUTHORITATIVE_INSTANCE_TABLES, ...DERIVED_INSTANCE_TABLES]) {
    assert.match(t, /^[a-z][a-z0-9_]+$/, `suspicious table identifier: ${t}`);
  }
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
