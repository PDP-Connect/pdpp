import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { ListLoadingSkeleton } from "../components/route-loading.tsx";

/**
 * Route-level loading state for the connections (records) list.
 *
 * `/sources` fetches connector summaries, version-churn stats, and
 * device-exporter source instances on every load, so it can take a moment.
 * This gives the owner immediate, stable feedback instead of a blank frame.
 */
export default function RecordsLoading() {
  return (
    <RecordroomShellWithPalette>
      <ListLoadingSkeleton label="connections" rows={6} />
    </RecordroomShellWithPalette>
  );
}
