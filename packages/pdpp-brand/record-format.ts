/**
 * Declared-type-aware value formatting for record fields — a framework-agnostic,
 * dependency-free leaf module.
 *
 * A connector manifest may declare a field's presentation type via the
 * `x_pdpp_type` JSON-Schema extension, surfaced read-only on the read contract
 * as `field_capabilities[field].type`. This module turns that declared type into
 * a display string for a single field value — most importantly, rendering a
 * monetary minor-units field (chase `amount`, documented "signed amount in
 * cents") as `$30.00` rather than the raw integer `3000`.
 *
 * It is presentation metadata only: never written back, never sent to the
 * resource server, never treated as a manifest field. A field with no declared
 * type (or an unrecognized one) is left to the caller's plain stringification —
 * this module deliberately does NOT apply a magnitude heuristic, so a bare
 * undeclared integer is never silently reinterpreted as cents.
 *
 * This lives in `@pdpp/brand` (the shared design-system LEAF) so every consumer
 * — the React component library `@pdpp/brand-react`, the console substrate
 * `@pdpp/operator-ui` (which re-exports it), and the console record pages —
 * shares ONE source of truth without any of them depending on the others. The
 * dependency direction stays apps → {operator-ui, brand-react} → brand.
 */

/**
 * Maps a field's wire key → its declared presentation type (from
 * `field_capabilities[field].type`). Presentation-only and read-only; only field
 * names that carry a declared type appear here. Inlined here (rather than pulling
 * in operator-ui's `record-kind.ts`) to keep this module a self-contained leaf.
 */
export type DeclaredFieldTypes = Readonly<Record<string, string>>;

// Declared presentation types denoting a monetary value carried in MINOR units
// (integer cents). `currency` is the vocabulary the pilot manifests use (e.g.
// chase `amount`); the explicit aliases future-proof the same intent. A field
// with one of these declared types is divided by 100, independent of magnitude.
const MINOR_UNITS_TYPE_RE = /^(currency|currency_minor_units|minor_units|cents)$/;
// Declared types denoting MILLI units (thousandths), e.g. YNAB-style amounts.
const MILLI_UNITS_TYPE_RE = /^(currency_milliunits|milliunits|milli_units)$/;

export interface FormattedAmount {
  positive: boolean;
  text: string;
}

function normalizeType(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function formatDollars(n: number): FormattedAmount {
  const positive = n >= 0;
  const sign = positive ? "" : "-";
  return { text: `${sign}$${Math.abs(n).toFixed(2)}`, positive };
}

/**
 * Format a numeric value as a monetary amount IFF the declared type names a
 * monetary unit (minor units → ÷100, milli units → ÷1000). Returns null when
 * the value is not a finite number or the declared type is not monetary — in
 * which case the caller keeps its plain rendering. No magnitude heuristic: an
 * undeclared field is never guessed at here.
 */
export function formatDeclaredAmount(value: unknown, declaredType: unknown): FormattedAmount | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const declared = normalizeType(declaredType);
  if (!declared) {
    return null;
  }
  if (MINOR_UNITS_TYPE_RE.test(declared)) {
    return formatDollars(value / 100);
  }
  if (MILLI_UNITS_TYPE_RE.test(declared)) {
    return formatDollars(value / 1000);
  }
  return null;
}

/** True when the declared type names a monetary unit this module formats. */
export function isMonetaryDeclaredType(declaredType: unknown): boolean {
  const declared = normalizeType(declaredType);
  return declared !== null && (MINOR_UNITS_TYPE_RE.test(declared) || MILLI_UNITS_TYPE_RE.test(declared));
}

interface StreamMetadataLike {
  field_capabilities?: Record<string, { type?: unknown } | null | undefined> | null;
}

/**
 * Build the declared field-type map from a stream's `field_capabilities`,
 * keeping only entries that carry a non-empty string `type`. Mirrors the
 * Explorer feed's derivation so every surface reads the same declared types.
 * Returns an empty object when no field declares a type.
 */
export function deriveDeclaredFieldTypes(metadata: StreamMetadataLike | null | undefined): DeclaredFieldTypes {
  const raw = metadata?.field_capabilities;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const entries: Array<readonly [string, string]> = [];
  for (const [name, cap] of Object.entries(raw)) {
    const type = normalizeType(cap?.type);
    if (type) {
      entries.push([name, type]);
    }
  }
  return Object.fromEntries(entries);
}
