/**
 * Record synthesis for SQLite → Postgres migration.
 *
 * Mirrors runtime logic from postgres-records.js:
 * - Extracts manifest information (cursor_field, primary_key)
 * - Synthesizes primary_key_text and cursor_value columns at migration time
 * - These columns are Postgres-only and must be computed from the manifest + record data
 *
 * Pure ESM, zero dependencies.
 */

import type { Database } from "better-sqlite3";

/** A single stream's metadata as declared in a connector manifest. */
interface ManifestStream {
  cursor_field?: string | null;
  name?: string;
  primary_key?: string | string[];
}

/** A parsed connector manifest. */
interface Manifest {
  streams?: ManifestStream[];
}

/** Record JSON as stored (string) or already parsed (object). */
type RecordJson = string | Record<string, unknown> | null | undefined;

const KEY_SEPARATOR = "\x00"; // NUL byte separator for composite keys
const SAFE_JSON_FIELD_RE = /^[A-Za-z0-9_]+$/;

/**
 * Validate a JSON field name (alphanumeric + underscore only).
 * Mirrors safeJsonField from postgres-records.js line 192-194.
 *
 * @param field
 * @returns
 */
function safeJsonField(field: string | null | undefined): string | null {
  if (!(field && SAFE_JSON_FIELD_RE.test(field))) {
    return null;
  }
  return field;
}

/**
 * Extract primary key fields from a manifest stream.
 * Mirrors primaryKeyFieldsFor from postgres-records.js lines 65-70.
 *
 * Returns an array:
 * - If primary_key is array: return as-is
 * - If primary_key is string: return [string]
 * - If neither: return ['id'] (default)
 *
 * @param manifestStream - Stream metadata from manifest
 * @returns
 */
function primaryKeyFieldsFor(manifestStream: ManifestStream | null | undefined): string[] {
  const primary = manifestStream?.primary_key;
  if (Array.isArray(primary)) {
    return primary;
  }
  if (typeof primary === "string") {
    return [primary];
  }
  return ["id"];
}

/**
 * Load all connector manifests from the SQLite source.
 *
 * Returns a Map<connector_id, parsedManifest>.
 *
 * @param sqliteHandle - SQLite database handle
 * @returns
 */
export function loadConnectorManifests(sqliteHandle: Database): Map<string, Manifest> {
  const manifests = new Map<string, Manifest>();

  const stmt = sqliteHandle.prepare("SELECT connector_id, manifest FROM connectors");
  const rows = stmt.all() as Array<{ connector_id: string; manifest: string | Manifest }>;

  for (const row of rows) {
    try {
      const parsed = typeof row.manifest === "string" ? JSON.parse(row.manifest) : row.manifest;
      manifests.set(row.connector_id, parsed);
    } catch (err) {
      console.warn(`Failed to parse manifest for connector ${row.connector_id}:`, (err as Error).message);
    }
  }

  return manifests;
}

/**
 * Extract a single stream from a manifest by name.
 *
 * @param manifest - Parsed manifest object
 * @param streamName - Name of the stream to find
 * @returns The stream object, or null if not found
 */
export function getStreamFromManifest(
  manifest: Manifest | null | undefined,
  streamName: string
): ManifestStream | null {
  if (!(manifest && Array.isArray(manifest.streams))) {
    return null;
  }

  for (const stream of manifest.streams) {
    if (stream.name === streamName) {
      return stream;
    }
  }

  return null;
}

/**
 * Derive the primary_key_text value for a record.
 * Mirrors the logic in recordOrderExpressions (line 199-202) and primaryKeyText (line 113-118).
 *
 * Logic:
 * 1. Get primary key fields from manifest (single field or array of fields)
 * 2. For each field, extract value from record_json
 * 3. If value is undefined/null, use record_key as fallback
 * 4. Join multiple fields with KEY_SEPARATOR
 * 5. Result is always a non-empty string (never null)
 *
 * @param streamMeta - Stream metadata from manifest
 * @param recordJson - JSON data (string or parsed object)
 * @param recordKey - The record_key value from the database
 * @returns Non-empty string value for primary_key_text column
 * @throws {Error} If JSON parsing fails (indicates corrupt record_json in source)
 */
export function derivePrimaryKeyText(
  streamMeta: ManifestStream | null | undefined,
  recordJson: RecordJson,
  recordKey: string
): string {
  // Parse recordJson if it's a string
  let data: Record<string, unknown> | null | undefined;
  if (typeof recordJson === "string") {
    try {
      data = recordJson ? JSON.parse(recordJson) : null;
    } catch (err) {
      // Re-throw JSON parse errors so they bubble up to the caller
      // This indicates a corrupt record in the source database
      throw new Error(`derivePrimaryKeyText: failed to parse record_json: ${(err as Error).message}`);
    }
  } else {
    data = recordJson;
  }

  // Get primary key field(s) from manifest
  const primaryFields = primaryKeyFieldsFor(streamMeta);

  // For each primary field, extract value from data or fall back to record_key
  const parts = primaryFields.map((field) => {
    const value = data?.[field];
    return value === undefined || value === null ? recordKey : value;
  });

  // Convert all parts to string and join with separator
  const result = parts.map((part) => String(part ?? "")).join(KEY_SEPARATOR);

  // Ensure non-empty (should always be true since recordKey is always present)
  return result || recordKey;
}

/**
 * Derive the cursor_value for a record.
 * Mirrors the logic in recordOrderExpressions (line 198, 201) and cursorValue (line 121-126).
 *
 * Logic:
 * 1. If manifest declares cursor_field, extract that field from record_json
 * 2. If field exists and is not null/undefined, return string value
 * 3. Otherwise, return null (column is nullable)
 *
 * @param streamMeta - Stream metadata from manifest
 * @param recordJson - JSON data (string or parsed object)
 * @returns Cursor value or null
 * @throws {Error} If JSON parsing fails (indicates corrupt record_json in source)
 */
export function deriveCursorValue(
  streamMeta: ManifestStream | null | undefined,
  recordJson: RecordJson
): string | null {
  // Get cursor field from manifest
  const cursorField = safeJsonField(streamMeta?.cursor_field);

  // If no cursor field declared, return null
  if (!cursorField) {
    return null;
  }

  // Parse recordJson if it's a string
  let data: Record<string, unknown> | null | undefined;
  if (typeof recordJson === "string") {
    try {
      data = recordJson ? JSON.parse(recordJson) : null;
    } catch (err) {
      // Re-throw JSON parse errors so they bubble up to the caller
      // This indicates a corrupt record in the source database
      throw new Error(`deriveCursorValue: failed to parse record_json: ${(err as Error).message}`);
    }
  } else {
    data = recordJson;
  }

  // Extract value from data
  const value = data?.[cursorField];

  // If value is undefined or null, return null
  if (value === undefined || value === null) {
    return null;
  }

  // Convert to string
  return String(value);
}
