// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Readable rendering for array/object field values, so a record card never
 * dumps `JSON.stringify` at the owner. Purely structural — it reasons about
 * JS shapes (array vs. object, string vs. number, "does this object have a
 * field literally named `name`"), never about what a connector or field
 * MEANS. No connector-specific vocabulary, no field-name map keyed by
 * connector: every rule here applies identically to a Gmail `cc` array, a
 * GroupMe `attachments` array, or a field no connector has been written yet.
 */

const MAX_ITEMS = 3;

export interface StructuredCell {
  /** Full untruncated detail (e.g. every item, or an email address) for a hover title. */
  detail?: string;
  /** Display text, already length-bounded. Never a half-rendered JSON fragment. */
  text: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The first string-valued field on an object, preferring one literally named `name`. */
function primaryStringField(obj: Record<string, unknown>): string | null {
  if (typeof obj.name === "string" && obj.name.trim().length > 0) {
    return obj.name;
  }
  for (const value of Object.values(obj)) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return null;
}

/** A short label for one array item, structural only — never a connector field-name guess. */
function describeItem(item: unknown): string {
  if (typeof item === "string") {
    return item;
  }
  if (typeof item === "number" || typeof item === "boolean") {
    return String(item);
  }
  if (isPlainObject(item)) {
    return primaryStringField(item) ?? JSON.stringify(item);
  }
  return JSON.stringify(item);
}

function joinBounded(items: string[]): StructuredCell {
  const shown = items.slice(0, MAX_ITEMS);
  const text = shown.join(", ") + (items.length > MAX_ITEMS ? `, +${items.length - MAX_ITEMS} more` : "");
  const detail = items.length > MAX_ITEMS ? items.join(", ") : undefined;
  return detail ? { detail, text } : { text };
}

/**
 * Render an array or object field value as readable text instead of raw JSON.
 * Returns `null` for anything that is not an array/object (the caller's plain
 * stringification already handles strings/numbers/booleans/null/undefined) so
 * this never fabricates a value the field does not carry.
 *
 *   - empty array → an explicit empty-state marker, never silently blank.
 *   - array of scalars → joined, bounded to MAX_ITEMS with a "+N more" tail.
 *   - array of objects → each item reduced to its first string field (`name`
 *     preferred), joined the same way; the full list is available as `detail`
 *     for a hover title once truncated.
 *   - plain object → the same first-string-field reduction, single item.
 */
export function formatStructuredCell(value: unknown): StructuredCell | null {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return { text: "None" };
    }
    return joinBounded(value.map(describeItem));
  }
  if (isPlainObject(value)) {
    return { text: describeItem(value) };
  }
  return null;
}
