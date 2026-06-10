/**
 * canonical-connector-keys / writer.mjs
 *
 * Write-mode companion to `inspect.mjs` (`openspec/changes/
 * canonicalize-connector-keys/`, tasks §3.3). Rewrites every active
 * connector identifier from URL/legacy aliases to canonical
 * `connector_key` form across:
 *
 *   - direct `connector_id` columns on every table that owns one
 *     (discovered via information_schema, classified by surface tier);
 *   - the known JSONB surfaces that embed `connector_id` inside
 *     structured payloads (`grants.grant_json`, `grants.storage_binding_json`,
 *     `grant_package_members.source_json`, `pending_consents.params_json`).
 *
 * Design constraints (from `design.md` §3 and the worker contract):
 *   - dry-run-first: refuse to write if any active-table value is unmapped;
 *   - fail-closed: bail before writes if any unmapped active value remains;
 *   - backup/scratch tables are scanned but NOT rewritten unless the caller
 *     explicitly opts in with `--include-backup-tables` (scratch is never
 *     rewritten — those tables are ephemeral test scaffolding);
 *   - local-device wrappers collapse to the canonical connector key; the
 *     configured source/device distinction belongs on `connector_instance_id`
 *     and source binding metadata, not in `connector_id`;
 *   - row counts MUST be preserved for every touched table except
 *     intentional `connectors` parent-row collapse when multiple old ids
 *     map to one canonical key.
 *
 * All writes happen inside a single transaction so a mid-flight failure
 * rolls back to the pre-migration snapshot.
 */

import {
  classifyConnectorId,
  inspect,
  makePostgresDriver,
  quotePgIdentifier,
} from './inspect.mjs';

const CONNECTOR_SOURCE_KINDS = new Set(['connector', 'provider_native']);

/**
 * Return the canonical storage form for a `connector_id` value. The
 * function rewrites:
 *
 *   - URL-shaped first-party ids (`https://registry.pdpp.org/connectors/gmail` → `gmail`);
 *   - legacy snake_case aliases (`claude_code` → `claude-code`);
 *   - wrapped local-device forms, removing the wrapper and optional
 *     trailing `:source_instance_id` segment (e.g. `local-device:claude_code`
 *     → `claude-code`, `local-device:claude_code:cin_legacy_abc`
 *     → `claude-code`).
 *
 * Returns `null` when the value is unmapped (caller MUST treat that as
 * an abort condition — the migration plan never rewrites unmapped
 * values, and the top-level `migrate` entry refuses to start when any
 * active surface contains an unmapped row).
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function rewriteStoredValue(value) {
  if (typeof value !== 'string') return null;
  const classification = classifyConnectorId(value);
  if (classification.classification === 'unmapped') return null;
  if (classification.canonicalKey === null) return null;

  return classification.canonicalKey;
}

/**
 * JSONB rewrite shapes — one per (table, jsonb column) surface known to
 * embed `connector_id` values. Each `apply(json)` returns a new JSON
 * object with all embedded identifiers rewritten via `rewriteStoredValue`,
 * or `null` when the row needs no change. `primaryKey` is the column
 * list the writer uses for `UPDATE … WHERE`.
 *
 * The shapes intentionally mirror `inspect.mjs::JSONB_CONNECTOR_ID_SHAPES`
 * — extraction (read) and apply (write) share the same path semantics.
 *
 * Sites NOT listed here (because they carry no embedded `connector_id`
 * — see `inspect.mjs::JSONB_NON_EXTRACTED_SURFACES`):
 *   - `grant_packages.package_json`
 *   - `connector_instances.source_binding_json`
 */
export const JSONB_REWRITE_SHAPES = Object.freeze([
  {
    table: 'grants',
    column: 'grant_json',
    primaryKey: Object.freeze(['grant_id']),
    apply(json) {
      if (!json?.source || !CONNECTOR_SOURCE_KINDS.has(json.source.kind)) return null;
      if (typeof json.source.id !== 'string') return null;
      const next = rewriteStoredValue(json.source.id);
      if (next === null || next === json.source.id) return null;
      return { ...json, source: { ...json.source, id: next } };
    },
  },
  {
    table: 'grants',
    column: 'storage_binding_json',
    primaryKey: Object.freeze(['grant_id']),
    apply(json) {
      if (typeof json?.connector_id !== 'string') return null;
      const next = rewriteStoredValue(json.connector_id);
      if (next === null || next === json.connector_id) return null;
      return { ...json, connector_id: next };
    },
  },
  {
    table: 'grant_package_members',
    column: 'source_json',
    primaryKey: Object.freeze(['package_id', 'grant_id']),
    apply(json) {
      if (!json || !CONNECTOR_SOURCE_KINDS.has(json.kind)) return null;
      if (typeof json.id !== 'string') return null;
      const next = rewriteStoredValue(json.id);
      if (next === null || next === json.id) return null;
      return { ...json, id: next };
    },
  },
  {
    table: 'pending_consents',
    column: 'params_json',
    primaryKey: Object.freeze(['device_code']),
    apply(json) {
      if (!json || typeof json !== 'object') return null;
      let next = json;
      const sb = json.source_binding;
      if (sb && CONNECTOR_SOURCE_KINDS.has(sb.kind) && typeof sb.id === 'string') {
        const sbNext = rewriteStoredValue(sb.id);
        if (sbNext !== null && sbNext !== sb.id) {
          next = { ...next, source_binding: { ...sb, id: sbNext } };
        }
      }
      const stg = next.storage_binding;
      if (stg && typeof stg.connector_id === 'string') {
        const stgNext = rewriteStoredValue(stg.connector_id);
        if (stgNext !== null && stgNext !== stg.connector_id) {
          next = { ...next, storage_binding: { ...stg, connector_id: stgNext } };
        }
      }
      return next === json ? null : next;
    },
  },
]);

/**
 * Build a write plan from an inspection report.
 *
 * The plan never includes unmapped rows. Backup-tier rows are included
 * only when `options.includeBackupTables` is true; scratch-tier rows are
 * always skipped (those tables are ephemeral test scaffolding and the
 * migration deliberately leaves them alone).
 *
 * @param {ReturnType<typeof inspect>} report
 * @param {{ includeBackupTables?: boolean }} [options]
 */
export function planFromReport(report, options = {}) {
  const includeBackup = !!options.includeBackupTables;
  const allowedTiers = includeBackup ? new Set(['active', 'backup']) : new Set(['active']);

  const columnRewrites = [];
  const skipped = { backupRowsColumns: 0, scratchRowsColumns: 0 };
  for (const tableEntry of report.tables) {
    const tier = tableEntry.surfaceClass;
    for (const distinct of tableEntry.distinct) {
      if (!distinct.rewriteRequired) continue;
      if (distinct.unmapped) continue;
      if (!allowedTiers.has(tier)) {
        if (tier === 'backup') skipped.backupRowsColumns += distinct.count;
        else if (tier === 'scratch') skipped.scratchRowsColumns += distinct.count;
        continue;
      }
      const newValue = rewriteStoredValue(distinct.value);
      if (newValue === null || newValue === distinct.value) continue;
      columnRewrites.push({
        table: tableEntry.table,
        column: tableEntry.column,
        surfaceClass: tier,
        oldValue: distinct.value,
        newValue,
        expectedRows: distinct.count,
      });
    }
  }

  return {
    columnRewrites,
    jsonbSurfaces: JSONB_REWRITE_SHAPES.map((s) => ({
      table: s.table,
      column: s.column,
      primaryKey: s.primaryKey,
      apply: s.apply,
    })),
    options: { includeBackupTables: includeBackup },
    skipped,
  };
}

async function snapshotRowCounts(driver, plan) {
  const tables = new Set();
  for (const r of plan.columnRewrites) tables.add(r.table);
  for (const s of plan.jsonbSurfaces) tables.add(s.table);
  const counts = {};
  for (const t of tables) {
    counts[t] = await driver.countTableRows(t);
  }
  return counts;
}

function splitConnectorParentRewrites(columnRewrites) {
  const parent = [];
  const rest = [];
  for (const r of columnRewrites) {
    if (r.table === 'connectors' && r.column === 'connector_id') {
      parent.push(r);
    } else {
      rest.push(r);
    }
  }
  return { parent, rest };
}

function chooseConnectorParentSource(newValue, rewrites) {
  const registrySource = `https://registry.pdpp.org/connectors/${newValue}`;
  return (
    rewrites.find((r) => r.oldValue === registrySource) ??
    [...rewrites].sort((a, b) => String(a.oldValue).localeCompare(String(b.oldValue)))[0]
  );
}

function groupConnectorParentRewrites(parentRewrites) {
  const byNewValue = new Map();
  for (const r of parentRewrites) {
    const rewrites = byNewValue.get(r.newValue) ?? [];
    rewrites.push(r);
    byNewValue.set(r.newValue, rewrites);
  }
  return [...byNewValue.entries()].map(([newValue, rewrites]) => ({
    newValue,
    rewrites,
    source: chooseConnectorParentSource(newValue, rewrites),
  }));
}

/**
 * Apply a plan inside a single transaction. Driver must extend the
 * read-only inspector driver with:
 *
 *   - `beginTransaction()` / `commit()` / `rollback()`
 *   - `connectorParentRowExists(connectorId) → boolean`
 *   - `upsertConnectorParentRow(oldValue, newValue) → rowCount`
 *   - `deleteConnectorParentRow(oldValue) → rowCount`
 *   - `updateConnectorIdColumn(table, column, oldValue, newValue) → rowCount`
 *   - `readJsonbRowsWithPk(table, pkCols, jsonbColumn) → [{ pk, value }]`
 *   - `updateJsonbRow(table, pkCols, pkValues, jsonbColumn, newJson) → rowCount`
 *
 * The function:
 *   1. opens a transaction;
 *   2. snapshots the row count of every touched table;
 *   3. upserts rewritten `connectors.connector_id` parent rows to their
 *      canonical key before child FKs are updated; many old ids may collapse
 *      into one canonical parent, in which case the registry URL source wins;
 *   4. runs each non-parent `UPDATE … WHERE column = oldValue` and verifies the
 *      affected row count equals the expected count from the dry-run;
 *   5. for each JSONB surface that exists, reads every row with the
 *      JSONB column populated, computes the new payload via `shape.apply`,
 *      and updates per primary key (each update MUST affect exactly one
 *      row);
 *   6. deletes the old `connectors.connector_id` parent rows once children
 *      no longer reference them;
 *   7. re-snapshots the row count of every touched table and asserts
 *      it is unchanged except for intentional parent connector row collapse;
 *   8. commits.
 *
 * Any error rolls back. A row-count mismatch (column or per-row JSONB)
 * is treated as a failure and rolled back.
 */
export async function applyPlan(driver, plan) {
  await driver.beginTransaction();
  try {
    const before = await snapshotRowCounts(driver, plan);
    const { parent: connectorParentRewrites, rest: ordinaryColumnRewrites } =
      splitConnectorParentRewrites(plan.columnRewrites);
    const connectorParentGroups = groupConnectorParentRewrites(connectorParentRewrites);
    let connectorRowDelta = 0;

    for (const group of connectorParentGroups) {
      const existed = await driver.connectorParentRowExists(group.newValue);
      const affected = await driver.upsertConnectorParentRow(group.source.oldValue, group.newValue);
      if (affected !== 1) {
        throw new Error(
          `applyPlan: connector parent upsert affected ${affected} rows, expected 1 ` +
            `for connectors.connector_id ${JSON.stringify(group.source.oldValue)} → ` +
            `${JSON.stringify(group.newValue)}`,
        );
      }
      if (!existed) connectorRowDelta += 1;
    }

    const columnsApplied = [];
    for (const r of ordinaryColumnRewrites) {
      const affected = await driver.updateConnectorIdColumn(
        r.table,
        r.column,
        r.oldValue,
        r.newValue,
      );
      if (affected !== r.expectedRows) {
        throw new Error(
          `applyPlan: column rewrite affected ${affected} rows, expected ${r.expectedRows} ` +
            `for ${r.table}.${r.column} ${JSON.stringify(r.oldValue)} → ${JSON.stringify(r.newValue)}`,
        );
      }
      columnsApplied.push({ ...r, actualRows: affected });
    }

    const jsonbApplied = [];
    for (const shape of plan.jsonbSurfaces) {
      const exists = await driver.hasColumn(shape.table, shape.column);
      if (!exists) {
        jsonbApplied.push({
          table: shape.table,
          column: shape.column,
          present: false,
          rowsUpdated: 0,
        });
        continue;
      }
      const rows = await driver.readJsonbRowsWithPk(shape.table, shape.primaryKey, shape.column);
      let rowsUpdated = 0;
      for (const { pk, value } of rows) {
        const nextValue = shape.apply(value);
        if (nextValue === null) continue;
        const affected = await driver.updateJsonbRow(
          shape.table,
          shape.primaryKey,
          pk,
          shape.column,
          nextValue,
        );
        if (affected !== 1) {
          throw new Error(
            `applyPlan: jsonb rewrite affected ${affected} rows for ` +
              `${shape.table}.${shape.column} pk=${JSON.stringify(pk)}`,
          );
        }
        rowsUpdated += 1;
      }
      jsonbApplied.push({
        table: shape.table,
        column: shape.column,
        present: true,
        rowsUpdated,
      });
    }

    for (const r of connectorParentRewrites) {
      const affected = await driver.deleteConnectorParentRow(r.oldValue);
      if (affected !== r.expectedRows) {
        throw new Error(
          `applyPlan: connector parent delete affected ${affected} rows, expected ${r.expectedRows} ` +
            `for connectors.connector_id ${JSON.stringify(r.oldValue)}`,
        );
      }
      connectorRowDelta -= affected;
      columnsApplied.push({ ...r, actualRows: affected });
    }

    const after = await snapshotRowCounts(driver, plan);
    for (const t of Object.keys(before)) {
      const expectedAfter = t === 'connectors' ? before[t] + connectorRowDelta : before[t];
      if (expectedAfter !== after[t]) {
        throw new Error(
          `applyPlan: row count for ${t} changed from ${before[t]} to ${after[t]} ` +
            `(expected ${expectedAfter})`,
        );
      }
    }

    await driver.commit();
    return {
      applied: { columns: columnsApplied, jsonb: jsonbApplied },
      rowCounts: { before, after },
    };
  } catch (err) {
    try {
      await driver.rollback();
    } catch {
      // Swallow rollback errors — the original is what the caller cares
      // about.
    }
    throw err;
  }
}

/**
 * Top-level entry: inspect the database, fail closed if any active
 * (and, with `--include-backup-tables`, any backup) connector_id value
 * is unmapped, then either return the plan (dry-run) or apply it.
 *
 * Options:
 *   - `apply`: actually perform the writes (default false — report only).
 *   - `includeBackupTables`: include backup-tier tables in the plan and
 *     in the fail-closed unmapped check (default false; scratch tables
 *     are never rewritten).
 *   - `allowUnmapped`: bypass the fail-closed check (review/diagnostic
 *     use only — the migration MUST NOT be applied with unmapped active
 *     rows in production).
 */
export async function migrate(driver, options = {}) {
  if (options.apply && options.allowUnmapped) {
    throw new Error(
      'migrate: refusing to apply with allowUnmapped=true. ' +
        '--allow-unmapped is diagnostic-only; resolve unmapped active values before writing.',
    );
  }

  const report = await inspect(driver);

  const blockedActive = report.summary.totalUnmappedRowsActive;
  const blockedBackup = options.includeBackupTables
    ? report.summary.totalUnmappedRowsBackup
    : 0;
  if (blockedActive + blockedBackup > 0 && !options.allowUnmapped) {
    const tierDescription = options.includeBackupTables
      ? `active=${blockedActive} backup=${blockedBackup}`
      : `active=${blockedActive}`;
    throw new Error(
      `migrate: refusing to write — unmapped connector_id rows present (${tierDescription}). ` +
        `Resolve mappings or re-run with --allow-unmapped to bypass for diagnostic purposes only.`,
    );
  }

  const plan = planFromReport(report, options);
  if (!options.apply) {
    return { report, plan, applied: null };
  }

  const applied = await applyPlan(driver, plan);
  return { report, plan, applied };
}

/**
 * Build a write-capable Postgres driver around a single `pg.Client`
 * connection (`await pool.connect()`). The single-connection
 * requirement is intentional: BEGIN/COMMIT/ROLLBACK must reach the
 * same backend connection that runs the UPDATE statements.
 *
 * The driver wraps the read-only `makePostgresDriver` shape and adds
 * the writer-only methods.
 */
export function makePostgresWriteDriver(client) {
  const readDriver = makePostgresDriver({
    query: (text, params) => client.query(text, params),
  });
  return {
    ...readDriver,
    async beginTransaction() {
      await client.query('BEGIN');
    },
    async commit() {
      await client.query('COMMIT');
    },
    async rollback() {
      await client.query('ROLLBACK');
    },
    async connectorParentRowExists(connectorId) {
      const res = await client.query(
        `SELECT 1 FROM connectors WHERE connector_id = $1 LIMIT 1`,
        [connectorId],
      );
      return (res.rowCount ?? 0) > 0;
    },
    async upsertConnectorParentRow(oldValue, newValue) {
      const res = await client.query(
        `INSERT INTO connectors (connector_id, manifest, created_at)
         SELECT $1, manifest, created_at
           FROM connectors
          WHERE connector_id = $2
         ON CONFLICT (connector_id) DO UPDATE
             SET manifest = EXCLUDED.manifest,
                 created_at = EXCLUDED.created_at`,
        [newValue, oldValue],
      );
      return res.rowCount ?? 0;
    },
    async deleteConnectorParentRow(oldValue) {
      const res = await client.query(
        `DELETE FROM connectors WHERE connector_id = $1`,
        [oldValue],
      );
      return res.rowCount ?? 0;
    },
    async updateConnectorIdColumn(table, column, oldValue, newValue) {
      const qt = quotePgIdentifier(table);
      const qc = quotePgIdentifier(column);
      const res = await client.query(
        `UPDATE ${qt} SET ${qc} = $1 WHERE ${qc} = $2`,
        [newValue, oldValue],
      );
      return res.rowCount ?? 0;
    },
    async readJsonbRowsWithPk(table, pkCols, jsonbCol) {
      const qt = quotePgIdentifier(table);
      const qc = quotePgIdentifier(jsonbCol);
      const qpk = pkCols.map(quotePgIdentifier).join(', ');
      const { rows } = await client.query(
        `SELECT ${qpk}, ${qc} AS value FROM ${qt} WHERE ${qc} IS NOT NULL`,
      );
      return rows.map((r) => ({
        pk: pkCols.map((c) => r[c]),
        value: r.value,
      }));
    },
    async updateJsonbRow(table, pkCols, pkValues, jsonbCol, newJson) {
      const qt = quotePgIdentifier(table);
      const qc = quotePgIdentifier(jsonbCol);
      const whereParts = pkCols
        .map((c, i) => `${quotePgIdentifier(c)} = $${i + 2}`)
        .join(' AND ');
      const res = await client.query(
        `UPDATE ${qt} SET ${qc} = $1::jsonb WHERE ${whereParts}`,
        [JSON.stringify(newJson), ...pkValues],
      );
      return res.rowCount ?? 0;
    },
  };
}

/**
 * Format the applied result as a short human-readable summary. The JSON
 * form is the source of truth; this format is intended for terminal
 * review only.
 */
export function formatApplyResult(result) {
  const lines = [];
  lines.push(`# canonical connector-key migration — applied`);
  lines.push('');
  const columns = result.applied.columns;
  lines.push(`columns rewritten: ${columns.length} distinct rewrites`);
  for (const c of columns) {
    lines.push(
      `  ${c.surfaceClass.padEnd(7)} ${c.table}.${c.column}  ` +
        `rows=${c.actualRows}  ${c.oldValue} → ${c.newValue}`,
    );
  }
  lines.push('');
  lines.push(`jsonb surfaces:`);
  for (const j of result.applied.jsonb) {
    if (!j.present) {
      lines.push(`  ${j.table}.${j.column}  (missing on this deployment — skipped)`);
      continue;
    }
    lines.push(`  ${j.table}.${j.column}  rows_updated=${j.rowsUpdated}`);
  }
  lines.push('');
  lines.push(`row counts (before / after; only connectors may intentionally collapse):`);
  const tables = Object.keys(result.rowCounts.before).sort();
  for (const t of tables) {
    lines.push(`  ${t.padEnd(36)} ${result.rowCounts.before[t]} → ${result.rowCounts.after[t]}`);
  }
  return lines.join('\n');
}
