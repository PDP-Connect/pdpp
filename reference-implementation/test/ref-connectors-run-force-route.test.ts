const TOP_LEVEL_REGEX_1 = /run resources must include at least one resource id per stream/;
const TOP_LEVEL_REGEX_2 = /run resources must map stream names to string arrays/;
const TOP_LEVEL_REGEX_3 = /run resources must include at least one resource id per stream/;
const TOP_LEVEL_REGEX_4 = /run resources must map stream names to string arrays/;

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import type { MountOwnerConnectionRunContext } from "../server/routes/owner-connection-run.ts";
import { mountOwnerConnectionRun } from "../server/routes/owner-connection-run.ts";
import type { MountRefConnectorsContext } from "../server/routes/ref-connectors.ts";
import { mountRefConnectionRun, mountRefConnectorRun } from "../server/routes/ref-connectors.ts";

// Minimal shapes for the harness's own request/response fakes. These
// intentionally mirror the union of what `RouteRequest`/`RouteResponse` in
// `server/routes/ref-connectors.ts` and `server/routes/owner-connection-run.ts`
// require, so a single fake `res` satisfies both route families' handler
// signatures without pulling in the transport's ambient (untyped) types.
interface FakeRequest {
  readonly body?: Readonly<Record<string, unknown>> | null;
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, unknown>>;
  readonly tokenInfo?: {
    readonly client_id?: string | null;
    readonly client_name?: string | null;
    readonly pdpp_token_kind?: string | null;
    readonly scenario_id?: string | null;
    readonly subject_id?: string | null;
  } | null;
}

interface FakeResponse {
  body: unknown;
  end: () => void;
  getHeader: (name: string) => string | undefined;
  readonly headers: Map<string, string>;
  json: (value: unknown) => unknown;
  setHeader: (name: string, value: string) => void;
  status: (code: number) => FakeResponse;
  statusCode: number | null;
}

type FakeRouteHandler = (req: FakeRequest, res: FakeResponse) => unknown;

// Shape of the spine event this route family emits, projected down to the
// fields the tests assert on.
interface SpineEvent {
  readonly data?: {
    readonly forced?: boolean;
    readonly run_id?: string;
    readonly connection_id?: string;
  };
  readonly event_type?: string;
}

interface RunNowCall {
  readonly connectorId: string | null;
  readonly options: {
    connectorInstanceId?: string | null;
    force?: boolean;
    runAdmission?: "browser_enrollment";
    resources?: Readonly<Record<string, readonly string[]>>;
  };
}

interface ResolveNamespaceCall {
  readonly connectorId: string | null;
  readonly options: { allowStatuses?: readonly string[]; connectorInstanceId?: string | null };
}

type MountRefRun = typeof mountRefConnectionRun | typeof mountRefConnectorRun;

function buildHarness(mount: MountRefRun) {
  const calls: {
    emitSpineEvent: SpineEvent[];
    runNow: RunNowCall[];
    resolveOwnerConnectorNamespace: ResolveNamespaceCall[];
  } = {
    emitSpineEvent: [],
    resolveOwnerConnectorNamespace: [],
    runNow: [],
  };
  const ctx: MountRefConnectorsContext = {
    canonicalConnectorKey: (value) => value ?? null,
    createRequestConnectorInstanceStore: () => {
      throw new Error("createRequestConnectorInstanceStore is not used by this route family");
    },
    createTraceContext: () => ({ request_id: "req_test", scenario_id: "scn_test", trace_id: "trc_test" }),
    deleteConnection: () => {
      throw new Error("deleteConnection is not used by the run route");
    },
    deleteSchedule: () => {
      throw new Error("deleteSchedule is not used by the run route");
    },
    emitSpineEvent(event) {
      calls.emitSpineEvent.push(event as SpineEvent);
      return Promise.resolve(undefined);
    },
    ensureRequestId: () => "req_test",
    getConnectorDetail: () => Promise.resolve(null),
    getConnectorSummaryForRoute: () => null,
    getFleetHealthVerdict: () => {
      throw new Error("getFleetHealthVerdict is not used by the run route");
    },
    getOwnerSubjectId: () => "owner_local",
    getRuntimeStatus: () => {
      throw new Error("getRuntimeStatus is not used by the run route");
    },
    getSchedule: () => {
      throw new Error("getSchedule is not used by the run route");
    },
    handleError(_res, err) {
      throw err;
    },
    listSchedules: () => [],
    pdppError(_res, status, code, message) {
      const err = new Error(message) as Error & { status: number; code: string };
      err.status = status;
      err.code = code;
      throw err;
    },
    requireOwnerSession: (_req, _res, next) => (typeof next === "function" ? next() : undefined),
    resolveOwnerConnectorNamespace(_req, connectorId, options = {}) {
      calls.resolveOwnerConnectorNamespace.push({ connectorId, options });
      return Promise.resolve({
        connectorId: connectorId ?? "chatgpt",
        connectorInstanceId: options.connectorInstanceId ?? "cin_chatgpt",
      });
    },
    resolveRegisteredConnectorManifest: () => {
      throw new Error("resolveRegisteredConnectorManifest is not used by the run route");
    },
    resolveSingleConnectorIdQueryValue: () => null,
    runNow(connectorId, options) {
      calls.runNow.push({ connectorId, options });
      return Promise.resolve({ run_id: "run_force_test" });
    },
    // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
    setReferenceTraceId: () => {},
    setScheduleEnabled: () => {
      throw new Error("setScheduleEnabled is not used by the run route");
    },
    updateConnectorInstanceStatus: () => {
      throw new Error("updateConnectorInstanceStatus is not used by the run route");
    },
    upsertSchedule: () => {
      throw new Error("upsertSchedule is not used by the run route");
    },
  };

  let routeHandler: FakeRouteHandler | null = null;
  const app = {
    delete(_path: string, ..._handlers: unknown[]) {
      return app;
    },
    get(_path: string, ..._handlers: unknown[]) {
      return app;
    },
    patch(_path: string, ..._handlers: unknown[]) {
      return app;
    },
    post(_path: string, ..._handlers: unknown[]) {
      const last = _handlers.at(-1);
      routeHandler = last as FakeRouteHandler;
      return app;
    },
    put(_path: string, ..._handlers: unknown[]) {
      return app;
    },
  };
  mount(app, ctx);

  return {
    calls,
    async invoke({
      body = null,
      params = {},
    }: {
      body?: Readonly<Record<string, unknown>> | null;
      params?: Readonly<Record<string, string>>;
    } = {}) {
      assert.ok(routeHandler, "route handler must be registered by mount()");
      const handler = routeHandler;
      const res: FakeResponse = {
        body: null,
        // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
        end() {},
        getHeader(name) {
          return this.headers.get(name);
        },
        headers: new Map(),
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
        statusCode: null,
      };
      await handler({ body, params, query: {} }, res);
      return res;
    },
  };
}

type AmbiguousConnectionErrorCtor = MountOwnerConnectionRunContext["AmbiguousConnectionError"];
type AvailableConnections = ConstructorParameters<AmbiguousConnectionErrorCtor>[1];

class AmbiguousConnectionError extends Error {
  available_connections: AvailableConnections;
  code = "ambiguous_connection";
  retry_with = "connection_id";

  constructor(message: string, availableConnections: AvailableConnections) {
    super(message);
    this.available_connections = availableConnections;
  }
}

function buildOwnerHarness() {
  const calls: { runNow: RunNowCall[] } = {
    runNow: [],
  };
  const ctx: MountOwnerConnectionRunContext = {
    AmbiguousConnectionError,
    canonicalConnectorKey: (value) => value ?? null,
    createTraceContext: () => ({ request_id: "req_test", scenario_id: "scn_test", trace_id: "trc_test" }),
    emitSpineEvent: () => Promise.resolve(undefined),
    ensureRequestId: () => "req_test",
    getOwnerTokenSubjectId: () => "owner_local",
    handleError(_res, err) {
      throw err;
    },
    listActiveBindingsForGrant: () => [],
    pdppError(_res, status, code, message) {
      const err = new Error(message) as Error & { status: number; code: string };
      err.status = status;
      err.code = code;
      throw err;
    },
    projectBindingForWire: () => null,
    requireOwner: (_req, _res, next) => (typeof next === "function" ? next() : undefined),
    requireToken: (_req, _res, next) => (typeof next === "function" ? next() : undefined),
    resolveOwnerConnectorNamespace(_req, connectorId, options = {}) {
      return Promise.resolve({
        connectorId: connectorId ?? "chatgpt",
        connectorInstanceId: options.connectorInstanceId ?? "cin_chatgpt",
      });
    },
    runNow(connectorId, options) {
      calls.runNow.push({ connectorId, options });
      return Promise.resolve({ run_id: "run_owner_resources_test" });
    },
    // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
    setReferenceTraceId: () => {},
  };

  let routeHandler: FakeRouteHandler | null = null;
  const app = {
    post(_path: string, ..._handlers: unknown[]) {
      const last = _handlers.at(-1);
      routeHandler = last as FakeRouteHandler;
      return app;
    },
  };
  mountOwnerConnectionRun(app, ctx);

  return {
    calls,
    async invoke({
      body = null,
      params = {},
    }: {
      body?: Readonly<Record<string, unknown>> | null;
      params?: Readonly<Record<string, string>>;
    } = {}) {
      assert.ok(routeHandler, "route handler must be registered by mountOwnerConnectionRun()");
      const handler = routeHandler;
      const res: FakeResponse = {
        body: null,
        // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
        end() {},
        getHeader(name) {
          return this.headers.get(name);
        },
        headers: new Map(),
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
        statusCode: null,
      };
      await handler(
        {
          body,
          params: { connectionId: "cin_chatgpt", ...params },
          query: {},
          tokenInfo: { client_id: "cli_longview", pdpp_token_kind: "owner", subject_id: "owner_local" },
        },
        res
      );
      return res;
    },
  };
}

test("POST /_ref/connections/:id/run forwards explicit force override to the controller", async () => {
  const harness = buildHarness(mountRefConnectionRun);

  const res = await harness.invoke({
    body: { force: true },
    params: { connectorInstanceId: "cin_chatgpt" },
  });

  assert.equal(res.statusCode, 202);
  assert.deepEqual(harness.calls.runNow, [
    {
      connectorId: "chatgpt",
      options: { connectorInstanceId: "cin_chatgpt", force: true, ownerSubjectId: "owner_local" },
    },
  ]);
  const [firstEvent] = harness.calls.emitSpineEvent;
  assert.ok(firstEvent);
  assert.equal(firstEvent.event_type, "owner_agent.connection.run");
  assert.equal(firstEvent.data?.forced, true);
  assert.equal(firstEvent.data?.run_id, "run_force_test");
});

test("POST /_ref/connectors/:id/run forwards explicit force override to the controller", async () => {
  const harness = buildHarness(mountRefConnectorRun);

  const res = await harness.invoke({
    body: { force: true },
    params: { connectorId: "chatgpt" },
  });

  assert.equal(res.statusCode, 202);
  assert.deepEqual(harness.calls.runNow, [
    {
      connectorId: "chatgpt",
      options: { connectorInstanceId: "cin_chatgpt", force: true, ownerSubjectId: "owner_local" },
    },
  ]);
  const [firstEvent] = harness.calls.emitSpineEvent;
  assert.ok(firstEvent);
  assert.equal(firstEvent.event_type, "owner_agent.connection.run");
  assert.equal(firstEvent.data?.forced, true);
  assert.equal(firstEvent.data?.connection_id, "cin_chatgpt");
});

test("POST /_ref/connections/:id/run uses the typed draft enrollment admission", async () => {
  const harness = buildHarness(mountRefConnectionRun);

  const res = await harness.invoke({
    body: { run_admission: "browser_enrollment" },
    params: { connectorInstanceId: "cin_amazon_draft" },
  });

  assert.equal(res.statusCode, 202);
  assert.deepEqual(harness.calls.resolveOwnerConnectorNamespace, [
    {
      connectorId: null,
      options: {
        allowDefaultAccount: false,
        allowStatuses: ["draft"],
        connectorInstanceId: "cin_amazon_draft",
        ownerSubjectId: "owner_local",
      },
    },
  ]);
  assert.deepEqual(harness.calls.runNow, [
    {
      connectorId: "chatgpt",
      options: {
        connectorInstanceId: "cin_amazon_draft",
        force: false,
        ownerSubjectId: "owner_local",
        runAdmission: "browser_enrollment",
      },
    },
  ]);
});

test("connector-wide run never accepts draft enrollment admission", async () => {
  const harness = buildHarness(mountRefConnectorRun);

  const res = await harness.invoke({
    body: { run_admission: "browser_enrollment" },
    params: { connectorId: "amazon" },
  });

  assert.equal(res.statusCode, 202);
  assert.equal(harness.calls.runNow[0]?.options.runAdmission, undefined);
});

test("POST /_ref/connections/:id/run does not force unless the body value is exactly true", async () => {
  const harness = buildHarness(mountRefConnectionRun);

  await harness.invoke({
    body: { force: "true" },
    params: { connectorInstanceId: "cin_chatgpt" },
  });

  const [firstCall] = harness.calls.runNow;
  assert.ok(firstCall);
  assert.equal(firstCall.options.force, false);
  const [firstEvent] = harness.calls.emitSpineEvent;
  assert.ok(firstEvent);
  assert.equal(firstEvent.data?.forced, false);
});

test("POST /_ref/connections/:id/run forwards scoped stream resources", async () => {
  const harness = buildHarness(mountRefConnectionRun);

  const res = await harness.invoke({
    body: { resources: { messages: ["C07JYF0U8BY", "C07JYF0U8BY", ""] } },
    params: { connectorInstanceId: "cin_slack" },
  });

  assert.equal(res.statusCode, 202);
  assert.deepEqual(harness.calls.runNow, [
    {
      connectorId: "chatgpt",
      options: {
        connectorInstanceId: "cin_slack",
        force: false,
        ownerSubjectId: "owner_local",
        resources: { messages: ["C07JYF0U8BY"] },
      },
    },
  ]);
});

test("POST /_ref/connections/:id/run rejects prototype-polluting resource keys", async () => {
  const harness = buildHarness(mountRefConnectionRun);
  const body = JSON.parse('{"resources":{"__proto__":["C07JYF0U8BY"]}}') as Record<string, unknown>;

  await assert.rejects(
    () =>
      harness.invoke({
        body,
        params: { connectorInstanceId: "cin_slack" },
      }),
    TOP_LEVEL_REGEX_2
  );
  assert.deepEqual(harness.calls.runNow, []);
});

test("POST /_ref/connections/:id/run rejects empty scoped resources instead of widening", async () => {
  const harness = buildHarness(mountRefConnectionRun);

  await assert.rejects(
    () =>
      harness.invoke({
        body: { resources: { messages: [] } },
        params: { connectorInstanceId: "cin_slack" },
      }),
    TOP_LEVEL_REGEX_3
  );
  assert.deepEqual(harness.calls.runNow, []);
});

test("POST /v1/owner/connections/:id/run rejects prototype-polluting resource keys", async () => {
  const harness = buildOwnerHarness();
  const body = JSON.parse('{"resources":{"__proto__":["C07JYF0U8BY"]}}') as Record<string, unknown>;

  await assert.rejects(() => harness.invoke({ body }), TOP_LEVEL_REGEX_4);
  assert.deepEqual(harness.calls.runNow, []);
});

test("POST /v1/owner/connections/:id/run rejects empty scoped resources instead of widening", async () => {
  const harness = buildOwnerHarness();

  await assert.rejects(() => harness.invoke({ body: { resources: { messages: [] } } }), TOP_LEVEL_REGEX_1);
  assert.deepEqual(harness.calls.runNow, []);
});
