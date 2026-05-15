import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Canonical table ordering respecting FK dependencies
const TABLE_ORDER = [
  'connectors',
  'connector_instances',
  'oauth_clients',
  'grants',
  'tokens',
  'pending_consents',
  'owner_device_auth',
  'device_exporters',
  'device_ingest_credentials',
  'device_enrollment_codes',
  'device_source_instances',
  'device_ingest_batch_outcomes',
  'connector_state',
  'grant_connector_state',
  'connector_schedules',
  'controller_active_runs',
  'scheduler_run_history',
  'scheduler_last_run_times',
  'version_counter',
  'blobs',
  'blob_bindings',
  'records',
  'record_changes',
  'spine_events',
  'lexical_search_index',
  'lexical_search_snapshots',
  'lexical_search_meta',
  'semantic_search_blob',
  'semantic_search_snapshots',
  'semantic_search_meta',
  'semantic_search_backfill_progress',
];

// Tables that are derived/rebuilt by the runtime; should not be migrated
const DERIVED_TABLE_NAMES = new Set([
  'lexical_search_index',
  'lexical_search_snapshots',
  'lexical_search_meta',
  'semantic_search_blob',
  'semantic_search_snapshots',
  'semantic_search_meta',
  'semantic_search_backfill_progress',
]);

let cachedSchema = null;

/**
 * Determine SQLite type equivalent for diagnostics
 */
function sqliteTypeFromPg(pgType) {
  const upper = pgType.toUpperCase();
  if (/\bJSONB\b/.test(upper)) return 'TEXT';
  if (/\bBYTEA\b/.test(upper)) return 'BLOB';
  if (/\bBOOLEAN\b/.test(upper)) return 'INTEGER';
  if (/\bTIMESTAMPTZ\b|\bTIMESTAMP\b/.test(upper)) return 'TEXT';
  if (/\bBIGINT\b|\bBIGSERIAL\b/.test(upper)) return 'INTEGER';
  if (/\bINTEGER\b|\bSERIAL\b/.test(upper)) return 'INTEGER';
  return 'TEXT';
}

/**
 * Parse a single column definition and extract type metadata
 */
function parseColumnDef(colDef) {
  const trimmed = colDef.trim();
  if (!trimmed) return null;

  // Match: <name> <type> [modifiers...]
  const match = trimmed.match(/^(\S+)\s+(.+)$/);
  if (!match) return null;

  const [, name, rest] = match;

  // Reject false-positive "columns" that are actually constraints
  // Must use word boundaries to avoid matching column names like 'primary_key_text'
  if (/[()]/i.test(name) || /^\b(UNIQUE|PRIMARY|FOREIGN|CONSTRAINT|CHECK|INDEX)\b/i.test(name)) {
    return null;
  }

  const pgType = rest.split(/\s+/)[0]; // e.g. "BIGSERIAL", "TEXT", "JSONB"

  const nullable = !/NOT\s+NULL/i.test(rest);
  const jsonb = /\bJSONB\b/i.test(rest);
  const bytea = /\bBYTEA\b/i.test(rest);
  const boolean = /\bBOOLEAN\b/i.test(rest);
  const timestamp = /\bTIMESTAMPTZ\b|\bTIMESTAMP\b/i.test(rest);

  return {
    name,
    pgType,
    sqliteType: sqliteTypeFromPg(pgType),
    nullable,
    jsonb,
    bytea,
    boolean,
    timestamp,
  };
}

/**
 * Extract PRIMARY KEY column name(s) from table definition
 * Handles both inline PRIMARY KEY and PRIMARY KEY(...) constraints
 */
function extractPrimaryKey(body) {
  // First try PRIMARY KEY(...) constraint (compound or single)
  const pkMatch = body.match(/PRIMARY\s+KEY\s*\(\s*([^)]+)\s*\)/i);
  if (pkMatch) {
    const cols = pkMatch[1]
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s);
    return cols.length === 1 ? cols[0] : null; // Only return if single-column
  }

  // Try inline PRIMARY KEY on a column
  const inlineMatch = body.match(/(\S+)\s+\S+.*?PRIMARY\s+KEY/i);
  if (inlineMatch) {
    return inlineMatch[1];
  }

  return null;
}

/**
 * Parse a CREATE TABLE statement and extract schema
 */
function parseTable(ddl, tableName) {
  // Extract body: CREATE TABLE IF NOT EXISTS <name> ( <body> )
  // Must handle nested parens in REFERENCES clauses
  const tableStartRegex = new RegExp(
    `CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+${tableName}\\s*\\(`,
    'i',
  );
  const startMatch = ddl.match(tableStartRegex);
  if (!startMatch) {
    return null;
  }

  const startIdx = startMatch.index + startMatch[0].length;

  // Find matching closing paren
  let parenDepth = 1;
  let endIdx = startIdx;
  for (let i = startIdx; i < ddl.length && parenDepth > 0; i++) {
    if (ddl[i] === '(') {
      parenDepth++;
    } else if (ddl[i] === ')') {
      parenDepth--;
      if (parenDepth === 0) {
        endIdx = i;
        break;
      }
    }
  }

  const body = ddl.substring(startIdx, endIdx);
  const primaryKey = extractPrimaryKey(body);

  // Split on commas while respecting parentheses
  // This handles PRIMARY KEY(col1, col2) correctly
  const items = [];
  let current = '';
  let itemParenDepth = 0;

  for (let i = 0; i < body.length; i++) {
    const char = body[i];

    if (char === '(') {
      itemParenDepth++;
      current += char;
    } else if (char === ')') {
      itemParenDepth--;
      current += char;
    } else if (char === ',' && itemParenDepth === 0) {
      // Top-level comma: separator between items
      const trimmed = current.trim();
      if (trimmed) {
        items.push(trimmed);
      }
      current = '';
    } else {
      current += char;
    }
  }

  // Don't forget the last item
  const trimmed = current.trim();
  if (trimmed) {
    items.push(trimmed);
  }

  const columns = [];

  for (const item of items) {
    // Skip constraint declarations (PRIMARY KEY, FOREIGN KEY, UNIQUE, CONSTRAINT, CHECK)
    if (/^(PRIMARY|FOREIGN|UNIQUE|CONSTRAINT|CHECK)\s+/i.test(item)) {
      continue;
    }

    // This should be a column definition
    // Extract just the name and type part, ignoring REFERENCES, ON DELETE, etc.
    // Pattern: <name> <type> [modifiers including REFERENCES clause]
    const col = parseColumnDef(item);
    if (col) {
      columns.push(col);
    }
  }

  const skipMigration = DERIVED_TABLE_NAMES.has(tableName);
  const reason = skipMigration ? 'Derived table: rebuilt by runtime on first boot' : undefined;

  return {
    name: tableName,
    primaryKey,
    columns,
    skipMigration,
    reason,
  };
}

/**
 * Load and parse the schema from the source DDL file
 */
export function loadSchemaFromSource() {
  if (cachedSchema !== null) {
    return cachedSchema;
  }

  const ddlPath = join(
    __dirname,
    '..',
    '..',
    'server',
    'postgres-storage.js',
  );
  const ddlContent = readFileSync(ddlPath, 'utf-8');

  const tables = [];
  for (const tableName of TABLE_ORDER) {
    const tableSchema = parseTable(ddlContent, tableName);
    if (tableSchema) {
      tables.push(tableSchema);
    }
  }

  cachedSchema = tables;
  return cachedSchema;
}

/**
 * Export the canonical schema (loaded on first access)
 */
export const TABLES = (() => loadSchemaFromSource())();

/**
 * Set of table names that are derived and should not be migrated
 */
export const DERIVED_TABLES = DERIVED_TABLE_NAMES;

/**
 * Alias for convenience (same as DERIVED_TABLES for now)
 */
export const SKIP_TABLES = DERIVED_TABLE_NAMES;

/**
 * Regex patterns matching FTS5 shadow tables and legacy search artifacts.
 * These are SQLite implementation details, not canonical tables.
 * They don't exist in the Postgres schema and are rebuilt by the runtime.
 */
export const SHADOW_TABLE_PATTERNS = [
  /^lexical_search_index_(config|data|docsize|idx|content)$/,
  /^ref_record_search$/,
  /^ref_record_search_(config|data|docsize|idx|content)$/,
  /^semantic_search_rowid$/,
];

/**
 * Check if a table name is a shadow/auxiliary table.
 * @param {string} name - Table name
 * @returns {boolean}
 */
export function isShadowTable(name) {
  for (const pattern of SHADOW_TABLE_PATTERNS) {
    if (pattern.test(name)) {
      return true;
    }
  }
  return false;
}

/**
 * Compute the per-column plan for migration, given source column names.
 * For each Postgres column in tableMeta, determine if the source has it (mode: "copy")
 * or if the migration will substitute NULL (mode: "null").
 *
 * @param {object} tableMeta - Table metadata from TABLES
 * @param {Set<string>} sourceColumnNames - Set of column names in the source
 * @returns {Array<{name: string, mode: "copy" | "null"}>}
 */
export function getMigratableColumns(tableMeta, sourceColumnNames) {
  if (!tableMeta || !Array.isArray(tableMeta.columns)) {
    throw new Error('getMigratableColumns: tableMeta must have a columns array');
  }

  return tableMeta.columns.map((col) => ({
    name: col.name,
    mode: sourceColumnNames.has(col.name) ? 'copy' : 'null',
  }));
}

// CLI guard: allow running `node schema.mjs` to inspect parsed schema
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(loadSchemaFromSource(), null, 2));
}
