import assert from 'node:assert/strict';
import test from 'node:test';

import { mountRefConnectionRun, mountRefConnectorRun } from '../server/routes/ref-connectors.ts';

function buildHarness(mount) {
  const calls = {
    runNow: [],
    resolveOwnerConnectorNamespace: [],
  };
  const ctx = {
    requireOwnerSession: (_req, _res, next) => (typeof next === 'function' ? next() : undefined),
    getOwnerSubjectId: () => 'owner_local',
    resolveOwnerConnectorNamespace(_req, connectorId, options = {}) {
      calls.resolveOwnerConnectorNamespace.push({ connectorId, options });
      return {
        connectorId: connectorId ?? 'chatgpt',
        connectorInstanceId: options.connectorInstanceId ?? 'cin_chatgpt',
      };
    },
    runNow(connectorId, options) {
      calls.runNow.push({ connectorId, options });
      return { run_id: 'run_force_test' };
    },
    handleError(_res, err) {
      throw err;
    },
  };

  let routeHandler = null;
  const app = {
    post(_path, ...handlers) {
      routeHandler = handlers[handlers.length - 1];
      return app;
    },
  };
  mount(app, ctx);

  return {
    calls,
    async invoke({ body = null, params = {} } = {}) {
      const res = {
        body: null,
        statusCode: null,
        json(value) {
          this.body = value;
          return value;
        },
        status(code) {
          this.statusCode = code;
          return this;
        },
      };
      await routeHandler({ body, params, query: {} }, res);
      return res;
    },
  };
}

test('POST /_ref/connections/:id/run forwards explicit force override to the controller', async () => {
  const harness = buildHarness(mountRefConnectionRun);

  const res = await harness.invoke({
    body: { force: true },
    params: { connectorInstanceId: 'cin_chatgpt' },
  });

  assert.equal(res.statusCode, 202);
  assert.deepEqual(harness.calls.runNow, [
    {
      connectorId: 'chatgpt',
      options: { connectorInstanceId: 'cin_chatgpt', force: true },
    },
  ]);
});

test('POST /_ref/connectors/:id/run forwards explicit force override to the controller', async () => {
  const harness = buildHarness(mountRefConnectorRun);

  const res = await harness.invoke({
    body: { force: true },
    params: { connectorId: 'chatgpt' },
  });

  assert.equal(res.statusCode, 202);
  assert.deepEqual(harness.calls.runNow, [
    {
      connectorId: 'chatgpt',
      options: { connectorInstanceId: 'cin_chatgpt', force: true },
    },
  ]);
});

test('POST /_ref/connections/:id/run does not force unless the body value is exactly true', async () => {
  const harness = buildHarness(mountRefConnectionRun);

  await harness.invoke({
    body: { force: 'true' },
    params: { connectorInstanceId: 'cin_chatgpt' },
  });

  assert.equal(harness.calls.runNow[0]?.options.force, false);
});
