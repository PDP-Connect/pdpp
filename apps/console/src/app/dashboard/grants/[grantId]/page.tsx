import { RecordroomShell } from "@pdpp/brand-react";
import { PageHeader } from "@pdpp/operator-ui/components/primitives";
import { dashboardRoutes } from "@pdpp/operator-ui/components/views/routes";
import { TimelineDetailView } from "@pdpp/operator-ui/components/views/timeline-detail-view";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ServerUnreachable } from "../../components/shell.tsx";
import { getAsInternalUrl, ReferenceServerUnreachableError } from "../../lib/owner-token.ts";
import { getGrantTimeline, lookupGrantPackageIdForGrant } from "../../lib/ref-client.ts";

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
  let packageId: string | null = null;
  try {
    [envelope, packageId] = await Promise.all([
      getGrantTimeline(grantId, { cursor }),
      lookupGrantPackageIdForGrant(grantId),
    ]);
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <RecordroomShell>
          <PageHeader title="Grant" />
          <ServerUnreachable />
        </RecordroomShell>
      );
    }
    throw err;
  }

  if (!envelope) {
    notFound();
  }

  const revoked = envelope.events.some((e) => e.event_type === "grant.revoked" || e.status === "revoked");

  const subscriptionsHref = `/dashboard/event-subscriptions?grant_id=${encodeURIComponent(grantId)}`;
  const packageHref = packageId ? `/dashboard/grants/packages/${encodeURIComponent(packageId)}` : null;

  return (
    <RecordroomShell>
      <TimelineDetailView
        beforeTimelineContent={
          <div className="pdpp-caption mb-6 flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
            {packageHref ? (
              <Link className="underline-offset-2 hover:underline" href={packageHref}>
                Parent grant package {packageId} →
              </Link>
            ) : null}
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
    </RecordroomShell>
  );
}
