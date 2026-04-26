import { notFound } from "next/navigation";
import { RecordDetailView } from "@/app/dashboard/components/views/record-detail-view.tsx";
import { sandboxRoutes } from "@/app/dashboard/components/views/routes.ts";
import type { StreamRecord } from "@/app/dashboard/lib/rs-client.ts";
import { SandboxShell } from "../../../../_demo/components/shell.tsx";
import { sandboxDashboardDataSource } from "../../../../_demo/data-source.ts";

export const dynamic = "force-static";
const NOT_FOUND_RE = /\(404\)/;

export default async function SandboxRecordDetailPage({
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
    record = await sandboxDashboardDataSource.getRecord(connectorId, streamName, recordId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (NOT_FOUND_RE.test(msg)) {
      notFound();
    }
    throw err;
  }
  return (
    <SandboxShell active="records">
      <RecordDetailView
        connectorId={connectorId}
        record={record}
        recordId={recordId}
        routes={sandboxRoutes}
        streamName={streamName}
      />
    </SandboxShell>
  );
}
