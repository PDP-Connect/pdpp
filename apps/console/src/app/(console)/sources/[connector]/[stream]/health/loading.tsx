import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { DetailLoadingSkeleton } from "../../../../components/route-loading.tsx";

/**
 * Route-level loading state for a stream's coverage/health detail page.
 *
 * `/sources/[connector]/[stream]/health` is `force-dynamic` and
 * resolves the connection plus the stream's coverage-health evidence before it
 * can paint. Keep the shell stable and animate a detail skeleton while it
 * resolves instead of a blank frame.
 */
export default function StreamHealthLoading() {
  return (
    <RecordroomShellWithPalette>
      <DetailLoadingSkeleton label="this stream's coverage" />
    </RecordroomShellWithPalette>
  );
}
