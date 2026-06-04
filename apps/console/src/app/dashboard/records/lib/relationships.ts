/**
 * Console relationship navigation — pure helpers.
 *
 * Relationships come ONLY from `expand_capabilities` returned by
 * `GET /v1/streams/<s>` (the manifest's declared, grant-scoped relations). The
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

function recordsBasePath(connectionId: string): string {
  return `/dashboard/records/${encodeURIComponent(connectionId)}`;
}

/** Minimal manifest shapes for pruning which parent streams need metadata reads. */
interface ManifestRelationship {
  name: string;
  stream?: string;
  foreign_key?: string;
  cardinality?: string;
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
 * `expand_capabilities` metadata. This is the only relationship source used for
 * link construction; a local manifest may identify which parent metadata to
 * fetch, but it must not fabricate `child_parent_key_field` or target-stream
 * values for links.
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
      out.push({ parentStream: parent.parentStream, capability });
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
  const base = recordsBasePath(args.connectionId);

  return expandCapabilities.map((cap): RelatedLink => {
    const targetStream = cap.target_stream ?? cap.stream ?? "";
    const childParentKeyField = cap.child_parent_key_field ?? cap.foreign_key;
    const cardinality: "has_one" | "has_many" = cap.cardinality === "has_one" ? "has_one" : "has_many";

    const link: RelatedLink = {
      relation: cap.name,
      targetStream,
      cardinality,
      childParentKeyField,
      navigable: false,
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
      const filterQuery = `filter[${encodeURIComponent(childParentKeyField)}]=${encodeURIComponent(args.parentRecordKey)}`;
      link.href = `${base}/${encodeURIComponent(targetStream)}?${filterQuery}`;
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
      parentStream: rel.stream,
      href: `${base}/${encodeURIComponent(rel.stream)}/${encodeURIComponent(value)}`,
    });
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
  args: { connectionId: string }
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
    const value = childRecordData[childParentKeyField];
    if (typeof value !== "string" || value.length === 0) {
      continue;
    }
    return {
      childParentKeyField,
      parentStream,
      href: `${base}/${encodeURIComponent(parentStream)}/${encodeURIComponent(value)}`,
    };
  }
  return null;
}
