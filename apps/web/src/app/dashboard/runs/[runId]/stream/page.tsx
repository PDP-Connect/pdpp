import { notFound } from "next/navigation";
import { Callout, PageHeader } from "../../../components/primitives.tsx";
import { DashboardShell, ServerUnreachable } from "../../../components/shell.tsx";
import { dashboardRoutes } from "../../../components/views/routes.ts";
import { ReferenceServerUnreachableError } from "../../../lib/owner-token.ts";
import { getRunTimeline, type SpineEvent, type TimelineEnvelope } from "../../../lib/ref-client.ts";
import { RunInteractionStreamViewer } from "./stream-viewer.tsx";

export const dynamic = "force-dynamic";

interface PendingInteractionSummary {
  interactionId: string;
  kind: string;
  message: string;
}

function getPendingInteraction(events: SpineEvent[]): PendingInteractionSummary | null {
  const completed = new Set(
    events
      .filter((event) => event.event_type === "run.interaction_completed")
      .map((event) => event.interaction_id)
      .filter((value): value is string => typeof value === "string" && value.length > 0)
  );
  const pending = [...events]
    .reverse()
    .find(
      (event) =>
        event.event_type === "run.interaction_required" &&
        typeof event.interaction_id === "string" &&
        !completed.has(event.interaction_id)
    );
  if (!pending || typeof pending.interaction_id !== "string") {
    return null;
  }
  return {
    interactionId: pending.interaction_id,
    kind: String(pending.data?.kind ?? "interaction"),
    message: String(pending.data?.message ?? "Awaiting operator response."),
  };
}

export default async function RunInteractionStreamPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId: raw } = await params;
  const runId = decodeURIComponent(raw);

  let envelope: TimelineEnvelope | null;
  try {
    envelope = await getRunTimeline(runId, { cursor: null });
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <DashboardShell active="runs">
          <PageHeader title="Streaming companion" />
          <ServerUnreachable />
        </DashboardShell>
      );
    }
    throw err;
  }
  if (!envelope) {
    notFound();
    return null;
  }

  const pending = getPendingInteraction(envelope.events);

  return (
    <DashboardShell active="runs">
      <PageHeader
        breadcrumbs={[
          { label: "Runs", href: dashboardRoutes.section.runs },
          { label: runId, href: `/dashboard/runs/${encodeURIComponent(runId)}` },
          { label: "Streaming companion" },
        ]}
        description="Use a short-lived browser stream to satisfy a pending manual-action interaction from this device."
        title="Run interaction stream"
      />
      {pending ? (
        <Callout description={pending.message} surface="human" title="Pending interaction">
          <RunInteractionStreamViewer
            interactionId={pending.interactionId}
            interactionKind={pending.kind}
            runId={runId}
          />
        </Callout>
      ) : (
        <Callout
          description="This run has nothing waiting on operator input. Streaming is only available while an interaction is pending."
          surface="protocol"
          title="No pending interaction"
        />
      )}
    </DashboardShell>
  );
}
