// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Route-level integration test for the operator `_ref/event-subscriptions`
 * routes. Stands up a real server with owner auth enabled and asserts that
 * the three routes require a valid owner session and refuse to disclose
 * subscription existence to an unauthenticated caller.
 *
 * The functional projection / disable behaviors are covered by the
 * operation-level test in `ref-client-event-subscriptions-operations.test.js`;
 * this file is the host-adapter contract only.
 *
 * Spec: openspec/changes/add-client-event-subscription-management/specs/
 *       reference-implementation-architecture/spec.md
 */

import assert from "node:assert/strict";
import test from "node:test";

import { startServer as startServerUntyped } from "../server/index.ts";

const TEST_PASSWORD = "ref-event-subscriptions-owner-test-password";

/**
 * `server/index.js` is still plain JS (not migrated) and exports no types.
 * TypeScript's `allowJs`-without-`checkJs` inference on `startServer`'s
 * default-valued `opts = {}` parameter collapses to `{}`, and its returned
 * `asServer`/`rsServer` infer as `Http2SecureServer` (missing
 * `closeAllConnections`) — both are inference artifacts of the untyped
 * source, not the real runtime shape. These local interfaces describe the
 * actual shape this test drives, read directly from `server/index.js`
 * (`startServer(opts)` options destructured near the top of the function;
 * the returned `{ asServer, rsServer, asPort, rsPort, ... }` object and its
 * `asServer.closeAllConnections()` / `asServer.close(cb)` usage near the
 * bottom).
 */
interface RefEventSubscriptionsServerOptions {
  readonly asPort?: number;
  readonly dbPath?: string;
  readonly ownerAuthPassword?: string;
  readonly quiet?: boolean;
  readonly rsPort?: number;
}

interface RefEventSubscriptionsHttpServer {
  close: (callback: (err?: Error) => void) => void;
  closeAllConnections: () => void;
}

interface RefEventSubscriptionsServer {
  readonly asPort: number;
  readonly asServer: RefEventSubscriptionsHttpServer;
  readonly rsPort: number;
  readonly rsServer: RefEventSubscriptionsHttpServer;
}

/**
 * Narrows an unknown value to `RefEventSubscriptionsHttpServer` by checking
 * for the two methods this test actually calls. `server.asServer`/
 * `server.rsServer` are real `http.Server` instances (see
 * `asApp.listen(...)` / `rsApp.listen(...)` in `server/index.js`); TS's
 * allowJs-without-checkJs inference on that untyped source collapses them to
 * `Http2SecureServer`, which structurally has too little overlap with this
 * interface for a direct `as` cast (`server/index.js` is forbidden territory
 * so the inference gap can't be closed at the source). A runtime guard
 * avoids asserting past the type system entirely.
 */
function isHttpServerLike(value: unknown): value is RefEventSubscriptionsHttpServer {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { closeAllConnections?: unknown }).closeAllConnections === "function" &&
    typeof (value as { close?: unknown }).close === "function"
  );
}

function assertHttpServerLike(value: unknown, label: string): RefEventSubscriptionsHttpServer {
  assert.ok(isHttpServerLike(value), `${label} does not expose the expected server shape`);
  return value;
}

async function startServer(opts: RefEventSubscriptionsServerOptions): Promise<RefEventSubscriptionsServer> {
  const server = await startServerUntyped(opts);
  return {
    asPort: server.asPort,
    asServer: assertHttpServerLike(server.asServer, "asServer"),
    rsPort: server.rsPort,
    rsServer: assertHttpServerLike(server.rsServer, "rsServer"),
  };
}

async function closeServer(server: RefEventSubscriptionsServer): Promise<void> {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise<void>((resolve) => server.asServer.close(() => resolve())),
    new Promise<void>((resolve) => server.rsServer.close(() => resolve())),
  ]);
}

interface ServerFixture {
  readonly asUrl: string;
}

async function withServer(
  opts: RefEventSubscriptionsServerOptions,
  fn: (fixture: ServerFixture) => Promise<void>
): Promise<void> {
  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    quiet: true,
    rsPort: 0,
    ...opts,
  });
  try {
    await fn({ asUrl: `http://localhost:${server.asPort}` });
  } finally {
    await closeServer(server);
  }
}

test("_ref/event-subscriptions* routes require an owner session", async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const list = await fetch(`${asUrl}/_ref/event-subscriptions`, {
      headers: { Accept: "application/json" },
      redirect: "manual",
    });
    assert.equal(list.status, 401);

    const get = await fetch(`${asUrl}/_ref/event-subscriptions/sub_does_not_exist`, {
      headers: { Accept: "application/json" },
      redirect: "manual",
    });
    // Spec scenario "A request without an owner session is rejected":
    // SHALL respond 401 and SHALL NOT disclose whether the subscription exists.
    assert.equal(get.status, 401);

    const disable = await fetch(`${asUrl}/_ref/event-subscriptions/sub_does_not_exist/disable`, {
      body: JSON.stringify({ reason: "unit_test" }),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      method: "POST",
      redirect: "manual",
    });
    assert.equal(disable.status, 401);
  });
});

test("_ref/event-subscriptions* routes return JSON shape when owner auth is disabled (no session needed)", async () => {
  // When ownerAuthPassword is the empty string the requireOwnerSession
  // middleware is a no-op (this mirrors the dev-bootstrap configuration); the
  // routes should succeed without a session and return the expected envelope
  // shape. This confirms the host-adapter wiring at least reaches the
  // operation layer. We pass `''` explicitly so the test does not inherit
  // PDPP_OWNER_PASSWORD from the ambient environment — see other tests in
  // this folder (ref-read-owner-gate, provider-metadata, hosted-mcp-oauth)
  // for the same idiom.
  await withServer({ ownerAuthPassword: "" }, async ({ asUrl }) => {
    const list = await fetch(`${asUrl}/_ref/event-subscriptions`, {
      headers: { Accept: "application/json" },
    });
    assert.equal(list.status, 200);
    // Route response body: this test only asserts the host-adapter envelope
    // shape (`{ object: 'list', data: [] }`), not the full projected item
    // shape from `RefClientEventSubscriptionsListEnvelope` — a local
    // interface keeps that assertion honest without importing operation
    // internals the route boundary doesn't guarantee verbatim.
    interface ListEnvelopeBody {
      readonly data: readonly unknown[];
      readonly object: string;
    }
    const body = (await list.json()) as ListEnvelopeBody;
    assert.equal(body.object, "list");
    assert.equal(Array.isArray(body.data), true);

    const get = await fetch(`${asUrl}/_ref/event-subscriptions/sub_does_not_exist`, {
      headers: { Accept: "application/json" },
    });
    assert.equal(get.status, 404);

    const disable = await fetch(`${asUrl}/_ref/event-subscriptions/sub_does_not_exist/disable`, {
      body: JSON.stringify({}),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(disable.status, 404);
  });
});
