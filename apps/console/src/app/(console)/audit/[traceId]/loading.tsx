import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { DetailLoadingSkeleton } from "../../components/route-loading.tsx";

/**
 * Route-level loading state for a single trace's detail page.
 *
 * `/audit/[traceId]` is `force-dynamic` and resolves a trace's full
 * protocol timeline, which can lag on a busy or long-lived trace. Keep the shell
 * stable and animate a detail skeleton while it resolves instead of a blank
 * frame.
 */
export default function TraceDetailLoading() {
  return (
    <RecordroomShellWithPalette>
      <DetailLoadingSkeleton label="this trace" />
    </RecordroomShellWithPalette>
  );
}
