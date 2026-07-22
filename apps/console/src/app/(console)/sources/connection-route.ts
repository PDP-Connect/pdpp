// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { listConnectorSummaries, type RefConnectorSummary } from "../lib/ref-client.ts";

export async function resolveConnectionForRecordsRoute(routeId: string): Promise<RefConnectorSummary | null> {
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
  // biome-ignore lint/suspicious/noUnnecessaryConditions: runtime value, TS type is optimistic
  return summary.display_name?.trim() || summary.connector_display_name?.trim() || summary.connection_id;
}
