import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { test } from "node:test";
import { COLLECTOR_PROTOCOL_VERSION } from "./collector-protocol.ts";
import { LOCAL_DEVICE_ENDPOINTS, LocalDeviceClient, LocalDeviceHttpError } from "./local-device-client.ts";

test("LocalDeviceClient sends enrollment exchange without bearer token", async () => {
  const seen: SeenRequest[] = [];
  const server = await startJsonServer(seen);
  try {
    const client = new LocalDeviceClient({ baseUrl: server.url, deviceId: "device-1", deviceToken: "device-token" });
    const response = await client.exchangeEnrollment({
      device_label: "Laptop",
      enrollment_code: "enroll-123",
    });

    assert.equal(response.device_id, "device-1");
    assert.equal(seen[0]?.path, LOCAL_DEVICE_ENDPOINTS.exchangeEnrollment);
    assert.equal(seen[0]?.authorization, undefined);
    assert.equal(seen[0]?.collectorProtocol, COLLECTOR_PROTOCOL_VERSION);
    assert.deepEqual(seen[0]?.body, {
      device_label: "Laptop",
      enrollment_code: "enroll-123",
    });
  } finally {
    await server.close();
  }
});

test("LocalDeviceClient sends bearer-authenticated heartbeat and ingest batch shapes", async () => {
  const seen: SeenRequest[] = [];
  const server = await startJsonServer(seen);
  try {
    const client = new LocalDeviceClient({ baseUrl: server.url, deviceId: "device-1", deviceToken: "device-token" });
    await client.heartbeat({
      connector_id: "codex",
      records_pending: 3,
      source_instance_id: "source-1",
      status: "healthy",
    });
    await client.ingestBatch({
      batch_id: "batch-1",
      batch_seq: 1,
      body_hash: "hash-1",
      connector_id: "codex",
      device_id: "device-1",
      records: [{ data: {}, emitted_at: "2026-04-30T12:00:00.000Z", record_key: "record-1", stream: "messages" }],
      source_instance_id: "source-1",
    });

    assert.equal(seen[0]?.path, LOCAL_DEVICE_ENDPOINTS.heartbeat("device-1"));
    assert.equal(seen[0]?.authorization, "Bearer device-token");
    assert.equal(seen[0]?.collectorProtocol, COLLECTOR_PROTOCOL_VERSION);
    assert.deepEqual(seen[0]?.body, {
      connector_id: "codex",
      records_pending: 3,
      source_instance_id: "source-1",
      status: "healthy",
    });
    assert.equal(seen[1]?.path, LOCAL_DEVICE_ENDPOINTS.ingestBatch("device-1"));
    assert.equal(seen[1]?.authorization, "Bearer device-token");
    assert.equal(seen[1]?.collectorProtocol, COLLECTOR_PROTOCOL_VERSION);
    assert.deepEqual(seen[1]?.body, {
      batch_id: "batch-1",
      batch_seq: 1,
      body_hash: "hash-1",
      connector_id: "codex",
      device_id: "device-1",
      records: [{ data: {}, emitted_at: "2026-04-30T12:00:00.000Z", record_key: "record-1", stream: "messages" }],
      source_instance_id: "source-1",
    });
  } finally {
    await server.close();
  }
});

test("LocalDeviceClient GET source-instance state hits the device-scoped state route with the bearer", async () => {
  const seen: SeenRequest[] = [];
  const server = await startJsonServer(seen);
  try {
    const client = new LocalDeviceClient({ baseUrl: server.url, deviceId: "device-1", deviceToken: "device-token" });
    const response = await client.getSourceInstanceState({ sourceInstanceId: "source-1" });
    assert.equal(response.object, "device_source_instance_state");
    assert.equal(response.device_id, "device-1");
    assert.equal(response.source_instance_id, "source-1");
    assert.deepEqual(response.state, { messages: { cursor: "abc" } });
    assert.equal(seen[0]?.method, "GET");
    assert.equal(seen[0]?.path, LOCAL_DEVICE_ENDPOINTS.sourceInstanceState("device-1", "source-1"));
    assert.equal(seen[0]?.authorization, "Bearer device-token");
    assert.equal(seen[0]?.collectorProtocol, COLLECTOR_PROTOCOL_VERSION);
    // No body on GET.
    assert.equal(seen[0]?.body, null);
  } finally {
    await server.close();
  }
});

test("LocalDeviceClient PUT source-instance state sends bearer + JSON body", async () => {
  const seen: SeenRequest[] = [];
  const server = await startJsonServer(seen);
  try {
    const client = new LocalDeviceClient({ baseUrl: server.url, deviceId: "device-1", deviceToken: "device-token" });
    await client.putSourceInstanceState({
      sourceInstanceId: "source-1",
      state: { messages: { cursor: "next" } },
    });
    assert.equal(seen[0]?.method, "PUT");
    assert.equal(seen[0]?.path, LOCAL_DEVICE_ENDPOINTS.sourceInstanceState("device-1", "source-1"));
    assert.equal(seen[0]?.authorization, "Bearer device-token");
    assert.equal(seen[0]?.collectorProtocol, COLLECTOR_PROTOCOL_VERSION);
    assert.deepEqual(seen[0]?.body, { state: { messages: { cursor: "next" } } });
  } finally {
    await server.close();
  }
});

test("LocalDeviceClient sends local collector gap ack and recovery through device-scoped routes", async () => {
  const seen: SeenRequest[] = [];
  const server = await startJsonServer(seen);
  try {
    const client = new LocalDeviceClient({ baseUrl: server.url, deviceId: "device-1", deviceToken: "device-token" });
    await client.ackLocalCollectorGap({
      connector_id: "codex",
      first_seen_at: "2026-05-19T12:00:00.000Z",
      next_attempt_backoff_ms: 60_000,
      reason: "policy_budget",
      retryable: true,
      source_instance_id: "source-1",
    });
    await client.recoverLocalCollectorGap({
      connector_id: "codex",
      reason: "policy_budget",
      recovered_run_id: "run-2",
      source_instance_id: "source-1",
    });

    assert.equal(seen[0]?.method, "POST");
    assert.equal(seen[0]?.path, LOCAL_DEVICE_ENDPOINTS.localCollectorGap("device-1", "source-1"));
    assert.equal(seen[0]?.authorization, "Bearer device-token");
    assert.deepEqual(seen[0]?.body, {
      connector_id: "codex",
      first_seen_at: "2026-05-19T12:00:00.000Z",
      next_attempt_backoff_ms: 60_000,
      reason: "policy_budget",
      retryable: true,
      source_instance_id: "source-1",
    });
    assert.equal(seen[1]?.method, "POST");
    assert.equal(seen[1]?.path, LOCAL_DEVICE_ENDPOINTS.localCollectorGapRecovered("device-1", "source-1"));
    assert.deepEqual(seen[1]?.body, {
      connector_id: "codex",
      reason: "policy_budget",
      recovered_run_id: "run-2",
      source_instance_id: "source-1",
    });
  } finally {
    await server.close();
  }
});

test("LocalDeviceClient state methods reject 401/403 with LocalDeviceHttpError", async () => {
  const server = await startStatusServer(401, "denied");
  try {
    const client = new LocalDeviceClient({ baseUrl: server.url, deviceId: "device-1", deviceToken: "device-token" });
    await assert.rejects(
      () => client.getSourceInstanceState({ sourceInstanceId: "source-1" }),
      (err: unknown) => {
        assert.ok(err instanceof LocalDeviceHttpError);
        if (err instanceof LocalDeviceHttpError) {
          assert.equal(err.status, 401);
        }
        return true;
      }
    );
  } finally {
    await server.close();
  }
});

test("LocalDeviceClient state methods surface 404 unknown source instance", async () => {
  const server = await startStatusServer(404, '{"error":{"code":"not_found"}}');
  try {
    const client = new LocalDeviceClient({ baseUrl: server.url, deviceId: "device-1", deviceToken: "device-token" });
    await assert.rejects(
      () => client.getSourceInstanceState({ sourceInstanceId: "missing" }),
      (err: unknown) => {
        assert.ok(err instanceof LocalDeviceHttpError);
        if (err instanceof LocalDeviceHttpError) {
          assert.equal(err.status, 404);
          assert.ok(err.body.includes("not_found"));
        }
        return true;
      }
    );
  } finally {
    await server.close();
  }
});

interface SeenRequest {
  authorization: string | undefined;
  body: unknown;
  collectorProtocol: string | undefined;
  method: string;
  path: string;
}

async function startJsonServer(seen: SeenRequest[]): Promise<{ close: () => Promise<void>; url: string }> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const body = await readRequestBody(req);
    const path = req.url ?? "";
    seen.push({
      authorization: req.headers.authorization,
      body: body ? JSON.parse(body) : null,
      collectorProtocol: req.headers["x-pdpp-collector-protocol"] as string | undefined,
      method: req.method ?? "",
      path,
    });
    if (path === LOCAL_DEVICE_ENDPOINTS.exchangeEnrollment) {
      sendJson(res, 200, { device_id: "device-1", device_token: "token-1", source_instance_id: "source-1" });
      return;
    }
    // Match either GET or PUT against the state route, regardless of which
    // sourceInstanceId the test used.
    if (path.endsWith("/state")) {
      const parts = path.split("/");
      const sourceInstanceId = decodeURIComponent(parts.at(-2) ?? "");
      sendJson(res, 200, {
        object: "device_source_instance_state",
        device_id: "device-1",
        source_instance_id: sourceInstanceId,
        state:
          req.method === "GET"
            ? { messages: { cursor: "abc" } }
            : ((body ? JSON.parse(body) : { state: {} }).state ?? {}),
        updated_at: "2026-04-30T12:00:00.000Z",
      });
      return;
    }
    sendJson(res, 200, { ok: true });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    url: `http://127.0.0.1:${address.port}`,
  };
}

async function startStatusServer(status: number, body: string): Promise<{ close: () => Promise<void>; url: string }> {
  const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    url: `http://127.0.0.1:${address.port}`,
  };
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
