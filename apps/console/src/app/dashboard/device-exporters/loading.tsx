import { ListLoadingSkeleton } from "../components/route-loading.tsx";
import { DashboardShell } from "../components/shell.tsx";

/**
 * Route-level loading state for the device-exporters list.
 *
 * `/dashboard/device-exporters` reads collector diagnostics and source
 * instances from the reference deployment in parallel on every load. Keep the
 * shell stable and animate a list skeleton instead of a blank frame.
 */
export default function DeviceExportersLoading() {
  return (
    <DashboardShell active="device-exporters">
      <ListLoadingSkeleton label="device exporters" rows={5} />
    </DashboardShell>
  );
}
