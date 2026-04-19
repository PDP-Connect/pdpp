import Link from 'next/link';
import {
  getConnectorOverview,
  listConnectorManifests,
} from './lib/rs-client';
import { ReferenceServerUnreachableError, getRsUrl } from './lib/owner-token';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const manifests = await listConnectorManifests();

  let overviews;
  try {
    overviews = await Promise.all(manifests.map((m) => getConnectorOverview(m)));
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return <ServerUnreachable />;
    }
    throw err;
  }

  const withData = overviews.filter((o) => o.totalRecords > 0);
  const empty = overviews.filter((o) => o.totalRecords === 0 && !o.error);

  return (
    <main className="mx-auto max-w-5xl px-4 py-10 font-mono text-sm sm:px-6">
      <header className="mb-8">
        <h1 className="text-lg font-semibold">dashboard</h1>
        <p className="text-muted-foreground mt-1 break-words">
          owner self-export of the local reference server at{' '}
          <code className="text-foreground break-all">{getRsUrl()}</code>
        </p>
      </header>
      <section>
        <h2 className="text-muted-foreground mb-3 text-xs uppercase tracking-wide">
          connectors with data ({withData.length})
        </h2>
        <ul className="divide-border divide-y border-y">
          {withData.map((o) => (
            <li key={o.connector.connector_id}>
              <Link
                href={`/dashboard/${encodeURIComponent(o.connector.connector_id)}`}
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
      </section>
      {empty.length > 0 && (
        <section className="mt-8">
          <h2 className="text-muted-foreground mb-3 text-xs uppercase tracking-wide">
            registered but empty ({empty.length})
          </h2>
          <p className="text-muted-foreground text-xs break-words">
            {empty.map((o) => o.connector.connector_id).join(', ')}
          </p>
        </section>
      )}
    </main>
  );
}

function ServerUnreachable() {
  return (
    <main className="mx-auto max-w-5xl px-4 py-10 font-mono text-sm sm:px-6">
      <div className="border-destructive/40 bg-destructive/5 rounded border p-4">
        <h2 className="text-destructive font-semibold">Reference server unreachable</h2>
        <p className="mt-2 break-words">
          Could not reach the PDPP resource server at{' '}
          <code className="break-all">{getRsUrl()}</code>. Start it with:
        </p>
        <pre className="bg-muted mt-3 overflow-x-auto rounded p-3 text-xs">
          PDPP_DB_PATH=packages/polyfill-connectors/.pdpp-data/polyfill.sqlite \{'\n'}
          node reference-implementation/server/index.js
        </pre>
      </div>
    </main>
  );
}
