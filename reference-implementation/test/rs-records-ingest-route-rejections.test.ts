// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import type { MountRsMutationContext } from "../server/routes/rs-mutation.ts";
import { mountRsRecordsIngest } from "../server/routes/rs-mutation.ts";

type RouteHandler = (req: unknown, res: unknown) => unknown | Promise<unknown>;
type MountApp = Parameters<typeof mountRsRecordsIngest>[0];

interface FakeResponse {
  body: unknown;
  end: () => void;
  headers: Record<string, string>;
  json: (body: unknown) => unknown;
  setHeader: (name: string, value: string) => unknown;
  status: (code: number) => FakeResponse;
  statusCode: number | null;
}

function makeApp(): { app: MountApp; routes: Record<string, RouteHandler[]> } {
  const routes: Record<string, RouteHandler[]> = {};
  const app = {
    post(path: string, ...handlers: unknown[]) {
      routes[path] = handlers as RouteHandler[];
      return app;
    },
  } as unknown as MountApp;
  return { app, routes };
}

function makeResponse(): FakeResponse {
  const response: FakeResponse = {
    body: undefined,
    end() {
      // Successful route responses use JSON; this exists for the response shape.
    },
    headers: {},
    json(body) {
      response.body = body;
      return body;
    },
    setHeader(name, value) {
      response.headers[name] = value;
    },
    status(code) {
      response.statusCode = code;
      return response;
    },
    statusCode: null,
  };
  return response;
}

function mountRoute(overrides: Partial<MountRsMutationContext> = {}) {
  const { app, routes } = makeApp();
  const ctx = {
    buildMutationContext: () => ({ traceId: "trace-route-rejections" }),
    classifyIngestFailure: (err: unknown) => ({
      code: typeof (err as { code?: unknown }).code === "string" ? String((err as { code?: unknown }).code) : "unknown",
      message: err instanceof Error ? err.message : "unknown ingest failure",
      retryable: (err as { retryable?: unknown }).retryable !== false,
    }),
    emitMutationEvent: async () => undefined,
    emitMutationRequested: async () => undefined,
    getOwnerTokenSubjectId: () => "owner-token-subject",
    handleError: (_res: unknown, err: unknown) => {
      throw err;
    },
    ingestRecord: async (_target: unknown, record: unknown) => {
      if ((record as { id?: unknown }).id === "bad") {
        const err = new Error("invalid identity") as Error & { code: string; retryable: boolean };
        err.code = "invalid_record_identity";
        err.retryable = false;
        throw err;
      }
    },
    insertOrReplayRecordRejection: async (input: { code: string; inputIndex: number }) => ({
      code: input.code,
      input_index: input.inputIndex,
      receipt_id: `rr_${input.inputIndex}_${input.code}`,
    }),
    rejectMutation: async (res: FakeResponse, _req: unknown, _ctx: unknown, err: Error & { code?: string }) =>
      res.status(err.code === "ingest_batch_storage_error" ? 503 : 400).json({ code: err.code, error: err.message }),
    requireOwner: (_req: unknown, _res: unknown, next: () => unknown) => next(),
    requireToken: (_req: unknown, _res: unknown, next: () => unknown) => next(),
    resolveOwnerConnectorNamespace: async () => ({
      connectorId: "connector-1",
      connectorInstanceId: "connection-1",
    }),
    resolveRegisteredConnectorManifest: async () => ({ streams: [{ name: "items" }] }),
    resolveSingleConnectorIdQueryValue: (value: unknown) => (typeof value === "string" ? value : null),
    setReferenceTraceId: () => undefined,
    storageTargetForConnectorNamespace: () => ({
      connector_id: "connector-1",
      connector_instance_id: "connection-1",
    }),
    ...overrides,
  } as unknown as MountRsMutationContext;

  mountRsRecordsIngest(app, ctx);
  const routeHandlers = routes["/v1/ingest/:stream"];
  assert.ok(routeHandlers, "ingest route must be mounted");
  const handler = routeHandlers.at(-1);
  assert.ok(handler, "ingest route handler must be mounted");
  return handler;
}

async function post(handler: RouteHandler, body: string): Promise<FakeResponse> {
  const response = makeResponse();
  await handler(
    {
      body,
      headers: {},
      params: { stream: "items" },
      query: {
        connector_id: "connector-1",
        connector_instance_id: "connection-1",
        run_id: "run-1",
      },
      tokenInfo: { subject_id: "token-info-owner" },
    },
    response
  );
  return response;
}

async function postConnectorOnly(handler: RouteHandler, body: string): Promise<FakeResponse> {
  const response = makeResponse();
  await handler(
    {
      body: Buffer.from(body),
      headers: {},
      params: { stream: "items" },
      query: {
        connector_id: "connector-1",
        run_id: "run-1",
      },
      tokenInfo: { subject_id: "token-info-owner" },
    },
    response
  );
  return response;
}

test("hosted route returns additive receipt envelope for accepted-only ingest", async () => {
  const response = await post(mountRoute(), '{"id":"ok"}');

  assert.equal(response.statusCode, null);
  assert.deepEqual(response.body, {
    errors: [],
    records_accepted: 1,
    records_attempted: 1,
    records_rejected: 0,
    rejections: [],
    stream: "items",
  });
});

test("hosted route persists invalid_record_identity receipt with raw non-empty index and run binding", async () => {
  const persisted: unknown[] = [];
  const handler = mountRoute({
    insertOrReplayRecordRejection: (input: unknown) => {
      persisted.push(input);
      return { code: "invalid_record_identity", input_index: 1, receipt_id: "rr_invalid" };
    },
  } as Partial<MountRsMutationContext>);
  const response = await post(handler, '{"id":"ok"}\n\n{"id":"bad"}');

  assert.deepEqual(response.body, {
    errors: [],
    records_accepted: 1,
    records_attempted: 2,
    records_rejected: 1,
    rejections: [{ code: "invalid_record_identity", input_index: 1, receipt_id: "rr_invalid" }],
    stream: "items",
  });
  assert.deepEqual(persisted, [
    {
      auditActorId: "owner-token-subject",
      auditActorType: "subject",
      auditTraceId: "trace-route-rejections",
      code: "invalid_record_identity",
      connectorId: "connector-1",
      connectorInstanceId: "connection-1",
      inputIndex: 1,
      ownerSubjectId: "owner-token-subject",
      rawLine: Buffer.from('{"id":"bad"}'),
      runId: "run-1",
      stream: "items",
    },
  ]);
});

test("connector-only hosted route uses one resolved instance for accepted records and rejection receipts", async () => {
  const persisted: unknown[] = [];
  const targets: unknown[] = [];
  const handler = mountRoute({
    ingestRecord: async (target: unknown, record: unknown) => {
      targets.push(target);
      if ((record as { id?: unknown }).id === "bad") {
        const err = new Error("invalid identity") as Error & { code: string; retryable: boolean };
        err.code = "invalid_record_identity";
        err.retryable = false;
        throw err;
      }
    },
    insertOrReplayRecordRejection: (input: unknown) => {
      persisted.push(input);
      return { code: "invalid_record_identity", input_index: 1, receipt_id: "rr_invalid" };
    },
    resolveOwnerConnectorNamespace: (
      _req: unknown,
      _connectorId: string,
      opts?: { connectorInstanceId?: string | null }
    ) => {
      assert.equal(opts?.connectorInstanceId ?? null, null);
      return { connectorId: "connector-1", connectorInstanceId: "resolved-connection-1" };
    },
    storageTargetForConnectorNamespace: (namespace: unknown) => namespace,
  } as unknown as Partial<MountRsMutationContext>);

  const response = await postConnectorOnly(handler, '{"id":"ok"}\n{"id":"bad"}');

  assert.equal(response.statusCode, null);
  assert.deepEqual(targets, [
    { connectorId: "connector-1", connectorInstanceId: "resolved-connection-1" },
    { connectorId: "connector-1", connectorInstanceId: "resolved-connection-1" },
  ]);
  assert.deepEqual(
    persisted.map((input) => ({
      connectorInstanceId: (input as { connectorInstanceId: string }).connectorInstanceId,
      rawLine: (input as { rawLine: Buffer }).rawLine.toString("utf8"),
    })),
    [{ connectorInstanceId: "resolved-connection-1", rawLine: '{"id":"bad"}' }]
  );
});

test("hosted route checks manifest visibility before connector-only namespace admission", async () => {
  let namespaceCalls = 0;
  let rejectionCalls = 0;
  const handler = mountRoute({
    insertOrReplayRecordRejection: () => {
      rejectionCalls += 1;
      return { code: "invalid_record_identity", input_index: 0, receipt_id: "rr_unreachable" };
    },
    rejectMutation: async (res: FakeResponse, _req: unknown, _ctx: unknown, err: Error & { code?: string }) =>
      res.status(err.code === "not_found" ? 404 : 400).json({ code: err.code, error: err.message }),
    resolveOwnerConnectorNamespace: () => {
      namespaceCalls += 1;
      throw new Error("namespace resolution must wait for manifest visibility");
    },
    resolveRegisteredConnectorManifest: async () => ({ streams: [{ name: "other" }] }),
  } as unknown as Partial<MountRsMutationContext>);
  const response = await postConnectorOnly(handler, '{"id":"bad"}');

  assert.equal(response.statusCode, 404);
  assert.equal((response.body as { code?: string }).code, "not_found");
  assert.equal(namespaceCalls, 0);
  assert.equal(rejectionCalls, 0);
});

test("hosted route fails non-2xx when rejection persistence is missing or malformed", async () => {
  const missing = await post(
    mountRoute({ insertOrReplayRecordRejection: undefined } as unknown as Partial<MountRsMutationContext>),
    '{"id":"bad"}'
  );
  assert.equal(missing.statusCode, 503);
  assert.equal((missing.body as { code?: string }).code, "ingest_batch_storage_error");

  const malformed = await post(
    mountRoute({
      insertOrReplayRecordRejection: async () => ({
        code: "invalid_record_identity",
        input_index: 4,
        receipt_id: "",
      }),
    } as Partial<MountRsMutationContext>),
    '{"id":"bad"}'
  );
  assert.ok((malformed.statusCode ?? 200) >= 400, "malformed persistence must not return 2xx");
});

test("hosted route retains structured batch error code for receipt creation", async () => {
  const response = await post(mountRoute(), '{"id":"bad"}');

  assert.deepEqual(response.body, {
    errors: [],
    records_accepted: 0,
    records_attempted: 1,
    records_rejected: 1,
    rejections: [{ code: "invalid_record_identity", input_index: 0, receipt_id: "rr_0_invalid_record_identity" }],
    stream: "items",
  });
});

test("hosted route never repeats payload-bearing storage text in its success envelope", async () => {
  const privateFailureText = "key and data.id disagree: key=private-key data.id=private-data";
  const response = await post(
    mountRoute({
      ingestRecord: async () => {
        const err = new Error(privateFailureText) as Error & { code: string; retryable: boolean };
        err.code = "invalid_record_identity";
        err.retryable = false;
        throw err;
      },
    } as Partial<MountRsMutationContext>),
    '{"id":"private-data","private_field":"private-key"}'
  );

  assert.equal(response.statusCode, null);
  assert.deepEqual((response.body as { errors?: unknown }).errors, []);
  assert.equal(JSON.stringify(response.body).includes(privateFailureText), false);
  assert.equal(JSON.stringify(response.body).includes("private-key"), false);
  assert.equal(JSON.stringify(response.body).includes("private-data"), false);
});
