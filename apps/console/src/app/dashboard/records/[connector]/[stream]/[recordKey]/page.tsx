import { PageHeader, Section } from "@pdpp/operator-ui/components/primitives";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Timestamp } from "@/components/ui/timestamp.tsx";
import { DashboardShell, ServerUnreachable } from "../../../../components/shell.tsx";
import { WarningsBanner } from "../../../../components/warnings-banner.tsx";
import { ReferenceServerUnreachableError, ResourceServerHttpError } from "../../../../lib/owner-token.ts";
import {
  type ExpandCapability,
  getRecord,
  getStreamMetadata,
  listConnectorManifests,
  type StreamRecord,
} from "../../../../lib/rs-client.ts";
import { connectorInstanceIdForConnection, resolveConnectionForRecordsRoute } from "../../../connection-route.ts";
import {
  buildRelatedLinks,
  candidateParentStreamsForChild,
  childHasOneBackLinksFromManifest,
  findParentBackLink,
  parentRelationsForChild,
  type RelatedLink,
} from "../../../lib/relationships.ts";

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
  let expandCapabilities: ExpandCapability[] = [];
  let parentRelations: Array<{ parentStream: string; capability: ExpandCapability }> = [];
  let childManifestStream: { name: string; relationships?: Array<{ name: string; stream?: string; foreign_key?: string; cardinality?: string }> } | undefined;
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
    expandCapabilities = Array.isArray(metadataResult?.expand_capabilities) ? metadataResult.expand_capabilities : [];
    const connectorManifest = manifests.find((m) => m.connector_id === connection.connector_id);
    childManifestStream = connectorManifest?.streams?.find((s) => s.name === streamName) as typeof childManifestStream;
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
        <DashboardShell active="records">
          <PageHeader title="Connections" />
          <ServerUnreachable />
        </DashboardShell>
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
  // Child → parent back-links from two sources:
  //   1. Parent streams' expand_capabilities (server metadata, covers parent-declared has_many/has_one)
  //   2. Child's own manifest has_one relationships (covers child-declared has_one like Chase transactions→account)
  const parentBackLinkFromMeta = findParentBackLink(streamName, record.data, parentRelations, { connectionId });
  const childHasOneLinks = childHasOneBackLinksFromManifest(childManifestStream, record.data, { connectionId });
  // Prefer the metadata-derived link; fall back to manifest-derived ones. Deduplicate by parentStream.
  const seenParentStreams = new Set<string>();
  const allParentBackLinks = [...(parentBackLinkFromMeta ? [parentBackLinkFromMeta] : []), ...childHasOneLinks].filter(
    (link) => {
      if (seenParentStreams.has(link.parentStream)) return false;
      seenParentStreams.add(link.parentStream);
      return true;
    }
  );

  return (
    <DashboardShell active="records">
      <PageHeader
        breadcrumbs={[
          { label: "Connections", href: "/dashboard/records" },
          { label: connectionId, href: connectorHref },
          { label: streamName, href: streamHref },
          { label: recordId },
        ]}
        description={
          <>
            emitted_at <Timestamp className="text-foreground" value={record.emitted_at} />
          </>
        }
        title={<code className="break-all font-mono">{recordId}</code>}
      />

      <WarningsBanner warnings={record.warnings} />

      <Section title="Record">
        <pre className="pdpp-caption overflow-x-auto whitespace-pre-wrap break-words rounded-md border border-border/80 bg-muted/30 p-4 font-mono">
          {pretty}
        </pre>
      </Section>

      {(relatedLinks.length > 0 || allParentBackLinks.length > 0) && (
        <Section title="Related">
          <ul className="space-y-2">
            {allParentBackLinks.map((backLink) => (
              <li key={backLink.parentStream} className="pdpp-caption">
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
          </ul>
        </Section>
      )}
    </DashboardShell>
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
