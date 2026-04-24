import { notFound } from "next/navigation";
import { Timestamp } from "@/components/ui/timestamp.tsx";
import { PageHeader, Section } from "../../../../components/primitives.tsx";
import { DashboardShell, ServerUnreachable } from "../../../../components/shell.tsx";
import { ReferenceServerUnreachableError } from "../../../../lib/owner-token.ts";
import { getRecord, type StreamRecord } from "../../../../lib/rs-client.ts";

export const dynamic = "force-dynamic";

const NOT_FOUND_ERROR_RE = /\(404\)/;

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
    if (NOT_FOUND_ERROR_RE.test(msg)) {
      notFound();
    }
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
        breadcrumbs={[
          { label: "Records", href: "/dashboard/records" },
          { label: connectorId, href: connectorHref },
          { label: streamName, href: streamHref },
          { label: recordId },
        ]}
        description={
          <>
            emitted_at <Timestamp className="text-foreground" value={record.emitted_at} />
          </>
        }
        title={<code className="break-all font-mono">{recordId}</code>}
      />

      <Section title="Record">
        <pre className="pdpp-caption overflow-x-auto whitespace-pre-wrap break-words rounded-md border border-border/80 bg-muted/30 p-4 font-mono">
          {pretty}
        </pre>
      </Section>
    </DashboardShell>
  );
}
