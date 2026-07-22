// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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
  // Lane B — COMPLETE (2026-05-28): anthropic, notion, oura, spotify, strava,
  // pocket, linkedin, shopify, and uber now wire emit-time validateRecord
  // (connectors/<name>/schemas.ts). Their entries were removed per the
  // shrink-only invariant. notion/oura/spotify/strava/pocket are
  // emit-shape-derived; anthropic/linkedin/shopify/uber are scaffolds that do
  // not yet emit a RECORD, so their schemas follow the manifest stream contract
  // (loom precedent) and the first real emit is shape-checked.
  // Lane C — COMPLETE (2026-05-28): heb, ical, meta, apple_health, doordash, and
  // wholefoods now wire emit-time validateRecord (connectors/<name>/schemas.ts).
  // Their entries were removed per the shrink-only invariant. ical and
  // apple_health are emit-shape-derived from their parser record builders
  // (buildEventRecord / buildHealthRecord / buildWorkoutRecord); heb, meta,
  // doordash, and wholefoods are browser scaffolds that do not yet emit a RECORD,
  // so their schemas follow the manifest stream contract (loom precedent) and
  // the first real emit is shape-checked rather than silently trusted.
  // The allowlist is now EMPTY: every stream-declaring connector validates its
  // emitted records. It is kept (rather than deleted) so the honesty gate keeps
  // running in BOTH directions — a connector that loses its validateRecord wiring
  // and is not re-added here fails the build, and a future schemaless connector
  // must make a deliberate, reviewed addition here. The map can only grow by an
  // explicit, justified escape-hatch entry; a new connector validates by default.
});
