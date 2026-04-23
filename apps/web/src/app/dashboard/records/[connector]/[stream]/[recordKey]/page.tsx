import { notFound } from 'next/navigation';
import { DashboardShell, OwnerTokenRequired, ServerUnreachable } from '../../../../components/shell';
import { PageHeader, Section } from '../../../../components/primitives';
import { getRecord, type StreamRecord } from '../../../../lib/rs-client';
import { ReferenceServerUnreachableError } from '../../../../lib/owner-token';
import { Timestamp } from '@/components/ui/timestamp';

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
          <PageHeader title="Records" />
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
      <PageHeader
        title={<code className="font-mono break-all">{recordId}</code>}
        breadcrumbs={[
          { label: 'Records', href: '/dashboard/records' },
          { label: connectorId, href: connectorHref },
          { label: streamName, href: streamHref },
          { label: recordId },
        ]}
        description={
          <>
            emitted_at <Timestamp value={record.emitted_at} className="text-foreground" />
          </>
        }
      />

      <Section title="Record">
        <pre className="pdpp-caption border-border/80 bg-muted/30 overflow-x-auto rounded-md border p-4 font-mono whitespace-pre-wrap break-words">
          {pretty}
        </pre>
      </Section>
    </DashboardShell>
  );
}
