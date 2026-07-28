import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const JSONB_RE = /\bJSONB\b/;
const BYTEA_RE = /\bBYTEA\b/;
const BOOLEAN_RE = /\bBOOLEAN\b/;
const TIMESTAMP_RE = /\bTIMESTAMPTZ\b|\bTIMESTAMP\b/;
const BIGINT_RE = /\bBIGINT\b|\bBIGSERIAL\b/;
const INTEGER_RE = /\bINTEGER\b|\bSERIAL\b/;
const CONSTRAINT_NAME_RE = /^\b(UNIQUE|PRIMARY|FOREIGN|CONSTRAINT|CHECK|INDEX)\b/i;
const PRIMARY_KEY_RE = /PRIMARY\s+KEY\s*\(\s*([^)]+)\s*\)/i;
const INLINE_PRIMARY_KEY_RE = /(\S+)\s+\S+.*?PRIMARY\s+KEY/i;
const CREATE_TABLE_RE = (tableName: string): RegExp =>
  new RegExp(`CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+${tableName}\\s*\\(`, "i");
const TABLE_CONSTRAINT_RE = /^(PRIMARY|FOREIGN|UNIQUE|CONSTRAINT|CHECK)\s+/i;
const COLUMN_DEFINITION_RE = /^(\S+)\s+(.+)$/;
const PAREN_RE = /[()]/i;
const NOT_NULL_RE = /NOT\s+NULL/i;
const WHITESPACE_RE = /\s+/;

export interface ColumnMeta {
  boolean: boolean;
  bytea: boolean;
  jsonb: boolean;
  name: string;
  nullable: boolean;
  pgType: string;
  sqliteType: string;
  timestamp: boolean;
}

export interface TableMeta {
  columns: ColumnMeta[];
  name: string;
  primaryKey: string | null;
  reason?: string;
  skipMigration: boolean;
}

// Canonical table ordering respecting FK dependencies
const TABLE_ORDER = [
  "connectors",
  "connector_instances",
  "oauth_clients",
  "grants",
  "tokens",
  "pending_consents",
  "owner_device_auth",
  "device_exporters",
  "device_ingest_credentials",
  "device_enrollment_codes",
  "device_source_instances",
  "device_ingest_batch_outcomes",
  "source_webhook_events",
  "connector_state",
  "grant_connector_state",
  "connector_schedules",
  "controller_active_runs",
  "scheduler_run_history",
  "scheduler_last_run_times",
  "version_counter",
  "blobs",
  "blob_bindings",
  "records",
  "record_changes",
  "spine_events",
  "lexical_search_index",
  "lexical_search_snapshots",
  "lexical_search_meta",
  "semantic_search_blob",
  "semantic_search_snapshots",
  "semantic_search_meta",
  "semantic_search_backfill_progress",
];

// Tables that are derived/rebuilt by the runtime; should not be migrated
const DERIVED_TABLE_NAMES = new Set([
  "lexical_search_index",
  "lexical_search_snapshots",
  "lexical_search_meta",
  "semantic_search_blob",
  "semantic_search_snapshots",
  "semantic_search_meta",
  "semantic_search_backfill_progress",
]);

// Postgres-only columns that `execute` synthesizes per-row when the SQLite
// source predates them, rather than NULL-filling. This is the single source
// of truth shared by `execute` (cli.mjs wires the actual synthesize hooks)
// and `diff` (which must not flag a synthesizable column as unhandleable
// drift). If you add a synthesize hook in cli.mjs, add the column here so
// `diff` stays honest about what the migration can handle.
//
//   - records.primary_key_text — derived from manifest primary_key + record
//     (derivePrimaryKeyText); always non-empty, so it satisfies NOT NULL even
//     though the source lacks the column.
//   - records.cursor_value      — derived from manifest cursor_field
//     (deriveCursorValue); nullable.
//   - blob_bindings.json_path   — legacy bindings map to '@record'
//     (sqliteRow.json_path ?? '@record'); NOT NULL in target.
//
// See cli.mjs executeCommand() transformerOptions.synthesize for the hooks
// these names correspond to.
const SYNTHESIZED_TARGET_COLUMNS = new Map([
  ["records", new Set(["primary_key_text", "cursor_value"])],
  ["blob_bindings", new Set(["json_path"])],
]);

/**
 * Whether `execute` synthesizes the named target column for the given table
 * when it is absent from the SQLite source. Synthesized columns are NOT a
 * migration hazard: the transformer derives a value (never NULL-fills), so
 * `diff` must not classify them as unhandleable drift.
 *
 * @param {string} tableName
 * @param {string} columnName
 * @returns {boolean}
 */
export function isSynthesizedColumn(tableName: string, columnName: string): boolean {
  return SYNTHESIZED_TARGET_COLUMNS.get(tableName)?.has(columnName) ?? false;
}

/**
 * Classify a target column that is present in the Postgres schema but absent
 * from the SQLite source. Models exactly how `execute` treats the column so
 * `diff` and `execute` agree:
 *
 *   - "synthesized": execute derives the value per-row (never NULL-fills).
 *     Not a hazard regardless of nullability.
 *   - "null-fill": execute NULL-fills, which is safe only when the column is
 *     nullable. A nullable target column is handled.
 *   - "hard-drift": execute would NULL-fill a NOT NULL column → the insert
 *     would fail. This is the one case the migration genuinely cannot handle.
 *
 * @param {{name: string, nullable: boolean}} column - target column metadata
 * @param {string} tableName
 * @returns {"synthesized" | "null-fill" | "hard-drift"}
 */
export function classifyMissingTargetColumn(
  column: { name: string; nullable: boolean },
  tableName: string
): "synthesized" | "null-fill" | "hard-drift" {
  if (isSynthesizedColumn(tableName, column.name)) {
    return "synthesized";
  }
  return column.nullable ? "null-fill" : "hard-drift";
}

let cachedSchema: TableMeta[] | null = null;

/**
 * Determine SQLite type equivalent for diagnostics
 */
function sqliteTypeFromPg(pgType: string): string {
  const upper = pgType.toUpperCase();
  if (JSONB_RE.test(upper)) {
    return "TEXT";
  }
  if (BYTEA_RE.test(upper)) {
    return "BLOB";
  }
  if (BOOLEAN_RE.test(upper)) {
    return "INTEGER";
  }
  if (TIMESTAMP_RE.test(upper)) {
    return "TEXT";
  }
  if (BIGINT_RE.test(upper)) {
    return "INTEGER";
  }
  if (INTEGER_RE.test(upper)) {
    return "INTEGER";
  }
  return "TEXT";
}

/**
 * Parse a single column definition and extract type metadata
 */
function parseColumnDef(colDef: string): ColumnMeta | null {
  const trimmed = colDef.trim();
  if (!trimmed) {
    return null;
  }

  // Match: <name> <type> [modifiers...]
  const match = trimmed.match(COLUMN_DEFINITION_RE);
  if (!match) {
    return null;
  }

  const [, name, rest] = match;
  if (!(name && rest)) {
    return null;
  }

  // Reject false-positive "columns" that are actually constraints
  // Must use word boundaries to avoid matching column names like 'primary_key_text'
  if (PAREN_RE.test(name) || CONSTRAINT_NAME_RE.test(name)) {
    return null;
  }

  const [pgType] = rest.split(WHITESPACE_RE); // e.g. "BIGSERIAL", "TEXT", "JSONB"
  if (!pgType) {
    return null;
  }

  const nullable = !NOT_NULL_RE.test(rest);
  const jsonb = JSONB_RE.test(rest);
  const bytea = BYTEA_RE.test(rest);
  const boolean = BOOLEAN_RE.test(rest);
  const timestamp = TIMESTAMP_RE.test(rest);

  return {
    boolean,
    bytea,
    jsonb,
    name,
    nullable,
    pgType,
    sqliteType: sqliteTypeFromPg(pgType),
    timestamp,
  };
}

/**
 * Extract PRIMARY KEY column name(s) from table definition
 * Handles both inline PRIMARY KEY and PRIMARY KEY(...) constraints
 */
function extractPrimaryKey(body: string): string | null {
  // First try PRIMARY KEY(...) constraint (compound or single)
  const pkMatch = body.match(PRIMARY_KEY_RE);
  if (pkMatch) {
    const [, pkGroup] = pkMatch;
    if (!pkGroup) {
      return null;
    }
    const cols = pkGroup
      .split(",")
      .map((s) => s.trim())
      .filter((s): s is string => Boolean(s));
    return cols.length === 1 ? (cols[0] ?? null) : null; // Only return if single-column
  }

  // Try inline PRIMARY KEY on a column
  const inlineMatch = body.match(INLINE_PRIMARY_KEY_RE);
  if (inlineMatch) {
    return inlineMatch[1] ?? null;
  }

  return null;
}

function extractTableBody(ddl: string, tableName: string): string | null {
  // Extract body: CREATE TABLE IF NOT EXISTS <name> ( <body> )
  // Must handle nested parens in REFERENCES clauses
  const startMatch = ddl.match(CREATE_TABLE_RE(tableName));
  if (!startMatch) {
    return null;
  }

  const startIdx = (startMatch.index ?? 0) + startMatch[0].length;

  // Find matching closing paren
  let parenDepth = 1;
  let endIdx = startIdx;
  for (let i = startIdx; i < ddl.length && parenDepth > 0; i += 1) {
    if (ddl[i] === "(") {
      parenDepth += 1;
    } else if (ddl[i] === ")") {
      parenDepth -= 1;
      if (parenDepth === 0) {
        endIdx = i;
        break;
      }
    }
  }

  return ddl.slice(startIdx, endIdx);
}

function splitTableItems(body: string): string[] {
  const items: string[] = [];
  let current = "";
  let itemParenDepth = 0;

  for (const char of body) {
    if (char === "(") {
      itemParenDepth += 1;
      current += char;
    } else if (char === ")") {
      itemParenDepth -= 1;
      current += char;
    } else if (char === "," && itemParenDepth === 0) {
      // Top-level comma: separator between items
      const trimmed = current.trim();
      if (trimmed) {
        items.push(trimmed);
      }
      current = "";
    } else {
      current += char;
    }
  }

  // Don't forget the last item
  const trimmed = current.trim();
  if (trimmed) {
    items.push(trimmed);
  }

  return items;
}

/**
 * Parse a CREATE TABLE statement and extract schema
 */
function parseTable(ddl: string, tableName: string): TableMeta | null {
  const body = extractTableBody(ddl, tableName);
  if (body === null) {
    return null;
  }
  const primaryKey = extractPrimaryKey(body);
  const columns: ColumnMeta[] = [];
  const items = splitTableItems(body);

  for (const item of items) {
    // Skip constraint declarations (PRIMARY KEY, FOREIGN KEY, UNIQUE, CONSTRAINT, CHECK)
    if (TABLE_CONSTRAINT_RE.test(item)) {
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
  const reason = skipMigration ? "Derived table: rebuilt by runtime on first boot" : undefined;

  return {
    columns,
    name: tableName,
    primaryKey: primaryKey ?? null,
    skipMigration,
    ...(reason ? { reason } : {}),
  };
}

/**
 * Load and parse the schema from the source DDL file
 */
export function loadSchemaFromSource(): TableMeta[] {
  if (cachedSchema !== null) {
    return cachedSchema;
  }

  const ddlPath = join(__dirname, "..", "..", "server", "postgres-storage.js");
  const ddlContent = readFileSync(ddlPath, "utf-8");

  const tables: TableMeta[] = [];
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
 * Map<tableName, Set<columnName>> of Postgres-only columns that `execute`
 * synthesizes per-row. Exported so the synthesize hooks in cli.mjs and the
 * `diff` classifier read from one source of truth.
 */
export const SYNTHESIZED_COLUMNS = SYNTHESIZED_TARGET_COLUMNS;

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
export function isShadowTable(name: string): boolean {
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
export function getMigratableColumns(
  tableMeta: TableMeta,
  sourceColumnNames: Set<string>
): Array<{ name: string; mode: "copy" | "null" }> {
  if (!(tableMeta && Array.isArray(tableMeta.columns))) {
    throw new Error("getMigratableColumns: tableMeta must have a columns array");
  }

  return tableMeta.columns.map((col) => ({
    mode: sourceColumnNames.has(col.name) ? "copy" : "null",
    name: col.name,
  }));
}

// CLI guard: allow running `node schema.mjs` to inspect parsed schema
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(loadSchemaFromSource(), null, 2));
}
