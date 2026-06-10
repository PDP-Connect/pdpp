import { listConnectorSummaries, type RefConnectorSummary } from "../lib/ref-client.ts";

export async function resolveConnectionForRecordsRoute(routeId: string): Promise<RefConnectorSummary | null> {
  // Scope the reference projection to this one route id. The reference resolves
  // it with the same precedence applied below (stable connection identity first,
  // then first `connector_id` match), so this returns a 0-or-1 list and the
  // record subpage no longer hydrates every connector to find one. The `find`
  // chain is preserved as a defensive no-op: identical match precedence, so a
  // single-element response resolves unchanged and the behavior is byte-for-byte
  // the same as filtering the full list.
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
