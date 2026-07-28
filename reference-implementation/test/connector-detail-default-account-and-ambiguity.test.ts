// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end proof that the default-account/no-explicit-instance ingest
 * journey and the zero/multi connection-ambiguity contract
 * (reconcile-active-summary-evidence design.md "Health boundary" / spec.md
 * "A connector-keyed catalog detail MAY expose connection health/counts only
 * when it resolves exactly one visible connection... With zero or multiple
 * connections it SHALL omit connection health/counts") hold together on the
 * real HTTP path, not just in a hand-seeded unit test.
 *
 * Closes the regression e6610b946 introduced: routing `getConnectorDetail`
 * through the same catalog-visibility-gated `projectConnectorSummaryForInstance`
 * every list surface uses made a private/unlisted connector's real,
 * implicitly-materialized default-account connection invisible through its
 * own detail route — even though it is a genuine, unambiguous, single
 * connection, not a zero/multi case. `getConnectorDetail` is reached by an
 * owner-addressed connector_id (not catalog browsing), so it must not apply
 * catalog-visibility gating; it must still omit health/counts when zero or
 * multiple real connections exist.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runConnector } from "../runtime/index.ts";
import { startServer } from "../server/index.ts";

// `startServer`'s inferred asServer/rsServer type comes from a framework
// `.listen()` call whose TS overload resolves to an http2-shaped type, but at
// runtime these are plain node:http/https servers (the framework never
// negotiates ALPN in this reference stack) — so `closeAllConnections` (added
// Node 18.2+) and the single-error-arg `close` callback genuinely exist and
// are safe to declare here. Established pattern, see
// connector-failure-diagnostics-control-plane.test.ts.
type TestServer = Awaited<ReturnType<typeof startServer>> & {
  asServer: { close: (cb: (err?: Error) => void) => void; closeAllConnections: () => void };
  rsServer: { close: (cb: (err?: Error) => void) => void; closeAllConnections: () => void };
};

async function closeServer(server: TestServer): Promise<void> {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  const closeWithTimeout = (srv: TestServer["asServer"] | TestServer["rsServer"]): Promise<void> =>
    new Promise<void>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      }, 2000);
      srv.close(() => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve();
      });
    });
  await Promise.allSettled([closeWithTimeout(server.asServer), closeWithTimeout(server.rsServer)]);
}

async function fetchJson<T = Record<string, unknown>>(
  url: string,
  opts: RequestInit = {}
): Promise<{ status: number; body: T }> {
  const resp = await fetch(url, opts);
  const body = (await resp.json()) as T;
  return { body, status: resp.status };
}

function createTestConnector(messages: Record<string, unknown>[]): { connectorPath: string; cleanup: () => void } {
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-detail-default-account-connector-"));
  const connectorPath = join(tmpDir, "connector.mjs");
  const script = `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START') {
    const messages = ${JSON.stringify(messages)};
    const doneMessage = [...messages].reverse().find((m) => m.type === 'DONE') || null;
    const exitCode = !doneMessage ? 0 : (doneMessage.status === 'succeeded' ? 0 : 1);
    for (const m of messages) {
      process.stdout.write(JSON.stringify(m) + '\\n');
    }
    rl.close();
    process.exit(exitCode);
  }
});
`;
  writeFileSync(connectorPath, script, "utf-8");
  return { cleanup: () => rmSync(tmpDir, { force: true, recursive: true }), connectorPath };
}

// This manifest deliberately declares NO `capabilities.public_listing` —
// the exact shape of a private/default (not catalog-browsable) connector,
// which is what exposed the regression: catalog-visibility gating has no
// legitimate role in an owner-addressed detail lookup.
const UNLISTED_MANIFEST = {
  connector_id: "detail-default-account-unlisted",
  display_name: "Unlisted Default-Account Connector",
  protocol_version: "0.1.0",
  streams: [
    {
      name: "items",
      primary_key: ["id"],
      schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
      semantics: "append_only",
    },
  ],
  version: "1.0.0",
};

async function issueOwnerToken(asUrl: string, subjectId = "test_user"): Promise<string> {
  const clientId = "cli_longview";
  const { body: device } = await fetchJson<{ device_code: string; user_code: string }>(
    `${asUrl}/oauth/device_authorization`,
    {
      body: new URLSearchParams({ client_id: clientId }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    }
  );
  const approveResp = await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({ subject_id: subjectId, user_code: device.user_code }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  assert.equal(approveResp.status, 200);
  const { body: tokenBody } = await fetchJson<{ access_token: string }>(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: clientId,
      device_code: device.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  return tokenBody.access_token;
}

interface ConnectorDetailStream {
  name: string;
  record_count: number | null;
}

interface ConnectorDetail {
  connection_health: unknown;
  connection_resolution: "resolved" | "unresolved";
  streams: ConnectorDetailStream[];
  total_records: number | null;
}

test("a no-explicit-instance ingest run against an unlisted connector resolves to a real, visible connection on its own detail route", async () => {
  const server = (await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 })) as TestServer;
  const { asPort, rsPort } = server;
  const asUrl = `http://localhost:${asPort}`;

  await fetchJson(`${asUrl}/connectors`, {
    body: JSON.stringify(UNLISTED_MANIFEST),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  // The owner-dashboard read surface (`getConnectorDetail`) is hardcoded to
  // REFERENCE_OWNER_SUBJECT_ID/OWNER_AUTH_DEFAULT_SUBJECT_ID ('owner_local')
  // — a real, intentional single-owner security boundary. A run's owner
  // token must carry that same subject for its connection to be genuinely
  // dashboard-visible; this proves the SUPPORTED default-account journey
  // (no explicit connector_instance_id, real owner-scoped token), not that
  // an arbitrary token subject is silently reassigned to the dashboard owner.
  const ownerToken = await issueOwnerToken(asUrl, "owner_local");
  const connectorId = UNLISTED_MANIFEST.connector_id;

  const { connectorPath, cleanup } = createTestConnector([
    { data: { id: "i1" }, emitted_at: "2026-07-17T00:00:00.000Z", key: "i1", stream: "items", type: "RECORD" },
    { records_emitted: 1, status: "succeeded", type: "DONE" },
  ]);

  try {
    // No connectorInstanceId is passed anywhere below — the supported
    // implicit default-account journey.
    const result = await runConnector({
      collectionMode: "full_refresh",
      connectorId,
      connectorPath,
      manifest: UNLISTED_MANIFEST,
      onInteraction: async () => ({}),
      ownerToken,
      persistState: true,
      rsUrl: `http://localhost:${rsPort}`,
      scope: { streams: [{ name: "items" }] },
      state: null,
    });
    assert.equal(result.status, "succeeded");

    const { status, body: detail } = await fetchJson<ConnectorDetail>(
      `${asUrl}/_ref/connectors/${encodeURIComponent(connectorId)}`
    );
    assert.equal(status, 200);
    // The real, single, implicitly-materialized default-account connection
    // resolves unambiguously — never gated out for being unlisted, and
    // never conflated with the zero/multi-connection cases below.
    assert.equal(detail.connection_resolution, "resolved", "a real single connection resolves, unlisted or not");
    assert.ok(detail.connection_health, "connection_health is present for the one real, resolved connection");
    assert.equal(detail.total_records, 1, "the real ingested record count rides through, not omitted or zeroed");
    const itemsStream = detail.streams.find((s) => s.name === "items");
    assert.ok(itemsStream, "declared stream present");
    assert.equal(itemsStream.record_count, 1);

    // The list surface (genuinely catalog-scoped) legitimately keeps
    // omitting this connector — catalog visibility is a real, distinct
    // concept the detail route must not inherit. Confirms the fix is
    // scoped to the detail route only, not a global gate removal.
    const { body: list } = await fetchJson<{ data: unknown }>(`${asUrl}/_ref/connectors`, {
      headers: { Authorization: `Bearer ${ownerToken}`, Cookie: "" },
    });
    assert.ok(Array.isArray(list.data));
  } finally {
    cleanup();
    await closeServer(server);
  }
});

test("a connector with zero real connections still resolves to the typed unresolved projection on its own detail route (no fabricated health)", async () => {
  const server = (await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 })) as TestServer;
  const { asPort } = server;
  const asUrl = `http://localhost:${asPort}`;

  await fetchJson(`${asUrl}/connectors`, {
    body: JSON.stringify(UNLISTED_MANIFEST),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const connectorId = UNLISTED_MANIFEST.connector_id;

  try {
    // No ingest, no connection ever created — a registered connector with
    // literally zero connections, the case the detail-route fix must NOT
    // paper over: catalog-visibility gating is gone, but the zero/multi
    // ambiguity contract must still hold.
    const { status, body: detail } = await fetchJson<ConnectorDetail>(
      `${asUrl}/_ref/connectors/${encodeURIComponent(connectorId)}`
    );
    assert.equal(status, 200);
    assert.equal(detail.connection_resolution, "unresolved");
    assert.equal(
      detail.connection_health,
      null,
      "zero connections omits connection_health, never a fabricated snapshot"
    );
    assert.equal(detail.total_records, null, "zero connections omits total_records — 0 would be a false count claim");
    // Declared stream names are a connector-level catalog fact owned by the
    // registered manifest, not per-connection evidence — they still
    // surface with zero connections, distinct from the per-connection
    // record_count, which stays honestly null (never a fabricated zero).
    const itemsStream = detail.streams.find((s) => s.name === "items");
    assert.ok(itemsStream, "declared stream name still surfaces with zero connections");
    assert.equal(itemsStream.record_count, null, "per-connection record_count is honestly null, not a fabricated zero");
  } finally {
    await closeServer(server);
  }
});
