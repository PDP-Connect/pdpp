import { RecordroomShell } from "@/components/ink-carbon/index.ts";
import { ListLoadingSkeleton } from "../components/route-loading.tsx";

/**
 * Route-level loading state for the runs list.
 *
 * `/dashboard/runs` lists connector runs (and optionally peeks a run timeline),
 * which can be slow on a busy instance. Show a stable Ink Carbon shell plus an
 * animated list skeleton while the data resolves — the same frame the live
 * Syncs view renders, so there is no shell flash on first paint.
 */
export default function RunsLoading() {
  return (
    <RecordroomShell>
      <ListLoadingSkeleton label="runs" rows={8} />
    </RecordroomShell>
  );
}
