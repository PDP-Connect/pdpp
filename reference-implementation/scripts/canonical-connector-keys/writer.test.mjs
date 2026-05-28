/**
 * Fixture-backed tests for the canonical connector-key writer
 * (`writer.mjs`, OpenSpec change `canonicalize-connector-keys`, tasks
 * §3.3 and §3.4).
 *
 * Do NOT connect to a database. Each test builds a synthetic
 * in-memory driver whose rows shadow what the real Postgres tables
 * would return, then asserts that:
 *
 *   - URL-shaped first-party ids in direct `connector_id` columns are
 *     rewritten to canonical keys;
 *   - JSONB-embedded connector ids are rewritten through the same
 *     mapping (per shape in `JSONB_REWRITE_SHAPES`);
 *   - `local-device:<inner>[:<source_instance_id>]` wrappers are
 *     rewritten on the inner connector key only and preserve the
 *     wrapper + trailing source-instance segment;
 *   - any unmapped active-tier value aborts before any write;
 *   - backup/scratch tables are skipped by default and rewritten only
 *     with `--include-backup-tables` (scratch is never rewritten);
 *   - row counts are preserved on every touched table;
 *   - a mid-flight failure rolls the transaction back to its
 *     pre-migration snapshot.
 *
 * Run:
 *   node --test reference-implementation/scripts/canonical-connector-keys/writer.test.mjs
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyPlan,
  formatApplyResult,
  JSONB_REWRITE_SHAPES,
  migrate,
  planFromReport,
  rewriteStoredValue,
} from './writer.mjs';

const GMAIL_URL = 'https://registry.pdpp.org/connectors/gmail';
const SLACK_URL = 'https://registry.pdpp.org/connectors/slack';
const UNKNOWN_URL = 'https://registry.pdpp.org/connectors/unknown-vendor';

/**
 * Build an in-memory driver around `tables` of the shape:
 *   {
 *     <tableName>: {
 *       columns: { connector_id?: string, ... },  // column → column type tag (only used for hasColumn lookups)
 *       primaryKey: string[],
 *       rows: Array<Record<string, unknown>>,
 *     }
 *   }
 *
 * The driver is intentionally minimal: it implements just enough of the
 * inspector + writer driver surface to drive `migrate()` end to end.
 *
 * Transaction support is implemented by taking a deep snapshot of every
 * table at `beginTransaction()` and restoring on `rollback()`. The
 * snapshot is discarded on `commit()`.
 */
function makeMemoryDriver(initialState, options = {}) {
  // Deep clone so each test's mutations are isolated.
  let tables = structuredClone(initialState);
  let txSnapshot = null;
  const { onAfterColumnUpdate, onAfterJsonbUpdate } = options;

  function getTable(name) {
    const t = tables[name];
    if (!t) throw new Error(`memoryDriver: unknown table ${name}`);
    return t;
  }

  function pkMatches(row, pkCols, pkValues) {
    for (let i = 0; i < pkCols.length; i++) {
      if (row[pkCols[i]] !== pkValues[i]) return false;
    }
    return true;
  }

  return {
    // Inspector surface ----------------------------------------------------
    async listConnectorIdColumns() {
      const out = [];
      for (const [tableName, def] of Object.entries(tables)) {
        if (def.columns?.connector_id) {
          out.push({ table: tableName, column: 'connector_id' });
        }
      }
      out.sort((a, b) => a.table.localeCompare(b.table));
      return out;
    },
    async countDistinctConnectorIds(tableName) {
      const t = getTable(tableName);
      const counts = new Map();
      for (const row of t.rows) {
        const v = row.connector_id;
        if (v === undefined) continue;
        counts.set(v, (counts.get(v) ?? 0) + 1);
      }
      return [...counts.entries()]
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
    },
    async countSourceBindingPlaceholders() {
      return [];
    },
    async countLegacyDisplayNames() {
      return [];
    },
    async hasColumn(tableName, columnName) {
      const t = tables[tableName];
      return !!(t && t.columns && t.columns[columnName]);
    },
    async readJsonbColumn(tableName, columnName) {
      const t = getTable(tableName);
      return t.rows.map((r) => r[columnName]).filter((v) => v !== null && v !== undefined);
    },
    async countTableRows(tableName) {
      return tables[tableName]?.rows.length ?? 0;
    },

    // Writer surface -------------------------------------------------------
    async beginTransaction() {
      if (txSnapshot !== null) throw new Error('beginTransaction: nested');
      txSnapshot = structuredClone(tables);
    },
    async commit() {
      if (txSnapshot === null) throw new Error('commit: no transaction');
      txSnapshot = null;
    },
    async rollback() {
      if (txSnapshot === null) return;
      tables = txSnapshot;
      txSnapshot = null;
    },
    async updateConnectorIdColumn(tableName, columnName, oldValue, newValue) {
      const t = getTable(tableName);
      let count = 0;
      for (const row of t.rows) {
        if (row[columnName] === oldValue) {
          row[columnName] = newValue;
          count += 1;
        }
      }
      if (onAfterColumnUpdate) {
        await onAfterColumnUpdate({ tableName, columnName, oldValue, newValue, count });
      }
      return count;
    },
    async readJsonbRowsWithPk(tableName, pkCols, jsonbCol) {
      const t = getTable(tableName);
      const out = [];
      for (const row of t.rows) {
        const value = row[jsonbCol];
        if (value === null || value === undefined) continue;
        out.push({ pk: pkCols.map((c) => row[c]), value });
      }
      return out;
    },
    async updateJsonbRow(tableName, pkCols, pkValues, jsonbCol, newJson) {
      const t = getTable(tableName);
      let count = 0;
      for (const row of t.rows) {
        if (pkMatches(row, pkCols, pkValues)) {
          row[jsonbCol] = newJson;
          count += 1;
        }
      }
      if (onAfterJsonbUpdate) {
        await onAfterJsonbUpdate({ tableName, pkCols, pkValues, jsonbCol, newJson, count });
      }
      return count;
    },

    // Test peek helper
    _tables() {
      return tables;
    },
  };
}

// --- rewriteStoredValue --------------------------------------------------

test('rewriteStoredValue: URL-shaped first-party id → canonical bare key', () => {
  assert.equal(rewriteStoredValue(GMAIL_URL), 'gmail');
  assert.equal(rewriteStoredValue(SLACK_URL), 'slack');
});

test('rewriteStoredValue: bare canonical key is unchanged', () => {
  assert.equal(rewriteStoredValue('gmail'), 'gmail');
});

test('rewriteStoredValue: legacy snake_case alias → canonical hyphen form', () => {
  assert.equal(rewriteStoredValue('claude_code'), 'claude-code');
});

test('rewriteStoredValue: wrapped local-device unwraps inner only', () => {
  assert.equal(rewriteStoredValue('local-device:claude_code'), 'local-device:claude-code');
  assert.equal(rewriteStoredValue('local-device:claude-code'), 'local-device:claude-code');
});

test('rewriteStoredValue: wrapped local-device preserves trailing source_instance_id', () => {
  assert.equal(
    rewriteStoredValue('local-device:claude_code:cin_legacy_abc'),
    'local-device:claude-code:cin_legacy_abc',
  );
  // Already canonical inner — trailing segment still preserved.
  assert.equal(
    rewriteStoredValue('local-device:codex:cin_xyz'),
    'local-device:codex:cin_xyz',
  );
});

test('rewriteStoredValue: unmapped value returns null (caller must abort, never rewrite)', () => {
  assert.equal(rewriteStoredValue(UNKNOWN_URL), null);
  assert.equal(rewriteStoredValue('https'), null);
  assert.equal(rewriteStoredValue('local-device:bogus-vendor'), null);
  assert.equal(rewriteStoredValue(null), null);
  assert.equal(rewriteStoredValue(''), null);
});

// --- planFromReport ------------------------------------------------------

test('planFromReport: skips unmapped and unchanged values', () => {
  const report = {
    tables: [
      {
        table: 'connectors',
        column: 'connector_id',
        surfaceClass: 'active',
        distinct: [
          { value: 'gmail', count: 1, rewriteRequired: false, unmapped: false },
          { value: GMAIL_URL, count: 4, rewriteRequired: true, unmapped: false },
          { value: UNKNOWN_URL, count: 3, rewriteRequired: false, unmapped: true },
        ],
      },
    ],
    summary: {},
  };
  const plan = planFromReport(report);
  assert.equal(plan.columnRewrites.length, 1);
  assert.equal(plan.columnRewrites[0].oldValue, GMAIL_URL);
  assert.equal(plan.columnRewrites[0].newValue, 'gmail');
  assert.equal(plan.columnRewrites[0].expectedRows, 4);
});

test('planFromReport: skips backup tier by default; --include-backup-tables opts in', () => {
  const report = {
    tables: [
      {
        table: 'connectors',
        column: 'connector_id',
        surfaceClass: 'active',
        distinct: [{ value: GMAIL_URL, count: 1, rewriteRequired: true, unmapped: false }],
      },
      {
        table: 'backup_20260526_connectors',
        column: 'connector_id',
        surfaceClass: 'backup',
        distinct: [{ value: GMAIL_URL, count: 7, rewriteRequired: true, unmapped: false }],
      },
      {
        table: 'cleanup_20260526_synth',
        column: 'connector_id',
        surfaceClass: 'scratch',
        distinct: [{ value: GMAIL_URL, count: 9, rewriteRequired: true, unmapped: false }],
      },
    ],
    summary: {},
  };

  const planDefault = planFromReport(report);
  assert.equal(planDefault.columnRewrites.length, 1);
  assert.equal(planDefault.columnRewrites[0].table, 'connectors');
  assert.equal(planDefault.skipped.backupRowsColumns, 7);
  assert.equal(planDefault.skipped.scratchRowsColumns, 9);

  const planWithBackup = planFromReport(report, { includeBackupTables: true });
  const tables = planWithBackup.columnRewrites.map((r) => r.table).sort();
  assert.deepEqual(tables, ['backup_20260526_connectors', 'connectors']);
  // Scratch remains skipped even with --include-backup-tables.
  assert.equal(planWithBackup.skipped.scratchRowsColumns, 9);
  assert.equal(planWithBackup.skipped.backupRowsColumns, 0);
});

// --- migrate: end-to-end --------------------------------------------------

function buildAllMappedState() {
  return {
    connectors: {
      columns: { connector_id: 'text' },
      primaryKey: ['connector_id'],
      rows: [
        { connector_id: GMAIL_URL, name: 'Gmail manifest' },
        { connector_id: 'claude_code', name: 'Claude Code legacy alias' },
      ],
    },
    connector_instances: {
      columns: { connector_id: 'text' },
      primaryKey: ['instance_id'],
      rows: [
        { instance_id: 'cin_1', connector_id: GMAIL_URL },
        { instance_id: 'cin_2', connector_id: GMAIL_URL },
        { instance_id: 'cin_3', connector_id: 'claude_code' },
      ],
    },
    records: {
      columns: { connector_id: 'text' },
      primaryKey: ['record_id'],
      rows: [
        { record_id: 'rec_1', connector_id: GMAIL_URL },
        { record_id: 'rec_2', connector_id: GMAIL_URL },
        { record_id: 'rec_3', connector_id: 'local-device:claude_code' },
        { record_id: 'rec_4', connector_id: 'local-device:claude_code:cin_legacy_abc' },
        { record_id: 'rec_5', connector_id: 'northstar_hr_native' },
      ],
    },
    grants: {
      columns: { connector_id: 'text', grant_json: 'jsonb', storage_binding_json: 'jsonb' },
      primaryKey: ['grant_id'],
      rows: [
        {
          grant_id: 'gnt_1',
          connector_id: GMAIL_URL,
          grant_json: { source: { kind: 'connector', id: GMAIL_URL }, scope: ['email:read'] },
          storage_binding_json: { connector_id: GMAIL_URL, connection_id: 'cnx_1' },
        },
        {
          grant_id: 'gnt_2',
          connector_id: 'claude_code',
          grant_json: { source: { kind: 'connector', id: 'claude_code' }, scope: ['messages:read'] },
          storage_binding_json: { connector_id: 'claude_code', connection_id: 'cnx_2' },
        },
        {
          grant_id: 'gnt_native',
          connector_id: 'northstar_hr_native',
          grant_json: { source: { kind: 'provider_native', id: 'northstar_hr_native' }, scope: [] },
          storage_binding_json: { connector_id: 'northstar_hr_native', connection_id: 'cnx_3' },
        },
      ],
    },
    grant_package_members: {
      columns: { source_json: 'jsonb' },
      primaryKey: ['package_id', 'grant_id'],
      rows: [
        {
          package_id: 'pkg_1',
          grant_id: 'gnt_1',
          source_json: { kind: 'connector', id: GMAIL_URL, connection_id: 'cnx_1' },
        },
        {
          package_id: 'pkg_1',
          grant_id: 'gnt_2',
          source_json: { kind: 'connector', id: 'local-device:claude_code', connection_id: 'cnx_2' },
        },
      ],
    },
    pending_consents: {
      columns: { params_json: 'jsonb' },
      primaryKey: ['device_code'],
      rows: [
        {
          device_code: 'dev_1',
          params_json: {
            source_binding: { kind: 'connector', id: GMAIL_URL },
            storage_binding: { connector_id: GMAIL_URL },
            other_field: 'preserved',
          },
        },
      ],
    },
  };
}

test('migrate: dry-run plan (no --apply) makes no writes', async () => {
  const state = buildAllMappedState();
  const driver = makeMemoryDriver(state);
  const before = structuredClone(driver._tables());

  const result = await migrate(driver, { apply: false });
  assert.equal(result.applied, null);
  assert.ok(result.plan.columnRewrites.length > 0);
  assert.deepEqual(driver._tables(), before);
});

test('migrate: --apply rewrites URL-shaped first-party ids in direct columns', async () => {
  const driver = makeMemoryDriver(buildAllMappedState());
  await migrate(driver, { apply: true });

  const connectors = driver._tables().connectors.rows;
  assert.equal(connectors.find((r) => r.name === 'Gmail manifest').connector_id, 'gmail');
  const ci = driver._tables().connector_instances.rows;
  assert.equal(ci.filter((r) => r.connector_id === 'gmail').length, 2);
  assert.equal(ci.find((r) => r.instance_id === 'cin_3').connector_id, 'claude-code');
});

test('migrate: --apply rewrites JSONB embedded connector_ids through the same mapping', async () => {
  const driver = makeMemoryDriver(buildAllMappedState());
  await migrate(driver, { apply: true });

  const grants = driver._tables().grants.rows;
  const gnt1 = grants.find((r) => r.grant_id === 'gnt_1');
  assert.equal(gnt1.grant_json.source.id, 'gmail');
  assert.equal(gnt1.storage_binding_json.connector_id, 'gmail');
  assert.deepEqual(gnt1.grant_json.scope, ['email:read'], 'unrelated json fields must be preserved');

  const gnt2 = grants.find((r) => r.grant_id === 'gnt_2');
  assert.equal(gnt2.grant_json.source.id, 'claude-code');
  assert.equal(gnt2.storage_binding_json.connector_id, 'claude-code');

  const gntNative = grants.find((r) => r.grant_id === 'gnt_native');
  assert.equal(gntNative.grant_json.source.id, 'northstar_hr_native', 'native binding stays canonical');

  const member = driver._tables().grant_package_members.rows.find(
    (r) => r.package_id === 'pkg_1' && r.grant_id === 'gnt_2',
  );
  assert.equal(
    member.source_json.id,
    'local-device:claude-code',
    'wrapped local-device id inside JSONB rewrites inner key only',
  );
  assert.equal(member.source_json.connection_id, 'cnx_2', 'unrelated JSONB fields preserved');

  const pc = driver._tables().pending_consents.rows[0];
  assert.equal(pc.params_json.source_binding.id, 'gmail');
  assert.equal(pc.params_json.storage_binding.connector_id, 'gmail');
  assert.equal(pc.params_json.other_field, 'preserved');
});

test('migrate: --apply rewrites local-device wrappers preserving the inner-only swap', async () => {
  const driver = makeMemoryDriver(buildAllMappedState());
  await migrate(driver, { apply: true });

  const records = driver._tables().records.rows;
  const wrapped = records.find((r) => r.record_id === 'rec_3');
  assert.equal(wrapped.connector_id, 'local-device:claude-code');

  const wrappedWithSourceInstance = records.find((r) => r.record_id === 'rec_4');
  assert.equal(
    wrappedWithSourceInstance.connector_id,
    'local-device:claude-code:cin_legacy_abc',
    'trailing :source_instance_id segment is preserved',
  );

  const native = records.find((r) => r.record_id === 'rec_5');
  assert.equal(native.connector_id, 'northstar_hr_native', 'already-canonical rows are untouched');
});

test('migrate: row counts are preserved on every touched table', async () => {
  const driver = makeMemoryDriver(buildAllMappedState());
  const before = {
    connectors: driver._tables().connectors.rows.length,
    connector_instances: driver._tables().connector_instances.rows.length,
    records: driver._tables().records.rows.length,
    grants: driver._tables().grants.rows.length,
    grant_package_members: driver._tables().grant_package_members.rows.length,
    pending_consents: driver._tables().pending_consents.rows.length,
  };

  const result = await migrate(driver, { apply: true });

  for (const t of Object.keys(before)) {
    assert.equal(driver._tables()[t].rows.length, before[t], `row count for ${t} must be preserved`);
  }
  // Snapshot reported on the result mirrors what we observed.
  for (const t of Object.keys(result.applied.rowCounts.before)) {
    assert.equal(result.applied.rowCounts.before[t], result.applied.rowCounts.after[t]);
  }
});

test('migrate: unmapped active value aborts before any write', async () => {
  const state = buildAllMappedState();
  // Inject one unmapped URL in an active-tier table.
  state.records.rows.push({ record_id: 'rec_unmapped', connector_id: UNKNOWN_URL });
  const driver = makeMemoryDriver(state);
  const before = structuredClone(driver._tables());

  await assert.rejects(
    () => migrate(driver, { apply: true }),
    /refusing to write — unmapped/i,
  );

  assert.deepEqual(driver._tables(), before, 'no rows mutated when the migration is aborted');
});

test('migrate: --allow-unmapped bypasses the fail-closed check but never rewrites the unmapped row', async () => {
  const state = buildAllMappedState();
  state.records.rows.push({ record_id: 'rec_unmapped', connector_id: UNKNOWN_URL });
  const driver = makeMemoryDriver(state);

  await migrate(driver, { apply: true, allowUnmapped: true });

  const records = driver._tables().records.rows;
  // The unmapped row is left exactly as-is.
  assert.equal(records.find((r) => r.record_id === 'rec_unmapped').connector_id, UNKNOWN_URL);
  // Mapped rows around it still rewrite.
  assert.equal(records.find((r) => r.record_id === 'rec_1').connector_id, 'gmail');
});

test('migrate: backup tables are skipped by default and rewritten only with --include-backup-tables', async () => {
  const state = buildAllMappedState();
  state.backup_20260526_records = {
    columns: { connector_id: 'text' },
    primaryKey: ['record_id'],
    rows: [
      { record_id: 'brec_1', connector_id: GMAIL_URL },
      { record_id: 'brec_2', connector_id: GMAIL_URL },
    ],
  };
  state.cleanup_20260526_synth = {
    columns: { connector_id: 'text' },
    primaryKey: ['record_id'],
    rows: [
      { record_id: 'srec_1', connector_id: GMAIL_URL },
    ],
  };

  // Default run — backup/scratch untouched.
  const driverDefault = makeMemoryDriver(state);
  await migrate(driverDefault, { apply: true });
  assert.equal(driverDefault._tables().backup_20260526_records.rows[0].connector_id, GMAIL_URL);
  assert.equal(driverDefault._tables().cleanup_20260526_synth.rows[0].connector_id, GMAIL_URL);
  // Active rows rewrite as usual.
  assert.equal(driverDefault._tables().records.rows.find((r) => r.record_id === 'rec_1').connector_id, 'gmail');

  // With --include-backup-tables, backup rows rewrite. Scratch is still skipped.
  const driverIncludeBackup = makeMemoryDriver(state);
  await migrate(driverIncludeBackup, { apply: true, includeBackupTables: true });
  for (const r of driverIncludeBackup._tables().backup_20260526_records.rows) {
    assert.equal(r.connector_id, 'gmail');
  }
  assert.equal(driverIncludeBackup._tables().cleanup_20260526_synth.rows[0].connector_id, GMAIL_URL);
});

test('migrate: backup-tier unmapped rows do not block default writes', async () => {
  const state = buildAllMappedState();
  state.backup_20260526_records = {
    columns: { connector_id: 'text' },
    primaryKey: ['record_id'],
    rows: [{ record_id: 'brec_unmapped', connector_id: UNKNOWN_URL }],
  };
  const driver = makeMemoryDriver(state);

  await migrate(driver, { apply: true });

  // Active rewrites applied; backup left alone (including its unmapped row).
  assert.equal(driver._tables().records.rows.find((r) => r.record_id === 'rec_1').connector_id, 'gmail');
  assert.equal(driver._tables().backup_20260526_records.rows[0].connector_id, UNKNOWN_URL);
});

test('migrate: backup-tier unmapped rows DO block writes when --include-backup-tables is set', async () => {
  const state = buildAllMappedState();
  state.backup_20260526_records = {
    columns: { connector_id: 'text' },
    primaryKey: ['record_id'],
    rows: [{ record_id: 'brec_unmapped', connector_id: UNKNOWN_URL }],
  };
  const driver = makeMemoryDriver(state);
  const before = structuredClone(driver._tables());

  await assert.rejects(
    () => migrate(driver, { apply: true, includeBackupTables: true }),
    /refusing to write — unmapped/i,
  );
  assert.deepEqual(driver._tables(), before);
});

test('applyPlan: mid-flight column failure rolls the transaction back', async () => {
  const driver = makeMemoryDriver(buildAllMappedState(), {
    onAfterColumnUpdate: ({ tableName }) => {
      if (tableName === 'records') {
        throw new Error('simulated mid-flight failure');
      }
    },
  });
  const before = structuredClone(driver._tables());

  await assert.rejects(() => migrate(driver, { apply: true }), /simulated mid-flight failure/);
  assert.deepEqual(
    driver._tables(),
    before,
    'partial column rewrites must roll back to the pre-migration snapshot',
  );
});

test('applyPlan: mid-flight JSONB failure rolls the transaction back', async () => {
  const driver = makeMemoryDriver(buildAllMappedState(), {
    onAfterJsonbUpdate: ({ tableName }) => {
      if (tableName === 'grants') {
        throw new Error('simulated jsonb failure');
      }
    },
  });
  const before = structuredClone(driver._tables());

  await assert.rejects(() => migrate(driver, { apply: true }), /simulated jsonb failure/);
  assert.deepEqual(driver._tables(), before, 'partial jsonb rewrites must roll back');
});

test('applyPlan: column UPDATE that affects fewer rows than expected fails fast', async () => {
  // Build a driver whose updateConnectorIdColumn lies about row counts.
  const state = buildAllMappedState();
  const driver = makeMemoryDriver(state);
  const originalUpdate = driver.updateConnectorIdColumn.bind(driver);
  driver.updateConnectorIdColumn = async (table, column, oldValue, newValue) => {
    await originalUpdate(table, column, oldValue, newValue);
    return 0; // pretend nothing was updated
  };

  await assert.rejects(
    () => migrate(driver, { apply: true }),
    /column rewrite affected 0 rows, expected/,
  );
});

test('migrate: idempotent — running twice has no net effect on the second run', async () => {
  const driver = makeMemoryDriver(buildAllMappedState());
  await migrate(driver, { apply: true });
  const after1 = structuredClone(driver._tables());

  const result2 = await migrate(driver, { apply: true });
  assert.deepEqual(driver._tables(), after1, 'second migration is a no-op');
  assert.equal(result2.plan.columnRewrites.length, 0);
});

test('migrate: existing JSONB rows without connector_id are left untouched', async () => {
  const driver = makeMemoryDriver({
    grants: {
      columns: { connector_id: 'text', grant_json: 'jsonb', storage_binding_json: 'jsonb' },
      primaryKey: ['grant_id'],
      rows: [
        // grant_json with kind=='other' should not be extracted nor rewritten.
        {
          grant_id: 'gnt_other',
          connector_id: 'gmail',
          grant_json: { source: { kind: 'other', id: 'anything' } },
          storage_binding_json: null,
        },
      ],
    },
  });
  await migrate(driver, { apply: true });
  const row = driver._tables().grants.rows[0];
  assert.equal(row.grant_json.source.kind, 'other');
  assert.equal(row.grant_json.source.id, 'anything');
});

// --- JSONB_REWRITE_SHAPES surface inventory ------------------------------

test('JSONB_REWRITE_SHAPES enumerates the same surfaces as JSONB_CONNECTOR_ID_SHAPES (extract parity)', async () => {
  const { JSONB_CONNECTOR_ID_SHAPES } = await import('./inspect.mjs');
  const writerSites = JSONB_REWRITE_SHAPES.map((s) => `${s.table}.${s.column}`).sort();
  const readerSites = JSONB_CONNECTOR_ID_SHAPES.map((s) => `${s.table}.${s.column}`).sort();
  assert.deepEqual(writerSites, readerSites, 'reader and writer JSONB shapes must agree');
  for (const s of JSONB_REWRITE_SHAPES) {
    assert.equal(typeof s.apply, 'function');
    assert.ok(Array.isArray(s.primaryKey) && s.primaryKey.length > 0);
  }
});

test('formatApplyResult: includes column rewrites, jsonb surfaces, and row-count parity', async () => {
  const driver = makeMemoryDriver(buildAllMappedState());
  const result = await migrate(driver, { apply: true });
  const human = formatApplyResult(result.applied);
  assert.match(human, /canonical connector-key migration — applied/);
  assert.match(human, /rows=\d+/);
  assert.match(human, /jsonb surfaces:/);
  assert.match(human, /row counts \(before \/ after, must match\):/);
});
