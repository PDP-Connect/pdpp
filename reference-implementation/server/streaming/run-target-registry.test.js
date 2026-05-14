/**
 * Tests for the run-target registry.
 *
 * Exercises:
 *  - in-process register/get/unregister semantics with composite
 *    `(runId, interactionId)` key and TTL
 *  - cross-interaction isolation (run X interaction A != run X interaction B)
 *  - target validation (CDP ws:/wss: and Neko http:/https:, loopback only)
 *  - device-authority binding on unregister
 *  - the route handler shape (auth gate, response envelope, never echo wsUrl)
 *  - logging never carries the full wsUrl path, Neko auth metadata, or raw nonce
 *  - PUT idempotency: same-value re-PUT is silent; different-value PUT
 *    replaces and emits a warn-level diagnostic
 *  - per-run nonce auth on the composite-key endpoint
 *  - device-token auth on the composite-key endpoint
 *
 * Routes are exercised by capturing the handlers via a fake express-like
 * `app` and invoking them with mock req/res. We do not stand up a full
 * Fastify instance — the registry's contract is the JSON it produces and
 * the records it stores, not the transport binding.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createRunTargetRegistry } from './run-target-registry.js';

// ─── helpers ────────────────────────────────────────────────────────────

function assertNoRawBackendAuthority(value) {
  const serialized = JSON.stringify(value);
  assert.equal(/ws:\/\/|wss:\/\//i.test(serialized), false);
  assert.equal(/https?:\/\/(?:127\.0\.0\.1|localhost|neko)(?::\d+)?/i.test(serialized), false);
  assert.equal(/\/json\/version|\/devtools\/browser/i.test(serialized), false);
  assert.equal(/base_url|cdpWsUrl|cdpHttpUrl|webSocketDebuggerUrl/i.test(serialized), false);
  assert.equal(/docker\.sock|allocatorCredentials/i.test(serialized), false);
}

function makeFakeApp() {
  const routes = [];
  return {
    routes,
    put(path, ...args) {
      routes.push({ method: 'PUT', path, handlers: args });
    },
    post(path, ...args) {
      routes.push({ method: 'POST', path, handlers: args });
    },
    delete(path, ...args) {
      routes.push({ method: 'DELETE', path, handlers: args });
    },
    findHandler(method, path) {
      const route = routes.find((r) => r.method === method && r.path === path);
      if (!route) throw new Error(`No ${method} ${path} registered`);
      return route.handlers;
    },
  };
}

function makeReq({ params = {}, body = {}, deviceId = null } = {}) {
  return {
    params,
    body,
    deviceExporter: deviceId ? { deviceId } : undefined,
  };
}

function makeRes() {
  let statusCode = 200;
  let payload = null;
  const res = {
    status(code) {
      statusCode = code;
      return res;
    },
    json(body) {
      payload = body;
      return res;
    },
    get statusCode() {
      return statusCode;
    },
    get payload() {
      return payload;
    },
  };
  return res;
}

function makeCapturedLogger() {
  const entries = [];
  function record(level) {
    return (data) => {
      entries.push({ level, ...data });
    };
  }
  return {
    entries,
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    debug: record('debug'),
  };
}

// Mock auth middleware: stamps req.deviceExporter = { deviceId } and
// continues. The deviceId is provided per-call via `mockAuth(deviceId)`.
function mockAuth(deviceId) {
  return (req, _res, next) => {
    req.deviceExporter = { deviceId };
    next();
  };
}

// Run a request through a (middleware, handler) pair. Mirrors what the
// Fastify wrapper does, but stays in-process so tests can introspect the
// captured response.
async function runRoute(handlers, req, res) {
  let i = 0;
  async function next(err) {
    if (err) throw err;
    const fn = handlers[i++];
    if (!fn) return;
    await fn(req, res, next);
  }
  await next();
  return res;
}

const RESOURCE_PATH =
  '/admin/runs/:runId/interactions/:interactionId/streaming-target';
const VALID_WS = 'ws://127.0.0.1:9222/devtools/page/abc123XYZ';
const VALID_WS_2 = 'ws://127.0.0.1:9222/devtools/page/xyz789ABC';
const VALID_NEKO_BASE_URL = 'http://127.0.0.1:6080';
const VALID_NEKO_BASE_URL_2 = 'https://localhost:6081/neko';
const VALID_NEKO_DOCKER_BASE_URL = 'http://neko:8080/neko';

// ─── unit-level: register / get / unregister ────────────────────────────

test('register stores a record retrievable via get by composite key', () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  const result = registry.register({
    runId: 'run_test_1',
    interactionId: 'int_a',
    wsUrl: VALID_WS,
    deviceId: 'dev_1',
  });
  assert.equal(result.runId, 'run_test_1');
  assert.equal(result.interactionId, 'int_a');
  assert.equal(result.action, 'registered');
  assert.ok(Number.isFinite(result.expiry));
  assert.equal(registry.get({ runId: 'run_test_1', interactionId: 'int_a' }), VALID_WS);
  registry.shutdown();
});

test('register accepts ws_url and preserves CDP resolver string compatibility', () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  registry.register({
    runId: 'run_test_1',
    interactionId: 'int_a',
    ws_url: VALID_WS,
    deviceId: 'dev_1',
  });
  assert.equal(registry.get({ runId: 'run_test_1', interactionId: 'int_a' }), VALID_WS);
  registry.shutdown();
});

test('register stores a normalized neko descriptor retrievable via get', () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  registry.register({
    runId: 'run_neko_1',
    interactionId: 'int_a',
    backend: 'neko',
    base_url: `${VALID_NEKO_BASE_URL}/`,
    auth: {
      token: 'secret-token-for-neko',
      scheme: 'bearer',
    },
    deviceId: 'dev_1',
  });

  assert.deepEqual(registry.get({ runId: 'run_neko_1', interactionId: 'int_a' }), {
    backend: 'neko',
    base_url: VALID_NEKO_BASE_URL,
    auth: {
      scheme: 'bearer',
      token: 'secret-token-for-neko',
    },
  });
  const [record] = registry.getByRun('run_neko_1');
  assert.equal(record.backend, 'neko');
  assert.equal(record.baseUrl, VALID_NEKO_BASE_URL);
  assert.equal(record.descriptor.auth.token, 'secret-token-for-neko');
  registry.shutdown();
});

test('register accepts the private Docker Compose n.eko service host', () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  registry.register({
    runId: 'run_neko_docker',
    interactionId: 'int_a',
    backend: 'neko',
    base_url: `${VALID_NEKO_DOCKER_BASE_URL}/`,
    deviceId: 'dev_1',
  });

  assert.deepEqual(registry.get({ runId: 'run_neko_docker', interactionId: 'int_a' }), {
    backend: 'neko',
    base_url: VALID_NEKO_DOCKER_BASE_URL,
  });
  registry.shutdown();
});

test('cross-interaction isolation: registering for (run, intA) does not surface for (run, intB)', () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  registry.register({
    runId: 'run_x',
    interactionId: 'int_a',
    wsUrl: VALID_WS,
    deviceId: 'dev_1',
  });
  // The same runId paired with a different interactionId must be a miss,
  // even though the wsUrl exists in the registry. This proves we are
  // genuinely keyed by the composite, not by `runId` with a fallback.
  assert.equal(registry.get({ runId: 'run_x', interactionId: 'int_b' }), null);
  // Sanity: the original is still there.
  assert.equal(registry.get({ runId: 'run_x', interactionId: 'int_a' }), VALID_WS);
  registry.shutdown();
});

test('cross-run isolation: registering for (runA, int) does not surface for (runB, int)', () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  registry.register({
    runId: 'run_a',
    interactionId: 'int_shared_id',
    wsUrl: VALID_WS,
    deviceId: 'dev_1',
  });
  assert.equal(
    registry.get({ runId: 'run_b', interactionId: 'int_shared_id' }),
    null,
    'a different runId with the same interactionId must miss',
  );
  registry.shutdown();
});

test('register requires runId and interactionId', () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  assert.throws(
    () =>
      registry.register({
        runId: '',
        interactionId: 'int_a',
        wsUrl: VALID_WS,
        deviceId: 'dev_1',
      }),
    (err) => err.code === 'run_target_invalid_url' && /runId/.test(err.message),
  );
  assert.throws(
    () =>
      registry.register({
        runId: 'run_a',
        interactionId: '',
        wsUrl: VALID_WS,
        deviceId: 'dev_1',
      }),
    (err) => err.code === 'run_target_invalid_url' && /interactionId/.test(err.message),
  );
  registry.shutdown();
});

test('register rejects non-loopback hosts', () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  assert.throws(
    () =>
      registry.register({
        runId: 'run_a',
        interactionId: 'int_a',
        wsUrl: 'ws://example.com:9222/devtools/page/abc',
        deviceId: 'dev_1',
      }),
    (err) => err.code === 'run_target_non_loopback',
  );
  // Public IP — also rejected.
  assert.throws(
    () =>
      registry.register({
        runId: 'run_b',
        interactionId: 'int_a',
        wsUrl: 'ws://10.0.0.5:9222/devtools/page/abc',
        deviceId: 'dev_1',
      }),
    (err) => err.code === 'run_target_non_loopback',
  );
  registry.shutdown();
});

test('register accepts the private Compose host `neko` as a wsUrl host', () => {
  // The chatgpt connector's remote-CDP flow registers wsUrls of the form
  // `ws://neko:9223/devtools/page/<targetId>`. The neko host is reachable
  // only on the private docker-compose network and fronted by cdp-proxy.py;
  // it carries the same trust boundary as loopback. The registry
  // previously rejected this URL with `run_target_non_loopback`, which
  // was the proximate cause of `companion_start_failed` on every
  // remote-CDP-routed manual_action.
  //
  // `get()` returns the raw wsUrl string for cdp targets (callers always
  // know which backend they registered, so a single resolver value is
  // sufficient). The neko-host-passes assertion is that the registration
  // does not throw and the value round-trips intact.
  const wsUrl = 'ws://neko:9223/devtools/page/AFFF11F8FEDF0CB0C8764672D4A67648';
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  registry.register({
    runId: 'run_neko_remote',
    interactionId: 'int_neko_remote',
    wsUrl,
    deviceId: 'dev_1',
  });
  const got = registry.get({ runId: 'run_neko_remote', interactionId: 'int_neko_remote' });
  assert.equal(got, wsUrl);
  registry.shutdown();
});

test('register rejects malformed URLs', () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  assert.throws(
    () =>
      registry.register({
        runId: 'run_a',
        interactionId: 'int_a',
        wsUrl: 'not-a-url',
        deviceId: 'dev_1',
      }),
    (err) => err.code === 'run_target_invalid_url',
  );
  registry.shutdown();
});

test('register rejects non-ws schemes', () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  assert.throws(
    () =>
      registry.register({
        runId: 'run_a',
        interactionId: 'int_a',
        wsUrl: 'http://127.0.0.1:9222/devtools/page/abc',
        deviceId: 'dev_1',
      }),
    (err) =>
      err.code === 'run_target_invalid_url' &&
      err.message.includes('scheme must be ws: or wss:'),
  );
  registry.shutdown();
});

test('register rejects neko descriptors with non-loopback base_url', () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  assert.throws(
    () =>
      registry.register({
        runId: 'run_a',
        interactionId: 'int_a',
        backend: 'neko',
        base_url: 'http://example.com:6080',
        deviceId: 'dev_1',
      }),
    (err) => err.code === 'run_target_non_loopback',
  );
  registry.shutdown();
});

test('register accepts dynamic managed n.eko descriptor approved by lease metadata', () => {
  const approved = [];
  const registry = createRunTargetRegistry({
    sweepIntervalMs: 0,
    isNekoDescriptorApproved(descriptor, context) {
      approved.push({ descriptor, context });
      return (
        context.runId === 'run_dynamic_1' &&
        context.interactionId === 'int_a' &&
        descriptor.surface_id === 'surf_1' &&
        descriptor.lease_id === 'lease_1' &&
        descriptor.profile_key === 'profile_1' &&
        descriptor.base_url === 'http://10.88.0.4:6080/neko'
      );
    },
  });

  registry.register({
    runId: 'run_dynamic_1',
    interactionId: 'int_a',
    backend: 'neko',
    base_url: 'http://10.88.0.4:6080/neko/',
    descriptor: {
      backend: 'neko',
      base_url: 'http://10.88.0.4:6080/neko/',
      surface_id: 'surf_1',
      lease_id: 'lease_1',
      profile_key: 'profile_1',
    },
    deviceId: 'dev_1',
  });

  assert.deepEqual(registry.get({ runId: 'run_dynamic_1', interactionId: 'int_a' }), {
    backend: 'neko',
    base_url: 'http://10.88.0.4:6080/neko',
    lease_id: 'lease_1',
    profile_key: 'profile_1',
    surface_id: 'surf_1',
  });
  assert.equal(approved.length, 1);
  registry.shutdown();
});

test('register rejects neko descriptors with non-http base_url schemes', () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  assert.throws(
    () =>
      registry.register({
        runId: 'run_a',
        interactionId: 'int_a',
        backend: 'neko',
        base_url: 'ws://127.0.0.1:6080',
        deviceId: 'dev_1',
      }),
    (err) =>
      err.code === 'run_target_invalid_url' &&
      err.message.includes('scheme must be http: or https:'),
  );
  registry.shutdown();
});

test('register accepts wss: loopback URLs', () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  const wssUrl = 'wss://localhost:9222/devtools/page/xyz';
  registry.register({
    runId: 'run_a',
    interactionId: 'int_a',
    wsUrl: wssUrl,
    deviceId: 'dev_1',
  });
  assert.equal(registry.get({ runId: 'run_a', interactionId: 'int_a' }), wssUrl);
  registry.shutdown();
});

test('register stores optional metadata fields and they survive in getByRun()', () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  registry.register({
    runId: 'run_a',
    interactionId: 'int_a',
    wsUrl: VALID_WS,
    deviceId: 'dev_1',
    pageUrl: 'https://example.test/login',
    pageTitle: 'Sign in to Example',
    reason: 'captcha',
  });
  const records = registry.getByRun('run_a');
  assert.equal(records.length, 1);
  const [record] = records;
  assert.equal(record.runId, 'run_a');
  assert.equal(record.interactionId, 'int_a');
  assert.equal(record.pageUrl, 'https://example.test/login');
  assert.equal(record.pageTitle, 'Sign in to Example');
  assert.equal(record.reason, 'captcha');
  assert.equal(typeof record.registeredAt, 'string');
  registry.shutdown();
});

test('getByRun returns multiple interactions for a single run', () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  registry.register({
    runId: 'run_a',
    interactionId: 'int_a',
    wsUrl: VALID_WS,
    deviceId: 'dev_1',
  });
  registry.register({
    runId: 'run_a',
    interactionId: 'int_b',
    wsUrl: VALID_WS_2,
    deviceId: 'dev_1',
  });
  const records = registry.getByRun('run_a');
  assert.equal(records.length, 2);
  const interactionIds = records.map((r) => r.interactionId).sort();
  assert.deepEqual(interactionIds, ['int_a', 'int_b']);
  registry.shutdown();
});

test('unregister by wrong deviceId returns false and leaves the record', () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  registry.register({
    runId: 'run_a',
    interactionId: 'int_a',
    wsUrl: VALID_WS,
    deviceId: 'dev_owner',
  });
  const removed = registry.unregister({
    runId: 'run_a',
    interactionId: 'int_a',
    deviceId: 'dev_intruder',
  });
  assert.equal(removed, false);
  assert.equal(
    registry.get({ runId: 'run_a', interactionId: 'int_a' }),
    VALID_WS,
    'record should still exist',
  );
  registry.shutdown();
});

test('unregister by correct deviceId removes only the targeted (run, interaction)', () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  registry.register({
    runId: 'run_a',
    interactionId: 'int_a',
    wsUrl: VALID_WS,
    deviceId: 'dev_owner',
  });
  registry.register({
    runId: 'run_a',
    interactionId: 'int_b',
    wsUrl: VALID_WS_2,
    deviceId: 'dev_owner',
  });
  const removed = registry.unregister({
    runId: 'run_a',
    interactionId: 'int_a',
    deviceId: 'dev_owner',
  });
  assert.equal(removed, true);
  assert.equal(registry.get({ runId: 'run_a', interactionId: 'int_a' }), null);
  // Sibling interaction is untouched.
  assert.equal(registry.get({ runId: 'run_a', interactionId: 'int_b' }), VALID_WS_2);
  registry.shutdown();
});

test('forceUnregister drops an entry regardless of the registered deviceId', () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  registry.register({
    runId: 'run_a',
    interactionId: 'int_a',
    wsUrl: VALID_WS,
    deviceId: 'dev_owner',
  });
  const removed = registry.forceUnregister({
    runId: 'run_a',
    interactionId: 'int_a',
  });
  assert.equal(removed, true);
  assert.equal(registry.get({ runId: 'run_a', interactionId: 'int_a' }), null);
  registry.shutdown();
});

test('forceUnregister is idempotent: calling on a non-existent key returns false', () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  const removed = registry.forceUnregister({
    runId: 'run_never_registered',
    interactionId: 'int_never',
  });
  assert.equal(removed, false);
  registry.shutdown();
});

test('forceUnregister removes only the targeted (run, interaction)', () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  registry.register({
    runId: 'run_a',
    interactionId: 'int_a',
    wsUrl: VALID_WS,
    deviceId: 'dev_owner',
  });
  registry.register({
    runId: 'run_a',
    interactionId: 'int_b',
    wsUrl: VALID_WS_2,
    deviceId: 'dev_owner',
  });
  const removed = registry.forceUnregister({
    runId: 'run_a',
    interactionId: 'int_a',
  });
  assert.equal(removed, true);
  assert.equal(registry.get({ runId: 'run_a', interactionId: 'int_a' }), null);
  // Sibling is untouched.
  assert.equal(registry.get({ runId: 'run_a', interactionId: 'int_b' }), VALID_WS_2);
  registry.shutdown();
});

test('forceUnregister logs at info level when dropping an entry', () => {
  const logger = makeCapturedLogger();
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0, logger });
  registry.register({
    runId: 'run_a',
    interactionId: 'int_a',
    wsUrl: VALID_WS,
    deviceId: 'dev_owner',
  });
  registry.forceUnregister({
    runId: 'run_a',
    interactionId: 'int_a',
  });
  const forceUnregLog = logger.entries.find((e) => e.msg === 'run_target_force_unregistered');
  assert.ok(forceUnregLog, 'should have logged run_target_force_unregistered');
  assert.equal(forceUnregLog.level, 'info');
  assert.equal(forceUnregLog.runId, 'run_a');
  assert.equal(forceUnregLog.interactionId, 'int_a');
  registry.shutdown();
});

test('forceUnregister with empty runId or interactionId returns false', () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  assert.equal(
    registry.forceUnregister({
      runId: '',
      interactionId: 'int_a',
    }),
    false,
  );
  assert.equal(
    registry.forceUnregister({
      runId: 'run_a',
      interactionId: '',
    }),
    false,
  );
  registry.shutdown();
});

test('register by a different device on a still-live record is rejected with 409 code', () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  registry.register({
    runId: 'run_a',
    interactionId: 'int_a',
    wsUrl: VALID_WS,
    deviceId: 'dev_owner',
  });
  assert.throws(
    () =>
      registry.register({
        runId: 'run_a',
        interactionId: 'int_a',
        wsUrl: VALID_WS,
        deviceId: 'dev_intruder',
      }),
    (err) => err.code === 'run_target_already_registered_other_device' && err.status === 409,
  );
  registry.shutdown();
});

test('idempotent re-register: same device + same wsUrl returns action=reaffirmed and emits no log', () => {
  const logger = makeCapturedLogger();
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0, logger });
  registry.register({
    runId: 'run_a',
    interactionId: 'int_a',
    wsUrl: VALID_WS,
    deviceId: 'dev_owner',
  });
  const firstRegisters = logger.entries.filter((e) => e.msg === 'run_target_registered').length;

  const result = registry.register({
    runId: 'run_a',
    interactionId: 'int_a',
    wsUrl: VALID_WS,
    deviceId: 'dev_owner',
  });
  assert.equal(result.action, 'reaffirmed');
  // No new register/replace log line for the silent retry.
  const afterRegisters = logger.entries.filter((e) => e.msg === 'run_target_registered').length;
  const afterReplaces = logger.entries.filter((e) => e.msg === 'run_target_replaced').length;
  assert.equal(afterRegisters, firstRegisters);
  assert.equal(afterReplaces, 0);
  registry.shutdown();
});

test('different-value re-register: same device + different wsUrl REPLACES and emits a warn log', () => {
  const logger = makeCapturedLogger();
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0, logger });
  registry.register({
    runId: 'run_a',
    interactionId: 'int_a',
    wsUrl: VALID_WS,
    deviceId: 'dev_owner',
  });

  const result = registry.register({
    runId: 'run_a',
    interactionId: 'int_a',
    wsUrl: VALID_WS_2,
    deviceId: 'dev_owner',
    reason: 'page_navigated',
  });
  assert.equal(result.action, 'replaced');
  assert.equal(registry.get({ runId: 'run_a', interactionId: 'int_a' }), VALID_WS_2);

  const replaceLog = logger.entries.find((e) => e.msg === 'run_target_replaced');
  assert.ok(replaceLog, 'a warn-level run_target_replaced log entry should be emitted');
  assert.equal(replaceLog.level, 'warn');
  assert.equal(replaceLog.runId, 'run_a');
  assert.equal(replaceLog.interactionId, 'int_a');
  assert.equal(replaceLog.reason, 'page_navigated');
  // Diagnostic warning must NOT include the wsUrl path.
  const serialized = JSON.stringify(logger.entries);
  assert.equal(serialized.includes('/devtools/page/'), false);
  registry.shutdown();
});

test('neko registration logs backend/host/port but never auth metadata', () => {
  const logger = makeCapturedLogger();
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0, logger });
  registry.register({
    runId: 'run_neko',
    interactionId: 'int_a',
    backend: 'neko',
    base_url: 'http://127.0.0.1:6080/session-secret-path',
    auth: {
      token: 'log-secret-token',
    },
    deviceId: 'dev_owner',
  });

  const registerLog = logger.entries.find((e) => e.msg === 'run_target_registered');
  assert.ok(registerLog, 'a run_target_registered log entry should be emitted');
  assert.equal(registerLog.backend, 'neko');
  assert.equal(registerLog.host, '127.0.0.1');
  assert.equal(registerLog.port, '6080');
  const serialized = JSON.stringify(logger.entries);
  assert.equal(serialized.includes('log-secret-token'), false);
  assert.equal(serialized.includes('session-secret-path'), false);
  registry.shutdown();
});

test('TTL expiry causes get to return null and removes only the expired record', () => {
  let t = 1_000_000;
  const registry = createRunTargetRegistry({
    ttlMs: 100,
    now: () => t,
    sweepIntervalMs: 0,
  });
  registry.register({
    runId: 'run_a',
    interactionId: 'int_a',
    wsUrl: VALID_WS,
    deviceId: 'dev_1',
  });
  // A second composite key, registered "later", should outlive the first.
  t += 50;
  registry.register({
    runId: 'run_a',
    interactionId: 'int_b',
    wsUrl: VALID_WS_2,
    deviceId: 'dev_1',
  });
  assert.equal(registry.get({ runId: 'run_a', interactionId: 'int_a' }), VALID_WS);
  assert.equal(registry.get({ runId: 'run_a', interactionId: 'int_b' }), VALID_WS_2);
  // Move past int_a's expiry but not int_b's.
  t += 60;
  assert.equal(
    registry.get({ runId: 'run_a', interactionId: 'int_a' }),
    null,
    'expired record should be evicted',
  );
  // The other interaction is still present.
  assert.equal(registry.get({ runId: 'run_a', interactionId: 'int_b' }), VALID_WS_2);
  // After eviction the internal map should not still hold it.
  assert.equal(registry._internal.records.has('run_a::int_a'), false);
  registry.shutdown();
});

// ─── route-level ────────────────────────────────────────────────────────

test('route handler returns 401 if no auth middleware passes', async () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  const app = makeFakeApp();
  // Auth middleware that mimics the real device-exporter rejection: writes
  // a 401 envelope and does NOT call next().
  const reject401 = (_req, res, _next) => {
    res
      .status(401)
      .json({ error: { type: 'authentication_error', code: 'authentication_error', message: 'no creds' } });
  };
  registry.attachRoutes(app, reject401);

  const handlers = app.findHandler('PUT', RESOURCE_PATH);
  const req = makeReq({
    params: { runId: 'run_a', interactionId: 'int_a' },
    body: { wsUrl: VALID_WS },
  });
  const res = makeRes();
  await runRoute(handlers, req, res);

  assert.equal(res.statusCode, 401);
  assert.equal(res.payload.error.code, 'authentication_error');
  assert.equal(
    registry.get({ runId: 'run_a', interactionId: 'int_a' }),
    null,
    'no record should be created',
  );
  registry.shutdown();
});

test('PUT returns 200 + { run_id, interaction_id, expiry, action } on successful register', async () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  const app = makeFakeApp();
  registry.attachRoutes(app, mockAuth('dev_owner'));

  const handlers = app.findHandler('PUT', RESOURCE_PATH);
  const req = makeReq({
    params: { runId: 'run_a', interactionId: 'int_a' },
    body: { wsUrl: VALID_WS },
  });
  const res = makeRes();
  await runRoute(handlers, req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.run_id, 'run_a');
  assert.equal(res.payload.interaction_id, 'int_a');
  assert.equal(res.payload.action, 'registered');
  assert.ok(Number.isFinite(res.payload.expiry), 'response includes expiry');
  assert.equal(registry.get({ runId: 'run_a', interactionId: 'int_a' }), VALID_WS);
  registry.shutdown();
});

test('PUT does NOT echo wsUrl back in the response', async () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  const app = makeFakeApp();
  registry.attachRoutes(app, mockAuth('dev_owner'));

  const handlers = app.findHandler('PUT', RESOURCE_PATH);
  const req = makeReq({
    params: { runId: 'run_a', interactionId: 'int_a' },
    body: { wsUrl: VALID_WS },
  });
  const res = makeRes();
  await runRoute(handlers, req, res);

  const serialized = JSON.stringify(res.payload);
  assert.equal(
    serialized.includes(VALID_WS),
    false,
    'response body must not contain the full wsUrl',
  );
  assert.equal(serialized.includes('/devtools/page/abc123XYZ'), false);
  registry.shutdown();
});

test('PUT also accepts ws_url (snake_case) and optional metadata fields', async () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  const app = makeFakeApp();
  registry.attachRoutes(app, mockAuth('dev_owner'));

  const handlers = app.findHandler('PUT', RESOURCE_PATH);
  const req = makeReq({
    params: { runId: 'run_a', interactionId: 'int_a' },
    body: {
      ws_url: VALID_WS,
      page_url: 'https://example.test/2fa',
      page_title: 'Two-factor',
      reason: '2fa',
    },
  });
  const res = makeRes();
  await runRoute(handlers, req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(registry.get({ runId: 'run_a', interactionId: 'int_a' }), VALID_WS);
  const [record] = registry.getByRun('run_a');
  assert.equal(record.pageUrl, 'https://example.test/2fa');
  assert.equal(record.pageTitle, 'Two-factor');
  assert.equal(record.reason, '2fa');
  registry.shutdown();
});

test('PUT accepts neko descriptor and does not echo auth metadata', async () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  const app = makeFakeApp();
  registry.attachRoutes(app, mockAuth('dev_owner'));

  const handlers = app.findHandler('PUT', RESOURCE_PATH);
  const req = makeReq({
    params: { runId: 'run_neko', interactionId: 'int_a' },
    body: {
      backend: 'neko',
      base_url: `${VALID_NEKO_BASE_URL_2}/`,
      auth: {
        scheme: 'bearer',
        token: 'route-secret-token',
      },
    },
  });
  const res = makeRes();
  await runRoute(handlers, req, res);

  assert.equal(res.statusCode, 200);
  assertNoRawBackendAuthority(res.payload);
  assert.deepEqual(registry.get({ runId: 'run_neko', interactionId: 'int_a' }), {
    backend: 'neko',
    base_url: VALID_NEKO_BASE_URL_2,
    auth: {
      scheme: 'bearer',
      token: 'route-secret-token',
    },
  });
  const serialized = JSON.stringify(res.payload);
  assert.equal(serialized.includes('route-secret-token'), false);
  assert.equal(serialized.includes(VALID_NEKO_BASE_URL_2), false);
  registry.shutdown();
});

test('PUT accepts nested neko target descriptor', async () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  const app = makeFakeApp();
  registry.attachRoutes(app, mockAuth('dev_owner'));

  const handlers = app.findHandler('PUT', RESOURCE_PATH);
  const req = makeReq({
    params: { runId: 'run_neko_nested', interactionId: 'int_a' },
    body: {
      target: {
        backend: 'neko',
        base_url: VALID_NEKO_BASE_URL,
      },
    },
  });
  const res = makeRes();
  await runRoute(handlers, req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(registry.get({ runId: 'run_neko_nested', interactionId: 'int_a' }), {
    backend: 'neko',
    base_url: VALID_NEKO_BASE_URL,
  });
  registry.shutdown();
});

test('POST accepts managed neko descriptor with lease metadata and omits CDP details', async () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  const app = makeFakeApp();
  registry.attachRoutes(app, mockAuth('dev_owner'));

  const handlers = app.findHandler('POST', RESOURCE_PATH);
  const req = makeReq({
    params: { runId: 'run_neko_managed', interactionId: 'int_a' },
    body: {
      backend: 'neko',
      descriptor: {
        backend: 'neko',
        base_url: VALID_NEKO_DOCKER_BASE_URL,
        lease_id: 'lease_123',
        profile_key: 'chatgpt:owner',
        surface_id: 'surface_static_1',
        start_url: 'https://example.test/login',
      },
    },
  });
  const res = makeRes();
  await runRoute(handlers, req, res);

  assert.equal(res.statusCode, 200);
  assertNoRawBackendAuthority(res.payload);
  const descriptor = registry.get({ runId: 'run_neko_managed', interactionId: 'int_a' });
  assert.deepEqual(descriptor, {
    backend: 'neko',
    base_url: VALID_NEKO_DOCKER_BASE_URL,
    lease_id: 'lease_123',
    profile_key: 'chatgpt:owner',
    surface_id: 'surface_static_1',
    start_url: 'https://example.test/login',
  });
  const serialized = JSON.stringify(descriptor);
  assert.equal(serialized.includes('cdp'), false);
  assert.equal(serialized.includes('9223'), false);
  registry.shutdown();
});

test('PUT same-value re-PUT succeeds with action=reaffirmed', async () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  const app = makeFakeApp();
  registry.attachRoutes(app, mockAuth('dev_owner'));

  const handlers = app.findHandler('PUT', RESOURCE_PATH);
  await runRoute(
    handlers,
    makeReq({ params: { runId: 'run_a', interactionId: 'int_a' }, body: { wsUrl: VALID_WS } }),
    makeRes(),
  );
  const res = makeRes();
  await runRoute(
    handlers,
    makeReq({ params: { runId: 'run_a', interactionId: 'int_a' }, body: { wsUrl: VALID_WS } }),
    res,
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.action, 'reaffirmed');
  registry.shutdown();
});

test('PUT different-value re-PUT replaces the record AND surfaces action=replaced', async () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  const app = makeFakeApp();
  registry.attachRoutes(app, mockAuth('dev_owner'));

  const handlers = app.findHandler('PUT', RESOURCE_PATH);
  await runRoute(
    handlers,
    makeReq({ params: { runId: 'run_a', interactionId: 'int_a' }, body: { wsUrl: VALID_WS } }),
    makeRes(),
  );
  const res = makeRes();
  await runRoute(
    handlers,
    makeReq({
      params: { runId: 'run_a', interactionId: 'int_a' },
      body: { wsUrl: VALID_WS_2, reason: 'oauth_popup' },
    }),
    res,
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.action, 'replaced');
  assert.equal(registry.get({ runId: 'run_a', interactionId: 'int_a' }), VALID_WS_2);
  registry.shutdown();
});

test('PUT surfaces non-loopback rejection as 400 run_target_non_loopback', async () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  const app = makeFakeApp();
  registry.attachRoutes(app, mockAuth('dev_owner'));

  const handlers = app.findHandler('PUT', RESOURCE_PATH);
  const req = makeReq({
    params: { runId: 'run_a', interactionId: 'int_a' },
    body: { wsUrl: 'ws://example.com:9222/devtools/page/abc' },
  });
  const res = makeRes();
  await runRoute(handlers, req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.error.code, 'run_target_non_loopback');
  // And the response message must not include the rejected URL or path.
  assert.equal(res.payload.error.message.includes('example.com'), false);
  assert.equal(res.payload.error.message.includes('/devtools/page/abc'), false);
  registry.shutdown();
});

test('DELETE 200 on owning device, 404 when not present', async () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  registry.register({
    runId: 'run_a',
    interactionId: 'int_a',
    wsUrl: VALID_WS,
    deviceId: 'dev_owner',
  });
  const app = makeFakeApp();
  registry.attachRoutes(app, mockAuth('dev_owner'));

  const handlers = app.findHandler('DELETE', RESOURCE_PATH);
  const req1 = makeReq({ params: { runId: 'run_a', interactionId: 'int_a' } });
  const res1 = makeRes();
  await runRoute(handlers, req1, res1);
  assert.equal(res1.statusCode, 200);
  assert.equal(res1.payload.run_id, 'run_a');
  assert.equal(res1.payload.interaction_id, 'int_a');

  // Second delete on the now-empty record should be 404.
  const req2 = makeReq({ params: { runId: 'run_a', interactionId: 'int_a' } });
  const res2 = makeRes();
  await runRoute(handlers, req2, res2);
  assert.equal(res2.statusCode, 404);
  assert.equal(res2.payload.error.code, 'not_found');
  registry.shutdown();
});

test('DELETE by non-owning device returns 404 (does not leak presence)', async () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  registry.register({
    runId: 'run_a',
    interactionId: 'int_a',
    wsUrl: VALID_WS,
    deviceId: 'dev_owner',
  });
  const app = makeFakeApp();
  registry.attachRoutes(app, mockAuth('dev_intruder'));

  const handlers = app.findHandler('DELETE', RESOURCE_PATH);
  const req = makeReq({ params: { runId: 'run_a', interactionId: 'int_a' } });
  const res = makeRes();
  await runRoute(handlers, req, res);

  assert.equal(res.statusCode, 404);
  // Record must still be intact.
  assert.equal(registry.get({ runId: 'run_a', interactionId: 'int_a' }), VALID_WS);
  registry.shutdown();
});

test('logging never contains the full wsUrl path', async () => {
  const logger = makeCapturedLogger();
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0, logger });
  const app = makeFakeApp();
  registry.attachRoutes(app, mockAuth('dev_owner'));

  const handlers = app.findHandler('PUT', RESOURCE_PATH);
  const req = makeReq({
    params: { runId: 'run_a', interactionId: 'int_a' },
    body: { wsUrl: VALID_WS, reason: 'login' },
  });
  const res = makeRes();
  await runRoute(handlers, req, res);

  // Also exercise unregister + an expiry sweep so all log paths are covered.
  registry.unregister({ runId: 'run_a', interactionId: 'int_a', deviceId: 'dev_owner' });

  const serialized = JSON.stringify(logger.entries);
  assert.equal(logger.entries.length > 0, true, 'should have logged at least once');
  assert.equal(
    serialized.includes('/devtools/page/abc123XYZ'),
    false,
    'log entries must not contain the page-target path',
  );
  assert.equal(serialized.includes(VALID_WS), false, 'log entries must not contain the full wsUrl');
  // Spot-check that the structured fields we DO want are present.
  const registerEntry = logger.entries.find((e) => e.msg === 'run_target_registered');
  assert.ok(registerEntry, 'registered log entry should exist');
  assert.equal(registerEntry.runId, 'run_a');
  assert.equal(registerEntry.interactionId, 'int_a');
  assert.equal(registerEntry.host, '127.0.0.1');
  assert.equal(registerEntry.port, '9222');
  assert.equal(registerEntry.deviceId, 'dev_owner');
  assert.equal(registerEntry.reason, 'login');
  registry.shutdown();
});

test('attachRoutes throws on missing app or middleware', () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  assert.throws(() => registry.attachRoutes(null, () => {}));
  assert.throws(() => registry.attachRoutes(makeFakeApp(), null));
  registry.shutdown();
});

// ─── per-run nonce: Mode-A in-process auth path ────────────────────────────

// Auth middleware that always rejects with 401 — used to prove the nonce
// path bypasses the device-exporter check entirely on success.
function rejectAuth(_req, res, _next) {
  res
    .status(401)
    .json({ error: { type: 'authentication_error', code: 'authentication_error', message: 'no creds' } });
}

function makeReqWithBearer({ params = {}, body = {}, bearer }) {
  return {
    params,
    body,
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  };
}

test('registerNonce + verifyNonce round-trips and clears on demand', () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  registry.registerNonce({ runId: 'run_a', nonce: 'super_secret_nonce_v1' });
  assert.equal(registry.verifyNonce({ runId: 'run_a', presentedToken: 'super_secret_nonce_v1' }), true);
  assert.equal(registry.verifyNonce({ runId: 'run_a', presentedToken: 'wrong' }), false);
  registry.clearNonce({ runId: 'run_a' });
  assert.equal(registry.verifyNonce({ runId: 'run_a', presentedToken: 'super_secret_nonce_v1' }), false);
  registry.shutdown();
});

test('verifyNonce returns false when runId or token is missing', () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  registry.registerNonce({ runId: 'run_a', nonce: 'tok' });
  assert.equal(registry.verifyNonce({ runId: '', presentedToken: 'tok' }), false);
  assert.equal(registry.verifyNonce({ runId: 'run_a', presentedToken: '' }), false);
  registry.shutdown();
});

test('verifyNonce is bound by runId (cross-run nonce reuse rejected)', () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  registry.registerNonce({ runId: 'run_a', nonce: 'nonce_A' });
  registry.registerNonce({ runId: 'run_b', nonce: 'nonce_B' });
  assert.equal(registry.verifyNonce({ runId: 'run_a', presentedToken: 'nonce_A' }), true);
  assert.equal(registry.verifyNonce({ runId: 'run_b', presentedToken: 'nonce_A' }), false, 'A nonce must not validate for B');
  assert.equal(registry.verifyNonce({ runId: 'run_a', presentedToken: 'nonce_B' }), false, 'B nonce must not validate for A');
  registry.shutdown();
});

test('registerNonce never stores the raw nonce in memory', () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  const raw = 'super_secret_nonce_v1';
  registry.registerNonce({ runId: 'run_a', nonce: raw });
  // The internal nonceHashes Map should hold a SHA-256 hex of the nonce,
  // not the raw value.
  const stored = registry._internal.nonceHashes.get('run_a');
  assert.ok(stored, 'nonce was registered');
  assert.notEqual(stored, raw, 'raw nonce must not be stored');
  assert.equal(stored.length, 64, 'stored value should be SHA-256 hex (64 chars)');
  assert.match(stored, /^[0-9a-f]{64}$/);
  registry.shutdown();
});

test('registerNonce throws on missing runId or nonce', () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  assert.throws(() => registry.registerNonce({ runId: '', nonce: 'x' }));
  assert.throws(() => registry.registerNonce({ runId: 'run_a', nonce: '' }));
  registry.shutdown();
});

test('clearNonce is idempotent', () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  registry.clearNonce({ runId: 'run_never_registered' }); // does not throw
  registry.registerNonce({ runId: 'run_a', nonce: 'tok' });
  registry.clearNonce({ runId: 'run_a' });
  registry.clearNonce({ runId: 'run_a' });
  assert.equal(registry.verifyNonce({ runId: 'run_a', presentedToken: 'tok' }), false);
  registry.shutdown();
});

test('shutdown clears the nonce store', () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  registry.registerNonce({ runId: 'run_a', nonce: 'tok' });
  registry.shutdown();
  assert.equal(registry._internal.nonceHashes.size, 0);
});

test('PUT: bearer matching the per-run nonce authenticates without device-exporter creds', async () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  registry.registerNonce({ runId: 'run_a', nonce: 'mode_a_nonce_v1' });
  const app = makeFakeApp();
  // Device-exporter middleware rejects everything; success here proves the
  // nonce path won.
  registry.attachRoutes(app, rejectAuth);

  const handlers = app.findHandler('PUT', RESOURCE_PATH);
  const req = makeReqWithBearer({
    params: { runId: 'run_a', interactionId: 'int_a' },
    body: { wsUrl: VALID_WS },
    bearer: 'mode_a_nonce_v1',
  });
  const res = makeRes();
  await runRoute(handlers, req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.run_id, 'run_a');
  assert.equal(res.payload.interaction_id, 'int_a');
  assert.equal(registry.get({ runId: 'run_a', interactionId: 'int_a' }), VALID_WS);
  registry.shutdown();
});

test('PUT: per-run nonce authenticates registrations for ANY interactionId in the same run', async () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  registry.registerNonce({ runId: 'run_a', nonce: 'shared_run_nonce' });
  const app = makeFakeApp();
  registry.attachRoutes(app, rejectAuth);
  const handlers = app.findHandler('PUT', RESOURCE_PATH);

  // First interaction.
  const res1 = makeRes();
  await runRoute(
    handlers,
    makeReqWithBearer({
      params: { runId: 'run_a', interactionId: 'int_first' },
      body: { wsUrl: VALID_WS },
      bearer: 'shared_run_nonce',
    }),
    res1,
  );
  assert.equal(res1.statusCode, 200);

  // Second interaction in the same run, same nonce.
  const res2 = makeRes();
  await runRoute(
    handlers,
    makeReqWithBearer({
      params: { runId: 'run_a', interactionId: 'int_second' },
      body: { wsUrl: VALID_WS_2 },
      bearer: 'shared_run_nonce',
    }),
    res2,
  );
  assert.equal(res2.statusCode, 200);
  assert.equal(registry.get({ runId: 'run_a', interactionId: 'int_first' }), VALID_WS);
  assert.equal(registry.get({ runId: 'run_a', interactionId: 'int_second' }), VALID_WS_2);
  registry.shutdown();
});

test('PUT: bearer for a DIFFERENT run does NOT authenticate (cross-run nonce rejected)', async () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  registry.registerNonce({ runId: 'run_a', nonce: 'nonce_A' });
  registry.registerNonce({ runId: 'run_b', nonce: 'nonce_B' });
  const app = makeFakeApp();
  registry.attachRoutes(app, rejectAuth);

  const handlers = app.findHandler('PUT', RESOURCE_PATH);
  // Try to register run_b's target using run_a's nonce.
  const req = makeReqWithBearer({
    params: { runId: 'run_b', interactionId: 'int_a' },
    body: { wsUrl: VALID_WS },
    bearer: 'nonce_A',
  });
  const res = makeRes();
  await runRoute(handlers, req, res);

  assert.equal(res.statusCode, 401);
  assert.equal(
    registry.get({ runId: 'run_b', interactionId: 'int_a' }),
    null,
    'run_b must not get a target registered',
  );
  registry.shutdown();
});

test('PUT: a wrong bearer falls through to the device-exporter middleware (which rejects)', async () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  registry.registerNonce({ runId: 'run_a', nonce: 'right_nonce' });
  const app = makeFakeApp();
  registry.attachRoutes(app, rejectAuth);

  const handlers = app.findHandler('PUT', RESOURCE_PATH);
  const req = makeReqWithBearer({
    params: { runId: 'run_a', interactionId: 'int_a' },
    body: { wsUrl: VALID_WS },
    bearer: 'wrong_nonce',
  });
  const res = makeRes();
  await runRoute(handlers, req, res);

  assert.equal(res.statusCode, 401);
  assert.equal(registry.get({ runId: 'run_a', interactionId: 'int_a' }), null);
  registry.shutdown();
});

test('DELETE: nonce-authenticated unregister works (synthetic deviceId is bound to the run)', async () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  registry.registerNonce({ runId: 'run_a', nonce: 'tok_a' });
  const app = makeFakeApp();
  registry.attachRoutes(app, rejectAuth);

  // Register via the nonce path.
  const putHandlers = app.findHandler('PUT', RESOURCE_PATH);
  await runRoute(
    putHandlers,
    makeReqWithBearer({
      params: { runId: 'run_a', interactionId: 'int_a' },
      body: { wsUrl: VALID_WS },
      bearer: 'tok_a',
    }),
    makeRes(),
  );
  assert.equal(registry.get({ runId: 'run_a', interactionId: 'int_a' }), VALID_WS);

  // Unregister via the same nonce.
  const delHandlers = app.findHandler('DELETE', RESOURCE_PATH);
  const res = makeRes();
  await runRoute(
    delHandlers,
    makeReqWithBearer({
      params: { runId: 'run_a', interactionId: 'int_a' },
      bearer: 'tok_a',
    }),
    res,
  );
  assert.equal(res.statusCode, 200);
  assert.equal(registry.get({ runId: 'run_a', interactionId: 'int_a' }), null);
  registry.shutdown();
});

test('PUT: device-exporter creds still work when no nonce is presented (Mode B unchanged)', async () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  // No nonce registered. Device-exporter middleware stamps the device id
  // and passes through.
  const app = makeFakeApp();
  registry.attachRoutes(app, mockAuth('dev_owner'));

  const handlers = app.findHandler('PUT', RESOURCE_PATH);
  // Note: no Authorization header — just lets the device-exporter mock
  // middleware stamp the deviceId, exactly the Mode-B path.
  const req = makeReq({
    params: { runId: 'run_a', interactionId: 'int_a' },
    body: { wsUrl: VALID_WS },
  });
  const res = makeRes();
  await runRoute(handlers, req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(registry.get({ runId: 'run_a', interactionId: 'int_a' }), VALID_WS);
  registry.shutdown();
});

test('logging never carries the raw nonce', () => {
  const logger = makeCapturedLogger();
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0, logger });
  const raw = 'unique_marker_nonce_value_xyz';
  registry.registerNonce({ runId: 'run_a', nonce: raw });
  registry.verifyNonce({ runId: 'run_a', presentedToken: raw });
  registry.clearNonce({ runId: 'run_a' });
  const serialized = JSON.stringify(logger.entries);
  assert.equal(serialized.includes(raw), false, 'raw nonce must never appear in logs');
  registry.shutdown();
});
