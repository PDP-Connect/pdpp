const TOP_LEVEL_REGEX_1 = /run_never_existed/;
const TOP_LEVEL_REGEX_2 = /spine exploded/;

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for server/routes/ref-run-status.ts — the owner-only run-handle
 * status route `GET /_ref/runs/:runId` added by
 * openspec/changes/surface-run-handle-resolvability.
 *
 * Adapter-level tests mount the route into a fake Express-like app (same
 * pattern as run-cancel-adapter.test.js). Terminal and started-only
 * resolution run against REAL spine fixtures: events are emitted into a
 * fresh SQLite db via `emitSpineEvent` and read back through the real
 * `getRunTerminalEvent` / `getRunStartedEvent` lookups from lib/spine.ts.
 *
 * Coverage:
 *   - route is gated by requireOwnerSession;
 *   - active run (controller flight state) → 200 status "active";
 *   - terminal run (spine fixture) → 200 terminal status with typed
 *     reason, bounded failure summary, started/completed timestamps;
 *   - terminal event wins over not-yet-finalized flight state;
 *   - started-without-terminal falls back to status "active";
 *   - unknown run id → typed `not_found` 404 envelope (never the
 *     transport default 404);
 *   - URL-encoded run ids are decoded before lookup.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { emitSpineEvent, getRunStartedEvent, getRunTerminalEvent, listSpineEventsPage } from "../lib/spine.ts";
import { closeDb, initDb } from "../server/db.ts";
import type { MountRefRunStatusContext, RunStatusBody } from "../server/routes/ref-run-status.ts";
import { mountRefRunStatus } from "../server/routes/ref-run-status.ts";
import { makeTemporaryDbPath } from "./helpers/temp-dir.ts";

const CONNECTOR_ID = "https://registry.pdpp.org/connectors/run-status-test";
const ROUTE = "GET /_ref/runs/:runId";

interface TestRequest {
  params: { runId: string };
}
type TestResponseBody = RunStatusBody & { error: { code: string; message: string; param?: string } };
interface TestResponse {
  _body: TestResponseBody;
  _status: number;
  json: (body: unknown) => TestResponse;
  status: (code: number) => TestResponse;
}
type TestHandler = (req: TestRequest, res: TestResponse) => unknown | Promise<unknown>;

function makeApp() {
  const routes: Record<string, TestHandler> = {};
  const middleware: Record<string, unknown[]> = {};
  const app = {
    get(path: string, ...args: unknown[]) {
      const fns = args.filter((a) => typeof a === "function");
      const handler = fns.at(-1);
      if (typeof handler !== "function") {
        throw new Error("route handler missing");
      }
      routes[`GET ${path}`] = handler as TestHandler;
      middleware[`GET ${path}`] = fns.slice(0, -1);
      return app;
    },
    middleware,
    routes,
  };
  return app;
}

function makeRes(): TestResponse {
  const res = {
    _body: {
      completed_at: null,
      connector_id: null,
      connector_instance_id: null,
      error: { code: "", message: "" },
      failure: null,
      links: { timeline: "" },
      object: "run_status",
      run_id: "",
      started_at: null,
      status: "active",
      terminal_reason: null,
      trace_id: null,
    } as TestResponseBody,
    _status: 200,
    json(body: unknown) {
      if (!body || typeof body !== "object") {
        throw new Error("expected response object");
      }
      res._body = body as TestResponseBody;
      return res;
    },
    status(code: number) {
      res._status = code;
      return res;
    },
  };
  return res;
}

function makeCtx(overrides: Partial<MountRefRunStatusContext> = {}): MountRefRunStatusContext {
  return {
    controller: { findActiveRunByRunId: () => null },
    getRunStartedEvent: () => null,
    getRunTerminalEvent: () => null,
    handleError: (_res: unknown, err: unknown) => {
      throw err;
    },
    pdppError: (res: unknown, status, code, message, param) => {
      if (res && typeof res === "object" && "status" in res && typeof res.status === "function") {
        const next = res.status(status);
        if (next && typeof next === "object" && "json" in next && typeof next.json === "function") {
          next.json({ error: { code, message, ...(param ? { param } : {}) } });
        }
      }
    },
    // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
    requireOwnerSession: () => {},
    ...overrides,
  };
}

// Real-spine ctx: terminal + started lookups hit the SQLite fixture db.
function makeSpineCtx(overrides: Partial<MountRefRunStatusContext> = {}): MountRefRunStatusContext {
  return makeCtx({
    getLatestRunEvent: async (runId) => {
      const page = await listSpineEventsPage("run", runId, { limit: 20 });
      const event = page.events.at(-1);
      if (!event) {
        return null;
      }
      const data =
        event.data && typeof event.data === "object" && !Array.isArray(event.data)
          ? (event.data as Readonly<Record<string, unknown>>)
          : null;
      return {
        actor_id: event.actor_id ?? null,
        data,
        event_type: event.event_type,
        occurred_at: event.occurred_at ?? null,
        status: event.status ?? null,
        trace_id: event.trace_id ?? null,
      };
    },
    getRunStartedEvent: (runId) => getRunStartedEvent(runId),
    getRunTerminalEvent: (runId) => getRunTerminalEvent(runId),
    ...overrides,
  });
}

function getRoute(app: ReturnType<typeof makeApp>, route: string): TestHandler {
  const handler = app.routes[route];
  assert.ok(handler, `expected route ${route}`);
  return handler;
}

function freshDb(t: { after: (callback: () => void) => void }): void {
  closeDb();
  initDb(makeTemporaryDbPath("pdpp-run-status-"));
  t.after(() => {
    closeDb();
  });
}

async function emitStarted(
  runId: string,
  {
    occurredAt = "2026-06-10T19:05:40.278Z",
    traceId = "trace_status_1",
  }: { occurredAt?: string; traceId?: string } = {}
): Promise<void> {
  await emitSpineEvent({
    actor_id: CONNECTOR_ID,
    actor_type: "runtime",
    data: {
      boot_epoch: "boot_1",
      controller_id: "ctrl_test",
      seq: 1,
      source: { id: CONNECTOR_ID, kind: "connector" },
    },
    event_type: "run.started",
    object_id: runId,
    object_type: "run",
    occurred_at: occurredAt,
    run_id: runId,
    status: "started",
    trace_id: traceId,
  });
}

async function emitFailed(
  runId: string,
  {
    occurredAt = "2026-06-10T19:05:40.730Z",
    traceId = "trace_status_1",
  }: { occurredAt?: string; traceId?: string } = {}
): Promise<void> {
  await emitSpineEvent({
    actor_id: CONNECTOR_ID,
    actor_type: "runtime",
    data: {
      connector_error_message: "could not open browser profile",
      failure_origin: "connector",
      reason: "connector_reported_failed",
      records_emitted: 0,
      source: { id: CONNECTOR_ID, kind: "connector" },
    },
    event_type: "run.failed",
    object_id: runId,
    object_type: "run",
    occurred_at: occurredAt,
    run_id: runId,
    status: "failed",
    trace_id: traceId,
  });
}

// ---------------------------------------------------------------------------
// Auth gating
// ---------------------------------------------------------------------------

test("run-status route: gated by requireOwnerSession before the handler", () => {
  // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
  const ownerGate = () => {};
  const app = makeApp();
  mountRefRunStatus(app, makeCtx({ requireOwnerSession: ownerGate }));
  const middleware = app.middleware[ROUTE];
  assert.ok(middleware);
  assert.equal(middleware.length, 1, "exactly one middleware is registered");
  assert.equal(middleware[0], ownerGate, "requireOwnerSession is that middleware");
});

// ---------------------------------------------------------------------------
// Active run (controller flight state)
// ---------------------------------------------------------------------------

test("run-status route: active run resolves with status active and identity fields", async () => {
  const app = makeApp();
  mountRefRunStatus(
    app,
    makeCtx({
      controller: {
        findActiveRunByRunId: (runId) =>
          runId === "run_active"
            ? {
                connector_id: CONNECTOR_ID,
                connector_instance_id: "cin_a",
                run_id: "run_active",
                started_at: "2026-06-10T19:05:40.000Z",
                trace_id: "trace_active",
              }
            : null,
      },
    })
  );
  const res = makeRes();
  await getRoute(app, ROUTE)({ params: { runId: "run_active" } }, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.object, "run_status");
  assert.equal(res._body.run_id, "run_active");
  assert.equal(res._body.status, "active");
  assert.equal(res._body.connector_id, CONNECTOR_ID);
  assert.equal(res._body.connector_instance_id, "cin_a");
  assert.equal(res._body.trace_id, "trace_active");
  assert.equal(res._body.started_at, "2026-06-10T19:05:40.000Z");
  assert.equal(res._body.completed_at, null);
  assert.equal(res._body.failure, null);
  assert.equal(res._body.links.timeline, "/_ref/runs/run_active/timeline");
});

// ---------------------------------------------------------------------------
// Terminal run (real spine fixture)
// ---------------------------------------------------------------------------

test("run-status route: terminal run resolves from the spine with typed failure summary", async (t) => {
  freshDb(t);
  await emitStarted("run_done");
  await emitFailed("run_done");

  const app = makeApp();
  mountRefRunStatus(app, makeSpineCtx());
  const res = makeRes();
  await getRoute(app, ROUTE)({ params: { runId: "run_done" } }, res);

  assert.equal(res._status, 200);
  assert.equal(res._body.object, "run_status");
  assert.equal(res._body.run_id, "run_done");
  assert.equal(res._body.status, "failed");
  assert.equal(res._body.terminal_reason, "connector_reported_failed");
  assert.equal(res._body.connector_id, CONNECTOR_ID);
  assert.equal(res._body.trace_id, "trace_status_1");
  assert.equal(res._body.started_at, "2026-06-10T19:05:40.278Z");
  assert.equal(res._body.completed_at, "2026-06-10T19:05:40.730Z");
  assert.deepEqual(res._body.failure, {
    connector_error_message: "could not open browser profile",
    message: null,
    origin: "connector",
    reason: "connector_reported_failed",
  });
  assert.equal(res._body.links.timeline, "/_ref/runs/run_done/timeline");
});

test("run-status route: completed run has no failure summary", async (t) => {
  freshDb(t);
  await emitStarted("run_ok");
  await emitSpineEvent({
    actor_id: CONNECTOR_ID,
    actor_type: "runtime",
    data: { records_emitted: 12, source: { id: CONNECTOR_ID, kind: "connector" } },
    event_type: "run.completed",
    object_id: "run_ok",
    object_type: "run",
    occurred_at: "2026-06-10T19:06:00.000Z",
    run_id: "run_ok",
    status: "succeeded",
    trace_id: "trace_status_1",
  });

  const app = makeApp();
  mountRefRunStatus(app, makeSpineCtx());
  const res = makeRes();
  await getRoute(app, ROUTE)({ params: { runId: "run_ok" } }, res);

  assert.equal(res._status, 200);
  assert.equal(res._body.status, "completed");
  assert.equal(res._body.terminal_reason, null);
  assert.equal(res._body.failure, null);
});

test("run-status route: terminal event wins over not-yet-finalized flight state", async (t) => {
  freshDb(t);
  await emitStarted("run_racing");
  await emitFailed("run_racing");

  const app = makeApp();
  mountRefRunStatus(
    app,
    makeSpineCtx({
      controller: {
        findActiveRunByRunId: () => ({
          connector_id: CONNECTOR_ID,
          connector_instance_id: "cin_a",
          run_id: "run_racing",
          started_at: "2026-06-10T19:05:40.000Z",
          trace_id: "trace_status_1",
        }),
      },
    })
  );
  const res = makeRes();
  await getRoute(app, ROUTE)({ params: { runId: "run_racing" } }, res);
  assert.equal(res._body.status, "failed", "durable terminal status wins over in-memory flight state");
});

// ---------------------------------------------------------------------------
// Started-without-terminal fallback
// ---------------------------------------------------------------------------

test("run-status route: started run with no terminal event and no flight state reads active", async (t) => {
  freshDb(t);
  await emitStarted("run_orphaned");

  const app = makeApp();
  mountRefRunStatus(app, makeSpineCtx());
  const res = makeRes();
  await getRoute(app, ROUTE)({ params: { runId: "run_orphaned" } }, res);

  assert.equal(res._status, 200);
  assert.equal(res._body.status, "active");
  assert.equal(res._body.connector_id, CONNECTOR_ID);
  assert.equal(res._body.started_at, "2026-06-10T19:05:40.278Z");
  assert.equal(res._body.completed_at, null);
});

test("run-status route: browser-surface-only failure resolves instead of dangling 404", async (t) => {
  freshDb(t);
  await emitSpineEvent({
    actor_id: "chase",
    actor_type: "runtime",
    data: {
      browser_surface: {
        browser_surface_lease_id: "lease_surface_failed",
        browser_surface_profile_key: "chase:cin_expired_setup",
        browser_surface_status: "surface_failed",
        browser_surface_wait_reason: "surface_unhealthy",
        pending_run_id: "run_surface_failed",
      },
      source: { id: "chase", kind: "connector" },
    },
    event_type: "run.browser_surface_failed",
    object_id: "run_surface_failed",
    object_type: "run",
    occurred_at: "2026-06-10T19:07:00.000Z",
    run_id: "run_surface_failed",
    source_id: "chase",
    source_kind: "connector",
    status: "surface_failed",
    trace_id: "trace_surface_failed",
  });

  const app = makeApp();
  mountRefRunStatus(app, makeSpineCtx());
  const res = makeRes();
  await getRoute(app, ROUTE)({ params: { runId: "run_surface_failed" } }, res);

  assert.equal(res._status, 200);
  assert.equal(res._body.object, "run_status");
  assert.equal(res._body.run_id, "run_surface_failed");
  assert.equal(res._body.status, "surface_failed");
  assert.equal(res._body.connector_id, "chase");
  assert.equal(res._body.connector_instance_id, "cin_expired_setup");
  assert.equal(res._body.completed_at, "2026-06-10T19:07:00.000Z");
  assert.equal(res._body.terminal_reason, "surface_unhealthy");
  assert.deepEqual(res._body.failure, {
    connector_error_message: null,
    message: null,
    origin: "browser_surface",
    reason: "surface_unhealthy",
  });
  assert.equal(res._body.links.timeline, "/_ref/runs/run_surface_failed/timeline");
});

// ---------------------------------------------------------------------------
// Unknown id → typed 404
// ---------------------------------------------------------------------------

test("run-status route: unknown run id gets the typed not_found envelope", async (t) => {
  freshDb(t);
  const app = makeApp();
  mountRefRunStatus(app, makeSpineCtx());
  const res = makeRes();
  await getRoute(app, ROUTE)({ params: { runId: "run_never_existed" } }, res);
  assert.equal(res._status, 404);
  assert.equal(res._body.error.code, "not_found");
  assert.equal(res._body.error.param, "run_id");
  assert.match(res._body.error.message, TOP_LEVEL_REGEX_1);
});

test("run-status route: no controller configured still resolves spine-known runs", async (t) => {
  freshDb(t);
  await emitStarted("run_no_controller");
  await emitFailed("run_no_controller");

  const app = makeApp();
  mountRefRunStatus(app, makeSpineCtx({ controller: null }));
  const res = makeRes();
  await getRoute(app, ROUTE)({ params: { runId: "run_no_controller" } }, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.status, "failed");
});

// ---------------------------------------------------------------------------
// URL decoding + error path
// ---------------------------------------------------------------------------

test("run-status route: URL-encoded runId is decoded before lookup", async () => {
  const seen: string[] = [];
  const app = makeApp();
  mountRefRunStatus(
    app,
    makeCtx({
      controller: {
        findActiveRunByRunId: (runId) => {
          seen.push(runId);
          return null;
        },
      },
    })
  );
  const res = makeRes();
  await getRoute(app, ROUTE)({ params: { runId: "run%2Fwith%2Fslashes" } }, res);
  assert.deepEqual(seen, ["run/with/slashes"]);
  assert.equal(res._status, 404, "decoded-but-unknown id still gets the typed 404");
});

test("run-status route: lookup throws → handleError called", async () => {
  const errorsHandled: unknown[] = [];
  const app = makeApp();
  mountRefRunStatus(
    app,
    makeCtx({
      getRunTerminalEvent: () => {
        throw new Error("spine exploded");
      },
      handleError: (_res, err) => {
        errorsHandled.push(err);
      },
    })
  );
  const res = makeRes();
  await getRoute(app, ROUTE)({ params: { runId: "run_abc" } }, res);
  assert.equal(errorsHandled.length, 1);
  // biome-ignore lint/style/useDestructuring: index access documents the asserted ordered position
  const handledError = errorsHandled[0];
  assert.ok(handledError instanceof Error);
  assert.match(handledError.message, TOP_LEVEL_REGEX_2);
});
