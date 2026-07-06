import { normalizePrimaryKey } from "./record-expand-helpers.js";
import { coerceComparableValue, type FieldSchema, getFieldSchema } from "./schema-coercion.ts";

interface ManifestStreamShape {
  cursor_field?: string | null;
  primary_key?: string | string[] | null;
  schema?: { properties?: Record<string, FieldSchema> | null } | null;
  [key: string]: unknown;
}

export interface SortPosition {
  cursor_value: string | number | null;
  primary_key: (string | number | null)[];
}

function compareComparableValues(left: unknown, right: unknown, fieldSchema: FieldSchema | null | undefined): number {
  const l = coerceComparableValue(left, fieldSchema);
  const r = coerceComparableValue(right, fieldSchema);
  if (typeof l === "number" && typeof r === "number") {
    return l - r;
  }
  return String(l ?? "").localeCompare(String(r ?? ""));
}

function compareCursorPositions(
  left: SortPosition | null | undefined,
  right: SortPosition | null | undefined,
  manifestStream: ManifestStreamShape | null | undefined,
  cursorField: string,
  direction: number
): number {
  const fieldSchema = getFieldSchema(manifestStream, cursorField);
  const leftCursorValue = left?.cursor_value;
  const rightCursorValue = right?.cursor_value;
  const leftMissing = leftCursorValue == null || leftCursorValue === "";
  const rightMissing = rightCursorValue == null || rightCursorValue === "";
  if (leftMissing !== rightMissing) {
    // Missing bucket is after present in ASC, before in DESC.
    return (leftMissing ? 1 : -1) * direction;
  }
  if (leftMissing || rightMissing) {
    return 0;
  }
  return compareComparableValues(leftCursorValue, rightCursorValue, fieldSchema) * direction;
}

function comparePrimaryKeyPositions(
  left: SortPosition | null | undefined,
  right: SortPosition | null | undefined,
  manifestStream: ManifestStreamShape | null | undefined,
  direction: number
): number {
  const primaryKeyFields = normalizePrimaryKey(manifestStream?.primary_key);
  for (let i = 0; i < primaryKeyFields.length; i += 1) {
    const fieldSchema = getFieldSchema(manifestStream, primaryKeyFields[i]);
    const cmp = compareComparableValues(left?.primary_key?.[i], right?.primary_key?.[i], fieldSchema);
    if (cmp !== 0) {
      return cmp * direction;
    }
  }
  return 0;
}

export function compareLogicalPositions(
  left: SortPosition | null | undefined,
  right: SortPosition | null | undefined,
  manifestStream: ManifestStreamShape | null | undefined,
  order: "ASC" | "DESC"
): number {
  const direction = order === "ASC" ? 1 : -1;
  const cursorField = manifestStream?.cursor_field || null;

  if (cursorField) {
    const cmp = compareCursorPositions(left, right, manifestStream, cursorField, direction);
    if (cmp !== 0) {
      return cmp;
    }
  }

  return comparePrimaryKeyPositions(left, right, manifestStream, direction);
}

export function decodeKey(keyStr: string): string | string[] {
  try {
    const parsed: unknown = JSON.parse(keyStr);
    if (Array.isArray(parsed)) {
      return parsed as string[];
    }
    return keyStr;
  } catch {
    return keyStr;
  }
}

export function buildRecordSortPosition(
  rawData: Record<string, unknown> | null | undefined,
  recordKey: string,
  manifestStream: ManifestStreamShape | null | undefined
): SortPosition {
  const primaryKeyFields = normalizePrimaryKey(manifestStream?.primary_key);
  const decodedKey = decodeKey(recordKey);
  const decodedKeyParts = Array.isArray(decodedKey) ? decodedKey : [decodedKey];
  const primaryKey: (string | number | null)[] = primaryKeyFields.map((field, index) => {
    if (rawData?.[field] !== undefined) {
      return rawData[field] as string | number | null;
    }
    return (decodedKeyParts[index] ?? null) as string | null;
  });

  return {
    cursor_value: manifestStream?.cursor_field
      ? ((rawData?.[manifestStream.cursor_field] ?? null) as string | number | null)
      : null,
    primary_key: primaryKey,
  };
}
