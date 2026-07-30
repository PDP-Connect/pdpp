// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Focused adapter-level tests for server/routes/run-cancel.ts.
 *
 * These tests mount the adapter into a fake Express-like app and exercise the
 * route logic directly with synthetic req/res/ctx objects. They do NOT start a
 * real server, spawn a connector, or trigger a run, so they are immune to the
 * pre-existing run-start regression that fails run-interaction-control.test.js
 * on both main and this branch. (The end-to-end cooperative-cancel path is
 * proven against a real child process in runtime-cancel-run.test.js, and the
 * controller primitive in controller-cancel-run.test.js.)
 *
 * Coverage — mountRefRunCancel (POST /_ref/runs/:runId/cancel):
 *   - the route is gated by requireOwnerSession (registered as middleware
 *     before the handler);
 *   - no controller → 404 not_found;
 *   - controller cancelRun → cancel_requested → 202 run_cancel_ack;
 *   - optional route-level cancelRun fallback can convert controller
 *     no_active_run into cancel_requested;
 *   - controller cancelRun → no_active_run → 404 no_active_run;
 *   - controller cancelRun → already_terminal → 409 run_already_terminal;
 *   - URL-encoded runId is decoded before forwarding to the controller;
 *   - controller throws → handleError called.
 *
 * Spec: openspec/changes/add-owner-run-cancellation-control (task 5.5).
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { MiddlewareHandler } from "../server/routes/_route-contract.ts";
import { type MountRefRunCancelContext, mountRefRunCancel, type RunCancelResult } from "../server/routes/run-cancel.ts";

const REGEXP_1 = /controller exploded/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FakeRequest {
  params: Record<string, string>;
}

interface FakeResponse {
  _body: { error?: { code: string; message: string | undefined; param?: string }; [key: string]: unknown } | null;
  _status: number;
  json: (body: FakeResponse["_body"]) => FakeResponse;
  status: (code: number) => FakeResponse;
}

type RouteHandler = (req: FakeRequest, res: FakeResponse) => unknown | Promise<unknown>;
type RunCancelApp = Parameters<typeof mountRefRunCancel>[0];

interface FakeApp extends RunCancelApp {
  middleware: Record<string, MiddlewareHandler[]>;
  routes: Record<string, RouteHandler>;
}

// Records middleware order per path so we can assert requireOwnerSession runs
// before the route handler.
function makeApp(): FakeApp {
  const routes: Record<string, RouteHandler> = {};
  const middleware: Record<string, MiddlewareHandler[]> = {};
  const app: FakeApp = {
    middleware,
    post(path, ...args) {
      const fns = args.filter((a) => typeof a === "function") as unknown as RouteHandler[];
      const middlewareFns = args.filter((a): a is MiddlewareHandler => typeof a === "function") as MiddlewareHandler[];
      routes[`POST ${path}`] = fns.at(-1) as RouteHandler;
      middleware[`POST ${path}`] = middlewareFns.slice(0, -1);
      return app;
    },
    routes,
  };
  return app;
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

function makeCtx(overrides: Partial<MountRefRunCancelContext> = {}): MountRefRunCancelContext {
  return {
    controller: {
      cancelRun: async (runId: string): Promise<RunCancelResult> => ({ run_id: runId, status: "cancel_requested" }),
    },
    handleError: (_res: unknown, err: unknown) => {
      throw err;
    },
    ownerSubjectId: "owner_local",
    pdppError: (res, status, code, message, param) => {
      (res as FakeResponse).status(status).json({ error: { code, message, ...(param ? { param } : {}) } });
    },
    requireOwnerSession: () => {
      /* intentionally empty */
    },
    ...overrides,
  };
}

const ROUTE = "POST /_ref/runs/:runId/cancel";

async function invokeRoute(app: FakeApp, req: FakeRequest, res: FakeResponse): Promise<void> {
  const handler = app.routes[ROUTE];
  assert.ok(handler, `expected a registered handler for ${ROUTE}`);
  await handler(req, res);
}

function routeMiddleware(app: FakeApp): MiddlewareHandler[] {
  const middleware = app.middleware[ROUTE];
  assert.ok(middleware, `expected registered middleware for ${ROUTE}`);
  return middleware;
}

function bodyError(res: FakeResponse): { code: string; message: string | undefined; param?: string } {
  assert.ok(res._body, "expected a response body");
  assert.ok(res._body.error, "expected a response body error");
  return res._body.error;
}

// ---------------------------------------------------------------------------
// Auth gating
// ---------------------------------------------------------------------------

test("run-cancel adapter: route is gated by requireOwnerSession before the handler", () => {
  const seen: string[] = [];
  const ownerGate = () => {
    seen.push("owner_session");
  };
  const app = makeApp();
  mountRefRunCancel(app, makeCtx({ requireOwnerSession: ownerGate }));
  // The owner-session middleware is registered on the route, ahead of the
  // handler — an unauthenticated request never reaches cancelRun because this
  // middleware rejects it first (its real implementation is exercised by the
  // server-level owner-auth suite).
  const middleware = routeMiddleware(app);
  assert.equal(middleware.length, 1, "exactly one middleware is registered");
  assert.equal(middleware[0], ownerGate, "requireOwnerSession is that middleware");
});

// ---------------------------------------------------------------------------
// Typed outcomes
// ---------------------------------------------------------------------------

test("run-cancel adapter: no controller → 404 not_found", async () => {
  const app = makeApp();
  mountRefRunCancel(app, makeCtx({ controller: null }));
  const res = makeRes();
  await invokeRoute(app, { params: { runId: "run_abc" } }, res);
  assert.equal(res._status, 404);
  assert.equal(bodyError(res).code, "not_found");
});

test("run-cancel adapter: cancel_requested → 202 run_cancel_ack", async () => {
  const calls: string[] = [];
  const app = makeApp();
  mountRefRunCancel(
    app,
    makeCtx({
      controller: {
        // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
        cancelRun: async (runId: string): Promise<RunCancelResult> => {
          calls.push(runId);
          return { run_id: runId, status: "cancel_requested" };
        },
      },
    })
  );
  const res = makeRes();
  await invokeRoute(app, { params: { runId: "run_abc" } }, res);
  assert.equal(res._status, 202);
  assert.equal(res._body?.object, "run_cancel_ack");
  assert.equal(res._body?.run_id, "run_abc");
  assert.equal(res._body?.status, "cancel_requested");
  assert.deepEqual(calls, ["run_abc"]);
});

test("run-cancel adapter: no_active_run → 404 no_active_run", async () => {
  const app = makeApp();
  mountRefRunCancel(
    app,
    makeCtx({
      controller: {
        cancelRun: async (runId: string): Promise<RunCancelResult> => ({ run_id: runId, status: "no_active_run" }),
      },
    })
  );
  const res = makeRes();
  await invokeRoute(app, { params: { runId: "run_missing" } }, res);
  assert.equal(res._status, 404);
  assert.equal(bodyError(res).code, "no_active_run");
  assert.equal(bodyError(res).param, "run_id");
});

test("run-cancel adapter: route-level fallback can cancel a scheduler-owned run", async () => {
  const calls: string[] = [];
  const app = makeApp();
  mountRefRunCancel(
    app,
    makeCtx({
      // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
      cancelRun: async (runId: string): Promise<RunCancelResult> => {
        calls.push(runId);
        return { run_id: runId, status: "cancel_requested" };
      },
      controller: {
        cancelRun: async (runId: string): Promise<RunCancelResult> => ({ run_id: runId, status: "no_active_run" }),
      },
    })
  );
  const res = makeRes();
  await invokeRoute(app, { params: { runId: "run_scheduler_direct" } }, res);
  assert.equal(res._status, 202);
  assert.equal(res._body?.object, "run_cancel_ack");
  assert.equal(res._body?.run_id, "run_scheduler_direct");
  assert.deepEqual(calls, ["run_scheduler_direct"]);
});

test("run-cancel adapter: already_terminal → 409 run_already_terminal", async () => {
  const app = makeApp();
  mountRefRunCancel(
    app,
    makeCtx({
      controller: {
        cancelRun: async (runId: string): Promise<RunCancelResult> => ({ run_id: runId, status: "already_terminal" }),
      },
    })
  );
  const res = makeRes();
  await invokeRoute(app, { params: { runId: "run_done" } }, res);
  assert.equal(res._status, 409);
  assert.equal(bodyError(res).code, "run_already_terminal");
  assert.equal(bodyError(res).param, "run_id");
});

test("run-cancel adapter: URL-encoded runId is decoded before forwarding to controller", async () => {
  const calls: string[] = [];
  const app = makeApp();
  mountRefRunCancel(
    app,
    makeCtx({
      controller: {
        // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
        cancelRun: async (runId: string): Promise<RunCancelResult> => {
          calls.push(runId);
          return { run_id: runId, status: "cancel_requested" };
        },
      },
    })
  );
  const res = makeRes();
  await invokeRoute(app, { params: { runId: "run%2Fwith%2Fslashes" } }, res);
  assert.equal(res._status, 202);
  assert.equal(calls[0], "run/with/slashes");
});

test("run-cancel adapter: controller throws → handleError called", async () => {
  const errorsHandled: unknown[] = [];
  const app = makeApp();
  mountRefRunCancel(
    app,
    makeCtx({
      controller: {
        // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
        cancelRun: async (): Promise<RunCancelResult> => {
          throw new Error("controller exploded");
        },
      },
      handleError: (_res: unknown, err: unknown) => {
        errorsHandled.push(err);
      },
    })
  );
  const res = makeRes();
  await invokeRoute(app, { params: { runId: "run_abc" } }, res);
  assert.equal(errorsHandled.length, 1);
  const [firstError] = errorsHandled;
  assert.ok(firstError instanceof Error);
  assert.match(firstError.message, REGEXP_1);
});
