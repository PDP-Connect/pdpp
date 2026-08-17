// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import type { MountRefRecordRejectionsContext } from "../server/routes/ref-record-rejections.ts";
import { mountRefRecordRejections } from "../server/routes/ref-record-rejections.ts";

type RouteHandler = (req: unknown, res: unknown) => unknown | Promise<unknown>;
type MountApp = Parameters<typeof mountRefRecordRejections>[0];

interface FakeResponse {
  body: unknown;
  header: (name: string, value: string) => FakeResponse;
  headers: Record<string, string>;
  json: (body: unknown) => unknown;
  status: (code: number) => FakeResponse;
  statusCode: number | null;
}

interface MountedRoute {
  readonly handlers: readonly RouteHandler[];
  readonly path: string;
}

const baseMetadata = {
  connectorId: "connector-1",
  connectorInstanceId: "connection-1",
  createdAt: "2026-08-11T00:00:00.000Z",
  firstInputIndex: 1,
  lastSeenAt: "2026-08-11T00:01:00.000Z",
  latestInputIndex: 3,
  ownerSubjectId: "owner-1",
  payloadBytes: 42,
  payloadSha256: "sha256",
  quotaNearLimit: false,
  reasonCode: "invalid_record_identity",
  receiptId: "rr_1",
  replayCount: 2,
  runId: "run-1",
  status: "pending" as const,
  stream: "items",
};

const LIST_ROUTE = "/_ref/connections/:connectorInstanceId/record-rejections";
const DETAIL_ROUTE = "/_ref/connections/:connectorInstanceId/record-rejections/:receiptId";

function makeApp(): { app: MountApp; routes: Record<string, MountedRoute> } {
  const routes: Record<string, MountedRoute> = {};
  const app = {
    get(path: string, ...handlers: unknown[]) {
      routes[path] = { handlers: handlers as RouteHandler[], path };
      return app;
    },
  } as unknown as MountApp;
  return { app, routes };
}

function makeResponse(): FakeResponse {
  const response: FakeResponse = {
    body: undefined,
    header(name, value) {
      response.headers[name.toLowerCase()] = value;
      return response;
    },
    headers: {},
    json(body) {
      response.body = body;
      return body;
    },
    status(code) {
      response.statusCode = code;
      return response;
    },
    statusCode: null,
  };
  return response;
}

function makeContext(overrides: Partial<MountRefRecordRejectionsContext> = {}) {
  const listCalls: unknown[] = [];
  const detailCalls: unknown[] = [];
  const ctx = {
    createRequestConnectorInstanceStore: () => ({
      get: (connectorInstanceId: string) =>
        connectorInstanceId === "connection-1"
          ? { connectorId: "connector-1", connectorInstanceId: "connection-1", ownerSubjectId: "owner-1" }
          : null,
    }),
    createRequestRecordRejectionStore: () => ({
      getDetail: (input: unknown) => {
        detailCalls.push(input);
        return {
          ...baseMetadata,
          payloadBase64: Buffer.from('{"id":"bad"}').toString("base64"),
          payloadEncoding: "base64" as const,
          payloadText: '{"id":"bad"}',
        };
      },
      list: (input: unknown) => {
        listCalls.push(input);
        return { items: [baseMetadata], nextCursor: "opaque-next" };
      },
    }),
    getOwnerSubjectId: () => "owner-1",
    handleError: (_res: unknown, err: unknown) => {
      throw err;
    },
    maxRecordRejectionPageSize: 50,
    pdppError: (res: FakeResponse, status: number, code: string, message: string | undefined, param?: string | null) =>
      res.status(status).json({ error: { code, message, param: param ?? null } }),
    requireOwnerSession: (_req: unknown, _res: unknown, next: () => unknown) => next(),
    ...overrides,
  } as unknown as MountRefRecordRejectionsContext;
  return { ctx, detailCalls, listCalls };
}

function mount(overrides: Partial<MountRefRecordRejectionsContext> = {}) {
  const { app, routes } = makeApp();
  const harness = makeContext(overrides);
  mountRefRecordRejections(app, harness.ctx);
  return { ...harness, routes };
}

function getRoute(routes: Record<string, MountedRoute>, path: string): MountedRoute {
  const route = routes[path];
  assert.ok(route, `${path} must be mounted`);
  return route;
}

async function call(route: MountedRoute, params: Record<string, string>, query: Record<string, unknown> = {}) {
  const response = makeResponse();
  const handler = route.handlers.at(-1);
  assert.ok(handler, "route handler must be mounted");
  await handler({ params, query }, response);
  return response;
}

test("mounts list and detail behind owner-session middleware", () => {
  const ownerSession = () => undefined;
  const { routes } = mount({ requireOwnerSession: ownerSession });
  const listRoute = getRoute(routes, LIST_ROUTE);
  const detailRoute = getRoute(routes, DETAIL_ROUTE);

  assert.equal(listRoute.handlers[1], ownerSession);
  assert.equal(detailRoute.handlers[1], ownerSession);
});

test("list clamps page size, passes opaque cursor, and returns metadata only", async () => {
  const { listCalls, routes } = mount({ maxRecordRejectionPageSize: 2 });

  const response = await call(
    getRoute(routes, LIST_ROUTE),
    { connectorInstanceId: "connection-1" },
    { cursor: "opaque-cursor", limit: "99" }
  );

  assert.deepEqual(listCalls, [
    {
      connectorInstanceId: "connection-1",
      cursor: "opaque-cursor",
      limit: 2,
      ownerSubjectId: "owner-1",
    },
  ]);
  assert.equal(response.statusCode, null);
  assert.deepEqual(response.body, {
    data: [
      {
        connection_id: "connection-1",
        connector_id: "connector-1",
        created_at: "2026-08-11T00:00:00.000Z",
        first_input_index: 1,
        last_seen_at: "2026-08-11T00:01:00.000Z",
        latest_input_index: 3,
        payload_bytes: 42,
        payload_sha256: "sha256",
        quota_near_limit: false,
        reason_code: "invalid_record_identity",
        receipt_id: "rr_1",
        replay_count: 2,
        run_id: "run-1",
        status: "pending",
        stream: "items",
      },
    ],
    has_more: true,
    next_cursor: "opaque-next",
    object: "list",
  });
  assert.equal(response.headers["cache-control"], "private, no-store");
  assert.equal(JSON.stringify(response.body).includes("payloadText"), false);
  assert.equal(JSON.stringify(response.body).includes("parser exploded"), false);
  assert.equal(JSON.stringify(response.body).includes("storage exploded"), false);
  assert.equal(JSON.stringify(response.body).includes('{"id":"bad"}'), false);
});

test("detail returns exact bounded payload after connection ownership is proven", async () => {
  const { detailCalls, routes } = mount();

  const response = await call(getRoute(routes, DETAIL_ROUTE), {
    connectorInstanceId: "connection-1",
    receiptId: "rr_1",
  });

  assert.deepEqual(detailCalls, [
    {
      connectorInstanceId: "connection-1",
      ownerSubjectId: "owner-1",
      receiptId: "rr_1",
    },
  ]);
  assert.deepEqual(response.body, {
    connection_id: "connection-1",
    connector_id: "connector-1",
    created_at: "2026-08-11T00:00:00.000Z",
    first_input_index: 1,
    last_seen_at: "2026-08-11T00:01:00.000Z",
    latest_input_index: 3,
    payload_base64: Buffer.from('{"id":"bad"}').toString("base64"),
    payload_bytes: 42,
    payload_encoding: "base64",
    payload_sha256: "sha256",
    payload_text: '{"id":"bad"}',
    quota_near_limit: false,
    reason_code: "invalid_record_identity",
    receipt_id: "rr_1",
    replay_count: 2,
    run_id: "run-1",
    status: "pending",
    stream: "items",
  });
  assert.equal(response.headers["cache-control"], "private, no-store");
});

test("wrong owner and missing receipt use the same non-disclosing not-found surface", async () => {
  const wrongOwner = mount({
    createRequestConnectorInstanceStore: () => ({
      get: () => ({ connectorId: "connector-1", connectorInstanceId: "connection-1", ownerSubjectId: "other-owner" }),
    }),
  });
  const wrongOwnerResponse = await call(getRoute(wrongOwner.routes, DETAIL_ROUTE), {
    connectorInstanceId: "connection-1",
    receiptId: "rr_1",
  });
  assert.deepEqual(wrongOwner.detailCalls, []);

  const missingReceipt = mount({
    createRequestRecordRejectionStore: () => ({
      getDetail: () => null,
      list: () => ({ items: [], nextCursor: null }),
    }),
  });
  const missingReceiptResponse = await call(getRoute(missingReceipt.routes, DETAIL_ROUTE), {
    connectorInstanceId: "connection-1",
    receiptId: "rr_absent",
  });

  assert.equal(wrongOwnerResponse.statusCode, 404);
  assert.deepEqual(wrongOwnerResponse.body, missingReceiptResponse.body);
});

test("malformed cursor maps to a fixed client error without leaking store text", async () => {
  const { routes } = mount({
    createRequestRecordRejectionStore: () => ({
      getDetail: () => null,
      list: () => {
        const err = new Error("base64 decoder stack and raw cursor");
        (err as Error & { code?: string }).code = "invalid_cursor";
        throw err;
      },
    }),
  });

  const response = await call(
    getRoute(routes, LIST_ROUTE),
    { connectorInstanceId: "connection-1" },
    { cursor: "not-opaque-enough" }
  );

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.body, {
    error: {
      code: "invalid_cursor",
      message: "Record rejection cursor is invalid",
      param: "cursor",
    },
  });
});
