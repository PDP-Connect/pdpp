// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { ConnectorInstanceResolutionError } from "./stores/connector-instance-store.ts";

/**
 * Applies the reference-only write-admission lifecycle rule after a backend
 * has read a connector instance inside its durable write transaction.
 */
export function assertConnectorInstanceWritableStatus(status: string | null, connectorInstanceId: string): void {
  if (status === null) {
    throw new ConnectorInstanceResolutionError(
      "connector_instance_not_found",
      `Connector instance '${connectorInstanceId}' does not exist; it may have been deleted concurrently with this write.`,
      { connectorInstanceId }
    );
  }
  if (status === "revoked") {
    throw new ConnectorInstanceResolutionError(
      "connector_instance_not_writable",
      `Connector instance '${connectorInstanceId}' is revoked; it may have been revoked concurrently with this write.`,
      { connectorInstanceId }
    );
  }
}
