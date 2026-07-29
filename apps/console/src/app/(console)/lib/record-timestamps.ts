// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { formatTimestamp } from "./rs-client.ts";

export type SemanticTimestamp = {
  field: string;
  value: string;
} | null;

const UNDERSCORE_RE = /_/g;
const ISO_DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function humanizeFieldName(field: string): string {
  return field.replace(UNDERSCORE_RE, " ");
}

export function formatSemanticTimestamp(value: string): string {
  if (ISO_DATE_ONLY_RE.test(value)) {
    return value;
  }
  return formatTimestamp(value);
}

export function pickSemanticTimestamp(
  metadata: { consent_time_field?: string | null; cursor_field?: string | null } | null | undefined,
  data: Record<string, unknown> | null | undefined
): SemanticTimestamp {
  if (!(metadata && data)) {
    return null;
  }
  const candidates = [metadata.consent_time_field, metadata.cursor_field].filter(
    (field, index, all): field is string =>
      typeof field === "string" && field.length > 0 && all.indexOf(field) === index
  );
  for (const field of candidates) {
    const value = data[field];
    if (typeof value === "string" && value.trim()) {
      return { field, value: value.trim() };
    }
  }
  return null;
}

export function primaryTimestamp(
  semanticTimestamp: SemanticTimestamp,
  emittedAt: string
): { value: string; label: string; secondary: { label: string; value: string } | null } {
  if (semanticTimestamp) {
    return {
      label: humanizeFieldName(semanticTimestamp.field),
      secondary: { label: "ingested", value: formatTimestamp(emittedAt) },
      value: formatSemanticTimestamp(semanticTimestamp.value),
    };
  }
  return {
    label: "ingested",
    secondary: null,
    value: formatTimestamp(emittedAt),
  };
}
