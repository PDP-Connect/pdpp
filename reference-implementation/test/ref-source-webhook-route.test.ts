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
import { closePostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import {
  createPostgresConnectorInstanceStore,
  createSqliteConnectorInstanceStore,
} from "../server/stores/connector-instance-store.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

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
  fn: (input: {
    asUrl: string;
    connectorInstanceId: string;
    rsUrl: string;
    secret: string;
    sourceId: string;
  }) => Promise<void>
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
    await fn({
      asUrl,
      connectorInstanceId: "cin_spotify_legacy_webhook",
      rsUrl,
      secret,
      sourceId: "spotify",
    });
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
  storage?: "postgres" | "sqlite";
}): Promise<void> {
  const now = new Date().toISOString();
  const store =
    input.storage === "postgres" ? createPostgresConnectorInstanceStore() : createSqliteConnectorInstanceStore();
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

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);

async function withPostgresHarness(
  fn: (input: {
    asUrl: string;
    connectorInstanceId: string;
    rsUrl: string;
    secret: string;
    sourceId: string;
  }) => Promise<void>
): Promise<void> {
  assert.ok(POSTGRES_URL, "PDPP_TEST_POSTGRES_URL must target the disposable Postgres listener");
  const oldDatabaseUrl = process.env.PDPP_DATABASE_URL;
  const oldStorageBackend = process.env.PDPP_STORAGE_BACKEND;
  const oldSecrets = process.env.PDPP_SOURCE_WEBHOOK_SECRETS;
  const secret = "spotify_source_secret_pg_route";
  const sourceId = "spotify";
  const connectorInstanceId = "cin_spotify_pg_webhook";
  const databaseName = `pdpp_test_source_webhook_route_${process.pid}_${Date.now().toString(36)}`;
  try {
    await withTemporaryPostgresDatabase(
      { closeConnections: closePostgresStorage, connectionString: POSTGRES_URL, databaseName },
      async (databaseUrl) => {
        process.env.PDPP_DATABASE_URL = databaseUrl;
        process.env.PDPP_STORAGE_BACKEND = "postgres";
        process.env.PDPP_SOURCE_WEBHOOK_SECRETS = `spotify:${secret}:${sourceId}`;
        const manifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, "manifests/spotify.json"), "utf8"));
        const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
        try {
          const asUrl = `http://localhost:${server.asPort}`;
          const rsUrl = `http://localhost:${server.rsPort}`;
          const registerResp = await fetch(`${asUrl}/connectors`, {
            body: JSON.stringify(manifest),
            headers: { "Content-Type": "application/json" },
            method: "POST",
          });
          assert.equal(registerResp.status, 201);
          await seedConnectorInstance({
            connectorId: sourceId,
            connectorInstanceId,
            displayName: "Postgres webhook",
            ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
            sourceBindingKey: "pg-webhook@example.com",
            storage: "postgres",
          });
          await fn({ asUrl, connectorInstanceId, rsUrl, secret, sourceId });
        } finally {
          await closeServer(server);
          await closePostgresStorage();
        }
      }
    );
  } finally {
    if (oldDatabaseUrl === undefined) {
      delete process.env.PDPP_DATABASE_URL;
    } else {
      process.env.PDPP_DATABASE_URL = oldDatabaseUrl;
    }
    if (oldStorageBackend === undefined) {
      delete process.env.PDPP_STORAGE_BACKEND;
    } else {
      process.env.PDPP_STORAGE_BACKEND = oldStorageBackend;
    }
    if (oldSecrets === undefined) {
      delete process.env.PDPP_SOURCE_WEBHOOK_SECRETS;
    } else {
      process.env.PDPP_SOURCE_WEBHOOK_SECRETS = oldSecrets;
    }
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

async function setWebhookBackgroundSafety(input: {
  backgroundSafe: boolean;
  connectorId: string;
  storage: "postgres" | "sqlite";
}): Promise<void> {
  const manifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, "manifests/spotify.json"), "utf8"));
  manifest.capabilities = {
    ...(manifest.capabilities ?? {}),
    refresh_policy: {
      ...(manifest.capabilities?.refresh_policy ?? {}),
      background_safe: input.backgroundSafe,
      rationale: "Exercise source-webhook policy-transition idempotency.",
      recommended_mode: "automatic",
    },
  };
  if (input.storage === "postgres") {
    await postgresQuery("UPDATE connectors SET manifest = $1::jsonb WHERE connector_id = $2", [
      JSON.stringify(manifest),
      input.connectorId,
    ]);
    return;
  }
  getDb()
    .prepare("UPDATE connectors SET manifest = ? WHERE connector_id = ?")
    .run(JSON.stringify(manifest), input.connectorId);
}

async function assertBlockedScheduleStaysGenericDuplicate(input: {
  connectorInstanceId: string;
  countActiveRuns: () => Promise<number>;
  countReceipts: () => Promise<number>;
  countGenericClaims: () => Promise<number>;
  rsUrl: string;
  secret: string;
  setBackgroundSafety: (backgroundSafe: boolean) => Promise<void>;
  sourceId: string;
}): Promise<void> {
  const body = '{"action":"schedule_run"}';
  const eventId = "evt_schedule_blocked_then_allowed";
  await input.setBackgroundSafety(false);
  const blocked = await postWebhook(input.rsUrl, input.sourceId, input.secret, eventId, body);
  assert.equal(blocked.status, 200, JSON.stringify(blocked.body));
  assert.equal(blocked.body.duplicate, false);
  assert.equal(objectField(blocked.body, "automation_policy").allowed_to_start, false);
  assert.equal(await input.countGenericClaims(), 1);
  assert.equal(await input.countReceipts(), 0);

  await input.setBackgroundSafety(true);
  const retry = await postWebhook(input.rsUrl, input.sourceId, input.secret, eventId, body);
  assert.equal(retry.status, 202);
  assert.equal(retry.body.duplicate, true);
  assert.equal(await input.countGenericClaims(), 1);
  assert.equal(await input.countReceipts(), 0, "a generic-claimed event must not enter receipt admission later");
  assert.equal(await input.countActiveRuns(), 0, "a generic-claimed event must not start a later run");
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
  await withHarness(async ({ asUrl, connectorInstanceId, rsUrl, secret, sourceId }) => {
    const eventId = "evt_schedule_1";
    const body = '{"action":"schedule_run"}';
    const result = await postWebhook(rsUrl, sourceId, secret, eventId, body);
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

    const receipt = getDb()
      .prepare(
        `SELECT source_id, event_id, body_hash, connector_id, connector_instance_id,
                owner_subject_id, action, run_id, trace_id
           FROM source_webhook_run_receipts
          WHERE source_id = ? AND event_id = ?`
      )
      .get(sourceId, eventId) as
      | {
          action: string;
          body_hash: string;
          connector_id: string;
          connector_instance_id: string;
          event_id: string;
          owner_subject_id: string;
          run_id: string;
          source_id: string;
          trace_id: string;
        }
      | undefined;
    assert.ok(receipt, "the live HTTP route must persist the source-webhook dispatch receipt");
    assert.equal(receipt.source_id, sourceId);
    assert.equal(receipt.event_id, eventId);
    assert.equal(receipt.body_hash, createHmac("sha256", secret).update(body).digest("hex"));
    assert.equal(receipt.connector_id, canonicalConnectorKey(sourceId));
    assert.equal(receipt.connector_instance_id, connectorInstanceId);
    assert.equal(receipt.run_id, runId);
    assert.equal(receipt.trace_id, stringField(run, "trace_id"));

    const routeReplay = await postWebhook(rsUrl, sourceId, secret, eventId, body);
    assert.equal(routeReplay.status, 200);
    assert.equal(routeReplay.body.duplicate, false);
    assert.equal(stringField(objectField(routeReplay.body, "run"), "run_id"), runId);
    assert.equal(stringField(objectField(routeReplay.body, "run"), "trace_id"), receipt.trace_id);

    assert.equal(
      (
        getDb()
          .prepare("SELECT COUNT(*) AS count FROM controller_active_runs WHERE connector_instance_id = ?")
          .get(connectorInstanceId) as { count: number }
      ).count,
      0,
      "terminal cleanup must remove the active admission before receipt replay"
    );

    const conflictBody = '{"action":"schedule_run","conflict":true}';
    const conflict = await postWebhook(rsUrl, sourceId, secret, eventId, conflictBody);
    assert.equal(conflict.status, 409);
    assert.equal(objectField(conflict.body, "error").code, "source_webhook_event_conflict");
    assert.equal(objectField(conflict.body, "error").type, "api_error");
    assert.equal(
      (
        getDb()
          .prepare("SELECT COUNT(*) AS count FROM source_webhook_run_receipts WHERE source_id = ? AND event_id = ?")
          .get(sourceId, eventId) as { count: number }
      ).count,
      1,
      "a body conflict must not create a second receipt"
    );
    assert.equal(
      (
        getDb()
          .prepare("SELECT COUNT(*) AS count FROM controller_active_runs WHERE connector_instance_id = ?")
          .get(connectorInstanceId) as { count: number }
      ).count,
      0,
      "a body conflict must not admit a second active run"
    );
  });
});

test("source webhook route keeps a blocked signed schedule event generic after policy becomes allowed", async () => {
  await withHarness(async ({ connectorInstanceId, rsUrl, secret, sourceId }) => {
    await assertBlockedScheduleStaysGenericDuplicate({
      connectorInstanceId,
      countActiveRuns: async () =>
        Number(
          (
            getDb()
              .prepare("SELECT COUNT(*) AS count FROM controller_active_runs WHERE connector_instance_id = ?")
              .get(connectorInstanceId) as { count: number }
          ).count
        ),
      countGenericClaims: async () =>
        Number(
          (
            getDb()
              .prepare("SELECT COUNT(*) AS count FROM source_webhook_events WHERE source_id = ? AND event_id = ?")
              .get(sourceId, "evt_schedule_blocked_then_allowed") as { count: number }
          ).count
        ),
      countReceipts: async () =>
        Number(
          (
            getDb()
              .prepare("SELECT COUNT(*) AS count FROM source_webhook_run_receipts WHERE source_id = ? AND event_id = ?")
              .get(sourceId, "evt_schedule_blocked_then_allowed") as { count: number }
          ).count
        ),
      rsUrl,
      secret,
      setBackgroundSafety: async (backgroundSafe) =>
        await setWebhookBackgroundSafety({
          backgroundSafe,
          connectorId: canonicalConnectorKey(sourceId) ?? sourceId,
          storage: "sqlite",
        }),
      sourceId,
    });
  });
});

test("source webhook route replays schedule receipt on live PostgreSQL", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset or not a dedicated test URL",
}, async () => {
  await withPostgresHarness(async ({ asUrl, connectorInstanceId, rsUrl, secret, sourceId }) => {
    const eventId = "evt_schedule_pg_route";
    const body = '{"action":"schedule_run"}';
    const first = await postWebhook(rsUrl, sourceId, secret, eventId, body);
    assert.equal(first.status, 200);
    const run = objectField(first.body, "run");
    const runId = stringField(run, "run_id");
    await waitForRunTerminal(asUrl, runId);

    const receiptResult = await postgresQuery<{
      body_hash: string;
      connector_instance_id: string;
      event_id: string;
      run_id: string;
      source_id: string;
    }>(
      `SELECT source_id, event_id, body_hash, connector_instance_id, run_id
         FROM source_webhook_run_receipts
        WHERE source_id = $1 AND event_id = $2`,
      [sourceId, eventId]
    );
    const [receipt] = receiptResult.rows;
    assert.ok(receipt, "the live HTTP route must persist the Postgres receipt");
    assert.equal(receipt.body_hash, createHmac("sha256", secret).update(body).digest("hex"));
    assert.equal(receipt.connector_instance_id, connectorInstanceId);
    assert.equal(receipt.run_id, runId);

    const replay = await postWebhook(rsUrl, sourceId, secret, eventId, body);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.duplicate, false);
    assert.equal(stringField(objectField(replay.body, "run"), "run_id"), runId);
    assert.equal(stringField(objectField(replay.body, "run"), "trace_id"), stringField(run, "trace_id"));

    const conflict = await postWebhook(rsUrl, sourceId, secret, eventId, '{"action":"schedule_run","conflict":true}');
    assert.equal(conflict.status, 409);
    assert.equal(objectField(conflict.body, "error").code, "source_webhook_event_conflict");
    const count = await postgresQuery<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM source_webhook_run_receipts WHERE source_id = $1 AND event_id = $2",
      [sourceId, eventId]
    );
    assert.equal(count.rows[0]?.count, "1");
    const active = await postgresQuery<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM controller_active_runs WHERE connector_instance_id = $1",
      [connectorInstanceId]
    );
    assert.equal(active.rows[0]?.count, "0");
  });
});

test("source webhook route keeps a blocked signed schedule event generic on live PostgreSQL", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset or not a dedicated test URL",
}, async () => {
  await withPostgresHarness(async ({ connectorInstanceId, rsUrl, secret, sourceId }) => {
    await assertBlockedScheduleStaysGenericDuplicate({
      connectorInstanceId,
      countActiveRuns: async () => {
        const result = await postgresQuery<{ count: string }>(
          "SELECT COUNT(*)::text AS count FROM controller_active_runs WHERE connector_instance_id = $1",
          [connectorInstanceId]
        );
        return Number(result.rows[0]?.count ?? 0);
      },
      countGenericClaims: async () => {
        const result = await postgresQuery<{ count: string }>(
          "SELECT COUNT(*)::text AS count FROM source_webhook_events WHERE source_id = $1 AND event_id = $2",
          [sourceId, "evt_schedule_blocked_then_allowed"]
        );
        return Number(result.rows[0]?.count ?? 0);
      },
      countReceipts: async () => {
        const result = await postgresQuery<{ count: string }>(
          "SELECT COUNT(*)::text AS count FROM source_webhook_run_receipts WHERE source_id = $1 AND event_id = $2",
          [sourceId, "evt_schedule_blocked_then_allowed"]
        );
        return Number(result.rows[0]?.count ?? 0);
      },
      rsUrl,
      secret,
      setBackgroundSafety: async (backgroundSafe) =>
        await setWebhookBackgroundSafety({
          backgroundSafe,
          connectorId: canonicalConnectorKey(sourceId) ?? sourceId,
          storage: "postgres",
        }),
      sourceId,
    });
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
