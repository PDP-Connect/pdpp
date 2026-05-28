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

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mountRefDevPlaygroundSession,
  mountRefRunInteraction,
} from '../server/routes/run-interaction.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeApp() {
  const routes = {};
  const app = {
    post(path, ...args) {
      const handler = args.findLast((a) => typeof a === 'function');
      routes[`POST ${path}`] = handler;
      return app;
    },
    routes,
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

function makeInteractionCtx(overrides = {}) {
  return {
    controller: {
      respondToInteraction: (_runId, input) => ({ status: input.status }),
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

// ---------------------------------------------------------------------------
// mountRefRunInteraction — boundary cases
// ---------------------------------------------------------------------------

test('run-interaction adapter: no controller → 404 not_found', () => {
  const app = makeApp();
  const ctx = makeInteractionCtx({ controller: null });
  mountRefRunInteraction(app, ctx);
  const handler = app.routes['POST /_ref/runs/:runId/interaction'];
  const res = makeRes();
  handler({ params: { runId: 'run_abc' }, body: { interaction_id: 'int_1', status: 'success' } }, res);
  assert.equal(res._status, 404);
  assert.equal(res._body.error.code, 'not_found');
});

test('run-interaction adapter: undefined controller → 404 not_found', () => {
  const app = makeApp();
  const ctx = makeInteractionCtx({ controller: undefined });
  mountRefRunInteraction(app, ctx);
  const handler = app.routes['POST /_ref/runs/:runId/interaction'];
  const res = makeRes();
  handler({ params: { runId: 'run_abc' }, body: { interaction_id: 'int_1', status: 'success' } }, res);
  assert.equal(res._status, 404);
  assert.equal(res._body.error.code, 'not_found');
});

test('run-interaction adapter: missing interaction_id → 400 invalid_request', () => {
  const app = makeApp();
  const ctx = makeInteractionCtx();
  mountRefRunInteraction(app, ctx);
  const handler = app.routes['POST /_ref/runs/:runId/interaction'];
  const res = makeRes();
  handler({ params: { runId: 'run_abc' }, body: { status: 'success' } }, res);
  assert.equal(res._status, 400);
  assert.equal(res._body.error.code, 'invalid_request');
  assert.equal(res._body.error.param, 'interaction_id');
});

test('run-interaction adapter: whitespace-only interaction_id → 400 invalid_request', () => {
  const app = makeApp();
  const ctx = makeInteractionCtx();
  mountRefRunInteraction(app, ctx);
  const handler = app.routes['POST /_ref/runs/:runId/interaction'];
  const res = makeRes();
  handler({ params: { runId: 'run_abc' }, body: { interaction_id: '   ', status: 'success' } }, res);
  assert.equal(res._status, 400);
  assert.equal(res._body.error.code, 'invalid_request');
});

test('run-interaction adapter: invalid status → 400 invalid_status', () => {
  const app = makeApp();
  const ctx = makeInteractionCtx();
  mountRefRunInteraction(app, ctx);
  const handler = app.routes['POST /_ref/runs/:runId/interaction'];
  const res = makeRes();
  handler({ params: { runId: 'run_abc' }, body: { interaction_id: 'int_1', status: 'nope' } }, res);
  assert.equal(res._status, 400);
  assert.equal(res._body.error.code, 'invalid_status');
  assert.equal(res._body.error.param, 'status');
});

test('run-interaction adapter: data is array → 400 invalid_request', () => {
  const app = makeApp();
  const ctx = makeInteractionCtx();
  mountRefRunInteraction(app, ctx);
  const handler = app.routes['POST /_ref/runs/:runId/interaction'];
  const res = makeRes();
  handler(
    { params: { runId: 'run_abc' }, body: { interaction_id: 'int_1', status: 'success', data: [1, 2] } },
    res,
  );
  assert.equal(res._status, 400);
  assert.equal(res._body.error.code, 'invalid_request');
  assert.equal(res._body.error.param, 'data');
});

test('run-interaction adapter: success with status=success delivers 202 ack', () => {
  const calls = [];
  const app = makeApp();
  const ctx = makeInteractionCtx({
    controller: {
      respondToInteraction: (runId, input) => {
        calls.push({ runId, input });
        return { status: input.status };
      },
    },
  });
  mountRefRunInteraction(app, ctx);
  const handler = app.routes['POST /_ref/runs/:runId/interaction'];
  const res = makeRes();
  handler(
    {
      params: { runId: 'run_abc' },
      body: { interaction_id: 'int_1', status: 'success', data: { username: 'alice' } },
    },
    res,
  );
  assert.equal(res._status, 202);
  assert.equal(res._body.object, 'run_interaction_ack');
  assert.equal(res._body.run_id, 'run_abc');
  assert.equal(res._body.interaction_id, 'int_1');
  assert.equal(res._body.status, 'success');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].runId, 'run_abc');
  assert.equal(calls[0].input.interaction_id, 'int_1');
  assert.deepEqual(calls[0].input.data, { username: 'alice' });
});

test('run-interaction adapter: success with status=cancelled delivers 202 ack', () => {
  const app = makeApp();
  const ctx = makeInteractionCtx();
  mountRefRunInteraction(app, ctx);
  const handler = app.routes['POST /_ref/runs/:runId/interaction'];
  const res = makeRes();
  handler(
    { params: { runId: 'run_xyz' }, body: { interaction_id: 'int_2', status: 'cancelled' } },
    res,
  );
  assert.equal(res._status, 202);
  assert.equal(res._body.status, 'cancelled');
  assert.equal(res._body.run_id, 'run_xyz');
});

test('run-interaction adapter: URL-encoded runId is decoded before forwarding to controller', () => {
  const calls = [];
  const app = makeApp();
  const ctx = makeInteractionCtx({
    controller: {
      respondToInteraction: (runId, input) => {
        calls.push(runId);
        return { status: input.status };
      },
    },
  });
  mountRefRunInteraction(app, ctx);
  const handler = app.routes['POST /_ref/runs/:runId/interaction'];
  const res = makeRes();
  handler(
    { params: { runId: 'run%2Fwith%2Fslashes' }, body: { interaction_id: 'int_1', status: 'success' } },
    res,
  );
  assert.equal(res._status, 202);
  assert.equal(calls[0], 'run/with/slashes');
});

test('run-interaction adapter: controller throws → handleError called', () => {
  const errorsHandled = [];
  const app = makeApp();
  const ctx = makeInteractionCtx({
    controller: {
      respondToInteraction: () => {
        throw new Error('controller exploded');
      },
    },
    handleError: (_res, err) => {
      errorsHandled.push(err);
    },
  });
  mountRefRunInteraction(app, ctx);
  const handler = app.routes['POST /_ref/runs/:runId/interaction'];
  const res = makeRes();
  handler({ params: { runId: 'run_abc' }, body: { interaction_id: 'int_1', status: 'success' } }, res);
  assert.equal(errorsHandled.length, 1);
  assert.match(errorsHandled[0].message, /controller exploded/);
});

test('run-interaction adapter: null body treated as empty object', () => {
  const app = makeApp();
  const ctx = makeInteractionCtx();
  mountRefRunInteraction(app, ctx);
  const handler = app.routes['POST /_ref/runs/:runId/interaction'];
  const res = makeRes();
  handler({ params: { runId: 'run_abc' }, body: null }, res);
  // null body → empty object → missing interaction_id → 400
  assert.equal(res._status, 400);
  assert.equal(res._body.error.code, 'invalid_request');
});

// ---------------------------------------------------------------------------
// mountRefDevPlaygroundSession — boundary cases
// ---------------------------------------------------------------------------

function makePlaygroundCtx(overrides = {}) {
  return {
    playground: {
      getOrCreatePlaygroundSession: async ({ backend, streamDebug }) => ({
        backend: backend ?? 'default',
        runId: 'run_playground_1',
        interactionId: 'int_playground_1',
        streamDebug,
      }),
    },
    pdppError: (res, status, code, message) => {
      res.status(status).json({ error: { code, message } });
    },
    requireOwnerSession: () => {},
    logger: null,
    ...overrides,
  };
}

test('playground adapter: success with backend from query → 200 session envelope', async () => {
  const app = makeApp();
  const ctx = makePlaygroundCtx();
  mountRefDevPlaygroundSession(app, ctx);
  const handler = app.routes['POST /_ref/dev/playground/session'];
  const res = makeRes();
  await handler({ params: {}, query: { backend: 'neko' }, body: null }, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.object, 'stream_playground_session');
  assert.equal(res._body.backend, 'neko');
  assert.equal(res._body.run_id, 'run_playground_1');
  assert.equal(res._body.interaction_id, 'int_playground_1');
});

test('playground adapter: success with backend from body when no query backend → 200', async () => {
  const app = makeApp();
  const ctx = makePlaygroundCtx();
  mountRefDevPlaygroundSession(app, ctx);
  const handler = app.routes['POST /_ref/dev/playground/session'];
  const res = makeRes();
  await handler({ params: {}, query: {}, body: { backend: 'cdp' } }, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.backend, 'cdp');
});

test('playground adapter: stream_debug forwarded from query', async () => {
  const calls = [];
  const app = makeApp();
  const ctx = makePlaygroundCtx({
    playground: {
      getOrCreatePlaygroundSession: async (opts) => {
        calls.push(opts);
        return { backend: 'neko', runId: 'r1', interactionId: 'i1' };
      },
    },
  });
  mountRefDevPlaygroundSession(app, ctx);
  const handler = app.routes['POST /_ref/dev/playground/session'];
  const res = makeRes();
  await handler({ params: {}, query: { stream_debug: 'verbose' }, body: null }, res);
  assert.equal(calls[0].streamDebug, 'verbose');
  assert.equal(res._status, 200);
});

test('playground adapter: playground throws → 500 playground_failed', async () => {
  const app = makeApp();
  const ctx = makePlaygroundCtx({
    playground: {
      getOrCreatePlaygroundSession: async () => {
        throw new Error('backend unreachable');
      },
    },
  });
  mountRefDevPlaygroundSession(app, ctx);
  const handler = app.routes['POST /_ref/dev/playground/session'];
  const res = makeRes();
  await handler({ params: {}, query: {}, body: null }, res);
  assert.equal(res._status, 500);
  assert.equal(res._body.error.code, 'playground_failed');
  assert.match(res._body.error.message, /backend unreachable/);
});
