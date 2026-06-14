import { RecordroomShell } from "@pdpp/brand-react";
import { ListLoadingSkeleton } from "../components/route-loading.tsx";

/**
 * Route-level loading state for the Records Explorer.
 *
 * `/dashboard/explore` is `force-dynamic` and, before it can paint, fans out to
 * connector summaries, connector manifests, and either a hybrid/lexical search
 * or an empty-query recency read — one of the heavier dashboard surfaces. Show a
 * stable Ink Carbon shell plus an animated list skeleton instead of a blank
 * frame while it resolves.
 */
export default function ExploreLoading() {
  return (
    <RecordroomShell build="pdpp 0.1.0" host="this server">
      <ListLoadingSkeleton label="records" rows={8} />
    </RecordroomShell>
  );
}
