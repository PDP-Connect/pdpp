import { IcTimestamp } from "@pdpp/brand-react";
import { PageHeader, Section } from "@pdpp/operator-ui/components/primitives";
import Link from "next/link";
import { notFound } from "next/navigation";
import { RecordroomShellWithPalette } from "@/app/dashboard/components/recordroom-shell-with-palette.tsx";
import { ServerUnreachable } from "../../../../components/shell.tsx";
import { WarningsBanner } from "../../../../components/warnings-banner.tsx";
import { ReferenceServerUnreachableError, ResourceServerHttpError } from "../../../../lib/owner-token.ts";
import {
  type ExpandCapability,
  getRecord,
  getStreamMetadata,
  listConnectorManifests,
  type StreamMetadata,
  type StreamRecord,
} from "../../../../lib/rs-client.ts";
import { connectorInstanceIdForConnection, resolveConnectionForRecordsRoute } from "../../../connection-route.ts";
import {
  buildRelatedLinks,
  candidateParentStreamsForChild,
  childHasOneBackLinksFromManifest,
  findManifestForConnectorId,
  findParentBackLink,
  mergeParentBackLinks,
  parentBackLinkDedupKey,
  parentRelationsForChild,
  type RelatedLink,
  reverseChildListDedupKey,
  reverseChildListLinksFromManifest,
} from "../../../lib/relationships.ts";
import { RecordFields } from "./record-fields.tsx";

export const dynamic = "force-dynamic";

export default async function RecordDetailPage({
  params,
}: {
  params: Promise<{ connector: string; stream: string; recordKey: string }>;
}) {
  const { connector, stream, recordKey } = await params;
  const routeId = decodeURIComponent(connector);
  const streamName = decodeURIComponent(stream);
  const recordId = decodeURIComponent(recordKey);

  let record: StreamRecord;
  let connectionId = routeId;
  let recordMetadata: StreamMetadata | null = null;
  let expandCapabilities: ExpandCapability[] = [];
  let parentRelations: Array<{ parentStream: string; capability: ExpandCapability }> = [];
  type ManifestStream = {
    name: string;
    query?: { expand?: Array<{ name: string }> };
    relationships?: Array<{ name: string; stream?: string; foreign_key?: string; cardinality?: string }>;
  };
  let childManifestStream: ManifestStream | undefined;
  // All streams in this connector's manifest — used to enumerate child streams
  // whose declared `has_one` points back at the displayed (parent) stream, for
  // reverse parent → filtered-child-list links.
  let connectorStreams: ManifestStream[] = [];
  try {
    const connection = await resolveConnectionForRecordsRoute(routeId);
    if (!connection) {
      notFound();
    }
    connectionId = connection.connection_id;
    const connectorInstanceId = connectorInstanceIdForConnection(connection);
    // Fetch the record, this stream's metadata (for parent → child relations),
    // and the connector manifest together. The manifest is used only to prune
    // parent metadata reads; child → parent link semantics come from live
    // `expand_capabilities`, not fabricated manifest fields.
    const [recordResult, metadataResult, manifests] = await Promise.all([
      getRecord(connection.connector_id, streamName, recordId, { connectorInstanceId }),
      getStreamMetadata(connection.connector_id, streamName, { connectorInstanceId }).catch(() => null),
      listConnectorManifests().catch(() => []),
    ]);
    record = recordResult;
    recordMetadata = metadataResult;
    expandCapabilities = Array.isArray(metadataResult?.expand_capabilities) ? metadataResult.expand_capabilities : [];
    const connectorManifest = findManifestForConnectorId(manifests, connection.connector_id);
    connectorStreams = (connectorManifest?.streams ?? []) as ManifestStream[];
    childManifestStream = connectorStreams.find((s) => s.name === streamName);
    const parentMetadata = await Promise.all(
      candidateParentStreamsForChild(connectorManifest?.streams, streamName).map(async (parentStream) => {
        const metadata = await getStreamMetadata(connection.connector_id, parentStream, { connectorInstanceId }).catch(
          () => null
        );
        return {
          parentStream,
          expandCapabilities: Array.isArray(metadata?.expand_capabilities) ? metadata.expand_capabilities : [],
        };
      })
    );
    parentRelations = parentRelationsForChild(parentMetadata, streamName);
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <RecordroomShellWithPalette>
          <PageHeader title="Sources" />
          <ServerUnreachable />
        </RecordroomShellWithPalette>
      );
    }
    // A 404/410 from the resource server is an expected end-state for a record
    // route: the record was deleted, or its stream was retired/renamed in a
    // newer manifest and `getRecord` can no longer resolve it (owner-mode
    // visibility is manifest-derived). The reference returns "Record not found"
    // for both, so this surfaces as the standard not-found page. Branch on the
    // typed `ResourceServerHttpError.status` — authoritative and 410-aware —
    // rather than substring-matching the wrapped message.
    if (err instanceof ResourceServerHttpError && (err.status === 404 || err.status === 410)) {
      notFound();
    }
    throw err;
  }

  const envelope = {
    id: record.id,
    stream: record.stream,
    emitted_at: record.emitted_at,
    data: record.data,
  };
  const pretty = JSON.stringify(envelope, null, 2);

  const connectorHref = `/dashboard/records/${encodeURIComponent(connectionId)}`;
  const streamHref = `${connectorHref}/${encodeURIComponent(streamName)}`;

  // Parent → child relations declared on THIS (parent) stream.
  const relatedLinks = buildRelatedLinks(expandCapabilities, { connectionId, parentRecordKey: record.id });
  // Reverse parent → filtered-child-list links: for each child stream that
  // declares a `has_one` back to THIS (parent) stream, link to that child's
  // list filtered by the parent key. Deduplicated against any forward
  // `has_many` link that already resolves to the same `(child stream, filter
  // field)` filtered list (D6 in the OpenSpec design).
  const forwardChildListKeys = new Set(
    relatedLinks
      .filter((link) => link.navigable && link.cardinality === "has_many" && link.childParentKeyField)
      .map((link) => reverseChildListDedupKey(link.targetStream, link.childParentKeyField as string))
  );
  const reverseChildListLinks = reverseChildListLinksFromManifest(
    connectorStreams,
    { connectionId, parentStream: streamName, parentRecordKey: record.id },
    forwardChildListKeys
  );
  // Child → parent back-links from two sources:
  //   1. Parent streams' expand_capabilities (server metadata, covers parent-declared has_many/has_one)
  //   2. Child's own manifest has_one relationships (covers child-declared has_one like Chase transactions→account)
  const parentBackLinkFromMeta = findParentBackLink(streamName, record.data, parentRelations, { connectionId });
  const childHasOneLinks = childHasOneBackLinksFromManifest(childManifestStream, record.data, { connectionId });
  // Merge the two manifest sources, preferring the metadata-derived link, and
  // deduplicate by (parentStream, child parent-key field) — NOT parentStream
  // alone. Two declared has_one edges to the same parent stream via different
  // fields (e.g. a YNAB transaction's account_id and transfer_account_id, both →
  // accounts) point at different parent records, so both must render.
  const allParentBackLinks = mergeParentBackLinks(parentBackLinkFromMeta, childHasOneLinks);

  return (
    <RecordroomShellWithPalette>
      <PageHeader
        breadcrumbs={[
          { label: "Sources", href: "/dashboard/records" },
          { label: connectionId, href: connectorHref },
          { label: streamName, href: streamHref },
          { label: recordId },
        ]}
        description={
          <>
            emitted_at <IcTimestamp className="text-foreground" value={record.emitted_at} />
          </>
        }
        title={<code className="break-all font-mono">{recordId}</code>}
      />

      <WarningsBanner warnings={record.warnings} />

      <Section title="Record">
        <RecordFields data={record.data} metadata={recordMetadata} />
        <details className="mt-4">
          <summary className="pdpp-caption cursor-pointer text-muted-foreground hover:text-foreground">
            Raw JSON
          </summary>
          <pre className="pdpp-caption mt-2 overflow-x-auto whitespace-pre-wrap break-words rounded-md border border-border/80 bg-muted/30 p-4 font-mono">
            {pretty}
          </pre>
        </details>
      </Section>

      {(relatedLinks.length > 0 || allParentBackLinks.length > 0 || reverseChildListLinks.length > 0) && (
        <Section title="Related">
          <ul className="space-y-2">
            {allParentBackLinks.map((backLink) => (
              <li
                className="pdpp-caption"
                key={parentBackLinkDedupKey(backLink.parentStream, backLink.childParentKeyField)}
              >
                <span className="text-muted-foreground">{backLink.parentStream} · </span>
                <Link
                  className="font-mono text-foreground underline underline-offset-2 hover:no-underline"
                  href={backLink.href}
                >
                  {backLink.childParentKeyField} → parent
                </Link>
              </li>
            ))}
            {relatedLinks.map((link) => (
              <RelatedRow key={link.relation} link={link} />
            ))}
            {reverseChildListLinks.map((link) => (
              <li className="pdpp-caption" key={`reverse:${link.childStream}:${link.foreignKey}`}>
                <Link
                  className="font-mono text-foreground underline underline-offset-2 hover:no-underline"
                  href={link.href}
                >
                  {link.childStream} (has_many) →
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </RecordroomShellWithPalette>
  );
}

function RelatedRow({ link }: { link: RelatedLink }) {
  const label = `${link.relation} (${link.cardinality})`;
  if (link.navigable && link.href) {
    return (
      <li className="pdpp-caption">
        <Link className="font-mono text-foreground underline underline-offset-2 hover:no-underline" href={link.href}>
          {label} →
        </Link>
      </li>
    );
  }
  return (
    <li className="pdpp-caption text-muted-foreground" title={link.advisory}>
      <span className="font-mono">{label}</span>
      {link.advisory ? <span> — {link.advisory}</span> : null}
    </li>
  );
}
