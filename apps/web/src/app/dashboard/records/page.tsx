import Link from 'next/link';
import { DashboardShell, EmptyState, ServerUnreachable } from '../components/shell';
import { buttonVariants } from '@/components/ui/button';
import { DataList, PageHeader, Section } from '../components/primitives';
import { ReferenceServerUnreachableError } from '../lib/owner-token';
import { getConnectorOverview, listConnectorManifests, type ConnectorOverview } from '../lib/rs-client';
import { ConnectorRow } from './connector-row';

export const dynamic = 'force-dynamic';

const STALE_MS = 7 * 24 * 60 * 60 * 1000;
const RECENT_MS = 24 * 60 * 60 * 1000;

function connectorSortKey(o: ConnectorOverview): [number, number, string] {
  // Primary sort: by urgency. Failed first, then running, then stale
  // (never-run ranks as infinitely stale), then fresh.
  // Secondary sort: oldest last-sync first within each band, so
  // attention flows toward the thing most overdue.
  if (o.lastRun?.status === 'failed') return [0, 0, o.connector.connector_id];
  if (o.isRunning) return [1, 0, o.connector.connector_id];
  const lastTs = o.lastSuccessfulRun ? Date.parse(o.lastSuccessfulRun.last_at) : 0;
  if (!lastTs) return [2, 0, o.connector.connector_id]; // never run
  return [3, lastTs, o.connector.connector_id];
}

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

  const withData = overviews.filter((o) => o.totalRecords > 0 || o.lastRun);
  const empty = overviews.filter((o) => o.totalRecords === 0 && !o.lastRun && !o.error);

  // Sort the primary list by urgency (failed/running/stale/fresh).
  const sorted = [...withData].sort((a, b) => {
    const [ak, at, an] = connectorSortKey(a);
    const [bk, bt, bn] = connectorSortKey(b);
    if (ak !== bk) return ak - bk;
    if (at !== bt) return at - bt;
    return an.localeCompare(bn);
  });

  const totalRecords = withData.reduce((sum, o) => sum + o.totalRecords, 0);
  const totalStreams = withData.reduce((sum, o) => sum + o.streams.length, 0);

  const now = Date.now();
  const runningCount = withData.filter((o) => o.isRunning).length;
  const failedCount = withData.filter((o) => o.lastRun?.status === 'failed').length;
  const syncedRecently = withData.filter((o) => {
    const ts = o.lastSuccessfulRun ? Date.parse(o.lastSuccessfulRun.last_at) : 0;
    return ts && now - ts < RECENT_MS;
  }).length;
  const staleCount = withData.filter((o) => {
    const ts = o.lastSuccessfulRun ? Date.parse(o.lastSuccessfulRun.last_at) : 0;
    return ts > 0 && now - ts > STALE_MS;
  }).length;
  const neverRun = withData.filter((o) => !o.lastRun).length;

  return (
    <DashboardShell active="records">
      <PageHeader
        title="Records"
        description="Owner control plane for your connectors. Click Sync now to pull fresh data; drill in to browse streams and records."
        count={`${totalRecords.toLocaleString()} records · ${totalStreams} streams · ${withData.length} connectors`}
        actions={
          <Link href="/dashboard/records/timeline" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            Activity timeline →
          </Link>
        }
      />

      {/* Vital signs strip — substrate, not decoration. */}
      <section aria-label="Connector health summary" className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <HealthStat label="Connectors" value={withData.length.toLocaleString()} tone="neutral" />
        <HealthStat
          label="Synced last 24h"
          value={syncedRecently.toLocaleString()}
          tone={syncedRecently > 0 ? 'success' : 'neutral'}
        />
        <HealthStat
          label={staleCount > 0 ? 'Stale >7d' : neverRun > 0 ? 'Never run' : 'All fresh'}
          value={(staleCount || neverRun || 0).toLocaleString()}
          tone={staleCount > 0 || neverRun > 0 ? 'warning' : 'neutral'}
        />
        <HealthStat
          label={failedCount > 0 ? 'Failing' : runningCount > 0 ? 'Running' : 'Idle'}
          value={(failedCount || runningCount || 0).toLocaleString()}
          tone={failedCount > 0 ? 'danger' : runningCount > 0 ? 'active' : 'neutral'}
        />
      </section>

      <Section title={`Connectors (${withData.length})`}>
        {withData.length === 0 ? (
          <EmptyState
            title="No data ingested yet"
            hint="Click Sync now on a connector below to pull your first records."
          />
        ) : (
          <DataList>
            {sorted.map((o) => (
              <ConnectorRow
                key={o.connector.connector_id}
                overview={o}
                runsHref="/dashboard/runs"
              />
            ))}
          </DataList>
        )}
      </Section>

      {empty.length > 0 && (
        <Section
          title={`Registered but never run (${empty.length})`}
          description="These connectors are registered and can be synced. Click Sync now to pull initial data."
        >
          <DataList>
            {empty.map((o) => (
              <ConnectorRow
                key={o.connector.connector_id}
                overview={o}
                runsHref="/dashboard/runs"
              />
            ))}
          </DataList>
        </Section>
      )}
    </DashboardShell>
  );
}

function HealthStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'neutral' | 'success' | 'warning' | 'danger' | 'active';
}) {
  const toneClass =
    tone === 'success'
      ? 'text-emerald-600'
      : tone === 'warning'
        ? 'text-amber-600'
        : tone === 'danger'
          ? 'text-destructive'
          : tone === 'active'
            ? 'text-blue-600'
            : 'text-foreground';
  return (
    <div className="border-border/60 flex flex-col gap-1 border-l-2 pl-3">
      <span className="pdpp-caption text-muted-foreground">{label}</span>
      <span className={`pdpp-heading tabular-nums ${toneClass}`}>{value}</span>
    </div>
  );
}
