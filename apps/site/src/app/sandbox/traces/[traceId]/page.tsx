import { sandboxRoutes } from "@pdpp/operator-ui/components/views/routes";
import { TimelineDetailView } from "@pdpp/operator-ui/components/views/timeline-detail-view";
import { notFound } from "next/navigation";
import { DashboardShell } from "@/app/dashboard/components/shell.tsx";
import { sandboxDashboardDataSource } from "../../_demo/data-source.ts";

export const dynamic = "force-static";

export default async function SandboxTraceDetailPage({ params }: { params: Promise<{ traceId: string }> }) {
  const { traceId: raw } = await params;
  const traceId = decodeURIComponent(raw);
  const envelope = await sandboxDashboardDataSource.getTraceTimeline(traceId);
  if (!envelope) {
    notFound();
  }
  const first = envelope.events[0];
  return (
    <DashboardShell active="traces" mode="mock-owner">
      <TimelineDetailView
        breadcrumbs={[{ label: "Traces", href: sandboxRoutes.section.traces }, { label: "Trace" }]}
        cliCommand={`pdpp ref trace show ${traceId}`}
        description={
          <>
            {envelope.events.length} events
            {first ? (
              <>
                {" · "}actor{" "}
                <span className="font-mono text-foreground">
                  {first.actor_type}/{first.actor_id}
                </span>
              </>
            ) : null}
          </>
        }
        envelope={envelope}
        id={traceId}
        rawUrl={`/sandbox/_ref/traces/${encodeURIComponent(traceId)}`}
        routes={sandboxRoutes}
        subject="trace"
      />
    </DashboardShell>
  );
}
