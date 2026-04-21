import Link from 'next/link';
import { DashboardShell, EmptyState, ServerUnreachable } from '../components/shell';
import { ReferenceServerUnreachableError } from '../lib/owner-token';
import { getConnectorOverview, listConnectorManifests } from '../lib/rs-client';

export const dynamic = 'force-dynamic';

export default async function RecordsIndexPage() {
  let overviews;
  try {
    const manifests = await listConnectorManifests();
    overviews = await Promise.all(manifests.map((m) => getConnectorOverview(m)));
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <DashboardShell active="records">
          <ServerUnreachable />
        </DashboardShell>
      );
    }
    throw err;
  }

  const withData = overviews.filter((o) => o.totalRecords > 0);
  const empty = overviews.filter((o) => o.totalRecords === 0 && !o.error);

  return (
    <DashboardShell active="records">
      <header className="mb-4">
        <h1 className="text-lg font-semibold">Records</h1>
        <p className="text-muted-foreground text-xs">
          Owner self-export: drill into connectors, streams, and records.
        </p>
      </header>

      <nav className="mb-6 flex flex-wrap gap-2 text-xs">
        <Link
          href="/dashboard/records/timeline"
          className="border-border hover:bg-muted/50 rounded border px-2 py-1"
        >
          timeline / activity →
        </Link>
      </nav>

      <section className="mb-6">
        <h2 className="text-muted-foreground mb-2 text-xs uppercase tracking-wide">
          connectors with records ({withData.length})
        </h2>
        {withData.length === 0 ? (
          <EmptyState title="No data ingested yet" hint="Run a connector through the polyfill orchestrator to populate streams." />
        ) : (
          <ul className="divide-border divide-y border-y">
            {withData.map((o) => (
              <li key={o.connector.connector_id}>
                <Link
                  href={`/dashboard/records/${encodeURIComponent(o.connector.connector_id)}`}
                  className="hover:bg-muted/50 flex flex-col gap-1 px-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
                >
                  <span className="font-medium break-all">{o.connector.connector_id}</span>
                  <span className="text-muted-foreground tabular-nums text-xs sm:text-sm">
                    {o.totalRecords.toLocaleString()} records · {o.streams.length} streams
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {empty.length > 0 && (
        <section>
          <h2 className="text-muted-foreground mb-2 text-xs uppercase tracking-wide">
            registered but empty ({empty.length})
          </h2>
          <p className="text-muted-foreground text-xs break-words">
            {empty.map((o) => o.connector.connector_id).join(', ')}
          </p>
        </section>
      )}
    </DashboardShell>
  );
}
