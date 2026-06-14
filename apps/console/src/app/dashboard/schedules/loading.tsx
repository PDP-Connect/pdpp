import { RecordroomShell } from "@pdpp/brand-react";
import { ListLoadingSkeleton } from "../components/route-loading.tsx";

/**
 * Route-level loading state for the schedules list.
 *
 * `/dashboard/schedules` reads connector summaries to render per-connection
 * schedules, which can be slow against a remote reference deployment. Keep the
 * shell stable and animate a list skeleton while the data resolves.
 */
export default function SchedulesLoading() {
  return (
    <RecordroomShell>
      <ListLoadingSkeleton label="schedules" rows={6} />
    </RecordroomShell>
  );
}
