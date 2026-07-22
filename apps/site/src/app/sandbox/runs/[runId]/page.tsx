// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { sandboxRoutes } from "@pdpp/operator-ui/components/views/routes";
import { TimelineDetailView } from "@pdpp/operator-ui/components/views/timeline-detail-view";
import { notFound } from "next/navigation";
import { DashboardShell } from "@/app/dashboard/components/shell.tsx";
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
        cliCommand={`pdpp ref run timeline ${runId}`}
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
