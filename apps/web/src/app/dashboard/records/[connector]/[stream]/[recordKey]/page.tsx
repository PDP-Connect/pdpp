import Link from 'next/link';
import { notFound } from 'next/navigation';
import { DashboardShell, ServerUnreachable } from '../../../../components/shell';
import { getRecord, type StreamRecord } from '../../../../lib/rs-client';
import { ReferenceServerUnreachableError } from '../../../../lib/owner-token';

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
        <DashboardShell active="records">
          <ServerUnreachable />
        </DashboardShell>
      );
    }
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

  const connectorHref = `/dashboard/records/${encodeURIComponent(connectorId)}`;
  const streamHref = `${connectorHref}/${encodeURIComponent(streamName)}`;

  return (
    <DashboardShell active="records">
      <nav className="text-muted-foreground mb-3 flex flex-wrap items-center gap-x-2 text-xs">
        <Link href="/dashboard/records" className="hover:text-foreground">records</Link>
        <span>/</span>
        <Link href={connectorHref} className="hover:text-foreground break-all">{connectorId}</Link>
        <span>/</span>
        <Link href={streamHref} className="hover:text-foreground break-all">{streamName}</Link>
        <span>/</span>
        <span className="text-foreground break-all">{recordId}</span>
      </nav>

      <header className="mb-4">
        <h1 className="text-lg font-semibold break-all">{recordId}</h1>
        <p className="text-muted-foreground mt-1 text-xs">
          emitted_at: <span className="text-foreground">{record.emitted_at}</span>
        </p>
      </header>

      <section>
        <h2 className="text-muted-foreground mb-2 text-xs uppercase tracking-wide">record</h2>
        <pre className="border-border bg-muted/30 overflow-x-auto whitespace-pre-wrap break-words rounded border p-4 text-xs leading-relaxed">
          {pretty}
        </pre>
      </section>
    </DashboardShell>
  );
}
