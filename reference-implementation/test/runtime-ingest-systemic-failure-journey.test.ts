// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadSyncState, runConnector } from "../runtime/index.ts";
import { getDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { __setIngestFaultHookForTest } from "../server/records.ts";
import { createRequestConnectorInstanceStore } from "../server/request-store-factories.ts";
import { admitOwnerRunConnection } from "../server/stores/connector-instance-store.ts";

const SYSTEMIC_PUBLIC_RE = /transient storage error|ingest_batch_storage_error/;

interface ClosableServer {
  asPort: number;
  asServer: { close: (cb: () => void) => void; closeAllConnections?: () => void };
  rsPort: number;
  rsServer: { close: (cb: () => void) => void; closeAllConnections?: () => void };
}

async function closeServer(server: ClosableServer): Promise<void> {
  server.asServer.closeAllConnections?.();
  server.rsServer.closeAllConnections?.();
  const closeOne = (srv: { close: (cb: () => void) => void }) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2000);
      srv.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  await Promise.allSettled([closeOne(server.asServer), closeOne(server.rsServer)]);
}

async function fetchJson(url: string, init?: RequestInit): Promise<{ body: unknown; status: number }> {
  const resp = await fetch(url, init);
  const text = await resp.text();
  return { body: text ? JSON.parse(text) : null, status: resp.status };
}

function manifest(connectorId: string) {
  return {
    connector_id: connectorId,
    connector_key: connectorId,
    display_name: "Runtime systemic failure journey",
    manifest_uri: `https://registry.pdpp.dev/connectors/${connectorId}`,
    protocol_version: "0.1.0",
    streams: [
      {
        name: "items",
        primary_key: ["id"],
        schema: {
          properties: { id: { type: "string" }, value: { type: "string" } },
          required: ["id"],
          type: "object",
        },
        selection: { fields: true, resources: true },
        semantics: "mutable_state",
      },
    ],
    version: "1.0.0",
  };
}

function runtimeManifest(connectorId: string): Parameters<typeof runConnector>[0]["manifest"] {
  return manifest(connectorId) as Parameters<typeof runConnector>[0]["manifest"];
}

async function registerManifest(asUrl: string, connectorManifest: Record<string, unknown>): Promise<void> {
  const response = await fetchJson(`${asUrl}/connectors`, {
    body: JSON.stringify(connectorManifest),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
}

async function issueOwnerToken(asUrl: string): Promise<string> {
  const clientId = "cli_longview";
  const { body } = await fetchJson(`${asUrl}/oauth/device_authorization`, {
    body: new URLSearchParams({ client_id: clientId }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const device = body as { device_code: string; user_code: string };
  await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({ subject_id: "owner_local", user_code: device.user_code }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const { body: tokenBody } = await fetchJson(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: clientId,
      device_code: device.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  return (tokenBody as { access_token: string }).access_token;
}

function createConnector(): { cleanup: () => void; connectorPath: string } {
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-runtime-systemic-journey-"));
  const connectorPath = join(tmpDir, "connector.mjs");
  writeFileSync(
    connectorPath,
    `
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'items', key: 'r1', data: { id: 'r1', value: 'ok' }, emitted_at: '2026-08-13T00:00:00.000Z' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'items', cursor: { cursor: 'must_not_commit' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 1 }) + '\\n');
  rl.close();
});
`,
    "utf8"
  );
  return { cleanup: () => rmSync(tmpDir, { force: true, recursive: true }), connectorPath };
}

test("runtime journey: non-ok systemic ingest fails the run and does not commit cursor state", async () => {
  const server = (await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 })) as ClosableServer;
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const connectorId = "runtime-systemic-journey";
  const runId = "run_runtime_systemic_journey";
  await registerManifest(asUrl, manifest(connectorId));
  const ownerToken = await issueOwnerToken(asUrl);
  const admitted = await admitOwnerRunConnection({
    connectorId,
    connectorInstanceId: null,
    connectorInstanceStore: createRequestConnectorInstanceStore(),
    ownerSubjectId: "owner_local",
  });
  const connector = createConnector();
  __setIngestFaultHookForTest((point: string) => {
    if (point === "after-version-allocation") {
      throw new Error("internal driver path /tmp/private/socket failed");
    }
  });

  try {
    await assert.rejects(
      () =>
        runConnector({
          admitRunConnection: async () => ({
            connectorId,
            connectorInstanceId: admitted.connectorInstanceId,
            ownerSubjectId: "owner_local",
          }),
          collectionMode: "full_refresh",
          connectorId,
          connectorInstanceId: admitted.connectorInstanceId,
          connectorPath: connector.connectorPath,
          manifest: runtimeManifest(connectorId),
          onInteraction: async () => ({}),
          ownerToken,
          persistState: true,
          rsUrl,
          runId,
          scope: { streams: [{ name: "items" }] },
          state: null,
        }),
      (err: unknown) => {
        assert.match(String((err as { message?: unknown }).message ?? ""), SYSTEMIC_PUBLIC_RE);
        return true;
      }
    );

    const runRow = getDb()
      .prepare("SELECT status FROM run_history WHERE run_id = ? AND connector_instance_id = ?")
      .get(runId, admitted.connectorInstanceId) as { status?: string } | undefined;
    assert.equal(runRow?.status, "failed");

    const state = (await loadSyncState(connectorId, ownerToken, { rsUrl })) as { items?: { cursor?: string } } | null;
    assert.notEqual(state?.items?.cursor, "must_not_commit");
  } finally {
    __setIngestFaultHookForTest(null);
    connector.cleanup();
    await closeServer(server);
  }
});
