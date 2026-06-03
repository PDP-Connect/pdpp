import { ListLoadingSkeleton } from "../components/route-loading.tsx";
import { DashboardShell } from "../components/shell.tsx";

/**
 * Route-level loading state for the Records Explorer.
 *
 * `/dashboard/explore` is `force-dynamic` and, before it can paint, fans out to
 * connector summaries, connector manifests, and either a hybrid/lexical search
 * or an empty-query recency read — one of the heavier dashboard surfaces. Show a
 * stable shell plus an animated list skeleton instead of a blank frame while it
 * resolves.
 */
export default function ExploreLoading() {
  return (
    <DashboardShell active="explore">
      <ListLoadingSkeleton label="records" rows={8} />
    </DashboardShell>
  );
}
