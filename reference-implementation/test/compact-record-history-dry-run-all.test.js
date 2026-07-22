// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the read-only batch dry-run wrapper
 * `compact-record-history-dry-run-all.mjs`.
 *
 * All pure: scope resolution, table formatting, and the DB-backed
 * functions are exercised against a fake pool so no Postgres is required.
 * The wrapper deliberately has no `--apply` path; the safety assertion
 * here is that it only ever calls the read-only `planCompaction` and a
 * SELECT-only pool.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { COMPACTION_POLICIES } from '../scripts/compact-record-history.mjs';
import {
  formatDryRunTable,
  listConnectionsWithPolicies,
  parseArgs,
  policiesForConnector,
  resolveConnectorId,
  runDryRuns,
  totalRemovableVersions,
} from '../scripts/compact-record-history-dry-run-all.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Fake pool ──────────────────────────────────────────────────────────

/**
 * Minimal pg-compatible fake. `handlers` is an array of
 * {match(sqlLower) -> bool, rows} probed in order. Records every query so
 * a test can assert no mutation SQL was issued.
 */
function fakePool(handlers) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql, params });
      for (const h of handlers) {
        if (h.match(sql.toLowerCase())) {
          return { rows: typeof h.rows === 'function' ? h.rows(params) : h.rows };
        }
      }
      return { rows: [] };
    },
    async end() {},
  };
}

// ─── parseArgs ────────────────────────────────────────────────────────────

test('parseArgs parses flags and key=value', () => {
  const args = parseArgs(['--all', '--connector-instance-id=cin_1', '--json']);
  assert.equal(args.all, true);
  assert.equal(args['connector-instance-id'], 'cin_1');
  assert.equal(args.json, true);
});

// ─── policiesForConnector ─────────────────────────────────────────────────

test('policiesForConnector returns every registered policy for a connector_id', () => {
  const usaa = policiesForConnector('cin_usaa', 'usaa');
  const streams = usaa.map((s) => s.stream).sort();
  // From the registry: accounts, credit_card_billing, inbox_messages, statements, transactions.
  assert.deepEqual(streams, ['accounts', 'credit_card_billing', 'inbox_messages', 'statements', 'transactions']);
  for (const scope of usaa) {
    assert.equal(scope.connectorInstanceId, 'cin_usaa');
    assert.equal(scope.connectorId, 'usaa');
    assert.ok(scope.policy, 'each scope carries its policy');
  }
});

test('policiesForConnector matches registry-URL connector ids too', () => {
  const byUrl = policiesForConnector('cin_gmail', 'https://registry.pdpp.org/connectors/gmail');
  const streams = byUrl.map((s) => s.stream).sort();
  // gmail registry policies: threads, labels.
  assert.deepEqual(streams, ['labels', 'threads']);
});

test('policiesForConnector returns empty for a connector with no policy', () => {
  assert.deepEqual(policiesForConnector('cin_x', 'no-such-connector'), []);
});

test('policiesForConnector matches claude-code (hyphen) connector id', () => {
  // The live DB uses connector_id = 'claude-code' (hyphen). An earlier version of
  // the policy builder used 'claude_code' (underscore), which never matched and
  // silently excluded all claude-code instances from --all scans.
  const cc = policiesForConnector('cin_cc', 'claude-code');
  const streams = cc.map((s) => s.stream).sort();
  assert.deepEqual(streams, [
    'attachments',
    'backup_inventory',
    'cache_inventory',
    'config_inventory',
    'file_history',
    'memory_notes',
    'messages',
    'sessions',
    'skills',
    'slash_commands',
  ]);
  for (const scope of cc) {
    assert.equal(scope.connectorInstanceId, 'cin_cc');
    assert.equal(scope.connectorId, 'claude-code');
  }
});

// ─── resolveConnectorId ────────────────────────────────────────────────────

test('resolveConnectorId reads connector_id from connector_instances', async () => {
  const pool = fakePool([
    { match: (s) => s.includes('from connector_instances'), rows: [{ connector_id: 'usaa' }] },
  ]);
  assert.equal(await resolveConnectorId(pool, 'cin_usaa'), 'usaa');
});

test('resolveConnectorId returns null for an unknown connection', async () => {
  const pool = fakePool([
    { match: (s) => s.includes('from connector_instances'), rows: [] },
  ]);
  assert.equal(await resolveConnectorId(pool, 'cin_missing'), null);
});

// ─── listConnectionsWithPolicies ───────────────────────────────────────────

test('listConnectionsWithPolicies passes only policy-eligible connector ids', async () => {
  let capturedParams = null;
  const pool = fakePool([
    {
      match: (s) => s.includes('from connector_instances'),
      rows: (params) => {
        capturedParams = params;
        return [
          { connector_instance_id: 'cin_usaa', connector_id: 'usaa' },
          { connector_instance_id: 'cin_gmail', connector_id: 'gmail' },
        ];
      },
    },
  ]);
  const conns = await listConnectionsWithPolicies(pool);
  assert.equal(conns.length, 2);
  // The IN-list is the union of every registered connectorIds entry.
  const expected = new Set(COMPACTION_POLICIES.flatMap((p) => p.connectorIds));
  assert.deepEqual(new Set(capturedParams[0]), expected);
});

// ─── runDryRuns ────────────────────────────────────────────────────────────

test('runDryRuns calls the injected plan fn once per scope and never mutates', async () => {
  const pool = fakePool([]); // planFn is injected, so the pool is untouched here
  const planCalls = [];
  const planFn = async ({ connectorInstanceId, stream }) => {
    planCalls.push({ connectorInstanceId, stream });
    return {
      scannedKeys: 3,
      scannedVersions: 30,
      removableVersions: stream === 'statements' ? 27 : 0,
      estimatedRemovedBytes: stream === 'statements' ? 5400 : 0,
      connectorIdsSeen: ['usaa'],
    };
  };
  const scopes = policiesForConnector('cin_usaa', 'usaa');
  const rows = await runDryRuns({ pool, scopes, planFn });

  // usaa now has 5 registered policies: accounts, credit_card_billing, inbox_messages, statements, transactions.
  assert.equal(rows.length, 5);
  assert.equal(planCalls.length, 5);
  assert.equal(totalRemovableVersions(rows), 27);
  // No SQL issued through the pool by runDryRuns itself.
  assert.equal(pool.queries.length, 0);
});

test('runDryRuns records a per-scope error instead of throwing', async () => {
  const planFn = async ({ stream }) => {
    if (stream === 'accounts') throw new Error('relation record_changes missing');
    return { scannedVersions: 10, removableVersions: 0, estimatedRemovedBytes: 0, connectorIdsSeen: ['usaa'] };
  };
  const scopes = policiesForConnector('cin_usaa', 'usaa');
  const rows = await runDryRuns({ pool: fakePool([]), scopes, planFn });
  const errored = rows.find((r) => r.error);
  assert.ok(errored, 'an errored scope is present');
  assert.equal(errored.stream, 'accounts');
  assert.match(errored.error, /record_changes missing/);
  // Other 4 scopes (credit_card_billing, inbox_messages, statements, transactions) still planned.
  assert.equal(rows.filter((r) => !r.error).length, 4);
});

// ─── formatDryRunTable / totalRemovableVersions ────────────────────────────

test('formatDryRunTable renders aligned rows including errors', () => {
  const rows = [
    {
      connectorInstanceId: 'cin_usaa',
      connectorId: 'usaa',
      stream: 'statements',
      plan: { scannedVersions: 30, removableVersions: 27, estimatedRemovedBytes: 5400, connectorIdsSeen: ['usaa'] },
    },
    { connectorInstanceId: 'cin_usaa', connectorId: 'usaa', stream: 'accounts', error: 'boom' },
  ];
  const table = formatDryRunTable(rows);
  assert.match(table, /connection/);
  assert.match(table, /statements/);
  assert.match(table, /27/);
  assert.match(table, /ERROR/);
  assert.match(table, /boom/);
});

test('totalRemovableVersions sums non-error rows only', () => {
  const rows = [
    { plan: { removableVersions: 27 } },
    { plan: { removableVersions: 5 } },
    { error: 'x' },
  ];
  assert.equal(totalRemovableVersions(rows), 32);
});

// ─── No-apply / no-mutation static guard ───────────────────────────────────

test('the wrapper source contains no DELETE/INSERT/UPDATE and no --apply wiring', () => {
  const src = readFileSync(
    path.resolve(__dirname, '..', 'scripts', 'compact-record-history-dry-run-all.mjs'),
    'utf8',
  );
  // No write SQL anywhere in the wrapper.
  assert.doesNotMatch(src, /\b(DELETE|INSERT|UPDATE)\b/i, 'wrapper issues no write SQL');
  // It must not import or call applyCompaction.
  assert.doesNotMatch(src, /applyCompaction/, 'wrapper never references applyCompaction');
  // --apply is explicitly refused, not honored.
  assert.match(src, /does not support --apply/, 'wrapper explicitly refuses --apply');
});

test('compaction utilities are safe to import from node -e contexts', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  for (const rel of [
    'reference-implementation/scripts/compact-record-history.mjs',
    'reference-implementation/scripts/compact-record-history-dry-run-all.mjs',
  ]) {
    const child = spawnSync(
      process.execPath,
      ['-e', `import('./${rel}').then(() => console.log('ok'))`],
      { cwd: repoRoot, encoding: 'utf8' },
    );
    assert.equal(child.status, 0, `${rel} import failed: ${child.stderr || child.stdout}`);
    assert.match(child.stdout, /ok/);
    assert.doesNotMatch(child.stderr, /usage:|PDPP_DATABASE_URL|compact-record-history failed/i);
  }
});
