// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The batch optimization must not move acquisition provenance after the whole
 * request. The route's observable sequence is store(record), provenance(record),
 * then the next record's store.
 */

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
      // This route returns JSON in the successful path.
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

test("rs.records.ingest preserves store/provenance order inside a batch", async () => {
  const events: string[] = [];
  const { app, routes } = makeApp();
  const ctx = {
    buildMutationContext: () => ({ traceId: "trace-1" }),
    emitMutationEvent: async () => undefined,
    emitMutationRequested: async () => undefined,
    getLatestAcquisitionBatchForConnection: async () => ({
      acquisitionMethod: "manual_upload",
      batchId: "batch-1",
    }),
    ingestRecord: () => Promise.reject(new Error("single-record fallback must not run")),
    ingestRecords: async (
      _target: unknown,
      records: readonly Record<string, unknown>[],
      afterRecord?: (record: Record<string, unknown>, outcome: unknown) => Promise<void>
    ) => {
      const outcomes: Array<{ accepted: true; changed: true }> = [];
      for (const record of records) {
        const key = String(record.id);
        events.push(`store:${key}`);
        const outcome = { accepted: true as const, changed: true as const };
        outcomes.push(outcome);
        // biome-ignore lint/performance/noAwaitInLoops: The oracle asserts the required per-record ordering.
        await afterRecord?.(record, outcome);
      }
      return outcomes;
    },
    recordAcquisitionProvenance: ({ recordKey }: { recordKey: string }) => {
      events.push(`provenance:${recordKey}`);
    },
    rejectMutation: (_res: unknown, _req: unknown, _ctx: unknown, err: Error) => Promise.reject(err),
    requireOwner: (_req: unknown, _res: unknown, next: () => unknown) => next(),
    requireToken: (_req: unknown, _res: unknown, next: () => unknown) => next(),
    resolveOwnerConnectorNamespace: async () => ({
      connectorId: "connector-1",
      connectorInstanceId: "instance-1",
    }),
    resolveRegisteredConnectorManifest: async () => ({ streams: [{ name: "messages" }] }),
    resolveSingleConnectorIdQueryValue: (value: unknown) => (typeof value === "string" ? value : null),
    setReferenceTraceId: () => undefined,
    storageTargetForConnectorNamespace: () => ({
      connector_id: "connector-1",
      connector_instance_id: "instance-1",
    }),
  } as unknown as MountRsMutationContext;

  mountRsRecordsIngest(app, ctx);
  const routeHandlers = routes["/v1/ingest/:stream"];
  assert.ok(routeHandlers, "ingest route must be mounted");
  const handler = routeHandlers.at(-1);
  assert.ok(handler, "ingest route handler must be mounted");
  const response = makeResponse();
  await handler(
    {
      body: '{"id":"r1","key":"r1"}\n{"id":"r2","key":"r2"}',
      headers: {},
      params: { stream: "messages" },
      query: { connector_id: "connector-1", connector_instance_id: "instance-1" },
    },
    response
  );

  assert.deepEqual(events, ["store:r1", "provenance:r1", "store:r2", "provenance:r2"]);
  assert.deepEqual(response.body, {
    errors: [],
    records_accepted: 2,
    records_attempted: 2,
    records_rejected: 0,
    rejections: [],
    stream: "messages",
  });
});
