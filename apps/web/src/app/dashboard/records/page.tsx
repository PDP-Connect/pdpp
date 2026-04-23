import Link from 'next/link';
import { DashboardShell, EmptyState, OwnerTokenRequired, ServerUnreachable } from '../components/shell';
import { buttonVariants } from '@/components/ui/button';
import {
  DataList,
  PageHeader,
  Section,
} from '../components/primitives';
import { ReferenceServerUnreachableError } from '../lib/owner-token';
import { getConnectorOverview, listConnectorManifests, type ConnectorOverview } from '../lib/rs-client';

export const dynamic = 'force-dynamic';

export default async function RecordsIndexPage() {
  let overviews: ConnectorOverview[];
  try {
    const manifests = await listConnectorManifests();
    overviews = await Promise.all(manifests.map((m) => getConnectorOverview(m)));
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

  const withData = overviews.filter((o) => o.totalRecords > 0);
  const empty = overviews.filter((o) => o.totalRecords === 0 && !o.error);
  const totalRecords = withData.reduce((sum, o) => sum + o.totalRecords, 0);
  const totalStreams = withData.reduce((sum, o) => sum + o.streams.length, 0);

  return (
    <DashboardShell active="records">
      <PageHeader
        title="Records"
        description="Owner self-export of retained connector data. Drill from connectors to streams to individual records."
        count={`${totalRecords.toLocaleString()} records · ${totalStreams} streams · ${withData.length} connectors`}
        actions={
          <Link href="/dashboard/records/timeline" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            Activity timeline →
          </Link>
        }
      />

      <Section title={`Connectors with records (${withData.length})`}>
        {withData.length === 0 ? (
          <EmptyState
            title="No data ingested yet"
            hint="Run a connector through the polyfill orchestrator to populate streams."
          />
        ) : (
          <DataList>
            {withData.map((o) => (
              <li key={o.connector.connector_id}>
                <Link
                  href={`/dashboard/records/${encodeURIComponent(o.connector.connector_id)}`}
                  className="hover:bg-muted/40 flex flex-col gap-1 px-3 py-3 transition-colors sm:flex-row sm:items-center sm:justify-between sm:gap-4"
                >
                  <span className="pdpp-body break-all font-mono font-medium">
                    {o.connector.connector_id}
                  </span>
                  <span className="pdpp-caption text-muted-foreground tabular-nums">
                    {o.totalRecords.toLocaleString()} records · {o.streams.length} stream
                    {o.streams.length === 1 ? '' : 's'}
                  </span>
                </Link>
              </li>
            ))}
          </DataList>
        )}
      </Section>

      {empty.length > 0 && (
        <Section
          title={`Registered but empty (${empty.length})`}
          description="These connectors are registered but have not ingested any records."
        >
          <p className="pdpp-caption text-muted-foreground break-words font-mono">
            {empty.map((o) => o.connector.connector_id).join(', ')}
          </p>
        </Section>
      )}
    </DashboardShell>
  );
}
