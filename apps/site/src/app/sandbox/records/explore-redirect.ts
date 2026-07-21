// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { explorerPeekParam } from "@pdpp/operator-ui/components/views/explorer-utils";
import { sandboxRoutes } from "@pdpp/operator-ui/components/views/routes";

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
