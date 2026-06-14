import { RecordroomShell } from "@pdpp/brand-react";
import { DetailLoadingSkeleton } from "../../components/route-loading.tsx";

/**
 * Route-level loading state for a single connection's detail page.
 *
 * The detail page fans out to schedule, recent runs, manifests, streams, and
 * device-exporter source instances, so it is one of the heavier dashboard
 * surfaces. Show a stable shell plus a detail skeleton while it resolves.
 */
export default function ConnectorDetailLoading() {
  return (
    <RecordroomShell>
      <DetailLoadingSkeleton label="this connection" />
    </RecordroomShell>
  );
}
