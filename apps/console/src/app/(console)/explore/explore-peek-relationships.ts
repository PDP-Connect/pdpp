// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Server-side relationship composition for the Explore inspector.
 *
 * Relationships in Explore are derived from the SAME declared metadata the
 * records detail page uses — never from heuristics over payload field names.
 * This module mirrors the detail page's composition at
 * `records/[connector]/[stream]/[recordKey]/page.tsx` (the parent → child,
 * reverse child-list, and child → parent back-link passes) so there is ONE
 * source of truth for relationship navigation: `records/lib/relationships.ts`.
 *
 * The inspector itself is a Client Component (ExploreCanvas). Relationship links
 * are plain serializable data (`RelatedLink` / `ParentBackLink` /
 * `ReverseChildListLink`), so the live Server Component (`page.tsx`) loads the
 * declared metadata here and passes the resolved links down as props. The hrefs
 * point into the records route (`/sources/...`) — the same targets the
 * detail page produces — keeping the href logic unforked.
 */

import type { DashboardDataSource } from "../lib/data-source.ts";
import type { ExpandCapability } from "../lib/rs-client.ts";
import {
  buildRelatedLinks,
  candidateParentStreamsForChild,
  childHasOneBackLinksFromManifest,
  findManifestForConnectorId,
  findParentBackLink,
  mergeParentBackLinks,
  type ParentBackLink,
  parentRelationsForChild,
  type RelatedLink,
  type ReverseChildListLink,
  reverseChildListDedupKey,
  reverseChildListLinksFromManifest,
} from "../sources/lib/relationships.ts";

/** A minimal manifest stream shape, matching the detail page's local type. */
interface ManifestStream {
  name: string;
  query?: { expand?: Array<{ name: string }> };
  relationships?: Array<{ name: string; stream?: string; foreign_key?: string; cardinality?: string }>;
}

/**
 * The resolved relationship links for one inspected record — the serializable
 * payload the inspector renders. Every list is plain data; nothing here carries
 * a function or a live handle, so it crosses the RSC boundary cleanly.
 */
export interface PeekRelationships {
  /** Child → parent back-links (declared `has_one`, merged from both sources). */
  parentBackLinks: ParentBackLink[];
  /** Parent → child relations declared on this stream (`expand_capabilities`). */
  relatedLinks: RelatedLink[];
  /** Reverse parent → filtered-child-list links from child-declared `has_one`. */
  reverseChildListLinks: ReverseChildListLink[];
}

/** Whether any relationship link exists (so the inspector can omit the rail). */
export function hasPeekRelationships(rels: PeekRelationships | null | undefined): boolean {
  return Boolean(
    rels && (rels.relatedLinks.length > 0 || rels.parentBackLinks.length > 0 || rels.reverseChildListLinks.length > 0)
  );
}

/**
 * The input the live page hands this helper. `data` is the inspected record's
 * already-fetched payload (the assembler parses the peek body), so no second
 * `getRecord` is issued.
 */
export interface PeekRelationshipInput {
  connectionId: string;
  connectorId: string;
  /** The inspected record's payload (child → parent back-links read fields here). */
  data: Record<string, unknown>;
  recordId: string;
  stream: string;
}

/**
 * Resolve the relationship rail for an inspected Explore record, mirroring the
 * records detail page's metadata-only composition exactly. Returns empty lists
 * (never throws) when metadata is unavailable, so the inspector degrades to "no
 * connected records" rather than a fabricated edge.
 */
export async function buildPeekRelationships(
  input: PeekRelationshipInput,
  dataSource: DashboardDataSource
): Promise<PeekRelationships> {
  const empty: PeekRelationships = { relatedLinks: [], reverseChildListLinks: [], parentBackLinks: [] };
  const { connectionId, connectorId, stream, recordId, data } = input;

  // Resolve the connection's instance id so metadata reads scope to the right
  // connection — the same binding the records route and the feed fan-out use.
  let connectorInstanceId: string | null = connectionId;
  try {
    const summaries = await dataSource.listConnectorSummaries();
    const match = summaries.data.find((s) => s.connection_id === connectionId);
    connectorInstanceId = match?.connector_instance_id ?? match?.connection_id ?? connectionId;
  } catch {
    connectorInstanceId = connectionId;
  }

  let expandCapabilities: ExpandCapability[] = [];
  let connectorStreams: ManifestStream[] = [];
  let childManifestStream: ManifestStream | undefined;
  let parentRelations: Array<{ parentStream: string; capability: ExpandCapability }> = [];
  try {
    const [metadata, manifests] = await Promise.all([
      dataSource.getStreamMetadata(connectorId, stream, { connectorInstanceId }).catch(() => null),
      dataSource.listConnectorManifests().catch(() => []),
    ]);
    expandCapabilities = Array.isArray(metadata?.expand_capabilities) ? metadata.expand_capabilities : [];
    const connectorManifest = findManifestForConnectorId(manifests, connectorId);
    connectorStreams = (connectorManifest?.streams ?? []) as ManifestStream[];
    childManifestStream = connectorStreams.find((s) => s.name === stream);
    const parentMetadata = await Promise.all(
      candidateParentStreamsForChild(connectorManifest?.streams, stream).map(async (parentStream) => {
        const parentMeta = await dataSource
          .getStreamMetadata(connectorId, parentStream, { connectorInstanceId })
          .catch(() => null);
        return {
          parentStream,
          expandCapabilities: Array.isArray(parentMeta?.expand_capabilities) ? parentMeta.expand_capabilities : [],
        };
      })
    );
    parentRelations = parentRelationsForChild(parentMetadata, stream);
  } catch {
    return empty;
  }

  // Parent → child relations declared on THIS (parent) stream.
  const relatedLinks = buildRelatedLinks(expandCapabilities, { connectionId, parentRecordKey: recordId });
  // Reverse parent → filtered-child-list links, deduplicated against any forward
  // `has_many` link that resolves to the same `(child stream, filter field)`.
  const forwardChildListKeys = new Set(
    relatedLinks
      .filter((link) => link.navigable && link.cardinality === "has_many" && link.childParentKeyField)
      .map((link) => reverseChildListDedupKey(link.targetStream, link.childParentKeyField as string))
  );
  const reverseChildListLinks = reverseChildListLinksFromManifest(
    connectorStreams,
    { connectionId, parentStream: stream, parentRecordKey: recordId },
    forwardChildListKeys
  );
  // Child → parent back-links from parent metadata + child's own declared has_one.
  const parentBackLinkFromMeta = findParentBackLink(stream, data, parentRelations, { connectionId });
  const childHasOneLinks = childHasOneBackLinksFromManifest(childManifestStream, data, { connectionId });
  const parentBackLinks = mergeParentBackLinks(parentBackLinkFromMeta, childHasOneLinks);

  return { relatedLinks, reverseChildListLinks, parentBackLinks };
}
