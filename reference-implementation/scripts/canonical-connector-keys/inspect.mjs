/**
 * canonical-connector-keys / inspect.mjs
 *
 * Read-only dry-run for the canonical connector-key migration
 * (`openspec/changes/canonicalize-connector-keys/`, tasks §3.2).
 *
 * Walks every table that owns a `connector_id` column and, for each
 * distinct value, classifies it against the canonical allowlist in
 * `reference-implementation/server/connector-key.js`. Surfaces three
 * additional findings the OpenSpec change explicitly names:
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
  firstPartyConnectorKeys,
  isLegacyLocalAlias,
  isRegistryUrlConnectorId,
  legacyLocalAliasMap,
  nativeConnectorKeys,
} from '../../server/connector-key.js';

const LOCAL_DEVICE_PREFIX = 'local-device:';

/**
 * JSONB surfaces that embed connector_id values inside structured
 * payloads. The dry-run reports row counts so the write migration in
 * §3.3 can budget a deeper sweep; per-row JSONB extraction is out of
 * scope for the dry-run itself.
 */
export const JSONB_CONNECTOR_ID_SURFACES = Object.freeze([
  { table: 'grants', column: 'grant_json', why: 'embeds connector_id inside scope' },
  { table: 'grants', column: 'storage_binding_json', why: 'storage binding payload' },
  { table: 'grant_packages', column: 'package_json', why: 'package members reference connector ids' },
  { table: 'grant_package_members', column: 'source_json', why: 'per-member source identity' },
  { table: 'pending_consents', column: 'params_json', why: 'request params and approved selections' },
  { table: 'tokens', column: null, why: 'no direct column; resolved via grants' },
  { table: 'connector_instances', column: 'source_binding_json', why: 'kind=legacy/default_account placeholders' },
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
      // Identifier interpolation: `table` comes from information_schema,
      // not user input. Wrap in double-quotes defensively.
      const { rows } = await pool.query(
        `SELECT connector_id AS value, COUNT(*)::bigint AS count
           FROM "${table}"
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
      // Owner-visible `display_name` values that match the migration
      // placeholders we no longer want as selectable connections. Both
      // strings are described in
      // `packages/reference-contract/src/common/canonical.ts`
      // (`ConnectionDisplayNameSchema`) and on the live pdpp.vivid.fish
      // deployment per the consent-scope closeout report.
      const { rows } = await pool.query(
        `SELECT display_name AS value, COUNT(*)::bigint AS count
           FROM connector_instances
          WHERE display_name IN ('legacy', 'default_account', 'default account')
          GROUP BY display_name
          ORDER BY count DESC, display_name ASC`,
      );
      return rows.map((r) => ({ value: r.value, count: Number(r.count) }));
    },

    async countJsonbSurfaceRows(table) {
      const { rows } = await pool.query(`SELECT COUNT(*)::bigint AS count FROM "${table}"`);
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

/**
 * Run the full inspection. Driver shape:
 *   - listConnectorIdColumns(): Promise<{table,column}[]>
 *   - countDistinctConnectorIds(table): Promise<{value,count}[]>
 *   - countSourceBindingPlaceholders(): Promise<{kind,count}[]>
 *   - countLegacyDisplayNames(): Promise<{value,count}[]>
 *   - countJsonbSurfaceRows(table): Promise<number>
 */
export async function inspect(driver) {
  if (!driver) {
    throw new Error('inspect: driver is required');
  }

  const columns = await driver.listConnectorIdColumns();

  const tables = [];
  for (const { table, column } of columns) {
    const distinct = await driver.countDistinctConnectorIds(table);
    const classified = distinct.map((row) => {
      const classification = classifyConnectorId(row.value);
      return {
        value: row.value,
        count: row.count,
        classification: classification.classification,
        canonicalKey: classification.canonicalKey,
        inner: classification.inner ?? null,
        reason: classification.reason ?? null,
        rewriteRequired: requiresRewrite(classification, row.value),
        unmapped: isUnmappedClassification(classification),
      };
    });
    tables.push({
      table,
      column,
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
  for (const surface of JSONB_CONNECTOR_ID_SURFACES) {
    if (!surface.column) {
      jsonbSurfaces.push({ ...surface, rowCount: null });
      continue;
    }
    const rowCount = await driver.countJsonbSurfaceRows(surface.table);
    jsonbSurfaces.push({ ...surface, rowCount });
  }

  const totalUnmappedRows = tables.reduce((acc, t) => acc + t.unmappedRowCount, 0);
  const totalRewriteRows = tables.reduce((acc, t) => acc + t.rewriteRowCount, 0);
  const totalRowsTouched = tables.reduce((acc, t) => acc + t.rowsTotal, 0);

  return {
    generatedAt: new Date().toISOString(),
    tables,
    sourceBindingPlaceholders,
    legacyDisplayNames,
    jsonbSurfaces,
    summary: {
      tablesScanned: tables.length,
      totalRowsTouched,
      totalRewriteRows,
      totalUnmappedRows,
      hasUnmapped: totalUnmappedRows > 0,
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
  lines.push(`rewrite_rows:        ${report.summary.totalRewriteRows}`);
  lines.push(`unmapped_rows:       ${report.summary.totalUnmappedRows}`);
  lines.push(`status:              ${report.summary.hasUnmapped ? 'FAIL (unmapped found)' : 'OK'}`);
  lines.push('');

  for (const t of report.tables) {
    if (t.distinctCount === 0) continue;
    lines.push(`## ${t.table}.${t.column}`);
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
    lines.push(`## jsonb surfaces requiring deeper write-migration sweep`);
    for (const s of report.jsonbSurfaces) {
      const col = s.column ?? '(indirect via grants)';
      const count = s.rowCount === null ? 'n/a' : s.rowCount;
      lines.push(`    ${s.table}.${col}  rows=${count}  — ${s.why}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
