// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Tests for the device-scoped local collector state routes defined under
// OpenSpec `design-local-collector-state-sync`:
//
//   GET  /_ref/device-exporters/:deviceId/source-instances/:sourceInstanceId/state
//   PUT  /_ref/device-exporters/:deviceId/source-instances/:sourceInstanceId/state
//
// These routes are reference-only and authenticated by the existing
// `requireDeviceExporterCredential` middleware. They store state under the
// local-device connector namespace plus the authorized connector instance id
// so they cannot collide with owner-auth `/v1/state/:connectorId` rows.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { COLLECTOR_PROTOCOL_VERSION } from "../server/collector-protocol.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";

const PROTOCOL_HEADERS = { "X-PDPP-Collector-Protocol": COLLECTOR_PROTOCOL_VERSION };
const CONNECTOR_INSTANCE_ID_PATTERN = /^cin_/;
const LEGACY_SOURCE_PATTERN = /Cannot migrate local-device source_instance_id/;
const MULTIPLE_INSTANCE_PATTERN = /multiple connector_instance_ids/;

function typedDb(): ReturnType<typeof getDb> {
  return getDb();
}

function mustExist<T>(value: T | null | undefined, description: string): T {
  assert.ok(value, description);
  return value;
}

interface CloseableTestServer {
  readonly asPort: number;
  readonly asServer: { closeAllConnections?: () => void; close: (callback: () => void) => void };
  readonly rsServer: { closeAllConnections?: () => void; close: (callback: () => void) => void };
}

async function closeServer(server: CloseableTestServer): Promise<void> {
  server.asServer.closeAllConnections?.();
  server.rsServer.closeAllConnections?.();
  const closeOne = (srv: CloseableTestServer["asServer"]) =>
    new Promise<void>((resolve) => {
      let settled = false;
      const t = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve();
        }
      }, 2000);
      srv.close(() => {
        if (!settled) {
          settled = true;
          clearTimeout(t);
          resolve();
        }
      });
    });
  await Promise.allSettled([closeOne(server.asServer), closeOne(server.rsServer)]);
}

async function withServer(fn: (context: { asUrl: string }) => Promise<void>): Promise<void> {
  const server: CloseableTestServer = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    quiet: true,
    rsPort: 0,
  });
  const asUrl = `http://localhost:${server.asPort}`;
  try {
    await fn({ asUrl });
  } finally {
    await closeServer(server);
  }
}

interface JsonResponse {
  readonly body: Record<string, unknown> | null;
  readonly status: number;
}

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<JsonResponse> {
  const resp = await fetch(url, {
    body: JSON.stringify(body),
    headers: { Accept: "application/json", "Content-Type": "application/json", ...headers },
    method: "POST",
  });
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = (await resp.json()) as Record<string, unknown>;
  } catch {
    // Non-JSON error responses intentionally retain a null parsed body.
  }
  return { body: parsed, status: resp.status };
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<JsonResponse> {
  const resp = await fetch(url, {
    headers: { Accept: "application/json", ...headers },
    method: "GET",
  });
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = (await resp.json()) as Record<string, unknown>;
  } catch {
    // Non-JSON error responses intentionally retain a null parsed body.
  }
  return { body: parsed, status: resp.status };
}

async function putJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<JsonResponse> {
  const resp = await fetch(url, {
    body: JSON.stringify(body),
    headers: { Accept: "application/json", "Content-Type": "application/json", ...headers },
    method: "PUT",
  });
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = (await resp.json()) as Record<string, unknown>;
  } catch {
    // Non-JSON error responses intentionally retain a null parsed body.
  }
  return { body: parsed, status: resp.status };
}

function bodyOf(response: JsonResponse): Record<string, unknown> {
  assert.ok(response.body, "response has a JSON body");
  return response.body;
}

function stringField(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  assert.equal(typeof value, "string", `${field} must be a string`);
  return value as string;
}

function errorCode(response: JsonResponse): string {
  const { error } = bodyOf(response);
  assert.ok(error && typeof error === "object", "response body must carry an error object");
  return stringField(error as Record<string, unknown>, "code");
}

function authHeaders(deviceToken: string): Record<string, string> {
  return { Authorization: `Bearer ${deviceToken}`, ...PROTOCOL_HEADERS };
}

interface EnrolledDevice {
  readonly connector_id: string;
  readonly connector_instance_id: string;
  readonly device_id: string;
  readonly device_token: string;
  readonly source_instance_id: string;
}

async function enrollDevice(asUrl: string, localBindingName: string): Promise<EnrolledDevice> {
  const codeResp = await postJson(`${asUrl}/_ref/device-exporters/enrollment-codes`, {
    connector_id: "codex",
    local_binding_name: localBindingName,
  });
  assert.equal(codeResp.status, 201, JSON.stringify(codeResp.body));
  const enrollResp = await postJson(
    `${asUrl}/_ref/device-exporters/enroll`,
    { enrollment_code: stringField(bodyOf(codeResp), "enrollment_code") },
    PROTOCOL_HEADERS
  );
  assert.equal(enrollResp.status, 201, JSON.stringify(enrollResp.body));
  const body = bodyOf(enrollResp);
  assert.match(stringField(body, "connector_instance_id"), CONNECTOR_INSTANCE_ID_PATTERN);
  return {
    connector_id: stringField(body, "connector_id"),
    connector_instance_id: stringField(body, "connector_instance_id"),
    device_id: stringField(body, "device_id"),
    device_token: stringField(body, "device_token"),
    source_instance_id: stringField(body, "source_instance_id"),
  };
}

function stateUrl(asUrl: string, deviceId: string, sourceInstanceId: string): string {
  return `${asUrl}/_ref/device-exporters/${encodeURIComponent(deviceId)}/source-instances/${encodeURIComponent(sourceInstanceId)}/state`;
}

// Live local-device storage key: the bare canonical connector key. Connection
// isolation is carried by connector_instance_id, not a `local-device:` prefix.
// See canonicalize-connector-keys design Decision 7.
function localDeviceConnectorId(connectorId: string): string {
  return connectorId;
}

// The pre-migration on-disk form: `local-device:<id>:<source_instance_id>`.
// Only used to seed legacy rows the startup migration must relocate.
function legacyLocalDeviceConnectorId(connectorId: string, sourceInstanceId: string): string {
  return `local-device:${encodeURIComponent(connectorId)}:${encodeURIComponent(sourceInstanceId)}`;
}

function hashDeviceSecret(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

type CanonicalValue = null | string | number | boolean | CanonicalValue[] | { [key: string]: CanonicalValue };

function canonicalValue(value: unknown): CanonicalValue {
  if (value === null || typeof value !== "object") {
    return value as CanonicalValue;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  const record = value as Record<string, unknown>;
  const out: { [key: string]: CanonicalValue } = {};
  for (const key of Object.keys(record).sort()) {
    out[key] = canonicalValue(record[key]);
  }
  return out;
}

function makeBatch(device: EnrolledDevice, batchId: string, value: string) {
  const records = [
    {
      data: { id: "after-migration", value },
      emitted_at: "2026-04-30T12:00:00.000Z",
      record_key: "after-migration",
      stream: "messages",
    },
  ];
  return {
    batch_id: batchId,
    batch_seq: 1,
    body_hash: createHash("sha256")
      .update(JSON.stringify(canonicalValue(records)))
      .digest("hex"),
    connector_id: device.connector_id,
    device_id: device.device_id,
    records,
    source_instance_id: device.source_instance_id,
  };
}

test("GET device state requires a valid device credential", async () => {
  await withServer(async ({ asUrl }) => {
    const device = await enrollDevice(asUrl, "laptop-a");

    // Missing auth.
    const missing = await getJson(stateUrl(asUrl, device.device_id, device.source_instance_id), PROTOCOL_HEADERS);
    assert.equal(missing.status, 401);
    assert.equal(errorCode(missing), "authentication_error");

    // Wrong auth shape.
    const wrong = await getJson(stateUrl(asUrl, device.device_id, device.source_instance_id), {
      Authorization: "NotBearer foo",
      ...PROTOCOL_HEADERS,
    });
    assert.equal(wrong.status, 401);

    // Invalid token.
    const invalid = await getJson(
      stateUrl(asUrl, device.device_id, device.source_instance_id),
      authHeaders("not-a-real-device-token")
    );
    assert.equal(invalid.status, 401);
  });
});

test("startup migrates legacy local-device source namespaces to connector-instance scope", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pdpp-local-device-migration-"));
  const dbPath = join(dir, "pdpp.sqlite");
  const device = {
    connector_id: "claude_code",
    connector_instance_id: "cin_preserved_legacy_local_device",
    device_id: "dev_legacy_local_device",
    device_token: "devtok_legacy_local_device",
    local_binding_name: "laptop-a",
    source_instance_id: "src_legacy_local_device",
  };
  const oldConnectorId = legacyLocalDeviceConnectorId(device.connector_id, device.source_instance_id);
  // Legacy `local-device:<id>:<source>` rows relocate to the bare canonical
  // connector key (`claude_code` → `claude-code`), the same key the live
  // ingest/read paths use. See canonicalize-connector-keys design Decision 7.
  const newConnectorId = "claude-code";
  try {
    initDb(dbPath);
    const db = typedDb();
    const now = "2026-05-01T00:00:00.000Z";
    // A real legacy deployment that produced local-device records also had the
    // connector registered with a full manifest (ingest requires one). Seed it
    // under the canonical key so post-migration ingest validates. The startup
    // migration's catalog upsert is ON CONFLICT DO NOTHING, so it will not
    // clobber this manifest.
    db.prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES(?, ?, ?)").run(
      newConnectorId,
      JSON.stringify({
        connector_id: newConnectorId,
        display_name: "Claude Code",
        streams: [
          {
            name: "messages",
            primary_key: ["id"],
            schema: { properties: { id: { type: "string" }, value: { type: "string" } } },
          },
        ],
      }),
      now
    );
    db.prepare(
      `INSERT INTO device_exporters(device_id, owner_subject_id, display_name, status, created_at, updated_at)
       VALUES(?, ?, ?, 'active', ?, ?)`
    ).run(device.device_id, "owner_ref", "Legacy Laptop", now, now);
    db.prepare(
      `INSERT INTO device_ingest_credentials(credential_id, device_id, token_hash, status, created_at)
       VALUES(?, ?, ?, 'active', ?)`
    ).run("cred_legacy_local_device", device.device_id, hashDeviceSecret(device.device_token), now);
    db.prepare(
      `INSERT INTO device_source_instances(source_instance_id, device_id, connector_id, connector_instance_id, local_binding_id, display_name, status, created_at, updated_at)
       VALUES(?, ?, ?, NULL, ?, ?, 'active', ?, ?)`
    ).run(
      device.source_instance_id,
      device.device_id,
      device.connector_id,
      device.local_binding_name,
      "Legacy Claude Code",
      now,
      now
    );
    db.prepare(
      `INSERT INTO connector_state(connector_id, connector_instance_id, stream, state_json, updated_at)
       VALUES(?, ?, 'messages', ?, ?)`
    ).run(oldConnectorId, device.connector_instance_id, JSON.stringify({ cursor: "legacy-cursor" }), now);
    db.prepare(
      `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version)
       VALUES(?, ?, 'messages', 'legacy-record', ?, ?, 1)`
    ).run(oldConnectorId, device.connector_instance_id, JSON.stringify({ id: "legacy-record", value: "before" }), now);
    db.prepare(
      `INSERT INTO record_changes(connector_id, connector_instance_id, stream, record_key, version, record_json, emitted_at)
       VALUES(?, ?, 'messages', 'legacy-record', 1, ?, ?)`
    ).run(oldConnectorId, device.connector_instance_id, JSON.stringify({ id: "legacy-record", value: "before" }), now);
    db.prepare(
      `INSERT INTO version_counter(connector_id, connector_instance_id, stream, max_version)
       VALUES(?, ?, 'messages', 1)`
    ).run(oldConnectorId, device.connector_instance_id);
    const migrations: Array<{ name: string }> = [];
    closeDb();
    initDb(dbPath, {
      onSchemaMigration: (event: { name: string }) => migrations.push(event),
    });
    closeDb();

    const server: CloseableTestServer = await startServer({
      asPort: 0,
      dbPath,
      quiet: true,
      rsPort: 0,
    });
    const asUrl = `http://localhost:${server.asPort}`;
    try {
      assert.ok(migrations.some((event) => event.name === "local_device_connector_instances"));

      const migratedDb = typedDb();
      const sourceRow = mustExist(
        migratedDb
          .prepare(
            "SELECT connector_instance_id FROM device_source_instances WHERE device_id = ? AND source_instance_id = ?"
          )
          .get<{ connector_instance_id: string }>(device.device_id, device.source_instance_id),
        "source row must exist after migration"
      );
      assert.equal(sourceRow.connector_instance_id, device.connector_instance_id);

      const instanceRow = mustExist(
        migratedDb
          .prepare(
            `SELECT connector_id, owner_subject_id, source_kind, source_binding_json
             FROM connector_instances
            WHERE connector_instance_id = ?`
          )
          .get<{ connector_id: string; owner_subject_id: string; source_kind: string; source_binding_json: string }>(
            device.connector_instance_id
          ),
        "instance row must exist after migration"
      );
      assert.equal(instanceRow.connector_id, newConnectorId);
      assert.equal(instanceRow.owner_subject_id, "owner_ref");
      assert.equal(instanceRow.source_kind, "local_device");
      assert.deepEqual(JSON.parse(instanceRow.source_binding_json), {
        device_id: device.device_id,
        kind: "local_device",
        local_binding_name: device.local_binding_name,
        source_instance_id: device.source_instance_id,
      });

      const stateRead = await getJson(
        stateUrl(asUrl, device.device_id, device.source_instance_id),
        authHeaders(device.device_token)
      );
      assert.equal(stateRead.status, 200, JSON.stringify(stateRead.body));
      assert.equal(bodyOf(stateRead).connector_instance_id, device.connector_instance_id);
      assert.deepEqual(bodyOf(stateRead).state, { messages: { cursor: "legacy-cursor" } });

      const statePut = await putJson(
        stateUrl(asUrl, device.device_id, device.source_instance_id),
        { state: { messages: { cursor: "post-migration" } } },
        authHeaders(device.device_token)
      );
      assert.equal(statePut.status, 200, JSON.stringify(statePut.body));

      const ingest = await postJson(
        `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
        makeBatch(device, "batch-after-migration", "after"),
        authHeaders(device.device_token)
      );
      assert.equal(ingest.status, 201, JSON.stringify(ingest.body));
      assert.equal(bodyOf(ingest).connector_instance_id, device.connector_instance_id);

      const oldRows = mustExist(
        migratedDb
          .prepare(
            `SELECT COUNT(*) AS n
             FROM (
               SELECT connector_id FROM connector_state WHERE connector_id = ?
               UNION ALL
               SELECT connector_id FROM records WHERE connector_id = ?
               UNION ALL
               SELECT connector_id FROM record_changes WHERE connector_id = ?
               UNION ALL
               SELECT connector_id FROM version_counter WHERE connector_id = ?
             )`
          )
          .get<{ n: number }>(oldConnectorId, oldConnectorId, oldConnectorId, oldConnectorId),
        "old-row count query must return a row"
      );
      assert.equal(oldRows.n, 0);

      const migratedState = mustExist(
        migratedDb
          .prepare(
            `SELECT connector_id, state_json
             FROM connector_state
            WHERE connector_instance_id = ? AND stream = 'messages'`
          )
          .get<{ connector_id: string; state_json: string }>(device.connector_instance_id),
        "migrated state row must exist"
      );
      assert.equal(migratedState.connector_id, newConnectorId);
      assert.equal(JSON.parse(migratedState.state_json).cursor, "post-migration");

      const migratedRecords = migratedDb
        .prepare(
          `SELECT record_key, connector_id
           FROM records
          WHERE connector_instance_id = ?
          ORDER BY record_key`
        )
        .all<{ record_key: string; connector_id: string }>(device.connector_instance_id);
      assert.deepEqual(
        migratedRecords.map((row) => [row.record_key, row.connector_id]),
        [
          ["after-migration", newConnectorId],
          ["legacy-record", newConnectorId],
        ]
      );
    } finally {
      await closeServer(server);
    }
  } finally {
    closeDb();
    await rm(dir, { force: true, recursive: true });
  }
});

test("startup migration fails clearly when a legacy local-device source maps to more than one connector instance", async () => {
  // complete-local-agent-collectors task 3.3 + spec scenario "Existing
  // single-device state is migrated → connector-only compatibility operations
  // SHALL fail clearly if more than one matching instance exists."
  //
  // The deterministic backfill (`migrateLocalDeviceConnectorInstances`) can
  // safely re-home a legacy `local-device:<id>:<source>` namespace into one
  // canonical connector instance ONLY when the legacy rows agree on a single
  // connector_instance_id (or the device_source_instances row already records
  // one). If the device source row has no connector_instance_id AND the legacy
  // rows disagree, re-homing them into a single instance would silently merge
  // two distinct collection histories. The migration MUST refuse rather than
  // guess — this proves it does.
  const dir = await mkdtemp(join(tmpdir(), "pdpp-local-device-ambiguous-"));
  const dbPath = join(dir, "pdpp.sqlite");
  const sourceInstanceId = "src_ambiguous_legacy";
  const oldConnectorId = legacyLocalDeviceConnectorId("claude_code", sourceInstanceId);
  try {
    initDb(dbPath);
    const db = typedDb();
    const now = "2026-05-01T00:00:00.000Z";
    db.prepare(
      `INSERT INTO device_exporters(device_id, owner_subject_id, display_name, status, created_at, updated_at)
       VALUES(?, ?, ?, 'active', ?, ?)`
    ).run("dev_ambiguous", "owner_ref", "Ambiguous Laptop", now, now);
    // device_source_instances.connector_instance_id is NULL — the pre-contract
    // shape that forces the migration to derive identity from the legacy rows.
    db.prepare(
      `INSERT INTO device_source_instances(source_instance_id, device_id, connector_id, connector_instance_id, local_binding_id, display_name, status, created_at, updated_at)
       VALUES(?, ?, ?, NULL, ?, ?, 'active', ?, ?)`
    ).run(sourceInstanceId, "dev_ambiguous", "claude_code", "laptop-a", "Legacy Claude Code", now, now);
    // Two legacy state rows under the same local-device namespace but DIFFERENT
    // connector_instance_ids: the migration cannot pick one without losing data.
    db.prepare(
      `INSERT INTO connector_state(connector_id, connector_instance_id, stream, state_json, updated_at)
       VALUES(?, ?, 'messages', ?, ?)`
    ).run(oldConnectorId, "cin_legacy_one", JSON.stringify({ cursor: "one" }), now);
    db.prepare(
      `INSERT INTO connector_state(connector_id, connector_instance_id, stream, state_json, updated_at)
       VALUES(?, ?, 'sessions', ?, ?)`
    ).run(oldConnectorId, "cin_legacy_two", JSON.stringify({ cursor: "two" }), now);
    closeDb();

    assert.throws(
      () => initDb(dbPath),
      (err) =>
        err instanceof Error &&
        LEGACY_SOURCE_PATTERN.test(err.message) &&
        MULTIPLE_INSTANCE_PATTERN.test(err.message) &&
        err.message.includes("cin_legacy_one") &&
        err.message.includes("cin_legacy_two"),
      "startup migration must refuse an ambiguous legacy local-device namespace rather than silently merge it"
    );
  } finally {
    closeDb();
    await rm(dir, { force: true, recursive: true });
  }
});

test("Owner-token bearer is rejected by the device state routes", async () => {
  await withServer(async ({ asUrl }) => {
    const device = await enrollDevice(asUrl, "laptop-a");
    getDb()
      .prepare(
        `INSERT INTO tokens(token_id, grant_id, subject_id, client_id, token_kind, expires_at)
       VALUES(?, NULL, ?, NULL, 'owner', ?)`
      )
      .run("owner-token-for-state-route-test", "owner_ref", "2999-01-01T00:00:00.000Z");

    const getResp = await getJson(
      stateUrl(asUrl, device.device_id, device.source_instance_id),
      authHeaders("owner-token-for-state-route-test")
    );
    assert.equal(getResp.status, 403);
    assert.equal(errorCode(getResp), "permission_error");

    const putResp = await putJson(
      stateUrl(asUrl, device.device_id, device.source_instance_id),
      { state: { messages: { cursor: "c" } } },
      authHeaders("owner-token-for-state-route-test")
    );
    assert.equal(putResp.status, 403);
    assert.equal(errorCode(putResp), "permission_error");
  });
});

test("Device credential cannot read state for a different device", async () => {
  await withServer(async ({ asUrl }) => {
    const first = await enrollDevice(asUrl, "laptop-a");
    const second = await enrollDevice(asUrl, "laptop-b");

    const crossRead = await getJson(
      stateUrl(asUrl, second.device_id, second.source_instance_id),
      authHeaders(first.device_token)
    );
    assert.equal(crossRead.status, 403);
    assert.equal(errorCode(crossRead), "permission_error");

    const crossWrite = await putJson(
      stateUrl(asUrl, second.device_id, second.source_instance_id),
      { state: { messages: { cursor: "c" } } },
      authHeaders(first.device_token)
    );
    assert.equal(crossWrite.status, 403);
    assert.equal(errorCode(crossWrite), "permission_error");
  });
});

test("Unknown source_instance_id is rejected with not_found", async () => {
  await withServer(async ({ asUrl }) => {
    const device = await enrollDevice(asUrl, "laptop-a");
    const getResp = await getJson(
      stateUrl(asUrl, device.device_id, "nonexistent-source-id"),
      authHeaders(device.device_token)
    );
    assert.equal(getResp.status, 404);
    assert.equal(errorCode(getResp), "not_found");

    const putResp = await putJson(
      stateUrl(asUrl, device.device_id, "nonexistent-source-id"),
      { state: { messages: { cursor: "c" } } },
      authHeaders(device.device_token)
    );
    assert.equal(putResp.status, 404);
    assert.equal(errorCode(putResp), "not_found");
  });
});

test("PUT then GET round-trips per-stream cursors with last-write-wins merge semantics", async () => {
  await withServer(async ({ asUrl }) => {
    const device = await enrollDevice(asUrl, "laptop-a");

    // First read: empty state, no rows.
    const initial = await getJson(
      stateUrl(asUrl, device.device_id, device.source_instance_id),
      authHeaders(device.device_token)
    );
    assert.equal(initial.status, 200);
    assert.equal(bodyOf(initial).object, "device_source_instance_state");
    assert.equal(bodyOf(initial).device_id, device.device_id);
    assert.equal(bodyOf(initial).connector_instance_id, device.connector_instance_id);
    assert.equal(bodyOf(initial).source_instance_id, device.source_instance_id);
    assert.deepEqual(bodyOf(initial).state, {});
    assert.equal(bodyOf(initial).updated_at, null);

    // First write: messages cursor only.
    const firstPut = await putJson(
      stateUrl(asUrl, device.device_id, device.source_instance_id),
      { state: { messages: { cursor: "m-1" } } },
      authHeaders(device.device_token)
    );
    assert.equal(firstPut.status, 200);
    assert.deepEqual(bodyOf(firstPut).state, { messages: { cursor: "m-1" } });

    // Second write: adds attachments and bumps messages — last-write-wins per stream.
    const secondPut = await putJson(
      stateUrl(asUrl, device.device_id, device.source_instance_id),
      { state: { attachments: { uid_low: 100 }, messages: { cursor: "m-2" } } },
      authHeaders(device.device_token)
    );
    assert.equal(secondPut.status, 200);
    assert.deepEqual(bodyOf(secondPut).state, {
      attachments: { uid_low: 100 },
      messages: { cursor: "m-2" },
    });
    assert.ok(bodyOf(secondPut).updated_at);

    // Final read confirms merged state survives.
    const finalRead = await getJson(
      stateUrl(asUrl, device.device_id, device.source_instance_id),
      authHeaders(device.device_token)
    );
    assert.equal(finalRead.status, 200);
    assert.deepEqual(bodyOf(finalRead).state, {
      attachments: { uid_low: 100 },
      messages: { cursor: "m-2" },
    });
  });
});

test("PUT device state is safe to replay for at-least-once local delivery", async () => {
  await withServer(async ({ asUrl }) => {
    const device = await enrollDevice(asUrl, "laptop-state-replay");
    const url = stateUrl(asUrl, device.device_id, device.source_instance_id);
    const body = { state: { messages: { cursor: "m-replay" } } };

    const firstPut = await putJson(url, body, authHeaders(device.device_token));
    assert.equal(firstPut.status, 200, JSON.stringify(firstPut.body));

    const replayPut = await putJson(url, body, authHeaders(device.device_token));
    assert.equal(replayPut.status, 200, JSON.stringify(replayPut.body));
    assert.deepEqual(bodyOf(replayPut).state, bodyOf(firstPut).state);

    const readBack = await getJson(url, authHeaders(device.device_token));
    assert.equal(readBack.status, 200);
    assert.deepEqual(bodyOf(readBack).state, body.state);

    const storageConnectorId = localDeviceConnectorId(device.connector_id);
    const rows = getDb()
      .prepare(
        `SELECT state_json FROM connector_state
        WHERE connector_id = ?
          AND connector_instance_id = ?
          AND stream = ?`
      )
      .all<{ state_json: string }>(storageConnectorId, device.connector_instance_id, "messages");
    assert.equal(rows.length, 1);
    const [stateRow] = rows;
    assert.ok(stateRow, "state row must exist");
    assert.deepEqual(JSON.parse(stateRow.state_json), { cursor: "m-replay" });
  });
});

test("Two-device isolation: same connector id, different source instances, separate state rows", async () => {
  await withServer(async ({ asUrl }) => {
    const first = await enrollDevice(asUrl, "laptop-a");
    const second = await enrollDevice(asUrl, "laptop-b");
    assert.notEqual(first.source_instance_id, second.source_instance_id);
    assert.equal(first.connector_id, "codex");
    assert.equal(second.connector_id, "codex");

    await putJson(
      stateUrl(asUrl, first.device_id, first.source_instance_id),
      { state: { messages: { cursor: "first-cursor" } } },
      authHeaders(first.device_token)
    );
    await putJson(
      stateUrl(asUrl, second.device_id, second.source_instance_id),
      { state: { messages: { cursor: "second-cursor" } } },
      authHeaders(second.device_token)
    );

    const firstRead = await getJson(
      stateUrl(asUrl, first.device_id, first.source_instance_id),
      authHeaders(first.device_token)
    );
    const secondRead = await getJson(
      stateUrl(asUrl, second.device_id, second.source_instance_id),
      authHeaders(second.device_token)
    );

    assert.deepEqual(bodyOf(firstRead).state, { messages: { cursor: "first-cursor" } });
    assert.deepEqual(bodyOf(secondRead).state, { messages: { cursor: "second-cursor" } });

    // Underlying state rows are stored under the bare canonical connector key
    // ('codex'), the same key API-collected records use. Isolation between the
    // two device connections — and from any owner-auth account connection for
    // the same connector type — is carried entirely by connector_instance_id,
    // not by a 'local-device:' storage prefix. See canonicalize-connector-keys
    // design Decision 7.
    const db = getDb();
    const storageConnectorId = localDeviceConnectorId("codex");

    // No legacy-prefixed rows should exist on the live write path.
    const prefixedRows = mustExist(
      db
        .prepare(`SELECT COUNT(*) AS n FROM connector_state WHERE connector_id LIKE 'local-device:%'`)
        .get<{ n: number }>(),
      "prefixed row count must exist"
    );
    assert.equal(prefixedRows.n, 0, "live local-device state MUST NOT use a local-device: prefix");

    const firstRow = mustExist(
      db
        .prepare(
          "SELECT state_json FROM connector_state WHERE connector_id = ? AND connector_instance_id = ? AND stream = ?"
        )
        .get<{ state_json: string }>(storageConnectorId, first.connector_instance_id, "messages"),
      "first device state row must exist"
    );
    const secondRow = mustExist(
      db
        .prepare(
          "SELECT state_json FROM connector_state WHERE connector_id = ? AND connector_instance_id = ? AND stream = ?"
        )
        .get<{ state_json: string }>(storageConnectorId, second.connector_instance_id, "messages"),
      "second device state row must exist"
    );
    assert.equal(JSON.parse(firstRow.state_json).cursor, "first-cursor");
    assert.equal(JSON.parse(secondRow.state_json).cursor, "second-cursor");
    // The two device connections never collide: distinct connector_instance_id.
    assert.notEqual(first.connector_instance_id, second.connector_instance_id);
  });
});

test("Single device with two source instances keeps state rows independent", async () => {
  await withServer(async ({ asUrl }) => {
    // Two enrollment codes against the same connector with two binding names
    // produces two source instances. The current enrollment flow ties one
    // device to one source instance, so we set up two devices that happen
    // to share the same connector_id but have distinct source_instance_ids.
    // This is the supported isolation invariant (see device ingest test).
    const a = await enrollDevice(asUrl, "binding-a");
    const b = await enrollDevice(asUrl, "binding-b");

    await putJson(
      stateUrl(asUrl, a.device_id, a.source_instance_id),
      { state: { sessions: { hwm: 1 } } },
      authHeaders(a.device_token)
    );
    await putJson(
      stateUrl(asUrl, b.device_id, b.source_instance_id),
      { state: { sessions: { hwm: 2 } } },
      authHeaders(b.device_token)
    );

    const readA = await getJson(stateUrl(asUrl, a.device_id, a.source_instance_id), authHeaders(a.device_token));
    const readB = await getJson(stateUrl(asUrl, b.device_id, b.source_instance_id), authHeaders(b.device_token));
    assert.deepEqual(bodyOf(readA).state, { sessions: { hwm: 1 } });
    assert.deepEqual(bodyOf(readB).state, { sessions: { hwm: 2 } });
  });
});

test("Owner-auth /v1/state/:connectorId does not surface device-scoped rows", async () => {
  await withServer(async ({ asUrl }) => {
    const device = await enrollDevice(asUrl, "laptop-a");
    await putJson(
      stateUrl(asUrl, device.device_id, device.source_instance_id),
      { state: { messages: { cursor: "device-only" } } },
      authHeaders(device.device_token)
    );

    // Mint an owner token for the same connector id and call /v1/state.
    getDb()
      .prepare(
        `INSERT INTO tokens(token_id, grant_id, subject_id, client_id, token_kind, expires_at)
       VALUES(?, NULL, ?, NULL, 'owner', ?)`
      )
      .run("owner-token-state-isolation", "owner_ref", "2999-01-01T00:00:00.000Z");

    const ownerState = await getJson(
      `${asUrl}/v1/state/${encodeURIComponent(device.connector_id)}`,
      authHeaders("owner-token-state-isolation")
    );
    // Owner-auth state for the public connector id sees no device rows.
    // Whatever the response shape, the device-only cursor must not appear.
    if (ownerState.status === 200) {
      assert.deepEqual(ownerState.body?.state ?? {}, {});
    } else {
      // Some configurations return a 4xx for the bare path without a
      // manifest-registered connector; either way the device row must
      // not have leaked.
      assert.notEqual(ownerState.status, 200);
    }

    // Conversely the device-scoped state route does not accept this owner token.
    const deviceWithOwnerToken = await getJson(
      stateUrl(asUrl, device.device_id, device.source_instance_id),
      authHeaders("owner-token-state-isolation")
    );
    assert.equal(deviceWithOwnerToken.status, 403);
  });
});

test("Revoked device cannot read or write state", async () => {
  await withServer(async ({ asUrl }) => {
    const device = await enrollDevice(asUrl, "laptop-a");
    await postJson(`${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/revoke`, {});
    const getResp = await getJson(
      stateUrl(asUrl, device.device_id, device.source_instance_id),
      authHeaders(device.device_token)
    );
    assert.equal(getResp.status, 401);
    const putResp = await putJson(
      stateUrl(asUrl, device.device_id, device.source_instance_id),
      { state: { messages: { cursor: "c" } } },
      authHeaders(device.device_token)
    );
    assert.equal(putResp.status, 401);
  });
});
