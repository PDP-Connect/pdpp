import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getRecord, type StreamRecord } from '../../../lib/rs-client';
import {
  ReferenceServerUnreachableError,
  getRsUrl,
} from '../../../lib/owner-token';

export const dynamic = 'force-dynamic';

export default async function RecordDetailPage({
  params,
}: {
  params: Promise<{ connector: string; stream: string; recordKey: string }>;
}) {
  const { connector, stream, recordKey } = await params;
  const connectorId = decodeURIComponent(connector);
  const streamName = decodeURIComponent(stream);
  const recordId = decodeURIComponent(recordKey);

  let record: StreamRecord;
  try {
    record = await getRecord(connectorId, streamName, recordId);
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
    // RS returns 404 as a non-OK; authedFetch throws a generic Error. If the
    // message indicates a 404, render Next's notFound(); otherwise rethrow so
    // the error boundary can handle it.
    const msg = err instanceof Error ? err.message : String(err);
    if (/\(404\)/.test(msg)) notFound();
    throw err;
  }

  const envelope = {
    id: record.id,
    stream: record.stream,
    emitted_at: record.emitted_at,
    data: record.data,
  };
  const pretty = JSON.stringify(envelope, null, 2);

  const connectorHref = `/dashboard/${encodeURIComponent(connectorId)}`;
  const streamHref = `${connectorHref}/${encodeURIComponent(streamName)}`;

  return (
    <main className="mx-auto max-w-5xl px-4 py-10 font-mono text-xs sm:px-6">
      <nav className="text-muted-foreground mb-6 flex flex-wrap items-center gap-x-2">
        <Link href="/dashboard" className="hover:text-foreground">dashboard</Link>
        <span>/</span>
        <Link href={connectorHref} className="hover:text-foreground break-all">{connectorId}</Link>
        <span>/</span>
        <Link href={streamHref} className="hover:text-foreground break-all">{streamName}</Link>
        <span>/</span>
        <span className="text-foreground break-all">{recordId}</span>
      </nav>

      <header className="mb-4">
        <h1 className="text-lg font-semibold break-all">{recordId}</h1>
        <p className="text-muted-foreground mt-1">
          emitted_at: <span className="text-foreground">{record.emitted_at}</span>
        </p>
      </header>

      <section>
        <h2 className="text-muted-foreground mb-2 text-xs uppercase tracking-wide">record</h2>
        <pre className="border-border bg-muted/30 overflow-x-auto whitespace-pre-wrap break-words rounded border p-4 text-xs leading-relaxed">
          {pretty}
        </pre>
      </section>
    </main>
  );
}
