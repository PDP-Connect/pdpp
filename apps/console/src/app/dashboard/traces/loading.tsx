import { RecordroomShell } from "@pdpp/brand-react";
import { ListLoadingSkeleton } from "../components/route-loading.tsx";

/**
 * Route-level loading state for the traces list.
 *
 * `/dashboard/traces` lists protocol traces (and optionally peeks a timeline)
 * from the reference deployment, which can be slow on a busy instance. Keep the
 * shell stable and animate a list skeleton while the data resolves.
 */
export default function TracesLoading() {
  return (
    <RecordroomShell>
      <ListLoadingSkeleton label="traces" rows={8} />
    </RecordroomShell>
  );
}
