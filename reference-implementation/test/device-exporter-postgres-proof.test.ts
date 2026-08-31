// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { registerEphemeralOrigin, unregisterEphemeralOrigin } from "../../scripts/hermetic/guard.ts";
import { COLLECTOR_PROTOCOL_VERSION } from "../server/collector-protocol.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { fingerprintDeviceAttemptManifest } from "../server/device-ingest-attempt-context.ts";
import { startServer } from "../server/index.ts";
import type { LocalTransformerExecutionTelemetry } from "../server/local-transformer-executor.ts";
import {
  bootstrapPostgresSchema,
  closePostgresStorage,
  initPostgresStorage,
  postgresQuery,
  withPostgresTransaction,
} from "../server/postgres-storage.ts";
import { createAlreadyAdmittedTestDatabaseChildAttachment } from "../server/postgres-test-database-guard.ts";
import { drainConnectorInstanceIndexWorkForTests, ingestRecord, setClientEventEnqueueHook } from "../server/records.ts";
import { runSearchIndexDirtyReconcileRound } from "../server/search-index-reconcile.ts";
import { __setDeviceIngestPhaseFaultHookForTest } from "../server/routes/ref-device-exporters.ts";
import { makeLocalTransformerBackend } from "../server/search-semantic.ts";
import {
  advancePostgresDeviceIngestPrefix,
  createPostgresDeviceExporterStore,
} from "../server/stores/device-exporter-store.ts";
import { isSearchIndexScopeDirty } from "../server/stores/search-index-dirty-store.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;
const DEDICATED_POSTGRES_URL = dedicatedPostgresTestUrl(POSTGRES_URL);
const PROTOCOL_HEADERS = { "X-PDPP-Collector-Protocol": COLLECTOR_PROTOCOL_VERSION };
const FAILSTOP_SERVER_FIXTURE = fileURLToPath(new URL("./fixtures/device-ingest-failstop-server.mjs", import.meta.url));
const PRIVATE_PG_TRIGGER_SENTINEL = /private-pg-trigger-sentinel/;
const PRIVATE_PG_SEMANTIC_SENTINEL = /private-pg-semantic-backend-sentinel/;
const PRIVATE_REAL_LOCAL_SENTINEL = /private-real-local-payload-sentinel|pg_sleep|\/owner\/private\/path/;
const SEMANTIC_VECTOR_COMPONENT = /0\.2/;

let tempCounter = 0;
function tempDbName(): string {
  tempCounter += 1;
  return `pdpp_device_ingest_${process.pid}_${Date.now()}_${tempCounter}`;
}

function requiredEnvironmentUrl(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} must be configured for the PostgreSQL proof`);
  }
  return value;
}

async function withTempPostgres(fn: (url: string) => Promise<void>): Promise<void> {
  const postgresUrl = requiredEnvironmentUrl(POSTGRES_URL, "PDPP_TEST_POSTGRES_URL");
  const name = tempDbName();
  await withTemporaryPostgresDatabase(
    { closeConnections: closePostgresStorage, connectionString: postgresUrl, databaseName: name },
    fn
  );
}

async function closeServer(server: Awaited<ReturnType<typeof startServer>> | null): Promise<void> {
  if (!server) {
    return;
  }
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

async function withServer(
  url: string,
  options: Parameters<typeof startServer>[0],
  fn: (ctx: { asUrl: string; server: unknown }) => Promise<void>
): Promise<void> {
  initDb(":memory:");
  const previousDatabaseUrl = process.env.PDPP_DATABASE_URL;
  process.env.PDPP_DATABASE_URL = url;
  let server: Awaited<ReturnType<typeof startServer>>;
  try {
    server = await startServer({
      asPort: 0,
      dbPath: ":memory:",
      quiet: true,
      rsPort: 0,
      ...options,
    });
  } finally {
    if (previousDatabaseUrl === undefined) {
      delete process.env.PDPP_DATABASE_URL;
    } else {
      process.env.PDPP_DATABASE_URL = previousDatabaseUrl;
    }
  }
  await server.startupBackfillDone.catch(() => undefined);
  const asUrl = `http://localhost:${server.asPort}`;
  try {
    await fn({ asUrl, server });
  } finally {
    await closeServer(server);
    await closePostgresStorage().catch(() => undefined);
    closeDb();
  }
}

type JsonValue = boolean | null | number | string | JsonValue[] | JsonRecord;
interface JsonRecord {
  [key: string]: JsonValue;
}
interface HttpResponseBody extends JsonRecord {
  enrollment_code?: string;
  error?: JsonRecord;
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredJsonRecord(value: unknown, description: string): JsonRecord {
  if (!isJsonRecord(value)) {
    throw new Error(`${description} must be a JSON object`);
  }
  return value;
}

function requiredString(record: JsonRecord, key: string, description: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`${description}.${key} must be a string`);
  }
  return value;
}

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: HttpResponseBody }> {
  const response = await fetch(url, {
    body: JSON.stringify(body),
    headers: { Accept: "application/json", "Content-Type": "application/json", ...headers },
    method: "POST",
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  return { body: requiredJsonRecord(parsed, `response from ${url}`), status: response.status };
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  const output: Record<string, unknown> = {};
  const object = requiredJsonRecord(value, "canonical value");
  for (const key of Object.keys(object).sort()) {
    if (object[key] !== undefined) {
      output[key] = canonicalValue(object[key]);
    }
  }
  return output;
}

function bodyHash(records: unknown[]): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalValue(records)))
    .digest("hex");
}

async function enrollDevice(
  asUrl: string,
  localBindingName: string,
  connectorId = "codex"
): Promise<{
  connector_id: string;
  connector_instance_id: string;
  device_id: string;
  device_token: string;
  source_instance_id: string;
}> {
  const code = await postJson(`${asUrl}/_ref/device-exporters/enrollment-codes`, {
    connector_id: connectorId,
    local_binding_name: localBindingName,
  });
  assert.equal(code.status, 201, JSON.stringify(code.body));
  const enrolled = await postJson(
    `${asUrl}/_ref/device-exporters/enroll`,
    { enrollment_code: code.body.enrollment_code },
    PROTOCOL_HEADERS
  );
  assert.equal(enrolled.status, 201, JSON.stringify(enrolled.body));
  return {
    connector_id: requiredString(enrolled.body, "connector_id", "device enrollment"),
    connector_instance_id: requiredString(enrolled.body, "connector_instance_id", "device enrollment"),
    device_id: requiredString(enrolled.body, "device_id", "device enrollment"),
    device_token: requiredString(enrolled.body, "device_token", "device enrollment"),
    source_instance_id: requiredString(enrolled.body, "source_instance_id", "device enrollment"),
  };
}

function authHeaders(deviceToken: string): Record<string, string> {
  return { Authorization: `Bearer ${deviceToken}`, ...PROTOCOL_HEADERS };
}

interface ManifestSearch extends JsonRecord {
  lexical_fields?: string[];
  semantic_fields?: string[];
}

interface ManifestQuery extends JsonRecord {
  search: ManifestSearch;
}

interface ManifestSchema extends JsonRecord {
  properties: Record<string, JsonRecord>;
}

interface MessagesManifest extends JsonRecord {
  consent_time_field?: string;
  cursor_field?: string;
  name: string;
  primary_key?: string[];
  query: ManifestQuery;
  schema: ManifestSchema;
}

interface ConnectorManifest extends JsonRecord {
  streams: JsonRecord[];
}

function isStringArray(value: JsonValue | undefined): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isMessagesManifest(value: JsonValue): value is MessagesManifest {
  if (!isJsonRecord(value) || typeof value.name !== "string") {
    return false;
  }
  const { query, schema } = value;
  if (!(isJsonRecord(query) && isJsonRecord(schema) && isJsonRecord(query.search) && isJsonRecord(schema.properties))) {
    return false;
  }
  const { search } = query;
  return (
    (search.lexical_fields === undefined || isStringArray(search.lexical_fields)) &&
    (search.semantic_fields === undefined || isStringArray(search.semantic_fields))
  );
}

function requiredFirstRow<Row>(rows: readonly Row[], description: string): Row {
  const [row] = rows;
  if (row === undefined) {
    throw new Error(`${description} did not return a row`);
  }
  return row;
}

function requiredAt<Value>(values: readonly Value[], index: number, description: string): Value {
  const value = values[index];
  if (value === undefined) {
    throw new Error(`${description} is missing index ${index}`);
  }
  return value;
}

async function mapSequentially<Value, Result>(
  values: readonly Value[],
  transform: (value: Value) => Promise<Result>
): Promise<Result[]> {
  const [value, ...remaining] = values;
  if (value === undefined) {
    return [];
  }
  return [await transform(value), ...(await mapSequentially(remaining, transform))];
}

function requiredValue<Value>(value: Value | undefined | null, description: string): Value {
  if (value === undefined || value === null) {
    throw new Error(`${description} is required`);
  }
  return value;
}

function parseConnectorManifest(value: unknown): ConnectorManifest {
  const manifest = requiredJsonRecord(value, "connector manifest");
  const { streams } = manifest;
  if (!(Array.isArray(streams) && streams.every(isJsonRecord))) {
    throw new Error("connector manifest streams must be objects");
  }
  return { ...manifest, streams };
}

async function setMessagesManifest(
  mutator: (messages: MessagesManifest, manifest: ConnectorManifest) => void
): Promise<void> {
  const row = await postgresQuery<{ manifest: JsonValue | string }>(
    "SELECT manifest FROM connectors WHERE connector_id = $1",
    ["codex"]
  );
  const storedManifest = requiredFirstRow(row.rows, "connector manifest").manifest;
  const manifest = parseConnectorManifest(
    typeof storedManifest === "string" ? JSON.parse(storedManifest) : storedManifest
  );
  const messages = manifest.streams.find((stream) => stream.name === "messages");
  if (messages === undefined || !isMessagesManifest(messages)) {
    throw new Error("connector manifest messages stream must have searchable message-stream structure");
  }
  mutator(messages, manifest);
  const manifestJson = JSON.stringify(manifest);
  await postgresQuery("UPDATE connectors SET manifest = $1::jsonb WHERE connector_id = $2", [manifestJson, "codex"]);
  getDb().prepare("UPDATE connectors SET manifest = ? WHERE connector_id = ?").run(manifestJson, "codex");
}

interface DeviceRecord {
  data: Record<string, string>;
  emitted_at: string;
  record_key: string;
  stream: string;
}

function recordFor(id: string, value: string, timestamp = "2026-07-16T00:00:00.000Z"): DeviceRecord {
  return {
    data: {
      content: value,
      id,
      role: "user",
      session_id: id,
      timestamp,
      type: "text",
    },
    emitted_at: timestamp,
    record_key: id,
    stream: "messages",
  };
}

function batchFor(
  device: { connector_id: string; device_id: string; source_instance_id: string },
  batchId: string,
  records: unknown[],
  batchSeq = 1
): Record<string, unknown> {
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
  delayMs?: number;
  model?: () => string;
  onEmbed?: ((text: string) => Promise<void> | void) | null;
  vector?: readonly number[];
}

function deterministicBackend({
  model = () => "pg-device-proof",
  delayMs = 0,
  onEmbed = null,
  vector = [0.25, 0.5, 0.75],
}: DeterministicBackendOptions = {}) {
  let calls = 0;
  return {
    available: () => true,
    calls: () => calls,
    dimensions: () => 3,
    distanceMetric: () => "cosine",
    embedDocument: async (text: string) => {
      calls += 1;
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      if (onEmbed) {
        await onEmbed(text);
      }
      return new Float32Array(vector);
    },
    embedQuery: async () => new Float32Array(vector),
    model,
    supportsDeviceAttemptDeadline: () => true,
  };
}

function vectorBytes(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

interface ObservedLocalBackend {
  close: () => Promise<void>;
  embedDocument: (text: string) => Promise<Float32Array>;
  executionTelemetry: () => LocalTransformerExecutionTelemetry;
  resetExecutionTelemetry: () => void;
}

function isLocalTransformerExecutionTelemetry(value: unknown): value is LocalTransformerExecutionTelemetry {
  if (!isJsonRecord(value)) {
    return false;
  }
  return (
    typeof value.childHighWater === "number" &&
    (typeof value.childPid === "number" || value.childPid === null) &&
    typeof value.childQueueDepth === "number" &&
    (typeof value.childRssBytes === "number" || value.childRssBytes === null) &&
    typeof value.generation === "number" &&
    typeof value.peakChildRssBytes === "number" &&
    typeof value.pendingJobs === "number" &&
    typeof value.stopped === "boolean" &&
    typeof value.terminating === "boolean"
  );
}

function observeLocalTransformerBackend(
  rawBackend: ReturnType<typeof makeLocalTransformerBackend>
): ObservedLocalBackend {
  const { close, executionTelemetry, resetExecutionTelemetry } = rawBackend;
  if (
    typeof close !== "function" ||
    typeof executionTelemetry !== "function" ||
    typeof resetExecutionTelemetry !== "function"
  ) {
    throw new Error("local transformer backend must expose lifecycle telemetry for this proof");
  }
  return {
    close: async () => {
      await close();
    },
    embedDocument: (text) => rawBackend.embedDocument(text),
    executionTelemetry: () => {
      const telemetry = executionTelemetry();
      if (!isLocalTransformerExecutionTelemetry(telemetry)) {
        throw new Error("local transformer backend returned invalid execution telemetry");
      }
      return telemetry;
    },
    resetExecutionTelemetry: () => {
      resetExecutionTelemetry();
    },
  };
}

type CapturingLogger = NonNullable<NonNullable<Parameters<typeof startServer>[0]>["logger"]> & {
  flush?: () => void;
};

function isPinoFactory(
  value: unknown
): value is (options: Record<string, unknown>, destination: Writable) => CapturingLogger {
  return typeof value === "function";
}

function capturingLogger(lines: string[]): CapturingLogger {
  const loadModule = createRequire(import.meta.url);
  const loadedPino: unknown = loadModule("pino");
  if (!isPinoFactory(loadedPino)) {
    throw new Error("pino module must export a logger factory");
  }
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(Buffer.from(chunk).toString("utf8"));
      callback();
    },
  });
  return loadedPino(
    {
      level: "info",
      redact: {
        censor: "<redacted>",
        paths: ["access_token", "refresh_token", "req.headers.authorization", "*.access_token", "*.refresh_token"],
      },
    },
    destination
  );
}

async function within<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const deadline = new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    });
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function startFailStopServerFixture(
  postgresDatabaseUrl: string,
  mode: string,
  childAttachment: string
): Promise<{
  asUrl: string;
  child: import("node:child_process").ChildProcess;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  output: () => string;
}> {
  interface FixtureExit {
    code: number | null;
    signal: NodeJS.Signals | null;
  }
  interface FixtureReadiness {
    asPort: number;
    ready: true;
  }
  const child = spawn(process.execPath, [FAILSTOP_SERVER_FIXTURE], {
    env: {
      ...process.env,
      PDPP_FAILSTOP_FIXTURE_CHILD_ATTACHMENT: childAttachment,
      PDPP_FAILSTOP_FIXTURE_DATABASE_URL: postgresDatabaseUrl,
      PDPP_FAILSTOP_FIXTURE_MODE: mode,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stderr.on("data", (chunk) => {
    output += Buffer.from(chunk).toString("utf8");
  });
  const exit = new Promise<FixtureExit>((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  const lines = createInterface({ crlfDelay: Number.POSITIVE_INFINITY, input: child.stdout });
  const ready = new Promise<FixtureReadiness>((resolve, reject) => {
    lines.on("line", (line) => {
      output += `${line}\n`;
      try {
        const parsed = JSON.parse(line);
        if (isJsonRecord(parsed) && parsed.ready === true && typeof parsed.asPort === "number") {
          resolve({ asPort: parsed.asPort, ready: true });
        }
      } catch {
        // The fixture may emit diagnostics before its JSON ready receipt.
      }
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => reject(new Error(`fail-stop fixture exited before ready: ${code ?? signal}`)));
  });
  let readiness: FixtureReadiness;
  try {
    readiness = await within(ready, 20_000, "fail-stop fixture startup exceeded 20s");
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
  // The fixture deliberately owns its server in a child process, so its bind
  // cannot be observed by this process's bind-derived hermetic guard. Its
  // ready handshake is the explicit authority handoff; revoke it as soon as
  // the child exits so an unrelated listener cannot inherit the grant.
  const asUrl = `http://127.0.0.1:${readiness.asPort}`;
  registerEphemeralOrigin(asUrl);
  child.once("exit", () => unregisterEphemeralOrigin(asUrl));
  return {
    asUrl,
    child,
    exit,
    output: () => output,
  };
}

function awaitFixtureExit(
  fixture: { exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }> },
  timeoutMs = 10_000
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return within(fixture.exit, timeoutMs, `fixture exit exceeded ${timeoutMs}ms`);
}

function stopServerFixture(fixture: {
  child: import("node:child_process").ChildProcess;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
}): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (fixture.child.exitCode === null && fixture.child.signalCode === null) {
    fixture.child.kill("SIGTERM");
  }
  return awaitFixtureExit(fixture);
}

async function installAcceptedTransitionBarrier(databaseUrl: string): Promise<() => Promise<void>> {
  const lockClass = 482_571;
  const lockKey = 320;
  const functionName = "pdpp_test_device_ingest_acceptance_barrier";
  const triggerName = "pdpp_test_device_ingest_acceptance_barrier_trigger";
  const blocker = new Pool({ connectionString: databaseUrl });
  await blocker.query("SELECT pg_advisory_lock($1, $2)", [lockClass, lockKey]);
  await blocker.query(`
    CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.status = 'accepted' AND OLD.status IS DISTINCT FROM 'accepted' THEN
        PERFORM pg_advisory_xact_lock(${lockClass}, ${lockKey});
      END IF;
      RETURN NEW;
    END;
    $$;
  `);
  await blocker.query(`
    CREATE TRIGGER ${triggerName}
      BEFORE UPDATE OF status ON device_ingest_batch_outcomes
      FOR EACH ROW EXECUTE FUNCTION ${functionName}()
  `);
  return async () => {
    try {
      await blocker.query("SELECT pg_advisory_unlock($1, $2)", [lockClass, lockKey]);
      await blocker.query(`DROP TRIGGER IF EXISTS ${triggerName} ON device_ingest_batch_outcomes`);
      await blocker.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
    } finally {
      await blocker.end();
    }
  };
}

if (DEDICATED_POSTGRES_URL) {
  test("PostgreSQL bootstrap preserves processing reservations and migrates only legacy accepted rows", async () => {
    await withTempPostgres(async (url) => {
      initDb(":memory:");
      await initPostgresStorage({ backend: "postgres", databaseUrl: url });
      const suffix = `${process.pid}_${Date.now()}`;
      const connectorId = `migration_${suffix}`;
      const deviceId = `device_${suffix}`;
      const batchId = `processing_${suffix}`;
      const legacyBatchId = `legacy_${suffix}`;
      const manifest = { connector_id: connectorId, streams: [], version: "1.0.0" };
      const identity = {
        batchId,
        batchSeq: 1,
        bodyHash: "a".repeat(64),
        connectorId,
        connectorInstanceId: `instance_${suffix}`,
        deviceId,
        sourceInstanceId: `source_${suffix}`,
      };
      await postgresQuery(
        `INSERT INTO device_exporters(device_id, owner_subject_id, display_name, status, created_at, updated_at)
         VALUES($1, $2, $3, 'active', $4, $4)`,
        [deviceId, `owner_${suffix}`, "migration-proof", "2026-07-16T00:00:00.000Z"]
      );
      await postgresQuery("INSERT INTO connectors(connector_id, manifest) VALUES($1, $2::jsonb)", [
        connectorId,
        JSON.stringify(manifest),
      ]);
      await postgresQuery(
        `INSERT INTO device_ingest_batch_outcomes(
           device_id, batch_id, body_hash, source_instance_id, connector_instance_id,
           connector_id, batch_seq, status, record_count, durable_prefix_count,
           manifest_fingerprint, semantic_capability_identity, created_at
         ) VALUES($1, $2, $3, $4, $5, $6, $7, 'processing', 2, 1, $8, $9, $10)`,
        [
          identity.deviceId,
          identity.batchId,
          identity.bodyHash,
          identity.sourceInstanceId,
          identity.connectorInstanceId,
          identity.connectorId,
          identity.batchSeq,
          fingerprintDeviceAttemptManifest(manifest),
          "migration-semantic",
          "2026-07-16T00:00:00.000Z",
        ]
      );
      await postgresQuery(
        `INSERT INTO device_ingest_batch_outcomes(
           device_id, batch_id, body_hash, source_instance_id, connector_instance_id,
           connector_id, batch_seq, status, response_json, record_count,
           durable_prefix_count, created_at
         ) VALUES($1, $2, $3, $4, $5, $6, $7, 'accepted', $8::jsonb, 0, 0, $9)`,
        [
          deviceId,
          legacyBatchId,
          "b".repeat(64),
          identity.sourceInstanceId,
          identity.connectorInstanceId,
          connectorId,
          2,
          JSON.stringify({ accepted_record_count: 3 }),
          "2026-07-16T00:00:01.000Z",
        ]
      );

      await bootstrapPostgresSchema();
      const afterBootstrap = await postgresQuery(
        `SELECT batch_id, status, durable_prefix_count, record_count, accepted_at, response_json
           FROM device_ingest_batch_outcomes WHERE batch_id = ANY($1::text[]) ORDER BY batch_id`,
        [[batchId, legacyBatchId]]
      );
      const processing = requiredValue(
        afterBootstrap.rows.find((row) => row.batch_id === batchId),
        "preserved processing outcome"
      );
      const legacy = requiredValue(
        afterBootstrap.rows.find((row) => row.batch_id === legacyBatchId),
        "migrated legacy outcome"
      );
      assert.deepEqual(
        {
          acceptedAt: processing.accepted_at,
          prefix: processing.durable_prefix_count,
          response: processing.response_json,
          status: processing.status,
        },
        { acceptedAt: null, prefix: 1, response: null, status: "processing" }
      );
      assert.equal(legacy.status, "accepted");
      assert.equal(Number(legacy.record_count), 3);
      assert.equal(Number(legacy.durable_prefix_count), 3);
      assert.ok(legacy.accepted_at);

      await withPostgresTransaction((client) =>
        advancePostgresDeviceIngestPrefix(
          client,
          {
            ...identity,
            recordCount: 2,
          },
          1
        )
      );
      const store = createPostgresDeviceExporterStore();
      const accepted = await store.completeProcessingBatch({
        ...identity,
        acceptedAt: "2026-07-16T00:00:02.000Z",
        getCurrentSemanticCapabilityIdentity: () => "migration-semantic",
        httpStatus: 201,
        manifestFingerprint: fingerprintDeviceAttemptManifest(manifest),
        recordCount: 2,
        response: { accepted_record_count: 2, rejected_record_count: 0 },
        semanticCapabilityIdentity: "migration-semantic",
      });
      assert.ok(accepted, "processing outcome completion must return an outcome");
      assert.equal(accepted.status, "accepted", "the preserved processing row can resume normally");
      assert.equal(accepted.durablePrefixCount, 2);
    });
  });

  test("PostgreSQL route preserves duplicate upsert/delete final state and exact replay", async () => {
    await withTempPostgres(async (url) => {
      const backend = deterministicBackend();
      await withServer(url, { semanticRetrievalBackend: backend }, async ({ asUrl }) => {
        const device = await enrollDevice(asUrl, `pg-duplicate-${Date.now()}`);
        const records = [
          { ...recordFor("same-key", "before-delete"), op: "upsert" },
          {
            data: {},
            emitted_at: "2026-07-16T00:00:01.000Z",
            op: "delete",
            record_key: "same-key",
            stream: "messages",
          },
        ];
        const batch = batchFor(device, "pg-duplicate-upsert-delete", records);
        const accepted = await postJson(
          `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
          batch,
          authHeaders(device.device_token)
        );
        assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
        const replay = await postJson(
          `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
          batch,
          authHeaders(device.device_token)
        );
        assert.equal(replay.status, 201);
        assert.deepEqual(replay.body, accepted.body);
        const beforeIdentityConflict = await postgresQuery(
          `SELECT
             (SELECT COUNT(*) FROM records WHERE connector_instance_id = $1)::integer AS records,
             (SELECT COUNT(*) FROM record_changes WHERE connector_instance_id = $1)::integer AS changes,
             (SELECT COUNT(*) FROM device_ingest_batch_outcomes WHERE device_id = $2)::integer AS outcomes`,
          [device.connector_instance_id, device.device_id]
        );
        const identityConflict = await postJson(
          `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
          { ...batch, connector_id: "claude-code" },
          authHeaders(device.device_token)
        );
        assert.equal(identityConflict.status, 409);
        assert.equal(
          requiredString(
            requiredJsonRecord(identityConflict.body.error, "identity conflict error"),
            "code",
            "identity conflict error"
          ),
          "device_batch_conflict"
        );
        const afterIdentityConflict = await postgresQuery(
          `SELECT
             (SELECT COUNT(*) FROM records WHERE connector_instance_id = $1)::integer AS records,
             (SELECT COUNT(*) FROM record_changes WHERE connector_instance_id = $1)::integer AS changes,
             (SELECT COUNT(*) FROM device_ingest_batch_outcomes WHERE device_id = $2)::integer AS outcomes`,
          [device.connector_instance_id, device.device_id]
        );
        assert.deepEqual(
          requiredFirstRow(afterIdentityConflict.rows, "identity conflict counts"),
          requiredFirstRow(beforeIdentityConflict.rows, "identity conflict counts")
        );
        const durable = await postgresQuery(
          "SELECT deleted, version FROM records WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3",
          [device.connector_instance_id, "messages", "same-key"]
        );
        assert.deepEqual(
          {
            deleted: requiredFirstRow(durable.rows, "durable record").deleted,
            version: Number(requiredFirstRow(durable.rows, "durable record").version),
          },
          { deleted: true, version: 2 }
        );
        const changes = await postgresQuery(
          "SELECT COUNT(*)::integer AS count FROM record_changes WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3",
          [device.connector_instance_id, "messages", "same-key"]
        );
        assert.equal(requiredFirstRow(changes.rows, "record change count").count, 2);
        const lexical = await postgresQuery(
          "SELECT COUNT(*)::integer AS count FROM lexical_search_index WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3",
          [device.connector_instance_id, "messages", "same-key"]
        );
        const semantic = await postgresQuery(
          "SELECT COUNT(*)::integer AS count FROM semantic_search_blob WHERE connector_instance_id = $1 AND scope_key LIKE $2 AND record_key = $3",
          [device.connector_instance_id, '["messages",%', "same-key"]
        );
        assert.equal(requiredFirstRow(lexical.rows, "lexical delete count").count, 0);
        assert.equal(requiredFirstRow(semantic.rows, "semantic delete count").count, 0);
      });
    });
  });

  test("PostgreSQL HTTP partial failure rolls back input 1 and resumes the sticky prefix", async () => {
    await withTempPostgres(async (url) => {
      const suffix = `${process.pid}_${Date.now()}`;
      const trigger = `pdpp_test_fail_ingest_${suffix}`;
      const functionName = `pdpp_test_fail_ingest_fn_${suffix}`;
      const flagTable = `pdpp_test_fail_ingest_flag_${suffix}`;
      await initPostgresStorage({ backend: "postgres", databaseUrl: url });
      await postgresQuery(`CREATE TABLE ${flagTable}(enabled BOOLEAN NOT NULL)`);
      await postgresQuery(`INSERT INTO ${flagTable}(enabled) VALUES(TRUE)`);
      await postgresQuery(`
        CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF (SELECT enabled FROM ${flagTable} LIMIT 1) AND NEW.record_key = 'second-key' THEN
            RAISE EXCEPTION 'private-pg-trigger-sentinel';
          END IF;
          RETURN NEW;
        END
        $$
      `);
      await postgresQuery(
        `CREATE TRIGGER ${trigger} BEFORE INSERT OR UPDATE ON records FOR EACH ROW EXECUTE FUNCTION ${functionName}()`
      );

      const backend = deterministicBackend();
      await withServer(url, { semanticRetrievalBackend: backend }, async ({ asUrl }) => {
        const notifications: Array<{ version: number }> = [];
        try {
          const device = await enrollDevice(asUrl, `pg-partial-${Date.now()}`);
          await setMessagesManifest((messages) => {
            messages.query.search.semantic_fields = ["content"];
          });
          setClientEventEnqueueHook((change: { version: number }) => notifications.push(change));
          const records = [recordFor("first-key", "first"), recordFor("second-key", "second")];
          const batch = batchFor(device, "pg-partial-failure", records);
          const failed = await postJson(
            `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
            batch,
            authHeaders(device.device_token)
          );
          assert.equal(failed.status, 503, JSON.stringify(failed.body));
          assert.equal(
            requiredString(requiredJsonRecord(failed.body.error, "failed ingest error"), "code", "failed ingest error"),
            "device_ingest_retryable"
          );
          assert.doesNotMatch(JSON.stringify(failed.body), PRIVATE_PG_TRIGGER_SENTINEL);
          const partial = await postgresQuery(
            `SELECT
                 (SELECT COUNT(*) FROM records WHERE connector_instance_id = $1 AND stream = 'messages')::integer AS records,
                 (SELECT COUNT(*) FROM record_changes WHERE connector_instance_id = $1 AND stream = 'messages')::integer AS changes,
                 (SELECT max_version FROM version_counter WHERE connector_instance_id = $1 AND stream = 'messages') AS max_version,
                 (SELECT durable_prefix_count FROM device_ingest_batch_outcomes WHERE device_id = $2 AND batch_id = $3) AS prefix`,
            [device.connector_instance_id, device.device_id, batch.batch_id]
          );
          assert.deepEqual(
            {
              changes: requiredFirstRow(partial.rows, "partial ingest state").changes,
              maxVersion: Number(requiredFirstRow(partial.rows, "partial ingest state").max_version),
              prefix: Number(requiredFirstRow(partial.rows, "partial ingest state").prefix),
              records: requiredFirstRow(partial.rows, "partial ingest state").records,
            },
            { changes: 1, maxVersion: 1, prefix: 1, records: 1 }
          );
          assert.equal(notifications.length, 1);
          assert.deepEqual(
            notifications.map((change) => change.version),
            [1],
            "the changed durable prefix must publish its allocated PostgreSQL version"
          );

          await postgresQuery(`UPDATE ${flagTable} SET enabled = FALSE`);
          const resumed = await postJson(
            `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
            batch,
            authHeaders(device.device_token)
          );
          assert.equal(resumed.status, 201, JSON.stringify(resumed.body));
          const complete = await postgresQuery(
            `SELECT
                 (SELECT COUNT(*) FROM records WHERE connector_instance_id = $1 AND stream = 'messages')::integer AS records,
                 (SELECT COUNT(*) FROM record_changes WHERE connector_instance_id = $1 AND stream = 'messages')::integer AS changes,
                 (SELECT max_version FROM version_counter WHERE connector_instance_id = $1 AND stream = 'messages') AS max_version,
                 (SELECT version FROM records WHERE connector_instance_id = $1 AND stream = 'messages' AND record_key = 'first-key') AS first_version,
                 (SELECT version FROM records WHERE connector_instance_id = $1 AND stream = 'messages' AND record_key = 'second-key') AS second_version,
                 (SELECT durable_prefix_count FROM device_ingest_batch_outcomes WHERE device_id = $2 AND batch_id = $3) AS prefix`,
            [device.connector_instance_id, device.device_id, batch.batch_id]
          );
          assert.deepEqual(
            {
              changes: requiredFirstRow(complete.rows, "completed ingest state").changes,
              firstVersion: Number(requiredFirstRow(complete.rows, "completed ingest state").first_version),
              maxVersion: Number(requiredFirstRow(complete.rows, "completed ingest state").max_version),
              prefix: Number(requiredFirstRow(complete.rows, "completed ingest state").prefix),
              records: requiredFirstRow(complete.rows, "completed ingest state").records,
              secondVersion: Number(requiredFirstRow(complete.rows, "completed ingest state").second_version),
            },
            { changes: 2, firstVersion: 1, maxVersion: 2, prefix: 2, records: 2, secondVersion: 2 }
          );
          assert.equal(notifications.length, 2);
          assert.deepEqual(
            notifications.map((change) => change.version),
            [1, 2],
            "resume must publish the second allocated PostgreSQL version without replaying the first"
          );
          const completedOutcome = await postgresQuery(
            "SELECT status, durable_prefix_count, record_count FROM device_ingest_batch_outcomes WHERE device_id = $1 AND batch_id = $2",
            [device.device_id, batch.batch_id]
          );
          assert.deepEqual(requiredFirstRow(completedOutcome.rows, "completed outcome"), {
            durable_prefix_count: 2,
            record_count: 2,
            status: "accepted",
          });
          const callsBeforeReplay = backend.calls();
          const replay = await postJson(
            `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
            batch,
            authHeaders(device.device_token)
          );
          assert.equal(replay.status, 201);
          assert.deepEqual(replay.body, resumed.body);
          assert.equal(backend.calls(), callsBeforeReplay);
          assert.equal(notifications.length, 2);
        } finally {
          setClientEventEnqueueHook(null);
          await postgresQuery(`DROP TRIGGER IF EXISTS ${trigger} ON records`).catch(() => undefined);
          await postgresQuery(`DROP FUNCTION IF EXISTS ${functionName}()`).catch(() => undefined);
          await postgresQuery(`DROP TABLE IF EXISTS ${flagTable}`).catch(() => undefined);
        }
      });
    });
  });

  test("PostgreSQL deferred semantic failure accepts durable state and reconcile preserves a newer writer", async () => {
    let failFirst = true;
    const backend = deterministicBackend({
      onEmbed: (text) => {
        if (failFirst && text.includes("payload-a")) {
          failFirst = false;
          throw new Error("private-pg-semantic-backend-sentinel");
        }
      },
      vector: [0.2, 0.3, 0.4],
    });
    await withTempPostgres(async (url) => {
      await withServer(url, { semanticRetrievalBackend: backend }, async ({ asUrl }) => {
        const device = await enrollDevice(asUrl, `pg-interleave-${Date.now()}`);
        await setMessagesManifest((messages) => {
          messages.query.search.semantic_fields = ["content"];
        });
        const notifications: Array<{ version: number }> = [];
        setClientEventEnqueueHook((change: { version: number }) => notifications.push(change));
        try {
          const records = [recordFor("same-key", "payload-a")];
          const batch = batchFor(device, "pg-authoritative-interleave", records);
          const first = await postJson(
            `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
            batch,
            authHeaders(device.device_token)
          );
          // Durable acknowledgement is intentionally independent from the
          // deferred index lane. Drain the lane before asserting the fault's
          // dirty-scope consequence; the HTTP receipt itself must stay 201.
          assert.equal(first.status, 201, JSON.stringify(first.body));
          assert.doesNotMatch(JSON.stringify(first.body), PRIVATE_PG_SEMANTIC_SENTINEL);
          await drainConnectorInstanceIndexWorkForTests();
          assert.equal(
            await isSearchIndexScopeDirty({ connectorInstanceId: device.connector_instance_id, stream: "messages" }),
            true,
            "the failed deferred publish leaves the durable scope for reconcile"
          );

          // The barrier above proves the first publish already failed before
          // the direct writer commits. This adversarial order distinguishes
          // reconcile of the authoritative row from a stale batch retry.
          await ingestRecord(
            { connector_id: "codex", connector_instance_id: device.connector_instance_id },
            {
              data: {
                ...requiredFirstRow(records, "interleaved record").data,
                content: "payload-b",
                role: "assistant",
                timestamp: "2026-07-16T00:00:01.000Z",
              },
              emitted_at: "2026-07-16T00:00:01.000Z",
              key: "same-key",
              stream: "messages",
            }
          );
          assert.equal(notifications.length, 2);
          await drainConnectorInstanceIndexWorkForTests();
          const directCurrent = await postgresQuery(
            `SELECT record_json, emitted_at, cursor_value, semantic_time
               FROM records WHERE connector_instance_id = $1 AND stream = 'messages' AND record_key = 'same-key'`,
            [device.connector_instance_id]
          );
          assert.equal(requiredFirstRow(directCurrent.rows, "direct current record").record_json.content, "payload-b");
          assert.equal(
            new Date(requiredFirstRow(directCurrent.rows, "direct current record").emitted_at).toISOString(),
            "2026-07-16T00:00:01.000Z"
          );
          await runSearchIndexDirtyReconcileRound({ maxDurationMs: 5000, pageSize: 100 });
          assert.equal(
            await isSearchIndexScopeDirty({ connectorInstanceId: device.connector_instance_id, stream: "messages" }),
            false,
            "the existing dirty-scope reconcile converges after semantic capacity returns"
          );
          const callsBeforeReplay = backend.calls();
          const replay = await postJson(
            `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
            batch,
            authHeaders(device.device_token)
          );
          assert.equal(replay.status, 201, JSON.stringify(replay.body));
          assert.deepEqual(replay.body, first.body);
          assert.equal(backend.calls(), callsBeforeReplay, "accepted replay must not repeat semantic work");
          const durable = await postgresQuery(
            `SELECT version, record_json, cursor_value, primary_key_text, semantic_time
               FROM records WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3`,
            [device.connector_instance_id, "messages", "same-key"]
          );
          assert.equal(Number(requiredFirstRow(durable.rows, "durable authoritative record").version), 2);
          assert.equal(requiredFirstRow(durable.rows, "durable authoritative record").record_json.content, "payload-b");
          assert.equal(
            requiredFirstRow(durable.rows, "durable authoritative record").cursor_value,
            "2026-07-16T00:00:01.000Z"
          );
          assert.equal(requiredFirstRow(durable.rows, "durable authoritative record").primary_key_text, "same-key");
          assert.equal(
            requiredFirstRow(durable.rows, "durable authoritative record").semantic_time,
            "2026-07-16T00:00:01.000Z"
          );
          assert.equal(notifications.length, 2);
          const lexical = await postgresQuery(
            `SELECT value FROM lexical_search_index
              WHERE connector_instance_id = $1 AND stream = 'messages' AND record_key = 'same-key' AND field = 'content'`,
            [device.connector_instance_id]
          );
          assert.equal(requiredFirstRow(lexical.rows, "authoritative lexical record").value, "payload-b");
          const semantic = await postgresQuery(
            `SELECT embedding::text AS embedding FROM semantic_search_blob
              WHERE connector_instance_id = $1 AND scope_key LIKE '["messages",%' AND record_key = 'same-key'`,
            [device.connector_instance_id]
          );
          assert.equal(semantic.rowCount, 1);
          assert.match(
            requiredFirstRow(semantic.rows, "authoritative semantic record").embedding,
            SEMANTIC_VECTOR_COMPONENT
          );
        } finally {
          setClientEventEnqueueHook(null);
        }
      });
    });
  });

  test("PostgreSQL manifest drift keeps the failed reservation bound until retry", async () => {
    let changed = false;
    let targetTriggerFires = 0;
    const backend = deterministicBackend({
      model: () => "pg-drift",
    });
    await withTempPostgres(async (url) => {
      await withServer(url, { semanticRetrievalBackend: backend }, async ({ asUrl }) => {
        const device = await enrollDevice(asUrl, `pg-drift-${Date.now()}`);
        const unrelatedDevice = await enrollDevice(asUrl, `pg-drift-unrelated-${Date.now()}`);
        await setMessagesManifest((messages) => {
          // biome-ignore lint/performance/noDelete: establish the optional-field-absent baseline for this manifest proof.
          delete messages.schema.properties.updated_at;
          messages.cursor_field = "timestamp";
          messages.consent_time_field = "timestamp";
          messages.primary_key = ["id"];
          messages.query.search.semantic_fields = ["content"];
        });
        const initialManifest = requiredFirstRow(
          (
            await postgresQuery<{ manifest: JsonValue }>("SELECT manifest FROM connectors WHERE connector_id = $1", [
              "codex",
            ])
          ).rows,
          "initial connector manifest"
        ).manifest;
        const initialManifestFingerprint = fingerprintDeviceAttemptManifest(initialManifest);
        const initialSemanticCapabilityIdentity = backend.model();
        const records = [recordFor("same-key", "drift-content")];
        requiredFirstRow(records, "manifest drift record").data.updated_at = "2026-07-16T13:00:00.000Z";
        const batch = batchFor(device, "pg-manifest-drift", records);
        __setDeviceIngestPhaseFaultHookForTest(async (point, inputIndex, requestIdentity) => {
          // The hook is a process-global test seam. Its request identity keeps
          // this mutation bound to the target's durable boundary only.
          if (
            point !== "after-durable-record" ||
            inputIndex !== 0 ||
            requestIdentity?.deviceId !== device.device_id ||
            requestIdentity.batchId !== batch.batch_id ||
            changed
          ) {
            return;
          }
          changed = true;
          targetTriggerFires += 1;
          await setMessagesManifest((messages) => {
            messages.schema.properties.updated_at = { format: "date-time", type: "string" };
            messages.cursor_field = "updated_at";
            messages.consent_time_field = "updated_at";
            messages.primary_key = ["session_id"];
            messages.query.search.semantic_fields = ["role"];
          });
        });
        let first: Awaited<ReturnType<typeof postJson>>;
        try {
          const unrelated = await postJson(
            `${asUrl}/_ref/device-exporters/${encodeURIComponent(unrelatedDevice.device_id)}/ingest-batches`,
            batchFor(unrelatedDevice, "pg-manifest-drift-unrelated", [recordFor("unrelated-key", "unrelated-content")]),
            authHeaders(unrelatedDevice.device_token)
          );
          assert.equal(unrelated.status, 201, JSON.stringify(unrelated.body));
          assert.equal(changed, false, "an unrelated batch cannot mutate the target manifest trigger");
          assert.equal(targetTriggerFires, 0, "an unrelated batch cannot consume the target trigger");
          first = await postJson(
            `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
            batch,
            authHeaders(device.device_token)
          );
        } finally {
          __setDeviceIngestPhaseFaultHookForTest(null);
        }
        assert.equal(changed, true, "the target record mutates the registered manifest");
        assert.equal(targetTriggerFires, 1, "the target trigger fires exactly once");
        assert.equal(
          backend.model(),
          initialSemanticCapabilityIdentity,
          "manifest drift proof keeps semantic capability identity constant"
        );
        const changedManifest = requiredFirstRow(
          (
            await postgresQuery<{ manifest: JsonValue }>("SELECT manifest FROM connectors WHERE connector_id = $1", [
              "codex",
            ])
          ).rows,
          "changed connector manifest"
        ).manifest;
        const changedManifestFingerprint = fingerprintDeviceAttemptManifest(changedManifest);
        assert.notEqual(
          changedManifestFingerprint,
          initialManifestFingerprint,
          "the target manifest mutation must produce a distinct production fingerprint"
        );
        assert.equal(first.status, 503, JSON.stringify(first.body));
        const stale = await postgresQuery(
          `SELECT cursor_value, primary_key_text, semantic_time
             FROM records WHERE connector_instance_id = $1 AND stream = 'messages' AND record_key = 'same-key'`,
          [device.connector_instance_id]
        );
        const staleOutcome = await postgresQuery(
          `SELECT durable_prefix_count, manifest_fingerprint, semantic_capability_identity FROM device_ingest_batch_outcomes
             WHERE device_id = $1 AND batch_id = $2`,
          [device.device_id, batch.batch_id]
        );
        assert.equal(Number(requiredFirstRow(staleOutcome.rows, "stale outcome").durable_prefix_count), 1);
        assert.equal(requiredFirstRow(stale.rows, "stale record").cursor_value, "2026-07-16T00:00:00.000Z");
        assert.equal(requiredFirstRow(stale.rows, "stale record").primary_key_text, "same-key");
        assert.equal(requiredFirstRow(stale.rows, "stale record").semantic_time, "2026-07-16T00:00:00.000Z");
        const staleReservation = requiredFirstRow(staleOutcome.rows, "stale reservation");
        assert.equal(
          staleReservation.manifest_fingerprint,
          initialManifestFingerprint,
          "the failed reservation remains bound to the manifest captured before deferred work"
        );
        assert.notEqual(
          staleReservation.manifest_fingerprint,
          changedManifestFingerprint,
          "the deferred mutation must differ from the manifest captured by the first attempt"
        );
        const retry = await postJson(
          `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
          batch,
          authHeaders(device.device_token)
        );
        assert.equal(retry.status, 201, JSON.stringify(retry.body));
        const refreshedReservation = requiredFirstRow(
          (
            await postgresQuery<{ manifest_fingerprint: string; semantic_capability_identity: string }>(
              "SELECT manifest_fingerprint, semantic_capability_identity FROM device_ingest_batch_outcomes WHERE device_id = $1 AND batch_id = $2",
              [device.device_id, batch.batch_id]
            )
          ).rows,
          "refreshed reservation"
        );
        assert.equal(
          refreshedReservation.manifest_fingerprint,
          changedManifestFingerprint,
          "the retry binds the processing reservation to the re-read manifest"
        );
        assert.equal(
          refreshedReservation.semantic_capability_identity,
          staleReservation.semantic_capability_identity,
          "the retry holds semantic capability identity constant across manifest drift"
        );
        const repaired = await postgresQuery(
          `SELECT cursor_value, primary_key_text, semantic_time
             FROM records WHERE connector_instance_id = $1 AND stream = 'messages' AND record_key = 'same-key'`,
          [device.connector_instance_id]
        );
        assert.deepEqual(requiredFirstRow(repaired.rows, "repaired record"), {
          cursor_value: "2026-07-16T13:00:00.000Z",
          primary_key_text: "same-key",
          semantic_time: "2026-07-16T13:00:00.000Z",
        });

        // Prove the remaining-suffix/no-op seam separately from the skipped
        // prefix repair above. A fresh reservation over an anchored identical
        // row must repair all manifest-derived columns without a new version.
        await postgresQuery(
          `UPDATE records
              SET cursor_value = 'stale-cursor',
                  primary_key_text = 'stale-primary',
                  semantic_time = '2026-07-16T00:00:00.000Z'
            WHERE connector_instance_id = $1 AND stream = 'messages' AND record_key = 'same-key'`,
          [device.connector_instance_id]
        );
        const freshNoop = await postJson(
          `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
          { ...batch, batch_id: "pg-fresh-noop-derived-repair" },
          authHeaders(device.device_token)
        );
        assert.equal(freshNoop.status, 201, JSON.stringify(freshNoop.body));
        const freshNoopRepair = await postgresQuery(
          `SELECT version, cursor_value, primary_key_text, semantic_time
             FROM records WHERE connector_instance_id = $1 AND stream = 'messages' AND record_key = 'same-key'`,
          [device.connector_instance_id]
        );
        assert.deepEqual(
          {
            cursor_value: requiredFirstRow(freshNoopRepair.rows, "fresh no-op repair").cursor_value,
            primary_key_text: requiredFirstRow(freshNoopRepair.rows, "fresh no-op repair").primary_key_text,
            semantic_time: requiredFirstRow(freshNoopRepair.rows, "fresh no-op repair").semantic_time,
            version: Number(requiredFirstRow(freshNoopRepair.rows, "fresh no-op repair").version),
          },
          {
            cursor_value: "2026-07-16T13:00:00.000Z",
            primary_key_text: "same-key",
            semantic_time: "2026-07-16T13:00:00.000Z",
            version: 1,
          }
        );
      });
    });
  });

  test("PostgreSQL HTTP 100-record correctness and bounded deterministic latency", async () => {
    const previousConcurrency = process.env.PDPP_INGEST_FINAL_INDEX_PLAN_CONCURRENCY;
    const previousSemanticLimit = process.env.PDPP_SEMANTIC_WORK_LIMIT;
    const previousDeadline = process.env.PDPP_INGEST_BATCH_ATTEMPT_DEADLINE_MS;
    process.env.PDPP_INGEST_FINAL_INDEX_PLAN_CONCURRENCY = "4";
    process.env.PDPP_SEMANTIC_WORK_LIMIT = "4";
    process.env.PDPP_INGEST_BATCH_ATTEMPT_DEADLINE_MS = "10000";
    try {
      const backend = deterministicBackend({ delayMs: 80 });
      await withTempPostgres(async (url) => {
        await withServer(url, { semanticRetrievalBackend: backend }, async ({ asUrl }) => {
          const device = await enrollDevice(asUrl, `pg-100-${Date.now()}`);
          await setMessagesManifest((messages) => {
            messages.query.search.semantic_fields = ["content"];
          });
          const records = Array.from({ length: 100 }, (_, index) =>
            recordFor(`row-${String(index).padStart(3, "0")}`, `payload-${index}`)
          );
          const batch = batchFor(device, "pg-100-correctness", records);
          const started = performance.now();
          const accepted = await postJson(
            `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
            batch,
            authHeaders(device.device_token)
          );
          const elapsedMs = performance.now() - started;
          assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
          assert.ok(elapsedMs < 6500, `deterministic overlap latency ${elapsedMs.toFixed(1)}ms exceeded 6500ms`);
          // `201` proves durable acceptance, not immediate search visibility.
          // Use the deferred lane's own settlement barrier before reading the
          // lexical/semantic projections; the latency assertion above remains
          // deliberately independent from deferred convergence.
          await drainConnectorInstanceIndexWorkForTests();
          const counts = await postgresQuery(
            `SELECT
               (SELECT COUNT(*) FROM records WHERE connector_instance_id = $1 AND stream = 'messages' AND deleted = FALSE)::integer AS records,
               (SELECT COUNT(*) FROM lexical_search_index WHERE connector_instance_id = $1 AND stream = 'messages')::integer AS lexical,
               (SELECT COUNT(*) FROM semantic_search_blob WHERE connector_instance_id = $1 AND scope_key LIKE '["messages",%')::integer AS semantic,
               (SELECT durable_prefix_count FROM device_ingest_batch_outcomes WHERE device_id = $2 AND batch_id = $3) AS prefix`,
            [device.connector_instance_id, device.device_id, batch.batch_id]
          );
          assert.equal(requiredFirstRow(counts.rows, "hundred-record counts").records, 100);
          assert.ok(requiredFirstRow(counts.rows, "hundred-record counts").lexical >= 100);
          assert.equal(requiredFirstRow(counts.rows, "hundred-record counts").semantic, 100);
          assert.equal(Number(requiredFirstRow(counts.rows, "hundred-record counts").prefix), 100);
          const callsBeforeReplay = backend.calls();
          const replayStarted = performance.now();
          const replay = await postJson(
            `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
            batch,
            authHeaders(device.device_token)
          );
          const replayElapsedMs = performance.now() - replayStarted;
          assert.equal(replay.status, 201);
          assert.deepEqual(replay.body, accepted.body);
          assert.equal(backend.calls(), callsBeforeReplay, "accepted replay must not perform semantic work");
          console.log(
            JSON.stringify({ elapsedMs, embedCalls: callsBeforeReplay, oracle: "postgres-http-100", replayElapsedMs })
          );
        });
      });
    } finally {
      const priorEnvironment: [string, string | undefined][] = [
        ["PDPP_INGEST_FINAL_INDEX_PLAN_CONCURRENCY", previousConcurrency],
        ["PDPP_SEMANTIC_WORK_LIMIT", previousSemanticLimit],
        ["PDPP_INGEST_BATCH_ATTEMPT_DEADLINE_MS", previousDeadline],
      ];
      for (const [name, value] of priorEnvironment) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
    }
  });

  test("spawned server preserves the durable acknowledgement before deferred child fail-stop", async () => {
    await withTempPostgres(async (url) => {
      const payloadSentinel = "private-spawned-failstop-record-sentinel";
      const timingMutation = process.env.PDPP_FAILSTOP_TIMING_MUTATION_ORACLE === "1";
      let failedServer: Awaited<ReturnType<typeof startFailStopServerFixture>> | null = null;
      let recoveryServer: Awaited<ReturnType<typeof startFailStopServerFixture>> | null = null;
      let releaseAcceptedTransitionBarrier: (() => Promise<void>) | null = null;
      try {
        const failedAttachment = await createAlreadyAdmittedTestDatabaseChildAttachment(url);
        const recoveryAttachment = await createAlreadyAdmittedTestDatabaseChildAttachment(url);
        failedServer = await startFailStopServerFixture(url, "fail", failedAttachment);
        // Start the recovery child while the guarded database is still empty.
        // Its independent process stays idle until the fail-stop child exits,
        // then proves an accepted batch is a durable replay rather than a
        // response emitted by the crashed process.
        recoveryServer = await startFailStopServerFixture(url, "recover", recoveryAttachment);
        const device = await enrollDevice(failedServer.asUrl, `pg-failstop-${Date.now()}`);
        const records = [recordFor("failstop-record", payloadSentinel)];
        const batch = batchFor(device, "pg-spawned-failstop-restart", records);
        if (timingMutation) {
          releaseAcceptedTransitionBarrier = await installAcceptedTransitionBarrier(url);
        }
        type InFlightResult =
          | { error: unknown; kind: "error" }
          | { kind: "response"; response: { body: HttpResponseBody; status: number } };
        const inFlight: Promise<InFlightResult> = postJson(
          `${failedServer.asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
          batch,
          authHeaders(device.device_token)
        ).then(
          (response) => ({ kind: "response", response }),
          (error: unknown) => ({ error, kind: "error" })
        );
        const failedExit = timingMutation ? await awaitFixtureExit(failedServer, 10_000) : null;
        const acknowledged = await inFlight;
        if (timingMutation) {
          assert.deepEqual(
            failedExit,
            { code: 1, signal: null },
            "the timing mutant must fail-stop before the accepted transition can commit"
          );
          assert.equal(acknowledged.kind, "error", "a pre-acceptance child fail-stop must not return 201");
          const releaseBarrier = releaseAcceptedTransitionBarrier;
          if (!releaseBarrier) {
            throw new Error("timing mutation acceptance barrier was not installed");
          }
          await releaseBarrier();
          releaseAcceptedTransitionBarrier = null;
          const verify = new Pool({ connectionString: url });
          try {
            const processing = await verify.query(
              "SELECT status, durable_prefix_count FROM device_ingest_batch_outcomes WHERE device_id = $1 AND batch_id = $2",
              [device.device_id, batch.batch_id]
            );
            assert.deepEqual(requiredFirstRow(processing.rows, "timing-mutant processing reservation"), {
              durable_prefix_count: 1,
              status: "processing",
            });
          } finally {
            await verify.end();
          }
          return;
        }
        assert.equal(
          acknowledged.kind,
          "response",
          "a post-acceptance child failure must preserve the durable acknowledgement"
        );
        if (acknowledged.kind === "response") {
          assert.equal(acknowledged.response.status, 201, JSON.stringify(acknowledged.response.body));
        }

        const confirmedFailedExit = await awaitFixtureExit(failedServer, 10_000);
        assert.deepEqual(
          confirmedFailedExit,
          { code: 1, signal: null },
          "an unconfirmed SIGKILL receipt must fail-stop the server nonzero after acknowledgement"
        );
        assert.ok(
          failedServer.output().includes('"event":"transformer-child-sigkill"'),
          "the fixture must reach the child SIGKILL path after durable acceptance"
        );

        const verify = new Pool({ connectionString: url });
        try {
          const processing = await verify.query(
            `SELECT
               (SELECT status FROM device_ingest_batch_outcomes WHERE device_id = $1 AND batch_id = $2) AS status,
               (SELECT durable_prefix_count FROM device_ingest_batch_outcomes WHERE device_id = $1 AND batch_id = $2) AS prefix,
               (SELECT COUNT(*) FROM records WHERE connector_instance_id = $3 AND stream = 'messages')::integer AS records,
               (SELECT COUNT(*) FROM record_changes WHERE connector_instance_id = $3 AND stream = 'messages')::integer AS changes,
               (SELECT version FROM records WHERE connector_instance_id = $3 AND stream = 'messages' AND record_key = 'failstop-record') AS version`,
            [device.device_id, batch.batch_id, device.connector_instance_id]
          );
          assert.deepEqual(
            {
              changes: requiredFirstRow(processing.rows, "fail-stop accepted state").changes,
              prefix: Number(requiredFirstRow(processing.rows, "fail-stop accepted state").prefix),
              records: requiredFirstRow(processing.rows, "fail-stop accepted state").records,
              status: requiredFirstRow(processing.rows, "fail-stop accepted state").status,
              version: Number(requiredFirstRow(processing.rows, "fail-stop accepted state").version),
            },
            { changes: 1, prefix: 1, records: 1, status: "accepted", version: 1 }
          );
        } finally {
          await verify.end();
        }

        const resumed = await postJson(
          `${recoveryServer.asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
          batch,
          authHeaders(device.device_token)
        );
        assert.equal(resumed.status, 201, JSON.stringify(resumed.body));
        const replay = await postJson(
          `${recoveryServer.asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
          batch,
          authHeaders(device.device_token)
        );
        assert.equal(replay.status, 201);
        assert.deepEqual(replay.body, resumed.body);

        const after = new Pool({ connectionString: url });
        try {
          const accepted = await after.query(
            `SELECT
               (SELECT status FROM device_ingest_batch_outcomes WHERE device_id = $1 AND batch_id = $2) AS status,
               (SELECT durable_prefix_count FROM device_ingest_batch_outcomes WHERE device_id = $1 AND batch_id = $2) AS prefix,
               (SELECT COUNT(*) FROM record_changes WHERE connector_instance_id = $3 AND stream = 'messages')::integer AS changes,
               (SELECT version FROM records WHERE connector_instance_id = $3 AND stream = 'messages' AND record_key = 'failstop-record') AS version,
               (SELECT COUNT(*) FROM lexical_search_index WHERE connector_instance_id = $3 AND stream = 'messages' AND record_key = 'failstop-record')::integer AS lexical,
               (SELECT COUNT(*) FROM semantic_search_blob WHERE connector_instance_id = $3 AND record_key = 'failstop-record')::integer AS semantic`,
            [device.device_id, batch.batch_id, device.connector_instance_id]
          );
          assert.deepEqual(
            {
              changes: requiredFirstRow(accepted.rows, "fail-stop accepted state").changes,
              lexical: requiredFirstRow(accepted.rows, "fail-stop accepted state").lexical,
              prefix: Number(requiredFirstRow(accepted.rows, "fail-stop accepted state").prefix),
              semantic: requiredFirstRow(accepted.rows, "fail-stop accepted state").semantic,
              status: requiredFirstRow(accepted.rows, "fail-stop accepted state").status,
              version: Number(requiredFirstRow(accepted.rows, "fail-stop accepted state").version),
            },
            // The child died while acknowledgement-independent index work was
            // pending. The durable reply must replay exactly; reconcile owns
            // any later projection convergence.
            { changes: 1, lexical: 0, prefix: 1, semantic: 0, status: "accepted", version: 1 }
          );
        } finally {
          await after.end();
        }

        const recoveryExit = await stopServerFixture(requiredValue(recoveryServer, "recovery server"));
        assert.deepEqual(recoveryExit, { code: 0, signal: null });
        const captured = `${requiredValue(failedServer, "failed server").output()}${requiredValue(recoveryServer, "recovery server").output()}`;
        assert.equal(captured.includes(payloadSentinel), false);
        assert.equal(captured.includes(device.device_token), false);
        assert.equal(captured.includes("pdpp_test"), false);
      } finally {
        await releaseAcceptedTransitionBarrier?.();
        if (failedServer?.child.exitCode === null && failedServer?.child.signalCode === null) {
          failedServer.child.kill("SIGKILL");
        }
        if (recoveryServer?.child.exitCode === null && recoveryServer?.child.signalCode === null) {
          recoveryServer.child.kill("SIGKILL");
        }
      }
    });
  });

  test("real local child + PostgreSQL HTTP preserves exact 100-record output, latency, lifecycle, and privacy", {
    skip: process.env.PDPP_REAL_LOCAL_TRANSFORMER_POSTGRES_ORACLE !== "1",
  }, async () => {
    const environment = {
      PDPP_INGEST_BATCH_ATTEMPT_DEADLINE_MS: "90000",
      PDPP_INGEST_FINAL_INDEX_PLAN_CONCURRENCY: "4",
      PDPP_SEMANTIC_WORK_ACQUIRE_DEADLINE_MS: "60000",
      PDPP_SEMANTIC_WORK_LIMIT: "1",
      PDPP_SEMANTIC_WORK_QUEUE_LIMIT: "16",
    };
    const previous = new Map(Object.keys(environment).map((name) => [name, process.env[name]]));
    for (const [name, value] of Object.entries(environment)) {
      process.env[name] = value;
    }
    let embedCalls = 0;
    let backend: ObservedLocalBackend | null = null;
    const logLines: string[] = [];
    const logger = capturingLogger(logLines);
    const payloadSentinel = "private-real-local-payload-sentinel SELECT pg_sleep(99) /owner/private/path";
    const responses: HttpResponseBody[] = [];
    const credentialSentinels: string[] = [];
    let receipt: {
      childHighWater: number;
      elapsedMs: number[];
      embedCalls: number;
      oracle: string;
      peakChildRssBytes: number;
      replayElapsedMs: number;
    } | null = null;
    try {
      const rawBackend = makeLocalTransformerBackend(undefined, {
        executorOptions: {
          deadlineMs: 60_000,
          queueLimit: 16,
          workLimit: 1,
        },
      });
      assert.equal(rawBackend.available(), true, "the real local model cache must be present with downloads disabled");
      const observedBackend = observeLocalTransformerBackend(rawBackend);
      const activeBackend: ObservedLocalBackend = {
        ...observedBackend,
        embedDocument: (text: string) => {
          embedCalls += 1;
          return observedBackend.embedDocument(text);
        },
      };
      backend = activeBackend;
      const content = Array.from({ length: 100 }, (_, index) =>
        index === 0 ? payloadSentinel : `real local transformer HTTP equality record ${index}`
      );
      const expectedVectors = await mapSequentially(content, (value) => activeBackend.embedDocument(value));
      const baselineCalls = embedCalls;
      backend.resetExecutionTelemetry();

      await withTempPostgres(async (url) => {
        await withServer(url, { logger, semanticRetrievalBackend: backend }, async ({ asUrl }) => {
          const device = await enrollDevice(asUrl, `pg-real-local-${Date.now()}`);
          credentialSentinels.push(device.device_token);
          await setMessagesManifest((messages) => {
            messages.query.search.lexical_fields = ["content"];
            messages.query.search.semantic_fields = ["content"];
          });
          const batches = [0, 1].map((batchIndex) => {
            const records = content.map((value, index) =>
              recordFor(`real-${batchIndex}-${String(index).padStart(3, "0")}`, value)
            );
            return batchFor(device, `pg-real-local-100-${batchIndex}`, records, batchIndex + 1);
          });
          const elapsed: number[] = [];
          await mapSequentially(batches, async (batch) => {
            const started = performance.now();
            const accepted = await postJson(
              `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
              batch,
              authHeaders(device.device_token)
            );
            elapsed.push(performance.now() - started);
            responses.push(accepted.body);
            assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
          });
          assert.ok(
            elapsed.every((value) => value < 30_000),
            `real local HTTP latency exceeded 30s: ${elapsed.join(", ")}`
          );
          assert.ok(
            elapsed.reduce((sum, value) => sum + value, 0) < 60_000,
            "two real 100-record batches must retain 2x margin inside the collector pass"
          );

          const expectedCallsAfterIngest = baselineCalls + 200;
          assert.equal(embedCalls, expectedCallsAfterIngest, "each required semantic row must execute exactly once");
          const replayStarted = performance.now();
          const replay = await postJson(
            `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
            batches[0],
            authHeaders(device.device_token)
          );
          const replayElapsedMs = performance.now() - replayStarted;
          responses.push(replay.body);
          assert.equal(replay.status, 201);
          assert.deepEqual(replay.body, requiredFirstRow(responses, "accepted response"));
          assert.equal(embedCalls, expectedCallsAfterIngest, "accepted replay must execute no local-transformer work");
          assert.ok(replayElapsedMs < 2000, `accepted replay took ${replayElapsedMs.toFixed(1)}ms`);

          const counts = await postgresQuery(
            `SELECT
               (SELECT COUNT(*) FROM records WHERE connector_instance_id = $1 AND stream = 'messages' AND deleted = FALSE)::integer AS records,
               (SELECT COUNT(*) FROM record_changes WHERE connector_instance_id = $1 AND stream = 'messages')::integer AS changes,
               (SELECT COUNT(*) FROM lexical_search_index WHERE connector_instance_id = $1 AND stream = 'messages')::integer AS lexical,
               (SELECT COUNT(*) FROM semantic_search_blob WHERE connector_instance_id = $1 AND scope_key = $2)::integer AS semantic,
               (SELECT max_version FROM version_counter WHERE connector_instance_id = $1 AND stream = 'messages') AS max_version,
               (SELECT COUNT(*) FROM device_ingest_batch_outcomes WHERE device_id = $3 AND status = 'accepted')::integer AS accepted_outcomes,
               (SELECT MIN(durable_prefix_count) FROM device_ingest_batch_outcomes WHERE device_id = $3) AS min_prefix`,
            [device.connector_instance_id, JSON.stringify(["messages", "content"]), device.device_id]
          );
          assert.deepEqual(
            {
              acceptedOutcomes: requiredFirstRow(counts.rows, "real local counts").accepted_outcomes,
              changes: requiredFirstRow(counts.rows, "real local counts").changes,
              lexical: requiredFirstRow(counts.rows, "real local counts").lexical,
              maxVersion: Number(requiredFirstRow(counts.rows, "real local counts").max_version),
              minPrefix: Number(requiredFirstRow(counts.rows, "real local counts").min_prefix),
              records: requiredFirstRow(counts.rows, "real local counts").records,
              semantic: requiredFirstRow(counts.rows, "real local counts").semantic,
            },
            {
              acceptedOutcomes: 2,
              changes: 200,
              lexical: 200,
              maxVersion: 200,
              minPrefix: 100,
              records: 200,
              semantic: 200,
            }
          );

          const lexical = await postgresQuery(
            `SELECT record_key, value
               FROM lexical_search_index
              WHERE connector_instance_id = $1 AND stream = 'messages' AND field = 'content'
              ORDER BY record_key`,
            [device.connector_instance_id]
          );
          assert.equal(lexical.rowCount, 200);
          for (const row of lexical.rows) {
            const index = Number(row.record_key.slice(-3));
            assert.equal(row.value, requiredAt(content, index, "expected lexical content"));
          }

          const semantic = await postgresQuery(
            `SELECT record_key, embedding::text AS embedding
               FROM semantic_search_blob
              WHERE connector_instance_id = $1 AND scope_key = $2
              ORDER BY record_key`,
            [device.connector_instance_id, JSON.stringify(["messages", "content"])]
          );
          assert.equal(semantic.rowCount, 200);
          for (const row of semantic.rows) {
            const index = Number(row.record_key.slice(-3));
            const actual = Float32Array.from(JSON.parse(row.embedding));
            assert.equal(
              vectorBytes(actual).equals(vectorBytes(requiredAt(expectedVectors, index, "expected semantic vector"))),
              true,
              `PostgreSQL vector bytes diverged for ${row.record_key}`
            );
          }

          const telemetry = requiredValue(backend, "observed local transformer backend").executionTelemetry();
          assert.equal(telemetry.childHighWater, 1);
          assert.equal(telemetry.pendingJobs, 0);
          assert.ok(telemetry.peakChildRssBytes > 0);
          receipt = {
            childHighWater: telemetry.childHighWater,
            elapsedMs: elapsed,
            embedCalls,
            oracle: "postgres-http-real-local-100x2",
            peakChildRssBytes: telemetry.peakChildRssBytes,
            replayElapsedMs,
          };

          const serializedResponses = JSON.stringify(responses);
          assert.doesNotMatch(serializedResponses, PRIVATE_REAL_LOCAL_SENTINEL);
          assert.equal(serializedResponses.includes(device.device_token), false);
          assert.equal(serializedResponses.includes("pdpp_test"), false);
        });
      });
    } finally {
      try {
        if (backend) {
          const closeStarted = performance.now();
          await within(backend.close(), 10_000, "real local child close exceeded 10s");
          const lifecycle = backend.executionTelemetry();
          assert.equal(lifecycle.pendingJobs, 0);
          assert.equal(lifecycle.childPid, null);
          assert.equal(lifecycle.terminating, false);
          assert.ok(performance.now() - closeStarted < 10_000);
        }
        logger.flush?.();
        const captured = logLines.join("");
        assert.doesNotMatch(captured, PRIVATE_REAL_LOCAL_SENTINEL);
        assert.equal(
          captured.includes("pdpp_test"),
          false,
          "captured logs must not expose the PostgreSQL credential sentinel"
        );
        assert.equal(captured.includes(process.env.PDPP_EMBEDDING_CACHE_DIR || "/cache/path/not-configured"), false);
        for (const sentinel of credentialSentinels) {
          assert.equal(captured.includes(sentinel), false);
        }
      } finally {
        for (const [name, value] of previous) {
          if (value === undefined) {
            delete process.env[name];
          } else {
            process.env[name] = value;
          }
        }
      }
    }
    assert.ok(receipt);
    console.log(JSON.stringify(receipt));
  });
} else {
  test("PostgreSQL device exporter proof (skipped: dedicated disposable URL not selected)", { skip: true }, () => {
    // The dedicated PostgreSQL test URL is intentionally absent.
  });
}
