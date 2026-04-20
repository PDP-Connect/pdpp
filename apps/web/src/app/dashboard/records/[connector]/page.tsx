import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  formatTimestamp,
  listConnectorManifests,
  listStreams,
} from '../lib/rs-client';
import { ReferenceServerUnreachableError, getRsUrl } from '../lib/owner-token';

export const dynamic = 'force-dynamic';

export default async function ConnectorPage({
  params,
}: {
  params: Promise<{ connector: string }>;
}) {
  const { connector } = await params;
  const connectorId = decodeURIComponent(connector);
  const manifests = await listConnectorManifests();
  const manifest = manifests.find((m) => m.connector_id === connectorId);
  if (!manifest) notFound();

  let streams;
  try {
    streams = await listStreams(connectorId);
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <main className="mx-auto max-w-5xl px-4 py-10 font-mono text-sm sm:px-6">
          <div className="border-destructive/40 bg-destructive/5 rounded border p-4 break-words">
            Cannot reach resource server at <code className="break-all">{getRsUrl()}</code>.
          </div>
        </main>
      );
    }
    throw err;
  }

  return (
    <main className="mx-auto max-w-5xl px-4 py-10 font-mono text-sm sm:px-6">
      <nav className="text-muted-foreground mb-6 flex flex-wrap items-center gap-x-2 text-xs">
        <Link href="/dashboard" className="hover:text-foreground">dashboard</Link>
        <span>/</span>
        <span className="text-foreground break-all">{connectorId}</span>
      </nav>
      <header className="mb-6">
        <h1 className="text-lg font-semibold break-all">{connectorId}</h1>
        {manifest.provider_id && (
          <p className="text-muted-foreground mt-1 text-xs break-all">provider: {manifest.provider_id}</p>
        )}
      </header>
      <section>
        <h2 className="text-muted-foreground mb-3 text-xs uppercase tracking-wide">
          streams ({streams.length})
        </h2>
        {streams.length === 0 ? (
          <p className="text-muted-foreground">No records for this connector yet.</p>
        ) : (
          <ul className="divide-border divide-y border-y">
            {streams.map((s) => (
              <li key={s.name}>
                <Link
                  href={`/dashboard/${encodeURIComponent(connectorId)}/${encodeURIComponent(s.name)}`}
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
    </main>
  );
}

