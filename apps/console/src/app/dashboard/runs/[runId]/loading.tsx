import { DetailLoadingSkeleton } from "../../components/route-loading.tsx";
import { DashboardShell } from "../../components/shell.tsx";

/**
 * Route-level loading state for a single run's detail page.
 *
 * The run detail page resolves the run timeline (and, for live runs, sets up
 * polling), which can lag on a long or browser-bound run. Keep the shell
 * stable and animate a detail skeleton while it resolves.
 */
export default function RunDetailLoading() {
  return (
    <DashboardShell active="runs">
      <DetailLoadingSkeleton label="this run" />
    </DashboardShell>
  );
}
