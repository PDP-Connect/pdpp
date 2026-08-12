// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Grant fan-in SHALL NOT bind to a phantom default-account connection.
 *
 * Regression for `openspec/changes/separate-connector-catalog-from-connections/`
 * (Requirement: "Grant resolution SHALL NOT bind to a non-existent connection").
 *
 * Before the fix, the dashboard / catalog read (`listConnectorSummaries`)
 * called `ensureDefaultAccountConnection` for every registered public
 * connector when the owner had zero connections. That `upsert` persisted a
 * `status:'active'` default-account `connector_instances` row, which then
 * leaked into grant fan-in resolution: a grant naming a `connector_id`
 * without pinning a `connector_instance_id` would resolve to that phantom
 * binding and read across a connection the owner never created.
 *
 * After the fix, a read persists nothing. A resolved grant keeps its frozen
 * instance handle without widening to a synthesized default connection.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { registerConnector } from "../server/auth.ts";
import { listActiveBindingsForGrant, resolveFanInBindings } from "../server/connection-identity.ts";
import { closeDb, initDb } from "../server/db.ts";
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from "../server/owner-auth.ts";
import { listConnectorSummaries } from "../server/ref-control.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";

const CONNECTOR_ID = "https://test.pdpp.dev/connectors/grant-fail-closed";
const STREAM = "messages";

const listedManifest = {
  // listed:true so it would have been materialized by the old read-time
  // catalog fan-out — the exact shape that produced phantom bindings.
  capabilities: { public_listing: { listed: true, status: "test" } },
  connector_id: CONNECTOR_ID,
  display_name: "Grant Fail-Closed Connector",
  protocol_version: "0.1.0",
  streams: [
    {
      name: STREAM,
      primary_key: ["id"],
      schema: {
        properties: {
          id: { type: "string" },
        },
        required: ["id"],
        type: "object",
      },
      selection: { fields: true, resources: true },
      semantics: "mutable_state",
    },
  ],
  version: "1.0.0",
};

function withDb(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    initDb();
    try {
      await fn();
    } finally {
      closeDb();
    }
  };
}

test(
  "a dashboard read persists no phantom connection and resolved grant fan-in does not widen",
  withDb(async () => {
    await registerConnector(listedManifest);

    const store = createSqliteConnectorInstanceStore();
    assert.equal(
      store.listByOwner(OWNER_AUTH_DEFAULT_SUBJECT_ID).length,
      0,
      "pre-condition: owner has zero connections for the registered connector"
    );

    // Simulate the owner viewing the dashboard / catalog. This is the read
    // that previously materialized a phantom default-account connection.
    const summaries = await listConnectorSummaries();
    assert.equal(summaries.length, 0, "owner with zero connections sees zero connections after the read");
    assert.equal(
      store.listByOwner(OWNER_AUTH_DEFAULT_SUBJECT_ID).length,
      0,
      "the read persisted no connector_instances row (no phantom connection)"
    );

    // The owner has no current active binding for this connector.
    const active = await listActiveBindingsForGrant({
      connectorId: CONNECTOR_ID,
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    });
    assert.deepEqual(active, [], "no active binding exists for an unconnected connector");

    const { bindings } = await resolveFanInBindings({
      authorizedInstanceIds: ["cin_unconnected"],
      connectorId: CONNECTOR_ID,
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    });
    assert.equal(bindings.length, 1, "resolved grant retains its one frozen instance handle");
    assert.equal(bindings[0]?.connectorId, CONNECTOR_ID);
    assert.equal(bindings[0]?.connectorInstanceId, "cin_unconnected");
    assert.equal(
      store.listByOwner(OWNER_AUTH_DEFAULT_SUBJECT_ID).length,
      0,
      "resolution does not synthesize or persist a replacement default connection"
    );
  })
);
