import { notFound } from "next/navigation";
import { PageHeader } from "../../components/primitives.tsx";
import { DashboardShell, ServerUnreachable } from "../../components/shell.tsx";
import { dashboardRoutes } from "../../components/views/routes.ts";
import { TimelineDetailView } from "../../components/views/timeline-detail-view.tsx";
import { getAsInternalUrl, ReferenceServerUnreachableError } from "../../lib/owner-token.ts";
import { getTraceTimeline, type TimelineEnvelope } from "../../lib/ref-client.ts";

export const dynamic = "force-dynamic";

type TimelineSearchParams = Promise<{ cursor?: string | string[] }>;

function getCursor(searchParams: { cursor?: string | string[] }): string | null {
  return typeof searchParams.cursor === "string" && searchParams.cursor.length > 0 ? searchParams.cursor : null;
}

function traceTimelineHref(traceId: string, cursor: string): string {
  return `/dashboard/traces/${encodeURIComponent(traceId)}?${new URLSearchParams({ cursor }).toString()}`;
}

export default async function TraceDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ traceId: string }>;
  searchParams: TimelineSearchParams;
}) {
  const { traceId: raw } = await params;
  const traceId = decodeURIComponent(raw);
  const cursor = getCursor(await searchParams);

  let envelope: TimelineEnvelope | null;
  try {
    envelope = await getTraceTimeline(traceId, { cursor });
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <DashboardShell active="traces">
          <PageHeader title="Trace" />
          <ServerUnreachable />
        </DashboardShell>
      );
    }
    throw err;
  }

  if (!envelope) {
    notFound();
  }

  const first = envelope.events[0];
  return (
    <DashboardShell active="traces">
      <TimelineDetailView
        breadcrumbs={[{ label: "Traces", href: "/dashboard/traces" }, { label: "Trace" }]}
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
        loadMoreHref={
          envelope.truncated && envelope.next_cursor ? traceTimelineHref(traceId, envelope.next_cursor) : null
        }
        rawUrl={`${getAsInternalUrl()}/_ref/traces/${encodeURIComponent(traceId)}`}
        routes={dashboardRoutes}
        subject="trace"
      />
    </DashboardShell>
  );
}
