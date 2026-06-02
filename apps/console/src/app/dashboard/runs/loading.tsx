import { ListLoadingSkeleton } from "../components/route-loading.tsx";
import { DashboardShell } from "../components/shell.tsx";

/**
 * Route-level loading state for the runs list.
 *
 * `/dashboard/runs` lists connector runs (and optionally peeks a run timeline),
 * which can be slow on a busy instance. Keep the shell stable and animate a
 * list skeleton while the data resolves.
 */
export default function RunsLoading() {
  return (
    <DashboardShell active="runs">
      <ListLoadingSkeleton label="runs" rows={8} />
    </DashboardShell>
  );
}
