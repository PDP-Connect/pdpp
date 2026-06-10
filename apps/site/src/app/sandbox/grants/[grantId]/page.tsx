import { sandboxRoutes } from "@pdpp/operator-ui/components/views/routes";
import { TimelineDetailView } from "@pdpp/operator-ui/components/views/timeline-detail-view";
import { notFound } from "next/navigation";
import { DashboardShell } from "@/app/dashboard/components/shell.tsx";
import { sandboxDashboardDataSource } from "../../_demo/data-source.ts";

export const dynamic = "force-static";

export default async function SandboxGrantDetailPage({ params }: { params: Promise<{ grantId: string }> }) {
  const { grantId: raw } = await params;
  const grantId = decodeURIComponent(raw);
  const envelope = await sandboxDashboardDataSource.getGrantTimeline(grantId);
  if (!envelope) {
    notFound();
  }
  const revoked = envelope.events.some((e) => e.event_type === "grant.revoked" || e.status === "revoked");
  return (
    <DashboardShell active="grants" mode="mock-owner">
      <TimelineDetailView
        breadcrumbs={[{ label: "Grants", href: sandboxRoutes.section.grants }, { label: "Grant" }]}
        cliCommand={`pdpp ref grant timeline ${grantId}`}
        count={`${envelope.events.length} events${revoked ? " · revoked" : ""}`}
        envelope={envelope}
        id={grantId}
        rawUrl={`/sandbox/_ref/grants/${encodeURIComponent(grantId)}/timeline`}
        routes={sandboxRoutes}
        subject="grant"
      />
    </DashboardShell>
  );
}
