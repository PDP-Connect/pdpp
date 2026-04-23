import Link from 'next/link';
import { notFound } from 'next/navigation';
import { DashboardShell, OwnerTokenRequired, ServerUnreachable } from '../../components/shell';
import { buttonVariants } from '@/components/ui/button';
import {
  DataList,
  PageHeader,
  Section,
} from '../../components/primitives';
import {
  listConnectorManifests,
  listStreams,
  type ConnectorManifest,
  type StreamSummary,
} from '../../lib/rs-client';
import { Timestamp } from '@/components/ui/timestamp';
import { ReferenceServerUnreachableError } from '../../lib/owner-token';

export const dynamic = 'force-dynamic';

export default async function ConnectorPage({
  params,
}: {
  params: Promise<{ connector: string }>;
}) {
  const { connector } = await params;
  const connectorId = decodeURIComponent(connector);

  let manifest: ConnectorManifest | undefined;
  let streams: StreamSummary[];
  try {
    const manifests = await listConnectorManifests();
    manifest = manifests.find((m) => m.connector_id === connectorId);
    if (!manifest) notFound();
    streams = await listStreams(connectorId);
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <DashboardShell active="records">
          <PageHeader title="Records" />
          <ServerUnreachable />
        </DashboardShell>
      );
    }
    throw err;
  }

  const totalRecords = streams.reduce((sum, s) => sum + s.record_count, 0);

  return (
    <DashboardShell active="records">
      <PageHeader
        title={<code className="font-mono">{connectorId}</code>}
        description={manifest.provider_id ? `Provider: ${manifest.provider_id}` : undefined}
        breadcrumbs={[{ label: 'Records', href: '/dashboard/records' }, { label: connectorId }]}
        count={`${totalRecords.toLocaleString()} records · ${streams.length} stream${streams.length === 1 ? '' : 's'}`}
        actions={
          <Link
            href={`/dashboard/runs?connector_id=${encodeURIComponent(connectorId)}`}
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
          >
            Runs for this connector →
          </Link>
        }
      />

      <Section title={`Streams (${streams.length})`}>
        {streams.length === 0 ? (
          <p className="pdpp-caption text-muted-foreground italic">No records for this connector yet.</p>
        ) : (
          <DataList>
            {streams.map((s) => (
              <li key={s.name}>
                <Link
                  href={`/dashboard/records/${encodeURIComponent(connectorId)}/${encodeURIComponent(s.name)}`}
                  className="hover:bg-muted/40 flex flex-col gap-1 px-3 py-3 transition-colors sm:flex-row sm:items-center sm:justify-between sm:gap-4"
                >
                  <span className="pdpp-body break-all font-mono font-medium">{s.name}</span>
                  <span className="pdpp-caption text-muted-foreground tabular-nums inline-flex flex-wrap items-baseline gap-x-1">
                    <span>{s.record_count.toLocaleString()} records</span>
                    {s.last_updated ? (
                      <>
                        <span aria-hidden>·</span>
                        <Timestamp value={s.last_updated} />
                      </>
                    ) : null}
                  </span>
                </Link>
              </li>
            ))}
          </DataList>
        )}
      </Section>
    </DashboardShell>
  );
}
