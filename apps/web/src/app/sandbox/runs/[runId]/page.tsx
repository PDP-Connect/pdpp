import { notFound } from "next/navigation";
import { DashboardShell } from "@/app/dashboard/components/shell.tsx";
import { sandboxRoutes } from "@/app/dashboard/components/views/routes.ts";
import { TimelineDetailView } from "@/app/dashboard/components/views/timeline-detail-view.tsx";
import { sandboxDashboardDataSource } from "../../_demo/data-source.ts";

export const dynamic = "force-static";

export default async function SandboxRunDetailPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId: raw } = await params;
  const runId = decodeURIComponent(raw);
  const envelope = await sandboxDashboardDataSource.getRunTimeline(runId);
  if (!envelope) {
    notFound();
  }
  const connectorId = envelope.events.find((e) => e.actor_type === "runtime")?.actor_id ?? null;
  return (
    <DashboardShell active="runs" mode="mock-owner">
      <TimelineDetailView
        breadcrumbs={[{ label: "Runs", href: sandboxRoutes.section.runs }, { label: "Run" }]}
        cliCommand={`pdpp run timeline ${runId}`}
        description={
          <>
            {connectorId ? (
              <>
                connector <span className="font-mono text-foreground">{connectorId}</span>
                {" · "}
              </>
            ) : null}
            {envelope.events.length} events
          </>
        }
        envelope={envelope}
        id={runId}
        rawUrl={`/sandbox/_ref/runs/${encodeURIComponent(runId)}/timeline`}
        routes={sandboxRoutes}
        subject="run"
      />
    </DashboardShell>
  );
}
