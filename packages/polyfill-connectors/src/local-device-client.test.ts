import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { test } from "node:test";
import { LOCAL_DEVICE_ENDPOINTS, LocalDeviceClient } from "./local-device-client.ts";

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
    assert.deepEqual(seen[0]?.body, {
      connector_id: "codex",
      records_pending: 3,
      source_instance_id: "source-1",
      status: "healthy",
    });
    assert.equal(seen[1]?.path, LOCAL_DEVICE_ENDPOINTS.ingestBatch("device-1"));
    assert.equal(seen[1]?.authorization, "Bearer device-token");
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

interface SeenRequest {
  authorization: string | undefined;
  body: unknown;
  path: string;
}

async function startJsonServer(seen: SeenRequest[]): Promise<{ close: () => Promise<void>; url: string }> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const body = await readRequestBody(req);
    seen.push({
      authorization: req.headers.authorization,
      body: body ? JSON.parse(body) : null,
      path: req.url ?? "",
    });
    if (req.url === LOCAL_DEVICE_ENDPOINTS.exchangeEnrollment) {
      sendJson(res, 200, { device_id: "device-1", device_token: "token-1", source_instance_id: "source-1" });
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
