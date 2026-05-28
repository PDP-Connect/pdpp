import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "../../components/primitives.tsx";
import { DashboardShell, ServerUnreachable } from "../../components/shell.tsx";
import { dashboardRoutes } from "../../components/views/routes.ts";
import { TimelineDetailView } from "../../components/views/timeline-detail-view.tsx";
import { getAsInternalUrl, ReferenceServerUnreachableError } from "../../lib/owner-token.ts";
import { getGrantTimeline } from "../../lib/ref-client.ts";

export const dynamic = "force-dynamic";

type TimelineSearchParams = Promise<{ cursor?: string | string[] }>;

function getCursor(searchParams: { cursor?: string | string[] }): string | null {
  return typeof searchParams.cursor === "string" && searchParams.cursor.length > 0 ? searchParams.cursor : null;
}

function grantTimelineHref(grantId: string, cursor: string): string {
  return `/dashboard/grants/${encodeURIComponent(grantId)}?${new URLSearchParams({ cursor }).toString()}`;
}

export default async function GrantDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ grantId: string }>;
  searchParams: TimelineSearchParams;
}) {
  const { grantId: raw } = await params;
  const grantId = decodeURIComponent(raw);
  const cursor = getCursor(await searchParams);

  let envelope: Awaited<ReturnType<typeof getGrantTimeline>>;
  try {
    envelope = await getGrantTimeline(grantId, { cursor });
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <DashboardShell active="grants">
          <PageHeader title="Grant" />
          <ServerUnreachable />
        </DashboardShell>
      );
    }
    throw err;
  }

  if (!envelope) {
    notFound();
  }

  const revoked = envelope.events.some((e) => e.event_type === "grant.revoked" || e.status === "revoked");

  const subscriptionsHref = `/dashboard/event-subscriptions?grant_id=${encodeURIComponent(grantId)}`;

  return (
    <DashboardShell active="grants">
      <TimelineDetailView
        beforeTimeline={
          <div className="pdpp-caption mb-6 text-muted-foreground">
            <Link className="underline-offset-2 hover:underline" href={subscriptionsHref}>
              Event subscriptions for this grant →
            </Link>
          </div>
        }
        breadcrumbs={[{ label: "Grants", href: "/dashboard/grants" }, { label: "Grant" }]}
        cliCommand={`pdpp ref grant timeline ${grantId}`}
        count={`${envelope.events.length} events${revoked ? " · revoked" : ""}`}
        envelope={envelope}
        id={grantId}
        loadMoreHref={
          envelope.truncated && envelope.next_cursor ? grantTimelineHref(grantId, envelope.next_cursor) : null
        }
        rawUrl={`${getAsInternalUrl()}/_ref/grants/${encodeURIComponent(grantId)}/timeline`}
        routes={dashboardRoutes}
        subject="grant"
      />
    </DashboardShell>
  );
}
