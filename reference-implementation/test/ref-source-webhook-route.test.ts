// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { startServer } from "../server/index.ts";

type TestServer = Awaited<ReturnType<typeof startServer>>;
type JsonObject = Record<string, unknown>;

function objectField(value: JsonObject, field: string): JsonObject {
  const nested = value[field];
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) {
    throw new Error(`expected object field ${field}`);
  }
  return nested as JsonObject;
}

function stringField(value: JsonObject, field: string): string {
  const nested = value[field];
  if (typeof nested !== "string") {
    throw new Error(`expected string field ${field}`);
  }
  return nested;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, "..");

async function closeServer(server: TestServer): Promise<void> {
  await Promise.allSettled([
    new Promise((resolve) => server.asServer.close(resolve)),
    new Promise((resolve) => server.rsServer.close(resolve)),
  ]);
}

function sign(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

async function withHarness(
  fn: (input: { asUrl: string; rsUrl: string; secret: string; sourceId: string }) => Promise<void>
): Promise<void> {
  const oldSecrets = process.env.PDPP_SOURCE_WEBHOOK_SECRETS;
  const secret = "spotify_source_secret";
  const spotifyManifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, "manifests/spotify.json"), "utf8"));
  const sourceId = spotifyManifest.connector_id;
  process.env.PDPP_SOURCE_WEBHOOK_SECRETS = `spotify:${secret}:${sourceId}`;
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  try {
    const registerResp = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(spotifyManifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);
    await fn({ asUrl, rsUrl, secret, sourceId: "spotify" });
  } finally {
    if (oldSecrets === undefined) {
      delete process.env.PDPP_SOURCE_WEBHOOK_SECRETS;
    } else {
      process.env.PDPP_SOURCE_WEBHOOK_SECRETS = oldSecrets;
    }
    await closeServer(server);
  }
}

async function waitForRunTerminal(asUrl: string, runId: string, timeoutMs = 5000): Promise<JsonObject> {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<JsonObject> => {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for webhook run ${runId}`);
    }
    const resp = await fetch(`${asUrl}/_ref/runs/${encodeURIComponent(runId)}/timeline`);
    if (resp.status === 200) {
      const raw: unknown = await resp.json();
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error("expected timeline object");
      }
      const body = raw as JsonObject;
      if (
        Array.isArray(body.data) &&
        body.data.some(
          (event) =>
            !!event &&
            typeof event === "object" &&
            ((event as JsonObject).event_type === "run.completed" || (event as JsonObject).event_type === "run.failed")
        )
      ) {
        return body;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
    return poll();
  };
  return await poll();
}

async function postWebhook(
  rsUrl: string,
  sourceId: string,
  secret: string,
  eventId: string,
  body: string
): Promise<{ status: number; body: JsonObject }> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const resp = await fetch(`${rsUrl}/_ref/source-webhooks/${encodeURIComponent(sourceId)}`, {
    body,
    headers: {
      "Content-Type": "text/plain",
      "PDPP-Webhook-Event-Id": eventId,
      "PDPP-Webhook-Signature": sign(secret, timestamp, body),
      "PDPP-Webhook-Timestamp": timestamp,
    },
    method: "POST",
  });
  const raw: unknown = await resp.json();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("expected webhook response object");
  }
  return { body: raw as JsonObject, status: resp.status };
}

test("source webhook route rejects missing signature before mutation", async () => {
  await withHarness(async ({ rsUrl }) => {
    const resp = await fetch(`${rsUrl}/_ref/source-webhooks/spotify`, {
      body: '{"action":"schedule_run"}',
      headers: { "Content-Type": "text/plain" },
      method: "POST",
    });
    assert.equal(resp.status, 401);
    const raw: unknown = await resp.json();
    assert.ok(raw && typeof raw === "object" && !Array.isArray(raw));
    const body = raw as JsonObject;
    const error = objectField(body, "error");
    assert.equal(error.code, "missing_event_id");
  });
});

test("source webhook route ingests signed records and dedupes event id", async () => {
  await withHarness(async ({ rsUrl, secret, sourceId }) => {
    const body = JSON.stringify({
      action: "ingest_records",
      records: [
        {
          data: { id: "artist_webhook_1", name: "Webhook Artist" },
          emitted_at: new Date().toISOString(),
          key: "artist_webhook_1",
        },
      ],
      stream: "top_artists",
    });
    const first = await postWebhook(rsUrl, sourceId, secret, "evt_ingest_1", body);
    assert.equal(first.status, 200);
    assert.equal(objectField(first.body, "ingest").records_accepted, 1);

    const duplicate = await postWebhook(rsUrl, sourceId, secret, "evt_ingest_1", body);
    assert.equal(duplicate.status, 202);
    assert.equal(duplicate.body.duplicate, true);
  });
});

test("source webhook route accepts schedule_run as a webhook-classified run request", async () => {
  await withHarness(async ({ asUrl, rsUrl, secret, sourceId }) => {
    const result = await postWebhook(rsUrl, sourceId, secret, "evt_schedule_1", '{"action":"schedule_run"}');
    assert.equal(result.status, 200);
    assert.equal(result.body.action, "schedule_run");
    assert.equal(result.body.accepted, true);
    assert.equal(result.body.trigger_kind, "webhook");
    const run = objectField(result.body, "run");
    assert.equal(run.trigger_kind, "webhook");
    const runId = stringField(run, "run_id");
    assert.ok(runId.startsWith("run_"));
    const timeline = await waitForRunTerminal(asUrl, runId);
    assert.ok(Array.isArray(timeline.data));
    const started = timeline.data.find(
      (event): boolean => !!event && typeof event === "object" && (event as JsonObject).event_type === "run.started"
    );
    assert.ok(started && typeof started === "object");
    assert.equal(objectField(started as JsonObject, "data").trigger_kind, "webhook");
  });
});
