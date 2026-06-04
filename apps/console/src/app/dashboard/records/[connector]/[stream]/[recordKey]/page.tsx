import { PageHeader, Section } from "@pdpp/operator-ui/components/primitives";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Timestamp } from "@/components/ui/timestamp.tsx";
import { DashboardShell, ServerUnreachable } from "../../../../components/shell.tsx";
import { WarningsBanner } from "../../../../components/warnings-banner.tsx";
import { ReferenceServerUnreachableError } from "../../../../lib/owner-token.ts";
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
  findParentBackLink,
  parentRelationsForChild,
  type RelatedLink,
} from "../../../lib/relationships.ts";

export const dynamic = "force-dynamic";

const NOT_FOUND_ERROR_RE = /\(404\)/;

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
  try {
    const connection = await resolveConnectionForRecordsRoute(routeId);
    if (!connection) {
      notFound();
    }
    connectionId = connection.connection_id;
    const connectorInstanceId = connectorInstanceIdForConnection(connection);
    // Fetch the record, this stream's metadata (for parent → child relations),
    // and the connector manifest (for the child → parent back-link) together —
    // no serial round-trips beyond what the page already needed. Metadata /
    // manifest are best-effort: a relationship-rendering miss must never block
    // the record view.
    const [recordResult, metadataResult, manifests] = await Promise.all([
      getRecord(connection.connector_id, streamName, recordId, { connectorInstanceId }),
      getStreamMetadata(connection.connector_id, streamName, { connectorInstanceId }).catch(() => null),
      listConnectorManifests().catch(() => []),
    ]);
    record = recordResult;
    expandCapabilities = Array.isArray(metadataResult?.expand_capabilities) ? metadataResult.expand_capabilities : [];
    const connectorManifest = manifests.find((m) => m.connector_id === connection.connector_id);
    parentRelations = parentRelationsForChild(connectorManifest?.streams, streamName);
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <DashboardShell active="records">
          <PageHeader title="Connections" />
          <ServerUnreachable />
        </DashboardShell>
      );
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (NOT_FOUND_ERROR_RE.test(msg)) {
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
  // Child → parent back-link, when THIS stream is the child of a declared
  // forward relation and the record carries the parent's key.
  const parentBackLink = findParentBackLink(streamName, record.data, parentRelations, { connectionId });

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

      {(relatedLinks.length > 0 || parentBackLink) && (
        <Section title="Related">
          <ul className="space-y-2">
            {parentBackLink && (
              <li className="pdpp-caption">
                <span className="text-muted-foreground">{parentBackLink.parentStream} · </span>
                <Link
                  className="font-mono text-foreground underline underline-offset-2 hover:no-underline"
                  href={parentBackLink.href}
                >
                  {parentBackLink.childParentKeyField} → parent
                </Link>
              </li>
            )}
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
