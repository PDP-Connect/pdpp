import { DetailLoadingSkeleton } from "../../../../components/route-loading.tsx";
import { RecordroomShell } from "@pdpp/brand-react";

/**
 * Route-level loading state for a stream's coverage/health detail page.
 *
 * `/dashboard/records/[connector]/[stream]/health` is `force-dynamic` and
 * resolves the connection plus the stream's coverage-health evidence before it
 * can paint. Keep the shell stable and animate a detail skeleton while it
 * resolves instead of a blank frame.
 */
export default function StreamHealthLoading() {
  return (
    <RecordroomShell>
      <DetailLoadingSkeleton label="this stream's coverage" />
    </RecordroomShell>
  );
}
