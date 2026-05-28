/**
 * Fixture-backed tests for the canonical connector-key dry-run inspector.
 *
 * Do NOT connect to a database. Each test builds a synthetic driver
 * whose async methods return precomputed rows shaped like the real
 * Postgres responses, then asserts the inspector's report.
 *
 * Run:
 *   node --test reference-implementation/scripts/canonical-connector-keys/inspect.test.mjs
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyConnectorId,
  formatHumanReport,
  inspect,
  JSONB_CONNECTOR_ID_SURFACES,
} from './inspect.mjs';
import { parseArgs } from './cli.mjs';

function makeDriver({ columns = [], distinctByTable = {}, placeholders = [], legacyNames = [], jsonbCounts = {} } = {}) {
  return {
    async listConnectorIdColumns() {
      return columns;
    },
    async countDistinctConnectorIds(table) {
      return distinctByTable[table] ?? [];
    },
    async countSourceBindingPlaceholders() {
      return placeholders;
    },
    async countLegacyDisplayNames() {
      return legacyNames;
    },
    async countJsonbSurfaceRows(table) {
      return jsonbCounts[table] ?? 0;
    },
  };
}

test('classifyConnectorId: maps URL-shaped first-party id to canonical key', () => {
  const c = classifyConnectorId('https://registry.pdpp.org/connectors/gmail');
  assert.equal(c.classification, 'url_first_party');
  assert.equal(c.canonicalKey, 'gmail');
});

test('classifyConnectorId: bare canonical key needs no rewrite', () => {
  const c = classifyConnectorId('gmail');
  assert.equal(c.classification, 'canonical_first_party');
  assert.equal(c.canonicalKey, 'gmail');
});

test('classifyConnectorId: native binding slug stays canonical', () => {
  const c = classifyConnectorId('northstar_hr_native');
  assert.equal(c.classification, 'canonical_native');
  assert.equal(c.canonicalKey, 'northstar_hr_native');
});

test('classifyConnectorId: legacy local-collector alias maps to hyphenated canonical', () => {
  const c = classifyConnectorId('claude_code');
  assert.equal(c.classification, 'canonical_legacy_alias');
  assert.equal(c.canonicalKey, 'claude-code');
});

test('classifyConnectorId: unknown registry URL fails closed', () => {
  const c = classifyConnectorId('https://registry.pdpp.org/connectors/unknown-vendor');
  assert.equal(c.classification, 'unmapped');
  assert.equal(c.canonicalKey, null);
  assert.match(c.reason, /first-party allowlist/);
});

test('classifyConnectorId: arbitrary string fails closed', () => {
  const c = classifyConnectorId('https');
  assert.equal(c.classification, 'unmapped');
  assert.equal(c.canonicalKey, null);
});

test('classifyConnectorId: wrapped local-device unwraps and recurses', () => {
  const c = classifyConnectorId('local-device:claude-code');
  assert.equal(c.classification, 'wrapped_local_device');
  assert.equal(c.canonicalKey, 'claude-code');
  assert.equal(c.inner.classification, 'canonical_first_party');
});

test('classifyConnectorId: wrapped local-device with trailing source-instance id', () => {
  // `codex` is both a legacy snake_case alias AND a canonical key.
  // The bare form `codex` is already canonical, so the inner
  // classification is canonical_first_party.
  const c = classifyConnectorId('local-device:codex:cin_legacy_abc');
  assert.equal(c.classification, 'wrapped_local_device');
  assert.equal(c.canonicalKey, 'codex');
  assert.equal(c.inner.classification, 'canonical_first_party');
});

test('classifyConnectorId: wrapped local-device with legacy snake alias inner', () => {
  const c = classifyConnectorId('local-device:claude_code');
  assert.equal(c.classification, 'wrapped_local_device');
  assert.equal(c.canonicalKey, 'claude-code');
  assert.equal(c.inner.classification, 'canonical_legacy_alias');
});

test('classifyConnectorId: wrapped local-device with unmapped inner fails closed', () => {
  const c = classifyConnectorId('local-device:something-bogus');
  assert.equal(c.classification, 'wrapped_local_device');
  assert.equal(c.canonicalKey, null);
  assert.equal(c.inner.classification, 'unmapped');
});

test('classifyConnectorId: null/empty values are unmapped', () => {
  for (const v of [null, undefined, '', '   ']) {
    const c = classifyConnectorId(v);
    assert.equal(c.classification, 'unmapped');
    assert.equal(c.canonicalKey, null);
  }
});

test('inspect: all-mapped fixture produces no unmapped rows and accurate counts', async () => {
  const driver = makeDriver({
    columns: [
      { table: 'connectors', column: 'connector_id' },
      { table: 'connector_instances', column: 'connector_id' },
      { table: 'records', column: 'connector_id' },
    ],
    distinctByTable: {
      connectors: [
        { value: 'https://registry.pdpp.org/connectors/gmail', count: 1 },
        { value: 'https://registry.pdpp.org/connectors/slack', count: 1 },
        { value: 'northstar_hr_native', count: 1 },
      ],
      connector_instances: [
        { value: 'https://registry.pdpp.org/connectors/gmail', count: 3 },
        { value: 'claude_code', count: 2 },
      ],
      records: [
        { value: 'local-device:claude-code', count: 7 },
        { value: 'https://registry.pdpp.org/connectors/gmail', count: 42 },
      ],
    },
    placeholders: [
      { kind: 'oauth', count: 4 },
      { kind: 'default_account', count: 1 },
    ],
    legacyNames: [{ value: 'default account', count: 1 }],
    jsonbCounts: { grants: 12, grant_packages: 3, grant_package_members: 9, pending_consents: 2, connector_instances: 5 },
  });

  const report = await inspect(driver);

  assert.equal(report.summary.totalUnmappedRows, 0);
  assert.equal(report.summary.hasUnmapped, false);
  assert.equal(report.summary.tablesScanned, 3);
  assert.equal(report.summary.totalRowsTouched, 1 + 1 + 1 + 3 + 2 + 7 + 42);

  // Any stored value that is not byte-equal to its canonical key is a
  // rewrite candidate, including the `local-device:` wrapped storage
  // form (which the canonical-key migration will unwrap).
  // connectors: 1 (gmail url) + 1 (slack url) = 2
  // connector_instances: 3 (gmail url) + 2 (claude_code alias) = 5
  // records: 7 (local-device:claude-code → claude-code)
  //          + 42 (gmail url) = 49
  // total = 2 + 5 + 49 = 56.
  assert.equal(report.summary.totalRewriteRows, 56);

  const connectorInstancesTable = report.tables.find((t) => t.table === 'connector_instances');
  const legacyAliasRow = connectorInstancesTable.distinct.find((r) => r.value === 'claude_code');
  assert.equal(legacyAliasRow.classification, 'canonical_legacy_alias');
  assert.equal(legacyAliasRow.canonicalKey, 'claude-code');
  assert.equal(legacyAliasRow.rewriteRequired, true);

  const recordsTable = report.tables.find((t) => t.table === 'records');
  const wrappedRow = recordsTable.distinct.find((r) => r.value === 'local-device:claude-code');
  assert.equal(wrappedRow.classification, 'wrapped_local_device');
  assert.equal(wrappedRow.unmapped, false);

  assert.deepEqual(
    report.sourceBindingPlaceholders.find((p) => p.kind === 'default_account'),
    { kind: 'default_account', count: 1 },
  );
  assert.equal(report.legacyDisplayNames[0].value, 'default account');

  // JSONB surface counts are reported but not classified deeply.
  const grantsSurface = report.jsonbSurfaces.find((s) => s.table === 'grants' && s.column === 'grant_json');
  assert.equal(grantsSurface.rowCount, 12);
});

test('inspect: ambiguous wrapped-local-device + unknown URL fixture surfaces fail-closed counts', async () => {
  const driver = makeDriver({
    columns: [
      { table: 'connector_instances', column: 'connector_id' },
      { table: 'records', column: 'connector_id' },
    ],
    distinctByTable: {
      connector_instances: [
        // Three URL-shaped rows for a connector slug we never shipped.
        { value: 'https://registry.pdpp.org/connectors/mystery', count: 3 },
        // Legitimate canonical alias coexisting with the URL form.
        { value: 'claude_code', count: 4 },
      ],
      records: [
        // Wrapped local-device whose inner slug is not in the allowlist.
        { value: 'local-device:something-bogus', count: 2 },
        // Garbled value that does not even look like a registry URL.
        { value: 'https', count: 1 },
      ],
    },
  });

  const report = await inspect(driver);

  assert.equal(report.summary.hasUnmapped, true);
  // 3 (mystery URL) + 2 (wrapped bogus) + 1 (https) = 6 unmapped rows.
  assert.equal(report.summary.totalUnmappedRows, 6);

  const records = report.tables.find((t) => t.table === 'records');
  const wrappedBogus = records.distinct.find((r) => r.value === 'local-device:something-bogus');
  assert.equal(wrappedBogus.classification, 'wrapped_local_device');
  assert.equal(wrappedBogus.unmapped, true);
  assert.equal(wrappedBogus.inner.classification, 'unmapped');

  const ci = report.tables.find((t) => t.table === 'connector_instances');
  const mystery = ci.distinct.find((r) => r.value.endsWith('/mystery'));
  assert.equal(mystery.classification, 'unmapped');
  assert.match(mystery.reason, /first-party allowlist/);
});

test('inspect: produces a stable human report containing every section', async () => {
  const driver = makeDriver({
    columns: [{ table: 'connector_instances', column: 'connector_id' }],
    distinctByTable: {
      connector_instances: [{ value: 'gmail', count: 1 }],
    },
    placeholders: [{ kind: 'default_account', count: 1 }],
    legacyNames: [{ value: 'legacy', count: 1 }],
    jsonbCounts: {
      grants: 1,
      grant_packages: 1,
      grant_package_members: 1,
      pending_consents: 1,
      connector_instances: 1,
    },
  });

  const report = await inspect(driver);
  const human = formatHumanReport(report);
  assert.match(human, /canonical connector-key migration — dry-run/);
  assert.match(human, /connector_instances\.connector_id/);
  assert.match(human, /source_binding_json\.kind/);
  assert.match(human, /display_name placeholders/);
  assert.match(human, /jsonb surfaces requiring deeper write-migration sweep/);
  assert.match(human, /grants\.grant_json/);
});

test('inspect: tables list is exhaustive when no columns are returned', async () => {
  const report = await inspect(makeDriver({}));
  assert.equal(report.summary.tablesScanned, 0);
  assert.equal(report.summary.hasUnmapped, false);
  assert.equal(report.summary.totalUnmappedRows, 0);
});

test('parseArgs: defaults', () => {
  const { command, opts } = parseArgs(['node', 'cli.mjs', 'inspect']);
  assert.equal(command, 'inspect');
  assert.equal(opts.json, false);
  assert.equal(opts.allowUnmapped, false);
});

test('parseArgs: --json and --allow-unmapped', () => {
  const { command, opts } = parseArgs(['node', 'cli.mjs', 'inspect', '--json', '--allow-unmapped']);
  assert.equal(command, 'inspect');
  assert.equal(opts.json, true);
  assert.equal(opts.allowUnmapped, true);
});

test('parseArgs: throws on unknown flag', () => {
  assert.throws(() => parseArgs(['node', 'cli.mjs', 'inspect', '--write']), /Unknown argument/);
});

test('JSONB_CONNECTOR_ID_SURFACES enumerates the known JSONB sites', () => {
  const tables = JSONB_CONNECTOR_ID_SURFACES.map((s) => s.table);
  assert.ok(tables.includes('grants'));
  assert.ok(tables.includes('grant_packages'));
  assert.ok(tables.includes('grant_package_members'));
  assert.ok(tables.includes('pending_consents'));
  assert.ok(tables.includes('connector_instances'));
});
