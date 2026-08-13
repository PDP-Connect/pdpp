// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { SOURCE_WEBHOOK_MAX_BODY_BYTES } from "../operations/ref-source-webhook-ingest/index.ts";
import { canonicalConnectorKey } from "../server/connector-key.ts";
import { getDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from "../server/owner-auth.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";

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

function sign(secret: string, eventId: string, timestamp: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${eventId}.${timestamp}.${body}`).digest("hex")}`;
}

function bodyWithByteLength(byteLength: number, action: "ingest_records" | "schedule_run"): string {
  const base =
    action === "ingest_records" ? { action, padding: "", records: [], stream: "top_artists" } : { action, padding: "" };
  const baseBody = JSON.stringify(base);
  const paddingLength = byteLength - Buffer.byteLength(baseBody);
  assert.ok(paddingLength >= 0, `fixture base body exceeds requested length ${byteLength}`);
  return JSON.stringify({ ...base, padding: "x".repeat(paddingLength) });
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
    await seedConnectorInstance({
      connectorId: sourceId,
      connectorInstanceId: "cin_spotify_legacy_webhook",
      displayName: "Legacy webhook",
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      sourceBindingKey: "legacy-webhook@example.com",
    });
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

async function withRegisteredServer(
  input: {
    ownerSubjectId?: string;
    secrets: string;
  },
  fn: (input: { asUrl: string; rsUrl: string; spotifyConnectorId: string }) => Promise<void>
): Promise<void> {
  const oldSecrets = process.env.PDPP_SOURCE_WEBHOOK_SECRETS;
  const spotifyManifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, "manifests/spotify.json"), "utf8"));
  process.env.PDPP_SOURCE_WEBHOOK_SECRETS = input.secrets;
  const serverOpts: Parameters<typeof startServer>[0] = {
    asPort: 0,
    dbPath: ":memory:",
    quiet: true,
    rsPort: 0,
  };
  if (input.ownerSubjectId) {
    serverOpts.ownerAuthSubjectId = input.ownerSubjectId;
  }
  const server = await startServer(serverOpts);
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  try {
    const registerResp = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(spotifyManifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);
    await fn({ asUrl, rsUrl, spotifyConnectorId: spotifyManifest.connector_id });
  } finally {
    if (oldSecrets === undefined) {
      delete process.env.PDPP_SOURCE_WEBHOOK_SECRETS;
    } else {
      process.env.PDPP_SOURCE_WEBHOOK_SECRETS = oldSecrets;
    }
    await closeServer(server);
  }
}

async function seedConnectorInstance(input: {
  connectorId: string;
  connectorInstanceId: string;
  displayName: string;
  ownerSubjectId: string;
  sourceBindingKey: string;
}): Promise<void> {
  const now = new Date().toISOString();
  const store = createSqliteConnectorInstanceStore();
  const connectorId = canonicalConnectorKey(input.connectorId) ?? input.connectorId;
  await store.upsert({
    connectorId,
    connectorInstanceId: input.connectorInstanceId,
    createdAt: now,
    displayName: input.displayName,
    ownerSubjectId: input.ownerSubjectId,
    sourceBinding: { account: input.sourceBindingKey },
    sourceBindingKey: input.sourceBindingKey,
    sourceKind: "account",
    status: "active",
    updatedAt: now,
  });
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
      "PDPP-Webhook-Signature": sign(secret, eventId, timestamp, body),
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

test("source webhook route enforces the one-byte body boundary before claiming an event", async () => {
  await withHarness(async ({ rsUrl, secret, sourceId }) => {
    const justUnder = await postWebhook(
      rsUrl,
      sourceId,
      secret,
      "evt_body_under",
      bodyWithByteLength(SOURCE_WEBHOOK_MAX_BODY_BYTES - 1, "ingest_records")
    );
    assert.equal(justUnder.status, 200);

    const exact = await postWebhook(
      rsUrl,
      sourceId,
      secret,
      "evt_body_exact",
      bodyWithByteLength(SOURCE_WEBHOOK_MAX_BODY_BYTES, "ingest_records")
    );
    assert.equal(exact.status, 200);

    const over = await postWebhook(
      rsUrl,
      sourceId,
      secret,
      "evt_body_over",
      bodyWithByteLength(SOURCE_WEBHOOK_MAX_BODY_BYTES + 1, "ingest_records")
    );
    assert.equal(over.status, 413);
    const error = objectField(over.body, "error");
    assert.equal(error.type, "request_entity_too_large_error");
    assert.equal(error.code, "resource_limit");
    assert.equal(
      (
        getDb()
          .prepare("SELECT COUNT(*) AS n FROM source_webhook_events WHERE source_id = ? AND event_id = ?")
          .get(sourceId, "evt_body_over") as { n: number }
      ).n,
      0
    );

    const oversizedSchedule = await postWebhook(
      rsUrl,
      sourceId,
      secret,
      "evt_schedule_over",
      bodyWithByteLength(SOURCE_WEBHOOK_MAX_BODY_BYTES + 1, "schedule_run")
    );
    assert.equal(oversizedSchedule.status, 413);
    assert.equal(
      (
        getDb()
          .prepare("SELECT COUNT(*) AS n FROM source_webhook_events WHERE source_id = ? AND event_id = ?")
          .get(sourceId, "evt_schedule_over") as { n: number }
      ).n,
      0
    );
  });
});

test("source webhook route resolves structured config to exact real owner connection", async () => {
  const ownerSubjectId = "owner_custom_source_webhook";
  const secret = "structured_source_secret";
  const selectedInstanceId = "cin_spotify_structured_selected";
  const siblingInstanceId = "cin_spotify_structured_sibling";
  const sourceId = "spotify-structured";

  await withRegisteredServer(
    {
      ownerSubjectId,
      secrets: JSON.stringify([
        {
          connector_id: "https://registry.pdpp.dev/connectors/spotify",
          connector_instance_id: selectedInstanceId,
          owner_subject_id: ownerSubjectId,
          secret,
          source_id: sourceId,
        },
      ]),
    },
    async ({ rsUrl, spotifyConnectorId }) => {
      await seedConnectorInstance({
        connectorId: spotifyConnectorId,
        connectorInstanceId: siblingInstanceId,
        displayName: "Structured sibling",
        ownerSubjectId,
        sourceBindingKey: "structured-sibling@example.com",
      });
      await seedConnectorInstance({
        connectorId: spotifyConnectorId,
        connectorInstanceId: selectedInstanceId,
        displayName: "Structured selected",
        ownerSubjectId,
        sourceBindingKey: "structured-selected@example.com",
      });

      const body = JSON.stringify({
        action: "ingest_records",
        records: [
          {
            data: { id: "artist_structured_selected", name: "Structured Artist" },
            emitted_at: new Date().toISOString(),
            key: "artist_structured_selected",
          },
        ],
        stream: "top_artists",
      });
      const first = await postWebhook(rsUrl, sourceId, secret, "evt_structured_selected", body);
      assert.equal(first.status, 200);
      assert.equal(objectField(first.body, "ingest").records_accepted, 1);

      const rows = getDb()
        .prepare(
          `SELECT connector_instance_id, record_key
             FROM records
            WHERE connector_id = ?
              AND stream = ?
              AND record_key = ?
            ORDER BY connector_instance_id`
        )
        .all("spotify", "top_artists", "artist_structured_selected");
      assert.deepEqual(rows, [{ connector_instance_id: selectedInstanceId, record_key: "artist_structured_selected" }]);
    }
  );
});

test("source webhook route rejects bad structured target before claim or mutation", async () => {
  const ownerSubjectId = "owner_custom_source_webhook_retry";
  const secret = "structured_retry_secret";
  const selectedInstanceId = "cin_spotify_structured_retry";
  const sourceId = "spotify-structured-retry";
  const eventId = "evt_structured_retry";
  const body = JSON.stringify({
    action: "ingest_records",
    records: [
      {
        data: { id: "artist_structured_retry", name: "Structured Retry Artist" },
        emitted_at: new Date().toISOString(),
        key: "artist_structured_retry",
      },
    ],
    stream: "top_artists",
  });

  await withRegisteredServer(
    {
      ownerSubjectId,
      secrets: JSON.stringify([
        {
          connector_id: "https://registry.pdpp.dev/connectors/spotify",
          connector_instance_id: "cin_spotify_missing_target",
          owner_subject_id: ownerSubjectId,
          secret,
          source_id: sourceId,
        },
      ]),
    },
    async ({ rsUrl, spotifyConnectorId }) => {
      await seedConnectorInstance({
        connectorId: spotifyConnectorId,
        connectorInstanceId: selectedInstanceId,
        displayName: "Structured retry selected",
        ownerSubjectId,
        sourceBindingKey: "structured-retry@example.com",
      });

      const rejected = await postWebhook(rsUrl, sourceId, secret, eventId, body);
      assert.equal(rejected.status, 404);
      assert.equal(
        (
          getDb()
            .prepare("SELECT COUNT(*) AS n FROM source_webhook_events WHERE source_id = ? AND event_id = ?")
            .get(sourceId, eventId) as { n: number }
        ).n,
        0
      );
      assert.equal(
        (
          getDb()
            .prepare("SELECT COUNT(*) AS n FROM records WHERE connector_instance_id = ?")
            .get(selectedInstanceId) as {
            n: number;
          }
        ).n,
        0
      );

      process.env.PDPP_SOURCE_WEBHOOK_SECRETS = JSON.stringify([
        {
          connector_id: "https://registry.pdpp.dev/connectors/spotify",
          connector_instance_id: selectedInstanceId,
          owner_subject_id: ownerSubjectId,
          secret,
          source_id: sourceId,
        },
      ]);
      const accepted = await postWebhook(rsUrl, sourceId, secret, eventId, body);
      assert.equal(accepted.status, 200);
      assert.equal(objectField(accepted.body, "ingest").records_accepted, 1);
    }
  );
});
