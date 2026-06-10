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
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { emitSpineEvent, getRunStartedEvent, getRunTerminalEvent } from "../lib/spine.ts";
import { closeDb, initDb } from "../server/db.js";
import { mountRefRunStatus } from "../server/routes/ref-run-status.ts";

const CONNECTOR_ID = "https://registry.pdpp.org/connectors/run-status-test";
const ROUTE = "GET /_ref/runs/:runId";

function makeApp() {
  const routes = {};
  const middleware = {};
  const app = {
    get(path, ...args) {
      const fns = args.filter((a) => typeof a === "function");
      routes[`GET ${path}`] = fns[fns.length - 1];
      middleware[`GET ${path}`] = fns.slice(0, -1);
      return app;
    },
    routes,
    middleware,
  };
  return app;
}

function makeRes() {
  const res = {
    _status: 200,
    _body: null,
    status(code) {
      res._status = code;
      return res;
    },
    json(body) {
      res._body = body;
      return res;
    },
  };
  return res;
}

function makeCtx(overrides = {}) {
  return {
    controller: { findActiveRunByRunId: () => null },
    getRunStartedEvent: () => null,
    getRunTerminalEvent: () => null,
    handleError: (_res, err) => {
      throw err;
    },
    pdppError: (res, status, code, message, param) => {
      res.status(status).json({ error: { code, message, ...(param ? { param } : {}) } });
    },
    requireOwnerSession: () => {},
    ...overrides,
  };
}

// Real-spine ctx: terminal + started lookups hit the SQLite fixture db.
function makeSpineCtx(overrides = {}) {
  return makeCtx({
    getRunStartedEvent: (runId) => getRunStartedEvent(runId),
    getRunTerminalEvent: (runId) => getRunTerminalEvent(runId),
    ...overrides,
  });
}

function freshDb(t) {
  closeDb();
  initDb(join(mkdtempSync(join(tmpdir(), "pdpp-run-status-")), "pdpp.sqlite"));
  t.after(() => {
    closeDb();
  });
}

async function emitStarted(runId, { occurredAt = "2026-06-10T19:05:40.278Z", traceId = "trace_status_1" } = {}) {
  await emitSpineEvent({
    event_type: "run.started",
    occurred_at: occurredAt,
    trace_id: traceId,
    actor_type: "runtime",
    actor_id: CONNECTOR_ID,
    object_type: "run",
    object_id: runId,
    status: "started",
    run_id: runId,
    data: {
      source: { kind: "connector", id: CONNECTOR_ID },
      boot_epoch: "boot_1",
      seq: 1,
      controller_id: "ctrl_test",
    },
  });
}

async function emitFailed(runId, { occurredAt = "2026-06-10T19:05:40.730Z", traceId = "trace_status_1" } = {}) {
  await emitSpineEvent({
    event_type: "run.failed",
    occurred_at: occurredAt,
    trace_id: traceId,
    actor_type: "runtime",
    actor_id: CONNECTOR_ID,
    object_type: "run",
    object_id: runId,
    status: "failed",
    run_id: runId,
    data: {
      source: { kind: "connector", id: CONNECTOR_ID },
      reason: "connector_reported_failed",
      connector_error_message: "could not open browser profile",
      failure_origin: "connector",
      records_emitted: 0,
    },
  });
}

// ---------------------------------------------------------------------------
// Auth gating
// ---------------------------------------------------------------------------

test("run-status route: gated by requireOwnerSession before the handler", () => {
  const ownerGate = () => {};
  const app = makeApp();
  mountRefRunStatus(app, makeCtx({ requireOwnerSession: ownerGate }));
  assert.equal(app.middleware[ROUTE].length, 1, "exactly one middleware is registered");
  assert.equal(app.middleware[ROUTE][0], ownerGate, "requireOwnerSession is that middleware");
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
    }),
  );
  const res = makeRes();
  await app.routes[ROUTE]({ params: { runId: "run_active" } }, res);
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
  await app.routes[ROUTE]({ params: { runId: "run_done" } }, res);

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
    event_type: "run.completed",
    occurred_at: "2026-06-10T19:06:00.000Z",
    trace_id: "trace_status_1",
    actor_type: "runtime",
    actor_id: CONNECTOR_ID,
    object_type: "run",
    object_id: "run_ok",
    status: "succeeded",
    run_id: "run_ok",
    data: { source: { kind: "connector", id: CONNECTOR_ID }, records_emitted: 12 },
  });

  const app = makeApp();
  mountRefRunStatus(app, makeSpineCtx());
  const res = makeRes();
  await app.routes[ROUTE]({ params: { runId: "run_ok" } }, res);

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
    }),
  );
  const res = makeRes();
  await app.routes[ROUTE]({ params: { runId: "run_racing" } }, res);
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
  await app.routes[ROUTE]({ params: { runId: "run_orphaned" } }, res);

  assert.equal(res._status, 200);
  assert.equal(res._body.status, "active");
  assert.equal(res._body.connector_id, CONNECTOR_ID);
  assert.equal(res._body.started_at, "2026-06-10T19:05:40.278Z");
  assert.equal(res._body.completed_at, null);
});

// ---------------------------------------------------------------------------
// Unknown id → typed 404
// ---------------------------------------------------------------------------

test("run-status route: unknown run id gets the typed not_found envelope", async (t) => {
  freshDb(t);
  const app = makeApp();
  mountRefRunStatus(app, makeSpineCtx());
  const res = makeRes();
  await app.routes[ROUTE]({ params: { runId: "run_never_existed" } }, res);
  assert.equal(res._status, 404);
  assert.equal(res._body.error.code, "not_found");
  assert.equal(res._body.error.param, "run_id");
  assert.match(res._body.error.message, /run_never_existed/);
});

test("run-status route: no controller configured still resolves spine-known runs", async (t) => {
  freshDb(t);
  await emitStarted("run_no_controller");
  await emitFailed("run_no_controller");

  const app = makeApp();
  mountRefRunStatus(app, makeSpineCtx({ controller: null }));
  const res = makeRes();
  await app.routes[ROUTE]({ params: { runId: "run_no_controller" } }, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.status, "failed");
});

// ---------------------------------------------------------------------------
// URL decoding + error path
// ---------------------------------------------------------------------------

test("run-status route: URL-encoded runId is decoded before lookup", async () => {
  const seen = [];
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
    }),
  );
  const res = makeRes();
  await app.routes[ROUTE]({ params: { runId: "run%2Fwith%2Fslashes" } }, res);
  assert.deepEqual(seen, ["run/with/slashes"]);
  assert.equal(res._status, 404, "decoded-but-unknown id still gets the typed 404");
});

test("run-status route: lookup throws → handleError called", async () => {
  const errorsHandled = [];
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
    }),
  );
  const res = makeRes();
  await app.routes[ROUTE]({ params: { runId: "run_abc" } }, res);
  assert.equal(errorsHandled.length, 1);
  assert.match(errorsHandled[0].message, /spine exploded/);
});
