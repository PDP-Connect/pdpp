// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { setImmediate as yieldImmediate } from "node:timers/promises";

import { __setRegisterConnectorPhaseHookForTest, registerConnector } from "../server/auth.ts";
import { COLLECTOR_PROTOCOL_VERSION } from "../server/collector-protocol.ts";
import {
  __setConnectorInstanceWritePhaseHookForTest,
  connectorInstanceWriteCoordinatorStatsForTests,
  withConnectorInstanceWrite,
} from "../server/connector-instance-write-coordinator.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { startServer as startServerBase } from "../server/index.ts";
import { __setPostgresRecordSortBackfillPhaseHookForTest } from "../server/postgres-records.ts";
import { closePostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import {
  __setIndexPublishPhaseHookForTest,
  __setRecordIndexFaultHookForTest,
  __setSqliteRecordSortBackfillPhaseHookForTest,
  deleteAllRecords,
  deleteRecord,
  drainConnectorInstanceIndexWork,
  ingestRecord,
  ingestRecords,
  setClientEventEnqueueHook,
} from "../server/records.ts";
import { __setDeviceIngestPhaseFaultHookForTest } from "../server/routes/ref-device-exporters.ts";
import { __setLexicalBackfillPhaseHookForTest } from "../server/search.ts";
import { configureSemanticBackend } from "../server/search-semantic.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const DEDICATED_POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
const PROTOCOL_HEADERS = { "X-PDPP-Collector-Protocol": COLLECTOR_PROTOCOL_VERSION };
let unique = 0;

function startServer(
  options: Parameters<typeof startServerBase>[0] & { databaseUrl?: string; storageBackend?: "postgres" }
) {
  return startServerBase(options);
}

// Row shapes here are genuinely heterogeneous: the same driver method serves
// both SQLite and Postgres queries (different column sets) and callers project
// arbitrary subsets. A permissive record keeps the conformance oracle's
// dynamic field access honest without inventing a rigid shape the two
// backends don't actually share.
type Row = Record<string, unknown>;
type JsonRecord = Record<string, unknown>;

function nextId(prefix: string): string {
  unique += 1;
  return `${prefix}-${process.pid}-${Date.now()}-${unique}`;
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

async function within<T>(promise: Promise<T>, label: string, timeoutMs = 10_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Durable record commit does not block on derived lexical/semantic index
// maintenance (records.ts's scheduleRecordIndexMaintenance runs it on a
// fire-and-forget per-connector-instance lane). A writer's own promise
// resolving therefore proves the durable row landed, not that its derived
// index converged -- drainConnectorInstanceIndexWork is the scheduler's own
// settlement barrier (awaits the real per-instance tail chain to
// quiescence), the deterministic way to observe that convergence before
// asserting on lexical/semantic content.
function waitForDeferredIndexWorkToDrain(timeoutMs = 10_000): Promise<void> {
  return drainConnectorInstanceIndexWork(timeoutMs);
}

type CanonicalValue = null | string | number | boolean | CanonicalValue[] | { [key: string]: CanonicalValue };

function canonical(value: unknown): CanonicalValue {
  if (value === null || typeof value !== "object") {
    return value as CanonicalValue;
  }
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => [key, canonical(record[key])])
  );
}

function bodyHash(records: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(records)))
    .digest("hex");
}

function vectorForText(text: string): Float32Array {
  const digest = createHash("sha256").update(String(text)).digest();
  return new Float32Array([
    digest.readUInt16BE(0) / 65_535,
    digest.readUInt16BE(2) / 65_535,
    digest.readUInt16BE(4) / 65_535,
  ]);
}

function normalizedVector(vector: Float32Array): number[] {
  return Array.from(vector, (value) => Number(Number(value).toFixed(5)));
}

function normalizedBlobVector(value: Buffer | Uint8Array): number[] {
  const bytes = Buffer.from(value);
  return normalizedVector(
    new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / Float32Array.BYTES_PER_ELEMENT)
  );
}

function parseResponseJson(value: unknown): unknown {
  if (value === null) {
    return null;
  }
  if (typeof value === "string") {
    return JSON.parse(value);
  }
  return value;
}

interface DeviceRecordOptions {
  fields?: Record<string, unknown>;
  nested?: unknown;
  op?: string;
  timestamp?: string;
}

interface DeviceRecord {
  data: Record<string, unknown>;
  emitted_at: string;
  op: string;
  record_key: string;
  stream: string;
}

function deviceRecord(
  key: string,
  content: unknown,
  { op = "upsert", nested = null, timestamp = "2026-07-16T12:00:00.000Z", fields = {} }: DeviceRecordOptions = {}
): DeviceRecord {
  return {
    data:
      op === "delete"
        ? {}
        : {
            content,
            id: key,
            role: "user",
            session_id: `session-${key}`,
            timestamp,
            type: "text",
            ...(nested ? { nested } : {}),
            ...fields,
          },
    emitted_at: timestamp,
    op,
    record_key: key,
    stream: "messages",
  };
}

interface DirectRecord {
  data: Record<string, unknown>;
  emitted_at: string;
  key: string;
  op: "delete" | "upsert";
  stream: string;
}

function directRecord(key: string, content: unknown, options: DeviceRecordOptions = {}): DirectRecord {
  const record = deviceRecord(key, content, options);
  return {
    data: record.data,
    emitted_at: record.emitted_at,
    key: record.record_key,
    op: record.op === "delete" ? "delete" : "upsert",
    stream: record.stream,
  };
}

interface EnrolledDevice {
  readonly connector_id: string;
  readonly connector_instance_id: string;
  readonly device_id: string;
  readonly device_token: string;
  readonly source_instance_id: string;
}

interface DeviceBatch {
  batch_id: string;
  batch_seq: number;
  body_hash: string;
  connector_id: string;
  device_id: string;
  records: unknown[];
  source_instance_id: string;
}

function batch(device: EnrolledDevice, batchId: string, records: unknown[], batchSeq = 1): DeviceBatch {
  return {
    batch_id: batchId,
    batch_seq: batchSeq,
    body_hash: bodyHash(records),
    connector_id: device.connector_id,
    device_id: device.device_id,
    records,
    source_instance_id: device.source_instance_id,
  };
}

interface DeterministicBackendOptions {
  onEmbed?: ((text: string) => Promise<void>) | null;
}

interface DeterministicBackend {
  available: () => boolean;
  calls: () => number;
  dimensions: () => number;
  distanceMetric: () => "cosine";
  embedDocument: (text: string) => Promise<Float32Array>;
  embedQuery: (text: string) => Promise<Float32Array>;
  identity: () => string;
  languageBias: () => unknown;
  model: () => string;
  profileId: () => string;
  setEmbedHook: (hook: ((text: string) => Promise<void>) | null) => void;
  supportsDeviceAttemptDeadline: () => boolean;
  [key: string]: unknown;
}

function deterministicBackend({ onEmbed = null }: DeterministicBackendOptions = {}): DeterministicBackend {
  let embedHook = onEmbed;
  let documentCalls = 0;
  return {
    available: () => true,
    calls: () => documentCalls,
    dimensions: () => 3,
    distanceMetric: () => "cosine",
    embedDocument: async (text) => {
      documentCalls += 1;
      await embedHook?.(text);
      return vectorForText(text);
    },
    embedQuery: async (text) => vectorForText(text),
    identity: () => "device-ingest-conformance-stub",
    languageBias: () => null,
    model: () => "device-ingest-conformance-stub",
    profileId: () => "device-ingest-conformance",
    setEmbedHook: (hook) => {
      embedHook = hook;
    },
    supportsDeviceAttemptDeadline: () => true,
  };
}

type CloseableTestServer = Awaited<ReturnType<typeof startServer>>;

async function closeServer(server: CloseableTestServer): Promise<void> {
  server.abortStartupBackfill("test shutdown");
  server.schedulerManager?.stop?.();
  server.stopBrowserSurfaceLeaseSweep();
  server.asServer.closeAllConnections?.();
  server.rsServer.closeAllConnections?.();
  await Promise.allSettled([
    new Promise((resolve) => server.asServer.close(resolve)),
    new Promise((resolve) => server.rsServer.close(resolve)),
    server.controller.drainActiveRuns(5000),
    server.startupBackfillDone,
    server.startupSummaryEvidenceSweepDone,
    server.stopClientEventDeliveryWorker(),
  ]);
}

interface JsonResponse {
  readonly body: Record<string, unknown> | null;
  readonly status: number;
}

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<JsonResponse> {
  const response = await fetch(url, {
    body: JSON.stringify(body),
    headers: { Accept: "application/json", "Content-Type": "application/json", ...headers },
    method: "POST",
  });
  const text = await response.text();
  return { body: (text ? JSON.parse(text) : null) as Record<string, unknown> | null, status: response.status };
}

function authHeaders(deviceToken: string): Record<string, string> {
  return { Authorization: `Bearer ${deviceToken}`, ...PROTOCOL_HEADERS };
}

function mustExist<T>(value: T | null | undefined, description: string): T {
  assert.ok(value, description);
  return value;
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

async function enrollDevice(asUrl: string, localBindingName: string): Promise<EnrolledDevice> {
  const code = await postJson(`${asUrl}/_ref/device-exporters/enrollment-codes`, {
    connector_id: "codex",
    local_binding_name: localBindingName,
  });
  assert.equal(code.status, 201, JSON.stringify(code.body));
  const enrolled = await postJson(
    `${asUrl}/_ref/device-exporters/enroll`,
    { enrollment_code: stringField(bodyOf(code), "enrollment_code") },
    PROTOCOL_HEADERS
  );
  assert.equal(enrolled.status, 201, JSON.stringify(enrolled.body));
  const body = bodyOf(enrolled);
  return {
    connector_id: stringField(body, "connector_id"),
    connector_instance_id: stringField(body, "connector_instance_id"),
    device_id: stringField(body, "device_id"),
    device_token: stringField(body, "device_token"),
    source_instance_id: stringField(body, "source_instance_id"),
  };
}

function deviceIngestUrl(asUrl: string, device: EnrolledDevice): string {
  return `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`;
}

async function withTemporaryPostgres(fn: (url: string) => Promise<void>): Promise<void> {
  const connectionString = mustExist(DEDICATED_POSTGRES_URL, "a dedicated Postgres URL must be selected");
  const database = `pdpp_ingest_oracle_${process.pid}_${Date.now()}_${unique}`;
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString,
      databaseName: database,
    },
    fn
  );
}

type BackendKind = "sqlite" | "postgres";

interface RecordSnapshot extends Row {
  cursor_value: unknown;
  deleted: boolean;
  primary_key_text: string;
  record_json: JsonRecord;
  record_json_raw: string;
  version: number;
}

interface SemanticRow {
  record_key: string;
  scope_key: string;
}

interface SemanticEmbeddingRow extends SemanticRow {
  embedding: number[];
}

interface DerivedState {
  lexicalMeta: Row[];
  semanticMeta: Row[];
  semanticProgress: Row[];
}

interface DiagnosticsSnapshot {
  device: {
    last_ingest_at: unknown;
    last_heartbeat_at: unknown;
    stale: unknown;
    last_error: unknown;
  };
  source: {
    accepted_record_count: unknown;
    rejected_record_count: unknown;
    last_ingest_at: unknown;
    last_heartbeat_at: unknown;
    last_heartbeat_status: unknown;
    records_pending: unknown;
    outbox_diagnostics: unknown;
    outbox_state: unknown;
    local_collector_gaps: unknown;
    local_collector_coverage: unknown;
    last_error: unknown;
  };
}

interface DriverSnapshot {
  derived: DerivedState;
  diagnostics: DiagnosticsSnapshot;
  histories: Record<string, Array<{ version: number; deleted: boolean }>>;
  lexical: Record<string, Row[]>;
  outcome: Row | null;
  outcomes: Row[];
  records: Record<string, RecordSnapshot | null>;
  semantic: Record<string, SemanticRow[]>;
  versionCounter: number;
}

interface Driver {
  asUrl: string;
  changes: (instanceId: string, key: string) => Promise<number>;
  corruptDerived: (instanceId: string, key: string) => Promise<void>;
  derivedState: (instanceId: string) => Promise<DerivedState>;
  diagnostics: (device: EnrolledDevice, sourceInstanceId: string) => Promise<DiagnosticsSnapshot["source"]>;
  diagnosticsSnapshot: (device: EnrolledDevice, sourceInstanceId: string) => Promise<DiagnosticsSnapshot>;
  disableSemanticBackend: () => void;
  embeddingCalls: () => number;
  enroll: (name: string) => Promise<EnrolledDevice>;
  eraseDerived: (instanceId: string, key: string) => Promise<void>;
  history: (instanceId: string, key: string) => Promise<Array<{ version: number; deleted: boolean }>>;
  ingest: (device: EnrolledDevice, request: unknown) => Promise<JsonResponse>;
  kind: BackendKind;
  lexical: (instanceId: string, key: string) => Promise<Row[]>;
  manifest: () => Promise<JsonRecord>;
  mutateOutcomeIdentity: (device: EnrolledDevice, batchId: string, column: string, value: unknown) => Promise<void>;
  outcome: (device: EnrolledDevice, batchId: string) => Promise<Row | null>;
  outcomes: (device: EnrolledDevice) => Promise<Row[]>;
  record: (instanceId: string, key: string, streamName?: string) => Promise<RecordSnapshot | null>;
  registerManifest: (manifest: unknown, options?: Record<string, unknown>) => Promise<void>;
  restoreSemanticBackend: () => void;
  semantic: (instanceId: string, key: string) => Promise<SemanticRow[]>;
  semanticWithEmbedding: (instanceId: string, key: string) => Promise<SemanticEmbeddingRow[]>;
  setEmbeddingHook: (hook: ((text: string) => Promise<void>) | null) => void;
  snapshot: (args: { device: EnrolledDevice; batchId: string; keys: string[] }) => Promise<DriverSnapshot>;
  target: (instanceId: string) => { connector_id: string; connector_instance_id: string };
  versions: (instanceId: string) => Promise<number>;
}

async function withBackend(kind: BackendKind, fn: (driver: Driver) => Promise<void>): Promise<void> {
  const backend = deterministicBackend();
  if (kind === "sqlite") {
    const server: CloseableTestServer = await startServer({
      asPort: 0,
      dbPath: ":memory:",
      quiet: true,
      rsPort: 0,
      semanticRetrievalBackend: backend,
    });
    try {
      await server.startupBackfillDone?.catch(() => undefined);
      await fn(createDriver({ kind, semanticBackend: backend, server }));
    } finally {
      __setConnectorInstanceWritePhaseHookForTest(null);
      __setDeviceIngestPhaseFaultHookForTest(null);
      __setIndexPublishPhaseHookForTest(null);
      __setRecordIndexFaultHookForTest(null);
      __setSqliteRecordSortBackfillPhaseHookForTest(null);
      __setRegisterConnectorPhaseHookForTest(null);
      __setLexicalBackfillPhaseHookForTest(null);
      __setPostgresRecordSortBackfillPhaseHookForTest(null);
      setClientEventEnqueueHook(null);
      configureSemanticBackend(backend);
      await closeServer(server);
      closeDb();
    }
    return;
  }

  await withTemporaryPostgres(async (url) => {
    initDb(":memory:");
    const server: CloseableTestServer = await startServer({
      asPort: 0,
      databaseUrl: url,
      dbPath: ":memory:",
      quiet: true,
      rsPort: 0,
      semanticRetrievalBackend: backend,
      storageBackend: "postgres",
    });
    try {
      await server.startupBackfillDone?.catch(() => undefined);
      await fn(createDriver({ kind, semanticBackend: backend, server }));
    } finally {
      __setConnectorInstanceWritePhaseHookForTest(null);
      __setDeviceIngestPhaseFaultHookForTest(null);
      __setIndexPublishPhaseHookForTest(null);
      __setRecordIndexFaultHookForTest(null);
      __setSqliteRecordSortBackfillPhaseHookForTest(null);
      __setRegisterConnectorPhaseHookForTest(null);
      __setLexicalBackfillPhaseHookForTest(null);
      __setPostgresRecordSortBackfillPhaseHookForTest(null);
      setClientEventEnqueueHook(null);
      configureSemanticBackend(backend);
      await closeServer(server);
      await closePostgresStorage().catch(() => undefined);
      closeDb();
    }
  });
}

function createDriver({
  kind,
  server,
  semanticBackend,
}: {
  kind: BackendKind;
  server: CloseableTestServer;
  semanticBackend: DeterministicBackend;
}): Driver {
  const asUrl = `http://localhost:${server.asPort}`;
  const sql = {
    async execute(sqlite: string, postgres: string, params: unknown[] = []): Promise<unknown> {
      if (kind === "sqlite") {
        return getDb()
          .prepare(sqlite)
          .run(...params);
      }
      return await postgresQuery(postgres, params);
    },
    async one(sqlite: string, postgres: string, params: unknown[] = []): Promise<Row | null> {
      const rows = await this.rows(sqlite, postgres, params);
      return rows[0] ?? null;
    },
    async rows(sqlite: string, postgres: string, params: unknown[] = []): Promise<Row[]> {
      if (kind === "sqlite") {
        return getDb()
          .prepare(sqlite)
          .all(...params);
      }
      return (await postgresQuery(postgres, params)).rows;
    },
  };
  const normalizeOutcome = (row: Row | null): Row | null => {
    if (!row) {
      return null;
    }
    return {
      ...row,
      batch_seq: Number(row.batch_seq),
      durable_prefix_count: Number(row.durable_prefix_count),
      record_count: Number(row.record_count),
      response_json: parseResponseJson(row.response_json),
    };
  };

  const driver: Driver = {
    asUrl,
    async changes(instanceId, key) {
      const row = await sql.one(
        `SELECT COUNT(*) AS count FROM record_changes
          WHERE connector_instance_id = ? AND stream = 'messages' AND record_key = ?`,
        `SELECT COUNT(*)::integer AS count FROM record_changes
          WHERE connector_instance_id = $1 AND stream = 'messages' AND record_key = $2`,
        [instanceId, key]
      );
      return Number(mustExist(row, "a count row must always be returned").count);
    },
    async corruptDerived(instanceId, key) {
      if (kind === "sqlite") {
        getDb()
          .prepare(
            `DELETE FROM lexical_search_index
            WHERE connector_instance_id = ? AND stream = 'messages' AND record_key = ?`
          )
          .run(instanceId, key);
        getDb()
          .prepare(
            `INSERT INTO lexical_search_index(connector_id, connector_instance_id, stream, record_key, field, text)
           VALUES('codex', ?, 'messages', ?, 'content', 'corrupt lexical value')`
          )
          .run(instanceId, key);
      } else {
        await postgresQuery(
          `UPDATE lexical_search_index SET value = 'corrupt lexical value'
            WHERE connector_instance_id = $1 AND stream = 'messages' AND record_key = $2 AND field = 'content'`,
          [instanceId, key]
        );
      }
      await this.eraseDerived(instanceId, key);
      if (kind === "sqlite") {
        getDb()
          .prepare(
            `INSERT INTO lexical_search_index(connector_id, connector_instance_id, stream, record_key, field, text)
           VALUES('codex', ?, 'messages', ?, 'content', 'corrupt lexical value')`
          )
          .run(instanceId, key);
      } else {
        await postgresQuery(
          `INSERT INTO lexical_search_index(connector_id, connector_instance_id, stream, record_key, field, value)
           VALUES('codex', $1, 'messages', $2, 'content', 'corrupt lexical value')`,
          [instanceId, key]
        );
      }
    },
    async derivedState(instanceId) {
      const [lexicalMeta, semanticMeta, semanticProgress] = await Promise.all([
        sql.rows(
          `SELECT stream, fields_fingerprint FROM lexical_search_meta
            WHERE connector_instance_id = ? ORDER BY stream`,
          `SELECT stream, fields_fingerprint FROM lexical_search_meta
            WHERE connector_instance_id = $1 ORDER BY stream`,
          [instanceId]
        ),
        sql.rows(
          `SELECT stream, fields_fingerprint, model_id, dimensions, distance_metric
             FROM semantic_search_meta WHERE connector_instance_id = ? ORDER BY stream`,
          `SELECT stream, fields_fingerprint, model_id, dimensions, distance_metric
             FROM semantic_search_meta WHERE connector_instance_id = $1 ORDER BY stream`,
          [instanceId]
        ),
        sql.rows(
          `SELECT stream, fields_fingerprint, model_id, dimensions, distance_metric
             FROM semantic_search_backfill_progress WHERE connector_instance_id = ? ORDER BY stream`,
          `SELECT stream, fields_fingerprint, model_id, dimensions, distance_metric
             FROM semantic_search_backfill_progress WHERE connector_instance_id = $1 ORDER BY stream`,
          [instanceId]
        ),
      ]);
      return { lexicalMeta, semanticMeta, semanticProgress };
    },
    async diagnostics(device, sourceInstanceId) {
      return (await this.diagnosticsSnapshot(device, sourceInstanceId)).source;
    },
    async diagnosticsSnapshot(device, sourceInstanceId) {
      interface DiagnosticsSourceRow extends Row {
        source_instance_id: string;
      }
      interface DiagnosticsDeviceRow extends Row {
        device_id: string;
        source_instances: DiagnosticsSourceRow[];
      }
      interface DiagnosticsPayload {
        data: DiagnosticsDeviceRow[];
      }
      const response = await fetch(`${asUrl}/_ref/device-exporters/diagnostics`, {
        headers: { Accept: "application/json" },
      });
      assert.equal(response.status, 200);
      const payload = (await response.json()) as DiagnosticsPayload;
      const deviceRow = mustExist(
        payload.data.find((entry) => entry.device_id === device.device_id),
        "diagnostics payload must include this device"
      );
      const source = mustExist(
        deviceRow.source_instances.find((entry) => entry.source_instance_id === sourceInstanceId),
        "diagnostics payload must include this source instance"
      );
      return {
        device: {
          last_error: deviceRow.last_error,
          last_heartbeat_at: deviceRow.last_heartbeat_at,
          last_ingest_at: deviceRow.last_ingest_at,
          stale: deviceRow.stale,
        },
        source: {
          accepted_record_count: source.accepted_record_count,
          last_error: source.last_error,
          last_heartbeat_at: source.last_heartbeat_at,
          last_heartbeat_status: source.last_heartbeat_status,
          last_ingest_at: source.last_ingest_at,
          local_collector_coverage: source.local_collector_coverage,
          local_collector_gaps: source.local_collector_gaps,
          outbox_diagnostics: source.outbox_diagnostics,
          outbox_state: source.outbox_state,
          records_pending: source.records_pending,
          rejected_record_count: source.rejected_record_count,
        },
      };
    },
    disableSemanticBackend: () => configureSemanticBackend(null),
    embeddingCalls: () => semanticBackend.calls(),
    async enroll(name) {
      return await enrollDevice(asUrl, `${name}-${nextId("binding")}`);
    },
    async eraseDerived(instanceId, key) {
      await sql.execute(
        `DELETE FROM lexical_search_index WHERE connector_instance_id = ? AND stream = 'messages' AND record_key = ?`,
        `DELETE FROM lexical_search_index WHERE connector_instance_id = $1 AND stream = 'messages' AND record_key = $2`,
        [instanceId, key]
      );
      if (kind === "sqlite") {
        const rowids: Row[] = getDb()
          .prepare("SELECT rowid FROM semantic_search_rowid WHERE connector_instance_id = ? AND record_key = ?")
          .all(instanceId, key);
        for (const row of rowids) {
          getDb().prepare("DELETE FROM semantic_search_vec WHERE rowid = ?").run(row.rowid);
        }
        getDb()
          .prepare("DELETE FROM semantic_search_rowid WHERE connector_instance_id = ? AND record_key = ?")
          .run(instanceId, key);
        getDb()
          .prepare("DELETE FROM semantic_search_blob WHERE connector_instance_id = ? AND record_key = ?")
          .run(instanceId, key);
      } else {
        await sql.execute(
          "DELETE FROM semantic_search_blob WHERE connector_instance_id = ? AND record_key = ?",
          "DELETE FROM semantic_search_blob WHERE connector_instance_id = $1 AND record_key = $2",
          [instanceId, key]
        );
      }
    },
    async history(instanceId, key) {
      return await sql
        .rows(
          `SELECT version, deleted FROM record_changes
          WHERE connector_instance_id = ? AND stream = 'messages' AND record_key = ? ORDER BY version`,
          `SELECT version, deleted FROM record_changes
          WHERE connector_instance_id = $1 AND stream = 'messages' AND record_key = $2 ORDER BY version`,
          [instanceId, key]
        )
        .then((rows) => rows.map((row) => ({ deleted: Boolean(row.deleted), version: Number(row.version) })));
    },
    async ingest(device, request) {
      return await postJson(deviceIngestUrl(asUrl, device), request, authHeaders(device.device_token));
    },
    kind,
    async lexical(instanceId, key) {
      return (
        await sql.rows(
          `SELECT field, text FROM lexical_search_index
          WHERE connector_instance_id = ? AND stream = 'messages' AND record_key = ? ORDER BY field`,
          `SELECT field, value AS text FROM lexical_search_index
          WHERE connector_instance_id = $1 AND stream = 'messages' AND record_key = $2 ORDER BY field`,
          [instanceId, key]
        )
      ).map((row) => ({ field: String(row.field), text: String(row.text) }));
    },
    async manifest() {
      let row = await sql.one(
        "SELECT manifest FROM connectors WHERE connector_id = ?",
        "SELECT manifest FROM connectors WHERE connector_id = $1",
        ["codex"]
      );
      // Enrollment is the shipped production path that materializes a local
      // connector catalog row. Do not seed it through direct SQL: registration
      // and subsequent backfill tests must exercise the same public path.
      if (!row) {
        await enrollDevice(asUrl, nextId("manifest-primer"));
        row = await sql.one(
          "SELECT manifest FROM connectors WHERE connector_id = ?",
          "SELECT manifest FROM connectors WHERE connector_id = $1",
          ["codex"]
        );
      }
      assert.ok(row, "the shipped codex connector must be registered before device ingest");
      return typeof row.manifest === "string" ? JSON.parse(row.manifest) : (row.manifest as JsonRecord);
    },
    async mutateOutcomeIdentity(device, batchId, column, value) {
      assert.ok(
        new Set(["body_hash", "source_instance_id", "connector_instance_id", "connector_id", "batch_seq"]).has(column)
      );
      if (kind === "sqlite") {
        getDb()
          .prepare(`UPDATE device_ingest_batch_outcomes SET ${column} = ? WHERE device_id = ? AND batch_id = ?`)
          .run(value, device.device_id, batchId);
      } else {
        await postgresQuery(
          `UPDATE device_ingest_batch_outcomes SET ${column} = $1 WHERE device_id = $2 AND batch_id = $3`,
          [value, device.device_id, batchId]
        );
      }
    },
    async outcome(device, batchId) {
      const row = await sql.one(
        `SELECT device_id, batch_id, body_hash, source_instance_id, connector_instance_id,
                connector_id, batch_seq, status, http_status, response_json,
                record_count, durable_prefix_count, manifest_fingerprint,
                semantic_capability_identity, created_at, accepted_at
           FROM device_ingest_batch_outcomes WHERE device_id = ? AND batch_id = ?`,
        `SELECT device_id, batch_id, body_hash, source_instance_id, connector_instance_id,
                connector_id, batch_seq, status, http_status, response_json::text AS response_json,
                record_count, durable_prefix_count, manifest_fingerprint,
                semantic_capability_identity, created_at, accepted_at
           FROM device_ingest_batch_outcomes WHERE device_id = $1 AND batch_id = $2`,
        [device.device_id, batchId]
      );
      return normalizeOutcome(row);
    },
    async outcomes(device) {
      const rows = await sql.rows(
        `SELECT device_id, batch_id, body_hash, source_instance_id, connector_instance_id,
                connector_id, batch_seq, status, http_status, response_json,
                record_count, durable_prefix_count, manifest_fingerprint,
                semantic_capability_identity, created_at, accepted_at
           FROM device_ingest_batch_outcomes WHERE device_id = ? ORDER BY batch_id`,
        `SELECT device_id, batch_id, body_hash, source_instance_id, connector_instance_id,
                connector_id, batch_seq, status, http_status, response_json::text AS response_json,
                record_count, durable_prefix_count, manifest_fingerprint,
                semantic_capability_identity, created_at, accepted_at
           FROM device_ingest_batch_outcomes WHERE device_id = $1 ORDER BY batch_id`,
        [device.device_id]
      );
      return rows.map((row) => mustExist(normalizeOutcome(row), "a listed outcome row must normalize"));
    },
    async record(instanceId, key, streamName = "messages") {
      const row = await sql.one(
        `SELECT record_json, deleted, version, semantic_time
           FROM records WHERE connector_instance_id = ? AND stream = ? AND record_key = ?`,
        `SELECT record_json, deleted, version, cursor_value, primary_key_text, semantic_time
           FROM records WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3`,
        [instanceId, streamName, key]
      );
      if (!row) {
        return null;
      }
      const recordJson: JsonRecord =
        typeof row.record_json === "string" ? JSON.parse(row.record_json) : row.record_json;
      interface ManifestStream {
        cursor_field?: string;
        name?: string;
        primary_key?: string[] | string;
      }
      let sqliteLogicalFacts: { cursor: unknown; primary: string } | null = null;
      if (kind === "sqlite") {
        const manifestRow = await sql.one(
          "SELECT manifest FROM connectors WHERE connector_id = ?",
          "SELECT manifest FROM connectors WHERE connector_id = $1",
          ["codex"]
        );
        const manifest: { streams?: ManifestStream[] } | undefined =
          typeof manifestRow?.manifest === "string"
            ? JSON.parse(manifestRow.manifest)
            : (manifestRow?.manifest as { streams?: ManifestStream[] } | undefined);
        const stream = manifest?.streams?.find((entry) => entry?.name === streamName) ?? null;
        let primaryFields: string[];
        if (Array.isArray(stream?.primary_key)) {
          primaryFields = stream.primary_key;
        } else if (typeof stream?.primary_key === "string") {
          primaryFields = [stream.primary_key];
        } else {
          primaryFields = ["id"];
        }
        sqliteLogicalFacts = {
          cursor: typeof stream?.cursor_field === "string" ? (recordJson[stream.cursor_field] ?? null) : null,
          primary: primaryFields
            .map((field) => recordJson[field] ?? key)
            .map((value) => String(value ?? ""))
            .join("\u0001"),
        };
      }
      return {
        ...row,
        // SQLite stores the canonical payload plus manifest-derived semantic
        // time; PostgreSQL additionally materializes cursor/key columns.
        // Normalize the real representations against the current persisted
        // manifest without inventing SQLite columns.
        cursor_value: row.cursor_value ?? sqliteLogicalFacts?.cursor ?? null,
        deleted: Boolean(row.deleted),
        primary_key_text: (row.primary_key_text as string | undefined) ?? sqliteLogicalFacts?.primary ?? key,
        record_json: recordJson,
        record_json_raw: typeof row.record_json === "string" ? row.record_json : JSON.stringify(row.record_json),
        version: Number(row.version),
      };
    },
    async registerManifest(manifest, options = {}) {
      await registerConnector(manifest as Record<string, unknown>, options);
    },
    restoreSemanticBackend: () => configureSemanticBackend(semanticBackend),
    async semantic(instanceId, key) {
      if (kind === "sqlite") {
        return getDb()
          .prepare(
            `SELECT scope_key, record_key FROM semantic_search_rowid
            WHERE connector_instance_id = ? AND record_key = ? ORDER BY scope_key`
          )
          .all(instanceId, key)
          .map((row) => ({ record_key: String(row.record_key), scope_key: String(row.scope_key) }));
      }
      return (
        await sql.rows(
          `SELECT scope_key, record_key FROM semantic_search_blob
          WHERE connector_instance_id = ? AND record_key = ? ORDER BY scope_key`,
          `SELECT scope_key, record_key FROM semantic_search_blob
          WHERE connector_instance_id = $1 AND record_key = $2 ORDER BY scope_key`,
          [instanceId, key]
        )
      ).map((row) => ({ record_key: String(row.record_key), scope_key: String(row.scope_key) }));
    },
    async semanticWithEmbedding(instanceId, key) {
      if (kind === "sqlite") {
        if (getDb().vectorIndexKind === "sqlite-vec") {
          const rows: Row[] = getDb()
            .prepare(
              `SELECT mapping.scope_key, mapping.record_key, vec.embedding
               FROM semantic_search_rowid AS mapping
               JOIN semantic_search_vec AS vec ON vec.rowid = mapping.rowid
              WHERE mapping.connector_instance_id = ? AND mapping.record_key = ?
              ORDER BY mapping.scope_key`
            )
            .all(instanceId, key);
          return rows.map((row) => ({
            embedding: normalizedBlobVector(row.embedding as Buffer),
            record_key: row.record_key as string,
            scope_key: row.scope_key as string,
          }));
        }
        const rows: Row[] = getDb()
          .prepare(
            `SELECT scope_key, record_key, embedding
             FROM semantic_search_blob
            WHERE connector_instance_id = ? AND record_key = ?
            ORDER BY scope_key`
          )
          .all(instanceId, key);
        return rows.map((row) => ({
          embedding: normalizedBlobVector(row.embedding as Buffer),
          record_key: row.record_key as string,
          scope_key: row.scope_key as string,
        }));
      }
      const rows = await sql.rows(
        `SELECT scope_key, record_key, embedding FROM semantic_search_blob
          WHERE connector_instance_id = ? AND record_key = ? ORDER BY scope_key`,
        `SELECT scope_key, record_key, embedding::text AS embedding FROM semantic_search_blob
          WHERE connector_instance_id = $1 AND record_key = $2 ORDER BY scope_key`,
        [instanceId, key]
      );
      return rows.map((row) => ({
        embedding: normalizedVector(JSON.parse(row.embedding as string)),
        record_key: row.record_key as string,
        scope_key: row.scope_key as string,
      }));
    },
    setEmbeddingHook: (hook) => semanticBackend.setEmbedHook(hook),
    async snapshot({ device, batchId, keys }) {
      const records: Record<string, RecordSnapshot | null> = {};
      const histories: Record<string, Array<{ version: number; deleted: boolean }>> = {};
      const lexical: Record<string, Row[]> = {};
      const semantic: Record<string, SemanticRow[]> = {};
      await runSerial(keys, async (key) => {
        records[key] = await this.record(device.connector_instance_id, key);
        histories[key] = await this.history(device.connector_instance_id, key);
        lexical[key] = await this.lexical(device.connector_instance_id, key);
        semantic[key] = await this.semantic(device.connector_instance_id, key);
      });
      return {
        derived: await this.derivedState(device.connector_instance_id),
        diagnostics: await this.diagnosticsSnapshot(device, device.source_instance_id),
        histories,
        lexical,
        outcome: await this.outcome(device, batchId),
        outcomes: await this.outcomes(device),
        records,
        semantic,
        versionCounter: await this.versions(device.connector_instance_id),
      };
    },
    target(instanceId) {
      return { connector_id: "codex", connector_instance_id: instanceId };
    },
    async versions(instanceId) {
      const row = await sql.one(
        `SELECT COALESCE(max_version, 0) AS max_version
           FROM version_counter WHERE connector_instance_id = ? AND stream = 'messages'`,
        `SELECT COALESCE(max_version, 0)::bigint AS max_version
           FROM version_counter WHERE connector_instance_id = $1 AND stream = 'messages'`,
        [instanceId]
      );
      return Number(row?.max_version ?? 0);
    },
  };
  return driver;
}

interface ManifestStreamMutable {
  consent_time_field?: string;
  cursor_field?: string;
  name?: string;
  primary_key?: string[];
  query: { search: { lexical_fields?: string[]; semantic_fields?: string[] } };
  schema: { properties: Record<string, unknown> };
  [key: string]: unknown;
}

interface ConnectorManifestMutable {
  storage_binding?: unknown;
  streams: ManifestStreamMutable[];
  [key: string]: unknown;
}

type ManifestMutation = (messages: ManifestStreamMutable, manifest: ConnectorManifestMutable) => void;

async function configureMessagesManifest(
  driver: Driver,
  mutation: ManifestMutation | null = null
): Promise<ConnectorManifestMutable> {
  const manifest = structuredClone(await driver.manifest()) as ConnectorManifestMutable;
  const messages = mustExist(
    manifest.streams.find((stream) => stream.name === "messages"),
    "shipped codex manifest must retain messages"
  );
  messages.query.search.lexical_fields = ["content"];
  messages.query.search.semantic_fields = ["content"];
  mutation?.(messages, manifest);
  await driver.registerManifest(manifest);
  const persisted = (await driver.manifest()) as ConnectorManifestMutable;
  const persistedMessages = mustExist(
    persisted.streams.find((stream) => stream.name === "messages"),
    "persisted manifest must retain messages"
  );
  assert.deepEqual(persistedMessages.query.search.lexical_fields, messages.query.search.lexical_fields);
  assert.deepEqual(persistedMessages.query.search.semantic_fields, messages.query.search.semantic_fields);
  return manifest;
}

async function enrollConfiguredDevice(
  driver: Driver,
  name: string,
  mutation: ManifestMutation | null = null
): Promise<EnrolledDevice> {
  const device = await driver.enroll(name);
  await configureMessagesManifest(driver, mutation);
  return device;
}

interface ClientEventNotification extends Row {
  connectorInstanceId?: string;
  version: number;
}

function notificationVersions(notifications: ClientEventNotification[]): number[] {
  return notifications.map((change) => change.version);
}

function diagnosticFreshnessInputs(diagnostics: DiagnosticsSnapshot) {
  return {
    device: {
      last_error: diagnostics.device.last_error,
      last_heartbeat_at: diagnostics.device.last_heartbeat_at,
      stale: diagnostics.device.stale,
    },
    source: {
      last_error: diagnostics.source.last_error,
      last_heartbeat_at: diagnostics.source.last_heartbeat_at,
      last_heartbeat_status: diagnostics.source.last_heartbeat_status,
      local_collector_coverage: diagnostics.source.local_collector_coverage,
      local_collector_gaps: diagnostics.source.local_collector_gaps,
      outbox_diagnostics: diagnostics.source.outbox_diagnostics,
      outbox_state: diagnostics.source.outbox_state,
      records_pending: diagnostics.source.records_pending,
    },
  };
}

function assertStoredAcceptedResponse(outcome: Row, device: EnrolledDevice, request: DeviceBatch): void {
  assert.equal(outcome.http_status, 201);
  assert.ok(outcome.accepted_at);
  assert.deepEqual(outcome.response_json, {
    accepted_record_count: outcome.record_count,
    batch_id: request.batch_id,
    body_hash: request.body_hash,
    connector_instance_id: device.connector_instance_id,
    device_id: device.device_id,
    object: "device_ingest_batch_result",
    rejected_record_count: 0,
    source_instance_id: device.source_instance_id,
    status: "accepted",
  });
}

async function assertOutcomeIdentity(
  driver: Driver,
  device: EnrolledDevice,
  request: DeviceBatch,
  { status = "accepted" } = {}
): Promise<Row> {
  const outcome = mustExist(
    await driver.outcome(device, request.batch_id),
    "the batch reservation is directly persisted"
  );
  assert.equal(outcome.status, status);
  assert.equal(outcome.device_id, device.device_id);
  assert.equal(outcome.batch_id, request.batch_id);
  assert.equal(outcome.body_hash, request.body_hash);
  assert.equal(outcome.source_instance_id, device.source_instance_id);
  assert.equal(outcome.connector_instance_id, device.connector_instance_id);
  assert.equal(outcome.connector_id, "codex");
  assert.equal(outcome.batch_seq, request.batch_seq);
  assert.ok(outcome.manifest_fingerprint);
  assert.ok(outcome.semantic_capability_identity);
  assert.ok(outcome.created_at);
  assert.ok(
    Number(outcome.durable_prefix_count) >= 0 && Number(outcome.durable_prefix_count) <= Number(outcome.record_count)
  );
  if (status === "accepted") {
    assertStoredAcceptedResponse(outcome, device, request);
  }
  return outcome;
}

interface AssertAcceptedFinalStateArgs {
  batchId: string;
  changes: number;
  content: string;
  device: EnrolledDevice;
  key: string;
  notifications: ClientEventNotification[];
  request?: DeviceBatch;
  version: number;
}

async function assertAcceptedFinalState(
  driver: Driver,
  { device, request, batchId, key, content, version, changes, notifications }: AssertAcceptedFinalStateArgs
): Promise<void> {
  const outcome = mustExist(await driver.outcome(device, batchId), "the batch outcome must be persisted");
  assert.equal(outcome.status, "accepted");
  assert.equal(Number(outcome.durable_prefix_count), Number(outcome.record_count));
  if (request) {
    assertStoredAcceptedResponse(outcome, device, request);
  }
  if (request) {
    await assertOutcomeIdentity(driver, device, request);
  }

  const record = mustExist(
    await driver.record(device.connector_instance_id, key),
    "the accepted record must be persisted"
  );
  assert.equal(record.deleted, false);
  assert.equal(record.record_json.content, content);
  assert.equal(record.version, version);
  assert.equal(record.cursor_value, record.record_json.timestamp);
  assert.equal(record.primary_key_text, key);
  assert.equal(record.semantic_time, record.record_json.timestamp);
  assert.equal(await driver.changes(device.connector_instance_id, key), changes);
  assert.equal(await driver.versions(device.connector_instance_id), version);
  assert.deepEqual(await driver.lexical(device.connector_instance_id, key), [{ field: "content", text: content }]);
  assert.deepEqual(await driver.semantic(device.connector_instance_id, key), [
    { record_key: key, scope_key: JSON.stringify(["messages", "content"]) },
  ]);
  assert.deepEqual(
    notificationVersions(notifications),
    Array.from({ length: changes }, (_, index) => index + 1)
  );
  const derived = await driver.derivedState(device.connector_instance_id);
  assert.equal(derived.lexicalMeta.filter((row) => row.stream === "messages").length, 1);
  assert.equal(derived.semanticMeta.filter((row) => row.stream === "messages").length, 1);
  assert.equal(derived.semanticProgress.filter((row) => row.stream === "messages").length, 0);
}

async function runPhaseFaultMatrix(driver: Driver): Promise<void> {
  const phases: [string, "route" | "derived"][] = [
    ["after-reservation", "route"],
    ["after-durable-record", "route"],
    ["after-durable-phase", "route"],
    ["after-lexical-index", "derived"],
    ["after-semantic-index", "derived"],
    ["after-accepted-commit", "route"],
  ];

  await runSerial(phases, async ([phase, hookKind]) => {
    const device = await enrollConfiguredDevice(driver, `phase-${phase}`);
    const key = `key-${phase}`;
    const suffixKey = `${key}-suffix`;
    const records =
      phase === "after-durable-record"
        ? [
            deviceRecord(key, `content-${phase}`),
            deviceRecord(suffixKey, `content-${phase}-suffix`, { timestamp: "2026-07-16T12:00:01.000Z" }),
          ]
        : [deviceRecord(key, `content-${phase}`)];
    const request = batch(device, nextId("phase"), records);
    const notifications: ClientEventNotification[] = [];
    let fired = false;
    setClientEventEnqueueHook((change: ClientEventNotification) => notifications.push(change));
    const throwOnce = (point: string) => {
      if (!fired && point === phase) {
        fired = true;
        throw new Error("deterministic test phase interruption");
      }
    };
    try {
      if (hookKind === "route") {
        __setDeviceIngestPhaseFaultHookForTest(throwOnce);
      } else {
        __setRecordIndexFaultHookForTest(throwOnce);
      }
      const interrupted = await driver.ingest(device, request);
      assert.equal(interrupted.status, 503, `${phase} must surface only retryable HTTP state`);
      assert.equal(errorCode(interrupted), "device_ingest_retryable");
    } finally {
      __setDeviceIngestPhaseFaultHookForTest(null);
      __setRecordIndexFaultHookForTest(null);
    }

    const beforeSnapshot = await driver.snapshot({
      batchId: request.batch_id,
      device,
      keys: [key, suffixKey],
    });
    const beforeResume = mustExist(beforeSnapshot.outcome, "a reservation outcome must exist before resume");
    const committed = phase !== "after-reservation";
    let expectedPrefix: number;
    if (phase === "after-reservation") {
      expectedPrefix = 0;
    } else if (phase === "after-durable-record") {
      expectedPrefix = 1;
    } else {
      expectedPrefix = records.length;
    }
    const expectedStatus = phase === "after-accepted-commit" ? "accepted" : "processing";
    assert.equal(beforeResume.status, expectedStatus);
    if (beforeResume.status === "processing") {
      assert.equal(beforeResume.accepted_at, null);
      assert.equal(beforeResume.http_status, null);
      assert.equal(beforeResume.response_json, null);
    } else {
      assert.equal(beforeResume.http_status, 201);
      assert.ok(beforeResume.accepted_at);
      assert.ok(beforeResume.response_json);
    }
    assert.equal(Number(beforeResume.durable_prefix_count), expectedPrefix);
    assert.equal(await driver.changes(device.connector_instance_id, key), committed ? 1 : 0);
    assert.equal(
      mustExist(beforeSnapshot.histories[key], "history entry must exist for key").length,
      committed ? 1 : 0
    );
    assert.equal(beforeSnapshot.versionCounter, committed ? 1 : 0);
    assert.equal(
      await driver.changes(device.connector_instance_id, suffixKey),
      phase === "after-durable-record" ? 0 : 0,
      "the durable-record interruption cannot commit an unvisited suffix"
    );
    assert.deepEqual(notificationVersions(notifications), committed ? [1] : []);

    const resumed = await driver.ingest(device, request);
    assert.equal(resumed.status, 201);
    const replay = await driver.ingest(device, request);
    assert.equal(replay.status, 201);
    if (phase === "after-durable-record") {
      const first = mustExist(await driver.record(device.connector_instance_id, key), "first record must exist");
      const second = mustExist(
        await driver.record(device.connector_instance_id, suffixKey),
        "second record must exist"
      );
      assert.deepEqual(
        {
          changes: await driver.versions(device.connector_instance_id),
          firstVersion: first.version,
          secondVersion: second.version,
        },
        { changes: 2, firstVersion: 1, secondVersion: 2 },
        "retry starts at the persisted prefix and only writes the suffix"
      );
      assert.deepEqual(notificationVersions(notifications), [1, 2]);
      assert.equal((await assertOutcomeIdentity(driver, device, request)).durable_prefix_count, 2);
      assert.deepEqual(await driver.lexical(device.connector_instance_id, suffixKey), [
        { field: "content", text: `content-${phase}-suffix` },
      ]);
      assert.deepEqual(await driver.semantic(device.connector_instance_id, suffixKey), [
        { record_key: suffixKey, scope_key: JSON.stringify(["messages", "content"]) },
      ]);
      return;
    }
    await assertAcceptedFinalState(driver, {
      batchId: request.batch_id,
      changes: 1,
      content: `content-${phase}`,
      device,
      key,
      notifications,
      request,
      version: 1,
    });
  });
  setClientEventEnqueueHook(null);
}

interface IdentityConflict {
  column?: "source_instance_id" | "connector_instance_id" | "connector_id" | "batch_seq";
  label: string;
  request?: DeviceBatch;
  value?: string | number;
}

async function runConcurrentIdentityOracle(driver: Driver): Promise<void> {
  const device = await enrollConfiguredDevice(driver, "concurrent-identity");
  const key = "same-identity";
  const request = batch(device, nextId("concurrent"), [deviceRecord(key, "one logical execution")]);
  const notifications: ClientEventNotification[] = [];
  setClientEventEnqueueHook((change: ClientEventNotification) => notifications.push(change));
  const enteredEmbedding = deferred<void>();
  const releaseEmbedding = deferred<void>();
  let heldEmbedding = false;
  driver.setEmbeddingHook(async () => {
    if (!heldEmbedding) {
      heldEmbedding = true;
      enteredEmbedding.resolve();
      await releaseEmbedding.promise;
    }
  });
  try {
    const firstPromise = driver.ingest(device, request);
    await within(enteredEmbedding.promise, "the first identical request to enter embedding");
    let secondSettled = false;
    const secondPromise = driver.ingest(device, request).then((value) => {
      secondSettled = true;
      return value;
    });
    await yieldImmediate();
    assert.equal(secondSettled, false, "the simultaneous replay must wait for the first real HTTP execution");
    releaseEmbedding.resolve();
    const [first, second] = await within(
      Promise.all([firstPromise, secondPromise]),
      "simultaneous identical HTTP requests"
    );
    assert.deepEqual([first.status, second.status].sort(), [201, 201]);
    assert.deepEqual(first.body, second.body, "both requests return the one stored accepted response");
    assert.equal(driver.embeddingCalls(), 1, "same identity performs one semantic execution");
    await assertAcceptedFinalState(driver, {
      batchId: request.batch_id,
      changes: 1,
      content: "one logical execution",
      device,
      key,
      notifications,
      request,
      version: 1,
    });

    const differentRecords = [...request.records, deviceRecord("other-identity", "different verified body")];
    const directIdentityMutations: [
      "source_instance_id" | "connector_instance_id" | "connector_id" | "batch_seq",
      string | number,
    ][] = [
      ["source_instance_id", "other-authorized-source"],
      ["connector_instance_id", "other-authorized-instance"],
      ["connector_id", "other-canonical-connector"],
      ["batch_seq", request.batch_seq + 1],
    ];
    const conflicts: IdentityConflict[] = [
      { label: "body hash", request: { ...request, body_hash: bodyHash(differentRecords), records: differentRecords } },
      ...directIdentityMutations.map(([column, value]) => ({ column, label: column, value })),
    ];
    await runSerial(conflicts, async (conflict) => {
      if (conflict.column) {
        // Source/instance/canonical-id identity is resolved by authorized route
        // context and therefore cannot all be varied in a valid single-device
        // HTTP envelope. Mutate only this existing reservation through the
        // store fixture seam, then prove the shipped HTTP route takes conflict
        // precedence before any work. It is restored immediately afterwards.
        await driver.mutateOutcomeIdentity(device, request.batch_id, conflict.column, conflict.value);
      }
      // The mutation above deliberately changes only one reservation identity
      // member. From that exact setup state, the conflicting HTTP request must
      // be a zero-effect read: outcomes, derived state, and diagnostics are as
      // important here as record versions and notifications.
      const beforeConflict = await driver.snapshot({ batchId: request.batch_id, device, keys: [key] });
      const response = await driver.ingest(device, conflict.request ?? request);
      assert.equal(response.status, 409);
      assert.equal(errorCode(response), "device_batch_conflict");
      const afterConflict = await driver.snapshot({ batchId: request.batch_id, device, keys: [key] });
      assert.deepEqual(
        afterConflict,
        beforeConflict,
        `${conflict.label} conflict has no persistence or diagnostic effect`
      );
      assert.equal(await driver.changes(device.connector_instance_id, key), 1);
      assert.equal(await driver.versions(device.connector_instance_id), 1);
      assert.deepEqual(notificationVersions(notifications), [1]);
      if (conflict.column) {
        const canonicalIdentity: Record<
          "source_instance_id" | "connector_instance_id" | "connector_id" | "batch_seq",
          string | number
        > = {
          batch_seq: request.batch_seq,
          connector_id: "codex",
          connector_instance_id: device.connector_instance_id,
          source_instance_id: device.source_instance_id,
        };
        await driver.mutateOutcomeIdentity(
          device,
          request.batch_id,
          conflict.column,
          canonicalIdentity[conflict.column]
        );
      }
    });
  } finally {
    releaseEmbedding.resolve();
    driver.setEmbeddingHook(null);
    setClientEventEnqueueHook(null);
  }
}

interface DuplicateWriterCase {
  content: string | null;
  deleted: boolean;
  key: string;
  newerContent: string;
}

async function runDuplicateAndNewerWriterOracle(driver: Driver): Promise<void> {
  const cases: [string, DeviceRecord[], DuplicateWriterCase][] = [
    [
      "upsert-to-upsert",
      [
        deviceRecord("duplicate-upsert", "A"),
        deviceRecord("duplicate-upsert", "B", { timestamp: "2026-07-16T12:00:01.000Z" }),
      ],
      { content: "B", deleted: false, key: "duplicate-upsert", newerContent: "newer direct B" },
    ],
    [
      "upsert-to-delete",
      [
        deviceRecord("duplicate-delete", "A"),
        deviceRecord("duplicate-delete", "", { op: "delete", timestamp: "2026-07-16T12:00:01.000Z" }),
      ],
      { content: null, deleted: true, key: "duplicate-delete", newerContent: "newer direct revival" },
    ],
  ];
  await runSerial(cases, async ([label, records, expected]) => {
    const device = await enrollConfiguredDevice(driver, `duplicate-${label}`);
    const request = batch(device, nextId(`duplicate-${label}`), records);
    const notifications: ClientEventNotification[] = [];
    const failurePoints = ["after-lexical-index", "after-semantic-index"];
    let failures = 0;
    setClientEventEnqueueHook((change: ClientEventNotification) => notifications.push(change));
    __setRecordIndexFaultHookForTest((point: string) => {
      if (point === failurePoints[failures]) {
        failures += 1;
        throw new Error(`repeated post-durable index interruption at ${point}`);
      }
    });
    try {
      assert.equal((await driver.ingest(device, request)).status, 503);
      assert.equal((await driver.ingest(device, request)).status, 503);
    } finally {
      __setRecordIndexFaultHookForTest(null);
    }
    const stranded = mustExist(await driver.outcome(device, request.batch_id), "a stranded outcome must exist");
    assert.equal(stranded.status, "processing");
    assert.equal(stranded.durable_prefix_count, 2);
    const beforeNewer = mustExist(
      await driver.record(device.connector_instance_id, expected.key),
      "the durable record must exist before the newer write"
    );
    assert.equal(beforeNewer.deleted, expected.deleted);
    assert.equal(beforeNewer.version, 2);
    assert.equal(await driver.changes(device.connector_instance_id, expected.key), 2);
    assert.deepEqual(notificationVersions(notifications), [1, 2]);
    // Lexical and semantic publish inside ONE atomic version-gated
    // transaction per record (see harden-connector-instance-write-fence-
    // transaction-native): the injected fault fires during the UNLOCKED
    // compute phase, before that transaction ever opens, so neither index
    // family observes a partial write here — both are empty regardless of
    // `expected.deleted`. This replaces the pre-atomicity expectation that
    // lexical alone could land before a fault blocked semantic.
    if (!expected.deleted) {
      assert.equal(beforeNewer.record_json.content, expected.content);
    }
    assert.deepEqual(await driver.lexical(device.connector_instance_id, expected.key), []);
    assert.deepEqual(await driver.semantic(device.connector_instance_id, expected.key), []);

    // The older reservation is deliberately still processing. A newer direct
    // authoritative write now wins before the old retry rereads its final
    // records; the retry may repair indexes but cannot restore A/B or a tombstone.
    await ingestRecord(
      driver.target(device.connector_instance_id),
      directRecord(expected.key, expected.newerContent, { timestamp: "2026-07-16T12:00:02.000Z" })
    );
    assert.equal(
      mustExist(
        await driver.record(device.connector_instance_id, expected.key),
        "record must exist after the newer write"
      ).version,
      3
    );
    assert.equal((await driver.ingest(device, request)).status, 201);
    assert.equal((await driver.ingest(device, request)).status, 201);
    const final = mustExist(
      await driver.record(device.connector_instance_id, expected.key),
      "a final record must exist"
    );
    assert.deepEqual(
      {
        changes: await driver.changes(device.connector_instance_id, expected.key),
        content: final.record_json.content,
        deleted: final.deleted,
        version: final.version,
      },
      { changes: 3, content: expected.newerContent, deleted: false, version: 3 }
    );
    assert.deepEqual(
      notificationVersions(notifications),
      [1, 2, 3],
      "resuming a durable prefix emits no duplicate notification"
    );
    assert.deepEqual(await driver.lexical(device.connector_instance_id, expected.key), [
      { field: "content", text: expected.newerContent },
    ]);
    assert.deepEqual(await driver.semantic(device.connector_instance_id, expected.key), [
      { record_key: expected.key, scope_key: JSON.stringify(["messages", "content"]) },
    ]);
    assert.equal((await assertOutcomeIdentity(driver, device, request)).status, "accepted");
    setClientEventEnqueueHook(null);
  });
}

async function runRepairAndCanonicalOracle(driver: Driver): Promise<void> {
  const device = await enrollConfiguredDevice(driver, "derived-repair");
  const request = batch(device, nextId("repair"), [deviceRecord("repair-key", "repair derived state")]);
  const notifications: ClientEventNotification[] = [];
  setClientEventEnqueueHook((change: ClientEventNotification) => notifications.push(change));
  let failSemantic = true;
  __setRecordIndexFaultHookForTest((point: string) => {
    if (point === "after-lexical-index" && failSemantic) {
      failSemantic = false;
      throw new Error("processing reservation keeps a corruptible derived phase");
    }
  });
  try {
    assert.equal((await driver.ingest(device, request)).status, 503);
  } finally {
    __setRecordIndexFaultHookForTest(null);
  }
  await driver.corruptDerived(device.connector_instance_id, "repair-key");
  assert.deepEqual(await driver.lexical(device.connector_instance_id, "repair-key"), [
    { field: "content", text: "corrupt lexical value" },
  ]);
  assert.deepEqual(await driver.semantic(device.connector_instance_id, "repair-key"), []);
  const corruptOutcome = mustExist(await driver.outcome(device, request.batch_id), "corrupt outcome must exist");
  assert.deepEqual(
    {
      acceptedAt: corruptOutcome.accepted_at,
      prefix: corruptOutcome.durable_prefix_count,
      status: corruptOutcome.status,
    },
    { acceptedAt: null, prefix: 1, status: "processing" }
  );
  assert.equal(await driver.changes(device.connector_instance_id, "repair-key"), 1);
  driver.disableSemanticBackend();
  try {
    const unavailable = await driver.ingest(device, request);
    assert.equal(unavailable.status, 503);
    assert.equal(errorCode(unavailable), "device_ingest_retryable");
    const stranded = mustExist(await driver.outcome(device, request.batch_id), "stranded outcome must exist");
    assert.equal(stranded.status, "processing");
    assert.equal(stranded.durable_prefix_count, 1);
    assert.equal(await driver.changes(device.connector_instance_id, "repair-key"), 1);
    assert.deepEqual(notificationVersions(notifications), [1]);
  } finally {
    driver.restoreSemanticBackend();
  }
  assert.equal((await driver.ingest(device, request)).status, 201);
  await assertAcceptedFinalState(driver, {
    batchId: request.batch_id,
    changes: 1,
    content: "repair derived state",
    device,
    key: "repair-key",
    notifications,
    request,
    version: 1,
  });
  setClientEventEnqueueHook(null);

  const nestedDevice = await enrollConfiguredDevice(driver, "canonical-nested");
  const original = [
    deviceRecord("nested-prefix", "prefix", {
      nested: {
        a: [
          { a: 4, z: 3 },
          { c: 7, d: { a: 5, b: 6 } },
        ],
        z: { a: 1, b: 2 },
      },
    }),
    deviceRecord("nested-suffix", "suffix", {
      nested: { a: true, b: { x: 1, y: 2 } },
      timestamp: "2026-07-16T12:00:03.000Z",
    }),
  ];
  const reordered = [
    deviceRecord("nested-prefix", "prefix", {
      nested: {
        a: [
          { a: 4, z: 3 },
          { c: 7, d: { a: 5, b: 6 } },
        ],
        z: { a: 1, b: 2 },
      },
    }),
    deviceRecord("nested-suffix", "suffix", {
      nested: { a: true, b: { x: 1, y: 2 } },
      timestamp: "2026-07-16T12:00:03.000Z",
    }),
  ];
  const nestedBatch = batch(nestedDevice, nextId("canonical-nested"), original);
  assert.equal(bodyHash(original), bodyHash(reordered));
  __setDeviceIngestPhaseFaultHookForTest((point: string, inputIndex?: number) => {
    if (point === "after-durable-record" && inputIndex === 0) {
      throw new Error("partial prefix");
    }
  });
  try {
    assert.equal((await driver.ingest(nestedDevice, nestedBatch)).status, 503);
  } finally {
    __setDeviceIngestPhaseFaultHookForTest(null);
  }
  const partial = mustExist(await driver.outcome(nestedDevice, nestedBatch.batch_id), "partial outcome must exist");
  assert.deepEqual(
    { acceptedAt: partial.accepted_at, prefix: partial.durable_prefix_count, status: partial.status },
    { acceptedAt: null, prefix: 1, status: "processing" }
  );
  const prefix = mustExist(
    await driver.record(nestedDevice.connector_instance_id, "nested-prefix"),
    "the nested prefix record must exist"
  );
  const originalFirst = mustExist(original[0], "the original batch must carry its first record");
  assert.deepEqual(prefix.record_json, canonical(originalFirst.data));
  if (driver.kind === "sqlite") {
    assert.equal(
      prefix.record_json_raw,
      JSON.stringify(canonical(originalFirst.data)),
      "SQLite stores canonical nested JSON bytes"
    );
  }
  const resumed = { ...nestedBatch, body_hash: bodyHash(reordered), records: reordered };
  assert.equal((await driver.ingest(nestedDevice, resumed)).status, 201);
  assert.equal((await driver.ingest(nestedDevice, nestedBatch)).status, 201);
  assert.equal(await driver.changes(nestedDevice.connector_instance_id, "nested-prefix"), 1);
  assert.equal(await driver.changes(nestedDevice.connector_instance_id, "nested-suffix"), 1);
  const canonicalPrefix = mustExist(
    await driver.record(nestedDevice.connector_instance_id, "nested-prefix"),
    "the canonical prefix record must exist"
  );
  const reorderedFirst = mustExist(reordered[0], "the reordered batch must carry its first record");
  assert.deepEqual(
    canonicalPrefix.record_json,
    canonical(reorderedFirst.data),
    "PostgreSQL JSONB and SQLite JSON agree structurally"
  );
  if (driver.kind === "sqlite") {
    assert.equal(canonicalPrefix.record_json_raw, JSON.stringify(canonical(reorderedFirst.data)));
  }
}

async function runStrandedDiagnosticsOracle(driver: Driver): Promise<void> {
  const device = await enrollConfiguredDevice(driver, "stranded-diagnostics");
  const request = batch(device, nextId("stranded"), [deviceRecord("stranded-key", "not yet accepted")]);
  const initialDiagnostics = await driver.diagnosticsSnapshot(device, device.source_instance_id);
  assert.deepEqual(
    {
      accepted: initialDiagnostics.source.accepted_record_count,
      deviceLastIngestAt: initialDiagnostics.device.last_ingest_at,
      rejected: initialDiagnostics.source.rejected_record_count,
      sourceLastIngestAt: initialDiagnostics.source.last_ingest_at,
    },
    { accepted: 0, deviceLastIngestAt: null, rejected: 0, sourceLastIngestAt: null }
  );
  __setDeviceIngestPhaseFaultHookForTest((point: string, inputIndex?: number) => {
    if (point === "after-durable-record" && inputIndex === 0) {
      throw new Error("strand after durable prefix");
    }
  });
  try {
    assert.equal((await driver.ingest(device, request)).status, 503);
  } finally {
    __setDeviceIngestPhaseFaultHookForTest(null);
  }
  const processing = mustExist(await driver.outcome(device, request.batch_id), "processing outcome must exist");
  assert.deepEqual(
    { acceptedAt: processing.accepted_at, prefix: Number(processing.durable_prefix_count), status: processing.status },
    { acceptedAt: null, prefix: 1, status: "processing" }
  );
  assert.equal(
    mustExist(await driver.record(device.connector_instance_id, "stranded-key"), "stranded record must exist").version,
    1
  );
  assert.equal(await driver.changes(device.connector_instance_id, "stranded-key"), 1);
  const strandedDiagnostics = await driver.diagnosticsSnapshot(device, device.source_instance_id);
  assert.deepEqual(
    {
      accepted: strandedDiagnostics.source.accepted_record_count,
      deviceLastIngestAt: strandedDiagnostics.device.last_ingest_at,
      rejected: strandedDiagnostics.source.rejected_record_count,
      sourceLastIngestAt: strandedDiagnostics.source.last_ingest_at,
    },
    { accepted: 0, deviceLastIngestAt: null, rejected: 0, sourceLastIngestAt: null },
    "a durable processing prefix is neither an accepted nor rejected diagnostic outcome"
  );
  assert.deepEqual(
    diagnosticFreshnessInputs(strandedDiagnostics),
    diagnosticFreshnessInputs(initialDiagnostics),
    "a processing prefix cannot advance any exposed freshness input"
  );
  const processingOutcomes = await driver.outcomes(device);
  assert.deepEqual(
    processingOutcomes.map((outcome) => ({
      acceptedAt: outcome.accepted_at,
      batchId: outcome.batch_id,
      status: outcome.status,
    })),
    [{ acceptedAt: null, batchId: request.batch_id, status: "processing" }]
  );
  assert.deepEqual(
    processingOutcomes.filter((outcome) => ["accepted", "rejected"].includes(outcome.status as string)),
    [],
    "a processing reservation must not have terminal diagnostic membership"
  );

  // The assertions above only prove the shape of a raw row read directly
  // against `device_ingest_batch_outcomes`; they never drive the production
  // ordinary-terminal-list seam a real caller actually uses
  // (`GET /_ref/device-exporters/diagnostics` -> `buildDeviceExporterDiagnostics`
  // -> `store.listBatchOutcomes` -> `aggregateOutcomeStats`, which is an
  // unfiltered list that filters to `status === 'accepted' | 'rejected'` only
  // inside the route's in-memory reducer). Nor is the zero-count assertion
  // above (`strandedDiagnostics.source.accepted_record_count === 0`) sensitive
  // to a broken filter: a stranded `processing` row's `response_json` is null,
  // so it contributes 0 to `accepted_record_count` whether or not the status
  // check is correct. Accept a second, independent batch on the same source
  // while the first stays stranded in `processing`, then re-read diagnostics
  // through the real HTTP route: a filter regression that lets a `processing`
  // row leak into the terminal aggregate (e.g. `status !== 'rejected'` instead
  // of `status === 'accepted'`) would corrupt this non-zero count, so this is
  // a non-vacuous proof that the production seam discriminates correctly.
  const coexisting = batch(device, nextId("stranded-coexisting"), [
    deviceRecord("coexisting-key", "accepted while sibling is stranded"),
  ]);
  assert.equal((await driver.ingest(device, coexisting)).status, 201);
  const coexistingOutcome = mustExist(
    await driver.outcome(device, coexisting.batch_id),
    "coexisting outcome must exist"
  );
  const coexistingAcceptedAt = coexistingOutcome.accepted_at;
  assert.ok(coexistingAcceptedAt);
  const mixedDiagnostics = await driver.diagnosticsSnapshot(device, device.source_instance_id);
  assert.deepEqual(
    {
      accepted: mixedDiagnostics.source.accepted_record_count,
      rejected: mixedDiagnostics.source.rejected_record_count,
      sourceLastIngestAt: mixedDiagnostics.source.last_ingest_at,
    },
    { accepted: 1, rejected: 0, sourceLastIngestAt: coexistingAcceptedAt },
    "the production diagnostics route attributes the accepted sibling batch and nothing from the still-stranded processing batch"
  );
  const mixedOutcomes = await driver.outcomes(device);
  assert.deepEqual(
    mixedOutcomes
      .map((outcome) => ({ batchId: outcome.batch_id as string, status: outcome.status }))
      .sort((a, b) => a.batchId.localeCompare(b.batchId)),
    [
      { batchId: coexisting.batch_id, status: "accepted" },
      { batchId: request.batch_id, status: "processing" },
    ].sort((a, b) => a.batchId.localeCompare(b.batchId)),
    "the stranded batch remains processing while its sibling reaches a terminal status"
  );

  assert.equal((await driver.ingest(device, request)).status, 201);
  const acceptedOutcome = mustExist(await driver.outcome(device, request.batch_id), "accepted outcome must exist");
  const acceptedAt = acceptedOutcome.accepted_at;
  assert.ok(acceptedAt);
  const acceptedDiagnostics = await driver.diagnosticsSnapshot(device, device.source_instance_id);
  assert.deepEqual(
    {
      accepted: acceptedDiagnostics.source.accepted_record_count,
      deviceLastIngestAt: acceptedDiagnostics.device.last_ingest_at,
      rejected: acceptedDiagnostics.source.rejected_record_count,
      sourceLastIngestAt: acceptedDiagnostics.source.last_ingest_at,
    },
    // Two batches are now terminal (`coexisting` accepted earlier, `request`
    // accepted here); the count includes both and freshness tracks whichever
    // accepted_at is later, proving the production seam aggregates across
    // multiple terminal rows rather than merely tolerating a single one.
    { accepted: 2, deviceLastIngestAt: acceptedAt, rejected: 0, sourceLastIngestAt: acceptedAt },
    "diagnostics derive acceptance exactly from the persisted terminal timestamp"
  );
  assert.deepEqual(
    diagnosticFreshnessInputs(acceptedDiagnostics),
    diagnosticFreshnessInputs(initialDiagnostics),
    "acceptance changes ingest recency, not heartbeat/outbox/coverage freshness inputs"
  );
  assert.deepEqual(
    (await driver.outcomes(device))
      .map((outcome) => ({
        acceptedAt: outcome.accepted_at,
        batchId: outcome.batch_id as string,
        status: outcome.status,
      }))
      .sort((a, b) => a.batchId.localeCompare(b.batchId)),
    [
      { acceptedAt: coexistingAcceptedAt, batchId: coexisting.batch_id, status: "accepted" },
      { acceptedAt, batchId: request.batch_id, status: "accepted" },
    ].sort((a, b) => a.batchId.localeCompare(b.batchId))
  );
  const beforeReplay = await driver.snapshot({ batchId: request.batch_id, device, keys: ["stranded-key"] });
  assert.equal((await driver.ingest(device, request)).status, 201);
  const afterReplay = await driver.snapshot({ batchId: request.batch_id, device, keys: ["stranded-key"] });
  assert.deepEqual(afterReplay, beforeReplay, "accepted replay cannot change diagnostics or persisted state");
}

async function generationManifests(
  driver: Driver
): Promise<{ m1: ConnectorManifestMutable; m2: ConnectorManifestMutable }> {
  const m1 = await configureMessagesManifest(driver, (messages, manifest) => {
    Reflect.deleteProperty(manifest, "storage_binding");
    messages.primary_key = ["id"];
    messages.cursor_field = "timestamp";
    messages.consent_time_field = "timestamp";
    messages.schema.properties.updated_at = { format: "date-time", type: "string" };
    messages.query.search.lexical_fields = ["content"];
    messages.query.search.semantic_fields = ["content"];
  });
  const m2 = structuredClone(m1);
  const stream = mustExist(
    m2.streams.find((entry) => entry.name === "messages"),
    "M2 clone must retain messages"
  );
  stream.primary_key = ["session_id"];
  stream.cursor_field = "updated_at";
  stream.consent_time_field = "updated_at";
  stream.query.search.lexical_fields = ["role"];
  stream.query.search.semantic_fields = ["role"];
  return { m1, m2 };
}

function generationRecord(
  key: string,
  content: string,
  timestamp = "2026-07-16T12:00:00.000Z",
  sessionId = key
): DeviceRecord {
  return deviceRecord(key, content, {
    fields: {
      // Keep the key valid under both M1 and M2 so a retry can refresh only
      // frozen manifest facts rather than allocating a replacement record.
      session_id: sessionId,
      updated_at: "2026-07-16T14:00:00.000Z",
    },
    timestamp,
  });
}

interface AssertM2GenerationFinalArgs {
  device: EnrolledDevice;
  expectedChanges?: number;
  expectedPrimary?: string;
  key: string;
  m1Fingerprint?: unknown;
  notifications: ClientEventNotification[];
  notificationVersionsExpected?: number[];
  request: DeviceBatch;
}

async function assertM2GenerationFinal(
  driver: Driver,
  {
    device,
    request,
    key,
    notifications,
    expectedChanges = 1,
    expectedPrimary = key,
    notificationVersionsExpected = Array.from({ length: expectedChanges }, (_, index) => index + 1),
    m1Fingerprint = null,
  }: AssertM2GenerationFinalArgs
): Promise<void> {
  const outcome = await assertOutcomeIdentity(driver, device, request);
  assert.equal(outcome.status, "accepted");
  assert.equal(outcome.http_status, 201);
  assert.ok(outcome.accepted_at);
  assert.equal(outcome.durable_prefix_count, outcome.record_count);
  if (m1Fingerprint) {
    assert.notEqual(outcome.manifest_fingerprint, m1Fingerprint, "accepted retry records the M2 generation");
  }
  const row = mustExist(await driver.record(device.connector_instance_id, key), "M2 record must exist");
  assert.deepEqual(
    {
      changes: await driver.changes(device.connector_instance_id, key),
      cursor: row.cursor_value,
      primary: row.primary_key_text,
      semanticTime: row.semantic_time,
      version: row.version,
    },
    {
      changes: expectedChanges,
      cursor: "2026-07-16T14:00:00.000Z",
      primary: expectedPrimary,
      semanticTime: "2026-07-16T14:00:00.000Z",
      version: expectedChanges,
    }
  );
  assert.deepEqual(await driver.lexical(device.connector_instance_id, key), [{ field: "role", text: "user" }]);
  assert.deepEqual(await driver.semantic(device.connector_instance_id, key), [
    { record_key: key, scope_key: JSON.stringify(["messages", "role"]) },
  ]);
  assert.deepEqual(notificationVersions(notifications), notificationVersionsExpected);
  const derived = await driver.derivedState(device.connector_instance_id);
  assert.equal(derived.lexicalMeta.filter((entry) => entry.stream === "messages").length, 1);
  assert.equal(derived.semanticMeta.filter((entry) => entry.stream === "messages").length, 1);
  assert.equal(derived.semanticProgress.filter((entry) => entry.stream === "messages").length, 0);
}

async function assertPostgresRegistrationStreamIsolation(driver: Driver): Promise<void> {
  if (driver.kind !== "postgres") {
    return;
  }

  const device = await driver.enroll("registration-stream-isolation");
  const { m2 } = await generationManifests(driver);
  const key = "same-key-in-two-streams";
  await ingestRecord(driver.target(device.connector_instance_id), {
    data: {
      id: key,
      last_event_at: "2026-07-16T12:01:00.000Z",
      started_at: "2026-07-16T12:02:00.000Z",
    },
    emitted_at: "2026-07-16T12:00:00.000Z",
    key,
    op: "upsert",
    stream: "sessions",
  });
  await ingestRecord(
    driver.target(device.connector_instance_id),
    directRecord(key, "message remains independent", {
      fields: {
        session_id: "message-primary-key",
        updated_at: "2026-07-16T12:04:00.000Z",
      },
    })
  );

  // This is the public registration path. M2 changes the messages sort facts
  // while sessions keeps its declared facts. The two rows intentionally share
  // record_key, which proves repair writes must retain stream in their identity.
  await driver.registerManifest(m2);
  const session = mustExist(
    await driver.record(device.connector_instance_id, key, "sessions"),
    "sessions record must exist"
  );
  const message = mustExist(
    await driver.record(device.connector_instance_id, key, "messages"),
    "messages record must exist"
  );
  assert.deepEqual(
    {
      cursor: session.cursor_value,
      primaryKey: session.primary_key_text,
      semanticTime: session.semantic_time,
    },
    {
      cursor: "2026-07-16T12:01:00.000Z",
      primaryKey: key,
      semanticTime: "2026-07-16T12:02:00.000Z",
    },
    "messages registration repair cannot overwrite sessions sort facts with the same record key"
  );
  assert.deepEqual(
    {
      cursor: message.cursor_value,
      primaryKey: message.primary_key_text,
      semanticTime: message.semantic_time,
    },
    {
      cursor: "2026-07-16T12:04:00.000Z",
      primaryKey: "message-primary-key",
      semanticTime: "2026-07-16T12:04:00.000Z",
    }
  );
}

async function runManifestRegistrationOracle(driver: Driver): Promise<void> {
  // M1 gets a durable prefix, then M2 performs its complete shipped
  // registration/backfill before the old reservation retries.
  const afterDevice = await driver.enroll("manifest-registration-last");
  const { m1, m2 } = await generationManifests(driver);
  const afterRequest = batch(afterDevice, nextId("manifest-registration-last"), [
    generationRecord("manifest-last", "after device"),
  ]);
  const afterNotifications: ClientEventNotification[] = [];
  setClientEventEnqueueHook((change: ClientEventNotification) => afterNotifications.push(change));
  __setDeviceIngestPhaseFaultHookForTest((point: string) => {
    if (point === "after-durable-phase") {
      throw new Error("hold M1 after durable phase");
    }
  });
  try {
    assert.equal((await driver.ingest(afterDevice, afterRequest)).status, 503);
  } finally {
    __setDeviceIngestPhaseFaultHookForTest(null);
  }
  const m1Outcome = await assertOutcomeIdentity(driver, afterDevice, afterRequest, { status: "processing" });
  assert.equal(m1Outcome.durable_prefix_count, 1);
  await driver.registerManifest(m2);
  assert.equal((await driver.ingest(afterDevice, afterRequest)).status, 201);
  await assertM2GenerationFinal(driver, {
    device: afterDevice,
    key: "manifest-last",
    m1Fingerprint: m1Outcome.manifest_fingerprint,
    notifications: afterNotifications,
    request: afterRequest,
  });
  setClientEventEnqueueHook(null);

  // The inverse ordering queues complete M2 registration/backfill before the
  // M1-origin request can enter the same instance fence.
  const beforeDevice = await driver.enroll("manifest-registration-first");
  await driver.registerManifest(m1);
  await ingestRecord(driver.target(beforeDevice.connector_instance_id), {
    data: {
      id: "registration-order-seed",
      last_event_at: "2026-07-16T11:00:00.000Z",
      started_at: "2026-07-16T10:00:00.000Z",
    },
    emitted_at: "2026-07-16T11:00:00.000Z",
    key: "registration-order-seed",
    op: "upsert",
    stream: "sessions",
  });
  const m2BackfillAtTarget = deferred<void>();
  const releaseM2Backfill = deferred<void>();
  const pauseM2AtTarget = async (point: string, context: Record<string, unknown>) => {
    if (point === "inside-instance-fence" && context.connectorInstanceId === beforeDevice.connector_instance_id) {
      m2BackfillAtTarget.resolve();
      await releaseM2Backfill.promise;
    }
  };
  if (driver.kind === "postgres") {
    __setPostgresRecordSortBackfillPhaseHookForTest(pauseM2AtTarget);
  } else {
    __setSqliteRecordSortBackfillPhaseHookForTest(pauseM2AtTarget);
  }
  let inverseRegistration: Promise<void> | undefined;
  try {
    inverseRegistration = driver.registerManifest(m2);
    await within(m2BackfillAtTarget.promise, "M2 sort backfill to own the target instance");
    // Registration owns the same-instance fence before the device request is
    // issued, so this is a deterministic registration-first order.
    const beforeRequest = batch(beforeDevice, nextId("manifest-registration-first"), [
      generationRecord("manifest-first", "before device"),
    ]);
    const beforeNotifications: ClientEventNotification[] = [];
    setClientEventEnqueueHook((change: ClientEventNotification) => beforeNotifications.push(change));
    const devicePromise = driver.ingest(beforeDevice, beforeRequest);
    releaseM2Backfill.resolve();
    await within(inverseRegistration, "registration-first M2 backfills");
    assert.equal((await within(devicePromise, "device ingest queued behind M2 registration")).status, 201);
    await assertM2GenerationFinal(driver, {
      device: beforeDevice,
      key: "manifest-first",
      notifications: beforeNotifications,
      request: beforeRequest,
    });
    setClientEventEnqueueHook(null);
  } finally {
    releaseM2Backfill.resolve();
    __setLexicalBackfillPhaseHookForTest(null);
    __setSqliteRecordSortBackfillPhaseHookForTest(null);
    __setPostgresRecordSortBackfillPhaseHookForTest(null);
    await Promise.allSettled([inverseRegistration].filter(Boolean));
  }

  // Once M1 is terminal, M2's actual registration/backfill is explicitly the
  // final writer: it must refresh durable sort facts as well as both indexes.
  const terminalDevice = await driver.enroll("manifest-terminal-before-m2");
  await driver.registerManifest(m1);
  const terminalRequest = batch(terminalDevice, nextId("manifest-terminal-before-m2"), [
    generationRecord(
      "manifest-terminal",
      "accepted under M1",
      "2026-07-16T12:00:00.000Z",
      "manifest-terminal-m2-primary"
    ),
  ]);
  const terminalNotifications: ClientEventNotification[] = [];
  setClientEventEnqueueHook((change: ClientEventNotification) => terminalNotifications.push(change));
  assert.equal((await driver.ingest(terminalDevice, terminalRequest)).status, 201);
  await driver.registerManifest(m2);
  await assertM2GenerationFinal(driver, {
    device: terminalDevice,
    expectedPrimary: "manifest-terminal-m2-primary",
    key: "manifest-terminal",
    notifications: terminalNotifications,
    request: terminalRequest,
  });
  setClientEventEnqueueHook(null);

  // This is the literal mid-prefix drift case: M2 is persisted after record
  // zero and before record one. Registration is paused only after persistence
  // so the held M1 attempt reaches its generation-fenced acceptance and fails;
  // its real backfills then finish before the no-prefix-replay retry.
  const midDevice = await driver.enroll("manifest-mid-prefix");
  await driver.registerManifest(m1);
  const midRequest = batch(midDevice, nextId("manifest-mid-prefix"), [
    generationRecord("manifest-mid-prefix", "first durable"),
    generationRecord("manifest-mid-suffix", "second durable", "2026-07-16T12:00:01.000Z"),
  ]);
  const midPersisted = deferred<void>();
  const releaseMidBackfill = deferred<void>();
  let midRegistration: Promise<void> | undefined;
  let registered = false;
  const midNotifications: ClientEventNotification[] = [];
  setClientEventEnqueueHook((change: ClientEventNotification) => midNotifications.push(change));
  __setRegisterConnectorPhaseHookForTest(async (point: string) => {
    if (point === "after-manifest-persisted") {
      midPersisted.resolve();
      await releaseMidBackfill.promise;
    }
  });
  __setDeviceIngestPhaseFaultHookForTest(async (point: string, inputIndex?: number) => {
    if (point === "after-durable-record" && inputIndex === 0 && !registered) {
      registered = true;
      midRegistration = driver.registerManifest(m2);
      await within(midPersisted.promise, "mid-prefix M2 manifest persistence");
    }
  });
  try {
    assert.equal((await driver.ingest(midDevice, midRequest)).status, 503, "M1 cannot accept after M2 persists");
  } finally {
    __setDeviceIngestPhaseFaultHookForTest(null);
    releaseMidBackfill.resolve();
    await within(Promise.allSettled([midRegistration].filter(Boolean)), "mid-prefix M2 backfills");
    __setRegisterConnectorPhaseHookForTest(null);
  }
  const midOutcome = mustExist(await driver.outcome(midDevice, midRequest.batch_id), "mid outcome must exist");
  assert.deepEqual(
    { acceptedAt: midOutcome.accepted_at, prefix: midOutcome.durable_prefix_count, status: midOutcome.status },
    { acceptedAt: null, prefix: 2, status: "processing" }
  );
  assert.equal(await driver.changes(midDevice.connector_instance_id, "manifest-mid-prefix"), 1);
  assert.equal(await driver.changes(midDevice.connector_instance_id, "manifest-mid-suffix"), 1);
  assert.deepEqual(notificationVersions(midNotifications), [1, 2]);
  assert.equal((await driver.ingest(midDevice, midRequest)).status, 201);
  await assertM2GenerationFinal(driver, {
    device: midDevice,
    key: "manifest-mid-prefix",
    m1Fingerprint: midOutcome.manifest_fingerprint,
    notifications: midNotifications,
    notificationVersionsExpected: [1, 2],
    request: midRequest,
  });
  const midSuffix = mustExist(
    await driver.record(midDevice.connector_instance_id, "manifest-mid-suffix"),
    "mid suffix record must exist"
  );
  assert.deepEqual(
    {
      cursor: midSuffix.cursor_value,
      primary: midSuffix.primary_key_text,
      semanticTime: midSuffix.semantic_time,
      version: midSuffix.version,
    },
    {
      cursor: "2026-07-16T14:00:00.000Z",
      primary: "manifest-mid-suffix",
      semanticTime: "2026-07-16T14:00:00.000Z",
      version: 2,
    }
  );
  assert.deepEqual(await driver.lexical(midDevice.connector_instance_id, "manifest-mid-suffix"), [
    { field: "role", text: "user" },
  ]);
  assert.deepEqual(await driver.semantic(midDevice.connector_instance_id, "manifest-mid-suffix"), [
    { record_key: "manifest-mid-suffix", scope_key: JSON.stringify(["messages", "role"]) },
  ]);
  assert.deepEqual(notificationVersions(midNotifications), [1, 2]);
  setClientEventEnqueueHook(null);

  await assertPostgresRegistrationStreamIsolation(driver);
}

function collisionHistory(...deletedByVersion: boolean[]) {
  return deletedByVersion.map((deleted, index) => ({ deleted, version: index + 1 }));
}

interface ActiveCollisionArgs {
  content: string;
  history: Array<{ version: number; deleted: boolean }>;
  notifications: number[];
  outcomeStatus: string | null;
  version: number;
}

function activeCollisionExpected({ content, version, history, notifications, outcomeStatus }: ActiveCollisionArgs) {
  return {
    derived: { lexicalMeta: 1, semanticMeta: 1, semanticProgress: 0 },
    history,
    lexical: [{ field: "content", text: content }],
    notifications,
    outcomeStatus,
    record: {
      content,
      cursor: "2026-07-16T12:00:00.000Z",
      deleted: false,
      primary: "collision",
      semanticTime: "2026-07-16T12:00:00.000Z",
      version,
    },
    semantic: [
      {
        embedding: normalizedVector(vectorForText(content)),
        record_key: "collision",
        scope_key: JSON.stringify(["messages", "content"]),
      },
    ],
    versionCounter: version,
  };
}

interface DeletedCollisionArgs {
  history: Array<{ version: number; deleted: boolean }>;
  notifications: number[];
  outcomeStatus: string | null;
  version: number;
}

function deletedCollisionExpected({ version, history, notifications, outcomeStatus }: DeletedCollisionArgs) {
  return {
    derived: { lexicalMeta: 1, semanticMeta: 1, semanticProgress: 0 },
    history,
    lexical: [],
    notifications,
    outcomeStatus,
    record: { deleted: true, version },
    semantic: [],
    versionCounter: version,
  };
}

interface AbsentCollisionArgs {
  notifications: number[];
  outcomeStatus: string | null;
}

function absentCollisionExpected({ notifications, outcomeStatus }: AbsentCollisionArgs) {
  return {
    derived: { lexicalMeta: 0, semanticMeta: 0, semanticProgress: 0 },
    history: [],
    lexical: [],
    notifications,
    outcomeStatus,
    record: null,
    semantic: [],
    versionCounter: 0,
  };
}

async function collisionSnapshot(
  driver: Driver,
  device: EnrolledDevice,
  request: DeviceBatch,
  notifications: ClientEventNotification[]
) {
  const row = await driver.record(device.connector_instance_id, "collision");
  const derived = await driver.derivedState(device.connector_instance_id);
  const outcome = await driver.outcome(device, request.batch_id);
  let record: Record<string, unknown> | null;
  if (row === null) {
    record = null;
  } else if (row.deleted) {
    record = { deleted: true, version: row.version };
  } else {
    record = {
      content: row.record_json.content,
      cursor: row.cursor_value,
      deleted: false,
      primary: row.primary_key_text,
      semanticTime: row.semantic_time,
      version: row.version,
    };
  }
  return {
    derived: {
      lexicalMeta: derived.lexicalMeta.filter((entry) => entry.stream === "messages").length,
      semanticMeta: derived.semanticMeta.filter((entry) => entry.stream === "messages").length,
      semanticProgress: derived.semanticProgress.filter((entry) => entry.stream === "messages").length,
    },
    history: await driver.history(device.connector_instance_id, "collision"),
    lexical: await driver.lexical(device.connector_instance_id, "collision"),
    notifications: notificationVersions(
      notifications.filter((change) => change.connectorInstanceId === device.connector_instance_id)
    ),
    outcomeStatus: outcome?.status ?? null,
    record,
    semantic: await driver.semanticWithEmbedding(device.connector_instance_id, "collision"),
    versionCounter: await driver.versions(device.connector_instance_id),
  };
}

function firstCollisionExpected(writerName: string, order: string) {
  if (order === "device-first") {
    return activeCollisionExpected({
      content: "device final",
      history: collisionHistory(false, false),
      notifications: [2],
      outcomeStatus: "accepted",
      version: 2,
    });
  }
  // order === "direct-first": the device batch is the SECOND writer, still
  // queued behind the direct writer's per-record connector-instance fence —
  // but its reservation row (`device_ingest_batch_outcomes`) is no longer
  // gated by that same fence (see `withDeviceIngestBatchAttempt`'s header in
  // ref-device-exporters.ts): reservation bookkeeping is self-serialized on
  // BATCH identity, not connector-instance identity, so it can and does run
  // concurrently with an in-flight direct writer on the same instance. The
  // reservation touches no shared record state, so "processing" is visible
  // here even though no record mutation has happened yet — this is the
  // correct, intended effect of no longer holding a batch-duration
  // connector-instance-wide fence (see
  // harden-connector-instance-write-fence-transaction-native).
  if (writerName === "direct-upsert") {
    return activeCollisionExpected({
      content: "direct final",
      history: collisionHistory(false, false),
      notifications: [2],
      outcomeStatus: "processing",
      version: 2,
    });
  }
  if (writerName === "direct-delete") {
    return deletedCollisionExpected({
      history: collisionHistory(false, true),
      notifications: [],
      outcomeStatus: "processing",
      version: 2,
    });
  }
  if (writerName === "stream-delete") {
    return absentCollisionExpected({ notifications: [], outcomeStatus: "processing" });
  }
  return activeCollisionExpected({
    content: "initial state",
    history: collisionHistory(false),
    notifications: [],
    outcomeStatus: "processing",
    version: 1,
  });
}

function finalCollisionExpected(writerName: string, order: string) {
  if (order === "direct-first") {
    if (writerName === "stream-delete") {
      return activeCollisionExpected({
        content: "device final",
        history: collisionHistory(false),
        notifications: [1],
        outcomeStatus: "accepted",
        version: 1,
      });
    }
    let history: ReturnType<typeof collisionHistory>;
    if (writerName === "direct-delete") {
      history = collisionHistory(false, true, false);
    } else if (writerName === "direct-upsert") {
      history = collisionHistory(false, false, false);
    } else {
      history = collisionHistory(false, false);
    }
    let notifications: number[];
    if (writerName === "direct-delete") {
      notifications = [3];
    } else if (history.length === 3) {
      notifications = [2, 3];
    } else {
      notifications = [2];
    }
    return activeCollisionExpected({
      content: "device final",
      history,
      notifications,
      outcomeStatus: "accepted",
      version: history.length,
    });
  }
  if (writerName === "direct-upsert") {
    return activeCollisionExpected({
      content: "direct final",
      history: collisionHistory(false, false, false),
      notifications: [2, 3],
      outcomeStatus: "accepted",
      version: 3,
    });
  }
  if (writerName === "direct-delete") {
    return deletedCollisionExpected({
      history: collisionHistory(false, false, true),
      notifications: [2],
      outcomeStatus: "accepted",
      version: 3,
    });
  }
  if (writerName === "stream-delete") {
    return absentCollisionExpected({ notifications: [2], outcomeStatus: "accepted" });
  }
  return activeCollisionExpected({
    content: "device final",
    history: collisionHistory(false, false),
    notifications: [2],
    outcomeStatus: "accepted",
    version: 2,
  });
}

interface WriterCollisionTarget {
  connector_id: string;
  connector_instance_id: string;
}

interface WriterCollisionCase {
  apply: (target: WriterCollisionTarget, manifest: ConnectorManifestMutable) => Promise<unknown>;
  name: string;
}

async function runWriterCollisionOracle(driver: Driver): Promise<void> {
  // Lexical and semantic manifest backfills intentionally do not hold the
  // connector-instance admission fence across their scans. Their bounded
  // per-page write coordination is covered by the dedicated backfill tests;
  // this matrix covers writers that participate in admission ordering.
  const writers: WriterCollisionCase[] = [
    {
      apply: async (target) => await ingestRecord(target, directRecord("collision", "direct final")),
      name: "direct-upsert",
    },
    {
      apply: async (target) => await deleteRecord(target, "messages", "collision"),
      name: "direct-delete",
    },
    {
      apply: async (target) => await deleteAllRecords(target, "messages"),
      name: "stream-delete",
    },
  ];

  const work = writers.flatMap((writer) =>
    (["device-first", "direct-first"] as const).map((order) => [writer, order] as const)
  );
  await runSerial(work, async ([writer, order]) => {
    const device = await driver.enroll(`${writer.name}-${order}`);
    const sibling = await driver.enroll(`${writer.name}-${order}-sibling`);
    await configureMessagesManifest(driver);
    const manifest = (await driver.manifest()) as ConnectorManifestMutable;
    manifest.storage_binding = { connector_instance_id: device.connector_instance_id };
    const target = driver.target(device.connector_instance_id);
    await ingestRecord(target, directRecord("collision", "initial state"));
    const notifications: ClientEventNotification[] = [];
    setClientEventEnqueueHook((change: ClientEventNotification) => notifications.push(change));
    const request = batch(device, nextId(`${writer.name}-${order}`), [deviceRecord("collision", "device final")]);
    const holderRelease = deferred<void>();
    const holderEntered = deferred<void>();
    const holder = withConnectorInstanceWrite(device.connector_instance_id, async () => {
      holderEntered.resolve();
      await holderRelease.promise;
    });
    await within(holderEntered.promise, `${writer.name} ordering holder`);

    const firstEnqueued = deferred<void>();
    const secondEnqueued = deferred<void>();
    const secondAcquired = deferred<void>();
    const releaseSecond = deferred<void>();
    let enqueued = 0;
    let acquired = 0;
    __setConnectorInstanceWritePhaseHookForTest(async (stage, context) => {
      if (context.connectorInstanceId !== device.connector_instance_id) {
        return;
      }
      if (stage === "before_key_acquire") {
        enqueued += 1;
        if (enqueued === 1) {
          firstEnqueued.resolve();
        }
        if (enqueued === 2) {
          secondEnqueued.resolve();
        }
        return;
      }
      acquired += 1;
      if (acquired === 2) {
        secondAcquired.resolve();
        await releaseSecond.promise;
      }
    });

    let firstPromise: Promise<unknown> | undefined;
    let secondPromise: Promise<unknown> | undefined;
    let deviceResult: JsonResponse | undefined;
    try {
      const deviceOperation = async () => {
        const result = await driver.ingest(device, request);
        deviceResult = result;
        return result;
      };
      const directOperation = async () => await writer.apply(target, manifest);
      firstPromise = order === "device-first" ? deviceOperation() : directOperation();
      await within(firstEnqueued.promise, `${writer.name} first writer enqueue`);
      secondPromise = order === "device-first" ? directOperation() : deviceOperation();
      await within(secondEnqueued.promise, `${writer.name} second writer enqueue`);

      const siblingRequest = batch(sibling, nextId("sibling-overlap"), [deviceRecord("sibling", "overlaps")]);
      assert.equal(
        (await driver.ingest(sibling, siblingRequest)).status,
        201,
        "different instances continue while both target writers are queued"
      );
      const siblingRow = mustExist(
        await driver.record(sibling.connector_instance_id, "sibling"),
        "sibling record must exist"
      );
      assert.equal(siblingRow.record_json.content, "overlaps");

      holderRelease.resolve();
      await within(
        Promise.all([holder, firstPromise, secondAcquired.promise]),
        `${writer.name} first writer completion and second-writer barrier`
      );
      await within(
        waitForDeferredIndexWorkToDrain(),
        `${writer.name} ${order} deferred index work draining after the first writer`
      );
      assert.deepEqual(
        await collisionSnapshot(driver, device, request, notifications),
        firstCollisionExpected(writer.name, order),
        `${writer.name} ${order} state at the first writer acknowledgement`
      );

      releaseSecond.resolve();
      await within(secondPromise, `${writer.name} second writer completion`);
      assert.equal(mustExist(deviceResult, "device result must exist").status, 201);
      await within(
        waitForDeferredIndexWorkToDrain(),
        `${writer.name} ${order} deferred index work draining after the second writer`
      );
      assert.deepEqual(
        await collisionSnapshot(driver, device, request, notifications),
        finalCollisionExpected(writer.name, order),
        `${writer.name} ${order} state at the second writer acknowledgement`
      );
    } finally {
      holderRelease.resolve();
      releaseSecond.resolve();
      __setConnectorInstanceWritePhaseHookForTest(null);
      await Promise.allSettled([holder, firstPromise, secondPromise].filter(Boolean));
    }
    const coordinator = connectorInstanceWriteCoordinatorStatsForTests();
    assert.deepEqual(
      {
        activeOwnerships: coordinator.activeOwnerships,
        activeWriters: coordinator.activeWriters,
        queuedWriters: coordinator.queuedWriters,
      },
      { activeOwnerships: 0, activeWriters: 0, queuedWriters: 0 }
    );
    setClientEventEnqueueHook(null);
  });
}

/**
 * Adversarial oracles for the version-gated derived-index publication CAS
 * (harden-connector-instance-write-fence-transaction-native's stale-overwrite
 * fix).
 *
 * Mechanism note (why these two shapes, not a generic "pause any writer"):
 * every per-record index-maintenance job for one connector instance —
 * whether from `ingestRecord`'s HTTP path or a device batch's final-plan
 * step — runs inside ONE per-instance FIFO tail chain
 * (`enqueueConnectorInstanceIndexWork`), which serializes compute+publish
 * end-to-end. Two jobs already enqueued into that lane therefore cannot have
 * their publishes overlap — the lane itself prevents that. The real,
 * reachable race has two distinct shapes instead:
 *
 * 1. `deleteRecord` (owner HTTP single-record delete) calls
 *    `maintainRecordIndexes` DIRECTLY and synchronously, bypassing the lane
 *    entirely (matching its pre-existing, un-laned behavior). This can run
 *    concurrently with an in-flight LANED publish for the same key.
 * 2. A device batch's derived-index step enqueues onto the lane only AFTER
 *    `finalDeviceRecordPlan`/`prepareDeviceFinalRecords` run (a real,
 *    structurally-necessary gap after the batch's own durable commits) — so
 *    ENQUEUE order can invert relative to COMMIT order: an older commit's
 *    enqueue can land, and therefore run, AFTER a newer same-key commit's
 *    enqueue+run already completed. Forced here by pausing at the device
 *    route's existing `"after-durable-phase"` fault hook (durable commits
 *    done, enqueue not yet issued).
 *
 * Both are exercised below; a lock-around-embedding regression guard and a
 * crash/sweep-backstop case round out the required oracle set.
 */
async function runVersionCasOracle(driver: Driver): Promise<void> {
  const target = (device: EnrolledDevice) => driver.target(device.connector_instance_id);

  await runSerial(
    [
      "delete-bypass-races-newer-upsert",
      "http-batch-lane-races-newer-delete",
      "device-commit-before-enqueue-inversion-upsert",
      "device-commit-before-enqueue-inversion-mixed-family",
      "device-stale-delete-vs-live-upsert",
      "device-stale-upsert-vs-live-delete",
      "crash-mid-publish-sweep-backstop",
      "no-lock-around-embedding",
      "device-retry-version-monotonicity",
    ] as const,
    async (caseName) => {
      const device = await enrollConfiguredDevice(driver, `version-cas-${caseName}`);
      const key = "version-cas-key";

      if (caseName === "delete-bypass-races-newer-upsert") {
        // `deleteRecord` holds the connector-instance write fence across its
        // OWN inline `maintainRecordIndexes` call (pre-existing behavior —
        // the old unguarded index-delete calls ran inline there too), so it
        // can never overlap a same-instance `ingestRecord`'s DURABLE write —
        // the fence already serializes those. What it DOES bypass is the
        // per-instance derived-work LANE: an earlier upsert's publish can
        // still be sitting in the lane, not yet run, when a delete for the
        // SAME key later commits and runs its own un-laned publish
        // immediately. Seed the row (v1) with its lane publish paused at the
        // version seam; delete it (v2, un-laned) to completion; then release
        // the seed's stale v1 publish. The stale publish must discard
        // itself, not resurrect content over the newer delete.
        const seedStalledAtSeam = deferred<void>();
        const releaseSeed = deferred<void>();
        __setIndexPublishPhaseHookForTest(async (point: string, context: Record<string, unknown>) => {
          if (point === "before-publish-transaction" && context.op === "upsert" && context.expectedVersion === 1) {
            seedStalledAtSeam.resolve();
            await releaseSeed.promise;
          }
        });
        try {
          const seedPromise = ingestRecord(target(device), directRecord(key, "seed"));
          await within(seedStalledAtSeam.promise, "the seed's lane publish stalled at its version seam");
          await deleteRecord(target(device), "messages", key);
          releaseSeed.resolve();
          await within(seedPromise, "the seed's ingestRecord call completes");
          await within(waitForDeferredIndexWorkToDrain(), "the stale seed publish attempt drains");
        } finally {
          __setIndexPublishPhaseHookForTest(null);
          releaseSeed.resolve();
        }
        const record = mustExist(await driver.record(device.connector_instance_id, key), "record must exist");
        assert.equal(record.deleted, true, "the newer, un-laned delete is authoritative");
        assert.deepEqual(
          await driver.lexical(device.connector_instance_id, key),
          [],
          "the stale seed publish must not resurrect content the newer delete already removed"
        );
        assert.deepEqual(await driver.semanticWithEmbedding(device.connector_instance_id, key), []);
        return;
      }

      if (caseName === "http-batch-lane-races-newer-delete") {
        // Same mechanism, exercised through the HTTP BATCH path
        // (`ingestRecords`) instead of the single-record path — a distinct
        // shared choke point (`runDeferredRecordIndexes`) that also
        // schedules onto the per-instance lane, fire-and-forget, after its
        // own durable batch commits. Seed the row (v1); a one-record batch
        // upsert (v2) commits durably, its lane publish paused at the
        // version seam; then the un-laned `deleteRecord` (v3) fully
        // commits+publishes. The batch's stale v2 publish must, on resuming,
        // discard itself rather than resurrect content the newer delete
        // already removed.
        await ingestRecord(target(device), directRecord(key, "seed"));
        await within(waitForDeferredIndexWorkToDrain(), "seed publish drains");
        const batchStalledAtSeam = deferred<void>();
        const releaseBatch = deferred<void>();
        __setIndexPublishPhaseHookForTest(async (point: string, context: Record<string, unknown>) => {
          if (point === "before-publish-transaction" && context.op === "upsert" && context.expectedVersion === 2) {
            batchStalledAtSeam.resolve();
            await releaseBatch.promise;
          }
        });
        try {
          const batchPromise = ingestRecords(target(device), [
            { data: { content: "batch-content", id: key }, key, op: "upsert", stream: "messages" },
          ]);
          await within(batchStalledAtSeam.promise, "the batch's lane publish stalled at its version seam");
          await deleteRecord(target(device), "messages", key);
          releaseBatch.resolve();
          await within(batchPromise, "the batch call completes");
          await within(waitForDeferredIndexWorkToDrain(), "the batch's stale publish attempt drains");
        } finally {
          __setIndexPublishPhaseHookForTest(null);
          releaseBatch.resolve();
        }
        const record = mustExist(await driver.record(device.connector_instance_id, key), "record must exist");
        assert.equal(record.deleted, true, "the newer, un-laned delete is authoritative");
        assert.deepEqual(
          await driver.lexical(device.connector_instance_id, key),
          [],
          "the batch's stale publish must not resurrect content the newer delete already removed"
        );
        assert.deepEqual(await driver.semanticWithEmbedding(device.connector_instance_id, key), []);
        return;
      }

      if (
        caseName === "device-commit-before-enqueue-inversion-upsert" ||
        caseName === "device-commit-before-enqueue-inversion-mixed-family"
      ) {
        // The real device-batch race: a device batch's durable per-record
        // commits finish, then `finalDeviceRecordPlan`/`prepareDeviceFinalRecords`
        // run (a genuine async gap) BEFORE the batch enqueues its
        // final-plan publish onto the per-instance lane. Pausing at the
        // route's own `"after-durable-phase"` hook (durable commits done,
        // enqueue not yet issued) lets a same-instance direct writer's
        // ENTIRE commit-enqueue-publish cycle land inside that gap — so the
        // device batch's OLDER commit enqueues, and therefore runs, AFTER
        // the direct writer's NEWER commit already published. Both index
        // families are checked in the "mixed-family" variant to prove they
        // never disagree about which write is current (the exact defect a
        // per-family-only CAS would miss).
        await ingestRecord(target(device), directRecord(key, "seed"));
        await within(waitForDeferredIndexWorkToDrain(), "seed publish drains");

        const devicePausedAfterDurablePhase = deferred<void>();
        const releaseDevice = deferred<void>();
        __setDeviceIngestPhaseFaultHookForTest(async (point: string) => {
          if (point === "after-durable-phase") {
            devicePausedAfterDurablePhase.resolve();
            await releaseDevice.promise;
          }
        });
        let deviceResult: JsonResponse | undefined;
        try {
          const request = batch(device, nextId(`${caseName}`), [deviceRecord(key, "device-older-content")]);
          const devicePromise = driver.ingest(device, request).then((result) => {
            deviceResult = result;
            return result;
          });
          await within(devicePausedAfterDurablePhase.promise, "device batch paused after its durable commit");
          // The direct writer's ENTIRE cycle (commit, enqueue, lane-run,
          // publish) completes here, strictly inside the device batch's
          // commit-to-enqueue gap.
          await ingestRecord(target(device), directRecord(key, "direct-newer-content"));
          await within(waitForDeferredIndexWorkToDrain(), "the direct writer's own publish drains");
          assert.deepEqual(
            await driver.lexical(device.connector_instance_id, key),
            [{ field: "content", text: "direct-newer-content" }],
            "the direct writer's newer publish must be visible before the device batch enqueues"
          );
          releaseDevice.resolve();
          await within(devicePromise, "the device batch resumes, enqueues, and completes");
          await within(waitForDeferredIndexWorkToDrain(), "the device batch's inverted-order publish attempt drains");
        } finally {
          __setDeviceIngestPhaseFaultHookForTest(null);
          releaseDevice.resolve();
        }
        assert.equal(mustExist(deviceResult, "device result must exist").status, 201);
        const record = mustExist(await driver.record(device.connector_instance_id, key), "record must exist");
        assert.equal(record.record_json.content, "direct-newer-content", "the durable row: newest write wins");
        const lexicalRows = await driver.lexical(device.connector_instance_id, key);
        assert.deepEqual(
          lexicalRows,
          [{ field: "content", text: "direct-newer-content" }],
          "lexical must reflect the direct writer, never the device batch's inverted-order stale publish"
        );
        if (caseName === "device-commit-before-enqueue-inversion-mixed-family") {
          const semanticRows = await driver.semanticWithEmbedding(device.connector_instance_id, key);
          assert.equal(
            semanticRows.length,
            1,
            "semantic must also reflect the direct writer, not be split from lexical"
          );
        }
        return;
      }

      if (caseName === "device-stale-delete-vs-live-upsert") {
        // Same commit-before-enqueue inversion mechanism, with the device
        // batch performing a DELETE that becomes stale: a same-instance
        // direct upsert lands inside the gap. The device's stale
        // delete-publish must not remove the direct writer's live content.
        await ingestRecord(target(device), directRecord(key, "seed"));
        await within(waitForDeferredIndexWorkToDrain(), "seed publish drains");
        const devicePausedAfterDurablePhase = deferred<void>();
        const releaseDevice = deferred<void>();
        __setDeviceIngestPhaseFaultHookForTest(async (point: string) => {
          if (point === "after-durable-phase") {
            devicePausedAfterDurablePhase.resolve();
            await releaseDevice.promise;
          }
        });
        let deviceResult: JsonResponse | undefined;
        try {
          const request = batch(device, nextId(`${caseName}`), [deviceRecord(key, "", { op: "delete" })]);
          const devicePromise = driver.ingest(device, request).then((result) => {
            deviceResult = result;
            return result;
          });
          await within(devicePausedAfterDurablePhase.promise, "device delete-batch paused after its durable commit");
          await ingestRecord(target(device), directRecord(key, "direct-revives"));
          await within(waitForDeferredIndexWorkToDrain(), "the direct writer's own publish drains");
          releaseDevice.resolve();
          await within(devicePromise, "the device batch resumes and completes");
          await within(waitForDeferredIndexWorkToDrain(), "the device batch's stale delete-publish attempt drains");
        } finally {
          __setDeviceIngestPhaseFaultHookForTest(null);
          releaseDevice.resolve();
        }
        assert.equal(mustExist(deviceResult, "device result must exist").status, 201);
        const record = mustExist(await driver.record(device.connector_instance_id, key), "record must exist");
        assert.equal(record.deleted, false);
        assert.equal(record.record_json.content, "direct-revives");
        assert.deepEqual(
          await driver.lexical(device.connector_instance_id, key),
          [{ field: "content", text: "direct-revives" }],
          "the device batch's stale delete-publish must not remove the direct writer's live content"
        );
        return;
      }

      if (caseName === "device-stale-upsert-vs-live-delete") {
        // Inverse: the device batch's UPSERT becomes stale — a same-instance
        // direct DELETE lands inside the gap. The device's stale
        // upsert-publish must not resurrect content into the index.
        await ingestRecord(target(device), directRecord(key, "seed"));
        await within(waitForDeferredIndexWorkToDrain(), "seed publish drains");
        const devicePausedAfterDurablePhase = deferred<void>();
        const releaseDevice = deferred<void>();
        __setDeviceIngestPhaseFaultHookForTest(async (point: string) => {
          if (point === "after-durable-phase") {
            devicePausedAfterDurablePhase.resolve();
            await releaseDevice.promise;
          }
        });
        let deviceResult: JsonResponse | undefined;
        try {
          const request = batch(device, nextId(`${caseName}`), [deviceRecord(key, "device-stale-content")]);
          const devicePromise = driver.ingest(device, request).then((result) => {
            deviceResult = result;
            return result;
          });
          await within(devicePausedAfterDurablePhase.promise, "device upsert-batch paused after its durable commit");
          await deleteRecord(target(device), "messages", key);
          await within(waitForDeferredIndexWorkToDrain(), "the direct delete's own publish drains");
          releaseDevice.resolve();
          await within(devicePromise, "the device batch resumes and completes");
          await within(waitForDeferredIndexWorkToDrain(), "the device batch's stale upsert-publish attempt drains");
        } finally {
          __setDeviceIngestPhaseFaultHookForTest(null);
          releaseDevice.resolve();
        }
        assert.equal(mustExist(deviceResult, "device result must exist").status, 201);
        const record = mustExist(await driver.record(device.connector_instance_id, key), "record must exist");
        assert.equal(record.deleted, true, "the newer direct delete is authoritative");
        assert.deepEqual(
          await driver.lexical(device.connector_instance_id, key),
          [],
          "the device batch's stale upsert-publish must not resurrect content the newer delete already removed"
        );
        assert.deepEqual(await driver.semanticWithEmbedding(device.connector_instance_id, key), []);
        return;
      }

      if (caseName === "crash-mid-publish-sweep-backstop") {
        // A publish "crashes" (throws) after compute but before the CAS
        // write lands — the durable commit's own dirty-flag mark is the
        // fact that survives, and the bounded reconcile sweep, run once,
        // brings the derived index to the correct current state. Proves
        // the sweep is a genuine backstop, not required for the primary
        // race (which the other cases already prove holds without it).
        __setIndexPublishPhaseHookForTest((point: string, context: Record<string, unknown>) => {
          if (point === "before-publish-transaction" && context.expectedVersion === 1) {
            throw new Error("simulated crash between compute and publish transaction");
          }
        });
        try {
          await ingestRecord(target(device), directRecord(key, "crash-content"));
        } catch {
          // Deliberately swallowed: this mirrors scheduleRecordIndexMaintenance's
          // own fire-and-forget contract — a derived-phase failure never
          // rolls back the durable write, and the caller here stands in for
          // that fire-and-forget lane.
        } finally {
          __setIndexPublishPhaseHookForTest(null);
        }
        assert.deepEqual(
          await driver.lexical(device.connector_instance_id, key),
          [],
          "the crashed publish must not have left partial state"
        );
        const { runSearchIndexDirtyReconcileRound } = await import("../server/search-index-reconcile.ts");
        await runSearchIndexDirtyReconcileRound();
        assert.deepEqual(
          await driver.lexical(device.connector_instance_id, key),
          [{ field: "content", text: "crash-content" }],
          "one reconcile round closes the gap the crashed publish left"
        );
        return;
      }

      if (caseName === "no-lock-around-embedding") {
        // Regression guard: a same-instance writer whose embedding is
        // artificially slow must not block a concurrent same-instance
        // writer's OWN record commit beyond one transaction's duration —
        // the CAS fix must not "fix" the stale-overwrite race by
        // reintroducing a lock spanning the embedding call.
        const otherKey = "version-cas-key-other";
        const embedStalled = deferred<void>();
        const releaseEmbed = deferred<void>();
        driver.setEmbeddingHook(async (text) => {
          if (text === "slow-content") {
            embedStalled.resolve();
            await releaseEmbed.promise;
          }
        });
        try {
          const slowPromise = ingestRecord(target(device), directRecord(key, "slow-content"));
          await within(embedStalled.promise, "the slow writer's embedding call is in flight");
          const commitStarted = performance.now();
          await ingestRecord(target(device), directRecord(otherKey, "fast-content"));
          const commitElapsedMs = performance.now() - commitStarted;
          assert.ok(
            commitElapsedMs < 1000,
            `a concurrent same-instance writer's durable commit must not queue behind another writer's embedding call — took ${commitElapsedMs}ms`
          );
          releaseEmbed.resolve();
          await within(slowPromise, "the slow writer completes");
        } finally {
          driver.setEmbeddingHook(null);
          releaseEmbed.resolve();
        }
        return;
      }

      if (caseName === "device-retry-version-monotonicity") {
        // A device-batch retry that replays a durable-prefix record (already
        // covered by authoritativeFinalRecord's reread) must not decrement
        // or otherwise corrupt the derived index's version when it repairs
        // derived facts — version only ever moves forward across a retry.
        __setDeviceIngestPhaseFaultHookForTest((point: string) => {
          if (point === "after-durable-phase") {
            throw new Error("hold the batch after durable phase, before final-plan index maintenance");
          }
        });
        let request: DeviceBatch;
        try {
          request = batch(device, nextId("version-cas-retry"), [deviceRecord(key, "retry-content")]);
          assert.equal((await driver.ingest(device, request)).status, 503);
        } finally {
          __setDeviceIngestPhaseFaultHookForTest(null);
        }
        const stranded = mustExist(await driver.outcome(device, request.batch_id), "stranded outcome must exist");
        assert.equal(stranded.durable_prefix_count, 1);
        assert.equal((await driver.ingest(device, request)).status, 201);
        await within(waitForDeferredIndexWorkToDrain(), "retry's final-plan publish drains");
        const record = mustExist(await driver.record(device.connector_instance_id, key), "record must exist");
        assert.equal(record.version, 1, "the retry repairs derived state at the SAME version, never a new one");
        assert.deepEqual(await driver.lexical(device.connector_instance_id, key), [
          { field: "content", text: "retry-content" },
        ]);
      }
    }
  );
}

/**
 * A batch whose records are ALL already durable
 * (`durable_prefix_count === record_count`) must still be able to reach
 * `accepted`, no matter how long this attempt took.
 *
 * The live wedge this pins: the attempt deadline was checked AFTER the
 * durable phase and index maintenance but BEFORE
 * `completeProcessingBatch`. A slow-but-successful attempt therefore threw
 * `device_ingest_retryable` with every record already committed, leaving
 * the reservation `processing` with a FULL durable prefix. Nothing reaps a
 * stale `processing` row, so the collector retried the same batch forever:
 * each retry skipped the durable loop (`start === records.length`) but
 * still re-ran the final-plan repair + embedding publish, blew the same
 * deadline again, and 503'd again — a self-sustaining livelock at ~45% of
 * batches once the queue backed up (one row reached 1058 attempts).
 *
 * The deadline is a bound on WORK YET TO DO, not a reason to discard work
 * already durably committed. Once the durable prefix is complete the only
 * thing left is the status transition, which must not be deadline-gated.
 */
async function runFullPrefixDeadlineOracle(driver: Driver): Promise<void> {
  const device = await enrollConfiguredDevice(driver, "full-prefix-deadline");
  const key = "full-prefix-deadline-key";
  const request = batch(device, nextId("full-prefix-deadline"), [deviceRecord(key, "deadline-content")]);

  // Strand the batch with a COMPLETE durable prefix, exactly like a slow
  // attempt that committed every record and then blew its deadline.
  __setDeviceIngestPhaseFaultHookForTest((point: string) => {
    if (point === "after-durable-phase") {
      throw new Error("strand the batch with every record already durable");
    }
  });
  try {
    assert.equal((await driver.ingest(device, request)).status, 503);
  } finally {
    __setDeviceIngestPhaseFaultHookForTest(null);
  }

  const stranded = mustExist(await driver.outcome(device, request.batch_id), "a stranded reservation must exist");
  assert.equal(stranded.status, "processing");
  assert.equal(
    Number(stranded.durable_prefix_count),
    Number(stranded.record_count),
    "sanity: the reservation is stranded with a FULL durable prefix — the wedged shape seen in production"
  );

  // Now retry that fully-durable batch under an attempt deadline that has
  // ALREADY expired, which is what a real slow retry hits. Before the fix
  // this threw at the post-index `assertBatchAttemptBefore`, never reaching
  // `completeProcessingBatch`, and 503'd forever.
  const previousDeadline = process.env.PDPP_INGEST_BATCH_ATTEMPT_DEADLINE_MS;
  process.env.PDPP_INGEST_BATCH_ATTEMPT_DEADLINE_MS = "1";
  let retried: JsonResponse;
  try {
    retried = await driver.ingest(device, request);
  } finally {
    if (previousDeadline === undefined) {
      delete process.env.PDPP_INGEST_BATCH_ATTEMPT_DEADLINE_MS;
    } else {
      process.env.PDPP_INGEST_BATCH_ATTEMPT_DEADLINE_MS = previousDeadline;
    }
  }

  assert.equal(
    retried.status,
    201,
    "a retry of a batch whose records are ALL durable must settle it, not 503 forever — this is the production wedge"
  );

  const settled = mustExist(await driver.outcome(device, request.batch_id), "the settled outcome must persist");
  assert.equal(settled.status, "accepted", "the reservation must reach a terminal accepted state");
  assert.equal(Number(settled.durable_prefix_count), Number(settled.record_count));
  assert.equal(Number(settled.http_status), 201);
  assert.ok(settled.accepted_at, "an accepted reservation must carry accepted_at");

  // And it must stay idempotent: replaying the same batch returns the same
  // stored acceptance rather than redoing work.
  const replay = await driver.ingest(device, request);
  assert.equal(replay.status, 201, "an accepted batch replays as accepted");
}

/**
 * A failed device-ingest batch attempt must leave a server-side trace.
 *
 * The collector's 503 envelope is a fixed, bounded template by design (no
 * storage/index/model/SQL diagnostic is safe to hand a collector), so before
 * this fix the real cause of a stuck batch was visible NOWHERE: not in the
 * client response, not in the server log. That is how the livelock above ran
 * for hours — 219 ingest POSTs in 12 minutes, zero error/warn lines.
 *
 * Mirrors the ingest-rejection diagnosability contract established by
 * `rs-ingest-systemic-failure-server-log.test.ts`. The log line carries
 * identifiers only, never record content.
 */
async function runAttemptFailureServerLogOracle(driver: Driver): Promise<void> {
  const device = await enrollConfiguredDevice(driver, "attempt-failure-log");
  const secretContent = "canary_DeviceIngestServerLogOnlyMarkerNeverInHttpBody";
  const request = batch(device, nextId("attempt-failure-log"), [deviceRecord("log-key", secretContent)]);

  const capturedErrorLogs: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    capturedErrorLogs.push(args.map((value) => String(value)).join(" "));
  };
  __setDeviceIngestPhaseFaultHookForTest((point: string) => {
    if (point === "after-durable-phase") {
      throw new Error("deterministic attempt failure for the server-log oracle");
    }
  });
  let response: JsonResponse;
  try {
    response = await driver.ingest(device, request);
  } finally {
    __setDeviceIngestPhaseFaultHookForTest(null);
    console.error = originalConsoleError;
  }

  assert.equal(response.status, 503, "the attempt must still fail retryably");

  const attemptLine = capturedErrorLogs.find((line) => line.includes("[device-ingest] batch attempt failed"));
  assert.ok(
    attemptLine,
    `a failed device-ingest attempt must be logged server-side, got: ${JSON.stringify(capturedErrorLogs)}`
  );
  assert.ok(attemptLine.includes(`device_id=${device.device_id}`), "the log line must identify the device");
  assert.ok(attemptLine.includes(`batch_id=${request.batch_id}`), "the log line must identify the batch");
  assert.ok(
    attemptLine.includes("durable_prefix_start="),
    "the log line must report the durable cursor that distinguishes a wedged batch"
  );

  // Diagnosability must not become an exfiltration channel: the log carries
  // identifiers, never record content, and the HTTP body stays redacted.
  assert.ok(!attemptLine.includes(secretContent), "the server log must never carry record content");
  assert.ok(
    !JSON.stringify(response.body).includes(secretContent),
    "the redacted 503 envelope must never carry record content"
  );
}

const ORACLES: [string, (driver: Driver) => Promise<void>][] = [
  ["phase fault/resume matrix", runPhaseFaultMatrix],
  ["full durable prefix settles under an expired deadline", runFullPrefixDeadlineOracle],
  ["failed batch attempts are logged server-side", runAttemptFailureServerLogOracle],
  ["simultaneous identity matrix", runConcurrentIdentityOracle],
  ["duplicate and newer writer matrix", runDuplicateAndNewerWriterOracle],
  ["derived repair and canonical records", runRepairAndCanonicalOracle],
  ["stranded processing diagnostics", runStrandedDiagnosticsOracle],
  ["registration/backfill ordering", runManifestRegistrationOracle],
  ["device/direct writer collision matrix", runWriterCollisionOracle],
  ["version-CAS stale-overwrite adversarial matrix", runVersionCasOracle],
];

for (const [name, oracle] of ORACLES) {
  test(`SQLite device-ingest conformance: ${name}`, async () => {
    await withBackend("sqlite", oracle);
  });
  test(`PostgreSQL device-ingest conformance: ${name}`, {
    skip: !DEDICATED_POSTGRES_URL,
  }, async () => {
    await withBackend("postgres", oracle);
  });
}
