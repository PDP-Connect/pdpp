/**
 * Explicit allowlist of connectors that declare manifest streams but do NOT yet
 * wire emit-time record validation (`validateRecord` / `makeValidateRecord`).
 *
 * This is the machine-checked successor to the green-prep audit's prose
 * inventory (`tmp/workstreams/ri-connector-schema-green-prep-audit-report.md`,
 * finding F1). The construction rule it backs lives in OpenSpec
 * `polyfill-runtime`: "Connectors declaring manifest streams SHALL validate
 * emitted records or be on a justified schemaless allowlist."
 *
 * The gate test (`connector-schema-validation-honesty.test.ts`) cross-checks
 * this list against the tree in BOTH directions every CI run:
 *   - a connector with manifest streams and no `validateRecord` that is NOT
 *     here fails the build (no silent schemaless drift);
 *   - a connector listed here that HAS started wiring `validateRecord` also
 *     fails the build, forcing its entry to be removed.
 *
 * Therefore this list can only shrink. Each schema authored under audit Lanes
 * A–C must delete the corresponding entry. When the map is empty, every
 * stream-declaring connector validates its records and this module can be
 * removed.
 *
 * Adding an entry is a deliberate, reviewed act — it is the documented escape
 * hatch, not a default. A new connector validates by default.
 */

export type SchemalessJustification = string;

export const SCHEMALESS_CONNECTOR_ALLOWLIST: Readonly<Record<string, SchemalessJustification>> = Object.freeze({
  // Lane A — COMPLETE (2026-05-28): google_takeout, twitter_archive, whatsapp,
  // imessage, and loom now wire emit-time validateRecord (connectors/<name>/
  // schemas.ts). Their entries were removed per the shrink-only invariant.

  // Lane B — medium risk: well-structured API responses, but no emit-side gate
  // catches unexpected field changes.
  anthropic: "Lane B: schemas.ts not yet authored (API connector).",
  notion: "Lane B: schemas.ts not yet authored (API connector).",
  oura: "Lane B: schemas.ts not yet authored (API connector).",
  spotify: "Lane B: schemas.ts not yet authored (API connector).",
  strava: "Lane B: schemas.ts not yet authored (API connector).",
  pocket: "Lane B: schemas.ts not yet authored (API connector).",
  linkedin: "Lane B: schemas.ts not yet authored (API connector).",
  shopify: "Lane B: schemas.ts not yet authored (API connector).",
  uber: "Lane B: schemas.ts not yet authored (API connector).",

  // Lane C — lower risk: upload-only or trivial record shapes. Still incomplete
  // per the authoring guide pre-ship checklist.
  heb: "Lane C: schemas.ts not yet authored (upload/trivial shape).",
  ical: "Lane C: schemas.ts not yet authored (upload/trivial shape).",
  meta: "Lane C: schemas.ts not yet authored (upload/trivial shape).",
  apple_health: "Lane C: schemas.ts not yet authored (upload/trivial shape).",
  doordash: "Lane C: schemas.ts not yet authored (upload/trivial shape).",
  wholefoods: "Lane C: schemas.ts not yet authored (upload/trivial shape).",
});
