// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { registerConnector } from "../server/auth.ts";
import { closeDb, initDb } from "../server/db.ts";
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from "../server/owner-auth.ts";
import { classifyIngestFailure, ingestRecord } from "../server/records.ts";
import { mountRsRecordsIngest } from "../server/routes/rs-mutation.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";
import { writeSqliteRunHistoryForSpineEvent } from "../server/stores/run-history-writer.ts";

const CONNECTOR_ID = "systemic_redaction_route_probe";
const CONNECTOR_INSTANCE_ID = "cin_systemic_redaction_route_probe";
const INTERNAL_RUN_ID = "run_internal_secret_storage_detail";
const NOW = "2026-08-13T00:00:00.000Z";
const PUBLIC_MESSAGE = "Ingest failed due to a transient storage error; retry later.";
const INTERNAL_DETAIL_RE = /internal_secret_storage_detail|already terminal|refusing to commit/;
const SYSTEMIC_CODE_RE = /ingest_batch_storage_error/;

test("ingest classifier keeps admission refusals permanent and run fences systemic", () => {
  for (const code of ["connector_instance_not_found", "connector_instance_not_writable"]) {
    const error = Object.assign(new Error(`typed ${code}`), { code });
    assert.deepEqual(classifyIngestFailure(error), {
      code,
      message: `typed ${code}`,
      retryable: false,
    });
  }

  const runFence = Object.assign(new Error("run fence detail"), { code: "run_terminal" });
  assert.deepEqual(classifyIngestFailure(runFence), {
    code: "run_terminal",
    message: "run fence detail",
    retryable: true,
  });

  assert.deepEqual(classifyIngestFailure(new Error("unknown driver fault")), {
    code: "ingest_storage_error",
    message: "unknown driver fault",
    retryable: true,
  });
});

interface RouteResponse {
  json: (body: unknown) => unknown;
  setHeader: (name: string, value: string) => unknown;
  status: (code: number) => RouteResponse;
}

function freshDb(t: TestContext): void {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-systemic-redaction-route-"));
  closeDb();
  initDb(join(dir, "pdpp.sqlite"));
  t.after(() => {
    closeDb();
    rmSync(dir, { force: true, recursive: true });
  });
}

function manifest() {
  return {
    connector_id: CONNECTOR_ID,
    display_name: "Systemic redaction route probe",
    protocol_version: "0.1.0",
    streams: [
      {
        name: "items",
        primary_key: ["id"],
        schema: {
          properties: { id: { type: "string" } },
          required: ["id"],
          type: "object",
        },
      },
    ],
    version: "1.0.0",
  };
}

async function seedConnection(): Promise<void> {
  await registerConnector(manifest());
  await createSqliteConnectorInstanceStore().upsert({
    connectorId: CONNECTOR_ID,
    connectorInstanceId: CONNECTOR_INSTANCE_ID,
    createdAt: NOW,
    displayName: "Systemic redaction route probe",
    ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    sourceBinding: { account: CONNECTOR_INSTANCE_ID },
    sourceBindingKey: CONNECTOR_INSTANCE_ID,
    sourceKind: "account",
    status: "active",
    updatedAt: NOW,
  });
}

function seedCancelledRun(): void {
  writeSqliteRunHistoryForSpineEvent({
    connectorId: CONNECTOR_ID,
    connectorInstanceId: CONNECTOR_INSTANCE_ID,
    data: {},
    eventType: "run.started",
    occurredAt: NOW,
    runId: INTERNAL_RUN_ID,
    status: "started",
  });
  writeSqliteRunHistoryForSpineEvent({
    connectorId: CONNECTOR_ID,
    connectorInstanceId: CONNECTOR_INSTANCE_ID,
    data: { reason: "owner_cancelled" },
    eventType: "run.cancelled",
    occurredAt: NOW,
    runId: INTERNAL_RUN_ID,
    status: "cancelled",
  });
}

function mountRoute(): {
  body: () => unknown;
  handler: (req: unknown, res: unknown) => unknown;
  res: RouteResponse;
  status: () => number | undefined;
} {
  let ingestHandler: ((req: unknown, res: unknown) => unknown) | undefined;
  let responseBody: unknown;
  let responseStatus: number | undefined;
  const res: RouteResponse = {
    json: (body: unknown) => {
      responseBody = body;
      return body;
    },
    setHeader: () => undefined,
    status: (code: number) => {
      responseStatus = code;
      return res;
    },
  };

  mountRsRecordsIngest(
    {
      post(path: string, ...handlers: Array<(req: unknown, res: unknown) => unknown>) {
        if (path === "/v1/ingest/:stream") {
          ingestHandler = handlers.at(-1);
        }
      },
    } as Parameters<typeof mountRsRecordsIngest>[0],
    {
      buildMutationContext: () => ({ traceId: "trace_systemic_redaction_route" }),
      buildStateContext: () => ({ traceId: "unused" }),
      classifyIngestFailure,
      emitMutationEvent: async () => undefined,
      emitMutationRequested: async () => undefined,
      getDefaultClientEventSubscriptionStore: () => ({}),
      getDefaultDeliveryWorker: () => ({ tick: async () => undefined }),
      getSyncState: async () => ({}),
      handleError: (_res: unknown, err: unknown) => {
        throw err;
      },
      ingestRecord: (target: unknown, record: unknown, options: unknown) =>
        ingestRecord(
          target as Parameters<typeof ingestRecord>[0],
          record as Parameters<typeof ingestRecord>[1],
          options as Parameters<typeof ingestRecord>[2]
        ),
      pdppError: (routeRes: RouteResponse, status: number, code: string, message: string) =>
        routeRes.status(status).json({ error: { code, message } }),
      putSyncState: async () => undefined,
      rejectMutation: async (routeRes: RouteResponse, _req: unknown, _ctx: unknown, err: Error & { code?: string }) =>
        routeRes.status(err.code === "ingest_batch_storage_error" ? 503 : 500).json({
          error: { code: err.code ?? "api_error", message: err.message },
        }),
      rejectState: async () => undefined,
      requireOwner: (_req: unknown, _res: unknown, next: () => unknown) => next(),
      requireToken: (_req: unknown, _res: unknown, next: () => unknown) => next(),
      resolveOwnerConnectorNamespace: async () => ({
        connectorId: CONNECTOR_ID,
        connectorInstanceId: CONNECTOR_INSTANCE_ID,
      }),
      resolveRegisteredConnectorManifest: async () => manifest(),
      resolveSingleConnectorIdQueryValue: (value: unknown) => (typeof value === "string" ? value : null),
      setReferenceTraceId: () => undefined,
      storageTargetForConnectorNamespace: () => ({
        connector_id: CONNECTOR_ID,
        connector_instance_id: CONNECTOR_INSTANCE_ID,
      }),
      toPublicConnectorStateProjection: (state: unknown) => state,
    } as unknown as Parameters<typeof mountRsRecordsIngest>[1]
  );

  assert.ok(ingestHandler, "ingest route handler must be mounted");
  return { body: () => responseBody, handler: ingestHandler, res, status: () => responseStatus };
}

test("real ingest route redacts systemic storage diagnostics in the public 503 envelope", async (t) => {
  freshDb(t);
  await seedConnection();
  seedCancelledRun();
  const route = mountRoute();
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  t.after(() => {
    console.warn = originalWarn;
  });

  await route.handler(
    {
      body: '{"key":"r1","data":{"id":"r1"}}',
      headers: {},
      params: { stream: "items" },
      query: {
        connector_id: CONNECTOR_ID,
        connector_instance_id: CONNECTOR_INSTANCE_ID,
        run_id: INTERNAL_RUN_ID,
      },
    },
    route.res
  );

  assert.equal(route.status(), 503);
  const body = route.body() as { error?: { code?: string; message?: string } };
  assert.equal(body.error?.code, "ingest_batch_storage_error");
  assert.equal(body.error?.message, PUBLIC_MESSAGE);
  assert.doesNotMatch(JSON.stringify(body), INTERNAL_DETAIL_RE);
  assert.doesNotMatch(JSON.stringify(warnings), INTERNAL_DETAIL_RE);
  assert.match(JSON.stringify(warnings), SYSTEMIC_CODE_RE);
});
