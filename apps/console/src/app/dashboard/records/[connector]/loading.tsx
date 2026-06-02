import { DetailLoadingSkeleton } from "../../components/route-loading.tsx";
import { DashboardShell } from "../../components/shell.tsx";

/**
 * Route-level loading state for a single connection's detail page.
 *
 * The detail page fans out to schedule, recent runs, manifests, streams, and
 * device-exporter source instances, so it is one of the heavier dashboard
 * surfaces. Show a stable shell plus a detail skeleton while it resolves.
 */
export default function ConnectorDetailLoading() {
  return (
    <DashboardShell active="records">
      <DetailLoadingSkeleton label="this connection" />
    </DashboardShell>
  );
}
