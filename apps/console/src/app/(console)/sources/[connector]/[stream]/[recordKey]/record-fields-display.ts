/**
 * Pure display logic for the record-detail field/value table. Kept apart from
 * the JSX component so it can be unit-tested in the console's `node --test`
 * harness (which tests pure render helpers, not rendered JSX).
 *
 * This module is deliberately free of `server-only` dependencies — it does NOT
 * import the heavy `rs-client.ts` (which pulls `owner-token` → `server-only` and
 * cannot load under the test runner). It inlines the same non-null
 * stringification `stringifyCell` performs so the two stay behavior-identical.
 */
import { formatDeclaredAmount } from "@pdpp/operator-ui/lib/record-field-format";

export const ROW_DT = "pdpp-caption truncate text-muted-foreground font-mono";
export const ROW_DD = "pdpp-caption break-words";

// Mirror of `rs-client.ts`'s `stringifyCell` for non-null values: strings pass
// through; numbers/booleans stringify; everything else serializes to JSON. The
// null/undefined cases are handled by `renderValue` ahead of this call.
function stringifyValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export interface RenderedValue {
  /** True when the value carries no content (null/undefined/empty string). */
  empty: boolean;
  /** True when the value was formatted as a monetary amount. */
  money: boolean;
  /** Display text. */
  text: string;
}

/**
 * Resolve a single field value to its display text and presentation flags.
 *   - `null` → explicit `"null"` token (so a null payload field never reads as
 *     missing page content); `undefined` → an em dash.
 *   - a declared-currency minor-unit number → formatted money (`3000` → `$30.00`).
 *   - an empty string → an explicit `"empty"` token.
 *   - anything else → the same `stringifyCell` the stream table uses.
 */
export function renderValue(value: unknown, declaredType: string | undefined): RenderedValue {
  if (value === null || value === undefined) {
    return { text: value === null ? "null" : "—", empty: true, money: false };
  }
  const amount = formatDeclaredAmount(value, declaredType);
  if (amount) {
    return { text: amount.text, empty: false, money: true };
  }
  if (typeof value === "string" && value.length === 0) {
    return { text: "empty", empty: true, money: false };
  }
  return { text: stringifyValue(value), empty: false, money: false };
}

/** Tailwind classes for a value cell, tinting empties and aligning money. */
export function valueClassName(rendered: RenderedValue): string {
  if (rendered.empty) {
    return `${ROW_DD} text-muted-foreground italic`;
  }
  if (rendered.money) {
    return `${ROW_DD} tabular-nums`;
  }
  return ROW_DD;
}
