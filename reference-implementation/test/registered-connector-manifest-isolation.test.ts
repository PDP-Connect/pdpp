// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import type { ConnectorManifest } from "../runtime/controller.ts";
import { collectValidRegisteredConnectorManifests } from "../server/index.ts";

test("registered manifest collection skips one invalid registration without suppressing valid connectors", async () => {
  const warnings: string[] = [];
  const valid = { connector_id: "valid", streams: [] } as unknown as ConnectorManifest;

  const manifests = await collectValidRegisteredConnectorManifests({
    listConnectorIds: async () => ["invalid", "valid"],
    loadManifest: (connectorId) => {
      if (connectorId === "invalid") {
        return Promise.reject(new Error("persisted manifest is no longer valid"));
      }
      return Promise.resolve(valid);
    },
    logger: {
      warn: ({ connectorId }: { connectorId: string }) => warnings.push(connectorId),
    } as never,
  });

  assert.deepEqual(manifests, [{ connectorId: "valid", manifest: valid }]);
  assert.deepEqual(warnings, ["invalid"]);
});
