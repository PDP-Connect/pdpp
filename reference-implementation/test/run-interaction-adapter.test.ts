// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Focused adapter-level tests for server/routes/run-interaction.ts.
 *
 * These tests mount the adapter into a fake Express-like app and exercise the
 * route logic directly with synthetic req/res/ctx objects. They do NOT start a
 * real server, spawn a connector, or trigger a run, so they are immune to the
 * pre-existing run-start regression that causes run-interaction-control.test.js
 * to fail on both main and this branch.
 *
 * Coverage:
 *   mountRefRunInteraction:
 *     - no controller → 404 not_found
 *     - missing interaction_id → 400 invalid_request
 *     - whitespace-only interaction_id → 400 invalid_request
 *     - invalid status value → 400 invalid_status
 *     - data is array (not plain object) → 400 invalid_request
 *     - URL-encoded runId decoded correctly before forwarding
 *     - success (status='success', data present) → 202 ack envelope
 *     - success (status='cancelled', no data) → 202 ack envelope
 *     - controller throws → handleError called
 *
 *   mountRefDevPlaygroundSession:
 *     - success with backend from query string → 200 session envelope
 *     - success with backend+streamDebug from body → 200 session envelope
 *     - playground throws → 500 playground_failed
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  type MountRefDevPlaygroundSessionContext,
  type MountRefRunInteractionContext,
  mountRefDevPlaygroundSession,
  mountRefRunInteraction,
} from "../server/routes/run-interaction.ts";

const BACKEND_UNREACHABLE = /backend unreachable/;
const CONTROLLER_EXPLODED = /controller exploded/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FakeRequest {
  body?: unknown;
  params: Record<string, string>;
  query?: Record<string, unknown>;
}

interface FakeResponseBody {
  error?: { code: string; message: string | undefined; param?: string };
  [key: string]: unknown;
}

interface FakeResponse {
  _body: FakeResponseBody | null;
  _status: number;
  json: (body: FakeResponseBody) => FakeResponse;
  status: (code: number) => FakeResponse;
}

type RouteHandler = (req: FakeRequest, res: FakeResponse) => unknown | Promise<unknown>;

interface FakeApp {
  post: (path: string, ...args: unknown[]) => FakeApp;
  routes: Record<string, RouteHandler>;
}

function makeApp(): FakeApp {
  const routes: Record<string, RouteHandler> = {};
  const app: FakeApp = {
    post(path, ...args) {
      const handler = args.findLast((a): a is RouteHandler => typeof a === "function");
      routes[`POST ${path}`] = handler as RouteHandler;
      return app;
    },
    routes,
  };
  return app;
}

function routeHandler(app: FakeApp, route: string): RouteHandler {
  const handler = app.routes[route];
  assert.ok(handler, `expected a registered handler for ${route}`);
  return handler;
}

function bodyError(res: FakeResponse): { code: string; message: string | undefined; param?: string } {
  assert.ok(res._body, "expected a response body");
  assert.ok(res._body.error, "expected a response body error");
  return res._body.error;
}

function makeRes(): FakeResponse {
  const res: FakeResponse = {
    _body: null,
    _status: 200,
    json(body) {
      res._body = body;
      return res;
    },
    status(code) {
      res._status = code;
      return res;
    },
  };
  return res;
}

function makeInteractionCtx(overrides: Partial<MountRefRunInteractionContext> = {}): MountRefRunInteractionContext {
  return {
    controller: {
      respondToInteraction: (_runId: string, input) => ({ status: input.status }),
    },
    handleError: (_res: unknown, err: unknown) => {
      throw err;
    },
    pdppError: (res, status, code, message, param) => {
      (res as FakeResponse).status(status).json({ error: { code, message, ...(param ? { param } : {}) } });
    },
    requireOwnerSession: () => {
      // no-op
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// mountRefRunInteraction — boundary cases
// ---------------------------------------------------------------------------

const INTERACTION_ROUTE = "POST /_ref/runs/:runId/interaction";
const PLAYGROUND_ROUTE = "POST /_ref/dev/playground/session";

test("run-interaction adapter: no controller → 404 not_found", async () => {
  const app = makeApp();
  const ctx = makeInteractionCtx({ controller: null });
  mountRefRunInteraction(app, ctx);
  const handler = routeHandler(app, INTERACTION_ROUTE);
  const res = makeRes();
  await handler({ body: { interaction_id: "int_1", status: "success" }, params: { runId: "run_abc" } }, res);
  assert.equal(res._status, 404);
  assert.equal(bodyError(res).code, "not_found");
});

test("run-interaction adapter: undefined controller → 404 not_found", async () => {
  const app = makeApp();
  const ctx = makeInteractionCtx({ controller: undefined });
  mountRefRunInteraction(app, ctx);
  const handler = routeHandler(app, INTERACTION_ROUTE);
  const res = makeRes();
  await handler({ body: { interaction_id: "int_1", status: "success" }, params: { runId: "run_abc" } }, res);
  assert.equal(res._status, 404);
  assert.equal(bodyError(res).code, "not_found");
});

test("run-interaction adapter: missing interaction_id → 400 invalid_request", async () => {
  const app = makeApp();
  const ctx = makeInteractionCtx();
  mountRefRunInteraction(app, ctx);
  const handler = routeHandler(app, INTERACTION_ROUTE);
  const res = makeRes();
  await handler({ body: { status: "success" }, params: { runId: "run_abc" } }, res);
  assert.equal(res._status, 400);
  assert.equal(bodyError(res).code, "invalid_request");
  assert.equal(bodyError(res).param, "interaction_id");
});

test("run-interaction adapter: whitespace-only interaction_id → 400 invalid_request", async () => {
  const app = makeApp();
  const ctx = makeInteractionCtx();
  mountRefRunInteraction(app, ctx);
  const handler = routeHandler(app, INTERACTION_ROUTE);
  const res = makeRes();
  await handler({ body: { interaction_id: "   ", status: "success" }, params: { runId: "run_abc" } }, res);
  assert.equal(res._status, 400);
  assert.equal(bodyError(res).code, "invalid_request");
});

test("run-interaction adapter: invalid status → 400 invalid_status", async () => {
  const app = makeApp();
  const ctx = makeInteractionCtx();
  mountRefRunInteraction(app, ctx);
  const handler = routeHandler(app, INTERACTION_ROUTE);
  const res = makeRes();
  await handler({ body: { interaction_id: "int_1", status: "nope" }, params: { runId: "run_abc" } }, res);
  assert.equal(res._status, 400);
  assert.equal(bodyError(res).code, "invalid_status");
  assert.equal(bodyError(res).param, "status");
});

test("run-interaction adapter: data is array → 400 invalid_request", async () => {
  const app = makeApp();
  const ctx = makeInteractionCtx();
  mountRefRunInteraction(app, ctx);
  const handler = routeHandler(app, INTERACTION_ROUTE);
  const res = makeRes();
  await handler(
    { body: { data: [1, 2], interaction_id: "int_1", status: "success" }, params: { runId: "run_abc" } },
    res
  );
  assert.equal(res._status, 400);
  assert.equal(bodyError(res).code, "invalid_request");
  assert.equal(bodyError(res).param, "data");
});

test("run-interaction adapter: success with status=success delivers 202 ack", async () => {
  const calls: { input: { data?: unknown; interaction_id: string }; runId: string }[] = [];
  const app = makeApp();
  const ctx = makeInteractionCtx({
    controller: {
      respondToInteraction: (runId: string, input) => {
        calls.push({ input, runId });
        return { status: input.status };
      },
    },
  });
  mountRefRunInteraction(app, ctx);
  const handler = routeHandler(app, INTERACTION_ROUTE);
  const res = makeRes();
  await handler(
    {
      body: { data: { username: "alice" }, interaction_id: "int_1", status: "success" },
      params: { runId: "run_abc" },
    },
    res
  );
  assert.equal(res._status, 202);
  assert.equal(res._body?.object, "run_interaction_ack");
  assert.equal(res._body?.run_id, "run_abc");
  assert.equal(res._body?.interaction_id, "int_1");
  assert.equal(res._body?.status, "success");
  assert.equal(calls.length, 1);
  const [firstCall] = calls;
  assert.ok(firstCall);
  assert.equal(firstCall.runId, "run_abc");
  assert.equal(firstCall.input.interaction_id, "int_1");
  assert.deepEqual(firstCall.input.data, { username: "alice" });
});

test("run-interaction adapter: success with status=cancelled delivers 202 ack", async () => {
  const app = makeApp();
  const ctx = makeInteractionCtx();
  mountRefRunInteraction(app, ctx);
  const handler = routeHandler(app, INTERACTION_ROUTE);
  const res = makeRes();
  await handler({ body: { interaction_id: "int_2", status: "cancelled" }, params: { runId: "run_xyz" } }, res);
  assert.equal(res._status, 202);
  assert.equal(res._body?.status, "cancelled");
  assert.equal(res._body?.run_id, "run_xyz");
});

test("run-interaction adapter: URL-encoded runId is decoded before forwarding to controller", async () => {
  const calls: string[] = [];
  const app = makeApp();
  const ctx = makeInteractionCtx({
    controller: {
      respondToInteraction: (runId: string, input) => {
        calls.push(runId);
        return { status: input.status };
      },
    },
  });
  mountRefRunInteraction(app, ctx);
  const handler = routeHandler(app, INTERACTION_ROUTE);
  const res = makeRes();
  await handler(
    { body: { interaction_id: "int_1", status: "success" }, params: { runId: "run%2Fwith%2Fslashes" } },
    res
  );
  assert.equal(res._status, 202);
  assert.equal(calls[0], "run/with/slashes");
});

test("run-interaction adapter: controller throws → handleError called", async () => {
  const errorsHandled: unknown[] = [];
  const app = makeApp();
  const ctx = makeInteractionCtx({
    controller: {
      respondToInteraction: (): { status: string } => {
        throw new Error("controller exploded");
      },
    },
    handleError: (_res: unknown, err: unknown) => {
      errorsHandled.push(err);
    },
  });
  mountRefRunInteraction(app, ctx);
  const handler = routeHandler(app, INTERACTION_ROUTE);
  const res = makeRes();
  await handler({ body: { interaction_id: "int_1", status: "success" }, params: { runId: "run_abc" } }, res);
  assert.equal(errorsHandled.length, 1);
  const [firstError] = errorsHandled;
  assert.ok(firstError instanceof Error);
  assert.match(firstError.message, CONTROLLER_EXPLODED);
});

test("run-interaction adapter: null body treated as empty object", async () => {
  const app = makeApp();
  const ctx = makeInteractionCtx();
  mountRefRunInteraction(app, ctx);
  const handler = routeHandler(app, INTERACTION_ROUTE);
  const res = makeRes();
  await handler({ body: null, params: { runId: "run_abc" } }, res);
  // null body → empty object → missing interaction_id → 400
  assert.equal(res._status, 400);
  assert.equal(bodyError(res).code, "invalid_request");
});

// ---------------------------------------------------------------------------
// mountRefDevPlaygroundSession — boundary cases
// ---------------------------------------------------------------------------

function makePlaygroundCtx(
  overrides: Partial<MountRefDevPlaygroundSessionContext> = {}
): MountRefDevPlaygroundSessionContext {
  return {
    logger: null,
    pdppError: (res, status, code, message) => {
      (res as FakeResponse).status(status).json({ error: { code, message } });
    },
    playground: {
      getOrCreatePlaygroundSession: async ({ backend, streamDebug }) => ({
        backend: backend ?? "default",
        interactionId: "int_playground_1",
        runId: "run_playground_1",
        streamDebug,
      }),
    },
    requireOwnerSession: () => {
      // no-op
    },
    ...overrides,
  };
}

test("playground adapter: success with backend from query → 200 session envelope", async () => {
  const app = makeApp();
  const ctx = makePlaygroundCtx();
  mountRefDevPlaygroundSession(app, ctx);
  const handler = routeHandler(app, PLAYGROUND_ROUTE);
  const res = makeRes();
  await handler({ body: null, params: {}, query: { backend: "neko" } }, res);
  assert.equal(res._status, 200);
  assert.equal(res._body?.object, "stream_playground_session");
  assert.equal(res._body?.backend, "neko");
  assert.equal(res._body?.run_id, "run_playground_1");
  assert.equal(res._body?.interaction_id, "int_playground_1");
});

test("playground adapter: success with backend from body when no query backend → 200", async () => {
  const app = makeApp();
  const ctx = makePlaygroundCtx();
  mountRefDevPlaygroundSession(app, ctx);
  const handler = routeHandler(app, PLAYGROUND_ROUTE);
  const res = makeRes();
  await handler({ body: { backend: "cdp" }, params: {}, query: {} }, res);
  assert.equal(res._status, 200);
  assert.equal(res._body?.backend, "cdp");
});

test("playground adapter: stream_debug forwarded from query", async () => {
  const calls: { backend?: string | undefined; streamDebug?: string | undefined }[] = [];
  const app = makeApp();
  const ctx = makePlaygroundCtx({
    playground: {
      getOrCreatePlaygroundSession: (opts) => {
        calls.push(opts);
        return Promise.resolve({ backend: "neko", interactionId: "i1", runId: "r1" });
      },
    },
  });
  mountRefDevPlaygroundSession(app, ctx);
  const handler = routeHandler(app, PLAYGROUND_ROUTE);
  const res = makeRes();
  await handler({ body: null, params: {}, query: { stream_debug: "verbose" } }, res);
  assert.equal(calls[0]?.streamDebug, "verbose");
  assert.equal(res._status, 200);
});

test("playground adapter: playground throws → 500 playground_failed", async () => {
  const app = makeApp();
  const ctx = makePlaygroundCtx({
    playground: {
      getOrCreatePlaygroundSession: (): Promise<never> => Promise.reject(new Error("backend unreachable")),
    },
  });
  mountRefDevPlaygroundSession(app, ctx);
  const handler = routeHandler(app, PLAYGROUND_ROUTE);
  const res = makeRes();
  await handler({ body: null, params: {}, query: {} }, res);
  assert.equal(res._status, 500);
  assert.equal(bodyError(res).code, "playground_failed");
  const { message } = bodyError(res);
  assert.ok(message);
  assert.match(message, BACKEND_UNREACHABLE);
});
