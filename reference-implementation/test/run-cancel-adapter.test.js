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
 *   - controller cancelRun → no_active_run → 404 no_active_run;
 *   - controller cancelRun → already_terminal → 409 run_already_terminal;
 *   - URL-encoded runId is decoded before forwarding to the controller;
 *   - controller throws → handleError called.
 *
 * Spec: openspec/changes/add-owner-run-cancellation-control (task 5.5).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { mountRefRunCancel } from '../server/routes/run-cancel.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Records middleware order per path so we can assert requireOwnerSession runs
// before the route handler.
function makeApp() {
  const routes = {};
  const middleware = {};
  const app = {
    post(path, ...args) {
      const fns = args.filter((a) => typeof a === 'function');
      routes[`POST ${path}`] = fns[fns.length - 1];
      middleware[`POST ${path}`] = fns.slice(0, -1);
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
    controller: {
      cancelRun: async (runId) => ({ status: 'cancel_requested', run_id: runId }),
    },
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

const ROUTE = 'POST /_ref/runs/:runId/cancel';

// ---------------------------------------------------------------------------
// Auth gating
// ---------------------------------------------------------------------------

test('run-cancel adapter: route is gated by requireOwnerSession before the handler', () => {
  const seen = [];
  const ownerGate = () => {
    seen.push('owner_session');
  };
  const app = makeApp();
  mountRefRunCancel(app, makeCtx({ requireOwnerSession: ownerGate }));
  // The owner-session middleware is registered on the route, ahead of the
  // handler — an unauthenticated request never reaches cancelRun because this
  // middleware rejects it first (its real implementation is exercised by the
  // server-level owner-auth suite).
  assert.equal(app.middleware[ROUTE].length, 1, 'exactly one middleware is registered');
  assert.equal(app.middleware[ROUTE][0], ownerGate, 'requireOwnerSession is that middleware');
});

// ---------------------------------------------------------------------------
// Typed outcomes
// ---------------------------------------------------------------------------

test('run-cancel adapter: no controller → 404 not_found', async () => {
  const app = makeApp();
  mountRefRunCancel(app, makeCtx({ controller: null }));
  const res = makeRes();
  await app.routes[ROUTE]({ params: { runId: 'run_abc' } }, res);
  assert.equal(res._status, 404);
  assert.equal(res._body.error.code, 'not_found');
});

test('run-cancel adapter: cancel_requested → 202 run_cancel_ack', async () => {
  const calls = [];
  const app = makeApp();
  mountRefRunCancel(
    app,
    makeCtx({
      controller: {
        cancelRun: async (runId) => {
          calls.push(runId);
          return { status: 'cancel_requested', run_id: runId };
        },
      },
    }),
  );
  const res = makeRes();
  await app.routes[ROUTE]({ params: { runId: 'run_abc' } }, res);
  assert.equal(res._status, 202);
  assert.equal(res._body.object, 'run_cancel_ack');
  assert.equal(res._body.run_id, 'run_abc');
  assert.equal(res._body.status, 'cancel_requested');
  assert.deepEqual(calls, ['run_abc']);
});

test('run-cancel adapter: no_active_run → 404 no_active_run', async () => {
  const app = makeApp();
  mountRefRunCancel(
    app,
    makeCtx({
      controller: { cancelRun: async (runId) => ({ status: 'no_active_run', run_id: runId }) },
    }),
  );
  const res = makeRes();
  await app.routes[ROUTE]({ params: { runId: 'run_missing' } }, res);
  assert.equal(res._status, 404);
  assert.equal(res._body.error.code, 'no_active_run');
  assert.equal(res._body.error.param, 'run_id');
});

test('run-cancel adapter: already_terminal → 409 run_already_terminal', async () => {
  const app = makeApp();
  mountRefRunCancel(
    app,
    makeCtx({
      controller: { cancelRun: async (runId) => ({ status: 'already_terminal', run_id: runId }) },
    }),
  );
  const res = makeRes();
  await app.routes[ROUTE]({ params: { runId: 'run_done' } }, res);
  assert.equal(res._status, 409);
  assert.equal(res._body.error.code, 'run_already_terminal');
  assert.equal(res._body.error.param, 'run_id');
});

test('run-cancel adapter: URL-encoded runId is decoded before forwarding to controller', async () => {
  const calls = [];
  const app = makeApp();
  mountRefRunCancel(
    app,
    makeCtx({
      controller: {
        cancelRun: async (runId) => {
          calls.push(runId);
          return { status: 'cancel_requested', run_id: runId };
        },
      },
    }),
  );
  const res = makeRes();
  await app.routes[ROUTE]({ params: { runId: 'run%2Fwith%2Fslashes' } }, res);
  assert.equal(res._status, 202);
  assert.equal(calls[0], 'run/with/slashes');
});

test('run-cancel adapter: controller throws → handleError called', async () => {
  const errorsHandled = [];
  const app = makeApp();
  mountRefRunCancel(
    app,
    makeCtx({
      controller: {
        cancelRun: async () => {
          throw new Error('controller exploded');
        },
      },
      handleError: (_res, err) => {
        errorsHandled.push(err);
      },
    }),
  );
  const res = makeRes();
  await app.routes[ROUTE]({ params: { runId: 'run_abc' } }, res);
  assert.equal(errorsHandled.length, 1);
  assert.match(errorsHandled[0].message, /controller exploded/);
});
