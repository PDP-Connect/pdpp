import { PageHeader } from "../../components/primitives.tsx";
import { DashboardShell, ServerUnreachable } from "../../components/shell.tsx";
import { RecordsTimelineView } from "../../components/views/records-timeline-view.tsx";
import { dashboardRoutes } from "../../components/views/routes.ts";
import { liveDashboardDataSource } from "../../lib/data-source.ts";
import { ReferenceServerUnreachableError } from "../../lib/owner-token.ts";
import { defaultWindow, loadTimeline } from "../../lib/timeline.ts";

export const dynamic = "force-dynamic";

export default async function RecordsTimelinePage({
  searchParams,
}: {
  searchParams: Promise<{ since?: string; until?: string }>;
}) {
  const { since: sinceParam, until: untilParam } = await searchParams;
  const fallback = defaultWindow(7);
  const since = sinceParam || fallback.since;
  const until = untilParam || fallback.until;

  let result: Awaited<ReturnType<typeof loadTimeline>>;
  try {
    result = await loadTimeline({ since, until }, liveDashboardDataSource);
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <DashboardShell active="records">
          <PageHeader title="Timeline" />
          <ServerUnreachable />
        </DashboardShell>
      );
    }
    throw err;
  }

  return (
    <DashboardShell active="records">
      <RecordsTimelineView result={result} routes={dashboardRoutes} since={since} until={until} />
    </DashboardShell>
  );
}
