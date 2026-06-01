import { explorerPeekParam } from "@/app/dashboard/components/views/explorer-utils.ts";
import { sandboxRoutes } from "@/app/dashboard/components/views/routes.ts";

export function sandboxExploreRedirectHref({
  connectorId,
  recordId,
  stream,
}: {
  connectorId?: string;
  recordId?: string;
  stream?: string;
} = {}): string {
  const params = new URLSearchParams();
  if (connectorId) {
    params.set("connection", connectorId);
  }
  if (stream) {
    params.set("stream", stream);
  }
  if (connectorId && stream && recordId) {
    params.set(
      "peek",
      explorerPeekParam({
        connectorId,
        connectionId: connectorId,
        stream,
        recordId,
      })
    );
  }
  const qs = params.toString();
  return qs ? `${sandboxRoutes.section.explore}?${qs}` : sandboxRoutes.section.explore;
}
