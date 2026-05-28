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
  classifyTableSurface,
  formatHumanReport,
  inspect,
  JSONB_CONNECTOR_ID_SHAPES,
  JSONB_NON_EXTRACTED_SURFACES,
  quotePgIdentifier,
} from './inspect.mjs';
import { parseArgs } from './cli.mjs';

function makeDriver({
  columns = [],
  distinctByTable = {},
  placeholders = [],
  legacyNames = [],
  jsonbRowsBySurface = {},
  missingJsonbSurfaces = new Set(),
  jsonbTableRowCounts = {},
} = {}) {
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
    async hasColumn(table, column) {
      return !missingJsonbSurfaces.has(`${table}.${column}`);
    },
    async readJsonbColumn(table, column) {
      return jsonbRowsBySurface[`${table}.${column}`] ?? [];
    },
    async countTableRows(table) {
      return jsonbTableRowCounts[table] ?? 0;
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

test('classifyTableSurface: cleanup_ prefix → scratch', () => {
  assert.equal(classifyTableSurface('cleanup_20260526_synthetic_records'), 'scratch');
  assert.equal(classifyTableSurface('cleanup_20260101_test'), 'scratch');
});

test('classifyTableSurface: backup_ prefix → backup', () => {
  assert.equal(classifyTableSurface('backup_20260526_codex_source_replay_records'), 'backup');
  assert.equal(classifyTableSurface('backup_20260101_anything'), 'backup');
});

test('classifyTableSurface: compact_*_backup_ pattern → backup', () => {
  assert.equal(classifyTableSurface('compact_record_history_backup_1779829900930_969063'), 'backup');
  assert.equal(classifyTableSurface('compact_record_changes_backup_1779832748470_726455'), 'backup');
});

test('classifyTableSurface: everything else → active', () => {
  for (const name of ['connectors', 'connector_instances', 'grants', 'records', 'record_changes', 'retained_size_connection', 'retained_size_stream', 'pending_consents']) {
    assert.equal(classifyTableSurface(name), 'active');
  }
});

test('classifyTableSurface: backup_ prefix requires 8-digit date segment', () => {
  // No date segment → active, not backup
  assert.equal(classifyTableSurface('backup_anything'), 'active');
  // Only 7 digits → active
  assert.equal(classifyTableSurface('backup_2026052_test'), 'active');
});

test('classifyTableSurface: cleanup_ prefix requires 8-digit date segment', () => {
  assert.equal(classifyTableSurface('cleanup_anything'), 'active');
  assert.equal(classifyTableSurface('cleanup_2026052_test'), 'active');
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
    jsonbTableRowCounts: { grant_packages: 3, connector_instances: 5 },
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
  assert.equal(report.summary.totalRewriteRowsColumns, 56);
  assert.equal(report.summary.totalRewriteRowsJsonb, 0);
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

  // No JSONB rows supplied → every extracted surface reports zero.
  for (const s of report.jsonbSurfaces) {
    assert.equal(s.extractedCount, 0);
    assert.equal(s.unmappedRowCount, 0);
  }
  const grantPackages = report.nonExtractedJsonbSurfaces.find((s) => s.table === 'grant_packages');
  assert.equal(grantPackages.rowCount, 3);
  assert.equal(grantPackages.present, true);
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
  assert.equal(report.summary.totalUnmappedRowsColumns, 6);
  assert.equal(report.summary.totalUnmappedRowsJsonb, 0);

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

test('inspect: jsonb extractor classifies embedded mapped + unmapped connector_ids', async () => {
  const driver = makeDriver({
    columns: [],
    jsonbRowsBySurface: {
      'grants.grant_json': [
        // Mapped: provider_native source.
        { source: { kind: 'provider_native', id: 'northstar_hr_native' } },
        // Mapped: URL-shaped first-party slug in the allowlist.
        { source: { kind: 'connector', id: 'https://registry.pdpp.org/connectors/gmail' } },
        { source: { kind: 'connector', id: 'https://registry.pdpp.org/connectors/gmail' } },
        // Other kinds (no source.id) are skipped, not failed.
        { source: { kind: 'other', id: 'something' } },
        // Missing/null source → no extraction.
        {},
        null,
      ],
      'grants.storage_binding_json': [
        { connector_id: 'https://registry.pdpp.org/connectors/gmail' },
        { connector_id: 'claude_code' },
        // Null storage_binding → no extraction.
        { connector_id: null },
      ],
      'grant_package_members.source_json': [
        { kind: 'connector', id: 'local-device:claude-code', connection_id: 'cnx_abc' },
        { kind: 'provider_native', id: 'northstar_hr_native' },
      ],
      'pending_consents.params_json': [
        {
          source_binding: { kind: 'connector', id: 'https://registry.pdpp.org/connectors/slack' },
          storage_binding: { connector_id: 'https://registry.pdpp.org/connectors/slack' },
        },
      ],
    },
  });

  const report = await inspect(driver);

  // No unmapped rows in this fixture: every embedded value is in the
  // canonical allowlist (or wraps a value that is).
  assert.equal(report.summary.totalUnmappedRowsJsonb, 0);
  assert.equal(report.summary.hasUnmapped, false);

  const grantJson = report.jsonbSurfaces.find((s) => s.table === 'grants' && s.column === 'grant_json');
  assert.equal(grantJson.present, true);
  assert.equal(grantJson.rowsScanned, 6);
  // Three extractions: northstar_hr_native, gmail URL ×2.
  assert.equal(grantJson.extractedCount, 3);
  assert.equal(grantJson.distinctCount, 2);
  const gmailRow = grantJson.distinct.find((d) => d.value.endsWith('/gmail'));
  assert.equal(gmailRow.path, '$.source.id');
  assert.equal(gmailRow.classification, 'url_first_party');
  assert.equal(gmailRow.canonicalKey, 'gmail');
  assert.equal(gmailRow.rewriteRequired, true);

  const storageJson = report.jsonbSurfaces.find((s) => s.column === 'storage_binding_json');
  assert.equal(storageJson.extractedCount, 2);
  const aliasRow = storageJson.distinct.find((d) => d.value === 'claude_code');
  assert.equal(aliasRow.classification, 'canonical_legacy_alias');
  assert.equal(aliasRow.canonicalKey, 'claude-code');

  const memberJson = report.jsonbSurfaces.find((s) => s.table === 'grant_package_members');
  assert.equal(memberJson.extractedCount, 2);
  const wrapped = memberJson.distinct.find((d) => d.value === 'local-device:claude-code');
  assert.equal(wrapped.classification, 'wrapped_local_device');
  assert.equal(wrapped.canonicalKey, 'claude-code');
  assert.equal(wrapped.unmapped, false);

  const paramsJson = report.jsonbSurfaces.find((s) => s.table === 'pending_consents');
  // Two paths extracted from one row: source_binding.id + storage_binding.connector_id.
  assert.equal(paramsJson.extractedCount, 2);
  assert.equal(paramsJson.distinctCount, 2);
  const paths = paramsJson.distinct.map((d) => d.path).sort();
  assert.deepEqual(paths, ['$.source_binding.id', '$.storage_binding.connector_id']);
});

test('inspect: jsonb extractor fails closed on unmapped embedded identifiers', async () => {
  const driver = makeDriver({
    columns: [],
    jsonbRowsBySurface: {
      'grants.grant_json': [
        // Unmapped URL-shaped slug inside the source binding.
        { source: { kind: 'connector', id: 'https://registry.pdpp.org/connectors/unknown' } },
        { source: { kind: 'connector', id: 'https://registry.pdpp.org/connectors/unknown' } },
      ],
      'grants.storage_binding_json': [
        // Wrapped local-device with bogus inner.
        { connector_id: 'local-device:totally-bogus-vendor' },
      ],
      'pending_consents.params_json': [
        // Garbled identifier on the source_binding path.
        { source_binding: { kind: 'connector', id: 'https' }, storage_binding: { connector_id: 'gmail' } },
      ],
    },
  });

  const report = await inspect(driver);

  assert.equal(report.summary.hasUnmapped, true);
  // 2 (grant_json) + 1 (storage_binding wrapped bogus) + 1 (params_json source_binding 'https')
  assert.equal(report.summary.totalUnmappedRowsJsonb, 4);
  // The mapped storage_binding 'gmail' in params_json should not count as unmapped.
  const params = report.jsonbSurfaces.find((s) => s.table === 'pending_consents');
  const stg = params.distinct.find((d) => d.path === '$.storage_binding.connector_id');
  assert.equal(stg.classification, 'canonical_first_party');
  assert.equal(stg.unmapped, false);

  const grantJson = report.jsonbSurfaces.find((s) => s.column === 'grant_json');
  const unknown = grantJson.distinct[0];
  assert.equal(unknown.classification, 'unmapped');
  assert.equal(unknown.count, 2);
});

test('inspect: missing JSONB columns on the deployment are reported but do not throw', async () => {
  const driver = makeDriver({
    columns: [],
    missingJsonbSurfaces: new Set([
      'grants.grant_json',
      'grants.storage_binding_json',
      'grant_package_members.source_json',
      'pending_consents.params_json',
      'grant_packages.package_json',
      'connector_instances.source_binding_json',
    ]),
  });
  const report = await inspect(driver);
  for (const s of report.jsonbSurfaces) {
    assert.equal(s.present, false);
    assert.equal(s.extractedCount, 0);
  }
  for (const s of report.nonExtractedJsonbSurfaces) {
    assert.equal(s.present, false);
    assert.equal(s.rowCount, 0);
  }
});

test('inspect: produces a stable human report containing every section', async () => {
  const driver = makeDriver({
    columns: [{ table: 'connector_instances', column: 'connector_id' }],
    distinctByTable: {
      connector_instances: [{ value: 'gmail', count: 1 }],
    },
    placeholders: [{ kind: 'default_account', count: 1 }],
    legacyNames: [{ value: 'legacy', count: 1 }],
    jsonbRowsBySurface: {
      'grants.grant_json': [
        { source: { kind: 'connector', id: 'https://registry.pdpp.org/connectors/gmail' } },
      ],
    },
    jsonbTableRowCounts: { grant_packages: 1, connector_instances: 1 },
  });

  const report = await inspect(driver);
  const human = formatHumanReport(report);
  assert.match(human, /canonical connector-key migration — dry-run/);
  assert.match(human, /connector_instances\.connector_id/);
  assert.match(human, /source_binding_json\.kind/);
  assert.match(human, /display_name placeholders/);
  assert.match(human, /jsonb embedded connector_id extraction/);
  assert.match(human, /grants\.grant_json/);
  assert.match(human, /\$\.source\.id=https:\/\/registry\.pdpp\.org\/connectors\/gmail/);
  assert.match(human, /no embedded connector_id/);
  assert.match(human, /grant_packages\.package_json/);
  // Status line should reflect active-table gate
  assert.match(human, /OK — no unmapped rows in active tables/);
  // Tables section should be grouped by tier
  assert.match(human, /tables — active/);
});

test('formatHumanReport: backup/scratch warn label and active FAIL label are correct', async () => {
  const driver = makeDriver({
    columns: [
      { table: 'connectors', column: 'connector_id' },
      { table: 'backup_20260526_records', column: 'connector_id' },
    ],
    distinctByTable: {
      connectors: [
        { value: 'https://registry.pdpp.org/connectors/unknown-active', count: 2 },
      ],
      backup_20260526_records: [
        { value: 'pg_runtime_1234', count: 1 },
      ],
    },
  });
  const report = await inspect(driver);
  const human = formatHumanReport(report);
  assert.match(human, /FAIL — active tables have unmapped rows/);
  assert.match(human, /WARN.*backup\/scratch.*not blocking/);
  assert.match(human, /tables — active/);
  assert.match(human, /tables — backup/);
});

test('inspect: tables list is exhaustive when no columns are returned', async () => {
  const report = await inspect(makeDriver({}));
  assert.equal(report.summary.tablesScanned, 0);
  assert.equal(report.summary.hasUnmapped, false);
  assert.equal(report.summary.totalUnmappedRows, 0);
  assert.equal(report.summary.hasUnmappedActive, false);
  assert.equal(report.summary.totalUnmappedRowsActive, 0);
  assert.equal(report.summary.totalUnmappedRowsBackup, 0);
  assert.equal(report.summary.totalUnmappedRowsScratch, 0);
});

test('inspect: surfaceClass is set on each table entry', async () => {
  const driver = makeDriver({
    columns: [
      { table: 'connectors', column: 'connector_id' },
      { table: 'backup_20260526_records', column: 'connector_id' },
      { table: 'cleanup_20260526_synthetic_records', column: 'connector_id' },
      { table: 'compact_record_history_backup_1779829900930_969063', column: 'connector_id' },
    ],
    distinctByTable: {
      connectors: [{ value: 'gmail', count: 1 }],
      backup_20260526_records: [{ value: 'gmail', count: 5 }],
      cleanup_20260526_synthetic_records: [{ value: 'gmail', count: 3 }],
      compact_record_history_backup_1779829900930_969063: [{ value: 'gmail', count: 10 }],
    },
  });
  const report = await inspect(driver);
  const byTable = Object.fromEntries(report.tables.map((t) => [t.table, t.surfaceClass]));
  assert.equal(byTable['connectors'], 'active');
  assert.equal(byTable['backup_20260526_records'], 'backup');
  assert.equal(byTable['cleanup_20260526_synthetic_records'], 'scratch');
  assert.equal(byTable['compact_record_history_backup_1779829900930_969063'], 'backup');
});

test('inspect: unmapped rows in backup/scratch do not set hasUnmappedActive', async () => {
  const driver = makeDriver({
    columns: [
      { table: 'backup_20260526_records', column: 'connector_id' },
      { table: 'cleanup_20260526_synthetic_records', column: 'connector_id' },
    ],
    distinctByTable: {
      backup_20260526_records: [
        { value: 'https://registry.pdpp.org/connectors/unknown-backup', count: 5 },
      ],
      cleanup_20260526_synthetic_records: [
        { value: 'pg_runtime_1234567890_scratch', count: 3 },
      ],
    },
  });
  const report = await inspect(driver);
  assert.equal(report.summary.hasUnmapped, true);
  assert.equal(report.summary.totalUnmappedRows, 8);
  assert.equal(report.summary.hasUnmappedActive, false);
  assert.equal(report.summary.totalUnmappedRowsActive, 0);
  assert.equal(report.summary.totalUnmappedRowsBackup, 5);
  assert.equal(report.summary.totalUnmappedRowsScratch, 3);
});

test('inspect: unmapped rows in active tables set hasUnmappedActive', async () => {
  const driver = makeDriver({
    columns: [
      { table: 'connectors', column: 'connector_id' },
      { table: 'backup_20260526_records', column: 'connector_id' },
    ],
    distinctByTable: {
      connectors: [
        { value: 'https://registry.pdpp.org/connectors/unknown-active', count: 5 },
      ],
      backup_20260526_records: [
        { value: 'https://registry.pdpp.org/connectors/unknown-backup', count: 3 },
      ],
    },
  });
  const report = await inspect(driver);
  assert.equal(report.summary.hasUnmappedActive, true);
  assert.equal(report.summary.totalUnmappedRowsActive, 5);
  assert.equal(report.summary.totalUnmappedRowsBackup, 3);
  assert.equal(report.summary.totalUnmappedRowsScratch, 0);
  assert.equal(report.summary.totalUnmappedRows, 8);
});

test('inspect: JSONB unmapped rows count toward totalUnmappedRowsActive', async () => {
  const driver = makeDriver({
    columns: [],
    jsonbRowsBySurface: {
      'grants.grant_json': [
        { source: { kind: 'connector', id: 'https://registry.pdpp.org/connectors/unknown' } },
      ],
    },
  });
  const report = await inspect(driver);
  assert.equal(report.summary.hasUnmappedActive, true);
  assert.equal(report.summary.totalUnmappedRowsActive, 1);
  assert.equal(report.summary.totalUnmappedRowsBackup, 0);
  assert.equal(report.summary.totalUnmappedRowsScratch, 0);
});

test('parseArgs: defaults', () => {
  const { command, opts } = parseArgs(['node', 'cli.mjs', 'inspect']);
  assert.equal(command, 'inspect');
  assert.equal(opts.json, false);
  assert.equal(opts.allowUnmapped, false);
  assert.equal(opts.includeBackupTables, false);
});

test('parseArgs: --json and --allow-unmapped', () => {
  const { command, opts } = parseArgs(['node', 'cli.mjs', 'inspect', '--json', '--allow-unmapped']);
  assert.equal(command, 'inspect');
  assert.equal(opts.json, true);
  assert.equal(opts.allowUnmapped, true);
  assert.equal(opts.includeBackupTables, false);
});

test('parseArgs: --include-backup-tables is parsed and defaults false', () => {
  const { command, opts } = parseArgs(['node', 'cli.mjs', 'inspect', '--include-backup-tables']);
  assert.equal(command, 'inspect');
  assert.equal(opts.includeBackupTables, true);
});

test('parseArgs: throws on unknown flag', () => {
  assert.throws(() => parseArgs(['node', 'cli.mjs', 'inspect', '--write']), /Unknown argument/);
});

test('JSONB_CONNECTOR_ID_SHAPES enumerates the known JSONB sites with extractors', () => {
  const sites = JSONB_CONNECTOR_ID_SHAPES.map((s) => `${s.table}.${s.column}`).sort();
  assert.deepEqual(sites, [
    'grant_package_members.source_json',
    'grants.grant_json',
    'grants.storage_binding_json',
    'pending_consents.params_json',
  ]);
  for (const s of JSONB_CONNECTOR_ID_SHAPES) {
    assert.equal(typeof s.extract, 'function');
  }
});

test('JSONB_NON_EXTRACTED_SURFACES lists informational sites with row counts only', () => {
  const sites = JSONB_NON_EXTRACTED_SURFACES.map((s) => `${s.table}.${s.column}`).sort();
  assert.deepEqual(sites, [
    'connector_instances.source_binding_json',
    'grant_packages.package_json',
  ]);
});

test('quotePgIdentifier: wraps a plain identifier in double-quotes', () => {
  assert.equal(quotePgIdentifier('connector_instances'), '"connector_instances"');
  assert.equal(quotePgIdentifier('grants'), '"grants"');
});

test('quotePgIdentifier: escapes embedded double-quotes by doubling them', () => {
  // If a (hypothetical) information_schema row ever surfaced a table
  // name containing a double-quote, naive `"${id}"` interpolation
  // would split the SQL string. The helper must escape it instead.
  assert.equal(quotePgIdentifier('weird"name'), '"weird""name"');
  assert.equal(quotePgIdentifier('a"b"c'), '"a""b""c"');
  // Round-trip parity: the unescaped form recovers the original.
  const escaped = quotePgIdentifier('a"b"c');
  const unwrapped = escaped.slice(1, -1).replace(/""/g, '"');
  assert.equal(unwrapped, 'a"b"c');
});

test('quotePgIdentifier: rejects empty / non-string / null-byte identifiers', () => {
  assert.throws(() => quotePgIdentifier(''), /non-empty string/);
  assert.throws(() => quotePgIdentifier(null), /non-empty string/);
  assert.throws(() => quotePgIdentifier(123), /non-empty string/);
  assert.throws(() => quotePgIdentifier('a\0b'), /null byte/);
});
