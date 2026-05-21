import { DashboardShell } from "@/app/dashboard/components/shell.tsx";
import { RecordsTimelineView } from "@/app/dashboard/components/views/records-timeline-view.tsx";
import { sandboxRoutes } from "@/app/dashboard/components/views/routes.ts";
import { defaultWindow, loadTimeline } from "@/app/dashboard/lib/timeline.ts";
import { sandboxDashboardDataSource } from "../../_demo/data-source.ts";

// The sandbox dataset is deterministic and lives in-process; rendering
// at request time keeps the date-window form responsive for ?since/?until
// without invalidating a Next cache.
export const dynamic = "force-dynamic";

export default async function SandboxRecordsTimelinePage({
  searchParams,
}: {
  searchParams: Promise<{ since?: string; until?: string }>;
}) {
  const { since: sinceParam, until: untilParam } = await searchParams;
  // Sandbox records are seeded around the frozen demo clock (early 2026),
  // not around real "now", so a 7-day default would render an empty view.
  // Using a 1-year window keeps the seeded records visible without
  // changing the live dashboard's default behavior.
  const fallback = defaultWindow(365);
  const since = sinceParam || fallback.since;
  const until = untilParam || fallback.until;

  const result = await loadTimeline({ since, until }, sandboxDashboardDataSource);

  return (
    <DashboardShell active="records" mode="mock-owner">
      <RecordsTimelineView result={result} routes={sandboxRoutes} since={since} until={until} />
    </DashboardShell>
  );
}
