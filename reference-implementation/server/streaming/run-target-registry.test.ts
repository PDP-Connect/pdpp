// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
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
import test from "node:test";

import { createRunTargetRegistry } from "./run-target-registry.ts";

// ─── helpers ────────────────────────────────────────────────────────────

type JsonRecord = Record<string, unknown>;
interface TestRequest {
  body: JsonRecord;
  deviceExporter?: { deviceId: string };
  headers?: Record<string, string>;
  params: Record<string, string>;
}
interface TestResponse {
  json: (body: JsonRecord) => TestResponse;
  readonly payload: JsonRecord;
  status: (code: number) => TestResponse;
  readonly statusCode: number;
}
type TestNext = (error?: unknown) => void | Promise<void>;
type TestHandler = (request: TestRequest, response: TestResponse, next: TestNext) => unknown;
type NekoApproval = NonNullable<NonNullable<Parameters<typeof createRunTargetRegistry>[0]>["isNekoDescriptorApproved"]>;
type NekoApprovalDescriptor = Parameters<NekoApproval>[0];
type NekoApprovalContext = Parameters<NekoApproval>[1];
interface CapturedRoute {
  handlers: TestHandler[];
  method: "DELETE" | "POST" | "PUT";
  path: string;
}

const RAW_WS_URL_PATTERN = /ws:\/\/|wss:\/\//i;
const RAW_NEKO_URL_PATTERN = /https?:\/\/(?:127\.0\.0\.1|localhost|neko)(?::\d+)?/i;
const RAW_CDP_PATH_PATTERN = /\/json\/version|\/devtools\/browser/i;
const RAW_DESCRIPTOR_KEY_PATTERN = /base_url|cdp_http_url|cdpWsUrl|cdpHttpUrl|webSocketDebuggerUrl/i;
const RAW_INFRASTRUCTURE_AUTHORITY_PATTERN = /docker\.sock|allocatorCredentials/i;
const RUN_ID_PATTERN = /runId/;
const INTERACTION_ID_PATTERN = /interactionId/;
const NONCE_HASH_PATTERN = /^[0-9a-f]{64}$/;

function hasErrorCode(value: unknown, code: string): boolean {
  return value instanceof Error && (value as Error & { code?: string }).code === code;
}

function hasErrorStatus(value: unknown, status: number): boolean {
  return value instanceof Error && (value as Error & { status?: number }).status === status;
}

function requiredValue<T>(value: T | undefined): T {
  assert.ok(value);
  return value;
}

function objectRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function assertNoRawBackendAuthority(value: unknown): void {
  const serialized = JSON.stringify(value);
  assert.equal(RAW_WS_URL_PATTERN.test(serialized), false);
  assert.equal(RAW_NEKO_URL_PATTERN.test(serialized), false);
  assert.equal(RAW_CDP_PATH_PATTERN.test(serialized), false);
  assert.equal(RAW_DESCRIPTOR_KEY_PATTERN.test(serialized), false);
  assert.equal(RAW_INFRASTRUCTURE_AUTHORITY_PATTERN.test(serialized), false);
}

function makeFakeApp() {
  const routes: CapturedRoute[] = [];
  return {
    delete(path: string, ...args: TestHandler[]) {
      routes.push({ handlers: args, method: "DELETE", path });
    },
    findHandler(method: CapturedRoute["method"], path: string): TestHandler[] {
      const route = routes.find((r) => r.method === method && r.path === path);
      if (!route) {
        throw new Error(`No ${method} ${path} registered`);
      }
      return route.handlers;
    },
    post(path: string, ...args: TestHandler[]) {
      routes.push({ handlers: args, method: "POST", path });
    },
    put(path: string, ...args: TestHandler[]) {
      routes.push({ handlers: args, method: "PUT", path });
    },
    routes,
  };
}

function makeReq({
  params = {},
  body = {},
  deviceId = null,
}: {
  body?: JsonRecord;
  deviceId?: string | null;
  params?: Record<string, string>;
} = {}): TestRequest {
  return {
    body,
    params,
    ...(deviceId ? { deviceExporter: { deviceId } } : {}),
  };
}

function makeRes(): TestResponse {
  let statusCode = 200;
  let payload: JsonRecord = {};
  const res = {
    json(body: JsonRecord) {
      payload = body;
      return res;
    },
    get payload() {
      return payload;
    },
    status(code: number) {
      statusCode = code;
      return res;
    },
    get statusCode() {
      return statusCode;
    },
  };
  return res;
}

function makeCapturedLogger() {
  const entries: (JsonRecord & { level: string })[] = [];
  function record(level: string): (data: JsonRecord) => void {
    return (data: JsonRecord) => {
      entries.push({ level, ...data });
    };
  }
  return {
    debug: record("debug"),
    entries,
    error: record("error"),
    info: record("info"),
    warn: record("warn"),
  };
}

// Mock auth middleware: stamps req.deviceExporter = { deviceId } and
// continues. The deviceId is provided per-call via `mockAuth(deviceId)`.
function mockAuth(deviceId: string): TestHandler {
  return (req: TestRequest, _res: TestResponse, next: TestNext) => {
    req.deviceExporter = { deviceId };
    next();
  };
}

// Run a request through a (middleware, handler) pair. Mirrors what the
// Fastify wrapper does, but stays in-process so tests can introspect the
// captured response.
async function runRoute(handlers: TestHandler[], req: TestRequest, res: TestResponse): Promise<TestResponse> {
  let i = 0;
  async function next(err?: unknown): Promise<void> {
    if (err) {
      throw err;
    }
    const fn = handlers[i];
    i += 1;
    if (!fn) {
      return;
    }
    await fn(req, res, next);
  }
  await next();
  return res;
}

const RESOURCE_PATH = "/admin/runs/:runId/interactions/:interactionId/streaming-target";
const VALID_WS = "ws://127.0.0.1:9222/devtools/page/abc123XYZ";
const VALID_WS_2 = "ws://127.0.0.1:9222/devtools/page/xyz789ABC";
const VALID_NEKO_BASE_URL = "http://127.0.0.1:6080";
const VALID_NEKO_BASE_URL_2 = "https://localhost:6081/neko";
const VALID_NEKO_DOCKER_BASE_URL = "http://neko:8080/neko";

// ─── unit-level: register / get / unregister ────────────────────────────

test("register stores a record retrievable via get by composite key", () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  const result = registry.register({
    deviceId: "dev_1",
    interactionId: "int_a",
    runId: "run_test_1",
    wsUrl: VALID_WS,
  });
  assert.equal(result.runId, "run_test_1");
  assert.equal(result.interactionId, "int_a");
  assert.equal(result.action, "registered");
  assert.ok(Number.isFinite(result.expiry));
  assert.equal(registry.get({ interactionId: "int_a", runId: "run_test_1" }), VALID_WS);
  registry.shutdown();
});

test("register accepts ws_url and preserves CDP resolver string compatibility", () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  registry.register({
    deviceId: "dev_1",
    interactionId: "int_a",
    runId: "run_test_1",
    ws_url: VALID_WS,
  });
  assert.equal(registry.get({ interactionId: "int_a", runId: "run_test_1" }), VALID_WS);
  registry.shutdown();
});

test("register stores a normalized neko descriptor retrievable via get", () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  registry.register({
    auth: {
      scheme: "bearer",
      token: "secret-token-for-neko",
    },
    backend: "neko",
    base_url: `${VALID_NEKO_BASE_URL}/`,
    deviceId: "dev_1",
    interactionId: "int_a",
    runId: "run_neko_1",
  });

  assert.deepEqual(registry.get({ interactionId: "int_a", runId: "run_neko_1" }), {
    auth: {
      scheme: "bearer",
      token: "secret-token-for-neko",
    },
    backend: "neko",
    base_url: VALID_NEKO_BASE_URL,
  });
  const record = requiredValue(registry.getByRun("run_neko_1")[0]);
  assert.equal(record.backend, "neko");
  assert.equal(record.baseUrl, VALID_NEKO_BASE_URL);
  assert.equal((record.descriptor.auth as { token?: unknown } | undefined)?.token, "secret-token-for-neko");
  registry.shutdown();
});

test("register accepts the private Docker Compose n.eko service host", () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  registry.register({
    backend: "neko",
    base_url: `${VALID_NEKO_DOCKER_BASE_URL}/`,
    deviceId: "dev_1",
    interactionId: "int_a",
    runId: "run_neko_docker",
  });

  assert.deepEqual(registry.get({ interactionId: "int_a", runId: "run_neko_docker" }), {
    backend: "neko",
    base_url: VALID_NEKO_DOCKER_BASE_URL,
  });
  registry.shutdown();
});

test("register preserves private Docker n.eko CDP HTTP URL on descriptors", () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  registry.register({
    backend: "neko",
    base_url: VALID_NEKO_DOCKER_BASE_URL,
    cdp_http_url: "http://neko:9223",
    deviceId: "dev_1",
    interactionId: "int_a",
    runId: "run_neko_docker_cdp",
  });

  assert.deepEqual(registry.get({ interactionId: "int_a", runId: "run_neko_docker_cdp" }), {
    backend: "neko",
    base_url: VALID_NEKO_DOCKER_BASE_URL,
    cdp_http_url: "http://neko:9223/",
  });
  registry.shutdown();
});

test("cross-interaction isolation: registering for (run, intA) does not surface for (run, intB)", () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  registry.register({
    deviceId: "dev_1",
    interactionId: "int_a",
    runId: "run_x",
    wsUrl: VALID_WS,
  });
  // The same runId paired with a different interactionId must be a miss,
  // even though the wsUrl exists in the registry. This proves we are
  // genuinely keyed by the composite, not by `runId` with a fallback.
  assert.equal(registry.get({ interactionId: "int_b", runId: "run_x" }), null);
  // Sanity: the original is still there.
  assert.equal(registry.get({ interactionId: "int_a", runId: "run_x" }), VALID_WS);
  registry.shutdown();
});

test("cross-run isolation: registering for (runA, int) does not surface for (runB, int)", () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  registry.register({
    deviceId: "dev_1",
    interactionId: "int_shared_id",
    runId: "run_a",
    wsUrl: VALID_WS,
  });
  assert.equal(
    registry.get({ interactionId: "int_shared_id", runId: "run_b" }),
    null,
    "a different runId with the same interactionId must miss"
  );
  registry.shutdown();
});

test("register requires runId and interactionId", () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  assert.throws(
    () =>
      registry.register({
        deviceId: "dev_1",
        interactionId: "int_a",
        runId: "",
        wsUrl: VALID_WS,
      }),
    (err) => hasErrorCode(err, "run_target_invalid_url") && RUN_ID_PATTERN.test(String(err))
  );
  assert.throws(
    () =>
      registry.register({
        deviceId: "dev_1",
        interactionId: "",
        runId: "run_a",
        wsUrl: VALID_WS,
      }),
    (err) => hasErrorCode(err, "run_target_invalid_url") && INTERACTION_ID_PATTERN.test(String(err))
  );
  registry.shutdown();
});

test("register rejects non-loopback hosts", () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  assert.throws(
    () =>
      registry.register({
        deviceId: "dev_1",
        interactionId: "int_a",
        runId: "run_a",
        wsUrl: "ws://example.com:9222/devtools/page/abc",
      }),
    (err) => hasErrorCode(err, "run_target_non_loopback")
  );
  // Public IP — also rejected.
  assert.throws(
    () =>
      registry.register({
        deviceId: "dev_1",
        interactionId: "int_a",
        runId: "run_b",
        wsUrl: "ws://10.0.0.5:9222/devtools/page/abc",
      }),
    (err) => hasErrorCode(err, "run_target_non_loopback")
  );
  registry.shutdown();
});

test("register accepts the private Compose host `neko` as a wsUrl host", () => {
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
  const wsUrl = "ws://neko:9223/devtools/page/AFFF11F8FEDF0CB0C8764672D4A67648";
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  registry.register({
    deviceId: "dev_1",
    interactionId: "int_neko_remote",
    runId: "run_neko_remote",
    wsUrl,
  });
  const got = registry.get({ interactionId: "int_neko_remote", runId: "run_neko_remote" });
  assert.equal(got, wsUrl);
  registry.shutdown();
});

test("register rejects malformed URLs", () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  assert.throws(
    () =>
      registry.register({
        deviceId: "dev_1",
        interactionId: "int_a",
        runId: "run_a",
        wsUrl: "not-a-url",
      }),
    (err) => hasErrorCode(err, "run_target_invalid_url")
  );
  registry.shutdown();
});

test("register rejects non-ws schemes", () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  assert.throws(
    () =>
      registry.register({
        deviceId: "dev_1",
        interactionId: "int_a",
        runId: "run_a",
        wsUrl: "http://127.0.0.1:9222/devtools/page/abc",
      }),
    (err) => hasErrorCode(err, "run_target_invalid_url") && String(err).includes("scheme must be ws: or wss:")
  );
  registry.shutdown();
});

test("register rejects neko descriptors with non-loopback base_url", () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  assert.throws(
    () =>
      registry.register({
        backend: "neko",
        base_url: "http://example.com:6080",
        deviceId: "dev_1",
        interactionId: "int_a",
        runId: "run_a",
      }),
    (err) => hasErrorCode(err, "run_target_non_loopback")
  );
  registry.shutdown();
});

test("register rejects unapproved non-private n.eko CDP HTTP URL", () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  assert.throws(
    () =>
      registry.register({
        backend: "neko",
        base_url: VALID_NEKO_DOCKER_BASE_URL,
        cdp_http_url: "http://example.com:9223/",
        deviceId: "dev_1",
        interactionId: "int_a",
        runId: "run_a",
      }),
    (err) => hasErrorCode(err, "run_target_non_loopback")
  );
  registry.shutdown();
});

test("register accepts dynamic managed n.eko descriptor approved by lease metadata", () => {
  const approved: { context: NekoApprovalContext; descriptor: NekoApprovalDescriptor }[] = [];
  const registry = createRunTargetRegistry({
    isNekoDescriptorApproved(descriptor, context) {
      approved.push({ context, descriptor });
      return (
        context.runId === "run_dynamic_1" &&
        context.interactionId === "int_a" &&
        descriptor.surface_id === "surf_1" &&
        descriptor.lease_id === "lease_1" &&
        descriptor.profile_key === "profile_1" &&
        descriptor.interaction_id === "int_a" &&
        descriptor.base_url === "http://10.88.0.4:6080/neko" &&
        descriptor.cdp_http_url === "http://10.88.0.4:9223/cdp/" &&
        context.cdpHost === "10.88.0.4" &&
        context.cdpPort === "9223"
      );
    },
    sweepIntervalMs: 0,
  });

  registry.register({
    backend: "neko",
    base_url: "http://10.88.0.4:6080/neko/",
    descriptor: {
      backend: "neko",
      base_url: "http://10.88.0.4:6080/neko/",
      cdp_http_url: "http://10.88.0.4:9223/cdp",
      interaction_id: "int_a",
      lease_id: "lease_1",
      profile_key: "profile_1",
      surface_id: "surf_1",
    },
    deviceId: "dev_1",
    interactionId: "int_a",
    runId: "run_dynamic_1",
  });

  assert.deepEqual(registry.get({ interactionId: "int_a", runId: "run_dynamic_1" }), {
    backend: "neko",
    base_url: "http://10.88.0.4:6080/neko",
    cdp_http_url: "http://10.88.0.4:9223/cdp/",
    interaction_id: "int_a",
    lease_id: "lease_1",
    profile_key: "profile_1",
    surface_id: "surf_1",
  });
  assert.equal(approved.length, 1);
  registry.shutdown();
});

test("register rejects managed n.eko descriptor for the wrong interaction when approval is interaction-exact", () => {
  const registry = createRunTargetRegistry({
    isNekoDescriptorApproved(descriptor, context) {
      return descriptor.interaction_id === context.interactionId;
    },
    sweepIntervalMs: 0,
  });

  assert.throws(
    () =>
      registry.register({
        backend: "neko",
        descriptor: {
          backend: "neko",
          base_url: "http://10.88.0.4:6080/neko",
          interaction_id: "int_b",
          lease_id: "lease_1",
          profile_key: "profile_1",
          surface_id: "surf_1",
        },
        deviceId: "dev_1",
        interactionId: "int_a",
        runId: "run_dynamic_1",
      }),
    (err) => hasErrorCode(err, "run_target_non_loopback")
  );
  registry.shutdown();
});

test("register rejects a managed surface settle endpoint from a foreign origin", () => {
  const registry = createRunTargetRegistry({
    isNekoDescriptorApproved: () => true,
    sweepIntervalMs: 0,
  });

  assert.throws(
    () =>
      registry.register({
        backend: "neko",
        descriptor: {
          backend: "neko",
          base_url: "http://10.88.0.4:6080/neko",
          cdp_http_url: "http://10.88.0.4:9223/cdp",
          lease_id: "lease_1",
          surface_id: "surf_1",
          window_settle_endpoint: "http://foreign.example:9223/pdpp/window-settle",
        },
        deviceId: "dev_1",
        interactionId: "int_a",
        runId: "run_dynamic_1",
      }),
    (err) => hasErrorCode(err, "run_target_window_settle_origin_mismatch")
  );
  registry.shutdown();
});

test("register accepts the managed surface settle endpoint derived from its CDP origin", () => {
  const registry = createRunTargetRegistry({
    isNekoDescriptorApproved: () => true,
    sweepIntervalMs: 0,
  });

  registry.register({
    backend: "neko",
    descriptor: {
      backend: "neko",
      base_url: "http://10.88.0.4:6080/neko",
      cdp_http_url: "http://10.88.0.4:9223/cdp",
      lease_id: "lease_1",
      surface_id: "surf_1",
      window_settle_endpoint: "http://10.88.0.4:9223/pdpp/window-settle",
    },
    deviceId: "dev_1",
    interactionId: "int_a",
    runId: "run_dynamic_1",
  });

  const target = registry.get({ interactionId: "int_a", runId: "run_dynamic_1" });
  assert.ok(target && typeof target !== "string");
  assert.equal(target.window_settle_endpoint, "http://10.88.0.4:9223/pdpp/window-settle");
  registry.shutdown();
});

test("register rejects neko descriptors with non-http base_url schemes", () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  assert.throws(
    () =>
      registry.register({
        backend: "neko",
        base_url: "ws://127.0.0.1:6080",
        deviceId: "dev_1",
        interactionId: "int_a",
        runId: "run_a",
      }),
    (err) => hasErrorCode(err, "run_target_invalid_url") && String(err).includes("scheme must be http: or https:")
  );
  registry.shutdown();
});

test("register accepts wss: loopback URLs", () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  const wssUrl = "wss://localhost:9222/devtools/page/xyz";
  registry.register({
    deviceId: "dev_1",
    interactionId: "int_a",
    runId: "run_a",
    wsUrl: wssUrl,
  });
  assert.equal(registry.get({ interactionId: "int_a", runId: "run_a" }), wssUrl);
  registry.shutdown();
});

test("register stores optional metadata fields and they survive in getByRun()", () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  registry.register({
    deviceId: "dev_1",
    interactionId: "int_a",
    pageTitle: "Sign in to Example",
    pageUrl: "https://example.test/login",
    reason: "captcha",
    runId: "run_a",
    wsUrl: VALID_WS,
  });
  const records = registry.getByRun("run_a");
  assert.equal(records.length, 1);
  const record = requiredValue(records[0]);
  assert.equal(record.runId, "run_a");
  assert.equal(record.interactionId, "int_a");
  assert.equal(record.pageUrl, "https://example.test/login");
  assert.equal(record.pageTitle, "Sign in to Example");
  assert.equal(record.reason, "captcha");
  assert.equal(typeof record.registeredAt, "string");
  registry.shutdown();
});

test("getByRun returns multiple interactions for a single run", () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  registry.register({
    deviceId: "dev_1",
    interactionId: "int_a",
    runId: "run_a",
    wsUrl: VALID_WS,
  });
  registry.register({
    deviceId: "dev_1",
    interactionId: "int_b",
    runId: "run_a",
    wsUrl: VALID_WS_2,
  });
  const records = registry.getByRun("run_a");
  assert.equal(records.length, 2);
  const interactionIds = records.map((r) => r.interactionId).sort((a, b) => a.localeCompare(b));
  assert.deepEqual(interactionIds, ["int_a", "int_b"]);
  registry.shutdown();
});

test("unregister by wrong deviceId returns false and leaves the record", () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  registry.register({
    deviceId: "dev_owner",
    interactionId: "int_a",
    runId: "run_a",
    wsUrl: VALID_WS,
  });
  const removed = registry.unregister({
    deviceId: "dev_intruder",
    interactionId: "int_a",
    runId: "run_a",
  });
  assert.equal(removed, false);
  assert.equal(registry.get({ interactionId: "int_a", runId: "run_a" }), VALID_WS, "record should still exist");
  registry.shutdown();
});

test("unregister by correct deviceId removes only the targeted (run, interaction)", () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  registry.register({
    deviceId: "dev_owner",
    interactionId: "int_a",
    runId: "run_a",
    wsUrl: VALID_WS,
  });
  registry.register({
    deviceId: "dev_owner",
    interactionId: "int_b",
    runId: "run_a",
    wsUrl: VALID_WS_2,
  });
  const removed = registry.unregister({
    deviceId: "dev_owner",
    interactionId: "int_a",
    runId: "run_a",
  });
  assert.equal(removed, true);
  assert.equal(registry.get({ interactionId: "int_a", runId: "run_a" }), null);
  // Sibling interaction is untouched.
  assert.equal(registry.get({ interactionId: "int_b", runId: "run_a" }), VALID_WS_2);
  registry.shutdown();
});

test("forceUnregister drops an entry regardless of the registered deviceId", () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  registry.register({
    deviceId: "dev_owner",
    interactionId: "int_a",
    runId: "run_a",
    wsUrl: VALID_WS,
  });
  const removed = registry.forceUnregister({
    interactionId: "int_a",
    runId: "run_a",
  });
  assert.equal(removed, true);
  assert.equal(registry.get({ interactionId: "int_a", runId: "run_a" }), null);
  registry.shutdown();
});

test("forceUnregister is idempotent: calling on a non-existent key returns false", () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  const removed = registry.forceUnregister({
    interactionId: "int_never",
    runId: "run_never_registered",
  });
  assert.equal(removed, false);
  registry.shutdown();
});

test("forceUnregister removes only the targeted (run, interaction)", () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  registry.register({
    deviceId: "dev_owner",
    interactionId: "int_a",
    runId: "run_a",
    wsUrl: VALID_WS,
  });
  registry.register({
    deviceId: "dev_owner",
    interactionId: "int_b",
    runId: "run_a",
    wsUrl: VALID_WS_2,
  });
  const removed = registry.forceUnregister({
    interactionId: "int_a",
    runId: "run_a",
  });
  assert.equal(removed, true);
  assert.equal(registry.get({ interactionId: "int_a", runId: "run_a" }), null);
  // Sibling is untouched.
  assert.equal(registry.get({ interactionId: "int_b", runId: "run_a" }), VALID_WS_2);
  registry.shutdown();
});

test("forceUnregister logs at info level when dropping an entry", () => {
  const logger = makeCapturedLogger();
  const registry = createRunTargetRegistry({ logger, sweepIntervalMs: 0 });
  registry.register({
    deviceId: "dev_owner",
    interactionId: "int_a",
    runId: "run_a",
    wsUrl: VALID_WS,
  });
  registry.forceUnregister({
    interactionId: "int_a",
    runId: "run_a",
  });
  const forceUnregLog = logger.entries.find((e) => e.msg === "run_target_force_unregistered");
  assert.ok(forceUnregLog, "should have logged run_target_force_unregistered");
  assert.equal(forceUnregLog.level, "info");
  assert.equal(forceUnregLog.runId, "run_a");
  assert.equal(forceUnregLog.interactionId, "int_a");
  registry.shutdown();
});

test("forceUnregister with empty runId or interactionId returns false", () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  assert.equal(
    registry.forceUnregister({
      interactionId: "int_a",
      runId: "",
    }),
    false
  );
  assert.equal(
    registry.forceUnregister({
      interactionId: "",
      runId: "run_a",
    }),
    false
  );
  registry.shutdown();
});

test("register by a different device on a still-live record is rejected with 409 code", () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  registry.register({
    deviceId: "dev_owner",
    interactionId: "int_a",
    runId: "run_a",
    wsUrl: VALID_WS,
  });
  assert.throws(
    () =>
      registry.register({
        deviceId: "dev_intruder",
        interactionId: "int_a",
        runId: "run_a",
        wsUrl: VALID_WS,
      }),
    (err) => hasErrorCode(err, "run_target_already_registered_other_device") && hasErrorStatus(err, 409)
  );
  registry.shutdown();
});

test("idempotent re-register: same device + same wsUrl returns action=reaffirmed and emits no log", () => {
  const logger = makeCapturedLogger();
  const registry = createRunTargetRegistry({ logger, sweepIntervalMs: 0 });
  registry.register({
    deviceId: "dev_owner",
    interactionId: "int_a",
    runId: "run_a",
    wsUrl: VALID_WS,
  });
  const firstRegisters = logger.entries.filter((e) => e.msg === "run_target_registered").length;

  const result = registry.register({
    deviceId: "dev_owner",
    interactionId: "int_a",
    runId: "run_a",
    wsUrl: VALID_WS,
  });
  assert.equal(result.action, "reaffirmed");
  // No new register/replace log line for the silent retry.
  const afterRegisters = logger.entries.filter((e) => e.msg === "run_target_registered").length;
  const afterReplaces = logger.entries.filter((e) => e.msg === "run_target_replaced").length;
  assert.equal(afterRegisters, firstRegisters);
  assert.equal(afterReplaces, 0);
  registry.shutdown();
});

test("different-value re-register: same device + different wsUrl REPLACES and emits a warn log", () => {
  const logger = makeCapturedLogger();
  const registry = createRunTargetRegistry({ logger, sweepIntervalMs: 0 });
  registry.register({
    deviceId: "dev_owner",
    interactionId: "int_a",
    runId: "run_a",
    wsUrl: VALID_WS,
  });

  const result = registry.register({
    deviceId: "dev_owner",
    interactionId: "int_a",
    reason: "page_navigated",
    runId: "run_a",
    wsUrl: VALID_WS_2,
  });
  assert.equal(result.action, "replaced");
  assert.equal(registry.get({ interactionId: "int_a", runId: "run_a" }), VALID_WS_2);

  const replaceLog = logger.entries.find((e) => e.msg === "run_target_replaced");
  assert.ok(replaceLog, "a warn-level run_target_replaced log entry should be emitted");
  assert.equal(replaceLog.level, "warn");
  assert.equal(replaceLog.runId, "run_a");
  assert.equal(replaceLog.interactionId, "int_a");
  assert.equal(replaceLog.reason, "page_navigated");
  // Diagnostic warning must NOT include the wsUrl path.
  const serialized = JSON.stringify(logger.entries);
  assert.equal(serialized.includes("/devtools/page/"), false);
  registry.shutdown();
});

test("neko registration logs backend/host/port but never auth metadata", () => {
  const logger = makeCapturedLogger();
  const registry = createRunTargetRegistry({ logger, sweepIntervalMs: 0 });
  registry.register({
    auth: {
      token: "log-secret-token",
    },
    backend: "neko",
    base_url: "http://127.0.0.1:6080/session-secret-path",
    deviceId: "dev_owner",
    interactionId: "int_a",
    runId: "run_neko",
  });

  const registerLog = logger.entries.find((e) => e.msg === "run_target_registered");
  assert.ok(registerLog, "a run_target_registered log entry should be emitted");
  assert.equal(registerLog.backend, "neko");
  assert.equal(registerLog.host, "127.0.0.1");
  assert.equal(registerLog.port, "6080");
  const serialized = JSON.stringify(logger.entries);
  assert.equal(serialized.includes("log-secret-token"), false);
  assert.equal(serialized.includes("session-secret-path"), false);
  registry.shutdown();
});

test("TTL expiry causes get to return null and removes only the expired record", () => {
  let t = 1_000_000;
  const registry = createRunTargetRegistry({
    now: () => t,
    sweepIntervalMs: 0,
    ttlMs: 100,
  });
  registry.register({
    deviceId: "dev_1",
    interactionId: "int_a",
    runId: "run_a",
    wsUrl: VALID_WS,
  });
  // A second composite key, registered "later", should outlive the first.
  t += 50;
  registry.register({
    deviceId: "dev_1",
    interactionId: "int_b",
    runId: "run_a",
    wsUrl: VALID_WS_2,
  });
  assert.equal(registry.get({ interactionId: "int_a", runId: "run_a" }), VALID_WS);
  assert.equal(registry.get({ interactionId: "int_b", runId: "run_a" }), VALID_WS_2);
  // Move past int_a's expiry but not int_b's.
  t += 60;
  assert.equal(registry.get({ interactionId: "int_a", runId: "run_a" }), null, "expired record should be evicted");
  // The other interaction is still present.
  assert.equal(registry.get({ interactionId: "int_b", runId: "run_a" }), VALID_WS_2);
  // After eviction the internal map should not still hold it.
  assert.equal(registry._internal.records.has("run_a::int_a"), false);
  registry.shutdown();
});

// ─── route-level ────────────────────────────────────────────────────────

test("route handler returns 401 if no auth middleware passes", async () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  const app = makeFakeApp();
  // Auth middleware that mimics the real device-exporter rejection: writes
  // a 401 envelope and does NOT call next().
  const reject401: TestHandler = (_req, reply, _next) => {
    reply
      .status(401)
      .json({ error: { code: "authentication_error", message: "no creds", type: "authentication_error" } });
  };
  registry.attachRoutes(app, reject401);

  const handlers = app.findHandler("PUT", RESOURCE_PATH);
  const req = makeReq({
    body: { wsUrl: VALID_WS },
    params: { interactionId: "int_a", runId: "run_a" },
  });
  const res = makeRes();
  await runRoute(handlers, req, res);

  assert.equal(res.statusCode, 401);
  assert.equal(objectRecord(res.payload.error).code, "authentication_error");
  assert.equal(registry.get({ interactionId: "int_a", runId: "run_a" }), null, "no record should be created");
  registry.shutdown();
});

test("PUT returns 200 + { run_id, interaction_id, expiry, action } on successful register", async () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  const app = makeFakeApp();
  registry.attachRoutes(app, mockAuth("dev_owner"));

  const handlers = app.findHandler("PUT", RESOURCE_PATH);
  const req = makeReq({
    body: { wsUrl: VALID_WS },
    params: { interactionId: "int_a", runId: "run_a" },
  });
  const res = makeRes();
  await runRoute(handlers, req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.run_id, "run_a");
  assert.equal(res.payload.interaction_id, "int_a");
  assert.equal(res.payload.action, "registered");
  assert.ok(Number.isFinite(res.payload.expiry), "response includes expiry");
  assert.equal(registry.get({ interactionId: "int_a", runId: "run_a" }), VALID_WS);
  registry.shutdown();
});

test("PUT does NOT echo wsUrl back in the response", async () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  const app = makeFakeApp();
  registry.attachRoutes(app, mockAuth("dev_owner"));

  const handlers = app.findHandler("PUT", RESOURCE_PATH);
  const req = makeReq({
    body: { wsUrl: VALID_WS },
    params: { interactionId: "int_a", runId: "run_a" },
  });
  const res = makeRes();
  await runRoute(handlers, req, res);

  const serialized = JSON.stringify(res.payload);
  assert.equal(serialized.includes(VALID_WS), false, "response body must not contain the full wsUrl");
  assert.equal(serialized.includes("/devtools/page/abc123XYZ"), false);
  registry.shutdown();
});

test("PUT also accepts ws_url (snake_case) and optional metadata fields", async () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  const app = makeFakeApp();
  registry.attachRoutes(app, mockAuth("dev_owner"));

  const handlers = app.findHandler("PUT", RESOURCE_PATH);
  const req = makeReq({
    body: {
      page_title: "Two-factor",
      page_url: "https://example.test/2fa",
      reason: "2fa",
      ws_url: VALID_WS,
    },
    params: { interactionId: "int_a", runId: "run_a" },
  });
  const res = makeRes();
  await runRoute(handlers, req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(registry.get({ interactionId: "int_a", runId: "run_a" }), VALID_WS);
  const record = requiredValue(registry.getByRun("run_a")[0]);
  assert.equal(record.pageUrl, "https://example.test/2fa");
  assert.equal(record.pageTitle, "Two-factor");
  assert.equal(record.reason, "2fa");
  registry.shutdown();
});

test("PUT accepts neko descriptor and does not echo auth metadata", async () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  const app = makeFakeApp();
  registry.attachRoutes(app, mockAuth("dev_owner"));

  const handlers = app.findHandler("PUT", RESOURCE_PATH);
  const req = makeReq({
    body: {
      auth: {
        scheme: "bearer",
        token: "route-secret-token",
      },
      backend: "neko",
      base_url: `${VALID_NEKO_BASE_URL_2}/`,
    },
    params: { interactionId: "int_a", runId: "run_neko" },
  });
  const res = makeRes();
  await runRoute(handlers, req, res);

  assert.equal(res.statusCode, 200);
  assertNoRawBackendAuthority(res.payload);
  assert.deepEqual(registry.get({ interactionId: "int_a", runId: "run_neko" }), {
    auth: {
      scheme: "bearer",
      token: "route-secret-token",
    },
    backend: "neko",
    base_url: VALID_NEKO_BASE_URL_2,
  });
  const serialized = JSON.stringify(res.payload);
  assert.equal(serialized.includes("route-secret-token"), false);
  assert.equal(serialized.includes(VALID_NEKO_BASE_URL_2), false);
  registry.shutdown();
});

test("PUT accepts nested neko target descriptor", async () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  const app = makeFakeApp();
  registry.attachRoutes(app, mockAuth("dev_owner"));

  const handlers = app.findHandler("PUT", RESOURCE_PATH);
  const req = makeReq({
    body: {
      target: {
        backend: "neko",
        base_url: VALID_NEKO_BASE_URL,
      },
    },
    params: { interactionId: "int_a", runId: "run_neko_nested" },
  });
  const res = makeRes();
  await runRoute(handlers, req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(registry.get({ interactionId: "int_a", runId: "run_neko_nested" }), {
    backend: "neko",
    base_url: VALID_NEKO_BASE_URL,
  });
  registry.shutdown();
});

test("POST accepts managed neko descriptor with lease metadata and omits CDP details", async () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  const app = makeFakeApp();
  registry.attachRoutes(app, mockAuth("dev_owner"));

  const handlers = app.findHandler("POST", RESOURCE_PATH);
  const req = makeReq({
    body: {
      backend: "neko",
      descriptor: {
        backend: "neko",
        base_url: VALID_NEKO_DOCKER_BASE_URL,
        interaction_id: "int_a",
        lease_id: "lease_123",
        profile_key: "chatgpt:owner",
        start_url: "https://example.test/login",
        surface_id: "surface_static_1",
      },
    },
    params: { interactionId: "int_a", runId: "run_neko_managed" },
  });
  const res = makeRes();
  await runRoute(handlers, req, res);

  assert.equal(res.statusCode, 200);
  assertNoRawBackendAuthority(res.payload);
  const descriptor = registry.get({ interactionId: "int_a", runId: "run_neko_managed" });
  assert.deepEqual(descriptor, {
    backend: "neko",
    base_url: VALID_NEKO_DOCKER_BASE_URL,
    interaction_id: "int_a",
    lease_id: "lease_123",
    profile_key: "chatgpt:owner",
    start_url: "https://example.test/login",
    surface_id: "surface_static_1",
  });
  const serialized = JSON.stringify(descriptor);
  assert.equal(serialized.includes("cdp"), false);
  assert.equal(serialized.includes("9223"), false);
  registry.shutdown();
});

test("PUT same-value re-PUT succeeds with action=reaffirmed", async () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  const app = makeFakeApp();
  registry.attachRoutes(app, mockAuth("dev_owner"));

  const handlers = app.findHandler("PUT", RESOURCE_PATH);
  await runRoute(
    handlers,
    makeReq({ body: { wsUrl: VALID_WS }, params: { interactionId: "int_a", runId: "run_a" } }),
    makeRes()
  );
  const res = makeRes();
  await runRoute(
    handlers,
    makeReq({ body: { wsUrl: VALID_WS }, params: { interactionId: "int_a", runId: "run_a" } }),
    res
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.action, "reaffirmed");
  registry.shutdown();
});

test("PUT different-value re-PUT replaces the record AND surfaces action=replaced", async () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  const app = makeFakeApp();
  registry.attachRoutes(app, mockAuth("dev_owner"));

  const handlers = app.findHandler("PUT", RESOURCE_PATH);
  await runRoute(
    handlers,
    makeReq({ body: { wsUrl: VALID_WS }, params: { interactionId: "int_a", runId: "run_a" } }),
    makeRes()
  );
  const res = makeRes();
  await runRoute(
    handlers,
    makeReq({
      body: { reason: "oauth_popup", wsUrl: VALID_WS_2 },
      params: { interactionId: "int_a", runId: "run_a" },
    }),
    res
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.action, "replaced");
  assert.equal(registry.get({ interactionId: "int_a", runId: "run_a" }), VALID_WS_2);
  registry.shutdown();
});

test("PUT surfaces non-loopback rejection as 400 run_target_non_loopback", async () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  const app = makeFakeApp();
  registry.attachRoutes(app, mockAuth("dev_owner"));

  const handlers = app.findHandler("PUT", RESOURCE_PATH);
  const req = makeReq({
    body: { wsUrl: "ws://example.com:9222/devtools/page/abc" },
    params: { interactionId: "int_a", runId: "run_a" },
  });
  const res = makeRes();
  await runRoute(handlers, req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(objectRecord(res.payload.error).code, "run_target_non_loopback");
  // And the response message must not include the rejected URL or path.
  assert.equal(String(objectRecord(res.payload.error).message).includes("example.com"), false);
  assert.equal(String(objectRecord(res.payload.error).message).includes("/devtools/page/abc"), false);
  registry.shutdown();
});

test("DELETE 200 on owning device, 404 when not present", async () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  registry.register({
    deviceId: "dev_owner",
    interactionId: "int_a",
    runId: "run_a",
    wsUrl: VALID_WS,
  });
  const app = makeFakeApp();
  registry.attachRoutes(app, mockAuth("dev_owner"));

  const handlers = app.findHandler("DELETE", RESOURCE_PATH);
  const req1 = makeReq({ params: { interactionId: "int_a", runId: "run_a" } });
  const res1 = makeRes();
  await runRoute(handlers, req1, res1);
  assert.equal(res1.statusCode, 200);
  assert.equal(res1.payload.run_id, "run_a");
  assert.equal(res1.payload.interaction_id, "int_a");

  // Second delete on the now-empty record should be 404.
  const req2 = makeReq({ params: { interactionId: "int_a", runId: "run_a" } });
  const res2 = makeRes();
  await runRoute(handlers, req2, res2);
  assert.equal(res2.statusCode, 404);
  assert.equal(objectRecord(res2.payload.error).code, "not_found");
  registry.shutdown();
});

test("DELETE by non-owning device returns 404 (does not leak presence)", async () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  registry.register({
    deviceId: "dev_owner",
    interactionId: "int_a",
    runId: "run_a",
    wsUrl: VALID_WS,
  });
  const app = makeFakeApp();
  registry.attachRoutes(app, mockAuth("dev_intruder"));

  const handlers = app.findHandler("DELETE", RESOURCE_PATH);
  const req = makeReq({ params: { interactionId: "int_a", runId: "run_a" } });
  const res = makeRes();
  await runRoute(handlers, req, res);

  assert.equal(res.statusCode, 404);
  // Record must still be intact.
  assert.equal(registry.get({ interactionId: "int_a", runId: "run_a" }), VALID_WS);
  registry.shutdown();
});

test("logging never contains the full wsUrl path", async () => {
  const logger = makeCapturedLogger();
  const registry = createRunTargetRegistry({ logger, sweepIntervalMs: 0 });
  const app = makeFakeApp();
  registry.attachRoutes(app, mockAuth("dev_owner"));

  const handlers = app.findHandler("PUT", RESOURCE_PATH);
  const req = makeReq({
    body: { reason: "login", wsUrl: VALID_WS },
    params: { interactionId: "int_a", runId: "run_a" },
  });
  const res = makeRes();
  await runRoute(handlers, req, res);

  // Also exercise unregister + an expiry sweep so all log paths are covered.
  registry.unregister({ deviceId: "dev_owner", interactionId: "int_a", runId: "run_a" });

  const serialized = JSON.stringify(logger.entries);
  assert.equal(logger.entries.length > 0, true, "should have logged at least once");
  assert.equal(
    serialized.includes("/devtools/page/abc123XYZ"),
    false,
    "log entries must not contain the page-target path"
  );
  assert.equal(serialized.includes(VALID_WS), false, "log entries must not contain the full wsUrl");
  // Spot-check that the structured fields we DO want are present.
  const registerEntry = logger.entries.find((e) => e.msg === "run_target_registered");
  assert.ok(registerEntry, "registered log entry should exist");
  assert.equal(registerEntry.runId, "run_a");
  assert.equal(registerEntry.interactionId, "int_a");
  assert.equal(registerEntry.host, "127.0.0.1");
  assert.equal(registerEntry.port, "9222");
  assert.equal(registerEntry.deviceId, "dev_owner");
  assert.equal(registerEntry.reason, "login");
  registry.shutdown();
});

test("attachRoutes throws on missing app or middleware", () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  assert.throws(() => registry.attachRoutes(null, () => undefined));
  assert.throws(() => registry.attachRoutes(makeFakeApp(), null));
  registry.shutdown();
});

// ─── per-run nonce: Mode-A in-process auth path ────────────────────────────

// Auth middleware that always rejects with 401 — used to prove the nonce
// path bypasses the device-exporter check entirely on success.
function rejectAuth(_req: TestRequest, res: TestResponse, _next: TestNext): void {
  res.status(401).json({ error: { code: "authentication_error", message: "no creds", type: "authentication_error" } });
}

function makeReqWithBearer({
  params = {},
  body = {},
  bearer,
}: {
  bearer?: string;
  body?: JsonRecord;
  params?: Record<string, string>;
}): TestRequest {
  return {
    body,
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    params,
  };
}

test("registerNonce + verifyNonce round-trips and clears on demand", () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  registry.registerNonce({ nonce: "super_secret_nonce_v1", runId: "run_a" });
  assert.equal(registry.verifyNonce({ presentedToken: "super_secret_nonce_v1", runId: "run_a" }), true);
  assert.equal(registry.verifyNonce({ presentedToken: "wrong", runId: "run_a" }), false);
  registry.clearNonce({ runId: "run_a" });
  assert.equal(registry.verifyNonce({ presentedToken: "super_secret_nonce_v1", runId: "run_a" }), false);
  registry.shutdown();
});

test("verifyNonce returns false when runId or token is missing", () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  registry.registerNonce({ nonce: "tok", runId: "run_a" });
  assert.equal(registry.verifyNonce({ presentedToken: "tok", runId: "" }), false);
  assert.equal(registry.verifyNonce({ presentedToken: "", runId: "run_a" }), false);
  registry.shutdown();
});

test("verifyNonce is bound by runId (cross-run nonce reuse rejected)", () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  registry.registerNonce({ nonce: "nonce_A", runId: "run_a" });
  registry.registerNonce({ nonce: "nonce_B", runId: "run_b" });
  assert.equal(registry.verifyNonce({ presentedToken: "nonce_A", runId: "run_a" }), true);
  assert.equal(
    registry.verifyNonce({ presentedToken: "nonce_A", runId: "run_b" }),
    false,
    "A nonce must not validate for B"
  );
  assert.equal(
    registry.verifyNonce({ presentedToken: "nonce_B", runId: "run_a" }),
    false,
    "B nonce must not validate for A"
  );
  registry.shutdown();
});

test("registerNonce never stores the raw nonce in memory", () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  const raw = "super_secret_nonce_v1";
  registry.registerNonce({ nonce: raw, runId: "run_a" });
  // The internal nonceHashes Map should hold a SHA-256 hex of the nonce,
  // not the raw value.
  const stored = registry._internal.nonceHashes.get("run_a");
  assert.ok(stored, "nonce was registered");
  assert.notEqual(stored, raw, "raw nonce must not be stored");
  assert.equal(stored.length, 64, "stored value should be SHA-256 hex (64 chars)");
  assert.match(stored, NONCE_HASH_PATTERN);
  registry.shutdown();
});

test("registerNonce throws on missing runId or nonce", () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  assert.throws(() => registry.registerNonce({ nonce: "x", runId: "" }));
  assert.throws(() => registry.registerNonce({ nonce: "", runId: "run_a" }));
  registry.shutdown();
});

test("clearNonce is idempotent", () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  registry.clearNonce({ runId: "run_never_registered" }); // does not throw
  registry.registerNonce({ nonce: "tok", runId: "run_a" });
  registry.clearNonce({ runId: "run_a" });
  registry.clearNonce({ runId: "run_a" });
  assert.equal(registry.verifyNonce({ presentedToken: "tok", runId: "run_a" }), false);
  registry.shutdown();
});

test("shutdown clears the nonce store", () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  registry.registerNonce({ nonce: "tok", runId: "run_a" });
  registry.shutdown();
  assert.equal(registry._internal.nonceHashes.size, 0);
});

test("PUT: bearer matching the per-run nonce authenticates without device-exporter creds", async () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  registry.registerNonce({ nonce: "mode_a_nonce_v1", runId: "run_a" });
  const app = makeFakeApp();
  // Device-exporter middleware rejects everything; success here proves the
  // nonce path won.
  registry.attachRoutes(app, rejectAuth);

  const handlers = app.findHandler("PUT", RESOURCE_PATH);
  const req = makeReqWithBearer({
    bearer: "mode_a_nonce_v1",
    body: { wsUrl: VALID_WS },
    params: { interactionId: "int_a", runId: "run_a" },
  });
  const res = makeRes();
  await runRoute(handlers, req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.run_id, "run_a");
  assert.equal(res.payload.interaction_id, "int_a");
  assert.equal(registry.get({ interactionId: "int_a", runId: "run_a" }), VALID_WS);
  registry.shutdown();
});

test("PUT: per-run nonce can authenticate multiple interaction routes in the same run", async () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  registry.registerNonce({ nonce: "shared_run_nonce", runId: "run_a" });
  const app = makeFakeApp();
  registry.attachRoutes(app, rejectAuth);
  const handlers = app.findHandler("PUT", RESOURCE_PATH);

  // First interaction.
  const res1 = makeRes();
  await runRoute(
    handlers,
    makeReqWithBearer({
      bearer: "shared_run_nonce",
      body: { wsUrl: VALID_WS },
      params: { interactionId: "int_first", runId: "run_a" },
    }),
    res1
  );
  assert.equal(res1.statusCode, 200);

  // Second interaction in the same run, same nonce.
  const res2 = makeRes();
  await runRoute(
    handlers,
    makeReqWithBearer({
      bearer: "shared_run_nonce",
      body: { wsUrl: VALID_WS_2 },
      params: { interactionId: "int_second", runId: "run_a" },
    }),
    res2
  );
  assert.equal(res2.statusCode, 200);
  assert.equal(registry.get({ interactionId: "int_first", runId: "run_a" }), VALID_WS);
  assert.equal(registry.get({ interactionId: "int_second", runId: "run_a" }), VALID_WS_2);
  registry.shutdown();
});

test("PUT: bearer for a DIFFERENT run does NOT authenticate (cross-run nonce rejected)", async () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  registry.registerNonce({ nonce: "nonce_A", runId: "run_a" });
  registry.registerNonce({ nonce: "nonce_B", runId: "run_b" });
  const app = makeFakeApp();
  registry.attachRoutes(app, rejectAuth);

  const handlers = app.findHandler("PUT", RESOURCE_PATH);
  // Try to register run_b's target using run_a's nonce.
  const req = makeReqWithBearer({
    bearer: "nonce_A",
    body: { wsUrl: VALID_WS },
    params: { interactionId: "int_a", runId: "run_b" },
  });
  const res = makeRes();
  await runRoute(handlers, req, res);

  assert.equal(res.statusCode, 401);
  assert.equal(
    registry.get({ interactionId: "int_a", runId: "run_b" }),
    null,
    "run_b must not get a target registered"
  );
  registry.shutdown();
});

test("PUT: a wrong bearer falls through to the device-exporter middleware (which rejects)", async () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  registry.registerNonce({ nonce: "right_nonce", runId: "run_a" });
  const app = makeFakeApp();
  registry.attachRoutes(app, rejectAuth);

  const handlers = app.findHandler("PUT", RESOURCE_PATH);
  const req = makeReqWithBearer({
    bearer: "wrong_nonce",
    body: { wsUrl: VALID_WS },
    params: { interactionId: "int_a", runId: "run_a" },
  });
  const res = makeRes();
  await runRoute(handlers, req, res);

  assert.equal(res.statusCode, 401);
  assert.equal(registry.get({ interactionId: "int_a", runId: "run_a" }), null);
  registry.shutdown();
});

test("DELETE: nonce-authenticated unregister works (synthetic deviceId is bound to the run)", async () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  registry.registerNonce({ nonce: "tok_a", runId: "run_a" });
  const app = makeFakeApp();
  registry.attachRoutes(app, rejectAuth);

  // Register via the nonce path.
  const putHandlers = app.findHandler("PUT", RESOURCE_PATH);
  await runRoute(
    putHandlers,
    makeReqWithBearer({
      bearer: "tok_a",
      body: { wsUrl: VALID_WS },
      params: { interactionId: "int_a", runId: "run_a" },
    }),
    makeRes()
  );
  assert.equal(registry.get({ interactionId: "int_a", runId: "run_a" }), VALID_WS);

  // Unregister via the same nonce.
  const delHandlers = app.findHandler("DELETE", RESOURCE_PATH);
  const res = makeRes();
  await runRoute(
    delHandlers,
    makeReqWithBearer({
      bearer: "tok_a",
      params: { interactionId: "int_a", runId: "run_a" },
    }),
    res
  );
  assert.equal(res.statusCode, 200);
  assert.equal(registry.get({ interactionId: "int_a", runId: "run_a" }), null);
  registry.shutdown();
});

test("PUT: device-exporter creds still work when no nonce is presented (Mode B unchanged)", async () => {
  const registry = createRunTargetRegistry({ sweepIntervalMs: 0 });
  // No nonce registered. Device-exporter middleware stamps the device id
  // and passes through.
  const app = makeFakeApp();
  registry.attachRoutes(app, mockAuth("dev_owner"));

  const handlers = app.findHandler("PUT", RESOURCE_PATH);
  // Note: no Authorization header — just lets the device-exporter mock
  // middleware stamp the deviceId, exactly the Mode-B path.
  const req = makeReq({
    body: { wsUrl: VALID_WS },
    params: { interactionId: "int_a", runId: "run_a" },
  });
  const res = makeRes();
  await runRoute(handlers, req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(registry.get({ interactionId: "int_a", runId: "run_a" }), VALID_WS);
  registry.shutdown();
});

test("logging never carries the raw nonce", () => {
  const logger = makeCapturedLogger();
  const registry = createRunTargetRegistry({ logger, sweepIntervalMs: 0 });
  const raw = "unique_marker_nonce_value_xyz";
  registry.registerNonce({ nonce: raw, runId: "run_a" });
  registry.verifyNonce({ presentedToken: raw, runId: "run_a" });
  registry.clearNonce({ runId: "run_a" });
  const serialized = JSON.stringify(logger.entries);
  assert.equal(serialized.includes(raw), false, "raw nonce must never appear in logs");
  registry.shutdown();
});
