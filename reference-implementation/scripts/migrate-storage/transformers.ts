/**
 * SQLite-to-Postgres value transformers.
 *
 * Each transformer coerces SQLite row values (loose typing) into Postgres-acceptable values.
 * Driven by per-column metadata from schema.ts.
 *
 * Pure ESM, zero dependencies, no filesystem access.
 *
 * For JSONB binary-content handling, see
 * docs/binary-content-invariant-design-brief.md §4.7 (extract-to-blobs
 * migration behavior). Two policies are supported:
 *   - "strict" (default): throw on U+0000 / forbidden control chars in
 *     every JSONB string leaf. Loud and safe; the right default for
 *     current connectors that use safeTextPreview() upstream.
 *   - "migrate-to-blobs": when a string leaf contains forbidden
 *     codepoints, extract the original UTF-8 bytes to the blobs table
 *     (via the caller-supplied extraction sink), replace the leaf with
 *     null, and record the RFC 6901 JSON Pointer for the field. The
 *     migrated record is structurally indistinguishable from a record
 *     emitted by a connector that correctly routed binary to blobs.
 */

import { createHash } from "node:crypto";
import type { ColumnMeta, TableMeta } from "./schema.ts";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type RawValue = JsonValue | bigint | Buffer | Date | undefined;
type ColumnMetaLike = Partial<ColumnMeta> & { tableName?: string };
export type JsonbPolicy = "strict" | "migrate-to-blobs";
interface RowContext {
  connectorId: string;
  recordKey: string;
  stream: string;
}
interface RowState {
  hasExtraction: boolean;
}
export interface Extraction {
  blob_id: string;
  bytes: Buffer;
  connector_id: string;
  json_path: string;
  reason: string;
  record_key: string;
  sha256: string;
  size_bytes: number;
  stream: string;
}
interface PolicyContext {
  columnName?: string;
  pointerPath: string;
  policy: JsonbPolicy;
  rowState: RowState;
  tableName?: string | null;
}
interface MigrationStats {
  extractedLeaves: number;
  extractedRows: number;
  strictFailures: number;
  totalExtractedBytes: number;
  uniqueBlobSha256s: Set<string>;
}

// Module-level migration stats. Tracks counters across a full run.
let migrationStats: MigrationStats = {
  extractedLeaves: 0, // Number of JSON leaves moved to blobs.
  extractedRows: 0, // Number of top-level rows that had ≥1 extraction.
  strictFailures: 0,
  totalExtractedBytes: 0, // Sum of original UTF-8 byte lengths.
  uniqueBlobSha256s: new Set(), // Per-run sha256 set (size = unique blobs).
};

/**
 * Policy controlling how `coerceJsonb` handles forbidden codepoints
 * (U+0000 and other PDPP-unsafe control chars) in JSONB string leaves.
 *
 *   - "strict" (default): throw a descriptive error naming the table,
 *     column, JSON Pointer, and offset.
 *   - "migrate-to-blobs": extract the offending string to blobs via
 *     the caller-supplied sink, replace the leaf with null. Lossless;
 *     produces records identical in shape to clean ingest.
 *
 * @type {"strict"|"migrate-to-blobs"}
 */
let jsonbNulPolicy: JsonbPolicy = "strict";

// Per-row context: set by the row transformer before each row, read by
// applyMigrateToBlobsToValue when it needs to emit an extraction.
// Reset to null after each row.
let currentRowContext: RowContext | null = null;

// Caller-supplied callback that persists an extraction. Signature:
//   onExtraction({ connector_id, stream, record_key, json_path,
//                  sha256, blob_id, size_bytes, reason, bytes })
// The callback is responsible for inserting into blobs + blob_bindings
// and writing the ledger line. May be sync or async (we don't await it
// inside the synchronous transformer — see the design note below).
let extractionSink: ((extraction: Extraction) => void) | null = null;

/**
 * Set the active JSONB policy.
 *
 * @param {"strict"|"migrate-to-blobs"} policy
 * @returns {string} previous policy
 */
export function setJsonbNulPolicy(policy: string): JsonbPolicy {
  if (policy !== "strict" && policy !== "migrate-to-blobs") {
    throw new Error(`setJsonbNulPolicy: unknown policy "${policy}". Expected one of: strict, migrate-to-blobs`);
  }
  const prev = jsonbNulPolicy;
  jsonbNulPolicy = policy;
  return prev;
}

/**
 * Get the currently-active JSONB policy.
 *
 * @returns {string}
 */
export function getJsonbNulPolicy(): JsonbPolicy {
  return jsonbNulPolicy;
}

/**
 * Set the extraction sink. Called by cli.mjs with a function that
 * persists each extracted blob into the target DB and writes a ledger
 * line. Pass `null` to clear (e.g., in tests).
 *
 * @param {function|null} sink
 */
export function setExtractionSink(sink: ((extraction: Extraction) => void) | null): void {
  if (sink !== null && typeof sink !== "function") {
    throw new Error("setExtractionSink: sink must be a function or null");
  }
  extractionSink = sink;
}

/**
 * Set the per-row context (connector_id, stream, record_key) so
 * extractions can be tagged with the correct binding tuple. Cleared
 * automatically at the end of each row transform.
 *
 * @param {object|null} ctx { connectorId, stream, recordKey }
 */
export function setCurrentRowContext(ctx: RowContext | null): void {
  currentRowContext = ctx;
}

/**
 * Get current migration statistics.
 *
 * @returns {object}
 */
export function getMigrationStats(): {
  strictFailures: number;
  extractedLeaves: number;
  extractedRows: number;
  uniqueBlobCount: number;
  totalExtractedBytes: number;
} {
  return {
    extractedLeaves: migrationStats.extractedLeaves,
    extractedRows: migrationStats.extractedRows,
    strictFailures: migrationStats.strictFailures,
    totalExtractedBytes: migrationStats.totalExtractedBytes,
    uniqueBlobCount: migrationStats.uniqueBlobSha256s.size,
  };
}

/**
 * Legacy-named accessor; many existing tests still call this. Returns
 * a superset of the new stats object so old assertions keep working.
 */
export function getJsonbScrubStats(): {
  extractedLeaves: number;
  extractedRows: number;
  uniqueBlobCount: number;
  totalExtractedBytes: number;
  scrubbedStringCount: number;
  scrubbedRowCount: number;
  strictFailures: number;
} {
  return {
    // New fields:
    extractedLeaves: migrationStats.extractedLeaves,
    extractedRows: migrationStats.extractedRows,
    scrubbedRowCount: migrationStats.extractedRows,
    // Legacy fields (preserved for back-compat with older tests):
    scrubbedStringCount: migrationStats.extractedLeaves,
    strictFailures: migrationStats.strictFailures,
    totalExtractedBytes: migrationStats.totalExtractedBytes,
    uniqueBlobCount: migrationStats.uniqueBlobSha256s.size,
  };
}

/**
 * Reset all module-level migration state. Used by tests so each case
 * starts from a known state.
 *
 */
export function resetMigrationStats(): void {
  migrationStats = {
    extractedLeaves: 0,
    extractedRows: 0,
    strictFailures: 0,
    totalExtractedBytes: 0,
    uniqueBlobSha256s: new Set(),
  };
  jsonbNulPolicy = "strict";
  currentRowContext = null;
  extractionSink = null;
}

/**
 * Coerce a value to TEXT (string).
 * Null stays null. Everything else stringified.
 *
 * @param {*} value - Raw value from SQLite
 * @param {object} [columnMeta] - Column metadata (name, type)
 * @returns {string|null}
 */
export function coerceText(value: RawValue, _columnMeta?: ColumnMetaLike): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return String(value);
}

function requiredText(value: RawValue, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`Expected ${field} to be text, got ${value === null ? "null" : typeof value}`);
  }
  return value;
}

// Forbidden codepoint for migration: ONLY U+0000, the byte that
// Postgres JSONB actually rejects (SQLSTATE 22P05). This is narrower
// than safeTextPreview\'s full set (which also forbids C0/C1 controls
// and DEL) because:
//
//   - For NEW writes, pdppSafeText/safeTextPreview enforce the full
//     printable-text invariant at the connector boundary.
//   - For LEGACY data being migrated, the only codepoint Postgres
//     actually rejects is U+0000. Other control codepoints (U+0080
//     Latin-1 mojibake from broken upstream pipelines, U+001B ANSI
//     escape codes in captured terminal output, etc.) are stored
//     fine and represent legitimate (if imperfect) text content.
//     Extracting them to blobs would lose more useful information
//     than it preserves.
//
// See docs/binary-content-invariant-design-brief.md §4.7 for the
// rationale on whole-string extraction; this narrowing was added
// after a dry-run on real production data showed the broader set
// would treat mojibake-corrupted but legible Gmail snippets as
// "binary" and discard the surrounding text.
const FORBIDDEN_CHAR = "\u0000";
const ISO_TIMESTAMP_RE = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/;

/**
 * Find the first forbidden codepoint in a string and return its info.
 * Returns null if the string is clean.
 *
 * @param {string} s
 * @returns {{offset: number, codePoint: number}|null}
 * @private
 */
function firstForbiddenInfo(s: string): { offset: number; codePoint: number } | null {
  const offset = s.indexOf(FORBIDDEN_CHAR);
  if (offset < 0) {
    return null;
  }
  return { codePoint: s.charCodeAt(offset), offset };
}

/**
 * Format a reason string for telemetry / ledger.
 *
 * @param {number} codePoint
 * @param {number} offset
 * @returns {string}
 * @private
 */
function formatReason(codePoint: number, offset: number): string {
  if (codePoint === 0) {
    return `U+0000 at offset ${offset}`;
  }
  const hex = codePoint.toString(16).toUpperCase().padStart(4, "0");
  return `U+${hex} at offset ${offset}`;
}

/**
 * Escape a token for inclusion in an RFC 6901 JSON Pointer.
 * RFC 6901 §4: '~' is escaped as '~0', '/' as '~1'. Numeric array
 * indices need no escaping.
 *
 * @param {string} token
 * @returns {string}
 * @private
 */
function escapePointerToken(token: string): string {
  return String(token).replace(/~/g, "~0").replace(/\//g, "~1");
}

/**
 * Recursively walk a parsed JSON structure and apply the active
 * `jsonbNulPolicy` to every string leaf that contains forbidden chars.
 * Tracks position via an RFC 6901 JSON Pointer (e.g. "/messages/0/content").
 *
 * Mutates `migrationStats` as a side effect. Pure with respect to
 * input (returns a new structure).
 *
 * @param value
 * @param {object} ctx - { columnName, tableName, policy, pointerPath, rowState }
 * @returns {*}
 * @private
 */
function handleForbiddenString(
  value: string,
  ctx: PolicyContext,
  info: { codePoint: number; offset: number }
): JsonValue {
  const reason = formatReason(info.codePoint, info.offset);
  if (ctx.policy === "strict") {
    migrationStats.strictFailures += 1;
    const colName = ctx.columnName || "unknown";
    const tblName = ctx.tableName ? ` in table "${ctx.tableName}"` : "";
    const pointerNote = ctx.pointerPath ? ` (json_path "${ctx.pointerPath}")` : "";
    throw new Error(
      `coerceJsonb: forbidden ${reason} in JSONB string${tblName} column "${colName}"${pointerNote}. ` +
        "Use --jsonb-nul-policy=migrate-to-blobs to extract legacy binary leaves to the blobs table."
    );
  }
  const bytes = Buffer.from(value, "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const extraction = {
    blob_id: `blob_sha256_${sha256}`,
    bytes,
    json_path: ctx.pointerPath || "@record",
    reason,
    sha256,
    size_bytes: bytes.byteLength,
  };
  migrationStats.extractedLeaves += 1;
  migrationStats.totalExtractedBytes += bytes.byteLength;
  migrationStats.uniqueBlobSha256s.add(sha256);
  ctx.rowState.hasExtraction = true;
  if (extractionSink && currentRowContext) {
    extractionSink({
      connector_id: currentRowContext.connectorId,
      record_key: currentRowContext.recordKey,
      stream: currentRowContext.stream,
      ...extraction,
    });
  }
  return null;
}

function applyNulPolicyToValue(value: JsonValue, ctx: PolicyContext): JsonValue {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    const info = firstForbiddenInfo(value);
    if (info === null) {
      return value;
    }
    return handleForbiddenString(value, ctx, info);
  }

  if (Array.isArray(value)) {
    return value.map((v, idx) =>
      applyNulPolicyToValue(v, {
        ...ctx,
        pointerPath: `${ctx.pointerPath || ""}/${idx}`,
      })
    );
  }

  if (typeof value === "object") {
    const result: { [key: string]: JsonValue } = {};
    for (const key in value) {
      if (Object.hasOwn(value, key)) {
        const child = value[key];
        if (child === undefined) {
          continue;
        }
        result[key] = applyNulPolicyToValue(child, {
          ...ctx,
          pointerPath: `${ctx.pointerPath || ""}/${escapePointerToken(key)}`,
        });
      }
    }
    return result;
  }

  return value;
}

/**
 * Coerce a value to JSONB.
 * Accepts: plain object, JSON string, null, or undefined.
 * Empty string "" treated as null (SQLite artifact).
 * Returns: plain object/array or null.
 *
 * Postgres JSONB does not allow NUL bytes (U+0000) in text values.
 * SQLite permits them. This function recursively scrubs every U+0000
 * from string leaves in the JSON structure, making it safe for Postgres.
 * Scrubbed counts are tracked in module-level stats.
 *
 * @param {*} value - Raw value from SQLite
 * @param {object} [columnMeta] - Column metadata (name, type)
 * @returns {object|null}
 * @throws {Error} If value is not parseable JSON
 */
export function coerceJsonb(value: RawValue, columnMeta?: ColumnMetaLike): JsonValue | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  let parsed: JsonValue;

  if (typeof value === "object") {
    parsed = value as JsonValue;
  } else if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch (err) {
      const colName = columnMeta?.name || "unknown";
      const sample = value.slice(0, 80);
      throw new Error(`coerceJsonb: invalid JSON in column "${colName}": ${sample}`, { cause: err });
    }
  } else {
    // Scalar (number, boolean) — wrap in JSON.stringify then parse
    // to maintain type fidelity, or just return as-is if Postgres JSONB accepts scalars
    // Safest: reject
    const colName = columnMeta?.name || "unknown";
    throw new Error(`coerceJsonb: expected object, string, or null in column "${colName}", got ${typeof value}`);
  }

  // Fast path: if the structure contains no forbidden codepoints
  // anywhere, return the original parsed value unchanged. Avoids
  // gratuitous object copying and preserves reference identity for
  // clean inputs.
  if (!structureContainsForbidden(parsed)) {
    return parsed;
  }

  const rowState: RowState = { hasExtraction: false };
  const ctx = {
    columnName: columnMeta?.name || "unknown",
    pointerPath: "",
    policy: jsonbNulPolicy,
    rowState,
    tableName: columnMeta?.tableName || null,
  };
  const handled = applyNulPolicyToValue(parsed, ctx);

  if (rowState.hasExtraction) {
    migrationStats.extractedRows += 1;
  }

  return handled;
}

/**
 * Cheap structural scan: does this value (or a nested string leaf)
 * contain a forbidden codepoint? Used as a fast path so clean records
 * skip the deep clone in coerceJsonb.
 *
 * @private
 */
function structureContainsForbidden(value: JsonValue): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === "string") {
    return value.includes(FORBIDDEN_CHAR);
  }
  if (Array.isArray(value)) {
    for (const v of value) {
      if (structureContainsForbidden(v)) {
        return true;
      }
    }
    return false;
  }
  if (typeof value === "object") {
    for (const child of Object.values(value)) {
      if (child !== undefined && structureContainsForbidden(child)) {
        return true;
      }
    }
    return false;
  }
  return false;
}

/**
 * Coerce a value to BYTEA.
 * Accepts: Buffer, base64 string, or null.
 * If string, treat as base64 and decode to Buffer.
 *
 * @param {*} value - Raw value from SQLite
 * @param {object} [columnMeta] - Column metadata (name, type)
 * @returns {Buffer|null}
 * @throws {Error} If value is not a valid base64 string or Buffer
 */
export function coerceBytea(value: RawValue, columnMeta?: ColumnMetaLike): Buffer | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (Buffer.isBuffer(value)) {
    return value;
  }

  if (typeof value === "string") {
    try {
      return Buffer.from(value, "base64");
    } catch (err) {
      const colName = columnMeta?.name || "unknown";
      const sample = value.slice(0, 80);
      throw new Error(`coerceBytea: invalid base64 in column "${colName}": ${sample}`, { cause: err });
    }
  }

  const colName = columnMeta?.name || "unknown";
  throw new Error(`coerceBytea: expected Buffer or base64 string in column "${colName}", got ${typeof value}`);
}

/**
 * Coerce a value to BOOLEAN.
 * Accepts: true, false, 0, 1, "0", "1", null.
 * Rejects anything else.
 *
 * @param {*} value - Raw value from SQLite
 * @param {object} [columnMeta] - Column metadata (name, type)
 * @returns {boolean|null}
 * @throws {Error} If value is not a valid boolean representation
 */
export function coerceBoolean(value: RawValue, columnMeta?: ColumnMetaLike): boolean | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (value === 0) {
      return false;
    }
    if (value === 1) {
      return true;
    }
  }

  if (typeof value === "string") {
    if (value === "0") {
      return false;
    }
    if (value === "1") {
      return true;
    }
  }

  const colName = columnMeta?.name || "unknown";
  const sample = String(value).slice(0, 80);
  throw new Error(`coerceBoolean: expected 0, 1, true, false, "0", or "1" in column "${colName}", got ${sample}`);
}

/**
 * Coerce a value to TIMESTAMP WITH TIME ZONE.
 * Accepts: ISO-8601 string, millisecond epoch (number), Date, or null.
 * Returns: ISO-8601 string with timezone indicator (Postgres parses).
 *
 * @param {*} value - Raw value from SQLite
 * @param {object} [columnMeta] - Column metadata (name, type)
 * @returns {string|null}
 * @throws {Error} If value is not a valid timestamp representation
 */
export function coerceTimestamp(value: RawValue, columnMeta?: ColumnMetaLike): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string") {
    // Assume ISO-8601. Validate minimally (has T or space).
    if (ISO_TIMESTAMP_RE.test(value)) {
      return value;
    }
    const colName = columnMeta?.name || "unknown";
    throw new Error(
      `coerceTimestamp: string does not match ISO-8601 pattern in column "${colName}": ${value.slice(0, 80)}`
    );
  }

  if (typeof value === "number") {
    // Assume millisecond epoch. Convert to ISO string.
    try {
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) {
        throw new Error("Invalid date");
      }
      return d.toISOString();
    } catch (err) {
      const colName = columnMeta?.name || "unknown";
      throw new Error(`coerceTimestamp: invalid epoch milliseconds in column "${colName}": ${value}`, { cause: err });
    }
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      const colName = columnMeta?.name || "unknown";
      throw new Error(`coerceTimestamp: Date is invalid (NaN) in column "${colName}"`);
    }
    return value.toISOString();
  }

  const colName = columnMeta?.name || "unknown";
  throw new Error(
    `coerceTimestamp: expected ISO string, epoch number, Date, or null in column "${colName}", got ${typeof value}`
  );
}

/**
 * Coerce a value to BIGINT.
 * Accepts: BigInt, number, numeric string, or null.
 * Returns: number if safe (within Number.MAX_SAFE_INTEGER), else BigInt.
 *
 * @param {*} value - Raw value from SQLite
 * @param {object} [columnMeta] - Column metadata (name, type)
 * @returns {number|bigint|null}
 * @throws {Error} If value is not a valid bigint representation
 */
export function coerceBigint(value: RawValue, columnMeta?: ColumnMetaLike): number | bigint | null {
  if (value === null || value === undefined) {
    return null;
  }

  // BigInt input
  if (typeof value === "bigint") {
    // Try to convert to safe number
    if (value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
      return Number(value);
    }
    return value;
  }

  // Number input
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      const colName = columnMeta?.name || "unknown";
      throw new Error(`coerceBigint: number is not finite in column "${colName}": ${value}`);
    }
    return value;
  }

  // String input
  if (typeof value === "string") {
    try {
      const bn = BigInt(value);
      if (bn >= BigInt(Number.MIN_SAFE_INTEGER) && bn <= BigInt(Number.MAX_SAFE_INTEGER)) {
        return Number(bn);
      }
      return bn;
    } catch (err) {
      const colName = columnMeta?.name || "unknown";
      throw new Error(`coerceBigint: string is not a valid bigint in column "${colName}": ${value.slice(0, 80)}`, {
        cause: err,
      });
    }
  }

  const colName = columnMeta?.name || "unknown";
  throw new Error(
    `coerceBigint: expected BigInt, number, or numeric string in column "${colName}", got ${typeof value}`
  );
}

/**
 * Coerce a value to INTEGER.
 * Accepts: number (integer), numeric string, or null.
 * Rejects non-finite or non-integer values.
 * Returns: number (integer).
 *
 * @param {*} value - Raw value from SQLite
 * @param {object} [columnMeta] - Column metadata (name, type)
 * @returns {number|null}
 * @throws {Error} If value is not a valid integer representation
 */
export function coerceInteger(value: RawValue, columnMeta?: ColumnMetaLike): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      const colName = columnMeta?.name || "unknown";
      throw new Error(`coerceInteger: number is not finite in column "${colName}": ${value}`);
    }
    if (!Number.isInteger(value)) {
      const colName = columnMeta?.name || "unknown";
      throw new Error(`coerceInteger: number is not an integer in column "${colName}": ${value}`);
    }
    return value;
  }

  if (typeof value === "string") {
    const n = Number.parseInt(value, 10);
    if (Number.isNaN(n) || String(n) !== value.trim()) {
      const colName = columnMeta?.name || "unknown";
      throw new Error(`coerceInteger: string is not a valid integer in column "${colName}": ${value.slice(0, 80)}`);
    }
    return n;
  }

  const colName = columnMeta?.name || "unknown";
  throw new Error(
    `coerceInteger: expected number, numeric string, or null in column "${colName}", got ${typeof value}`
  );
}

/**
 * Build a row transformer for a table.
 *
 * Takes tableMeta with a `columns` array.
 * Each column has: name, pgType, and optional flags: jsonb, bytea, boolean, timestamp.
 *
 * Optionally accepts:
 * - sourceColumnNames (Set): If provided:
 *   - For each Postgres column NOT in the source set, the transformer produces null.
 *   - For each source column NOT in the Postgres schema, it is silently dropped.
 * - options.synthesize (function): Optional per-row override hook:
 *   - Signature: (sqliteRow, columnName) => value | undefined
 *   - If returns a defined value, that value is used (bypassing normal coercion)
 *   - If returns undefined, normal coercion path runs
 *   - Useful for synthesizing Postgres-only columns (e.g., primary_key_text, cursor_value)
 *
 * Returns a function that takes a SQLite row object and returns an ordered tuple
 * matching tableMeta.columns order, ready for Postgres INSERT.
 *
 * @param {object} tableMeta - Table metadata
 * @param {string} tableMeta.name - Table name (for error messages)
 * @param {Array<object>} tableMeta.columns - Column definitions
 * @param {string} tableMeta.columns[].name - Column name
 * @param {string} tableMeta.columns[].pgType - Postgres type (TEXT, JSONB, BYTEA, BOOLEAN, TIMESTAMP, BIGINT, INTEGER)
 * @param {boolean} [tableMeta.columns[].jsonb] - Flag: JSONB type
 * @param {boolean} [tableMeta.columns[].bytea] - Flag: BYTEA type
 * @param {boolean} [tableMeta.columns[].boolean] - Flag: BOOLEAN type
 * @param {boolean} [tableMeta.columns[].timestamp] - Flag: TIMESTAMP type
 * @param {Set<string>} [sourceColumnNames] - Set of column names available in the source. If provided, missing columns produce null.
 * @param {object} [options] - Additional options
 * @param {function} [options.synthesize] - Synthesize function: (sqliteRow, columnName) => value | undefined
 * @returns {function} - (sqliteRow) => [value1, value2, ...]
 * @throws {Error} If column metadata is invalid
 */
export function buildRowTransformer(
  tableMeta: TableMeta,
  sourceColumnNames?: Set<string>,
  options: { synthesize?: (sqliteRow: Record<string, RawValue>, columnName: string) => RawValue | undefined } = {}
): (sqliteRow: Record<string, RawValue>) => RawValue[] {
  if (!(tableMeta && Array.isArray(tableMeta.columns))) {
    throw new Error("buildRowTransformer: tableMeta must have a columns array");
  }

  const { columns } = tableMeta;
  const tableName = tableMeta.name || "unknown";
  const hasSourceInfo = sourceColumnNames instanceof Set && sourceColumnNames.size > 0;
  const synthesize = typeof options.synthesize === "function" ? options.synthesize : null;

  // Build a coercer per column
  const coercers = columns.map((col) => {
    const { name, pgType, jsonb, bytea, boolean, timestamp } = col;

    // If sourceColumnNames is provided and this column is missing from source, produce null
    if (hasSourceInfo && !sourceColumnNames.has(name)) {
      return (_value: RawValue): null => null;
    }

    // Priority: explicit flags over pgType inference
    if (jsonb) {
      return (value: RawValue): JsonValue | null => coerceJsonb(value, col);
    }
    if (bytea) {
      return (value: RawValue): Buffer | null => coerceBytea(value, col);
    }
    if (boolean) {
      return (value: RawValue): boolean | null => coerceBoolean(value, col);
    }
    if (timestamp) {
      return (value: RawValue): string | null => coerceTimestamp(value, col);
    }

    // Fallback: infer from pgType
    const upperPgType = String(pgType).toUpperCase();

    if (upperPgType.includes("BIGINT")) {
      return (value: RawValue): number | bigint | null => coerceBigint(value, col);
    }
    if (upperPgType.includes("INTEGER") || upperPgType.includes("INT")) {
      return (value: RawValue): number | null => coerceInteger(value, col);
    }

    // Default: TEXT
    return (value: RawValue): string | null => coerceText(value, col);
  });

  // For tables that produce blob-binding extractions, expose the
  // per-row context so coerceJsonb can tag each extraction with
  // (connector_id, stream, record_key). `records` is the canonical
  // current state; `record_changes` is the version-history mirror.
  // Both have the binding tuple; both can contain U+0000 in record_json.
  // Other JSONB columns elsewhere in the schema (manifests, oauth
  // metadata, scheduler state, etc.) do not have a (connector_id,
  // stream, record_key) shape; strict policy surfaces each surprise loudly.
  const exposesRowBinding = tableName === "records" || tableName === "record_changes";

  function transformValue(sqliteRow: Record<string, RawValue>, column: ColumnMeta, index: number): RawValue {
    const colName = column.name;
    try {
      const synthesized = synthesize?.(sqliteRow, colName);
      if (synthesized !== undefined) {
        return synthesized;
      }
      const coerce = coercers[index];
      if (!coerce) {
        throw new Error(`Missing coercer for column "${colName}"`);
      }
      return coerce(sqliteRow[colName]);
    } catch (err) {
      throw new Error(
        `Row transform error in table "${tableName}" column "${colName}": ${err instanceof Error ? err.message : String(err)}`,
        { cause: err }
      );
    }
  }

  // Return the transformer function
  return (sqliteRow: Record<string, RawValue>): RawValue[] => {
    if (exposesRowBinding) {
      setCurrentRowContext({
        connectorId: requiredText(sqliteRow.connector_id, "connector_id"),
        recordKey: requiredText(sqliteRow.record_key, "record_key"),
        stream: requiredText(sqliteRow.stream, "stream"),
      });
    }
    try {
      const result: RawValue[] = [];
      for (let i = 0; i < columns.length; i += 1) {
        const column = columns[i];
        if (!column) {
          throw new Error(`Missing column metadata at index ${i}`);
        }
        result.push(transformValue(sqliteRow, column, i));
      }
      return result;
    } finally {
      if (exposesRowBinding) {
        setCurrentRowContext(null);
      }
    }
  };
}
