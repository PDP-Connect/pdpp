import { listConnectorSummaries, type RefConnectorSummary } from "../lib/ref-client.ts";

export async function resolveConnectionForRecordsRoute(routeId: string): Promise<RefConnectorSummary | null> {
  const response = await listConnectorSummaries();
  return (
    response.data.find((summary) => summary.connection_id === routeId || summary.connector_instance_id === routeId) ??
    response.data.find((summary) => summary.connector_id === routeId) ??
    null
  );
}

export function connectorInstanceIdForConnection(summary: RefConnectorSummary): string {
  return summary.connector_instance_id ?? summary.connection_id;
}
