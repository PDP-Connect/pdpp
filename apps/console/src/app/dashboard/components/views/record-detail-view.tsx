/**
 * Shared single-record detail view. Pretty-prints the record envelope
 * inside the standard dashboard breadcrumb header.
 */

import { PageHeader, Section } from "@pdpp/operator-ui/components/primitives";
import type { Routes } from "@pdpp/operator-ui/components/views/routes";
import { formatConnectorKeyForDisplay } from "@pdpp/operator-ui/lib/connector-display";
import { Timestamp } from "@/components/ui/timestamp.tsx";
import type { StreamRecord } from "../../lib/rs-client.ts";

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
  const connectorLabel = formatConnectorKeyForDisplay(connectorId);
  return (
    <>
      <PageHeader
        breadcrumbs={[
          { label: "Sources", href: routes.section.records },
          { label: connectorLabel, href: routes.connector(connectorId) },
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
