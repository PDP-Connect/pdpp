// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Console relationship navigation — pure helpers.
 *
 * Relationships come only from declared metadata: `expand_capabilities` returned
 * by `GET /v1/streams/<s>` and bundled manifest `relationships[]` entries. The
 * console never inspects raw payload fields to guess at links: a field that
 * merely *looks* like a foreign key is plain text unless a declared relation
 * covers it.
 *
 * The reference's join is asymmetric (see the OpenSpec design note
 * `add-record-relationship-navigation`):
 *
 *   - `child_parent_key_field` lives on the CHILD record and holds the PARENT
 *     record's key — it is NOT the child's own record key.
 *   - From a PARENT record, a `has_many` relation navigates to the child
 *     stream's list filtered by `child_parent_key_field = <parent key>` (the
 *     children, never a single child-detail URL built from the parent key).
 *   - From a CHILD record, a field matching a declared relation's
 *     `child_parent_key_field` links back to the PARENT record's detail page,
 *     because that field's value IS the parent's record key. This is a
 *     console-only affordance; it does not imply server-side reverse expansion.
 *
 * Server-only / framework-agnostic: this module builds hrefs and decisions from
 * plain data so it is unit-testable without a running server or React.
 */

import type { ExpandCapability } from "../../lib/rs-client.ts";

/** A declared relationship rendered on the parent record's detail page. */
export interface RelatedLink {
  /** Advisory copy for non-navigable relations (the manifest `reason`, mapped). */
  advisory?: string;
  cardinality: "has_one" | "has_many";
  childParentKeyField?: string;
  /** Relative href when navigable; absent when inert. */
  href?: string;
  /** True when this relation renders as a link. */
  navigable: boolean;
  /** The relation name (`expand_capabilities[*].name`). */
  relation: string;
  targetStream: string;
}

/** A child-record field that links back to its declared parent record. */
export interface ParentBackLink {
  /** The field on the child carrying the parent key. */
  childParentKeyField: string;
  href: string;
  parentStream: string;
}

/**
 * A reverse link from a PARENT record's detail page down to one of its child
 * streams' filtered record lists, derived from a child-declared `has_one`.
 */
export interface ReverseChildListLink {
  /** The child stream this link targets. */
  childStream: string;
  /** The child field (declared `foreign_key`) holding the parent's key. */
  foreignKey: string;
  /** Filtered child-list href: `…/<child>?filter[<fk>]=<parentKey>`. */
  href: string;
}

function recordsBasePath(connectionId: string): string {
  return `/sources/${encodeURIComponent(connectionId)}`;
}

/**
 * Build the bounded, server-filterable child-**list** href for a parent →
 * children navigation: `…/<child>?filter[<fk>]=<parentKey>`. Each path segment
 * and the filter value are percent-encoded; this is the only correct target for
 * a parent key (it is the filter value, never a child record-detail segment).
 *
 * Shared by the forward `has_many` path (`buildRelatedLinks`) and the reverse
 * child-declared `has_one` path (`reverseChildListLinksFromManifest`) so both
 * directions resolve to the identical location and encoding.
 */
function filteredChildListHref(args: {
  connectionId: string;
  childStream: string;
  foreignKey: string;
  parentKey: string;
}): string {
  const base = recordsBasePath(args.connectionId);
  const filterQuery = `filter[${encodeURIComponent(args.foreignKey)}]=${encodeURIComponent(args.parentKey)}`;
  return `${base}/${encodeURIComponent(args.childStream)}?${filterQuery}`;
}

/**
 * Bundled manifests use a URL-form `connector_id` and also carry the short
 * `connector_key`; reference connections report the short key. Resolve against
 * both namespaces so manifest-grounded relationship navigation does not silently
 * disappear for live connections.
 */
export interface ManifestIdentity {
  connector_id?: string;
  connector_key?: string;
}

export function manifestMatchesConnectorId(
  manifest: ManifestIdentity,
  connectorId: string | null | undefined
): boolean {
  if (!connectorId) {
    return false;
  }
  return manifest.connector_id === connectorId || manifest.connector_key === connectorId;
}

export function findManifestForConnectorId<T extends ManifestIdentity>(
  manifests: readonly T[],
  connectorId: string | null | undefined
): T | undefined {
  return manifests.find((manifest) => manifestMatchesConnectorId(manifest, connectorId));
}

/** Minimal manifest shapes for pruning which parent streams need metadata reads. */
interface ManifestRelationship {
  cardinality?: string;
  foreign_key?: string;
  name: string;
  stream?: string;
}
interface ManifestStreamShape {
  name: string;
  query?: { expand?: Array<{ name: string }> };
  relationships?: ManifestRelationship[];
}

/**
 * Use the local manifest only as a candidate index for parent streams whose
 * metadata might advertise a relation to `childStream`. The linkable relation
 * itself is still taken from live `expand_capabilities` via
 * `parentRelationsForChild`; this helper is a performance filter, not a source
 * of link semantics.
 */
export function candidateParentStreamsForChild(
  streams: ManifestStreamShape[] | undefined,
  childStream: string
): string[] {
  if (!Array.isArray(streams)) {
    return [];
  }
  const out: string[] = [];
  for (const parent of streams) {
    const enabled = new Set((parent.query?.expand ?? []).map((entry) => entry.name));
    for (const relationship of parent.relationships ?? []) {
      if (relationship.stream !== childStream || !enabled.has(relationship.name)) {
        continue;
      }
      out.push(parent.name);
    }
  }
  return [...new Set(out)];
}

interface ParentStreamCapabilities {
  expandCapabilities?: ExpandCapability[];
  parentStream: string;
}

/**
 * Derive child → parent console links from the parent streams' live
 * `expand_capabilities` metadata. A local manifest may identify which parent
 * metadata to fetch, but this helper must not fabricate
 * `child_parent_key_field` or target-stream values for links.
 */
export function parentRelationsForChild(
  parentStreams: ParentStreamCapabilities[],
  childStream: string
): Array<{ capability: ExpandCapability; parentStream: string }> {
  const out: Array<{ capability: ExpandCapability; parentStream: string }> = [];
  for (const parent of parentStreams) {
    for (const capability of parent.expandCapabilities ?? []) {
      if (capability.usable !== true) {
        continue;
      }
      const targetStream = capability.target_stream ?? capability.stream;
      if (targetStream !== childStream) {
        continue;
      }
      const childParentKeyField = capability.child_parent_key_field ?? capability.foreign_key;
      if (!childParentKeyField) {
        continue;
      }
      out.push({ capability, parentStream: parent.parentStream });
    }
  }
  return out;
}

/** Map a manifest `reason` enum value to calm operator-facing advisory copy. */
export function advisoryForReason(reason: string | undefined): string {
  switch (reason) {
    case "related_stream_not_granted":
      return "The related stream is not in this grant.";
    case "related_stream_unknown":
      return "The related stream is not in the current manifest.";
    case "related_stream_not_loaded":
      return "The related stream is not loaded.";
    default:
      return "This relationship is not available here.";
  }
}

/**
 * Build the "Related" section for a parent record's detail page from the parent
 * stream's `expand_capabilities` and the displayed parent record's key.
 *
 *   - `has_many` (usable): link to the child list filtered by
 *     `child_parent_key_field = <parent key>`. Never a child-detail URL.
 *   - `has_one` (usable): a child-detail link is only well-formed when the
 *     parent carries the child's record key for the relation. No first-party
 *     GitHub `has_one` ships in this tranche, so without a resolvable child key
 *     the relation renders as an inert "no related <relation>" chip rather than
 *     a fabricated link.
 *   - `usable: false`: inert text carrying the manifest `reason` as advisory.
 */
export function buildRelatedLinks(
  expandCapabilities: ExpandCapability[] | undefined,
  args: { connectionId: string; parentRecordKey: string }
): RelatedLink[] {
  if (!Array.isArray(expandCapabilities)) {
    return [];
  }

  return expandCapabilities.map((cap): RelatedLink => {
    const targetStream = cap.target_stream ?? cap.stream ?? "";
    const childParentKeyField = cap.child_parent_key_field ?? cap.foreign_key;
    const cardinality: "has_one" | "has_many" = cap.cardinality === "has_one" ? "has_one" : "has_many";

    const link: RelatedLink = {
      cardinality,
      childParentKeyField,
      navigable: false,
      relation: cap.name,
      targetStream,
    };

    if (cap.usable !== true) {
      link.advisory = advisoryForReason(cap.reason);
      return link;
    }

    if (!(targetStream && childParentKeyField)) {
      // Usable but underspecified — surface calmly rather than building a
      // malformed link.
      link.advisory = `No related ${cap.name || "records"}.`;
      return link;
    }

    if (cardinality === "has_many") {
      // Child list filtered by the parent's key. The parent key is NOT a child
      // record key, so this is the only correct target.
      link.href = filteredChildListHref({
        childStream: targetStream,
        connectionId: args.connectionId,
        foreignKey: childParentKeyField,
        parentKey: args.parentRecordKey,
      });
      link.navigable = true;
      return link;
    }

    // has_one: a child-detail link requires the parent to carry the child's
    // record key for this relation. That key is not derivable from the parent's
    // own key, and no first-party relation supplies one in this tranche, so we
    // render an inert chip instead of fabricating a child-detail URL from the
    // parent key.
    link.advisory = `No related ${cap.name || "record"}.`;
    return link;
  });
}

/**
 * Build child → parent links from `has_one` relationships declared on the child
 * stream's own manifest entry. This covers connectors (like Chase) that declare
 * `has_one` on the child rather than on a parent with `query.expand`.
 *
 * The manifest declaration is the source of truth for relationship structure;
 * the child record's field value (`foreign_key`) is the parent record's key.
 * Only `has_one` cardinality is handled here — `has_many` is navigated from the
 * parent side via `buildRelatedLinks`.
 *
 * Returns one `ParentBackLink` per usable declared `has_one` relationship where
 * the record carries a non-empty string value for the declared `foreign_key`.
 */
export function childHasOneBackLinksFromManifest(
  childManifestStream: ManifestStreamShape | undefined,
  childRecordData: Record<string, unknown> | undefined,
  args: { connectionId: string }
): ParentBackLink[] {
  if (!(childManifestStream && childRecordData && typeof childRecordData === "object")) {
    return [];
  }
  const base = recordsBasePath(args.connectionId);
  const out: ParentBackLink[] = [];
  for (const rel of childManifestStream.relationships ?? []) {
    if (rel.cardinality !== "has_one" || !rel.stream || !rel.foreign_key) {
      continue;
    }
    const value = childRecordData[rel.foreign_key];
    if (typeof value !== "string" || value.length === 0) {
      continue;
    }
    out.push({
      childParentKeyField: rel.foreign_key,
      href: `${base}/${encodeURIComponent(rel.stream)}/${encodeURIComponent(value)}`,
      parentStream: rel.stream,
    });
  }
  return out;
}

/**
 * The set of fields on a child stream that a declared `has_one` relationship
 * makes into a parent-record link. This is the child-declared analogue of the
 * `expand_capabilities` parent-link fields the record list page already
 * resolves per cell; it lets the list page render a child-declared `has_one`
 * foreign-key cell (Chase `transactions.account_id`, a YNAB transaction's
 * `account_id`/`transfer_account_id`, Slack `messages.channel_id`, …) as a link
 * to the parent record's detail page — the same affordance the record detail
 * page already shows for these edges, just rendered in-place.
 *
 * Returns only the field names; the per-cell resolver computes the href from the
 * record's value via `childHasOneBackLinksFromManifest`, so link semantics stay
 * in one place and a field with an absent/empty value yields no link.
 */
export function childHasOneLinkFields(childManifestStream: ManifestStreamShape | undefined): Set<string> {
  const fields = new Set<string>();
  for (const rel of childManifestStream?.relationships ?? []) {
    if (rel.cardinality === "has_one" && rel.stream && rel.foreign_key) {
      fields.add(rel.foreign_key);
    }
  }
  return fields;
}

/**
 * Resolve a single child-declared `has_one` back-link for one `(record, field)`
 * cell on the record list page. Returns the `ParentBackLink` for the declared
 * relation whose `foreign_key` is `field` when the record carries a non-empty
 * string value there, or `null` otherwise. Built on
 * `childHasOneBackLinksFromManifest` so the href, encoding, and empty-value
 * rules are identical to every other child → parent edge.
 */
export function childHasOneBackLinkForField(
  childManifestStream: ManifestStreamShape | undefined,
  childRecordData: Record<string, unknown> | undefined,
  field: string,
  args: { connectionId: string }
): ParentBackLink | null {
  const links = childHasOneBackLinksFromManifest(childManifestStream, childRecordData, args);
  return links.find((link) => link.childParentKeyField === field) ?? null;
}

/**
 * Stable key identifying a filtered child-list target as `(child stream, filter
 * field)`. The parent key is constant for a given parent detail page, so it is
 * not part of the key. Used to deduplicate a reverse child-declared `has_one`
 * link against a forward parent-declared `has_many` link that resolves to the
 * same filtered list. The parts are JSON-encoded as a 2-tuple, so the key is
 * collision-free even when a stream or field name contains separators.
 */
export function reverseChildListDedupKey(childStream: string, foreignKey: string): string {
  return JSON.stringify([childStream, foreignKey]);
}

/**
 * Inverse of `childHasOneBackLinksFromManifest`: from a displayed PARENT record,
 * build one link per child stream that declares a `has_one` back to the parent,
 * pointing at the child stream's bounded, server-filtered record **list**
 * (`…/<child>?filter[<fk>]=<parentKey>`).
 *
 * The relationship structure is read from each child stream's own declared
 * `relationships[]` (a manifest declaration) — the same `has_one` the forward
 * child → parent back-link reads, just traversed in the opposite direction. No
 * child records are loaded and no child record-**detail** URL is built: the
 * parent key is only ever the filter value, since it is the parent's key and not
 * a child record key.
 *
 * `alreadyLinked` carries the dedup keys (see `reverseChildListDedupKey`) of any
 * forward `has_many` links already rendered for this parent, so a stream that is
 * reachable both as a parent-declared `has_many` and a child-declared `has_one`
 * renders a single link, not two.
 */
export function reverseChildListLinksFromManifest(
  connectorStreams: ManifestStreamShape[] | undefined,
  args: { connectionId: string; parentStream: string; parentRecordKey: string },
  alreadyLinked?: ReadonlySet<string>
): ReverseChildListLink[] {
  if (!(Array.isArray(connectorStreams) && args.parentStream && args.parentRecordKey)) {
    return [];
  }
  const seen = new Set<string>(alreadyLinked ?? []);
  const out: ReverseChildListLink[] = [];
  for (const childStream of connectorStreams) {
    if (!childStream?.name) {
      continue;
    }
    for (const rel of childStream.relationships ?? []) {
      if (rel.cardinality !== "has_one" || rel.stream !== args.parentStream || !rel.foreign_key) {
        continue;
      }
      const dedupKey = reverseChildListDedupKey(childStream.name, rel.foreign_key);
      if (seen.has(dedupKey)) {
        continue;
      }
      seen.add(dedupKey);
      out.push({
        childStream: childStream.name,
        foreignKey: rel.foreign_key,
        href: filteredChildListHref({
          childStream: childStream.name,
          connectionId: args.connectionId,
          foreignKey: rel.foreign_key,
          parentKey: args.parentRecordKey,
        }),
      });
    }
  }
  return out;
}

/** A child stream that declares a `has_one` back to a given parent stream. */
export interface ReverseChildEdge {
  childStream: string;
  foreignKey: string;
}

/**
 * The set of child streams in a connector manifest that declare a `has_one`
 * targeting `parentStream` — the page-level prerequisite for rendering reverse
 * parent → filtered-child-list links on the parent **list** page.
 *
 * The displayed stream is the same for every row of a list page, so the reverse
 * child-edge set is constant per page and is computed once here; each row then
 * substitutes its own record key as the filter value via
 * `reverseChildListLinksFromManifest`. Returns an empty array when the manifest
 * is missing, the parent stream is empty, or no child declares a matching
 * `has_one` — in which case the list page draws no per-row reverse links and does
 * no per-row work. Reads the same child-declared `has_one` entries (cardinality
 * `has_one`, related `stream === parentStream`, non-empty `foreign_key`) as
 * `reverseChildListLinksFromManifest`, so the edge set and the per-row links stay
 * in agreement; `has_many` declarations and payload field names never contribute.
 */
export function reverseChildListEdgesFromManifest(
  connectorStreams: ManifestStreamShape[] | undefined,
  parentStream: string
): ReverseChildEdge[] {
  if (!(Array.isArray(connectorStreams) && parentStream)) {
    return [];
  }
  const seen = new Set<string>();
  const out: ReverseChildEdge[] = [];
  for (const childStream of connectorStreams) {
    if (!childStream?.name) {
      continue;
    }
    for (const rel of childStream.relationships ?? []) {
      if (rel.cardinality !== "has_one" || rel.stream !== parentStream || !rel.foreign_key) {
        continue;
      }
      const dedupKey = reverseChildListDedupKey(childStream.name, rel.foreign_key);
      if (seen.has(dedupKey)) {
        continue;
      }
      seen.add(dedupKey);
      out.push({ childStream: childStream.name, foreignKey: rel.foreign_key });
    }
  }
  return out;
}

/**
 * Stable key identifying a child → parent back-link as `(parent stream, child
 * field carrying the parent key)`. Two declared `has_one` edges from the same
 * child stream to the same parent stream via *different* fields (for example a
 * YNAB transaction's `account_id` and `transfer_account_id`, both → `accounts`)
 * resolve to *different* parent records, so they are distinct links and SHALL
 * both render; deduplicating on parent stream alone would silently drop one. The
 * field is part of the key for exactly that reason. The two parts are
 * JSON-encoded as a 2-tuple, so the key is collision-free even when a stream or
 * field name contains separators.
 */
export function parentBackLinkDedupKey(parentStream: string, childParentKeyField: string): string {
  return JSON.stringify([parentStream, childParentKeyField]);
}

/**
 * Merge the two child → parent back-link sources for a displayed child record —
 * the parent streams' `expand_capabilities` (`findParentBackLink`, at most one)
 * and the child stream's own declared `has_one` relationships
 * (`childHasOneBackLinksFromManifest`, zero or more) — into the de-duplicated
 * list the detail page renders.
 *
 * Both sources are manifest declarations that resolve to a parent record keyed
 * by the value the child carries in the relation's parent-key field, so the
 * dedup key is `(parentStream, childParentKeyField)` — NOT the parent stream
 * alone. The same edge discovered via both sources (same field) collapses to one
 * link; two distinct edges to the same parent stream via different fields both
 * survive, because they point at different parent records. The metadata-derived
 * link is preferred when both sources describe the same `(parentStream, field)`.
 */
export function mergeParentBackLinks(
  metadataBackLink: ParentBackLink | null,
  childDeclaredBackLinks: readonly ParentBackLink[]
): ParentBackLink[] {
  const seen = new Set<string>();
  const out: ParentBackLink[] = [];
  for (const link of [...(metadataBackLink ? [metadataBackLink] : []), ...childDeclaredBackLinks]) {
    const key = parentBackLinkDedupKey(link.parentStream, link.childParentKeyField);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(link);
  }
  return out;
}

/**
 * For a CHILD record being displayed, find the declared forward relation (from
 * any parent stream's metadata) whose `child_parent_key_field` matches a field
 * carried on the child, and return a link back to the parent record keyed by
 * that field's value.
 *
 * `parentRelations` is the union of `expand_capabilities` entries discovered
 * from the parent streams' metadata, each tagged with its owning parent stream.
 * The console discovers these from metadata only — never by guessing from the
 * child payload.
 */
export function findParentBackLink(
  childStream: string,
  childRecordData: Record<string, unknown> | undefined,
  parentRelations: Array<{ parentStream: string; capability: ExpandCapability }>,
  args: { childParentKeyField?: string; connectionId: string }
): ParentBackLink | null {
  if (!(childRecordData && typeof childRecordData === "object")) {
    return null;
  }
  const base = recordsBasePath(args.connectionId);

  for (const { parentStream, capability } of parentRelations) {
    const targetStream = capability.target_stream ?? capability.stream;
    if (targetStream !== childStream) {
      continue;
    }
    const childParentKeyField = capability.child_parent_key_field ?? capability.foreign_key;
    if (!childParentKeyField) {
      continue;
    }
    if (args.childParentKeyField && childParentKeyField !== args.childParentKeyField) {
      continue;
    }
    const value = childRecordData[childParentKeyField];
    if (typeof value !== "string" || value.length === 0) {
      continue;
    }
    return {
      childParentKeyField,
      href: `${base}/${encodeURIComponent(parentStream)}/${encodeURIComponent(value)}`,
      parentStream,
    };
  }
  return null;
}
