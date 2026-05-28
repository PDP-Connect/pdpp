/**
 * canonical-connector-keys / inspect.mjs
 *
 * Read-only dry-run for the canonical connector-key migration
 * (`openspec/changes/canonicalize-connector-keys/`, tasks §3.2).
 *
 * Walks every table that owns a `connector_id` column and, for each
 * distinct value, classifies it against the canonical allowlist in
 * `reference-implementation/server/connector-key.js`. Also walks the
 * known JSONB surfaces that embed `connector_id` inside structured
 * payloads (`grants.grant_json`, `grants.storage_binding_json`,
 * `grant_package_members.source_json`, `pending_consents.params_json`)
 * and classifies every extracted identifier with the same
 * `classifyConnectorId` function so the dry-run fails closed on
 * unmapped identifiers inside JSONB.
 *
 * Surfaces three additional findings the OpenSpec change explicitly
 * names:
 *
 *   - `legacy` / `default_account` placeholders on
 *     `connector_instances.source_binding_json`;
 *   - stale legacy local-collector aliases (`claude_code`, `codex`);
 *   - `local-device:<inner>` and `local-device:<inner>:<sourceInstanceId>`
 *     wrapped storage forms (see server/db.js::localDeviceConnectorId)
 *     whose inner id needs canonicalization.
 *
 * The module never writes. The Postgres-touching helpers are isolated
 * behind one injection point (`makeDriver`) so the unit test can drive
 * the inspection with synthetic fixtures.
 */

import {
  canonicalConnectorKey,
  isLegacyLocalAlias,
  isRegistryUrlConnectorId,
  legacyLocalAliasMap,
  nativeConnectorKeys,
} from '../../server/connector-key.js';

const LOCAL_DEVICE_PREFIX = 'local-device:';
const CONNECTOR_SOURCE_KINDS = new Set(['connector', 'provider_native']);

const SCRATCH_RE = /^cleanup_\d{8}_/;
const BACKUP_RE = /^backup_\d{8}_/;
const COMPACT_BACKUP_RE = /^compact_.+_backup_/;

/**
 * Classify a table name into one of three surface tiers based solely on
 * its naming pattern. No database access required.
 *
 *   scratch — ephemeral test scaffolding (`cleanup_YYYYMMDD_*`)
 *   backup  — forensic rollback artifacts (`backup_YYYYMMDD_*`, `compact_*_backup_*`)
 *   active  — everything else (live migration targets)
 *
 * Unmapped rows in `active` tables block the migration. Backup/scratch
 * unmapped rows are reported as warnings only.
 *
 * @param {string} tableName
 * @returns {'active' | 'backup' | 'scratch'}
 */
export function classifyTableSurface(tableName) {
  if (SCRATCH_RE.test(tableName)) return 'scratch';
  if (BACKUP_RE.test(tableName)) return 'backup';
  if (COMPACT_BACKUP_RE.test(tableName)) return 'backup';
  return 'active';
}

/**
 * Quote a Postgres identifier (table or column name) and escape any
 * embedded double-quotes per the SQL standard. The dry-run only ever
 * queries identifiers it discovered itself from `information_schema`
 * (or hard-coded surface names in JSONB_CONNECTOR_ID_SHAPES), so SQL
 * injection is not the threat model here. The helper exists so a
 * mis-named table that happens to contain a `"` character cannot break
 * the surrounding query, and so any future dynamic identifier passes
 * through one audited choke point.
 *
 * Rejects empty strings, non-strings, and identifiers containing a
 * null byte, since none of those are valid Postgres identifiers and
 * silently quoting them would mask a real bug.
 *
 * @param {unknown} identifier
 * @returns {string} e.g. `"connector_instances"` or `"weird""name"`
 */
export function quotePgIdentifier(identifier) {
  if (typeof identifier !== 'string' || identifier.length === 0) {
    throw new Error('quotePgIdentifier: identifier must be a non-empty string');
  }
  if (identifier.includes('\0')) {
    throw new Error('quotePgIdentifier: identifier contains null byte');
  }
  return `"${identifier.replace(/"/g, '""')}"`;
}

/**
 * Known JSONB surfaces and the per-shape extractors that pull
 * embedded `connector_id` values out of them. Each `extract` callback
 * runs against one parsed JSONB row and returns an array of
 * `{ path, value }` entries — one per identifier found. The dry-run
 * then classifies every value with `classifyConnectorId`, just like
 * the direct `connector_id` column scan, so unmapped JSONB
 * identifiers fail the same way unmapped column identifiers do.
 *
 * Shape sources (read/write call sites in the reference implementation):
 *
 *   - `grants.grant_json` → `$.source.id` when `$.source.kind` is
 *     `connector` or `provider_native`. Written by
 *     `server/auth.js::describeSourceBinding` and friends.
 *   - `grants.storage_binding_json` → `$.connector_id`. Written by
 *     `server/auth.js::normalizeStorageBinding`.
 *   - `grant_package_members.source_json` → `$.id` when `$.kind` is
 *     `connector` or `provider_native`. Written by
 *     `server/auth.js::describePackageMemberSource`.
 *   - `pending_consents.params_json` → `$.source_binding.id` (kind
 *     filter) and `$.storage_binding.connector_id`. Written by the
 *     pending-consent normalizer around `auth.js` line 540.
 *
 * `grant_packages.package_json` is intentionally NOT extracted: the
 * envelope today carries `{version, package_id, subject, client,
 * approved_source_count, source_bounded_child_grants}` only —
 * connector identifiers live on the child grants and on the
 * `grant_package_members.source_json` rows, both of which the
 * inspector already classifies.
 *
 * `connector_instances.source_binding_json` is also NOT extracted
 * here: the per-row connector identity already lives on the row's
 * `connector_id` column (which the direct-column scan covers), and
 * the JSONB carries `{kind: 'default_account'|'local_device'|...}`
 * placeholder/discriminator metadata only.
 */
export const JSONB_CONNECTOR_ID_SHAPES = Object.freeze([
  {
    table: 'grants',
    column: 'grant_json',
    extract: (json) => {
      if (!json?.source || !CONNECTOR_SOURCE_KINDS.has(json.source.kind)) return [];
      if (typeof json.source.id !== 'string' || json.source.id.length === 0) return [];
      return [{ path: '$.source.id', value: json.source.id }];
    },
  },
  {
    table: 'grants',
    column: 'storage_binding_json',
    extract: (json) => {
      if (typeof json?.connector_id !== 'string' || json.connector_id.length === 0) return [];
      return [{ path: '$.connector_id', value: json.connector_id }];
    },
  },
  {
    table: 'grant_package_members',
    column: 'source_json',
    extract: (json) => {
      if (!json || !CONNECTOR_SOURCE_KINDS.has(json.kind)) return [];
      if (typeof json.id !== 'string' || json.id.length === 0) return [];
      return [{ path: '$.id', value: json.id }];
    },
  },
  {
    table: 'pending_consents',
    column: 'params_json',
    extract: (json) => {
      const out = [];
      const sb = json?.source_binding;
      if (sb && CONNECTOR_SOURCE_KINDS.has(sb.kind) && typeof sb.id === 'string' && sb.id.length > 0) {
        out.push({ path: '$.source_binding.id', value: sb.id });
      }
      const stg = json?.storage_binding;
      if (stg && typeof stg.connector_id === 'string' && stg.connector_id.length > 0) {
        out.push({ path: '$.storage_binding.connector_id', value: stg.connector_id });
      }
      return out;
    },
  },
]);

/**
 * Sites the dry-run knows about but does NOT extract per-row, kept
 * in the report so the §3.3 write-migration plan can see them in one
 * place.
 */
export const JSONB_NON_EXTRACTED_SURFACES = Object.freeze([
  {
    table: 'grant_packages',
    column: 'package_json',
    why: 'envelope carries no embedded connector_id; identifiers live on child grants and grant_package_members.source_json',
  },
  {
    table: 'connector_instances',
    column: 'source_binding_json',
    why: 'JSONB carries kind placeholders only (`default_account`, `local_device`, …); the operational connector_id lives on the row column',
  },
]);

/**
 * Construct a Postgres driver around a `pg.Pool`-shaped client. Kept
 * narrow so the test suite can swap it for a stub. The driver exposes
 * only the queries the inspector needs.
 *
 * @param {{ query: (text: string, params?: any[]) => Promise<{ rows: any[] }> }} pool
 */
export function makePostgresDriver(pool) {
  return {
    async listConnectorIdColumns() {
      const { rows } = await pool.query(
        `SELECT table_name, column_name
           FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND column_name = 'connector_id'
          ORDER BY table_name`,
      );
      return rows.map((r) => ({ table: r.table_name, column: r.column_name }));
    },

    async countDistinctConnectorIds(table) {
      const quoted = quotePgIdentifier(table);
      const { rows } = await pool.query(
        `SELECT connector_id AS value, COUNT(*)::bigint AS count
           FROM ${quoted}
          GROUP BY connector_id
          ORDER BY count DESC, connector_id ASC`,
      );
      return rows.map((r) => ({ value: r.value, count: Number(r.count) }));
    },

    async countSourceBindingPlaceholders() {
      const { rows } = await pool.query(
        `SELECT
            COALESCE(source_binding_json->>'kind', '<missing>') AS kind,
            COUNT(*)::bigint AS count
           FROM connector_instances
          GROUP BY kind
          ORDER BY count DESC, kind ASC`,
      );
      return rows.map((r) => ({ kind: r.kind, count: Number(r.count) }));
    },

    async countLegacyDisplayNames() {
      const { rows } = await pool.query(
        `SELECT display_name AS value, COUNT(*)::bigint AS count
           FROM connector_instances
          WHERE display_name IN ('legacy', 'default_account', 'default account')
          GROUP BY display_name
          ORDER BY count DESC, display_name ASC`,
      );
      return rows.map((r) => ({ value: r.value, count: Number(r.count) }));
    },

    async hasColumn(table, column) {
      const { rows } = await pool.query(
        `SELECT 1
           FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = $1
            AND column_name = $2
          LIMIT 1`,
        [table, column],
      );
      return rows.length > 0;
    },

    async readJsonbColumn(table, column) {
      const quotedTable = quotePgIdentifier(table);
      const quotedColumn = quotePgIdentifier(column);
      const { rows } = await pool.query(
        `SELECT ${quotedColumn} AS value
           FROM ${quotedTable}
          WHERE ${quotedColumn} IS NOT NULL`,
      );
      // node-pg returns parsed JS objects for jsonb columns by default.
      return rows.map((r) => r.value);
    },

    async countTableRows(table) {
      const quoted = quotePgIdentifier(table);
      const { rows } = await pool.query(`SELECT COUNT(*)::bigint AS count FROM ${quoted}`);
      return Number(rows[0]?.count ?? 0);
    },
  };
}

/**
 * Classify one raw `connector_id` value the way the eventual migration
 * will see it. Returns:
 *   {
 *     classification: 'canonical_first_party' | 'canonical_native' |
 *                     'canonical_legacy_alias' | 'url_first_party' |
 *                     'wrapped_local_device' | 'unmapped',
 *     canonicalKey: string | null,
 *     inner?: classification of the unwrapped value (wrapped form only),
 *     reason?: short string for unmapped values,
 *   }
 *
 * `unmapped` is the fail-closed bucket. The dry-run treats any
 * unmapped row as a stop-the-line finding per design §3.
 */
export function classifyConnectorId(value) {
  if (value === null || value === undefined) {
    return { classification: 'unmapped', canonicalKey: null, reason: 'null/undefined' };
  }
  if (typeof value !== 'string' || value.trim() === '') {
    return { classification: 'unmapped', canonicalKey: null, reason: 'non-string/empty' };
  }

  if (value.startsWith(LOCAL_DEVICE_PREFIX)) {
    // Storage layer wrapped form. Strip the trailing `:source_instance_id`
    // segment if present, then percent-decode the connector id portion.
    const tail = value.slice(LOCAL_DEVICE_PREFIX.length);
    const colonIdx = tail.indexOf(':');
    const encodedInner = colonIdx === -1 ? tail : tail.slice(0, colonIdx);
    let inner;
    try {
      inner = decodeURIComponent(encodedInner);
    } catch {
      return {
        classification: 'wrapped_local_device',
        canonicalKey: null,
        inner: { classification: 'unmapped', canonicalKey: null, reason: 'undecodable inner' },
      };
    }
    const innerClassification = classifyConnectorId(inner);
    return {
      classification: 'wrapped_local_device',
      canonicalKey: innerClassification.canonicalKey,
      inner: innerClassification,
    };
  }

  if (isRegistryUrlConnectorId(value)) {
    const canonicalKey = canonicalConnectorKey(value);
    if (canonicalKey) {
      return { classification: 'url_first_party', canonicalKey };
    }
    return {
      classification: 'unmapped',
      canonicalKey: null,
      reason: 'registry-shaped URL not in first-party allowlist',
    };
  }

  const trimmed = value.trim();
  const canonicalKey = canonicalConnectorKey(trimmed);
  if (canonicalKey === null) {
    return { classification: 'unmapped', canonicalKey: null, reason: 'unrecognized string' };
  }

  // Bare value already equals its canonical key. Classify by which
  // allowlist it lives in so the report can break down rewrite-free
  // rows by connector flavor.
  if (trimmed === canonicalKey) {
    if (nativeConnectorKeys().includes(canonicalKey)) {
      return { classification: 'canonical_native', canonicalKey };
    }
    return { classification: 'canonical_first_party', canonicalKey };
  }

  // Value differs from canonical. The only known shape that triggers
  // this branch today is a legacy snake_case local-collector alias
  // (`claude_code` → `claude-code`). Anything else is unmapped.
  if (isLegacyLocalAlias(trimmed)) {
    return { classification: 'canonical_legacy_alias', canonicalKey: legacyLocalAliasMap()[trimmed] };
  }
  return { classification: 'unmapped', canonicalKey: null, reason: 'unrecognized string' };
}

function isUnmappedClassification(classification) {
  if (classification.classification === 'unmapped') return true;
  if (classification.classification === 'wrapped_local_device') {
    return classification.inner?.classification === 'unmapped';
  }
  return false;
}

function requiresRewrite(classification, value) {
  // Rule: rewrite iff the stored value is not byte-equal to the
  // canonical key. URL forms, legacy aliases, wrapped storage forms,
  // and whitespace-trimmable values all fall on the "rewrite" side.
  if (classification.classification === 'unmapped') return false;
  if (classification.canonicalKey === null) return false;
  return typeof value !== 'string' || value !== classification.canonicalKey;
}

function buildClassifiedDistinct(value, count) {
  const classification = classifyConnectorId(value);
  return {
    value,
    count,
    classification: classification.classification,
    canonicalKey: classification.canonicalKey,
    inner: classification.inner ?? null,
    reason: classification.reason ?? null,
    rewriteRequired: requiresRewrite(classification, value),
    unmapped: isUnmappedClassification(classification),
  };
}

function aggregateExtractions(extractions) {
  // extractions: [{ path, value }]  →  Map<JSON.stringify([path,value]), count>
  const counts = new Map();
  for (const { path, value } of extractions) {
    const key = JSON.stringify([path, value]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const distinct = [];
  for (const [key, count] of counts) {
    const [path, value] = JSON.parse(key);
    const entry = buildClassifiedDistinct(value, count);
    distinct.push({ path, ...entry });
  }
  distinct.sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  return distinct;
}

/**
 * Run the full inspection. Driver shape:
 *   - listConnectorIdColumns(): Promise<{table,column}[]>
 *   - countDistinctConnectorIds(table): Promise<{value,count}[]>
 *   - countSourceBindingPlaceholders(): Promise<{kind,count}[]>
 *   - countLegacyDisplayNames(): Promise<{value,count}[]>
 *   - hasColumn(table, column): Promise<boolean>
 *   - readJsonbColumn(table, column): Promise<unknown[]>  // parsed JSONB
 *   - countTableRows(table): Promise<number>
 */
export async function inspect(driver) {
  if (!driver) {
    throw new Error('inspect: driver is required');
  }

  const columns = await driver.listConnectorIdColumns();

  const tables = [];
  for (const { table, column } of columns) {
    const distinct = await driver.countDistinctConnectorIds(table);
    const classified = distinct.map((row) => buildClassifiedDistinct(row.value, row.count));
    tables.push({
      table,
      column,
      surfaceClass: classifyTableSurface(table),
      rowsTotal: classified.reduce((acc, r) => acc + r.count, 0),
      distinctCount: classified.length,
      unmappedDistinctCount: classified.filter((r) => r.unmapped).length,
      unmappedRowCount: classified.filter((r) => r.unmapped).reduce((acc, r) => acc + r.count, 0),
      rewriteRowCount: classified.filter((r) => r.rewriteRequired).reduce((acc, r) => acc + r.count, 0),
      distinct: classified,
    });
  }

  const sourceBindingPlaceholders = await driver.countSourceBindingPlaceholders();
  const legacyDisplayNames = await driver.countLegacyDisplayNames();

  const jsonbSurfaces = [];
  for (const shape of JSONB_CONNECTOR_ID_SHAPES) {
    const exists = await driver.hasColumn(shape.table, shape.column);
    if (!exists) {
      jsonbSurfaces.push({
        table: shape.table,
        column: shape.column,
        present: false,
        rowsScanned: 0,
        extractedCount: 0,
        distinctCount: 0,
        unmappedDistinctCount: 0,
        unmappedRowCount: 0,
        rewriteRowCount: 0,
        distinct: [],
      });
      continue;
    }
    const rows = await driver.readJsonbColumn(shape.table, shape.column);
    const extractions = [];
    for (const row of rows) {
      try {
        for (const hit of shape.extract(row)) extractions.push(hit);
      } catch {
        // A malformed JSONB row that throws during extraction is
        // treated as one unmapped extraction so it still fails closed.
        extractions.push({ path: '<extract-error>', value: '<extract-error>' });
      }
    }
    const distinct = aggregateExtractions(extractions);
    jsonbSurfaces.push({
      table: shape.table,
      column: shape.column,
      present: true,
      rowsScanned: rows.length,
      extractedCount: extractions.length,
      distinctCount: distinct.length,
      unmappedDistinctCount: distinct.filter((d) => d.unmapped).length,
      unmappedRowCount: distinct.filter((d) => d.unmapped).reduce((acc, d) => acc + d.count, 0),
      rewriteRowCount: distinct.filter((d) => d.rewriteRequired).reduce((acc, d) => acc + d.count, 0),
      distinct,
    });
  }

  const nonExtractedSurfaces = [];
  for (const surface of JSONB_NON_EXTRACTED_SURFACES) {
    const exists = await driver.hasColumn(surface.table, surface.column);
    const rowCount = exists ? await driver.countTableRows(surface.table) : 0;
    nonExtractedSurfaces.push({ ...surface, present: exists, rowCount });
  }

  const totalUnmappedRowsColumns = tables.reduce((acc, t) => acc + t.unmappedRowCount, 0);
  const totalUnmappedRowsJsonb = jsonbSurfaces.reduce((acc, s) => acc + s.unmappedRowCount, 0);
  const totalRewriteRowsColumns = tables.reduce((acc, t) => acc + t.rewriteRowCount, 0);
  const totalRewriteRowsJsonb = jsonbSurfaces.reduce((acc, s) => acc + s.rewriteRowCount, 0);
  const totalRowsTouched = tables.reduce((acc, t) => acc + t.rowsTotal, 0);

  // Per-tier unmapped counts. JSONB surfaces are always extracted from
  // base table names (grants, grant_package_members, pending_consents)
  // which are always `active`. Backup/scratch tables surface their
  // connector_id through the direct-column scan only.
  const totalUnmappedRowsActive =
    tables
      .filter((t) => t.surfaceClass === 'active')
      .reduce((acc, t) => acc + t.unmappedRowCount, 0) + totalUnmappedRowsJsonb;
  const totalUnmappedRowsBackup = tables
    .filter((t) => t.surfaceClass === 'backup')
    .reduce((acc, t) => acc + t.unmappedRowCount, 0);
  const totalUnmappedRowsScratch = tables
    .filter((t) => t.surfaceClass === 'scratch')
    .reduce((acc, t) => acc + t.unmappedRowCount, 0);

  return {
    generatedAt: new Date().toISOString(),
    tables,
    sourceBindingPlaceholders,
    legacyDisplayNames,
    jsonbSurfaces,
    nonExtractedJsonbSurfaces: nonExtractedSurfaces,
    summary: {
      tablesScanned: tables.length,
      totalRowsTouched,
      totalRewriteRows: totalRewriteRowsColumns + totalRewriteRowsJsonb,
      totalRewriteRowsColumns,
      totalRewriteRowsJsonb,
      // All-tier totals retained for backwards compatibility.
      totalUnmappedRows: totalUnmappedRowsColumns + totalUnmappedRowsJsonb,
      totalUnmappedRowsColumns,
      totalUnmappedRowsJsonb,
      // Per-tier unmapped counts (primary gate is hasUnmappedActive).
      totalUnmappedRowsActive,
      totalUnmappedRowsBackup,
      totalUnmappedRowsScratch,
      hasUnmapped: totalUnmappedRowsColumns + totalUnmappedRowsJsonb > 0,
      hasUnmappedActive: totalUnmappedRowsActive > 0,
    },
  };
}

/**
 * Render a concise human report. `report` is the value returned by
 * `inspect()`. The JSON form is the source of truth; this format is
 * intended for terminal review only.
 */
export function formatHumanReport(report) {
  const lines = [];
  lines.push(`# canonical connector-key migration — dry-run`);
  lines.push(`generated_at: ${report.generatedAt}`);
  lines.push('');
  lines.push(`tables_scanned:      ${report.summary.tablesScanned}`);
  lines.push(`total_rows_touched:  ${report.summary.totalRowsTouched}`);
  lines.push(`rewrite_rows:        ${report.summary.totalRewriteRows} (columns=${report.summary.totalRewriteRowsColumns}, jsonb=${report.summary.totalRewriteRowsJsonb})`);
  lines.push(`unmapped_rows:       ${report.summary.totalUnmappedRows} all tiers (active=${report.summary.totalUnmappedRowsActive}, backup=${report.summary.totalUnmappedRowsBackup}, scratch=${report.summary.totalUnmappedRowsScratch})`);
  const activeStatus = report.summary.hasUnmappedActive
    ? 'FAIL — active tables have unmapped rows (migration blocked)'
    : 'OK — no unmapped rows in active tables';
  const backupNote =
    report.summary.totalUnmappedRowsBackup + report.summary.totalUnmappedRowsScratch > 0
      ? ` [WARN: ${report.summary.totalUnmappedRowsBackup + report.summary.totalUnmappedRowsScratch} unmapped in backup/scratch — not blocking]`
      : '';
  lines.push(`status:              ${activeStatus}${backupNote}`);
  lines.push('');

  for (const tier of ['active', 'backup', 'scratch']) {
    const tierTables = report.tables.filter((t) => t.surfaceClass === tier && t.distinctCount > 0);
    if (tierTables.length === 0) continue;
    lines.push(`## tables — ${tier}`);
    for (const t of tierTables) {
      lines.push(`### ${t.table}.${t.column}`);
      lines.push(`  rows=${t.rowsTotal} distinct=${t.distinctCount} rewrite=${t.rewriteRowCount} unmapped=${t.unmappedRowCount}`);
      for (const d of t.distinct) {
        const tag = d.unmapped
          ? 'UNMAPPED'
          : d.rewriteRequired
            ? `→ ${d.canonicalKey}`
            : 'ok';
        const detail = d.classification === 'wrapped_local_device' && d.inner
          ? ` (inner=${d.inner.classification}${d.inner.canonicalKey ? '→' + d.inner.canonicalKey : ''})`
          : '';
        lines.push(`    ${tag.padEnd(20)} ${d.classification.padEnd(28)} count=${d.count.toString().padStart(7)}  ${d.value}${detail}`);
        if (d.reason) lines.push(`        reason: ${d.reason}`);
      }
      lines.push('');
    }
  }

  if (report.sourceBindingPlaceholders.length > 0) {
    lines.push(`## connector_instances.source_binding_json.kind`);
    for (const row of report.sourceBindingPlaceholders) {
      lines.push(`    kind=${row.kind.padEnd(22)} count=${row.count}`);
    }
    lines.push('');
  }

  if (report.legacyDisplayNames.length > 0) {
    lines.push(`## connector_instances.display_name placeholders`);
    for (const row of report.legacyDisplayNames) {
      lines.push(`    "${row.value}" count=${row.count}`);
    }
    lines.push('');
  }

  if (report.jsonbSurfaces.length > 0) {
    lines.push(`## jsonb embedded connector_id extraction`);
    for (const s of report.jsonbSurfaces) {
      if (!s.present) {
        lines.push(`  ${s.table}.${s.column}  (column missing on this deployment — skipped)`);
        continue;
      }
      lines.push(`  ${s.table}.${s.column}  rows=${s.rowsScanned} extracted=${s.extractedCount} distinct=${s.distinctCount} rewrite=${s.rewriteRowCount} unmapped=${s.unmappedRowCount}`);
      for (const d of s.distinct) {
        const tag = d.unmapped
          ? 'UNMAPPED'
          : d.rewriteRequired
            ? `→ ${d.canonicalKey}`
            : 'ok';
        const detail = d.classification === 'wrapped_local_device' && d.inner
          ? ` (inner=${d.inner.classification}${d.inner.canonicalKey ? '→' + d.inner.canonicalKey : ''})`
          : '';
        lines.push(`    ${tag.padEnd(20)} ${d.classification.padEnd(28)} count=${d.count.toString().padStart(7)}  ${d.path}=${d.value}${detail}`);
        if (d.reason) lines.push(`        reason: ${d.reason}`);
      }
    }
    lines.push('');
  }

  if (report.nonExtractedJsonbSurfaces.length > 0) {
    lines.push(`## jsonb surfaces with no embedded connector_id (informational)`);
    for (const s of report.nonExtractedJsonbSurfaces) {
      const presence = s.present ? `rows=${s.rowCount}` : '(missing)';
      lines.push(`    ${s.table}.${s.column}  ${presence}  — ${s.why}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
