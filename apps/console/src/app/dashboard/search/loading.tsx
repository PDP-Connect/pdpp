import { ListLoadingSkeleton } from "../components/route-loading.tsx";
import { DashboardShell } from "../components/shell.tsx";

/**
 * Route-level loading state for global search.
 *
 * `/dashboard/search` is `force-dynamic` and awaits a reference `refSearch`
 * read across grants, runs, and traces before it can render its result groups.
 * Keep the shell stable and animate a list skeleton while that read resolves,
 * rather than painting a blank frame.
 */
export default function SearchLoading() {
  return (
    <DashboardShell active="search">
      <ListLoadingSkeleton label="search results" rows={6} />
    </DashboardShell>
  );
}
