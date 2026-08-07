// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { listConnectorSummaries, type RefConnectorSummary } from "../lib/ref-client.ts";

export async function resolveConnectionForRecordsRoute(
  routeId: string,
  explicitConnectionId?: string | null
): Promise<RefConnectorSummary | null> {
  // An explicit connection_id disambiguates a connector-key route (e.g.
  // /sources/steam?connection_id=cin_...) that would otherwise fall back to
  // resolveUnambiguousConnectionForConnectorId and 404 whenever the owner has
  // more than one connection for that connector type — the exact scenario a
  // stuck draft plus an older/revoked attempt produces. Try the exact id
  // first; if it does not resolve (wrong owner, deleted, typo'd link), fall
  // through to the normal route-id resolution rather than failing outright.
  if (explicitConnectionId) {
    const scoped = await listConnectorSummaries({ connectionRouteId: explicitConnectionId });
    const exact = scoped.data.find(
      (summary) =>
        summary.connection_id === explicitConnectionId || summary.connector_instance_id === explicitConnectionId
    );
    if (exact) {
      return exact;
    }
  }
  // Scope the reference projection to this one route id. The reference resolves
  // exact connection identity first and allows connector-id fallback only when
  // unambiguous. This returns a 0-or-1 list and the record subpage no longer
  // hydrates every connector to find one. The local fallback below is defensive
  // for older references; current references should already have made the
  // ambiguity decision before returning data.
  const response = await listConnectorSummaries({ connectionRouteId: routeId });
  return (
    response.data.find((summary) => summary.connection_id === routeId || summary.connector_instance_id === routeId) ??
    response.data.find((summary) => summary.connector_id === routeId) ??
    null
  );
}

export function connectorInstanceIdForConnection(summary: RefConnectorSummary): string {
  return summary.connector_instance_id ?? summary.connection_id;
}

export function sourceLabelForConnection(summary: RefConnectorSummary): string {
  return summary.display_name.trim() || summary.connector_display_name?.trim() || summary.connection_id;
}
