// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Owner read routes SHALL NOT create phantom connector_instances rows.
 *
 * Regression for manual/artifact connectors like WhatsApp: an owner read that
 * addressed `/v1/streams?connector_id=whatsapp` resolved the manifest through a
 * path that still allowed default-account materialization. That persisted an
 * active `source_kind:'account'` row even though the owner never uploaded an
 * artifact and the connection had zero records/runs.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { issueOwnerToken, registerConnector } from "../server/auth.ts";
import { startServer } from "../server/index.ts";
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from "../server/owner-auth.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";

const CONNECTOR_ID = "test-manual-artifact";

const manualArtifactManifest = {
  capabilities: {
    public_listing: { listed: true, status: "test" },
    refresh_policy: {
      background_safe: false,
      interaction_posture: "manual_action_likely",
      rationale: "The test source is populated only when the owner uploads an artifact.",
      recommended_mode: "manual",
    },
  },
  connector_id: CONNECTOR_ID,
  connector_key: "test-manual-artifact",
  display_name: "Test Manual Artifact",
  manifest_uri: "https://registry.pdpp.dev/connectors/test-manual-artifact",
  protocol_version: "0.1.0",
  setup: {
    manual_or_upload: {
      accepted_file_extensions: [".txt"],
      label: "Manual artifact",
      validation: { kind: "test_manual_artifact" },
    },
    modality: "manual_or_upload",
  },
  streams: [
    {
      name: "messages",
      primary_key: ["id"],
      schema: {
        properties: { id: { type: "string" } },
        required: ["id"],
        type: "object",
      },
      selection: { fields: true, resources: true },
      semantics: "mutable_state",
    },
  ],
  version: "1.0.0",
};

// `closeAllConnections` exists on Node's http/http2 server objects at
// runtime but is not declared on the `tls.Server`/`Http2SecureServer`
// type chain in the installed @types/node version, so callers reach it
// through a structural interface rather than widening the whole handle.
interface TestHttpServer {
  close: (callback: () => void) => void;
  closeAllConnections?: () => void;
}

interface TestServerHandle {
  asServer: TestHttpServer;
  rsPort: number;
  rsServer: TestHttpServer;
}

async function closeServer(server: TestServerHandle): Promise<void> {
  server.asServer.closeAllConnections?.();
  server.rsServer.closeAllConnections?.();
  const closeOne = (srv: TestHttpServer) =>
    new Promise<void>((resolve) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve();
        }
      }, 2000);
      srv.close(() => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          resolve();
        }
      });
    });
  await Promise.allSettled([closeOne(server.asServer), closeOne(server.rsServer)]);
}

test("owner /v1/streams read for an unconnected manual connector persists no connection row", async () => {
  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    quiet: true,
    rsPort: 0,
  });
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    await registerConnector(manualArtifactManifest);
    const token = await issueOwnerToken(OWNER_AUTH_DEFAULT_SUBJECT_ID);
    const store = createSqliteConnectorInstanceStore();

    assert.equal(store.listByOwner(OWNER_AUTH_DEFAULT_SUBJECT_ID).length, 0);

    const ownerWideResp = await fetch(`${rsUrl}/v1/streams`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
    });
    const ownerWideBody = (await ownerWideResp.json()) as { data?: unknown[] };
    assert.equal(ownerWideResp.status, 200, JSON.stringify(ownerWideBody));
    assert.deepEqual(ownerWideBody.data, [], "unconnected registered connectors are absent from owner-wide discovery");

    const resp = await fetch(`${rsUrl}/v1/streams?connector_id=${encodeURIComponent(CONNECTOR_ID)}`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
    });
    const body = (await resp.json()) as { error?: { code?: string } };
    assert.equal(resp.status, 404, JSON.stringify(body));
    assert.equal(body.error?.code, "connection_not_found");

    assert.equal(
      store.listByOwner(OWNER_AUTH_DEFAULT_SUBJECT_ID).length,
      0,
      "owner read must not persist a default-account connector_instances row"
    );
  } finally {
    await closeServer(server);
  }
});
