import { formatTimestamp } from './rs-client';

export type SemanticTimestamp = {
  field: string;
  value: string;
} | null;

export function humanizeFieldName(field: string): string {
  return field.replace(/_/g, ' ');
}

export function formatSemanticTimestamp(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return formatTimestamp(value);
}

export function pickSemanticTimestamp(
  metadata: { consent_time_field?: string | null; cursor_field?: string | null } | null | undefined,
  data: Record<string, unknown> | null | undefined,
): SemanticTimestamp {
  if (!metadata || !data) return null;
  const candidates = [metadata.consent_time_field, metadata.cursor_field].filter(
    (field, index, all): field is string =>
      typeof field === 'string' && field.length > 0 && all.indexOf(field) === index,
  );
  for (const field of candidates) {
    const value = data[field];
    if (typeof value === 'string' && value.trim()) {
      return { field, value: value.trim() };
    }
  }
  return null;
}

export function primaryTimestamp(
  semanticTimestamp: SemanticTimestamp,
  emittedAt: string,
): { value: string; label: string; secondary: { label: string; value: string } | null } {
  if (semanticTimestamp) {
    return {
      value: formatSemanticTimestamp(semanticTimestamp.value),
      label: humanizeFieldName(semanticTimestamp.field),
      secondary: { label: 'ingested', value: formatTimestamp(emittedAt) },
    };
  }
  return {
    value: formatTimestamp(emittedAt),
    label: 'ingested',
    secondary: null,
  };
}
