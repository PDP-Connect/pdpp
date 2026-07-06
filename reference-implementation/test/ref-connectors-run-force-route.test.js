import assert from 'node:assert/strict';
import test from 'node:test';

import { mountOwnerConnectionRun } from '../server/routes/owner-connection-run.ts';
import { mountRefConnectionRun, mountRefConnectorRun } from '../server/routes/ref-connectors.ts';

function buildHarness(mount) {
  const calls = {
    emitSpineEvent: [],
    runNow: [],
    resolveOwnerConnectorNamespace: [],
  };
  const ctx = {
    canonicalConnectorKey: (value) => value,
    createTraceContext: () => ({ request_id: 'req_test', scenario_id: 'scn_test', trace_id: 'trc_test' }),
    emitSpineEvent(event) {
      calls.emitSpineEvent.push(event);
    },
    ensureRequestId: () => 'req_test',
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
    setReferenceTraceId: () => {},
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
        headers: new Map(),
        statusCode: null,
        getHeader(name) {
          return this.headers.get(name);
        },
        json(value) {
          this.body = value;
          return value;
        },
        setHeader(name, value) {
          this.headers.set(name, value);
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

function buildOwnerHarness() {
  const calls = {
    runNow: [],
  };
  const ctx = {
    AmbiguousConnectionError: class AmbiguousConnectionError extends Error {},
    canonicalConnectorKey: (value) => value,
    createTraceContext: () => ({ request_id: 'req_test', scenario_id: 'scn_test', trace_id: 'trc_test' }),
    emitSpineEvent: async () => {},
    ensureRequestId: () => 'req_test',
    getOwnerTokenSubjectId: () => 'owner_local',
    handleError(_res, err) {
      throw err;
    },
    listActiveBindingsForGrant: () => [],
    pdppError(_res, status, code, message) {
      const err = new Error(message);
      err.status = status;
      err.code = code;
      throw err;
    },
    projectBindingForWire: () => null,
    requireOwner: (_req, _res, next) => (typeof next === 'function' ? next() : undefined),
    requireToken: (_req, _res, next) => (typeof next === 'function' ? next() : undefined),
    resolveOwnerConnectorNamespace(_req, connectorId, options = {}) {
      return {
        connectorId: connectorId ?? 'chatgpt',
        connectorInstanceId: options.connectorInstanceId ?? 'cin_chatgpt',
      };
    },
    runNow(connectorId, options) {
      calls.runNow.push({ connectorId, options });
      return { run_id: 'run_owner_resources_test' };
    },
    setReferenceTraceId: () => {},
  };

  let routeHandler = null;
  const app = {
    post(_path, ...handlers) {
      routeHandler = handlers[handlers.length - 1];
      return app;
    },
  };
  mountOwnerConnectionRun(app, ctx);

  return {
    calls,
    async invoke({ body = null, params = {} } = {}) {
      const res = {
        body: null,
        headers: new Map(),
        statusCode: null,
        end() {},
        getHeader(name) {
          return this.headers.get(name);
        },
        json(value) {
          this.body = value;
          return value;
        },
        setHeader(name, value) {
          this.headers.set(name, value);
        },
        status(code) {
          this.statusCode = code;
          return this;
        },
      };
      await routeHandler({
        body,
        params: { connectionId: 'cin_chatgpt', ...params },
        query: {},
        tokenInfo: { pdpp_token_kind: 'owner', client_id: 'cli_longview', subject_id: 'owner_local' },
      }, res);
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
  assert.equal(harness.calls.emitSpineEvent[0]?.event_type, 'owner_agent.connection.run');
  assert.equal(harness.calls.emitSpineEvent[0]?.data?.forced, true);
  assert.equal(harness.calls.emitSpineEvent[0]?.data?.run_id, 'run_force_test');
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
  assert.equal(harness.calls.emitSpineEvent[0]?.event_type, 'owner_agent.connection.run');
  assert.equal(harness.calls.emitSpineEvent[0]?.data?.forced, true);
  assert.equal(harness.calls.emitSpineEvent[0]?.data?.connection_id, 'cin_chatgpt');
});

test('POST /_ref/connections/:id/run does not force unless the body value is exactly true', async () => {
  const harness = buildHarness(mountRefConnectionRun);

  await harness.invoke({
    body: { force: 'true' },
    params: { connectorInstanceId: 'cin_chatgpt' },
  });

  assert.equal(harness.calls.runNow[0]?.options.force, false);
  assert.equal(harness.calls.emitSpineEvent[0]?.data?.forced, false);
});

test('POST /_ref/connections/:id/run forwards scoped stream resources', async () => {
  const harness = buildHarness(mountRefConnectionRun);

  const res = await harness.invoke({
    body: { resources: { messages: ['C07JYF0U8BY', 'C07JYF0U8BY', ''] } },
    params: { connectorInstanceId: 'cin_slack' },
  });

  assert.equal(res.statusCode, 202);
  assert.deepEqual(harness.calls.runNow, [
    {
      connectorId: 'chatgpt',
      options: {
        connectorInstanceId: 'cin_slack',
        force: false,
        resources: { messages: ['C07JYF0U8BY'] },
      },
    },
  ]);
});

test('POST /_ref/connections/:id/run rejects prototype-polluting resource keys', async () => {
  const harness = buildHarness(mountRefConnectionRun);
  const body = JSON.parse('{"resources":{"__proto__":["C07JYF0U8BY"]}}');

  await assert.rejects(
    () => harness.invoke({
      body,
      params: { connectorInstanceId: 'cin_slack' },
    }),
    /run resources must map stream names to string arrays/,
  );
  assert.deepEqual(harness.calls.runNow, []);
});

test('POST /_ref/connections/:id/run rejects empty scoped resources instead of widening', async () => {
  const harness = buildHarness(mountRefConnectionRun);

  await assert.rejects(
    () => harness.invoke({
      body: { resources: { messages: [] } },
      params: { connectorInstanceId: 'cin_slack' },
    }),
    /run resources must include at least one resource id per stream/,
  );
  assert.deepEqual(harness.calls.runNow, []);
});

test('POST /v1/owner/connections/:id/run rejects prototype-polluting resource keys', async () => {
  const harness = buildOwnerHarness();
  const body = JSON.parse('{"resources":{"__proto__":["C07JYF0U8BY"]}}');

  await assert.rejects(
    () => harness.invoke({ body }),
    /run resources must map stream names to string arrays/,
  );
  assert.deepEqual(harness.calls.runNow, []);
});

test('POST /v1/owner/connections/:id/run rejects empty scoped resources instead of widening', async () => {
  const harness = buildOwnerHarness();

  await assert.rejects(
    () => harness.invoke({ body: { resources: { messages: [] } } }),
    /run resources must include at least one resource id per stream/,
  );
  assert.deepEqual(harness.calls.runNow, []);
});
