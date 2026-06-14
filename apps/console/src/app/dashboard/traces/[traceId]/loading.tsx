import { RecordroomShell } from "@pdpp/brand-react";
import { DetailLoadingSkeleton } from "../../components/route-loading.tsx";

/**
 * Route-level loading state for a single trace's detail page.
 *
 * `/dashboard/traces/[traceId]` is `force-dynamic` and resolves a trace's full
 * protocol timeline, which can lag on a busy or long-lived trace. Keep the shell
 * stable and animate a detail skeleton while it resolves instead of a blank
 * frame.
 */
export default function TraceDetailLoading() {
  return (
    <RecordroomShell>
      <DetailLoadingSkeleton label="this trace" />
    </RecordroomShell>
  );
}
