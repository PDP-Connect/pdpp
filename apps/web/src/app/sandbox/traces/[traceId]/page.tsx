import { notFound } from "next/navigation";
import { sandboxRoutes } from "@/app/dashboard/components/views/routes.ts";
import { TimelineDetailView } from "@/app/dashboard/components/views/timeline-detail-view.tsx";
import { SandboxShell } from "../../_demo/components/shell.tsx";
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
    <SandboxShell active="traces">
      <TimelineDetailView
        breadcrumbs={[{ label: "Traces", href: sandboxRoutes.section.traces }, { label: "Trace" }]}
        cliCommand={`pdpp trace show ${traceId}`}
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
    </SandboxShell>
  );
}
