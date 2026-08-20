// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { buildLocalDeviceRecordEnvelope } from "@pdpp/collector-runtime";
import { buildLocalDeviceIngestBatchRequest } from "@pdpp/collector-runtime/local-device-envelope";
import { registerConnector } from "../server/auth.ts";
import { COLLECTOR_PROTOCOL_VERSION } from "../server/collector-protocol.ts";
import { getDb } from "../server/db.ts";
import { HEARTBEAT_LEASE_MS } from "../server/heartbeat-lease.ts";
import { startServer } from "../server/index.ts";
import {
  __setIngestFaultHookForTest,
  deleteConnectionRecordRowsSqlite,
  enumerateConnectionStreams,
  ingestRecord,
  setClientEventEnqueueHook,
  teardownConnectionSearchProjection,
} from "../server/records.ts";
import { __setDeviceIngestStoreFaultHookForTest } from "../server/routes/ref-device-exporters.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";

const PROTOCOL_HEADERS = { "X-PDPP-Collector-Protocol": COLLECTOR_PROTOCOL_VERSION };
const CONNECTOR_INSTANCE_ID_PATTERN = /^cin_/;
const NARROW_ONLY_REJECTION_MESSAGE_PATTERN = /may only narrow, never widen/;
const ATTEMPT_MODEL_PATTERN = /attempt-model-c/;
const SEMANTIC_SENTINEL_PATTERN = /private-semantic-preflight-sentinel/;
const UNBOUNDED_SENTINEL_PATTERN = /private-unbounded-backend-sentinel/;
const DATA_SENTINEL_PATTERN = /private-data-sentinel|key and data disagree/;
const RESERVATION_SENTINEL_PATTERN = /private-reservation-store-sentinel/;
const DURABLE_SENTINEL_PATTERN = /private-durable-second-record-sentinel/;
const BACKEND_SENTINEL_PATTERN = /private-semantic-backend-sentinel/;

type Row = Record<string, unknown>;

interface TestStatement<Parameters extends unknown[], Result> {
  all: (...params: Parameters) => Result[];
  get: (...params: Parameters) => Result | undefined;
  run: (...params: Parameters) => { changes: number; lastInsertRowid: bigint | number };
}

interface TestDatabase {
  prepare: <Parameters extends unknown[] = unknown[], Result = Row>(sql: string) => TestStatement<Parameters, Result>;
}

function typedDb(): TestDatabase {
  return {
    prepare<Parameters extends unknown[] = unknown[], Result = Row>(sql: string): TestStatement<Parameters, Result> {
      const statement = getDb().prepare(sql);
      return {
        all: (...params) => statement.all<Result>(...params),
        get: (...params) => statement.get<Result>(...params),
        run: (...params) => statement.run(...params),
      };
    },
  };
}

function mustExist<T>(value: T | null | undefined, description: string): T {
  assert.ok(value, description);
  return value;
}

function selectRow<Result>(sql: string, ...params: unknown[]): Result {
  return mustExist(
    typedDb()
      .prepare<unknown[], Result>(sql)
      .get(...params),
    `database query returned no row: ${sql}`
  );
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function runSerial<T>(items: readonly T[], action: (item: T) => Promise<void>, index = 0): Promise<void> {
  if (index >= items.length) {
    return;
  }
  const item = items[index];
  if (item === undefined) {
    return;
  }
  await action(item);
  await runSerial(items, action, index + 1);
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

async function withServer(
  optionsOrFn: Record<string, unknown> | ((context: { asUrl: string }) => Promise<void>),
  maybeFn?: (context: { asUrl: string }) => Promise<void>
): Promise<void> {
  const opts = typeof optionsOrFn === "function" ? {} : optionsOrFn;
  const fn = typeof optionsOrFn === "function" ? optionsOrFn : mustExist(maybeFn, "withServer requires a callback");
  const server: CloseableTestServer = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    quiet: true,
    rsPort: 0,
    ...opts,
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

function errorMessage(response: JsonResponse): string {
  const { error } = bodyOf(response);
  assert.ok(error && typeof error === "object", "response body must carry an error object");
  return stringField(error as Record<string, unknown>, "message");
}

function stateOf(response: JsonResponse): Record<string, unknown> {
  const { state } = bodyOf(response);
  assert.ok(state && typeof state === "object", "response body must carry a state object");
  return state as Record<string, unknown>;
}

function errorOf(response: JsonResponse): Record<string, unknown> {
  const { error } = bodyOf(response);
  assert.ok(error && typeof error === "object", "response body must carry an error object");
  return error as Record<string, unknown>;
}

interface EnrolledDevice {
  readonly connector_id: string;
  readonly connector_instance_id: string;
  readonly device_id: string;
  readonly device_token: string;
  readonly source_instance_id: string;
}

async function enrollDevice(asUrl: string, localBindingName: string, connectorId = "codex"): Promise<EnrolledDevice> {
  const codeResp = await postJson(`${asUrl}/_ref/device-exporters/enrollment-codes`, {
    connector_id: connectorId,
    local_binding_name: localBindingName,
  });
  assert.equal(codeResp.status, 201);
  assert.equal(bodyOf(codeResp).object, "device_exporter_enrollment_code");

  const enrollResp = await postJson(
    `${asUrl}/_ref/device-exporters/enroll`,
    { enrollment_code: stringField(bodyOf(codeResp), "enrollment_code") },
    PROTOCOL_HEADERS
  );
  assert.equal(enrollResp.status, 201);
  const body = bodyOf(enrollResp);
  assert.equal(body.object, "device_exporter_enrollment");
  assert.match(stringField(body, "connector_instance_id"), CONNECTOR_INSTANCE_ID_PATTERN);
  return {
    connector_id: stringField(body, "connector_id"),
    connector_instance_id: stringField(body, "connector_instance_id"),
    device_id: stringField(body, "device_id"),
    device_token: stringField(body, "device_token"),
    source_instance_id: stringField(body, "source_instance_id"),
  };
}

function authHeaders(deviceToken: string): Record<string, string> {
  return { Authorization: `Bearer ${deviceToken}`, ...PROTOCOL_HEADERS };
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
    if (record[key] !== undefined) {
      out[key] = canonicalValue(record[key]);
    }
  }
  return out;
}

function bodyHash(records: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalValue(records)))
    .digest("hex");
}

interface DeviceRecordEntry {
  data: Record<string, unknown>;
  emitted_at: string;
  op?: string;
  record_key: string;
  stream: string;
}

interface DeviceBatch {
  batch_id: string;
  batch_seq: number;
  body_hash: string;
  connector_id: string;
  device_id: string;
  records: DeviceRecordEntry[];
  source_instance_id: string;
}

function makeBatch(device: EnrolledDevice, batchId: string, value: unknown): DeviceBatch {
  const records: DeviceRecordEntry[] = [
    {
      data: { id: "same-key", value },
      emitted_at: "2026-04-30T12:00:00.000Z",
      record_key: "same-key",
      stream: "messages",
    },
  ];
  return {
    batch_id: batchId,
    batch_seq: 1,
    body_hash: bodyHash(records),
    connector_id: device.connector_id,
    device_id: device.device_id,
    records,
    source_instance_id: device.source_instance_id,
  };
}

function firstRecord(batch: DeviceBatch): DeviceRecordEntry {
  return mustExist(batch.records[0], "batch must carry its first record");
}

// Local-device records are stored under the bare canonical connector key,
// the same key API/browser records use; connection isolation is carried by
// connector_instance_id, not a `local-device:` storage prefix. See
// canonicalize-connector-keys design Decision 7.
function internalStorageConnectorId(connectorId: string): string {
  return connectorId;
}

interface DeterministicAttemptBackendHooks {
  document: (text: string) => void;
  model: () => string;
}

interface DeterministicAttemptBackend {
  available: () => boolean;
  dimensions: () => number;
  distanceMetric: () => string;
  embedDocument: (text: string) => Promise<Float32Array>;
  embedQuery: () => Promise<Float32Array>;
  model: () => string;
  supportsDeviceAttemptDeadline: () => boolean;
}

function deterministicAttemptBackend(onEmbed: DeterministicAttemptBackendHooks): DeterministicAttemptBackend {
  return {
    available: () => true,
    dimensions: () => 3,
    distanceMetric: () => "cosine",
    embedDocument: (text) => {
      onEmbed.document(text);
      return Promise.resolve(new Float32Array([0.25, 0.5, 0.75]));
    },
    embedQuery: async () => new Float32Array([0.25, 0.5, 0.75]),
    model: () => onEmbed.model(),
    supportsDeviceAttemptDeadline: () => true,
  };
}

interface StreamManifest {
  consent_time_field?: string | null;
  cursor_field?: string | null;
  name: string;
  primary_key?: string[];
  query: { search: { lexical_fields?: string[]; semantic_fields?: string[] } };
  schema: { properties: Record<string, unknown> };
  [key: string]: unknown;
}

interface ConnectorManifest {
  streams: StreamManifest[];
  [key: string]: unknown;
}

function readCodexManifest(): ConnectorManifest {
  const row = mustExist(
    typedDb()
      .prepare<[string], { manifest: string }>("SELECT manifest FROM connectors WHERE connector_id = ?")
      .get("codex"),
    "codex manifest row must exist"
  );
  return JSON.parse(row.manifest);
}

function writeCodexManifest(manifest: ConnectorManifest): void {
  typedDb().prepare("UPDATE connectors SET manifest = ? WHERE connector_id = ?").run(JSON.stringify(manifest), "codex");
}

function setMessagesSemanticFields(fields: string[]): void {
  const manifest = readCodexManifest();
  const messages = mustExist(
    manifest.streams.find((stream) => stream.name === "messages"),
    "messages stream must exist"
  );
  messages.query.search.semantic_fields = fields;
  writeCodexManifest(manifest);
}

test("semantic-required device preflight is retryable, reservation-free, and privacy-safe without a bounded backend", async () => {
  await withServer({ semanticRetrievalSupported: false }, async ({ asUrl }) => {
    const device = await enrollDevice(asUrl, "semantic-preflight-unavailable");
    setMessagesSemanticFields(["content"]);
    const batch = makeBatch(device, "batch-semantic-preflight-unavailable", "unused");
    firstRecord(batch).data.content = "private-semantic-preflight-sentinel";
    batch.body_hash = bodyHash(batch.records);

    const response = await postJson(
      `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
      batch,
      authHeaders(device.device_token)
    );
    assert.equal(response.status, 503);
    assert.equal(errorCode(response), "device_ingest_retryable");
    assert.equal(errorMessage(response), "Device ingest is temporarily unavailable; retry the same batch");
    assert.doesNotMatch(JSON.stringify(response.body), SEMANTIC_SENTINEL_PATTERN);
    assert.equal(
      selectRow<{ count: number }>(
        "SELECT COUNT(*) AS count FROM device_ingest_batch_outcomes WHERE batch_id = ?",
        "batch-semantic-preflight-unavailable"
      ).count,
      0,
      "failed semantic preflight must occur before a processing reservation"
    );
  });
});

test("an injected semantic backend without confirmed attempt fencing is refused before reservation", async () => {
  let calls = 0;
  const unboundedBackend = {
    available: () => true,
    dimensions: () => 3,
    distanceMetric: () => "cosine",
    embedDocument: () => {
      calls += 1;
      return Promise.resolve(new Float32Array([0.25, 0.5, 0.75]));
    },
    embedQuery: async () => new Float32Array([0.25, 0.5, 0.75]),
    model: () => "unbounded-test-double",
  };
  await withServer({ semanticRetrievalBackend: unboundedBackend }, async ({ asUrl }) => {
    const device = await enrollDevice(asUrl, "semantic-preflight-unbounded");
    setMessagesSemanticFields(["content"]);
    const batch = makeBatch(device, "batch-semantic-preflight-unbounded", "unused");
    firstRecord(batch).data.content = "private-unbounded-backend-sentinel";
    batch.body_hash = bodyHash(batch.records);
    const response = await postJson(
      `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
      batch,
      authHeaders(device.device_token)
    );
    assert.equal(response.status, 503);
    assert.equal(errorCode(response), "device_ingest_retryable");
    assert.equal(calls, 0);
    assert.doesNotMatch(JSON.stringify(response.body), UNBOUNDED_SENTINEL_PATTERN);
    assert.equal(
      selectRow<{ count: number }>(
        "SELECT COUNT(*) AS count FROM device_ingest_batch_outcomes WHERE batch_id = ?",
        "batch-semantic-preflight-unbounded"
      ).count,
      0
    );
  });
});

test("declared semantic fields with empty values complete as a zero-row device index plan", async () => {
  let documentCalls = 0;
  const backend = deterministicAttemptBackend({
    document: () => {
      documentCalls += 1;
    },
    model: () => "empty-semantic-fields",
  });
  await withServer({ semanticRetrievalBackend: backend }, async ({ asUrl }) => {
    const device = await enrollDevice(asUrl, "semantic-empty-values");
    setMessagesSemanticFields(["content"]);
    const batch = makeBatch(device, "batch-semantic-empty-values", "unused");
    firstRecord(batch).data.content = "";
    batch.body_hash = bodyHash(batch.records);

    const response = await postJson(
      `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
      batch,
      authHeaders(device.device_token)
    );
    assert.equal(response.status, 201);
    assert.equal(bodyOf(response).accepted_record_count, 1);
    assert.equal(documentCalls, 0, "empty declared semantic values produce no vector rows or model work");
    const outcome = selectRow<{ durable_prefix_count: number; record_count: number; status: string }>(
      "SELECT status, durable_prefix_count, record_count FROM device_ingest_batch_outcomes WHERE batch_id = ?",
      "batch-semantic-empty-values"
    );
    assert.deepEqual(outcome, { durable_prefix_count: 1, record_count: 1, status: "accepted" });
  });
});

test("device ingest preflight and immutable attempt facts fence drift while accepted replay remains validation-free", async () => {
  let model = "attempt-model-a";
  let manifestChanged = false;
  let flipSemanticIdentity = false;
  let observeAcceptedBackfill = false;
  let acceptedStatusBeforeBackfill: string | undefined;
  let sawAcceptedBackfill = false;
  const backend = deterministicAttemptBackend({
    document: () => {
      if (observeAcceptedBackfill) {
        sawAcceptedBackfill ||= acceptedStatusBeforeBackfill === "accepted";
      }
      if (!manifestChanged) {
        const manifest = readCodexManifest();
        const messages = mustExist(
          manifest.streams.find((stream) => stream.name === "messages"),
          "messages stream must exist"
        );
        messages.query.search.semantic_fields = ["role"];
        messages.cursor_field = "updated_at";
        messages.consent_time_field = "updated_at";
        messages.primary_key = ["session_id"];
        writeCodexManifest(manifest);
        manifestChanged = true;
        model = "attempt-model-b";
      } else if (flipSemanticIdentity) {
        model = "attempt-model-c";
        flipSemanticIdentity = false;
      }
    },
    model: () => model,
  });

  await withServer({ semanticRetrievalBackend: backend }, async ({ asUrl }) => {
    const device = await enrollDevice(asUrl, "attempt-context");
    const initialManifest = readCodexManifest();
    const initialMessages = mustExist(
      initialManifest.streams.find((stream) => stream.name === "messages"),
      "messages stream must exist"
    );
    initialMessages.schema.properties.updated_at = { format: "date-time", type: "string" };
    initialMessages.cursor_field = "timestamp";
    initialMessages.consent_time_field = null;
    initialMessages.primary_key = ["id"];
    writeCodexManifest(initialManifest);
    const invalidRecords = [{ data: { id: "invalid" }, record_key: "invalid", stream: "not-in-manifest" }];
    const invalid = await postJson(
      `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
      {
        ...makeBatch(device, "batch-invalid-preflight", "unused"),
        body_hash: bodyHash(invalidRecords),
        records: invalidRecords,
      },
      authHeaders(device.device_token)
    );
    assert.equal(invalid.status, 400);
    assert.equal(
      selectRow<{ count: number }>(
        "SELECT COUNT(*) AS count FROM device_ingest_batch_outcomes WHERE batch_id = ?",
        "batch-invalid-preflight"
      ).count,
      0
    );

    const first = makeBatch(device, "batch-manifest-drift", "first");
    firstRecord(first).data = {
      ...firstRecord(first).data,
      content: "attempt context content",
      role: "user",
      session_id: "same-key",
      timestamp: "2026-04-30T11:00:00.000Z",
      updated_at: "2026-04-30T13:00:00.000Z",
    };
    first.body_hash = bodyHash(first.records);
    const stale = await postJson(
      `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
      first,
      authHeaders(device.device_token)
    );
    assert.equal(stale.status, 503, JSON.stringify(stale.body));
    const staleRow = selectRow<{
      durable_prefix_count: number;
      semantic_capability_identity: string;
      status: string;
    }>(
      `
      SELECT status, durable_prefix_count, manifest_fingerprint, semantic_capability_identity
        FROM device_ingest_batch_outcomes WHERE batch_id = ?
    `,
      "batch-manifest-drift"
    );
    assert.equal(staleRow.status, "processing");
    assert.equal(staleRow.durable_prefix_count, 1);
    assert.equal(staleRow.semantic_capability_identity.includes("attempt-model-a"), true);
    assert.equal(
      selectRow<{ semantic_time: string }>(
        "SELECT semantic_time FROM records WHERE connector_instance_id = ? AND record_key = ?",
        device.connector_instance_id,
        "same-key"
      ).semantic_time,
      "2026-04-30T11:00:00.000Z"
    );

    const repaired = await postJson(
      `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
      first,
      authHeaders(device.device_token)
    );
    assert.equal(repaired.status, 201);
    const acceptedRow = selectRow<{
      durable_prefix_count: number;
      record_count: number;
      semantic_capability_identity: string;
      status: string;
    }>(
      `
      SELECT status, durable_prefix_count, record_count, semantic_capability_identity
        FROM device_ingest_batch_outcomes WHERE batch_id = ?
    `,
      "batch-manifest-drift"
    );
    assert.deepEqual(
      {
        durable_prefix_count: acceptedRow.durable_prefix_count,
        record_count: acceptedRow.record_count,
        status: acceptedRow.status,
      },
      { durable_prefix_count: 1, record_count: 1, status: "accepted" }
    );
    assert.equal(acceptedRow.semantic_capability_identity.includes("attempt-model-b"), true);
    assert.equal(
      selectRow<{ semantic_time: string }>(
        "SELECT semantic_time FROM records WHERE connector_instance_id = ? AND record_key = ?",
        device.connector_instance_id,
        "same-key"
      ).semantic_time,
      "2026-04-30T13:00:00.000Z",
      "retry must repair durable semantic_time from the current manifest facts"
    );

    // A newly reserved batch can encounter an anchored, byte-identical row
    // after attempt facts changed. Acceptance still requires repairing the
    // durable derived value even though this input allocates no new version.
    getDb()
      .prepare("UPDATE records SET semantic_time = ? WHERE connector_instance_id = ? AND record_key = ?")
      .run("2026-04-30T11:00:00.000Z", device.connector_instance_id, "same-key");
    const freshNoop = await postJson(
      `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
      { ...first, batch_id: "batch-fresh-noop-derived-repair" },
      authHeaders(device.device_token)
    );
    assert.equal(freshNoop.status, 201, JSON.stringify(freshNoop.body));
    assert.deepEqual(
      getDb()
        .prepare("SELECT version, semantic_time FROM records WHERE connector_instance_id = ? AND record_key = ?")
        .get(device.connector_instance_id, "same-key"),
      { semantic_time: "2026-04-30T13:00:00.000Z", version: 1 },
      "fresh no-op input repairs attempt-derived state without version churn"
    );
    const repairedVector = selectRow<{ scope_key: string }>(
      `
      SELECT scope_key FROM semantic_search_blob
       WHERE connector_instance_id = ? AND scope_key = ? AND record_key = 'same-key'
      UNION ALL
      SELECT scope_key FROM semantic_search_rowid
       WHERE connector_instance_id = ? AND scope_key = ? AND record_key = 'same-key'
    `,
      device.connector_instance_id,
      JSON.stringify(["messages", "role"]),
      device.connector_instance_id,
      JSON.stringify(["messages", "role"])
    );
    assert.equal(repairedVector.scope_key, JSON.stringify(["messages", "role"]));

    flipSemanticIdentity = true;
    const semanticDrift = makeBatch(device, "batch-semantic-drift", "second");
    firstRecord(semanticDrift).data.content = "semantic identity content";
    firstRecord(semanticDrift).data.role = "assistant";
    semanticDrift.body_hash = bodyHash(semanticDrift.records);
    const semanticStale = await postJson(
      `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
      semanticDrift,
      authHeaders(device.device_token)
    );
    assert.equal(semanticStale.status, 503);
    const semanticRetry = await postJson(
      `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
      semanticDrift,
      authHeaders(device.device_token)
    );
    assert.equal(semanticRetry.status, 201);
    assert.match(
      selectRow<{ semantic_capability_identity: string }>(
        "SELECT semantic_capability_identity FROM device_ingest_batch_outcomes WHERE batch_id = ?",
        "batch-semantic-drift"
      ).semantic_capability_identity,
      ATTEMPT_MODEL_PATTERN
    );

    // A later registration mutation is allowed to be the final writer only
    // after the accepted attempt. Its synchronous backfill observes that
    // terminal state and rebuilds the changed manifest fields.
    const registeredManifest = readCodexManifest();
    const registeredMessages = mustExist(
      registeredManifest.streams.find((stream) => stream.name === "messages"),
      "messages stream must exist"
    );
    registeredMessages.query.search.lexical_fields = ["role"];
    registeredMessages.query.search.semantic_fields = ["content"];
    acceptedStatusBeforeBackfill = mustExist(
      typedDb()
        .prepare<[string], { status: string }>("SELECT status FROM device_ingest_batch_outcomes WHERE batch_id = ?")
        .get("batch-manifest-drift"),
      "outcome row must exist"
    ).status;
    observeAcceptedBackfill = true;
    await registerConnector(registeredManifest);
    observeAcceptedBackfill = false;
    assert.equal(sawAcceptedBackfill, true);
    const registrationLexical = typedDb()
      .prepare<[string], { field: string }>(`
      SELECT field FROM lexical_search_index
       WHERE connector_instance_id = ? AND stream = 'messages' AND record_key = 'same-key'
    `)
      .all(device.connector_instance_id);
    assert.deepEqual(
      registrationLexical.map((row) => row.field),
      ["role"]
    );

    // The accepted response is an immutable replay contract. Corrupting the
    // current manifest must not make that exact batch suddenly invalid.
    getDb().prepare("UPDATE connectors SET manifest = ? WHERE connector_id = ?").run("{invalid json", "codex");
    const replay = await postJson(
      `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
      first,
      authHeaders(device.device_token)
    );
    assert.equal(replay.status, 201);
    assert.equal(bodyOf(replay).status, "accepted");
  });
});

test("device ingest preserves op and rejects unsupported op or malformed data before reservation", async () => {
  await withServer(async ({ asUrl }) => {
    const device = await enrollDevice(asUrl, "shape-validation");
    const cases: [string, Record<string, unknown>][] = [
      ["unsupported-op", { data: { id: "same-key" }, op: "remove" }],
      ["array-upsert-data", { data: ["not", "an", "object"] }],
      ["null-upsert-data", { data: null }],
      ["missing-upsert-data", {}],
      ["null-delete-data", { data: null, op: "delete" }],
      ["nonempty-delete-data", { data: { ignored: true }, op: "delete" }],
      ["identity-mismatch", { data: { id: "private-data-sentinel" } }],
    ];
    assert.notEqual(
      bodyHash([{ data: { id: "same-key" }, op: "upsert", record_key: "same-key", stream: "messages" }]),
      bodyHash([{ data: {}, op: "delete", record_key: "same-key", stream: "messages" }]),
      "op is part of the canonical body hash"
    );

    await runSerial(cases, async ([suffix, override]) => {
      const record: Record<string, unknown> = {
        data: { id: "same-key" },
        emitted_at: "2026-07-16T00:00:00.000Z",
        record_key: "same-key",
        stream: "messages",
        ...override,
      };
      if (suffix === "missing-upsert-data") {
        Reflect.deleteProperty(record, "data");
      }
      if (suffix === "identity-mismatch") {
        record.record_key = "different-key";
      }
      const records = [record];
      const batch = {
        ...makeBatch(device, `batch-shape-${suffix}`, "unused"),
        body_hash: bodyHash(records),
        records,
      };
      const response = await postJson(
        `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
        batch,
        authHeaders(device.device_token)
      );
      assert.equal(response.status, 400, suffix);
      assert.equal(errorCode(response), "invalid_request", suffix);
      assert.doesNotMatch(JSON.stringify(response.body), DATA_SENTINEL_PATTERN);
      assert.equal(
        mustExist(
          typedDb()
            .prepare<[string], { count: number }>(
              "SELECT COUNT(*) AS count FROM device_ingest_batch_outcomes WHERE batch_id = ?"
            )
            .get(batch.batch_id),
          "count row must exist"
        ).count,
        0,
        `${suffix} must not reserve a batch`
      );
    });
  });
});

test("batch attempt deadline leaves the durable prefix sticky and retryable", async () => {
  const previousDeadline = process.env.PDPP_INGEST_BATCH_ATTEMPT_DEADLINE_MS;
  process.env.PDPP_INGEST_BATCH_ATTEMPT_DEADLINE_MS = "10";
  let delaySemantic = true;
  const backend = {
    available: () => true,
    dimensions: () => 3,
    distanceMetric: () => "cosine",
    embedDocument: async () => {
      if (delaySemantic) {
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      return new Float32Array([0.1, 0.2, 0.3]);
    },
    embedQuery: async () => new Float32Array([0.1, 0.2, 0.3]),
    model: () => "batch-deadline",
    supportsDeviceAttemptDeadline: () => true,
  };
  try {
    await withServer({ semanticRetrievalBackend: backend }, async ({ asUrl }) => {
      const device = await enrollDevice(asUrl, "batch-attempt-deadline");
      setMessagesSemanticFields(["content"]);
      const batch = makeBatch(device, "batch-attempt-deadline", "deadline");
      firstRecord(batch).data.content = "deadline payload";
      batch.body_hash = bodyHash(batch.records);
      const first = await postJson(
        `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
        batch,
        authHeaders(device.device_token)
      );
      assert.equal(first.status, 503, JSON.stringify(first.body));
      assert.equal(errorCode(first), "device_ingest_retryable");
      assert.deepEqual(
        getDb()
          .prepare("SELECT status, durable_prefix_count FROM device_ingest_batch_outcomes WHERE batch_id = ?")
          .get(batch.batch_id),
        { durable_prefix_count: 1, status: "processing" }
      );
      assert.equal(
        selectRow<{ count: number }>(
          "SELECT COUNT(*) AS count FROM record_changes WHERE connector_instance_id = ?",
          device.connector_instance_id
        ).count,
        1
      );

      delaySemantic = false;
      process.env.PDPP_INGEST_BATCH_ATTEMPT_DEADLINE_MS = "1000";
      const retry = await postJson(
        `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
        batch,
        authHeaders(device.device_token)
      );
      assert.equal(retry.status, 201, JSON.stringify(retry.body));
      assert.deepEqual(
        getDb()
          .prepare("SELECT status, durable_prefix_count FROM device_ingest_batch_outcomes WHERE batch_id = ?")
          .get(batch.batch_id),
        { durable_prefix_count: 1, status: "accepted" }
      );
      assert.equal(
        selectRow<{ count: number }>(
          "SELECT COUNT(*) AS count FROM record_changes WHERE connector_instance_id = ?",
          device.connector_instance_id
        ).count,
        1,
        "retry resumes derived work without allocating a second version"
      );
    });
  } finally {
    if (previousDeadline === undefined) {
      delete process.env.PDPP_INGEST_BATCH_ATTEMPT_DEADLINE_MS;
    } else {
      process.env.PDPP_INGEST_BATCH_ATTEMPT_DEADLINE_MS = previousDeadline;
    }
  }
});

test("device ingest canonicalizes connector aliases for replay and rejects a different canonical connector", async () => {
  await withServer(async ({ asUrl }) => {
    const device = await enrollDevice(asUrl, "connector-alias-identity");
    const batch = makeBatch(device, "batch-connector-alias-identity", "alias");
    batch.connector_id = "https://registry.pdpp.dev/connectors/codex";
    const accepted = await postJson(
      `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
      batch,
      authHeaders(device.device_token)
    );
    assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
    assert.equal(
      selectRow<{ connector_id: string }>(
        "SELECT connector_id FROM device_ingest_batch_outcomes WHERE batch_id = ?",
        batch.batch_id
      ).connector_id,
      "codex"
    );

    const replay = await postJson(
      `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
      { ...batch, connector_id: "codex" },
      authHeaders(device.device_token)
    );
    assert.equal(replay.status, 201);
    assert.deepEqual(replay.body, accepted.body);

    const beforeConflict = getDb()
      .prepare(
        `SELECT
         (SELECT COUNT(*) FROM records WHERE connector_instance_id = ?) AS records,
         (SELECT COUNT(*) FROM record_changes WHERE connector_instance_id = ?) AS changes,
         (SELECT COUNT(*) FROM device_ingest_batch_outcomes WHERE device_id = ?) AS outcomes`
      )
      .get(device.connector_instance_id, device.connector_instance_id, device.device_id);
    const sameBatchDifferentConnector = await postJson(
      `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
      { ...batch, connector_id: "claude-code" },
      authHeaders(device.device_token)
    );
    assert.equal(sameBatchDifferentConnector.status, 409);
    assert.equal(errorCode(sameBatchDifferentConnector), "device_batch_conflict");
    assert.deepEqual(
      getDb()
        .prepare(
          `SELECT
           (SELECT COUNT(*) FROM records WHERE connector_instance_id = ?) AS records,
           (SELECT COUNT(*) FROM record_changes WHERE connector_instance_id = ?) AS changes,
           (SELECT COUNT(*) FROM device_ingest_batch_outcomes WHERE device_id = ?) AS outcomes`
        )
        .get(device.connector_instance_id, device.connector_instance_id, device.device_id),
      beforeConflict,
      "same-batch connector conflicts must have zero effects"
    );

    const differentCanonicalConnector = await postJson(
      `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
      { ...batch, batch_id: "batch-different-canonical-connector", connector_id: "claude-code" },
      authHeaders(device.device_token)
    );
    assert.equal(differentCanonicalConnector.status, 400);
    assert.equal(errorCode(differentCanonicalConnector), "invalid_request");
    assert.equal(
      selectRow<{ count: number }>(
        "SELECT COUNT(*) AS count FROM device_ingest_batch_outcomes WHERE batch_id = ?",
        "batch-different-canonical-connector"
      ).count,
      0
    );
  });
});

test("device ingest verifies the shipped durable collector envelope hash", async () => {
  await withServer(async ({ asUrl }) => {
    const device = await enrollDevice(asUrl, "collector-envelope-hash");
    const batchId = "batch-collector-envelope-hash";
    const batchSeq = 7;
    const emitted = {
      data: { id: "collector-key", value: "from-shipped-collector" },
      emitted_at: "2026-07-16T00:00:00.000Z",
      key: "collector-key",
      stream: "messages",
      type: "RECORD" as const,
    };
    const envelope = buildLocalDeviceRecordEnvelope({
      batchId,
      batchSeq,
      connectorId: device.connector_id,
      deviceId: device.device_id,
      record: emitted,
      sourceInstanceId: device.source_instance_id,
    });
    const request = buildLocalDeviceIngestBatchRequest({
      batchId,
      batchSeq,
      connectorId: device.connector_id,
      deviceId: device.device_id,
      records: [envelope],
      sourceInstanceId: device.source_instance_id,
    });
    assert.notEqual(
      request.body_hash,
      bodyHash(request.records),
      "the current durable-envelope hash is intentionally distinct from the wire projection hash"
    );

    const accepted = await postJson(
      `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
      request,
      authHeaders(device.device_token)
    );
    assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
    assert.equal(bodyOf(accepted).accepted_record_count, 1);

    const representationConflict = await postJson(
      `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
      { ...request, body_hash: bodyHash(request.records) },
      authHeaders(device.device_token)
    );
    assert.equal(representationConflict.status, 409);
    assert.equal(errorCode(representationConflict), "device_batch_conflict");
    assert.equal(
      selectRow<{ count: number }>(
        "SELECT COUNT(*) AS count FROM record_changes WHERE connector_instance_id = ?",
        device.connector_instance_id
      ).count,
      1,
      "switching verified hash representation must not reapply the accepted batch"
    );
  });
});

test("unknown reservation-store failures use the fixed device retry envelope", async () => {
  __setDeviceIngestStoreFaultHookForTest((point: string) => {
    if (point === "before-get-batch-outcome") {
      throw new Error("private-reservation-store-sentinel");
    }
  });
  try {
    await withServer(async ({ asUrl }) => {
      const device = await enrollDevice(asUrl, "reservation-store-privacy");
      const batch = makeBatch(device, "batch-reservation-store-privacy", "store-failure");
      const response = await postJson(
        `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
        batch,
        authHeaders(device.device_token)
      );
      assert.equal(response.status, 503, JSON.stringify(response.body));
      assert.equal(errorCode(response), "device_ingest_retryable");
      assert.equal(errorMessage(response), "Device ingest is temporarily unavailable; retry the same batch");
      assert.doesNotMatch(JSON.stringify(response.body), RESERVATION_SENTINEL_PATTERN);
      assert.equal(
        selectRow<{ count: number }>(
          "SELECT COUNT(*) AS count FROM device_ingest_batch_outcomes WHERE batch_id = ?",
          batch.batch_id
        ).count,
        0
      );
    });
  } finally {
    __setDeviceIngestStoreFaultHookForTest(null);
  }
});

test("duplicate upsert/delete resumes a sticky cursor and leaves only the tombstone on SQLite", async () => {
  let versionAllocations = 0;
  __setIngestFaultHookForTest((point: string) => {
    if (point === "after-version-allocation") {
      versionAllocations += 1;
      if (versionAllocations === 2) {
        throw new Error("private-durable-second-record-sentinel");
      }
    }
  });
  try {
    await withServer(async ({ asUrl }) => {
      const device = await enrollDevice(asUrl, "duplicate-upsert-delete");
      const records = [
        {
          data: { id: "same-key", value: "before-delete" },
          emitted_at: "2026-07-16T00:00:00.000Z",
          op: "upsert",
          record_key: "same-key",
          stream: "messages",
        },
        {
          data: {},
          emitted_at: "2026-07-16T00:00:01.000Z",
          op: "delete",
          record_key: "same-key",
          stream: "messages",
        },
      ];
      const batch = {
        ...makeBatch(device, "batch-duplicate-upsert-delete", "unused"),
        body_hash: bodyHash(records),
        records,
      };
      const first = await postJson(
        `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
        batch,
        authHeaders(device.device_token)
      );
      assert.equal(first.status, 503, JSON.stringify(first.body));
      assert.equal(errorCode(first), "device_ingest_retryable");
      assert.doesNotMatch(JSON.stringify(first.body), DURABLE_SENTINEL_PATTERN);
      assert.deepEqual(
        getDb()
          .prepare("SELECT status, durable_prefix_count FROM device_ingest_batch_outcomes WHERE batch_id = ?")
          .get(batch.batch_id),
        { durable_prefix_count: 1, status: "processing" }
      );

      const retry = await postJson(
        `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
        batch,
        authHeaders(device.device_token)
      );
      assert.equal(retry.status, 201);
      const row = selectRow<{ deleted: number; record_json: string; version: number }>(
        `SELECT deleted, version, record_json FROM records
          WHERE connector_instance_id = ? AND stream = 'messages' AND record_key = 'same-key'`,
        device.connector_instance_id
      );
      assert.deepEqual({ deleted: row.deleted, version: row.version }, { deleted: 1, version: 2 });
      assert.equal(
        selectRow<{ count: number }>(
          "SELECT COUNT(*) AS count FROM record_changes WHERE connector_instance_id = ? AND stream = ? AND record_key = ?",
          device.connector_instance_id,
          "messages",
          "same-key"
        ).count,
        2
      );
      assert.equal(
        selectRow<{ max_version: number }>(
          "SELECT max_version FROM version_counter WHERE connector_instance_id = ? AND stream = ?",
          device.connector_instance_id,
          "messages"
        ).max_version,
        2
      );
      assert.equal(
        selectRow<{ count: number }>(
          "SELECT COUNT(*) AS count FROM lexical_search_index WHERE connector_instance_id = ? AND stream = ? AND record_key = ?",
          device.connector_instance_id,
          "messages",
          "same-key"
        ).count,
        0
      );
    });
  } finally {
    __setIngestFaultHookForTest(null);
  }
});

interface ClientEventNotification extends Row {
  connectorInstanceId?: string;
  version: number;
}

test("a post-durable index retry repairs from the newer authoritative writer on SQLite", async () => {
  let failFirstSemantic = true;
  const backend = {
    available: () => true,
    dimensions: () => 3,
    distanceMetric: () => "cosine",
    embedDocument: (text: string) => {
      if (failFirstSemantic && text.includes("payload-a")) {
        failFirstSemantic = false;
        throw new Error("private-semantic-backend-sentinel");
      }
      return Promise.resolve(
        text.includes("payload-b") ? new Float32Array([0.2, 0.3, 0.4]) : new Float32Array([0.8, 0.7, 0.6])
      );
    },
    embedQuery: async () => new Float32Array([0.2, 0.3, 0.4]),
    model: () => "authoritative-interleave",
    supportsDeviceAttemptDeadline: () => true,
  };
  await withServer({ semanticRetrievalBackend: backend }, async ({ asUrl }) => {
    const device = await enrollDevice(asUrl, "authoritative-interleave");
    setMessagesSemanticFields(["content"]);
    const notifications: ClientEventNotification[] = [];
    setClientEventEnqueueHook((change: ClientEventNotification) => notifications.push(change));
    try {
      const records = [
        {
          data: { content: "payload-a", id: "same-key", role: "user" },
          emitted_at: "2026-07-16T00:00:00.000Z",
          record_key: "same-key",
          stream: "messages",
        },
      ];
      const batch = {
        ...makeBatch(device, "batch-authoritative-interleave", "unused"),
        body_hash: bodyHash(records),
        records,
      };
      const first = await postJson(
        `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
        batch,
        authHeaders(device.device_token)
      );
      assert.equal(first.status, 503);
      assert.equal(errorCode(first), "device_ingest_retryable");
      assert.doesNotMatch(JSON.stringify(first.body), BACKEND_SENTINEL_PATTERN);
      assert.equal(
        selectRow<{ version: number }>(
          "SELECT version FROM records WHERE connector_instance_id = ? AND stream = ? AND record_key = ?",
          device.connector_instance_id,
          "messages",
          "same-key"
        ).version,
        1
      );

      await ingestRecord(
        { connector_id: device.connector_id, connector_instance_id: device.connector_instance_id },
        {
          data: { content: "payload-b", id: "same-key", role: "assistant" },
          emitted_at: "2026-07-16T00:00:01.000Z",
          key: "same-key",
          stream: "messages",
        }
      );
      assert.equal(notifications.length, 2, "A and direct B each notify exactly once");
      assert.deepEqual(
        notifications.map((change) => change.version),
        [1, 2],
        "SQLite notification versions define the backend-parity oracle"
      );

      const retry = await postJson(
        `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
        batch,
        authHeaders(device.device_token)
      );
      assert.equal(retry.status, 201);
      const current = selectRow<{ record_json: string; semantic_time: string; version: number }>(
        "SELECT version, record_json, semantic_time FROM records WHERE connector_instance_id = ? AND stream = ? AND record_key = ?",
        device.connector_instance_id,
        "messages",
        "same-key"
      );
      assert.equal(current.version, 2, "retry must not allocate a third version");
      assert.equal(JSON.parse(current.record_json).content, "payload-b");
      assert.equal(notifications.length, 2, "authoritative repair must not emit a retry notification");
      assert.equal(
        selectRow<{ count: number }>(
          "SELECT COUNT(*) AS count FROM record_changes WHERE connector_instance_id = ? AND stream = ? AND record_key = ?",
          device.connector_instance_id,
          "messages",
          "same-key"
        ).count,
        2
      );
      assert.deepEqual(
        getDb()
          .prepare(
            `SELECT field, text FROM lexical_search_index
          WHERE connector_instance_id = ? AND stream = ? AND record_key = ? AND field = 'content'`
          )
          .get(device.connector_instance_id, "messages", "same-key"),
        { field: "content", text: "payload-b" }
      );
      const semanticRow = typedDb()
        .prepare<unknown[], { embedding: Uint8Array }>(
          `SELECT embedding FROM semantic_search_blob
          WHERE connector_instance_id = ? AND scope_key = ? AND record_key = ?`
        )
        .get(device.connector_instance_id, JSON.stringify(["messages", "content"]), "same-key");
      if (semanticRow) {
        assert.ok(Math.abs(Buffer.from(semanticRow.embedding).readFloatLE(0) - 0.2) < 1e-6);
      } else {
        const semanticRowId = mustExist(
          typedDb()
            .prepare<unknown[], { rowid: number }>(
              `SELECT rowid FROM semantic_search_rowid
            WHERE connector_instance_id = ? AND scope_key = ? AND record_key = ?`
            )
            .get(device.connector_instance_id, JSON.stringify(["messages", "content"]), "same-key"),
          "semantic row id must exist"
        );
        const vectorRow = selectRow<{ embedding: Uint8Array }>(
          "SELECT embedding FROM semantic_search_vec WHERE rowid = ?",
          semanticRowId.rowid
        );
        assert.ok(Math.abs(Buffer.from(vectorRow.embedding).readFloatLE(0) - 0.2) < 1e-6);
      }
    } finally {
      setClientEventEnqueueHook(null);
    }
  });
});

test("device batch's derived (embedding) section does not block a same-instance direct writer; a sibling instance overlaps too", async () => {
  const previousSemanticLimit = process.env.PDPP_SEMANTIC_WORK_LIMIT;
  process.env.PDPP_SEMANTIC_WORK_LIMIT = "2";
  const deviceEmbeddingEntered = deferred();
  const releaseDeviceEmbedding = deferred();
  const backend = {
    available: () => true,
    dimensions: () => 3,
    distanceMetric: () => "cosine",
    embedDocument: async (text: string) => {
      if (text === "device blocked") {
        deviceEmbeddingEntered.resolve();
        await releaseDeviceEmbedding.promise;
      }
      return new Float32Array([0.25, 0.5, 0.75]);
    },
    embedQuery: async () => new Float32Array([0.25, 0.5, 0.75]),
    model: () => "device-coordination-test",
    supportsDeviceAttemptDeadline: () => true,
  };

  try {
    await withServer({ semanticRetrievalBackend: backend }, async ({ asUrl }) => {
      const device = await enrollDevice(asUrl, "device-direct-coordination");
      const manifest = readCodexManifest();
      const messages = mustExist(
        manifest.streams.find((stream) => stream.name === "messages"),
        "messages stream must exist"
      );
      messages.query.search.semantic_fields = ["content"];
      await registerConnector(manifest);

      const records = [
        {
          data: { content: "device blocked", id: "same-key", role: "user", value: "device" },
          emitted_at: "2026-07-16T00:00:00.000Z",
          record_key: "same-key",
          stream: "messages",
        },
      ];
      let batch: Promise<JsonResponse> | null = null;
      let sameInstanceDirect: Promise<unknown> | null = null;
      try {
        batch = postJson(
          `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
          {
            batch_id: "batch-device-direct-coordination",
            batch_seq: 1,
            body_hash: bodyHash(records),
            connector_id: device.connector_id,
            device_id: device.device_id,
            records,
            source_instance_id: device.source_instance_id,
          },
          authHeaders(device.device_token)
        );
        await deviceEmbeddingEntered.promise;

        // By the time embedding is entered, the device batch's durable
        // record write already committed (durable phase runs BEFORE the
        // derived/embedding phase) and released its per-record fence — the
        // fence is never held through embedding (see
        // harden-connector-instance-write-fence-transaction-native). A
        // same-instance direct writer for the SAME key must therefore be
        // able to proceed and complete WITHOUT waiting for the device
        // batch's still-in-flight embedding: this is the exact live-incident
        // shape being fixed (GroupMe run_1786387569309_3: same-instance
        // /v1/blobs 503s while a batch's derived work was still in flight).
        sameInstanceDirect = ingestRecord(
          { connector_id: device.connector_id, connector_instance_id: device.connector_instance_id },
          {
            data: { content: "direct after device", id: "same-key", role: "user", value: "direct" },
            emitted_at: "2026-07-16T00:00:01.000Z",
            key: "same-key",
            stream: "messages",
          }
        );
        await sameInstanceDirect;

        await ingestRecord(
          { connector_id: device.connector_id, connector_instance_id: "cin_device_direct_sibling" },
          {
            data: { content: "sibling overlaps", id: "sibling-key", role: "user", value: "sibling" },
            emitted_at: "2026-07-16T00:00:01.000Z",
            key: "sibling-key",
            stream: "messages",
          }
        );

        releaseDeviceEmbedding.resolve();
        const result = await batch;
        assert.equal(result.status, 201);
        // The durable RECORD row must reflect the direct writer (it
        // committed after the device's own durable write, per-record
        // fenced).
        const finalRecord = selectRow<{ record_json: string }>(
          `SELECT record_json FROM records
          WHERE connector_instance_id = ? AND stream = 'messages' AND record_key = 'same-key'`,
          device.connector_instance_id
        );
        assert.equal(JSON.parse(finalRecord.record_json).content, "direct after device");
        // Mutation-discriminating oracle: the device batch's embedding was
        // still in-flight (stalled on `releaseDeviceEmbedding`) when the
        // direct writer's OWN durable write and index publication already
        // ran and completed. If the device batch's LATER, stale publication
        // (still holding "device blocked" in its captured snapshot) were
        // allowed to overwrite the index after the direct writer's correct
        // publication, this would read "device blocked" instead of "direct
        // after device" — the derived-index staleness race this test
        // exists to rule out (see `enqueueDeviceIndexMaintenance`'s header
        // in records.ts). Awaiting `batch` above already waited for the
        // device batch's own index-lane job to finish (the route awaits it
        // before responding 201), so no extra drain is needed here.
        const lexicalRow = getDb()
          .prepare(
            `SELECT text FROM lexical_search_index
            WHERE connector_instance_id = ? AND stream = 'messages' AND record_key = 'same-key' AND field = 'content'`
          )
          .get(device.connector_instance_id) as { text: string } | undefined;
        assert.equal(
          mustExist(lexicalRow, "lexical index row must exist for same-key").text,
          "direct after device",
          "lexical index must reflect the WINNING (direct) write, not a stale device-batch snapshot"
        );
      } finally {
        releaseDeviceEmbedding.resolve();
        await Promise.allSettled([batch, sameInstanceDirect].filter(Boolean));
      }
    });
  } finally {
    if (previousSemanticLimit === undefined) {
      delete process.env.PDPP_SEMANTIC_WORK_LIMIT;
    } else {
      process.env.PDPP_SEMANTIC_WORK_LIMIT = previousSemanticLimit;
    }
  }
});

test("device exporter routes enroll, heartbeat, ingest idempotently, isolate source instances, and revoke", async () => {
  await withServer(async ({ asUrl }) => {
    const missingAuth = await postJson(`${asUrl}/_ref/device-exporters/dev_missing/heartbeat`, {}, PROTOCOL_HEADERS);
    assert.equal(missingAuth.status, 401);
    assert.equal(errorCode(missingAuth), "authentication_error");

    const first = await enrollDevice(asUrl, "laptop-a");
    const second = await enrollDevice(asUrl, "laptop-b");
    assert.notEqual(first.source_instance_id, second.source_instance_id);

    getDb()
      .prepare(
        `INSERT INTO tokens(token_id, grant_id, subject_id, client_id, token_kind, expires_at)
       VALUES(?, NULL, ?, NULL, 'owner', ?)`
      )
      .run("owner-token-for-device-route-test", "owner_ref", "2999-01-01T00:00:00.000Z");
    const ownerTokenRejected = await postJson(
      `${asUrl}/_ref/device-exporters/${encodeURIComponent(first.device_id)}/heartbeat`,
      { source_instances: [{ source_instance_id: first.source_instance_id }] },
      authHeaders("owner-token-for-device-route-test")
    );
    assert.equal(ownerTokenRejected.status, 403);
    assert.equal(errorCode(ownerTokenRejected), "permission_error");

    const heartbeat = await postJson(
      `${asUrl}/_ref/device-exporters/${encodeURIComponent(first.device_id)}/heartbeat`,
      {
        // Build-derived agent version, surfaced so an owner can spot stale-build
        // drift without inspecting dist mtimes. The reference persists it and
        // the diagnostics projection echoes it back (asserted below).
        agent_version: "0.0.0+deadbeef0001",
        connector_id: "codex",
        records_pending: 0,
        source_instance_id: first.source_instance_id,
        status: "healthy",
      },
      authHeaders(first.device_token)
    );
    assert.equal(heartbeat.status, 200);
    assert.equal(bodyOf(heartbeat).status, "accepted");

    const firstBatch = makeBatch(first, "batch-1", "first");
    const ingest = await postJson(
      `${asUrl}/_ref/device-exporters/${encodeURIComponent(first.device_id)}/ingest-batches`,
      firstBatch,
      authHeaders(first.device_token)
    );
    assert.equal(ingest.status, 201);
    assert.equal(bodyOf(ingest).connector_instance_id, first.connector_instance_id);
    assert.equal(bodyOf(ingest).accepted_record_count, 1);

    const replay = await postJson(
      `${asUrl}/_ref/device-exporters/${encodeURIComponent(first.device_id)}/ingest-batches`,
      firstBatch,
      authHeaders(first.device_token)
    );
    assert.equal(replay.status, 201);
    assert.equal(bodyOf(replay).status, "accepted");

    const conflictingRecords = firstBatch.records.map((record) => ({
      ...record,
      data: { ...record.data, value: "conflicting" },
    }));
    const conflict = await postJson(
      `${asUrl}/_ref/device-exporters/${encodeURIComponent(first.device_id)}/ingest-batches`,
      { ...firstBatch, body_hash: bodyHash(conflictingRecords), records: conflictingRecords },
      authHeaders(first.device_token)
    );
    assert.equal(conflict.status, 409);
    assert.equal(errorCode(conflict), "device_batch_conflict");

    const secondBatch = makeBatch(second, "batch-2", "second");
    const secondIngest = await postJson(
      `${asUrl}/_ref/device-exporters/${encodeURIComponent(second.device_id)}/ingest-batches`,
      secondBatch,
      authHeaders(second.device_token)
    );
    assert.equal(secondIngest.status, 201);
    assert.equal(bodyOf(secondIngest).connector_instance_id, second.connector_instance_id);

    const db = typedDb();
    const instanceRows = db
      .prepare<[string, string, string], { connector_instance_id: string; record_json: string }>(
        `SELECT connector_instance_id, record_json
         FROM records
        WHERE connector_id = ? AND stream = ? AND record_key = ?
        ORDER BY connector_instance_id`
      )
      .all(internalStorageConnectorId("codex"), "messages", "same-key");
    assert.equal(instanceRows.length, 2);
    assert.deepEqual(
      new Map(instanceRows.map((row) => [row.connector_instance_id, JSON.parse(row.record_json).value])),
      new Map([
        [first.connector_instance_id, "first"],
        [second.connector_instance_id, "second"],
      ])
    );

    const diagnosticsResp = await fetch(`${asUrl}/_ref/device-exporters/diagnostics`, {
      headers: { Accept: "application/json" },
    });
    assert.equal(diagnosticsResp.status, 200);
    const diagnostics = (await diagnosticsResp.json()) as DiagnosticsPayload;
    assert.equal(diagnostics.data.length, 2);
    const firstDiagnostics = mustExist(
      diagnostics.data.find((device) => device.device_id === first.device_id),
      "first device diagnostics must exist"
    );
    assert.ok(
      Number.isFinite(Date.parse(mustExist(firstDiagnostics.last_heartbeat_at, "last_heartbeat_at must exist")))
    );
    // The build-derived agent version sent on the heartbeat is persisted and
    // surfaced on the owner diagnostics projection.
    assert.equal(firstDiagnostics.agent_version, "0.0.0+deadbeef0001");
    // A device that never reported a version surfaces null, not an error.
    const secondDiagnostics = mustExist(
      diagnostics.data.find((device) => device.device_id === second.device_id),
      "second device diagnostics must exist"
    );
    assert.equal(secondDiagnostics.agent_version, null);
    // Presented health is DERIVED from heartbeat age against the declared
    // lease, not read off `last_heartbeat_status`. A just-sent heartbeat is
    // within lease, so the collector's own status passes through — and the
    // age and the lease it was judged against travel with it, which is what
    // lets a reader tell a live `starting` from a 38-hour-dead one.
    const firstSource = mustExist(firstDiagnostics.source_instances[0], "first source instance must exist");
    assert.equal(firstSource.heartbeat_health, "healthy", "a heartbeat sent moments ago is within lease");
    assert.equal(firstSource.heartbeat_lease_ms, HEARTBEAT_LEASE_MS, "the projection declares the lease it applied");
    assert.ok(
      typeof firstSource.heartbeat_age_ms === "number" && firstSource.heartbeat_age_ms < HEARTBEAT_LEASE_MS,
      "and reports the measured age that produced the verdict"
    );
    assert.equal(
      mustExist(firstDiagnostics.source_instances[0], "first source instance must exist").connector_instance_id,
      first.connector_instance_id
    );
    assert.equal(
      mustExist(firstDiagnostics.source_instances[0], "first source instance must exist").accepted_record_count,
      1
    );

    const revokeResp = await postJson(
      `${asUrl}/_ref/device-exporters/${encodeURIComponent(first.device_id)}/revoke`,
      {}
    );
    assert.equal(revokeResp.status, 200);

    const revokedHeartbeat = await postJson(
      `${asUrl}/_ref/device-exporters/${encodeURIComponent(first.device_id)}/heartbeat`,
      { source_instances: [{ source_instance_id: first.source_instance_id }] },
      authHeaders(first.device_token)
    );
    assert.equal(revokedHeartbeat.status, 401);
  });
});

test("self-revoke lets a device close its own credential using only its own bearer token", async () => {
  await withServer(async ({ asUrl }) => {
    const device = await enrollDevice(asUrl, "self-revoke-laptop");

    const selfRevokeResp = await postJson(
      `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/self-revoke`,
      {},
      authHeaders(device.device_token)
    );
    assert.equal(selfRevokeResp.status, 200);
    const body = bodyOf(selfRevokeResp);
    assert.equal(body.object, "device_exporter_revocation");
    assert.equal(body.device_id, device.device_id);
    assert.ok(typeof body.revoked_at === "string" && Number.isFinite(Date.parse(body.revoked_at as string)));

    const heartbeatAfterRevoke = await postJson(
      `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/heartbeat`,
      { source_instances: [{ source_instance_id: device.source_instance_id }] },
      authHeaders(device.device_token)
    );
    assert.equal(heartbeatAfterRevoke.status, 401, "the revoked credential must not authenticate any further request");
  });
});

test("self-revoke rejects an owner session and any other unauthenticated caller", async () => {
  await withServer(async ({ asUrl }) => {
    const device = await enrollDevice(asUrl, "self-revoke-no-owner");

    const missingAuth = await postJson(
      `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/self-revoke`,
      {},
      PROTOCOL_HEADERS
    );
    assert.equal(missingAuth.status, 401);
    assert.equal(errorCode(missingAuth), "authentication_error");

    getDb()
      .prepare(
        `INSERT INTO tokens(token_id, grant_id, subject_id, client_id, token_kind, expires_at)
       VALUES(?, NULL, ?, NULL, 'owner', ?)`
      )
      .run("owner-token-for-self-revoke-test", "owner_ref", "2999-01-01T00:00:00.000Z");
    const ownerTokenRejected = await postJson(
      `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/self-revoke`,
      {},
      authHeaders("owner-token-for-self-revoke-test")
    );
    assert.equal(
      ownerTokenRejected.status,
      403,
      "an owner/client bearer token is not a valid device exporter credential"
    );
    assert.equal(errorCode(ownerTokenRejected), "permission_error");
  });
});

test("self-revoke is scoped to the authenticated device: a device cannot revoke a different device", async () => {
  await withServer(async ({ asUrl }) => {
    const first = await enrollDevice(asUrl, "self-revoke-victim");
    const second = await enrollDevice(asUrl, "self-revoke-attacker");

    const crossDeviceRevoke = await postJson(
      `${asUrl}/_ref/device-exporters/${encodeURIComponent(first.device_id)}/self-revoke`,
      {},
      authHeaders(second.device_token)
    );
    assert.equal(
      crossDeviceRevoke.status,
      403,
      "a device credential must never be able to revoke a different device by URL id"
    );
    assert.equal(errorCode(crossDeviceRevoke), "permission_error");

    // The victim device's credential must still be live — the cross-device
    // attempt above must not have revoked it as a side effect.
    const heartbeatStillWorks = await postJson(
      `${asUrl}/_ref/device-exporters/${encodeURIComponent(first.device_id)}/heartbeat`,
      { source_instances: [{ source_instance_id: first.source_instance_id }] },
      authHeaders(first.device_token)
    );
    assert.equal(heartbeatStillWorks.status, 200);
  });
});

test("self-revoke retried after the credential is already revoked fails closed with 401, not a crash", async () => {
  await withServer(async ({ asUrl }) => {
    const device = await enrollDevice(asUrl, "self-revoke-retry");

    const first = await postJson(
      `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/self-revoke`,
      {},
      authHeaders(device.device_token)
    );
    assert.equal(first.status, 200);

    // A retry with the same (now-revoked) token cannot re-authenticate — the
    // device-credential middleware itself rejects a revoked credential before
    // the route body runs. This 401 is the exact signal `logout` on the CLI
    // side treats as "already revoked" and proceeds to delete local state.
    const retry = await postJson(
      `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/self-revoke`,
      {},
      authHeaders(device.device_token)
    );
    assert.equal(retry.status, 401);
    assert.equal(errorCode(retry), "authentication_error");
  });
});

test("two claude-code source homes ingest the same connector-local key without overwriting each other", async () => {
  // complete-local-agent-collectors task 3.4 (Claude Code half). Two Claude
  // Code source homes for the same owner legitimately share connector-local
  // record keys (e.g. a skill named `demo-skill` → record key
  // `skills:demo-skill`). Each source home enrolls under its own
  // local_binding_name, resolving to a distinct connector_instance_id, so the
  // store's (connector_instance_id, stream, record_key) unique key keeps both
  // rows. The connector_id is canonicalized to `claude-code` on enrollment.
  await withServer(async ({ asUrl }) => {
    const homeA = await enrollDevice(asUrl, "laptop-claude-a", "claude-code");
    const homeB = await enrollDevice(asUrl, "desktop-claude-b", "claude-code");
    assert.equal(homeA.connector_id, "claude-code");
    assert.equal(homeB.connector_id, "claude-code");
    assert.notEqual(homeA.source_instance_id, homeB.source_instance_id);
    assert.notEqual(homeA.connector_instance_id, homeB.connector_instance_id);

    // Both homes ingest a record under the identical connector-local key
    // `skills:demo-skill`, mirroring what the Claude Code connector emits for
    // a skill of the same name present on both machines.
    const makeSkillBatch = (device: EnrolledDevice, batchId: string, body: string) => {
      const records = [
        {
          data: { content: body, id: "skills:demo-skill", name: "Demo Skill" },
          emitted_at: "2026-05-31T12:00:00.000Z",
          record_key: "skills:demo-skill",
          stream: "skills",
        },
      ];
      return {
        batch_id: batchId,
        batch_seq: 1,
        body_hash: bodyHash(records),
        connector_id: device.connector_id,
        device_id: device.device_id,
        records,
        source_instance_id: device.source_instance_id,
      };
    };

    const ingestA = await postJson(
      `${asUrl}/_ref/device-exporters/${encodeURIComponent(homeA.device_id)}/ingest-batches`,
      makeSkillBatch(homeA, "claude-batch-a", "Device A skill body"),
      authHeaders(homeA.device_token)
    );
    assert.equal(ingestA.status, 201);
    assert.equal(bodyOf(ingestA).connector_instance_id, homeA.connector_instance_id);

    const ingestB = await postJson(
      `${asUrl}/_ref/device-exporters/${encodeURIComponent(homeB.device_id)}/ingest-batches`,
      makeSkillBatch(homeB, "claude-batch-b", "Device B skill body"),
      authHeaders(homeB.device_token)
    );
    assert.equal(ingestB.status, 201);
    assert.equal(bodyOf(ingestB).connector_instance_id, homeB.connector_instance_id);

    // Both source homes' records coexist under the canonical claude-code
    // storage key, keyed apart by connector_instance_id.
    const rows = typedDb()
      .prepare<[string, string, string], { connector_instance_id: string; record_json: string }>(
        `SELECT connector_instance_id, record_json
         FROM records
        WHERE connector_id = ? AND stream = ? AND record_key = ?
        ORDER BY connector_instance_id`
      )
      .all("claude-code", "skills", "skills:demo-skill");
    assert.equal(rows.length, 2, "both source homes must persist their own skills:demo-skill row");
    assert.deepEqual(
      new Map(rows.map((row) => [row.connector_instance_id, JSON.parse(row.record_json).content])),
      new Map([
        [homeA.connector_instance_id, "Device A skill body"],
        [homeB.connector_instance_id, "Device B skill body"],
      ]),
      "neither source home may overwrite the other"
    );
  });
});

function putSourceInstanceState(asUrl: string, device: EnrolledDevice, state: unknown): Promise<JsonResponse> {
  return fetch(
    `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/source-instances/${encodeURIComponent(device.source_instance_id)}/state`,
    {
      body: JSON.stringify({ state }),
      headers: { Accept: "application/json", "Content-Type": "application/json", ...authHeaders(device.device_token) },
      method: "PUT",
    }
  ).then(async (resp) => ({ body: (await resp.json()) as Record<string, unknown> | null, status: resp.status }));
}

function getSourceInstanceState(asUrl: string, device: EnrolledDevice, tokenOverride?: string): Promise<JsonResponse> {
  return fetch(
    `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/source-instances/${encodeURIComponent(device.source_instance_id)}/state`,
    { headers: { Accept: "application/json", ...authHeaders(tokenOverride ?? device.device_token) } }
  ).then(async (resp) => ({ body: (await resp.json()) as Record<string, unknown> | null, status: resp.status }));
}

test("two source homes keep collector state/checkpoints isolated by connector instance", async () => {
  // complete-local-agent-collectors tasks 3.1 (state gate) + 3.2 (checkpoint
  // namespace). Two source homes of the same connector type legitimately use
  // identical connector-local stream cursor keys (e.g. both track a `sessions`
  // checkpoint). The device state PUT/GET routes resolve the authorized
  // connector instance from (device, source_instance) and persist under the
  // `(connector_instance_id, stream)` namespace, so one home's checkpoint can
  // never read or clobber the other's even though the connector-local stream
  // keys collide. This proves the state/checkpoint half of the connector-
  // instance gate that the records path already proves for ingest.
  await withServer(async ({ asUrl }) => {
    const homeA = await enrollDevice(asUrl, "laptop-state-a", "claude-code");
    const homeB = await enrollDevice(asUrl, "desktop-state-b", "claude-code");
    assert.notEqual(homeA.connector_instance_id, homeB.connector_instance_id);

    // Both homes start with no STREAM cursors — neither can see the other
    // before either has written anything. Enrollment itself writes exactly
    // one reserved, non-stream key (`$collection_scope`, the honest
    // recent-history default an undeclared enrollment gets — see
    // enrollment-scope-narrowing.ts), so state is not literally `{}`; the
    // isolation property under test is that no STREAM key leaked across
    // connector instances.
    const emptyA = await getSourceInstanceState(asUrl, homeA);
    assert.equal(emptyA.status, 200);
    assert.deepEqual(
      Object.keys(stateOf(emptyA)).filter((key) => !key.startsWith("$")),
      []
    );
    assert.equal(bodyOf(emptyA).connector_instance_id, homeA.connector_instance_id);

    // Each home checkpoints the SAME connector-local stream cursor keys with
    // its own values.
    const putA = await putSourceInstanceState(asUrl, homeA, {
      sessions: "cursor-A-2026-05-31",
      skills: "skills-cursor-A",
    });
    assert.equal(putA.status, 200, JSON.stringify(putA.body));
    assert.equal(bodyOf(putA).connector_instance_id, homeA.connector_instance_id);
    assert.equal(stateOf(putA).sessions, "cursor-A-2026-05-31");

    const putB = await putSourceInstanceState(asUrl, homeB, {
      sessions: "cursor-B-2026-05-31",
      skills: "skills-cursor-B",
    });
    assert.equal(putB.status, 200, JSON.stringify(putB.body));
    assert.equal(bodyOf(putB).connector_instance_id, homeB.connector_instance_id);
    assert.equal(stateOf(putB).sessions, "cursor-B-2026-05-31");

    // Reading each home back returns only that home's checkpoints — no bleed
    // across the shared connector type / shared stream keys.
    const readA = await getSourceInstanceState(asUrl, homeA);
    assert.equal(stateOf(readA).sessions, "cursor-A-2026-05-31");
    assert.equal(stateOf(readA).skills, "skills-cursor-A");
    const readB = await getSourceInstanceState(asUrl, homeB);
    assert.equal(stateOf(readB).sessions, "cursor-B-2026-05-31");
    assert.equal(stateOf(readB).skills, "skills-cursor-B");

    // Storage is namespaced by connector_instance_id, not connector_id: two
    // rows for the same (connector_id, stream) survive side by side.
    const sessionRows = typedDb()
      .prepare<[string, string], { connector_instance_id: string; state_json: string }>(
        `SELECT connector_instance_id, state_json
           FROM connector_state
          WHERE connector_id = ? AND stream = ?
          ORDER BY connector_instance_id`
      )
      .all("claude-code", "sessions");
    assert.equal(sessionRows.length, 2, "both source homes must persist their own sessions checkpoint");
    assert.deepEqual(
      new Map(sessionRows.map((row) => [row.connector_instance_id, JSON.parse(row.state_json)])),
      new Map([
        [homeA.connector_instance_id, "cursor-A-2026-05-31"],
        [homeB.connector_instance_id, "cursor-B-2026-05-31"],
      ]),
      "neither source home may overwrite the other's checkpoint"
    );

    // A device credential is scoped to its own device: home A's token cannot
    // read home B's source-instance state.
    const crossDevice = await getSourceInstanceState(asUrl, homeB, homeA.device_token);
    assert.equal(crossDevice.status, 403);
    assert.equal(errorCode(crossDevice), "permission_error");
  });
});

test("re-enrolling the same connector + local_binding_name resumes one stable connector_instance", async () => {
  // Regression: source_binding_key for local-device instances used to
  // include the per-enrollment device_id and source_instance_id, so a
  // second enroll for the same owner-chosen binding forked a brand new
  // connector_instances row instead of upserting/resuming the existing
  // one. The stable identity is (owner, connector, local_device,
  // local_binding_name).
  await withServer(async ({ asUrl }) => {
    const first = await enrollDevice(asUrl, "laptop-stable");
    const second = await enrollDevice(asUrl, "laptop-stable");
    assert.equal(
      second.connector_instance_id,
      first.connector_instance_id,
      "re-enrollment must resume the same connector_instance_id"
    );
    assert.notEqual(second.device_id, first.device_id, "each enroll still mints a fresh device_id");
    assert.notEqual(
      second.source_instance_id,
      first.source_instance_id,
      "each enroll still mints a fresh source_instance_id"
    );

    const activeRows = typedDb()
      .prepare<[string], { connector_instance_id: string; source_binding_json: string; status: string }>(
        `SELECT connector_instance_id, source_kind, status, source_binding_json
           FROM connector_instances
          WHERE connector_id = ? AND source_kind = 'local_device'`
      )
      .all("codex");
    assert.equal(activeRows.length, 1, "re-enrollment must not fork a second connector_instances row");
    const activeRow = mustExist(activeRows[0], "active connector instance row must exist");
    assert.equal(activeRow.connector_instance_id, first.connector_instance_id);
    assert.equal(activeRow.status, "active");
    // Debugging payload retains the most recent device/source identifiers
    // for inspection, even though they no longer participate in identity.
    const binding = JSON.parse(activeRow.source_binding_json);
    assert.equal(binding.kind, "local_device");
    assert.equal(binding.local_binding_name, "laptop-stable");
    assert.equal(binding.device_id, second.device_id);
    assert.equal(binding.source_instance_id, second.source_instance_id);

    // A re-enrollment with a different local_binding_name DOES fork a
    // separate connector_instance, as expected.
    const other = await enrollDevice(asUrl, "laptop-other");
    assert.notEqual(other.connector_instance_id, first.connector_instance_id);
    const distinctRows = getDb()
      .prepare(
        `SELECT connector_instance_id FROM connector_instances
          WHERE connector_id = ? AND source_kind = 'local_device'
          ORDER BY connector_instance_id`
      )
      .all("codex");
    assert.equal(distinctRows.length, 2);
  });
});

test("enrollment against an owner-deleted binding fails closed with a typed 409, never resurrects", async () => {
  // Live incident regression (fix-owner-delete-resurrection): an owner
  // DELETE on a device-collected connection removes the connector_instances
  // row, but source_binding_key for local_device is derived from
  // {kind, local_binding_name} only — independent of device_id/
  // source_instance_id. A later enroll for the SAME local_binding_name (a
  // genuinely new device pairing, e.g. after a reinstall) used to silently
  // materialize a fresh active row on the SAME connector_instance_id. This
  // proves enroll now fails closed instead.
  await withServer(async ({ asUrl }) => {
    const first = await enrollDevice(asUrl, "laptop-deleted");
    const ownerRow = selectRow<{ owner_subject_id: string }>(
      "SELECT owner_subject_id FROM connector_instances WHERE connector_instance_id = ?",
      first.connector_instance_id
    );

    const store = createSqliteConnectorInstanceStore();
    await store.deleteConnection(first.connector_instance_id, {
      now: new Date().toISOString(),
      ownerSubjectId: ownerRow.owner_subject_id,
      purge: {
        deleteRecordRejectionsPostgres: async () => 0,
        deleteRecordRejectionsSqlite: () => 0,
        deleteRecordRowsPostgres: async () => 0,
        deleteRecordRowsSqlite: (id: string) => deleteConnectionRecordRowsSqlite(id),
        enumerateStreams: async (target: { connector_id: string; connector_instance_id: string }) => {
          const result = await enumerateConnectionStreams(target);
          return {
            connectorId: mustExist(result.connectorId, "connectorId must exist"),
            connectorInstanceId: result.connectorInstanceId,
            streams: result.streams as string[],
          };
        },
        teardownProjection: (args: {
          connectorId: string;
          connectorInstanceId: string;
          streams: string[];
          deletedRecordCount: number;
        }) => teardownConnectionSearchProjection(args),
      },
    });
    assert.equal(
      getDb()
        .prepare("SELECT 1 x FROM connector_instances WHERE connector_instance_id = ?")
        .get(first.connector_instance_id),
      undefined,
      "row is gone after owner delete"
    );

    // Re-enroll under the SAME local_binding_name — a genuinely new device
    // pairing (fresh enrollment code, fresh device_id/source_instance_id
    // under the hood), targeting the tombstoned identity.
    const codeResp = await postJson(`${asUrl}/_ref/device-exporters/enrollment-codes`, {
      connector_id: "codex",
      local_binding_name: "laptop-deleted",
    });
    assert.equal(codeResp.status, 201);
    const enrollResp = await postJson(
      `${asUrl}/_ref/device-exporters/enroll`,
      { enrollment_code: bodyOf(codeResp).enrollment_code },
      PROTOCOL_HEADERS
    );
    assert.equal(enrollResp.status, 409, "enroll against a tombstoned identity is a typed 409, not a 201");
    assert.equal(errorCode(enrollResp), "connection_tombstoned");
    assert.ok(!JSON.stringify(enrollResp.body).includes("device_token"), "a failed enroll never leaks a device token");

    assert.equal(
      getDb()
        .prepare("SELECT 1 x FROM connector_instances WHERE connector_instance_id = ?")
        .get(first.connector_instance_id),
      undefined,
      "no row was resurrected by the rejected enroll attempt"
    );

    // A DIFFERENT local_binding_name for the same connector is unaffected
    // and enrolls normally.
    const distinct = await enrollDevice(asUrl, "laptop-deleted-v2");
    assert.notEqual(distinct.connector_instance_id, first.connector_instance_id);
  });
});

test("device exporter enrollment keeps connector type display names separate from device labels", async () => {
  await withServer(async ({ asUrl }) => {
    const codeResp = await postJson(`${asUrl}/_ref/device-exporters/enrollment-codes`, {
      connector_id: "claude_code",
      display_name: "simon@192.168.1.7 Claude Code",
      local_binding_name: "simon-laptop",
    });
    assert.equal(codeResp.status, 201);

    const enrollResp = await postJson(
      `${asUrl}/_ref/device-exporters/enroll`,
      {
        device_label: "simon@192.168.1.7 Claude Code",
        enrollment_code: bodyOf(codeResp).enrollment_code,
      },
      PROTOCOL_HEADERS
    );
    assert.equal(enrollResp.status, 201);

    // The owner may enroll with the legacy snake_case alias (`claude_code`),
    // but the catalog row, instance row, and storage key are canonicalized to
    // `claude-code` so the connector type has one identity. The enroll
    // response echoes the canonical key. See canonicalize-connector-keys
    // design Decision 7.
    assert.equal(bodyOf(enrollResp).connector_id, "claude-code");
    const legacyAliasRow = getDb().prepare("SELECT 1 FROM connectors WHERE connector_id = ?").get("claude_code");
    assert.equal(legacyAliasRow, undefined, "legacy alias MUST NOT be registered as a connector row");

    const connectorRow = mustExist(
      typedDb()
        .prepare<[string], { manifest: string }>("SELECT manifest FROM connectors WHERE connector_id = ?")
        .get("claude-code"),
      "connector row must exist"
    );
    const connectorManifest: ConnectorManifest = JSON.parse(connectorRow.manifest);
    assert.equal(connectorManifest.connector_id, "claude-code");
    assert.equal(connectorManifest.display_name, "Claude Code");
    assert.ok(connectorManifest.streams.some((stream) => stream.name === "sessions"));

    const instanceRow = mustExist(
      typedDb()
        .prepare<[string], { display_name: string }>(
          "SELECT display_name FROM connector_instances WHERE connector_instance_id = ?"
        )
        .get(stringField(bodyOf(enrollResp), "connector_instance_id")),
      "instance row must exist"
    );
    assert.equal(instanceRow.display_name, "simon@192.168.1.7 Claude Code");
  });
});

test("enroll rejects missing collector protocol header with 409 collector_protocol_mismatch and persists nothing", async () => {
  await withServer(async ({ asUrl }) => {
    const codeResp = await postJson(`${asUrl}/_ref/device-exporters/enrollment-codes`, {
      connector_id: "codex",
      local_binding_name: "laptop-c",
    });
    assert.equal(codeResp.status, 201);

    // No X-PDPP-Collector-Protocol header — must fail before any device row
    // is created.
    const enrollResp = await postJson(`${asUrl}/_ref/device-exporters/enroll`, {
      enrollment_code: bodyOf(codeResp).enrollment_code,
    });
    assert.equal(enrollResp.status, 409);
    assert.equal(errorCode(enrollResp), "collector_protocol_mismatch");
    assert.ok(Array.isArray(errorOf(enrollResp).accepted_versions));
    assert.ok((errorOf(enrollResp).accepted_versions as unknown[]).length > 0);
    assert.equal(errorOf(enrollResp).received_version, null);

    // The enrollment code should still be pending — the rejected enroll
    // must not have consumed it.
    const retry = await postJson(
      `${asUrl}/_ref/device-exporters/enroll`,
      { enrollment_code: bodyOf(codeResp).enrollment_code },
      PROTOCOL_HEADERS
    );
    assert.equal(retry.status, 201);

    // And no devices should exist beyond the one we just enrolled — the
    // earlier mismatch must not have leaked a device row.
    const rows = selectRow<{ n: number }>("SELECT COUNT(*) as n FROM device_exporters");
    assert.equal(rows.n, 1);
  });
});

test("enroll persists collector_protocol_version on the device row", async () => {
  await withServer(async ({ asUrl }) => {
    const codeResp = await postJson(`${asUrl}/_ref/device-exporters/enrollment-codes`, {
      connector_id: "codex",
      local_binding_name: "laptop-d",
    });
    assert.equal(codeResp.status, 201);
    const enrollResp = await postJson(
      `${asUrl}/_ref/device-exporters/enroll`,
      { enrollment_code: bodyOf(codeResp).enrollment_code },
      PROTOCOL_HEADERS
    );
    assert.equal(enrollResp.status, 201);

    const row = selectRow<{ collector_protocol_version: string }>(
      "SELECT collector_protocol_version FROM device_exporters WHERE device_id = ?",
      bodyOf(enrollResp).device_id
    );
    assert.equal(row.collector_protocol_version, COLLECTOR_PROTOCOL_VERSION);
  });
});

function postLocalCollectorGap(
  asUrl: string,
  device: EnrolledDevice,
  body: unknown,
  tokenOverride?: string
): Promise<JsonResponse> {
  return postJson(
    `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/source-instances/${encodeURIComponent(device.source_instance_id)}/local-collector-gaps`,
    body,
    authHeaders(tokenOverride ?? device.device_token)
  );
}

function postLocalCollectorGapRecovered(
  asUrl: string,
  device: EnrolledDevice,
  body: unknown,
  tokenOverride?: string
): Promise<JsonResponse> {
  return postJson(
    `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/source-instances/${encodeURIComponent(device.source_instance_id)}/local-collector-gaps/recovered`,
    body,
    authHeaders(tokenOverride ?? device.device_token)
  );
}

function localCollectorGapBody(
  device: EnrolledDevice,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    connector_id: device.connector_id,
    first_seen_at: "2026-05-19T12:00:00.000Z",
    first_seen_run_id: "run-1",
    last_run_id: "run-1",
    next_attempt_backoff_ms: 900_000,
    reason: "policy_budget",
    retryable: true,
    source_instance_id: device.source_instance_id,
    ...overrides,
  };
}

test("local-collector-gaps route authorizes device, derives connector binding, and idempotently upserts", async () => {
  await withServer(async ({ asUrl }) => {
    const first = await enrollDevice(asUrl, "laptop-gap-1");
    const second = await enrollDevice(asUrl, "laptop-gap-2");

    // Missing auth.
    const missingAuth = await postJson(
      `${asUrl}/_ref/device-exporters/${encodeURIComponent(first.device_id)}/source-instances/${encodeURIComponent(first.source_instance_id)}/local-collector-gaps`,
      localCollectorGapBody(first),
      PROTOCOL_HEADERS
    );
    assert.equal(missingAuth.status, 401);

    // Token belonging to a different device.
    const wrongToken = await postLocalCollectorGap(asUrl, first, localCollectorGapBody(first), second.device_token);
    assert.equal(wrongToken.status, 403);

    // Connector id mismatch.
    const mismatch = await postLocalCollectorGap(
      asUrl,
      first,
      localCollectorGapBody(first, { connector_id: "not-codex" })
    );
    assert.equal(mismatch.status, 400);
    assert.equal(errorCode(mismatch), "invalid_request");

    // Source instance mismatch between body and path.
    const sourceMismatch = await postLocalCollectorGap(
      asUrl,
      first,
      localCollectorGapBody(first, { source_instance_id: second.source_instance_id })
    );
    assert.equal(sourceMismatch.status, 400);

    // Happy path.
    const ack = await postLocalCollectorGap(
      asUrl,
      first,
      localCollectorGapBody(first, {
        details: "child failed token=super-secret-value otp=123456 opaque=abcdefghijklmnopqrstuvwxyz123456",
        stream: "messages",
      })
    );
    assert.equal(ack.status, 201, JSON.stringify(ack.body));
    assert.equal(bodyOf(ack).object, "device_local_collector_gap");
    assert.equal(bodyOf(ack).connector_id, first.connector_id);
    assert.equal(bodyOf(ack).connector_instance_id, first.connector_instance_id);
    assert.equal(bodyOf(ack).source_instance_id, first.source_instance_id);
    assert.equal(bodyOf(ack).reason, "policy_budget");
    assert.equal(bodyOf(ack).retryable, true);
    assert.equal(bodyOf(ack).stream, "local-collector/policy_budget/messages");
    assert.equal(bodyOf(ack).status, "pending");
    assert.equal(bodyOf(ack).first_seen_run_id, "run-1");
    assert.equal(bodyOf(ack).last_run_id, "run-1");
    const firstGapId = stringField(bodyOf(ack), "gap_id");

    // Idempotent replay with current run.
    const ackReplay = await postLocalCollectorGap(
      asUrl,
      first,
      localCollectorGapBody(first, {
        details: "child failed token=super-secret-value otp=123456 opaque=abcdefghijklmnopqrstuvwxyz123456",
        last_run_id: "run-2",
        stream: "messages",
      })
    );
    assert.equal(ackReplay.status, 201);
    assert.equal(bodyOf(ackReplay).gap_id, firstGapId);
    assert.equal(bodyOf(ackReplay).last_run_id, "run-2");

    // Verify storage has exactly one row (idempotent) and is scoped to
    // the authorized connector instance.
    const dbRows = typedDb()
      .prepare<
        [string],
        {
          connector_id: string;
          connector_instance_id: string;
          detail_locator_json: string;
          last_error_json: string;
          reason: string;
          source_json: string;
          status: string;
          stream: string;
        }
      >(
        `SELECT gap_id, connector_id, connector_instance_id, stream, reason, status, source_json, detail_locator_json, last_error_json
           FROM connector_detail_gaps
          WHERE gap_id = ?`
      )
      .all(firstGapId);
    assert.equal(dbRows.length, 1);
    const dbRow = mustExist(dbRows[0], "local collector gap row must exist");
    assert.equal(dbRow.connector_id, first.connector_id);
    assert.equal(dbRow.connector_instance_id, first.connector_instance_id);
    assert.equal(dbRow.reason, "policy_budget");
    assert.equal(dbRow.stream, "local-collector/policy_budget/messages");
    assert.equal(dbRow.status, "pending");
    const source = JSON.parse(dbRow.source_json);
    assert.equal(source.kind, "local_device");
    assert.equal(source.device_id, first.device_id);
    assert.equal(source.source_instance_id, first.source_instance_id);
    const persistedDiagnostics = JSON.stringify({
      detail_locator: JSON.parse(dbRow.detail_locator_json),
      last_error: JSON.parse(dbRow.last_error_json),
    });
    assert.equal(persistedDiagnostics.includes("super-secret-value"), false);
    assert.equal(persistedDiagnostics.includes("123456"), false);
    assert.equal(persistedDiagnostics.includes("abcdefghijklmnopqrstuvwxyz123456"), false);
    assert.ok(persistedDiagnostics.includes("[REDACTED"));

    const recovered = await postLocalCollectorGapRecovered(asUrl, first, {
      connector_id: first.connector_id,
      reason: "policy_budget",
      recovered_run_id: "run-3",
      source_instance_id: first.source_instance_id,
      stream: "messages",
    });
    assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
    assert.equal(bodyOf(recovered).gap_id, firstGapId);
    assert.equal(bodyOf(recovered).status, "recovered");
    assert.equal(bodyOf(recovered).last_run_id, "run-3");
    const recoveredRow = selectRow<{ recovered_run_id: string; status: string }>(
      "SELECT status, recovered_run_id FROM connector_detail_gaps WHERE gap_id = ?",
      firstGapId
    );
    assert.equal(recoveredRow.status, "recovered");
    assert.equal(recoveredRow.recovered_run_id, "run-3");

    // A second device cannot observe or upsert into the first device's gap.
    const crossDevice = await postLocalCollectorGap(
      asUrl,
      second,
      localCollectorGapBody(first, { stream: "messages" })
    );
    assert.equal(crossDevice.status, 400);
    assert.equal(errorCode(crossDevice), "invalid_request");

    // Invalid reason rejected with 400.
    const badReason = await postLocalCollectorGap(asUrl, first, localCollectorGapBody(first, { reason: "nope" }));
    assert.equal(badReason.status, 400);

    // Missing retryable rejected.
    const missingRetryable = await postLocalCollectorGap(asUrl, first, {
      ...localCollectorGapBody(first),
      retryable: "truthy",
    });
    assert.equal(missingRetryable.status, 400);
  });
});

test("local-collector-gaps route rejects unaccepted collector protocol version", async () => {
  await withServer(async ({ asUrl }) => {
    const device = await enrollDevice(asUrl, "laptop-gap-proto");
    const reject = await postJson(
      `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/source-instances/${encodeURIComponent(device.source_instance_id)}/local-collector-gaps`,
      localCollectorGapBody(device),
      { Authorization: `Bearer ${device.device_token}`, "X-PDPP-Collector-Protocol": "999" }
    );
    assert.equal(reject.status, 409);
    assert.equal(errorCode(reject), "collector_protocol_mismatch");
  });
});

test("healthy drained heartbeat recovers stale local policy-budget gaps for the same connector instance", async () => {
  await withServer(async ({ asUrl }) => {
    const first = await enrollDevice(asUrl, "laptop-gap-drain-1");
    const second = await enrollDevice(asUrl, "laptop-gap-drain-2");

    const parentGap = await postLocalCollectorGap(asUrl, first, localCollectorGapBody(first));
    assert.equal(parentGap.status, 201, JSON.stringify(parentGap.body));
    assert.equal(bodyOf(parentGap).stream, "local-collector/policy_budget");

    const childGap = await postLocalCollectorGap(asUrl, first, localCollectorGapBody(first, { stream: "messages" }));
    assert.equal(childGap.status, 201, JSON.stringify(childGap.body));
    assert.equal(bodyOf(childGap).stream, "local-collector/policy_budget/messages");

    const childFailure = await postLocalCollectorGap(
      asUrl,
      first,
      localCollectorGapBody(first, { reason: "connector_child_failure", stream: "messages" })
    );
    assert.equal(childFailure.status, 201, JSON.stringify(childFailure.body));

    const otherDeviceGap = await postLocalCollectorGap(asUrl, second, localCollectorGapBody(second));
    assert.equal(otherDeviceGap.status, 201, JSON.stringify(otherDeviceGap.body));

    const heartbeat = await postJson(
      `${asUrl}/_ref/device-exporters/${encodeURIComponent(first.device_id)}/heartbeat`,
      {
        source_instances: [
          {
            outbox: {
              backlog_open: 0,
              dead_letter: 0,
              leased: 0,
              pending: 0,
              retrying: 0,
              stale_leases: 0,
              succeeded: 10,
              total: 10,
            },
            records_pending: 0,
            source_instance_id: first.source_instance_id,
            status: "healthy",
          },
        ],
      },
      authHeaders(first.device_token)
    );
    assert.equal(heartbeat.status, 200, JSON.stringify(heartbeat.body));

    const rows = typedDb()
      .prepare<[unknown, unknown, unknown, unknown], { gap_id: string; status: string }>(
        `SELECT gap_id, status
           FROM connector_detail_gaps
          WHERE gap_id IN (?, ?, ?, ?)
          ORDER BY gap_id`
      )
      .all(
        stringField(bodyOf(parentGap), "gap_id"),
        stringField(bodyOf(childGap), "gap_id"),
        stringField(bodyOf(childFailure), "gap_id"),
        stringField(bodyOf(otherDeviceGap), "gap_id")
      );
    const statusByGap = new Map(rows.map((row) => [row.gap_id, row.status]));
    assert.equal(statusByGap.get(stringField(bodyOf(parentGap), "gap_id")), "recovered");
    assert.equal(statusByGap.get(stringField(bodyOf(childGap), "gap_id")), "recovered");
    assert.equal(statusByGap.get(stringField(bodyOf(childFailure), "gap_id")), "pending");
    assert.equal(statusByGap.get(stringField(bodyOf(otherDeviceGap), "gap_id")), "pending");
  });
});

test("device-exporter diagnostics scope heartbeat, ingest, and local-collector gaps to the source instance", async () => {
  await withServer(async ({ asUrl }) => {
    const first = await enrollDevice(asUrl, "laptop-diag-1");
    const second = await enrollDevice(asUrl, "laptop-diag-2");

    // First device reports a healthy heartbeat with a small backlog; the
    // second device reports a blocked heartbeat. Per-source heartbeat
    // state must not bleed across instances even though they share the
    // `codex` connector type.
    const firstHeartbeat = await postJson(
      `${asUrl}/_ref/device-exporters/${encodeURIComponent(first.device_id)}/heartbeat`,
      {
        connector_id: "codex",
        last_error: {
          cookie: "session-cookie",
          message: "top-level token=top-secret-token otp=654321 path=/home/user owner/.codex/auth.json",
        },
        records_pending: 3,
        source_instance_id: first.source_instance_id,
        source_instances: [
          {
            last_error: {
              message:
                "source token=source-secret path=/Users/user owner/.claude.json opaque=abcdefghijklmnopqrstuvwxyz123456",
              nested: { api_key: "raw-api-key" },
            },
            outbox: {
              backlog_open: 1,
              dead_letter: 0,
              leased: 0,
              oldest_pending_at: "2026-05-19T12:00:00.000Z",
              pending: 2,
              retrying: 1,
              secret_path: "/home/user owner/.codex/auth.json",
              stale_leases: 0,
              succeeded: 4,
              token: "raw-outbox-token",
              total: 7,
            },
            records_pending: 3,
            source_instance_id: first.source_instance_id,
            status: "healthy",
          },
        ],
        status: "healthy",
      },
      authHeaders(first.device_token)
    );
    assert.equal(firstHeartbeat.status, 200);

    const secondHeartbeat = await postJson(
      `${asUrl}/_ref/device-exporters/${encodeURIComponent(second.device_id)}/heartbeat`,
      {
        connector_id: "codex",
        outbox: {
          cookie: "raw-cookie",
          dead_letter: 1,
          oldest_pending_at: "not-a-date",
          pending: 9,
          retrying: 2,
          stale_leases: 3,
          total: 15,
        },
        records_pending: 17,
        source_instance_id: second.source_instance_id,
        status: "blocked",
      },
      authHeaders(second.device_token)
    );
    assert.equal(secondHeartbeat.status, 200);

    // Only the first device ingests a batch; the second has none. The
    // diagnostics projection must show the ingest count under the right
    // source instance, not against the connector type.
    const ingestFirst = await postJson(
      `${asUrl}/_ref/device-exporters/${encodeURIComponent(first.device_id)}/ingest-batches`,
      makeBatch(first, "diag-batch-1", "first-only"),
      authHeaders(first.device_token)
    );
    assert.equal(ingestFirst.status, 201);

    // The first device also ingests coverage diagnostics. The records carry
    // a `reason` with a planted path+secret; the projection must surface
    // only the safe store/stream/status triple and never the reason text.
    const coverageBatch = {
      batch_id: "diag-coverage-1",
      batch_seq: 2,
      body_hash: "hash-diag-coverage-1",
      connector_id: first.connector_id,
      device_id: first.device_id,
      records: [
        {
          data: {
            id: "sessions:collected",
            reason: "declared stream at /home/user owner/.codex/sessions token=coverage-secret",
            status: "collected",
            store: "sessions",
            stream: "sessions",
          },
          emitted_at: "2026-05-20T12:00:00.000Z",
          record_key: "sessions:collected",
          stream: "coverage_diagnostics",
        },
        {
          data: {
            id: "auth:excluded",
            reason: "auth-adjacent /home/user owner/.codex/auth.json",
            status: "excluded",
            store: "auth",
            stream: null,
          },
          emitted_at: "2026-05-20T12:00:00.000Z",
          record_key: "auth:excluded",
          stream: "coverage_diagnostics",
        },
        {
          data: {
            id: "logs:deferred",
            reason: "redaction pending",
            status: "deferred",
            store: "logs",
            stream: "logs",
          },
          emitted_at: "2026-05-20T12:00:00.000Z",
          record_key: "logs:deferred",
          stream: "coverage_diagnostics",
        },
      ],
      source_instance_id: first.source_instance_id,
    };
    coverageBatch.body_hash = bodyHash(coverageBatch.records);
    const ingestCoverage = await postJson(
      `${asUrl}/_ref/device-exporters/${encodeURIComponent(first.device_id)}/ingest-batches`,
      coverageBatch,
      authHeaders(first.device_token)
    );
    assert.equal(ingestCoverage.status, 201, JSON.stringify(ingestCoverage.body));

    // Only the second device reports a local-collector gap. The first
    // device must show zero pending local-collector gaps even though
    // both devices share the `codex` connector type.
    const gapSecond = await postLocalCollectorGap(
      asUrl,
      second,
      localCollectorGapBody(second, {
        stream: "messages",
      })
    );
    assert.equal(gapSecond.status, 201, JSON.stringify(gapSecond.body));

    const diagnosticsResp = await fetch(`${asUrl}/_ref/device-exporters/diagnostics`, {
      headers: { Accept: "application/json" },
    });
    assert.equal(diagnosticsResp.status, 200);
    const diagnostics = (await diagnosticsResp.json()) as DiagnosticsPayload;

    const firstDevice = diagnostics.data.find((device) => device.device_id === first.device_id);
    const secondDevice = diagnostics.data.find((device) => device.device_id === second.device_id);
    assert.ok(firstDevice && secondDevice);

    const firstSource = mustExist(
      mustExist(firstDevice, "first device diagnostics must exist").source_instances.find(
        (source) => source.source_instance_id === first.source_instance_id
      ),
      "first source diagnostics must exist"
    );
    const secondSource = mustExist(
      mustExist(secondDevice, "second device diagnostics must exist").source_instances.find(
        (source) => source.source_instance_id === second.source_instance_id
      ),
      "second source diagnostics must exist"
    );

    // Identity is preserved.
    assert.equal(firstSource.connector_id, "codex");
    assert.equal(firstSource.connector_instance_id, first.connector_instance_id);
    assert.equal(firstSource.device_id, first.device_id);
    assert.equal(firstSource.local_binding_name, "laptop-diag-1");
    assert.equal(secondSource.connector_id, "codex");
    assert.equal(secondSource.connector_instance_id, second.connector_instance_id);
    assert.equal(secondSource.device_id, second.device_id);
    assert.equal(secondSource.local_binding_name, "laptop-diag-2");
    assert.notEqual(firstSource.connector_instance_id, secondSource.connector_instance_id);

    // Heartbeat status / backlog scoped per source instance.
    assert.equal(firstSource.last_heartbeat_status, "healthy");
    assert.equal(firstSource.records_pending, 3);
    assert.equal(firstSource.outbox_state, "retrying");
    assert.deepEqual(firstSource.outbox_diagnostics, {
      backlog_open: 1,
      dead_letter: 0,
      leased: 0,
      oldest_pending_at: "2026-05-19T12:00:00.000Z",
      pending: 2,
      retrying: 1,
      stale_leases: 0,
      succeeded: 4,
      total: 7,
    });
    assert.equal(secondSource.last_heartbeat_status, "blocked");
    assert.equal(secondSource.records_pending, 17);
    assert.equal(secondSource.outbox_state, "dead_letter");
    assert.equal(secondSource.outbox_diagnostics.dead_letter, 1);
    assert.equal(secondSource.outbox_diagnostics.oldest_pending_at, undefined);
    const diagnosticsJson = JSON.stringify(diagnostics);
    assert.equal(diagnosticsJson.includes("top-secret-token"), false);
    assert.equal(diagnosticsJson.includes("source-secret"), false);
    assert.equal(diagnosticsJson.includes("session-cookie"), false);
    assert.equal(diagnosticsJson.includes("raw-api-key"), false);
    assert.equal(diagnosticsJson.includes("raw-cookie"), false);
    assert.equal(diagnosticsJson.includes("raw-outbox-token"), false);
    assert.equal(diagnosticsJson.includes("654321"), false);
    assert.equal(diagnosticsJson.includes("/home/user owner"), false);
    assert.equal(diagnosticsJson.includes("/Users/user owner"), false);
    assert.ok(diagnosticsJson.includes("[REDACTED"));

    // Ingest counts scoped per source instance: 1 message record plus 3
    // coverage-diagnostic records across two batches.
    assert.equal(firstSource.accepted_record_count, 4);
    assert.ok(firstSource.last_ingest_at);
    assert.equal(secondSource.accepted_record_count, 0);
    assert.equal(secondSource.last_ingest_at, null);

    const scopedSourcesResp = await fetch(
      `${asUrl}/_ref/device-exporters/source-instances?connector_instance_id=${encodeURIComponent(first.connector_instance_id)}`,
      { headers: { Accept: "application/json" } }
    );
    assert.equal(scopedSourcesResp.status, 200);
    const scopedSources = (await scopedSourcesResp.json()) as { data: DiagnosticsSourceInstance[] };
    assert.deepEqual(
      scopedSources.data.map((source) => source.connector_instance_id),
      [first.connector_instance_id]
    );

    // Local-collector gap counts scoped per source instance.
    assert.equal(firstSource.local_collector_gaps.pending_count, 0);
    assert.deepEqual(firstSource.local_collector_gaps.reasons, []);
    assert.equal(firstSource.local_collector_gaps.unreliable, false);
    assert.equal(secondSource.local_collector_gaps.pending_count, 1);
    assert.deepEqual(secondSource.local_collector_gaps.reasons, ["policy_budget"]);
    assert.equal(secondSource.local_collector_gaps.unreliable, false);
    assert.ok(secondSource.local_collector_gaps.last_updated_at);

    // Local-collector coverage (Section 5.3) surfaces per source instance,
    // scoped to the connector instance, with only safe store/stream/status.
    assert.ok(firstSource.local_collector_coverage);
    assert.equal(firstSource.local_collector_coverage.observed, true);
    assert.equal(firstSource.local_collector_coverage.store_count, 3);
    assert.equal(firstSource.local_collector_coverage.fully_accounted, true);
    assert.deepEqual(firstSource.local_collector_coverage.unaccounted_stores, []);
    assert.equal(firstSource.local_collector_coverage.counts_by_status.collected, 1);
    assert.equal(firstSource.local_collector_coverage.counts_by_status.excluded, 1);
    assert.equal(firstSource.local_collector_coverage.counts_by_status.deferred, 1);
    assert.equal(firstSource.local_collector_coverage.by_store.auth, "excluded");
    assert.equal(firstSource.local_collector_coverage.by_store.logs, "deferred");
    // The second device requested no coverage; absence reads as absence.
    const secondCoverage = mustExist(secondSource.local_collector_coverage, "second source coverage must exist");
    assert.equal(secondCoverage.observed, false);
    assert.equal(secondCoverage.store_count, 0);
    assert.equal(secondCoverage.fully_accounted, false);
    // The coverage `reason` free-text (with its planted path/secret) must
    // never reach the diagnostics surface.
    assert.equal(diagnosticsJson.includes("coverage-secret"), false);
    assert.equal(diagnosticsJson.includes("redaction pending"), false);
    assert.equal(diagnosticsJson.includes(".codex/sessions"), false);
    assert.equal(diagnosticsJson.includes(".codex/auth.json"), false);

    // Recovering the second device's gap clears its per-source backlog
    // without disturbing the first device.
    const recovered = await postLocalCollectorGapRecovered(asUrl, second, {
      connector_id: "codex",
      reason: "policy_budget",
      recovered_run_id: "run-diag-recovery",
      source_instance_id: second.source_instance_id,
      stream: "messages",
    });
    assert.equal(recovered.status, 200, JSON.stringify(recovered.body));

    const refreshed = await fetch(`${asUrl}/_ref/device-exporters/diagnostics`, {
      headers: { Accept: "application/json" },
    });
    const refreshedJson = (await refreshed.json()) as DiagnosticsPayload;
    const refreshedFirst = mustExist(
      mustExist(
        refreshedJson.data.find((device) => device.device_id === first.device_id),
        "refreshed first device must exist"
      ).source_instances.find((source) => source.source_instance_id === first.source_instance_id),
      "refreshed first source must exist"
    );
    const refreshedSecond = mustExist(
      mustExist(
        refreshedJson.data.find((device) => device.device_id === second.device_id),
        "refreshed second device must exist"
      ).source_instances.find((source) => source.source_instance_id === second.source_instance_id),
      "refreshed second source must exist"
    );
    assert.equal(refreshedFirst.local_collector_gaps.pending_count, 0);
    assert.equal(refreshedSecond.local_collector_gaps.pending_count, 0);
  });
});

test("ingest rejects unaccepted collector protocol version with 409 before any record persists", async () => {
  await withServer(async ({ asUrl }) => {
    const device = await enrollDevice(asUrl, "laptop-e");
    const batch = makeBatch(device, "batch-mismatch", "will-not-persist");
    const reject = await postJson(
      `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
      batch,
      { Authorization: `Bearer ${device.device_token}`, "X-PDPP-Collector-Protocol": "999" }
    );
    assert.equal(reject.status, 409);
    assert.equal(errorCode(reject), "collector_protocol_mismatch");
    assert.equal(errorOf(reject).received_version, "999");

    const outcomes = selectRow<{ n: number }>(
      "SELECT COUNT(*) as n FROM device_ingest_batch_outcomes WHERE device_id = ?",
      device.device_id
    );
    assert.equal(outcomes.n, 0);
    const recordRows = selectRow<{ n: number }>(
      "SELECT COUNT(*) as n FROM records WHERE connector_id = ?",
      internalStorageConnectorId("codex")
    );
    assert.equal(recordRows.n, 0);
  });
});

// ─── Binding-aware enrollment (add-browser-collector-enrollment-primitive) ────
// The enroll/enrollment-code routes derive the connector-instance source kind
// from the connector manifest bindings rather than hardcoding `local_device`:
//   filesystem -> local_device, browser -> browser_collector, contradiction or
// no-resolvable-binding -> typed 400 reject. See design Decision 2.

async function registerAmazonConnector(asUrl: string): Promise<void> {
  const fs = await import("node:fs");
  const manifest = JSON.parse(
    fs.readFileSync(new URL("../../packages/polyfill-connectors/manifests/amazon.json", import.meta.url), "utf8")
  );
  const resp = await fetch(`${asUrl}/connectors`, {
    body: JSON.stringify(manifest),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.ok(resp.status < 500, `register amazon: ${resp.status}`);
}

test("enrollment derives local_device for a filesystem connector", async () => {
  await withServer(async ({ asUrl }) => {
    const device = await enrollDevice(asUrl, "laptop-fs", "codex");
    const row = selectRow<{ source_binding_json: string; source_kind: string }>(
      "SELECT source_kind, source_binding_json FROM connector_instances WHERE connector_instance_id = ?",
      device.connector_instance_id
    );
    assert.equal(row.source_kind, "local_device");
    assert.equal(JSON.parse(row.source_binding_json).kind, "local_device");
  });
});

test("enrollment derives browser_collector for a browser-bound connector and never local_device", async () => {
  await withServer(async ({ asUrl }) => {
    await registerAmazonConnector(asUrl);

    const codeResp = await postJson(`${asUrl}/_ref/device-exporters/enrollment-codes`, {
      connector_id: "amazon",
      local_binding_name: "the owner-personal-amazon",
    });
    assert.equal(codeResp.status, 201, JSON.stringify(codeResp.body));

    const enrollResp = await postJson(
      `${asUrl}/_ref/device-exporters/enroll`,
      { enrollment_code: bodyOf(codeResp).enrollment_code },
      PROTOCOL_HEADERS
    );
    assert.equal(enrollResp.status, 201, JSON.stringify(enrollResp.body));
    assert.equal(bodyOf(enrollResp).connector_id, "amazon");

    const row = selectRow<{ source_binding_json: string; source_kind: string }>(
      "SELECT source_kind, source_binding_json FROM connector_instances WHERE connector_instance_id = ?",
      bodyOf(enrollResp).connector_instance_id
    );
    assert.equal(row.source_kind, "browser_collector", "browser-bound connector must enroll as browser_collector");
    assert.notEqual(row.source_kind, "local_device");
    assert.equal(JSON.parse(row.source_binding_json).kind, "browser_collector");
  });
});

test("a second Amazon account enrolls as a distinct browser_collector instance", async () => {
  // Multi-account is correct by construction: each browser_collector binding
  // resolves to its own connector_instance_id under the same connector_id.
  await withServer(async ({ asUrl }) => {
    await registerAmazonConnector(asUrl);

    const enrollOne = async (binding: string) => {
      const code = await postJson(`${asUrl}/_ref/device-exporters/enrollment-codes`, {
        connector_id: "amazon",
        local_binding_name: binding,
      });
      assert.equal(code.status, 201, JSON.stringify(code.body));
      const enroll = await postJson(
        `${asUrl}/_ref/device-exporters/enroll`,
        { enrollment_code: bodyOf(code).enrollment_code },
        PROTOCOL_HEADERS
      );
      assert.equal(enroll.status, 201, JSON.stringify(enroll.body));
      return bodyOf(enroll);
    };

    const personal = await enrollOne("the owner-personal-amazon");
    const shared = await enrollOne("shared-amazon");
    assert.equal(personal.connector_id, "amazon");
    assert.equal(shared.connector_id, "amazon");
    assert.notEqual(personal.connector_instance_id, shared.connector_instance_id);

    const rows = getDb()
      .prepare(
        `SELECT connector_instance_id, source_kind FROM connector_instances
          WHERE connector_id = 'amazon' AND source_kind = 'browser_collector'
          ORDER BY connector_instance_id`
      )
      .all();
    assert.equal(rows.length, 2);
  });
});

test("a source_kind that contradicts the manifest is rejected with a typed 400 and persists nothing", async () => {
  await withServer(async ({ asUrl }) => {
    await registerAmazonConnector(asUrl);

    // amazon is browser-bound; asking to enroll it as local_device contradicts
    // the manifest and must be rejected before any code is minted.
    const reject = await postJson(`${asUrl}/_ref/device-exporters/enrollment-codes`, {
      connector_id: "amazon",
      local_binding_name: "amazon-wrong-kind",
      source_kind: "local_device",
    });
    assert.equal(reject.status, 400, JSON.stringify(reject.body));
    assert.equal(errorCode(reject), "invalid_request");

    // No enrollment code row was minted for the contradicting request.
    const codes = selectRow<{ n: number }>(
      "SELECT COUNT(*) AS n FROM device_enrollment_codes WHERE connector_id = 'amazon'"
    );
    assert.equal(codes.n, 0, "a contradicting request must not mint an enrollment code");
  });
});

test("a connector with no resolvable binding is rejected with a typed 400, never defaulted", async () => {
  await withServer(async ({ asUrl }) => {
    // No manifest registered for this connector_id at all → no resolvable
    // binding → typed reject, never a defaulted source kind.
    const reject = await postJson(`${asUrl}/_ref/device-exporters/enrollment-codes`, {
      connector_id: "totally-unregistered-connector",
      local_binding_name: "nope",
    });
    assert.equal(reject.status, 400, JSON.stringify(reject.body));
    assert.equal(errorCode(reject), "invalid_request");

    const instances = selectRow<{ n: number }>(
      "SELECT COUNT(*) AS n FROM connector_instances WHERE connector_id = 'totally-unregistered-connector'"
    );
    assert.equal(instances.n, 0);
  });
});

// Directly overwrite the stored heartbeat timestamp so the staleness badge can
// be exercised against a controlled age without sleeping. The heartbeat route
// always stamps `received_at = now`, so the only way to age a heartbeat in a
// test is to write the column.
function setDeviceLastHeartbeatAt(deviceId: string, isoTimestamp: string): void {
  const result = typedDb()
    .prepare("UPDATE device_exporters SET last_heartbeat_at = ? WHERE device_id = ?")
    .run(isoTimestamp, deviceId);
  assert.equal(result.changes, 1, `expected to age heartbeat for device ${deviceId}`);
}

interface DiagnosticsSourceInstance extends Row {
  accepted_record_count: number;
  connector_id: string;
  connector_instance_id: string;
  device_id: string;
  heartbeat_age_ms: number | null;
  heartbeat_health: string;
  heartbeat_lease_ms: number;
  last_heartbeat_at: string | null;
  last_heartbeat_status: string | null;
  last_ingest_at: string | null;
  local_binding_name: string;
  local_collector_coverage: {
    observed: boolean;
    store_count: number;
    fully_accounted: boolean;
    unaccounted_stores: string[];
    counts_by_status: Record<string, number>;
    by_store: Record<string, string>;
  } | null;
  local_collector_gaps: {
    pending_count: number;
    reasons: string[];
    unreliable: boolean;
    last_updated_at?: string | null;
  };
  outbox_diagnostics: Record<string, unknown>;
  outbox_state: string | null;
  records_pending: number;
  rejected_record_count: number;
  source_instance_id: string;
}

interface DiagnosticsDeviceRow extends Row {
  agent_version: string | null;
  device_id: string;
  last_heartbeat_at: string | null;
  source_instances: DiagnosticsSourceInstance[];
  stale: boolean;
}

interface DiagnosticsPayload {
  data: DiagnosticsDeviceRow[];
}

async function diagnosticsForDevice(asUrl: string, deviceId: string): Promise<DiagnosticsDeviceRow> {
  const resp = await fetch(`${asUrl}/_ref/device-exporters/diagnostics`, {
    headers: { Accept: "application/json" },
  });
  assert.equal(resp.status, 200);
  const body = (await resp.json()) as DiagnosticsPayload;
  const device = body.data.find((d) => d.device_id === deviceId);
  assert.ok(device, `expected diagnostics to include device ${deviceId}`);
  return device;
}

test("device staleness badge follows the connector refresh policy, not a fixed 5-minute window", async () => {
  await withServer(async ({ asUrl }) => {
    // The codex catalog manifest declares
    // capabilities.refresh_policy.maximum_staleness_seconds = 21600 (6h).
    const device = await enrollDevice(asUrl, "codex-laptop", "codex");

    // A heartbeat establishes an active source instance for the device. The
    // connector_id on the projected source instance is what selects the policy.
    const heartbeat = await postJson(
      `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/heartbeat`,
      {
        connector_id: "codex",
        records_pending: 0,
        source_instance_id: device.source_instance_id,
        status: "healthy",
      },
      authHeaders(device.device_token)
    );
    assert.equal(heartbeat.status, 200);

    // 10 minutes old: well past the legacy hard-coded 5-minute window, but far
    // inside the connector's 6-hour policy. The policy-aware badge must NOT
    // flag this device as stale. (Under the old fixed window this was `true`,
    // which is exactly the admin-badge bug being fixed.)
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    setDeviceLastHeartbeatAt(device.device_id, tenMinutesAgo);
    const fresh = await diagnosticsForDevice(asUrl, device.device_id);
    assert.equal(fresh.last_heartbeat_at, tenMinutesAgo);
    assert.equal(fresh.stale, false, "a 10-minute-old heartbeat must not be stale under a 6-hour refresh policy");

    // 7 hours old: past the connector's 6-hour policy window. A genuinely
    // overdue collector must still be flagged stale.
    const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
    setDeviceLastHeartbeatAt(device.device_id, sevenHoursAgo);
    const overdue = await diagnosticsForDevice(asUrl, device.device_id);
    assert.equal(overdue.last_heartbeat_at, sevenHoursAgo);
    assert.equal(overdue.stale, true, "a heartbeat older than the policy window must remain stale");
  });
});

test("device staleness badge stays honestly non-stale when no refresh policy resolves", async () => {
  await withServer(async ({ asUrl }) => {
    // Enroll a codex device (the only enrollable path requires a manifest with
    // a resolvable binding), then point its source instance at a connector that
    // has no resolvable manifest at all. With no manifest — and therefore no
    // declared staleness window — the badge must report `unknown` freshness,
    // i.e. not stale, rather than re-inventing a hard-coded window.
    const device = await enrollDevice(asUrl, "no-policy-laptop", "codex");
    await postJson(
      `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/heartbeat`,
      {
        connector_id: "codex",
        records_pending: 0,
        source_instance_id: device.source_instance_id,
        status: "healthy",
      },
      authHeaders(device.device_token)
    );

    // Repoint the source instance at an unregistered connector id. The catalog
    // and registered-manifest lookups both return null for it, so the staleness
    // window resolves to null (unknown).
    const repointed = getDb()
      .prepare("UPDATE device_source_instances SET connector_id = ? WHERE source_instance_id = ?")
      .run("unregistered-policyless-connector", device.source_instance_id);
    assert.equal(repointed.changes, 1);

    // Heartbeat far older than any plausible default window. With no policy the
    // honest answer is not-stale (unknown), never a fixed-window stale.
    const longAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    setDeviceLastHeartbeatAt(device.device_id, longAgo);
    const projected = await diagnosticsForDevice(asUrl, device.device_id);
    assert.equal(projected.last_heartbeat_at, longAgo);
    assert.equal(projected.stale, false, "with no resolvable refresh policy the badge must stay honestly non-stale");
  });
});

// --- connect's narrowing-only device scope, end to end against the real enroll route ---

function readEffectiveScope(connectorInstanceId: string): { since?: string; source_roots?: string[] } | null {
  const row = getDb()
    .prepare("SELECT state_json FROM connector_state WHERE connector_instance_id = ? AND stream = ?")
    .get(connectorInstanceId, "$collection_scope") as { state_json: string } | undefined;
  if (!row) {
    return null;
  }
  const stored = JSON.parse(row.state_json) as { scope: { since?: string; source_roots?: string[] } | null };
  return stored.scope;
}

async function mintEnrollmentCode(
  asUrl: string,
  localBindingName: string,
  connectorId = "codex",
  ownerDeclaredScope?: { since?: string; source_roots?: string[] } | null
): Promise<string> {
  const codeResp = await postJson(`${asUrl}/_ref/device-exporters/enrollment-codes`, {
    connector_id: connectorId,
    local_binding_name: localBindingName,
    ...(ownerDeclaredScope === undefined ? {} : { collection_scope: ownerDeclaredScope }),
  });
  assert.equal(codeResp.status, 201, JSON.stringify(codeResp.body));
  return stringField(bodyOf(codeResp), "enrollment_code");
}

function enrollWithScope(
  asUrl: string,
  enrollmentCode: string,
  collectionScope: { since?: string; source_roots?: string[] } | null | undefined
): Promise<JsonResponse> {
  return postJson(
    `${asUrl}/_ref/device-exporters/enroll`,
    { collection_scope: collectionScope, enrollment_code: enrollmentCode },
    PROTOCOL_HEADERS
  );
}

test("connect: enrolling with no scope declared defaults to recent history, not an implicit full pass", async () => {
  await withServer(async ({ asUrl }) => {
    const code = await mintEnrollmentCode(asUrl, "recent-default-laptop");
    const resp = await enrollWithScope(asUrl, code, undefined);
    assert.equal(resp.status, 201);
    const connectorInstanceId = stringField(bodyOf(resp), "connector_instance_id");
    const effective = readEffectiveScope(connectorInstanceId);
    assert.ok(effective?.since, "an undeclared enrollment must default to a recent-history since");
    const daysAgo = (Date.now() - Date.parse(effective?.since ?? "")) / 86_400_000;
    assert.ok(daysAgo > 29 && daysAgo < 31, `expected ~30 days back, got ${daysAgo}`);
  });
});

test("connect: --all requests an explicit full pass, honored when the server declared nothing", async () => {
  await withServer(async ({ asUrl }) => {
    const code = await mintEnrollmentCode(asUrl, "all-history-laptop");
    const resp = await enrollWithScope(asUrl, code, null);
    assert.equal(resp.status, 201);
    const connectorInstanceId = stringField(bodyOf(resp), "connector_instance_id");
    assert.equal(
      readEffectiveScope(connectorInstanceId),
      null,
      "an explicit all request must land as unscoped, not defaulted to recent"
    );
  });
});

test("connect: --recent <days> is honored exactly when the server declared nothing", async () => {
  await withServer(async ({ asUrl }) => {
    const code = await mintEnrollmentCode(asUrl, "custom-recent-laptop");
    const since = "2026-07-01T00:00:00.000Z";
    const resp = await enrollWithScope(asUrl, code, { since });
    assert.equal(resp.status, 201);
    const connectorInstanceId = stringField(bodyOf(resp), "connector_instance_id");
    assert.deepEqual(readEffectiveScope(connectorInstanceId), { since });
  });
});

test("connect: custom --since/--source-roots validates and is honored exactly when the server declared nothing", async () => {
  await withServer(async ({ asUrl }) => {
    const code = await mintEnrollmentCode(asUrl, "custom-roots-laptop");
    const resp = await enrollWithScope(asUrl, code, {
      since: "2026-06-01T00:00:00.000Z",
      source_roots: ["proj-a", "proj-b"],
    });
    assert.equal(resp.status, 201);
    const connectorInstanceId = stringField(bodyOf(resp), "connector_instance_id");
    assert.deepEqual(readEffectiveScope(connectorInstanceId), {
      since: "2026-06-01T00:00:00.000Z",
      source_roots: ["proj-a", "proj-b"],
    });
  });
});

test("connect: a malformed collection_scope (unparseable since) is rejected with a typed 400 and enrolls nothing", async () => {
  await withServer(async ({ asUrl }) => {
    const code = await mintEnrollmentCode(asUrl, "malformed-since-laptop");
    const resp = await enrollWithScope(asUrl, code, { since: "not-a-date" });
    assert.equal(resp.status, 400);
    assert.equal(errorCode(resp), "invalid_request");

    // Nothing was consumed: the SAME code can still be used for a valid enroll.
    const retry = await enrollWithScope(asUrl, code, undefined);
    assert.equal(retry.status, 201, "a rejected malformed request must not consume the one-time code");
  });
});

test("connect: a malformed collection_scope (empty source_roots entry) is rejected with a typed 400", async () => {
  await withServer(async ({ asUrl }) => {
    const code = await mintEnrollmentCode(asUrl, "malformed-roots-laptop");
    const resp = await enrollWithScope(asUrl, code, { source_roots: ["ok", ""] });
    assert.equal(resp.status, 400);
    assert.equal(errorCode(resp), "invalid_request");
  });
});

test("connect: a device --all request is REJECTED when the owner already staged a narrower boundary on the code", async () => {
  await withServer(async ({ asUrl }) => {
    // The owner (dashboard/enrollment-codes mint) already declared a
    // boundary on the CODE itself. A device requesting --all at enroll time
    // is a widening request against it and must be refused outright — never
    // silently clamped back down to the owner's boundary, and never honored
    // as the wider ask.
    const code = await mintEnrollmentCode(asUrl, "widen-laptop", "codex", { since: "2026-06-01T00:00:00.000Z" });
    const resp = await enrollWithScope(asUrl, code, null);
    assert.equal(resp.status, 400);
    assert.equal(errorCode(resp), "invalid_request");
    assert.match(
      String((bodyOf(resp).error as Record<string, unknown> | undefined)?.message),
      NARROW_ONLY_REJECTION_MESSAGE_PATTERN
    );

    // Nothing was consumed or materialized by the rejected attempt: the SAME
    // code can still be used with a compliant (narrower-or-equal) request.
    const compliant = await enrollWithScope(asUrl, code, { since: "2026-07-01T00:00:00.000Z" });
    assert.equal(compliant.status, 201, "a rejected widening attempt must not consume the code");
    assert.deepEqual(readEffectiveScope(stringField(bodyOf(compliant), "connector_instance_id")), {
      since: "2026-07-01T00:00:00.000Z",
    });
  });
});

test("connect: a device --since request EARLIER than the owner-staged boundary is REJECTED as widening", async () => {
  await withServer(async ({ asUrl }) => {
    const code = await mintEnrollmentCode(asUrl, "widen-since-laptop", "codex", {
      since: "2026-06-01T00:00:00.000Z",
    });
    const resp = await enrollWithScope(asUrl, code, { since: "2026-01-01T00:00:00.000Z" });
    assert.equal(resp.status, 400);
    assert.equal(errorCode(resp), "invalid_request");
  });
});

test("connect: a device --source-roots request outside the owner-staged root is REJECTED as widening", async () => {
  await withServer(async ({ asUrl }) => {
    const code = await mintEnrollmentCode(asUrl, "widen-roots-laptop", "codex", {
      source_roots: ["/home/owner/code/pdpp"],
    });
    const resp = await enrollWithScope(asUrl, code, { source_roots: ["/home/owner/code/other-project"] });
    assert.equal(resp.status, 400);
    assert.equal(errorCode(resp), "invalid_request");

    // A NARROWER root (a subdirectory of the owner's declared root) is honored.
    const narrower = await enrollWithScope(asUrl, code, { source_roots: ["/home/owner/code/pdpp/sub"] });
    assert.equal(narrower.status, 201);
    assert.deepEqual(readEffectiveScope(stringField(bodyOf(narrower), "connector_instance_id")), {
      source_roots: ["/home/owner/code/pdpp/sub"],
    });
  });
});

test("connect: a device request with no preference honors the owner-staged boundary unchanged", async () => {
  await withServer(async ({ asUrl }) => {
    const code = await mintEnrollmentCode(asUrl, "no-preference-laptop", "codex", {
      since: "2026-06-01T00:00:00.000Z",
    });
    const resp = await enrollWithScope(asUrl, code, undefined);
    assert.equal(resp.status, 201);
    assert.deepEqual(readEffectiveScope(stringField(bodyOf(resp), "connector_instance_id")), {
      since: "2026-06-01T00:00:00.000Z",
    });
  });
});

test("connect: one-time enrollment code cannot be replayed to mint a second unrelated device", async () => {
  await withServer(async ({ asUrl }) => {
    const code = await mintEnrollmentCode(asUrl, "replay-laptop");
    const first = await enrollWithScope(asUrl, code, undefined);
    assert.equal(first.status, 201);
    const firstDeviceId = stringField(bodyOf(first), "device_id");

    // Replaying the SAME code from a "different" caller (no device credential
    // reused) must not mint a second device: it can only resume the SAME
    // binding it already materialized (design D2's idempotent re-enroll), or
    // be refused outright if that binding no longer matches.
    const replay = await enrollWithScope(asUrl, code, undefined);
    assert.equal(replay.status, 201, "a consumed code replay resumes the same binding rather than erroring");
    assert.equal(
      stringField(bodyOf(replay), "device_id"),
      firstDeviceId,
      "replay must resolve to the SAME device, never mint a second, unrelated one"
    );

    // A THIRD replay, this time with an incompatible local_binding_name
    // encoded into a fresh code for the same owner, is a genuinely different
    // enrollment and must mint its own device — proving replay-detection
    // is about the CODE, not a blanket refusal of all subsequent enrolls.
    const otherCode = await mintEnrollmentCode(asUrl, "replay-laptop-2");
    const other = await enrollWithScope(asUrl, otherCode, undefined);
    assert.equal(other.status, 201);
    assert.notEqual(stringField(bodyOf(other), "device_id"), firstDeviceId);
  });
});

test("connect: a fully consumed and expired code cannot be reused at all", async () => {
  await withServer(async ({ asUrl }) => {
    const code = await mintEnrollmentCode(asUrl, "expired-laptop");
    const first = await enrollWithScope(asUrl, code, undefined);
    assert.equal(first.status, 201);

    // Force the enrollment code row into an already-expired state, mirroring
    // a code replayed long after its TTL — the expiry check runs even on a
    // consumed code's retry path.
    const latestCode = getDb()
      .prepare("SELECT code_hash FROM device_enrollment_codes ORDER BY created_at DESC LIMIT 1")
      .get() as { code_hash: string } | undefined;
    const updated = getDb()
      .prepare("UPDATE device_enrollment_codes SET expires_at = ? WHERE code_hash = ?")
      .run(new Date(Date.now() - 60_000).toISOString(), latestCode?.code_hash);
    assert.equal(updated.changes, 1);

    const replay = await enrollWithScope(asUrl, code, undefined);
    assert.equal(replay.status, 410, "an expired code, even one already consumed once, must be refused outright");
  });
});

test("connect: local profile permissions and redaction are unaffected by the scope request (regression via the shared writeLocalCollectorProfile path)", async () => {
  // This is a route-level sanity check that the enroll response's SECRET
  // fields (device_token) are the only sensitive material returned, and that
  // no scope-related detail leaks a path, payload, or PII. The local-collector
  // package's own test (`runConnect: writes the local profile with
  // restrictive permissions, same as setup`) proves file-mode 0600/0700; this
  // proves the SERVER side returns nothing extra to redact.
  await withServer(async ({ asUrl }) => {
    const code = await mintEnrollmentCode(asUrl, "redaction-laptop");
    const resp = await enrollWithScope(asUrl, code, { source_roots: ["/home/owner/secret-project-name"] });
    assert.equal(resp.status, 201);
    const body = bodyOf(resp);
    assert.deepEqual(
      new Set(Object.keys(body)),
      new Set([
        "connector_id",
        "connector_instance_id",
        "device_id",
        "device_token",
        "local_binding_name",
        "object",
        "source_instance_id",
      ])
    );
    // The declared root path is real owner data (a project path) — it must
    // never be echoed back in the enroll response itself; it lives only in
    // connector_state, read back through the dedicated scope route/CLI.
    assert.equal(JSON.stringify(body).includes("secret-project-name"), false);
  });
});
