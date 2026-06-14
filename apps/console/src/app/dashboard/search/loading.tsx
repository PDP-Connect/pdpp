import { RecordroomShellWithPalette } from "@/app/dashboard/components/recordroom-shell-with-palette.tsx";
import { ListLoadingSkeleton } from "../components/route-loading.tsx";

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
    <RecordroomShellWithPalette>
      <ListLoadingSkeleton label="search results" rows={6} />
    </RecordroomShellWithPalette>
  );
}
