import Link from 'next/link';
import { notFound } from 'next/navigation';
import { DashboardShell, ServerUnreachable } from '../../components/shell';
import {
  formatTimestamp,
  listConnectorManifests,
  listStreams,
  type ConnectorManifest,
  type StreamSummary,
} from '../../lib/rs-client';
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
          <ServerUnreachable />
        </DashboardShell>
      );
    }
    throw err;
  }

  return (
    <DashboardShell active="records">
      <nav className="text-muted-foreground mb-3 flex flex-wrap items-center gap-x-2 text-xs">
        <Link href="/dashboard/records" className="hover:text-foreground">records</Link>
        <span>/</span>
        <span className="text-foreground break-all">{connectorId}</span>
      </nav>
      <header className="mb-4">
        <h1 className="text-lg font-semibold break-all">{connectorId}</h1>
        {manifest.provider_id && (
          <p className="text-muted-foreground mt-1 text-xs break-all">provider: {manifest.provider_id}</p>
        )}
      </header>

      <div className="mb-4 flex flex-wrap gap-2 text-xs">
        <Link
          href={`/dashboard/runs?connector_id=${encodeURIComponent(connectorId)}`}
          className="border-border hover:bg-muted/50 rounded border px-2 py-1"
        >
          runs for this connector →
        </Link>
      </div>

      <section>
        <h2 className="text-muted-foreground mb-2 text-xs uppercase tracking-wide">
          streams ({streams.length})
        </h2>
        {streams.length === 0 ? (
          <p className="text-muted-foreground text-xs">No records for this connector yet.</p>
        ) : (
          <ul className="divide-border divide-y border-y">
            {streams.map((s) => (
              <li key={s.name}>
                <Link
                  href={`/dashboard/records/${encodeURIComponent(connectorId)}/${encodeURIComponent(s.name)}`}
                  className="hover:bg-muted/50 flex flex-col gap-1 px-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
                >
                  <span className="font-medium break-all">{s.name}</span>
                  <span className="text-muted-foreground tabular-nums text-xs sm:text-sm">
                    {s.record_count.toLocaleString()} records
                    {s.last_updated ? ` · ${formatTimestamp(s.last_updated)}` : ''}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </DashboardShell>
  );
}
