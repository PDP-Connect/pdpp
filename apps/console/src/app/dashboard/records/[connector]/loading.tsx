import { RecordroomShellWithPalette } from "@/app/dashboard/components/recordroom-shell-with-palette.tsx";
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
    <RecordroomShellWithPalette>
      <DetailLoadingSkeleton label="this connection" />
    </RecordroomShellWithPalette>
  );
}
