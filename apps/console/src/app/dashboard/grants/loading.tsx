import { RecordroomShell } from "@pdpp/brand-react";
import { ListLoadingSkeleton } from "../components/route-loading.tsx";

/**
 * Route-level loading state for the grants list.
 *
 * `/dashboard/grants` reads the grant list and pending approvals on every load,
 * so it can take a moment against a remote reference deployment. Keep the shell
 * stable and animate a list skeleton instead of showing a blank frame.
 */
export default function GrantsLoading() {
  return (
    <RecordroomShell>
      <ListLoadingSkeleton label="grants" rows={6} />
    </RecordroomShell>
  );
}
