// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

export interface SearchTimestampMetadata {
  consent_time_field?: string | null;
  cursor_field?: string | null;
}

export interface SearchDisplayTimestamp {
  emittedAt: string;
  /**
   * True when `value` is a declared semantic/authored timestamp (from
   * `consent_time_field` / `cursor_field`); false when it fell back to
   * `emitted_at`. Structural — consumers MUST NOT infer this by comparing
   * `value` to `emittedAt`, because an authored time can legitimately equal
   * the ingest time.
   */
  isSemantic: boolean;
  label: string;
  value: string;
}

const UNDERSCORE_RE = /_/g;

export function searchTimestampMetadataKey(connectorId: string, stream: string): string {
  return `${connectorId}::${stream}`;
}

export function lookupSearchTimestampMetadata(
  metadataByKey: ReadonlyMap<string, SearchTimestampMetadata>,
  connectorId: string,
  stream: string
): SearchTimestampMetadata | null {
  return metadataByKey.get(searchTimestampMetadataKey(connectorId, stream)) ?? null;
}

function humanizeFieldName(field: string): string {
  return field.replace(UNDERSCORE_RE, " ");
}

// Below this, a numeric timestamp is treated as Unix SECONDS; at or above it, as
// Unix MILLISECONDS. 1e12 seconds is the year 33658 and 1e12 ms is 2001 — any real
// record date is unambiguous against this boundary.
const EPOCH_MS_THRESHOLD = 1e12;

/**
 * Coerce a manifest-declared timestamp field value to a clean ISO-8601 string.
 * Connectors emit timestamps in different shapes — an ISO string (most), or a
 * Unix epoch NUMBER (e.g. ChatGPT `create_time` / `update_time` are float
 * seconds). Both must resolve to a displayable, sortable instant. Returns null
 * for anything that is not a finite date so the caller falls back to emitted_at.
 */
function coerceTimestampValue(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const ms = value >= EPOCH_MS_THRESHOLD ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

function pickDeclaredTimestamp(
  metadata: SearchTimestampMetadata | null | undefined,
  data: Record<string, unknown> | null | undefined
): { field: string; value: string } | null {
  if (!(metadata && data)) {
    return null;
  }
  const candidates = [metadata.consent_time_field, metadata.cursor_field].filter(
    (field, index, all): field is string =>
      typeof field === "string" && field.length > 0 && all.indexOf(field) === index
  );
  for (const field of candidates) {
    const value = coerceTimestampValue(data[field]);
    if (value) {
      return { field, value };
    }
  }
  return null;
}

export function pickSearchDisplayTimestamp({
  data,
  emittedAt,
  metadata,
}: {
  data: Record<string, unknown> | null | undefined;
  emittedAt: string;
  metadata: SearchTimestampMetadata | null | undefined;
}): SearchDisplayTimestamp {
  const semantic = pickDeclaredTimestamp(metadata, data);
  if (semantic) {
    return {
      emittedAt,
      label: humanizeFieldName(semantic.field),
      value: semantic.value,
      isSemantic: true,
    };
  }
  return { emittedAt, label: "emitted", value: emittedAt, isSemantic: false };
}
