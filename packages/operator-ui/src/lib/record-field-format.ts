/**
 * Declared-type-aware value formatting for record fields.
 *
 * The implementation now lives in the shared design-system LEAF
 * `@pdpp/brand/record-format` so every surface — the React component library
 * `@pdpp/brand-react`, this console substrate, and the console record pages —
 * shares ONE source of truth without `@pdpp/brand-react` having to depend on
 * `@pdpp/operator-ui`. This module is a thin re-export preserving the historical
 * `@pdpp/operator-ui/lib/record-field-format` import path for the console record
 * pages and `record-preview.ts`.
 *
 * A connector manifest may declare a field's presentation type via the
 * `x_pdpp_type` JSON-Schema extension, surfaced read-only on the read contract
 * as `field_capabilities[field].type`. The formatter turns that declared type
 * into a display string for a single field value — most importantly, rendering a
 * monetary minor-units field (chase `amount`, documented "signed amount in
 * cents") as `$30.00` rather than the raw integer `3000`.
 *
 * It is presentation metadata only: never written back, never sent to the
 * resource server, never treated as a manifest field. A field with no declared
 * type (or an unrecognized one) is left to the caller's plain stringification —
 * it deliberately does NOT apply a magnitude heuristic, so a bare undeclared
 * integer is never silently reinterpreted as cents.
 *
 * `record-preview.ts` consumes the same minor-units detection so the Explorer
 * feed and the console record surfaces agree on how a declared currency field
 * is formatted.
 */
// biome-ignore-all lint/performance/noBarrelFile: this preserves the historical
// `@pdpp/operator-ui/lib/record-field-format` import seam (the console record
// pages and `record-preview.ts` import here) while the implementation lives in
// the framework-free `@pdpp/brand` leaf — so `@pdpp/brand-react` need not depend
// on `@pdpp/operator-ui`.
export type { DeclaredFieldTypes, FormattedAmount } from "@pdpp/brand/record-format";
export { deriveDeclaredFieldTypes, formatDeclaredAmount, isMonetaryDeclaredType } from "@pdpp/brand/record-format";
