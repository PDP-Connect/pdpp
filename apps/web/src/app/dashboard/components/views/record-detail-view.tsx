/**
 * Shared single-record detail view. Pretty-prints the record envelope
 * inside the standard dashboard breadcrumb header.
 */

import { Timestamp } from "@/components/ui/timestamp.tsx";
import type { StreamRecord } from "../../lib/rs-client.ts";
import { PageHeader, Section } from "../primitives.tsx";
import type { Routes } from "./routes.ts";

export function RecordDetailView({
  connectorId,
  streamName,
  recordId,
  record,
  routes,
}: {
  connectorId: string;
  streamName: string;
  recordId: string;
  record: StreamRecord;
  routes: Routes;
}) {
  const envelope = {
    id: record.id,
    stream: record.stream,
    emitted_at: record.emitted_at,
    data: record.data,
  };
  const pretty = JSON.stringify(envelope, null, 2);
  return (
    <>
      <PageHeader
        breadcrumbs={[
          { label: "Records", href: routes.section.records },
          { label: connectorId, href: routes.connector(connectorId) },
          { label: streamName, href: routes.stream(connectorId, streamName) },
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
    </>
  );
}
