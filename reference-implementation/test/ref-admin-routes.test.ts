// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Route regression tests for the `_ref/approvals`, `_ref/records/timeline`,
 * `_ref/schedules`, `_ref/deployment`, `_ref/clients`, and `_ref/search`
 * route family.
 *
 * Exercises the routes at the HTTP level to catch wiring regressions that
 * operation-level and auth-gate tests cannot reach. Server runs in open mode
 * (no owner password) so auth does not mask routing errors. Each test verifies
 * the response status code and the top-level `object` discriminator (or key
 * set) in the envelope.
 *
 * Extracted to `server/routes/ref-admin.ts` per
 * `split-reference-server-by-route-family` §2.5. Mirrors the structure of
 * `test/ref-dataset-routes.test.js`.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { RefApprovalsListEnvelope } from "../operations/ref-approvals-list/index.ts";
import type { RefClientsListEnvelope } from "../operations/ref-clients-list/index.ts";
import type { RefDeploymentReport } from "../operations/ref-deployment/index.ts";
import type { RefRecordsTimelineEnvelope } from "../operations/ref-records-timeline/index.ts";
import type { RefSchedulesListEnvelope } from "../operations/ref-schedules-list/index.ts";
import type { RefSpineSearchEnvelope } from "../operations/ref-spine-search/index.ts";
import { startServer } from "../server/index.ts";

// `startServer` is still `.js` (allowJs, no exported types), so its return
// shape is described locally from what `startServer` actually returns (see
// `server/index.js`'s final `return { asServer, rsServer, asPort, rsPort,
// ... }` object) and what this suite actually calls on it.
//
// `closeAllConnections` is deliberately NOT part of this interface: at
// runtime `asServer`/`rsServer` are plain `http.Server` instances (which do
// have it), but the type TS infers for `startServer`'s return across the
// `.js` boundary resolves `asApp.listen(...)` to an `Http2SecureServer`
// overload that structurally lacks that method. Declaring it here would
// make `RefTestServer` incompatible with the real inferred return type, so
// closing all connections is done via a runtime `typeof` guard below
// instead of a static type member.
interface CloseableServer {
  close: (callback: (err?: Error) => void) => void;
}

interface RefTestServer {
  readonly asPort: number;
  readonly asServer: CloseableServer;
  readonly rsServer: CloseableServer;
}

function closeAllConnectionsIfSupported(server: CloseableServer): void {
  if ("closeAllConnections" in server && typeof server.closeAllConnections === "function") {
    server.closeAllConnections();
  }
}

// Envelope shapes below mirror the `error` envelope built by `pdppError` in
// `server/index.js` (`{ error: { type, code, message, ... } }`).
interface RefErrorEnvelope {
  readonly error: {
    readonly code: string;
  };
}

async function closeServer(server: RefTestServer): Promise<void> {
  closeAllConnectionsIfSupported(server.asServer);
  closeAllConnectionsIfSupported(server.rsServer);
  await Promise.allSettled([
    new Promise((resolve) => server.asServer.close(resolve)),
    new Promise((resolve) => server.rsServer.close(resolve)),
  ]);
}

async function withServer(fn: (ctx: { asUrl: string }) => Promise<void>): Promise<void> {
  const server: RefTestServer = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  try {
    await fn({ asUrl });
  } finally {
    await closeServer(server);
  }
}

test("GET /_ref/approvals returns list envelope", async () => {
  await withServer(async ({ asUrl }: { asUrl: string }) => {
    const resp = await fetch(`${asUrl}/_ref/approvals`);
    assert.equal(resp.status, 200);
    const body = (await resp.json()) as RefApprovalsListEnvelope;
    assert.equal(body.object, "list");
    assert.ok(Array.isArray(body.data));
  });
});

test("GET /_ref/records/timeline returns list envelope", async () => {
  await withServer(async ({ asUrl }: { asUrl: string }) => {
    const resp = await fetch(`${asUrl}/_ref/records/timeline`);
    assert.equal(resp.status, 200);
    const body = (await resp.json()) as RefRecordsTimelineEnvelope;
    assert.equal(body.object, "list");
    assert.ok(Array.isArray(body.data));
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
    assert.ok(body.meta !== undefined);
  });
});

test("GET /_ref/schedules returns list envelope", async () => {
  await withServer(async ({ asUrl }: { asUrl: string }) => {
    const resp = await fetch(`${asUrl}/_ref/schedules`);
    assert.equal(resp.status, 200);
    const body = (await resp.json()) as RefSchedulesListEnvelope;
    assert.equal(body.object, "list");
    assert.ok(Array.isArray(body.data));
  });
});

test("GET /_ref/deployment returns deployment report", async () => {
  await withServer(async ({ asUrl }: { asUrl: string }) => {
    const resp = await fetch(`${asUrl}/_ref/deployment`);
    assert.equal(resp.status, 200);
    const body = (await resp.json()) as RefDeploymentReport;
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
    assert.ok(body !== null && typeof body === "object");
    assert.ok("database" in body, "deployment report should include database key");
    assert.ok("environment" in body, "deployment report should include environment key");
  });
});

test("GET /_ref/clients without ?owner=true returns 400 invalid_request", async () => {
  await withServer(async ({ asUrl }: { asUrl: string }) => {
    const resp = await fetch(`${asUrl}/_ref/clients`);
    assert.equal(resp.status, 400);
    const body = (await resp.json()) as RefErrorEnvelope;
    assert.equal(body.error.code, "invalid_request");
  });
});

test("GET /_ref/clients?owner=true returns list envelope", async () => {
  await withServer(async ({ asUrl }: { asUrl: string }) => {
    const resp = await fetch(`${asUrl}/_ref/clients?owner=true`);
    assert.equal(resp.status, 200);
    const body = (await resp.json()) as RefClientsListEnvelope;
    assert.equal(body.object, "list");
    assert.ok(Array.isArray(body.data));
  });
});

test("GET /_ref/search returns search_result envelope", async () => {
  await withServer(async ({ asUrl }: { asUrl: string }) => {
    const resp = await fetch(`${asUrl}/_ref/search?q=test`);
    assert.equal(resp.status, 200);
    const body = (await resp.json()) as RefSpineSearchEnvelope;
    assert.equal(body.object, "search_result");
    assert.ok("traces" in body);
    assert.ok("grants" in body);
    assert.ok("runs" in body);
  });
});
