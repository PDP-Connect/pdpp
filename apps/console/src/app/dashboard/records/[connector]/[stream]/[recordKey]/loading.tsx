import { RecordroomShell } from "@pdpp/brand-react";
import { DetailLoadingSkeleton } from "../../../../components/route-loading.tsx";

/**
 * Route-level loading state for a single record's detail page.
 *
 * `/dashboard/records/[connector]/[stream]/[recordKey]` is `force-dynamic` and
 * resolves the connection, the connector manifest, and the individual record
 * (and its change history) before it can paint. Keep the shell stable and
 * animate a detail skeleton while it resolves instead of a blank frame.
 */
export default function RecordDetailLoading() {
  return (
    <RecordroomShell>
      <DetailLoadingSkeleton label="this record" />
    </RecordroomShell>
  );
}
