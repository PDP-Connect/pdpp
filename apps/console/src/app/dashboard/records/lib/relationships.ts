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

/** Minimal manifest shapes for deriving declared forward relations. */
interface ManifestRelationship {
  cardinality?: "has_one" | "has_many";
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
 * Derive the declared forward relations that point AT `childStream`, from a
 * connector manifest's stream declarations. A relation counts only when it is
 * both declared in a parent stream's `relationships[]` AND enabled in that
 * stream's `query.expand[]` — exactly the pair the server projects into
 * `expand_capabilities`. This is a manifest-declaration source (the only source
 * of truth), never raw payload inspection. Used to draw the child → parent
 * back-link (Decision D6) without issuing N per-stream metadata requests.
 */
export function parentRelationsForChild(
  streams: ManifestStreamShape[] | undefined,
  childStream: string
): Array<{ capability: ExpandCapability; parentStream: string }> {
  if (!Array.isArray(streams)) {
    return [];
  }
  const out: Array<{ capability: ExpandCapability; parentStream: string }> = [];
  for (const parent of streams) {
    const enabled = new Set((parent.query?.expand ?? []).map((entry) => entry.name));
    for (const relationship of parent.relationships ?? []) {
      if (relationship.stream !== childStream || !enabled.has(relationship.name)) {
        continue;
      }
      out.push({
        parentStream: parent.name,
        capability: {
          name: relationship.name,
          stream: relationship.stream,
          target_stream: relationship.stream,
          cardinality: relationship.cardinality === "has_one" ? "has_one" : "has_many",
          child_parent_key_field: relationship.foreign_key,
          foreign_key: relationship.foreign_key,
        },
      });
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
