import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { DetailLoadingSkeleton } from "../../components/route-loading.tsx";

/**
 * Route-level loading state for a single run's detail page.
 *
 * The run detail page resolves the run timeline (and, for live runs, sets up
 * polling), which can lag on a long or browser-bound run. Show a stable Ink
 * Carbon shell plus an animated detail skeleton while it resolves — the same
 * frame the resolved detail renders, so there is no shell flash.
 */
export default function RunDetailLoading() {
  return (
    <RecordroomShellWithPalette>
      <DetailLoadingSkeleton label="this run" />
    </RecordroomShellWithPalette>
  );
}
