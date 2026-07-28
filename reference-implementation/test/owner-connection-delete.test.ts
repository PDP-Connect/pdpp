const TOP_LEVEL_REGEX_1 = /Bearer\s/i;
const TOP_LEVEL_REGEX_2 = /owner-agent/i;

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration suite for the bearer-authed owner-agent connection-DELETE control
 * routes (mounted from `server/routes/owner-connection-delete.ts`):
 *
 *   DELETE /v1/owner/connections/:connectionId
 *   DELETE /v1/owner/connectors/:connectorId
 *
 * This is the implementation lane for `add-owner-connection-delete-contract`. It
 * proves the destructive cascade against each invariant the contract specifies:
 *
 *   - cascade completeness: a connection's records, record_changes, version
 *     counters, blobs, blob bindings, lexical search index, attention records,
 *     and schedule are all erased, the connector_instances row is gone, and a
 *     device source-instance back-ref is cleared (set null) while the device row
 *     itself survives (the controller_active_runs lease is never erased — an
 *     in-flight run is refused, not deleted);
 *   - no-sibling-overreach (I1): a sibling connection of the same connector type
 *     and a sibling connection on the same device keep their row + records +
 *     collectability;
 *   - records unreadable after delete (revoke != delete contrast): the deleted
 *     connection's records are physically gone, not merely status-flipped;
 *   - audit preserved (I3): prior spine events survive and a non-secret
 *     owner_agent.connection.delete event is appended with the deletion summary;
 *   - idempotency (I4): first delete 200, second 404 connector_instance_not_found;
 *   - foreign / unknown (I5): foreign-owner and unknown ids → 404, no
 *     cross-owner deletion, no existence leak;
 *   - default-account no-resurrection (I6 / Decision 1 fallback): a
 *     default-account connection is refused with default_account_delete_unsupported
 *     so its deterministic id cannot silently re-materialize;
 *   - active-run refusal (I7): delete under an active-run lease → 409
 *     connection_run_active, no rows erased;
 *   - grants untouched (I10): a disclosure grant for the connector type is
 *     unchanged after delete;
 *   - auth: missing bearer 401, client grant 403 (audited), revoked owner-agent
 *     credential 401, owner bearer on /mcp 403 (re-pin);
 *   - connector-only ambiguity / auto-select;
 *   - the control surface advertises delete_connection as supported with the
 *     DELETE URL.
 *
 * Spec: openspec/changes/add-owner-connection-delete-contract
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { exec, referenceQueries } from "../lib/db.ts";
import { listSpineEventsPage, type SpineEventRecord } from "../lib/spine.ts";
import { canonicalConnectorKey } from "../server/connector-key.ts";
import { getDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { ingestRecord } from "../server/records.ts";
import {
  createSqliteConnectorInstanceStore,
  makeDefaultAccountConnectorInstanceId,
} from "../server/stores/connector-instance-store.ts";
import { createSqliteSchedulerStore } from "../server/stores/scheduler-store.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, "..");
const OWNER_SUBJECT_ID = "owner_local";
const OTHER_SUBJECT_ID = "owner_other";
const OWNER_CLIENT_ID = "cli_longview";
const NOW = "2026-05-31T00:00:00.000Z";

function mustRow<T extends Record<string, unknown>>(value: T | undefined, description: string): T {
  assert.ok(value, description);
  return value;
}

interface CloseableServer {
  close: (callback?: (err?: Error) => void) => unknown;
  closeAllConnections: () => void;
}

type StartedServer = Awaited<ReturnType<typeof startServer>> & {
  asServer: CloseableServer;
  rsServer: CloseableServer;
  schedulerManager?: { stop?: () => void };
};

async function closeServer(server: StartedServer): Promise<void> {
  server.schedulerManager?.stop?.();
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise((resolve) => server.asServer.close(resolve)),
    new Promise((resolve) => server.rsServer.close(resolve)),
  ]);
}

interface JsonResult {
  body: unknown;
  resp: Response;
  status: number;
}

async function fetchJson(url: string | URL, opts: RequestInit = {}): Promise<JsonResult> {
  const resp = await fetch(url, opts);
  const text = await resp.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { body, resp, status: resp.status };
}

async function withServer(
  fn: (ctx: { asUrl: string; rsUrl: string; server: StartedServer }) => Promise<void>
): Promise<void> {
  const server = (await startServer({
    asPort: 0,
    dbPath: ":memory:",
    ownerAuthPassword: "",
    quiet: true,
    rsPort: 0,
  })) as StartedServer;
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  try {
    await fn({ asUrl, rsUrl, server });
  } finally {
    await closeServer(server);
  }
}

async function issueOwnerToken(asUrl: string, subjectId = OWNER_SUBJECT_ID): Promise<string> {
  const device = (
    await fetchJson(`${asUrl}/oauth/device_authorization`, {
      body: new URLSearchParams({ client_id: OWNER_CLIENT_ID }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    })
  ).body as { user_code: string; device_code: string };
  await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({ subject_id: subjectId, user_code: device.user_code }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const tok = (
    await fetchJson(`${asUrl}/oauth/token`, {
      body: new URLSearchParams({
        client_id: OWNER_CLIENT_ID,
        device_code: device.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    })
  ).body as { access_token?: string };
  assert.ok(tok.access_token, "device exchange should issue an owner token");
  return tok.access_token;
}

async function approveClientGrant(asUrl: string, connectorId: string, streamName: string): Promise<string> {
  const par = (
    await fetchJson(`${asUrl}/oauth/par`, {
      body: JSON.stringify({
        authorization_details: [
          {
            access_mode: "continuous",
            purpose_code: "https://pdpp.org/purpose/analytics",
            purpose_description: "owner-connection delete boundary test",
            source: { id: connectorId, kind: "connector" },
            streams: [{ fields: ["id"], name: streamName }],
            type: "https://pdpp.org/data-access",
          },
        ],
        client_id: "longview",
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    })
  ).body as { request_uri?: string };
  const approved = (
    await fetchJson(`${asUrl}/consent/approve`, {
      body: JSON.stringify({ request_uri: par.request_uri, subject_id: OWNER_SUBJECT_ID }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    })
  ).body as { token?: string };
  assert.ok(approved.token, "consent approval should issue a client grant token");
  return approved.token;
}

interface ReferenceManifest {
  connector_id: string;
  display_name?: string;
  streams: { name: string; [key: string]: unknown }[];
  [key: string]: unknown;
}

function loadReferenceManifest(name: string): ReferenceManifest {
  return JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, "manifests", `${name}.json`), "utf8")) as ReferenceManifest;
}

async function registerConnector(asUrl: string, manifest: ReferenceManifest): Promise<ReferenceManifest> {
  const resp = await fetch(`${asUrl}/connectors`, {
    body: JSON.stringify(manifest),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(resp.status, 201, `register ${manifest.connector_id} failed: ${resp.status}`);
  return manifest;
}

interface SeedInstanceOptions {
  connectorId: string;
  connectorInstanceId: string;
  displayName: string;
  ownerSubjectId?: string;
  sourceBinding?: Record<string, unknown>;
  sourceBindingKey: string;
  sourceKind?: string;
}

async function seedInstance({
  connectorInstanceId,
  connectorId,
  displayName,
  sourceBindingKey,
  sourceKind = "account",
  sourceBinding,
  ownerSubjectId = OWNER_SUBJECT_ID,
}: SeedInstanceOptions): Promise<void> {
  const store = createSqliteConnectorInstanceStore();
  await store.upsert({
    connectorId,
    connectorInstanceId,
    createdAt: NOW,
    displayName,
    ownerSubjectId,
    sourceBinding: sourceBinding ?? { account_hint: sourceBindingKey },
    sourceBindingKey,
    sourceKind,
    status: "active",
    updatedAt: NOW,
  });
}

interface ConnectorInstanceRow {
  connector_instance_id: string;
  status: string;
  [key: string]: unknown;
}

function getInstance(connectorInstanceId: string): ConnectorInstanceRow | null {
  return createSqliteConnectorInstanceStore().get(connectorInstanceId) as ConnectorInstanceRow | null;
}

// ─── Direct table reads/writes for cascade assertions ──────────────────────
// A connection-delete erases rows the high-level ingest path does not let us
// observe through projections; counting them directly is the honest proof.

function countRows(table: string, connectorInstanceId: string): number {
  return (
    getDb().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE connector_instance_id = ?`).get(connectorInstanceId) as {
      n: number;
    }
  ).n;
}

function countLexical(connectorInstanceId: string): number {
  return (
    getDb()
      .prepare("SELECT COUNT(*) AS n FROM lexical_search_index WHERE connector_instance_id = ?")
      .get(connectorInstanceId) as { n: number }
  ).n;
}

interface SeedLexicalOptions {
  connectorId: string;
  connectorInstanceId: string;
  recordKey: string;
  stream: string;
}

// Seed a lexical search-index row for a connection directly. The ingest path
// only indexes fields a registered search config declares searchable (a
// separate backfill step), so seeding the row directly gives the cascade a
// deterministic lexical row to prove it tears down — matching the FTS columns.
function seedLexical({ connectorId, connectorInstanceId, stream, recordKey }: SeedLexicalOptions): void {
  getDb()
    .prepare(
      `INSERT INTO lexical_search_index(connector_id, connector_instance_id, stream, record_key, field, text)
       VALUES(?, ?, ?, ?, 'name', 'alpha track')`
    )
    .run(connectorId, connectorInstanceId, stream, recordKey);
}

interface SeedBlobOptions extends SeedLexicalOptions {
  blobId: string;
}

// Seed a blob + binding for a connection so the cascade has blob rows to erase.
function seedBlob({ connectorId, connectorInstanceId, stream, recordKey, blobId }: SeedBlobOptions): void {
  getDb()
    .prepare(
      `INSERT INTO blobs(blob_id, connector_id, connector_instance_id, stream, record_key, mime_type, size_bytes, sha256, data)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(blobId, connectorId, connectorInstanceId, stream, recordKey, "text/plain", 3, "deadbeef", Buffer.from("abc"));
  getDb()
    .prepare(
      `INSERT INTO blob_bindings(blob_id, connector_id, connector_instance_id, stream, record_key, json_path)
       VALUES(?, ?, ?, ?, ?, '@record')`
    )
    .run(blobId, connectorId, connectorInstanceId, stream, recordKey);
}

interface SeedAttentionOptions {
  attentionId: string;
  connectorId: string;
  connectorInstanceId: string;
}

// Seed an open attention record for a connection.
function seedAttention({ connectorId, connectorInstanceId, attentionId }: SeedAttentionOptions): void {
  getDb()
    .prepare(
      `INSERT INTO connector_attention_records(
        attention_id, dedupe_key, connector_id, connector_instance_id, connection_id,
        run_id, reason_code, lifecycle, sensitivity, expires_at, record_json, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, NULL, 'auth_expired', 'open', 'non_secret', NULL, '{}', ?, ?)`
    )
    .run(attentionId, attentionId, connectorId, connectorInstanceId, connectorInstanceId, NOW, NOW);
}

interface SeedDeviceSourceInstanceOptions {
  connectorId: string;
  connectorInstanceId: string;
  deviceId: string;
  localBindingId: string;
  sourceInstanceId: string;
}

// Seed a device + source-instance back-reference at one connection.
function seedDeviceSourceInstance({
  deviceId,
  connectorId,
  connectorInstanceId,
  sourceInstanceId,
  localBindingId,
}: SeedDeviceSourceInstanceOptions): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO device_exporters(device_id, owner_subject_id, display_name, status, created_at, updated_at)
       VALUES(?, ?, ?, 'active', ?, ?)`
    )
    .run(deviceId, OWNER_SUBJECT_ID, deviceId, NOW, NOW);
  getDb()
    .prepare(
      `INSERT INTO device_source_instances(
        source_instance_id, device_id, connector_id, connector_instance_id, local_binding_id,
        display_name, status, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, 'active', ?, ?)`
    )
    .run(sourceInstanceId, deviceId, connectorId, connectorInstanceId, localBindingId, sourceInstanceId, NOW, NOW);
}

interface DeviceSourceInstanceRow {
  connector_instance_id: string | null;
  source_instance_id: string;
  [key: string]: unknown;
}

function getSourceInstance(sourceInstanceId: string): DeviceSourceInstanceRow | undefined {
  return getDb().prepare("SELECT * FROM device_source_instances WHERE source_instance_id = ?").get(sourceInstanceId) as
    | DeviceSourceInstanceRow
    | undefined;
}

function seedSchedule(connectorInstanceId: string, connectorId: string): void {
  createSqliteSchedulerStore().createSchedule({
    connector_id: connectorId,
    connector_instance_id: connectorInstanceId,
    created_at: NOW,
    enabled: true,
    interval_seconds: 3600,
    jitter_seconds: 0,
    updated_at: NOW,
  });
}

function seedActiveRun(connectorInstanceId: string, connectorId: string): void {
  createSqliteSchedulerStore().upsertActiveRun({
    connector_id: connectorId,
    connector_instance_id: connectorInstanceId,
    run_generation: 1,
    run_id: `run_${connectorInstanceId}`,
    scenario_id: "default",
    started_at: NOW,
    trace_id: "trc_test",
  });
}

function scheduleRowCount(connectorInstanceId: string): number {
  return (
    getDb()
      .prepare("SELECT COUNT(*) AS n FROM connector_schedules WHERE connector_instance_id = ?")
      .get(connectorInstanceId) as { n: number }
  ).n;
}

function activeRunRowCount(connectorInstanceId: string): number {
  return (
    getDb()
      .prepare("SELECT COUNT(*) AS n FROM controller_active_runs WHERE connector_instance_id = ?")
      .get(connectorInstanceId) as { n: number }
  ).n;
}

// biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
async function deleteConnection(rsUrl: string, ownerToken: string, path: string): Promise<JsonResult> {
  return fetchJson(`${rsUrl}${path}`, {
    headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
    method: "DELETE",
  });
}

interface DeleteResponseBody {
  actions?: { family?: string; status?: string; method?: string | null; url?: string | null }[];
  connection_id?: string;
  deleted?: boolean;
  deleted_record_count?: number;
  deleted_stream_count?: number;
  device_refs_cleared?: number;
  error?: { code?: string; type?: string; message?: string; retry_with?: string };
  object?: string;
  schedule_deleted?: boolean;
  [key: string]: unknown;
}

function deleteBody(result: JsonResult): DeleteResponseBody {
  return result.body as DeleteResponseBody;
}

interface AuditDeleteData {
  deletion_summary?: { deleted_record_count?: number; schedule_deleted?: boolean };
  error?: { code?: string; http_status?: number };
  operation?: string;
  selector?: string;
}

function auditData(event: SpineEventRecord): AuditDeleteData {
  return (event.data ?? {}) as AuditDeleteData;
}

function findDeleteAuditEvent(resp: Response): SpineEventRecord {
  const traceId = resp.headers.get("PDPP-Reference-Trace-Id");
  assert.ok(traceId?.startsWith("trc_"), "delete response should carry an audit trace id");
  assert.ok(traceId, "expected a trace id");
  const page = listSpineEventsPage("trace", traceId, { limit: 20 });
  const event = page.events.find((entry) => entry.event_type === "owner_agent.connection.delete");
  assert.ok(event, "expected owner-agent delete audit event");
  assert.equal(event.request_id, resp.headers.get("Request-Id"));
  assert.equal(event.token_id, null, "audit event must not store bearer tokens");
  const serialized = JSON.stringify(event);
  assert.ok(!TOP_LEVEL_REGEX_1.test(serialized), "audit must not carry a bearer token");
  assert.ok(!serialized.includes("access_token"), "audit must not carry an access token");
  return event;
}

test("owner-agent delete erases a connection completely: records, history, blobs, search, attention, schedule, row", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorKey, "expected a canonical connector key");
    // biome-ignore lint/style/useDestructuring: index access documents the asserted ordered position
    const firstStream = manifest.streams[0];
    assert.ok(firstStream, "expected the manifest to declare at least one stream");
    const stream = firstStream.name;
    const cin = "cin_spotify_personal";
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: cin,
      displayName: "My Spotify",
      sourceBindingKey: "the owner@example.com",
    });

    const storageTarget = { connector_id: connectorKey, connector_instance_id: cin };
    await ingestRecord(storageTarget, { data: { id: "rec_1", name: "alpha track" }, key: "rec_1", stream });
    await ingestRecord(storageTarget, { data: { id: "rec_2", name: "beta track" }, key: "rec_2", stream });
    seedBlob({ blobId: "blob_1", connectorId: connectorKey, connectorInstanceId: cin, recordKey: "rec_1", stream });
    seedAttention({ attentionId: "att_1", connectorId: connectorKey, connectorInstanceId: cin });
    seedLexical({ connectorId: connectorKey, connectorInstanceId: cin, recordKey: "rec_1", stream });
    seedSchedule(cin, connectorKey);

    // Pre-delete: every cascade table has rows for this connection.
    assert.equal(countRows("records", cin), 2, "records before");
    assert.ok(countRows("record_changes", cin) >= 2, "record_changes before");
    assert.equal(countRows("version_counter", cin), 1, "version_counter before");
    assert.equal(countRows("blobs", cin), 1, "blobs before");
    assert.equal(countRows("blob_bindings", cin), 1, "blob_bindings before");
    assert.equal(countRows("connector_attention_records", cin), 1, "attention before");
    assert.ok(countLexical(cin) >= 1, "lexical index before");
    assert.equal(scheduleRowCount(cin), 1, "schedule before");

    const ownerToken = await issueOwnerToken(asUrl);
    const del = await deleteConnection(rsUrl, ownerToken, `/v1/owner/connections/${cin}`);
    assert.equal(del.status, 200);
    const delBody = deleteBody(del);
    assert.equal(delBody.object, "owner_connection_delete");
    assert.equal(delBody.connection_id, cin);
    assert.equal(delBody.deleted, true);
    assert.equal(delBody.deleted_record_count, 2);
    assert.equal(delBody.deleted_stream_count, 1);
    assert.equal(delBody.schedule_deleted, true);

    // Post-delete: every cascade table is empty for this connection, and the
    // connector_instances row is gone.
    assert.equal(countRows("records", cin), 0, "records erased");
    assert.equal(countRows("record_changes", cin), 0, "record_changes erased");
    assert.equal(countRows("version_counter", cin), 0, "version_counter erased");
    assert.equal(countRows("blobs", cin), 0, "blobs erased");
    assert.equal(countRows("blob_bindings", cin), 0, "blob_bindings erased");
    assert.equal(countRows("connector_attention_records", cin), 0, "attention erased");
    assert.equal(countLexical(cin), 0, "lexical index erased");
    assert.equal(scheduleRowCount(cin), 0, "schedule erased");
    assert.equal(getInstance(cin), null, "connector_instances row gone");

    const audit = findDeleteAuditEvent(del.resp);
    assert.equal(audit.actor_type, "owner_agent");
    assert.equal(audit.object_id, cin);
    assert.equal(audit.status, "succeeded");
    const auditDataValue = auditData(audit);
    assert.equal(auditDataValue.operation, "delete");
    assert.equal(auditDataValue.selector, "connection_id");
    assert.equal(auditDataValue.deletion_summary?.deleted_record_count, 2);
    assert.equal(auditDataValue.deletion_summary?.schedule_deleted, true);
  });
});

test("owner-agent delete does not over-reach: a sibling connection of the same connector stays intact (I1)", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorKey, "expected a canonical connector key");
    // biome-ignore lint/style/useDestructuring: index access documents the asserted ordered position
    const firstStream = manifest.streams[0];
    assert.ok(firstStream, "expected the manifest to declare at least one stream");
    const stream = firstStream.name;
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_a",
      displayName: "A",
      sourceBindingKey: "a@example.com",
    });
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_b",
      displayName: "B",
      sourceBindingKey: "b@example.com",
    });
    await ingestRecord(
      { connector_id: connectorKey, connector_instance_id: "cin_a" },
      { data: { id: "a1" }, key: "a1", stream }
    );
    await ingestRecord(
      { connector_id: connectorKey, connector_instance_id: "cin_b" },
      { data: { id: "b1" }, key: "b1", stream }
    );

    const ownerToken = await issueOwnerToken(asUrl);
    const del = await deleteConnection(rsUrl, ownerToken, "/v1/owner/connections/cin_a");
    assert.equal(del.status, 200);

    // cin_a gone; cin_b fully intact and still collectable.
    assert.equal(getInstance("cin_a"), null);
    assert.equal(countRows("records", "cin_a"), 0);
    const sibling = getInstance("cin_b");
    assert.ok(sibling, "expected the sibling connection to still exist");
    assert.equal(sibling.status, "active", "sibling row intact");
    assert.equal(countRows("records", "cin_b"), 1, "sibling records intact");
    await ingestRecord(
      { connector_id: connectorKey, connector_instance_id: "cin_b" },
      { data: { id: "b2" }, key: "b2", stream }
    );
    assert.equal(countRows("records", "cin_b"), 2, "sibling still collectable");
  });
});

test("owner-agent delete clears the device back-reference but preserves the device edge and sibling on the same device", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorKey, "expected a canonical connector key");
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_dev_a",
      displayName: "Dev A",
      sourceBindingKey: "da",
      sourceKind: "local_device",
    });
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_dev_b",
      displayName: "Dev B",
      sourceBindingKey: "db",
      sourceKind: "local_device",
    });
    seedDeviceSourceInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_dev_a",
      deviceId: "dev_1",
      localBindingId: "lb_a",
      sourceInstanceId: "dsi_a",
    });
    seedDeviceSourceInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_dev_b",
      deviceId: "dev_1",
      localBindingId: "lb_b",
      sourceInstanceId: "dsi_b",
    });

    const ownerToken = await issueOwnerToken(asUrl);
    const del = await deleteConnection(rsUrl, ownerToken, "/v1/owner/connections/cin_dev_a");
    assert.equal(del.status, 200);
    assert.equal(deleteBody(del).device_refs_cleared, 1, "one device back-ref cleared");

    // dsi_a's back-reference is cleared (null) but the device-edge row survives.
    const dsiA = getSourceInstance("dsi_a");
    assert.ok(dsiA, "device source-instance row survives delete");
    assert.equal(dsiA.connector_instance_id, null, "back-reference cleared to null");
    // The sibling on the same device is fully untouched.
    const dsiB = getSourceInstance("dsi_b");
    assert.ok(dsiB, "sibling device source-instance row survives delete");
    assert.equal(dsiB.connector_instance_id, "cin_dev_b", "sibling back-ref untouched");
    assert.equal(getInstance("cin_dev_b")?.status, "active", "sibling connection intact");
    // The device exporter row itself is not deleted/revoked.
    const device = getDb().prepare("SELECT status FROM device_exporters WHERE device_id = ?").get("dev_1") as
      | { status: string }
      | undefined;
    assert.equal(device?.status, "active", "device enrollment not revoked by connection delete");
  });
});

test("owner-agent delete refuses while an active run lease exists (I7) and erases nothing", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorKey, "expected a canonical connector key");
    // biome-ignore lint/style/useDestructuring: index access documents the asserted ordered position
    const firstStream = manifest.streams[0];
    assert.ok(firstStream, "expected the manifest to declare at least one stream");
    const stream = firstStream.name;
    const cin = "cin_running";
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: cin,
      displayName: "Running",
      sourceBindingKey: "r@example.com",
    });
    await ingestRecord(
      { connector_id: connectorKey, connector_instance_id: cin },
      { data: { id: "r1" }, key: "r1", stream }
    );
    seedActiveRun(cin, connectorKey);

    const ownerToken = await issueOwnerToken(asUrl);
    const del = await deleteConnection(rsUrl, ownerToken, `/v1/owner/connections/${cin}`);
    assert.equal(del.status, 409);
    assert.equal(deleteBody(del).error?.code, "connection_run_active");

    // Nothing erased: row, records, and the active-run lease all survive.
    assert.equal(getInstance(cin)?.status, "active", "row survives refused delete");
    assert.equal(countRows("records", cin), 1, "records survive refused delete");
    assert.equal(activeRunRowCount(cin), 1, "active-run lease untouched");

    const audit = findDeleteAuditEvent(del.resp);
    assert.equal(audit.status, "failed");
    assert.equal(auditData(audit).error?.code, "connection_run_active");
    assert.equal(auditData(audit).error?.http_status, 409);
  });
});

test("owner-agent delete refuses a default-account connection (I6) so its deterministic id cannot re-materialize", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest("github"));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorKey, "expected a canonical connector key");
    const store = createSqliteConnectorInstanceStore();
    const defaultId = makeDefaultAccountConnectorInstanceId(OWNER_SUBJECT_ID, connectorKey);
    await store.ensureDefaultAccountConnection({
      connectorId: connectorKey,
      displayName: manifest.display_name || connectorKey,
      now: NOW,
      ownerSubjectId: OWNER_SUBJECT_ID,
    });
    assert.equal(getInstance(defaultId)?.status, "active");

    const ownerToken = await issueOwnerToken(asUrl);
    const del = await deleteConnection(rsUrl, ownerToken, `/v1/owner/connections/${defaultId}`);
    assert.equal(del.status, 409);
    assert.equal(deleteBody(del).error?.code, "default_account_delete_unsupported");

    // The default-account row is untouched (still active) — not hard-deleted and
    // therefore not subject to silent re-materialization.
    assert.equal(getInstance(defaultId)?.status, "active", "default-account row untouched");

    const audit = findDeleteAuditEvent(del.resp);
    assert.equal(audit.status, "failed");
    assert.equal(auditData(audit).error?.code, "default_account_delete_unsupported");
  });
});

test("owner-agent delete is idempotent-by-typed-error: first 200, second 404 connector_instance_not_found (I4)", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorKey, "expected a canonical connector key");
    const cin = "cin_once";
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: cin,
      displayName: "Once",
      sourceBindingKey: "o@example.com",
    });
    const ownerToken = await issueOwnerToken(asUrl);

    const first = await deleteConnection(rsUrl, ownerToken, `/v1/owner/connections/${cin}`);
    assert.equal(first.status, 200);

    const second = await deleteConnection(rsUrl, ownerToken, `/v1/owner/connections/${cin}`);
    assert.equal(second.status, 404);
    assert.equal(deleteBody(second).error?.code, "connector_instance_not_found");
  });
});

test("owner-agent delete on an unknown connection_id returns a typed 404 (I5)", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const ownerToken = await issueOwnerToken(asUrl);
    const {
      status,
      body: rawBody,
      resp,
    } = await deleteConnection(rsUrl, ownerToken, "/v1/owner/connections/cin_missing");
    const body = rawBody as DeleteResponseBody;
    assert.equal(status, 404);
    // biome-ignore lint/suspicious/noUnnecessaryConditions: assertion retains its defensive runtime boundary
    assert.equal(body?.error?.code, "connector_instance_not_found");
    const audit = findDeleteAuditEvent(resp);
    assert.equal(audit.status, "failed");
    assert.equal(audit.object_id, "cin_missing");
  });
});

test("owner-agent delete cannot cross owners (foreign connection is not found and not erased) (I5)", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorKey, "expected a canonical connector key");
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_foreign",
      displayName: "Foreign",
      ownerSubjectId: OTHER_SUBJECT_ID,
      sourceBindingKey: "f@example.com",
    });
    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body: rawBody } = await deleteConnection(rsUrl, ownerToken, "/v1/owner/connections/cin_foreign");
    const body = rawBody as DeleteResponseBody;
    assert.equal(status, 404);
    // biome-ignore lint/suspicious/noUnnecessaryConditions: assertion retains its defensive runtime boundary
    assert.equal(body?.error?.code, "connector_instance_not_found");
    // The foreign connection still exists.
    assert.equal(getInstance("cin_foreign")?.status, "active", "foreign connection not erased");
  });
});

test("owner-agent connector-only delete auto-selects the single active connection", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorKey, "expected a canonical connector key");
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_solo",
      displayName: "Solo",
      sourceBindingKey: "s@example.com",
    });
    const ownerToken = await issueOwnerToken(asUrl);
    const del = await deleteConnection(rsUrl, ownerToken, `/v1/owner/connectors/${encodeURIComponent(connectorKey)}`);
    assert.equal(del.status, 200);
    assert.equal(deleteBody(del).connection_id, "cin_solo");
    assert.equal(getInstance("cin_solo"), null);
    const audit = findDeleteAuditEvent(del.resp);
    assert.equal(auditData(audit).selector, "connector_id");
  });
});

test("owner-agent connector-only delete rejects two active connections with typed ambiguous_connection", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorKey, "expected a canonical connector key");
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_x",
      displayName: "X",
      sourceBindingKey: "x@example.com",
    });
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_y",
      displayName: "Y",
      sourceBindingKey: "y@example.com",
    });
    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body: rawBody } = await deleteConnection(
      rsUrl,
      ownerToken,
      `/v1/owner/connectors/${encodeURIComponent(connectorKey)}`
    );
    const body = rawBody as DeleteResponseBody;
    assert.equal(status, 409);
    // biome-ignore lint/suspicious/noUnnecessaryConditions: assertion retains its defensive runtime boundary
    assert.equal(body?.error?.code, "ambiguous_connection");
    // biome-ignore lint/suspicious/noUnnecessaryConditions: assertion retains its defensive runtime boundary
    assert.equal(body?.error?.retry_with, "connection_id");
    // Neither connection was deleted.
    assert.equal(getInstance("cin_x")?.status, "active");
    assert.equal(getInstance("cin_y")?.status, "active");
  });
});

test("owner-agent delete leaves disclosure grants untouched (I10)", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorKey, "expected a canonical connector key");
    // biome-ignore lint/style/useDestructuring: index access documents the asserted ordered position
    const firstStream = manifest.streams[0];
    assert.ok(firstStream, "expected the manifest to declare at least one stream");
    const stream = firstStream.name;
    // A non-default explicit account connection so delete is allowed while a
    // disclosure grant for the connector type exists.
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_grantable",
      displayName: "Grantable",
      sourceBindingKey: "g@example.com",
    });
    await approveClientGrant(asUrl, connectorKey, stream);
    // The PAR/consent flow records a row in `grants` (status + scope + members
    // live there); delete must not touch it.
    const grantsBefore = getDb().prepare("SELECT grant_id, status FROM grants WHERE status = 'active'").all() as {
      grant_id: string;
      status: string;
    }[];
    assert.ok(grantsBefore.length >= 1, "an active disclosure grant should exist");

    const ownerToken = await issueOwnerToken(asUrl);
    const del = await deleteConnection(rsUrl, ownerToken, "/v1/owner/connections/cin_grantable");
    assert.equal(del.status, 200);

    const grantsAfter = getDb().prepare("SELECT grant_id, status FROM grants WHERE status = 'active'").all() as {
      grant_id: string;
      status: string;
    }[];
    assert.deepEqual(
      // biome-ignore lint/suspicious/useArraySortCompare: fixture ordering intentionally uses lexical default sort
      grantsAfter.map((g) => g.grant_id).sort(),
      // biome-ignore lint/suspicious/useArraySortCompare: fixture ordering intentionally uses lexical default sort
      grantsBefore.map((g) => g.grant_id).sort(),
      "active disclosure grants unchanged in identity and status by connection delete"
    );
  });
});

test("owner-agent delete preserves the audit spine: prior events survive, a delete event is appended (I3)", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorKey, "expected a canonical connector key");
    // biome-ignore lint/style/useDestructuring: index access documents the asserted ordered position
    const firstStream = manifest.streams[0];
    assert.ok(firstStream, "expected the manifest to declare at least one stream");
    const stream = firstStream.name;
    const cin = "cin_audited";
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: cin,
      displayName: "Audited",
      sourceBindingKey: "au@example.com",
    });
    await ingestRecord(
      { connector_id: connectorKey, connector_instance_id: cin },
      { data: { id: "a1" }, key: "a1", stream }
    );

    const spineBefore = mustRow(
      getDb().prepare("SELECT COUNT(*) AS n FROM spine_events").get(),
      "spineBefore row exists"
    ).n;
    const ownerToken = await issueOwnerToken(asUrl);
    const del = await deleteConnection(rsUrl, ownerToken, `/v1/owner/connections/${cin}`);
    assert.equal(del.status, 200);

    const spineAfter = mustRow(
      getDb().prepare("SELECT COUNT(*) AS n FROM spine_events").get(),
      "spineAfter row exists"
    ).n;
    assert.equal(typeof spineAfter, "number");
    assert.equal(typeof spineBefore, "number");
    assert.ok(Number(spineAfter) > Number(spineBefore), "spine grew (delete event appended), never shrank");
    const deleteEvents = mustRow(
      getDb()
        .prepare("SELECT COUNT(*) AS n FROM spine_events WHERE event_type = 'owner_agent.connection.delete'")
        .get(),
      "delete event count row exists"
    ).n;
    assert.equal(deleteEvents, 1, "exactly one delete audit event appended");
  });
});

test("owner-agent delete rejects a client grant token with 403 and audits it", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorKey, "expected a canonical connector key");
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_cli",
      displayName: "Cli",
      sourceBindingKey: "c@example.com",
    });
    // biome-ignore lint/style/useDestructuring: index access documents the asserted ordered position
    const firstStream = manifest.streams[0];
    assert.ok(firstStream, "expected the manifest to declare at least one stream");
    const clientToken = await approveClientGrant(asUrl, connectorKey, firstStream.name);

    const { status, body: rawBody, resp } = await deleteConnection(rsUrl, clientToken, "/v1/owner/connections/cin_cli");
    const body = rawBody as DeleteResponseBody;
    assert.equal(status, 403);
    // biome-ignore lint/suspicious/noUnnecessaryConditions: assertion retains its defensive runtime boundary
    assert.equal(body?.error?.code, "permission_error");
    assert.equal(getInstance("cin_cli")?.status, "active", "client could not delete");

    const audit = findDeleteAuditEvent(resp);
    assert.equal(audit.status, "failed");
    assert.equal(audit.actor_type, "client");
    assert.equal(auditData(audit).operation, "delete");
  });
});

test("owner-agent delete rejects a request with no bearer (401)", async () => {
  await withServer(async ({ rsUrl }) => {
    const { status, body: rawBody } = await fetchJson(`${rsUrl}/v1/owner/connections/cin_any`, {
      headers: { "Content-Type": "application/json" },
      method: "DELETE",
    });
    const body = rawBody as DeleteResponseBody;
    assert.equal(status, 401);
    // biome-ignore lint/suspicious/noUnnecessaryConditions: assertion retains its defensive runtime boundary
    assert.equal(body?.error?.type, "authentication_error");
  });
});

test("a revoked owner-agent credential cannot delete a connection (401)", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorKey, "expected a canonical connector key");
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_dead",
      displayName: "Dead",
      sourceBindingKey: "d@example.com",
    });
    const ownerToken = await issueOwnerToken(asUrl);
    exec(referenceQueries.authTokensRevokeByClientId, [OWNER_CLIENT_ID]);
    const { status, body: rawBody } = await deleteConnection(rsUrl, ownerToken, "/v1/owner/connections/cin_dead");
    const body = rawBody as DeleteResponseBody;
    assert.equal(status, 401);
    // biome-ignore lint/suspicious/noUnnecessaryConditions: assertion retains its defensive runtime boundary
    assert.equal(body?.error?.type, "authentication_error");
    assert.equal(getInstance("cin_dead")?.status, "active", "dead credential could not delete");
  });
});

test("/mcp continues to reject owner-agent bearers after delete control lands (I9)", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body: rawBody } = await fetchJson(`${rsUrl}/mcp`, {
      body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/list", params: {} }),
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${ownerToken}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    const body = rawBody as DeleteResponseBody;
    assert.equal(status, 403);
    // biome-ignore lint/suspicious/noUnnecessaryConditions: assertion retains its defensive runtime boundary
    assert.equal(body?.error?.code, "permission_error");
    // biome-ignore lint/suspicious/noUnnecessaryConditions: assertion retains its defensive runtime boundary
    assert.match(body?.error?.message ?? "", TOP_LEVEL_REGEX_2);
  });
});

test("owner-agent control document advertises delete_connection as supported with a DELETE URL", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const { body: rawBody } = await fetchJson(`${rsUrl}/v1/owner/control`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const body = rawBody as DeleteResponseBody;
    const del = body.actions?.find((a) => a.family === "delete_connection");
    assert.ok(del, "delete_connection must be advertised");
    assert.equal(del.status, "supported");
    assert.equal(del.method, "DELETE");
    assert.equal(del.url, `${rsUrl}/v1/owner/connections/{connection_id}`);
  });
});
