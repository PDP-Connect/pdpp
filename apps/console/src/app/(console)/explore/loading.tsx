import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { ListLoadingSkeleton } from "../components/route-loading.tsx";

/**
 * Route-level loading state for the Records Explorer.
 *
 * `/explore` is `force-dynamic` and, before it can paint, fans out to
 * connector summaries, connector manifests, and either a hybrid/lexical search
 * or an empty-query recency read — one of the heavier dashboard surfaces. Show a
 * stable Ink Carbon shell plus an animated list skeleton instead of a blank
 * frame while it resolves.
 */
export default function ExploreLoading() {
  return (
    <RecordroomShellWithPalette build="pdpp 0.1.0" host="this server">
      <ListLoadingSkeleton label="records" rows={8} />
    </RecordroomShellWithPalette>
  );
}
