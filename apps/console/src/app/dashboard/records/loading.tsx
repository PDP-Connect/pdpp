import { ListLoadingSkeleton } from "../components/route-loading.tsx";
import { DashboardShell } from "../components/shell.tsx";

/**
 * Route-level loading state for the connections (records) list.
 *
 * `/dashboard/records` fetches connector summaries, version-churn stats, and
 * device-exporter source instances on every load, so it can take a moment.
 * This gives the owner immediate, stable feedback instead of a blank frame.
 */
export default function RecordsLoading() {
  return (
    <DashboardShell active="records">
      <ListLoadingSkeleton label="connections" rows={6} />
    </DashboardShell>
  );
}
