// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { loadSyncState, runConnector } from "../runtime/index.ts";
import { closeDb, getDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { closePostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { __setAdmissionPreCheckPhaseHookForTest } from "../server/records.ts";
import { createRequestConnectorInstanceStore } from "../server/request-store-factories.ts";
import { admitOwnerRunConnection } from "../server/stores/connector-instance-store.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const OWNER_SUBJECT_ID = "owner_alice";
const OWNER_PASSWORD = "runtime-record-rejection-password";
const CSRF_RE = /<input type="hidden" name="_csrf" value="([^"]+)"\s*\/>/;
const SIMULATED_RESPONSE_LOSS_RE = /simulated response loss/;
const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);

function capturedLogger() {
  const entries: unknown[][] = [];
  const capture = (...args: unknown[]) => entries.push(args);
  const logger: Record<string, unknown> = {
    child: () => logger,
    debug: capture,
    error: capture,
    fatal: capture,
    info: capture,
    level: "trace",
    silent: () => undefined,
    trace: capture,
    warn: capture,
  };
  return {
    logger: logger as never,
    output: () =>
      JSON.stringify(entries, (_key, value) =>
        value instanceof Error ? { message: value.message, name: value.name, stack: value.stack } : value
      ),
  };
}

interface ClosableServer {
  abortStartupBackfill?: (reason: string) => void;
  asPort: number;
  asServer: { close: (cb: () => void) => void; closeAllConnections?: () => void };
  controller?: { drainActiveRuns?: (timeoutMs: number) => Promise<unknown> };
  rsPort: number;
  rsServer: { close: (cb: () => void) => void; closeAllConnections?: () => void };
  schedulerManager?: { stop?: () => void };
}

async function closeServer(server: ClosableServer): Promise<void> {
  server.schedulerManager?.stop?.();
  server.abortStartupBackfill?.("test shutdown");
  server.asServer.closeAllConnections?.();
  server.rsServer.closeAllConnections?.();
  const closeOne = (srv: { close: (cb: () => void) => void }) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2000);
      srv.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  await Promise.allSettled([
    closeOne(server.asServer),
    closeOne(server.rsServer),
    server.controller?.drainActiveRuns?.(1000).catch(() => undefined),
  ]);
  closeDb();
}

async function fetchJson(url: string, init?: RequestInit): Promise<{ body: unknown; status: number }> {
  const resp = await fetch(url, init);
  const text = await resp.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { body, status: resp.status };
}

function getSetCookies(resp: Response): string[] {
  const headersWithGetSetCookie = resp.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headersWithGetSetCookie.getSetCookie === "function") {
    return headersWithGetSetCookie.getSetCookie();
  }
  const single = resp.headers.get("set-cookie");
  return single ? [single] : [];
}

function findCookiePair(list: readonly string[], name: string): string | null {
  for (const header of list) {
    const [first] = header.split(";");
    if (first?.startsWith(`${name}=`)) {
      return first;
    }
  }
  return null;
}

async function login(asUrl: string): Promise<string> {
  const getResp = await fetch(`${asUrl}/owner/login`, {
    headers: { Accept: "text/html" },
    redirect: "manual",
  });
  const csrfCookie = findCookiePair(getSetCookies(getResp), "pdpp_owner_csrf");
  const csrfField = (await getResp.text()).match(CSRF_RE)?.[1] ?? "";
  const postResp = await fetch(`${asUrl}/owner/login`, {
    body: new URLSearchParams({ _csrf: csrfField, password: OWNER_PASSWORD, return_to: "/" }).toString(),
    headers: {
      Accept: "text/html",
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: csrfCookie ?? "",
    },
    method: "POST",
    redirect: "manual",
  });
  const session = findCookiePair(getSetCookies(postResp), "pdpp_owner_session");
  assert.ok(session, "owner login must return a session cookie");
  return session;
}

function streamSchema() {
  return {
    properties: { id: { type: "string" }, value: { type: "string" } },
    required: ["id"],
    type: "object",
  };
}

function manifest(connectorId: string) {
  return {
    connector_id: connectorId,
    connector_key: connectorId,
    display_name: "Runtime Record Rejection Journey Test Connector",
    manifest_uri: `https://registry.pdpp.dev/connectors/${connectorId}`,
    protocol_version: "0.1.0",
    streams: [
      {
        name: "items",
        primary_key: ["id"],
        schema: streamSchema(),
        selection: { fields: true, resources: true },
        semantics: "append_only",
      },
    ],
    version: "1.0.0",
  };
}

function runtimeManifest(connectorId: string): Parameters<typeof runConnector>[0]["manifest"] {
  return manifest(connectorId) as Parameters<typeof runConnector>[0]["manifest"];
}

function createTestConnector(messages: readonly Record<string, unknown>[]) {
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-runtime-record-rejection-connector-"));
  const connectorPath = join(tmpDir, "connector.mjs");
  const script = `
import { createInterface } from 'readline';

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START') {
    const messages = ${JSON.stringify(messages)};
    const done = [...messages].reverse().find((m) => m.type === 'DONE') || null;
    const exitCode = !done ? 0 : (done.status === 'succeeded' ? 0 : 1);
    for (const m of messages) process.stdout.write(JSON.stringify(m) + '\\n');
    rl.close();
    process.exit(exitCode);
  }
});
`;
  writeFileSync(connectorPath, script, "utf-8");
  return { cleanup: () => rmSync(tmpDir, { force: true, recursive: true }), connectorPath };
}

function createIdlingTestConnector(messages: readonly Record<string, unknown>[]) {
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-runtime-record-rejection-idling-connector-"));
  const connectorPath = join(tmpDir, "connector.mjs");
  const script = `
import { createInterface } from 'readline';

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START') {
    const messages = ${JSON.stringify(messages)};
    for (const m of messages) process.stdout.write(JSON.stringify(m) + '\\n');
    setInterval(() => {}, 1000);
  }
});
`;
  writeFileSync(connectorPath, script, "utf-8");
  return { cleanup: () => rmSync(tmpDir, { force: true, recursive: true }), connectorPath };
}

async function registerManifest(asUrl: string, ownerSession: string, connectorManifest: Record<string, unknown>) {
  const response = await fetchJson(`${asUrl}/connectors`, {
    body: JSON.stringify(connectorManifest),
    headers: { "Content-Type": "application/json", Cookie: ownerSession },
    method: "POST",
  });
  assert.ok(response.status === 200 || response.status === 201, `manifest registration failed: ${response.status}`);
}

interface DeviceAuthorizationBody {
  device_code: string;
  user_code: string;
}

interface TokenBody {
  access_token: string;
}

async function issueOwnerToken(asUrl: string, ownerSession: string, subjectId = OWNER_SUBJECT_ID): Promise<string> {
  const clientId = "cli_longview";
  const { body } = await fetchJson(`${asUrl}/oauth/device_authorization`, {
    body: JSON.stringify({ client_id: clientId }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const device = body as DeviceAuthorizationBody;
  const approveResp = await fetch(`${asUrl}/device/approve`, {
    body: JSON.stringify({ subject_id: subjectId, user_code: device.user_code }),
    headers: { "Content-Type": "application/json", Cookie: ownerSession },
    method: "POST",
  });
  assert.equal(approveResp.status, 200);
  const { body: tokenBody } = await fetchJson(`${asUrl}/oauth/token`, {
    body: JSON.stringify({
      client_id: clientId,
      device_code: device.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  return (tokenBody as TokenBody).access_token;
}

function sqliteRunHistoryFacts(runId: string): Record<string, unknown> {
  const row = getDb().prepare("SELECT facts_json FROM run_history WHERE run_id = ?").get(runId) as
    | { facts_json: string | null }
    | undefined;
  assert.ok(row, `expected run_history row for ${runId}`);
  return JSON.parse(row.facts_json ?? "{}") as Record<string, unknown>;
}

async function countPostgresRecords(connectorInstanceId: string): Promise<number> {
  const result = await postgresQuery<{ count: number }>(
    "SELECT COUNT(*)::int AS count FROM records WHERE connector_instance_id = $1 AND deleted = false",
    [connectorInstanceId]
  );
  return result.rows[0]?.count ?? 0;
}

async function countPostgresRejections(connectorInstanceId: string): Promise<number> {
  const result = await postgresQuery<{ count: number }>(
    "SELECT COUNT(*)::int AS count FROM record_rejections WHERE connector_instance_id = $1",
    [connectorInstanceId]
  );
  return result.rows[0]?.count ?? 0;
}

async function readPostgresRejectedPayload(
  connectorInstanceId: string
): Promise<{ payload: Buffer; receipt_id: string }> {
  const result = await postgresQuery<{ payload: Buffer; receipt_id: string }>(
    `SELECT payload, receipt_id
       FROM record_rejections
      WHERE connector_instance_id = $1
      ORDER BY created_at ASC
      LIMIT 1`,
    [connectorInstanceId]
  );
  const [row] = result.rows;
  assert.ok(row, "expected one Postgres rejection receipt row");
  return row;
}

type RecordRejectionBackend = { kind: "sqlite"; dbPath: string } | { databaseUrl: string; kind: "postgres" };

async function startJourneyServer(backend: RecordRejectionBackend): Promise<ClosableServer> {
  const opts: Parameters<typeof startServer>[0] & { databaseUrl?: string; storageBackend?: string } = {
    asPort: 0,
    ownerAuthPassword: OWNER_PASSWORD,
    ownerAuthSubjectId: OWNER_SUBJECT_ID,
    quiet: true,
    rsPort: 0,
    ...(backend.kind === "sqlite"
      ? { dbPath: backend.dbPath }
      : { databaseUrl: backend.databaseUrl, storageBackend: "postgres" }),
  };
  return await startServer(opts);
}

async function countDurableRecords(backend: RecordRejectionBackend, connectorInstanceId: string): Promise<number> {
  if (backend.kind === "postgres") {
    return await countPostgresRecords(connectorInstanceId);
  }
  return (
    getDb()
      .prepare("SELECT COUNT(*) AS count FROM records WHERE connector_instance_id = ? AND deleted = 0")
      .get<{ count: number }>(connectorInstanceId)?.count ?? 0
  );
}

async function countDurableRejections(backend: RecordRejectionBackend, connectorInstanceId: string): Promise<number> {
  if (backend.kind === "postgres") {
    return await countPostgresRejections(connectorInstanceId);
  }
  return (
    getDb()
      .prepare("SELECT COUNT(*) AS count FROM record_rejections WHERE connector_instance_id = ?")
      .get<{ count: number }>(connectorInstanceId)?.count ?? 0
  );
}

async function readRejectedPayload(
  backend: RecordRejectionBackend,
  connectorInstanceId: string
): Promise<{ payload: Buffer; receipt_id: string }> {
  if (backend.kind === "postgres") {
    return await readPostgresRejectedPayload(connectorInstanceId);
  }
  const row = getDb()
    .prepare(
      `SELECT payload, receipt_id
         FROM record_rejections
        WHERE connector_instance_id = ?
        ORDER BY created_at ASC
        LIMIT 1`
    )
    .get<{ payload: Buffer; receipt_id: string }>(connectorInstanceId);
  assert.ok(row, "expected one SQLite rejection receipt row");
  return row;
}

async function assertLaterSystemicSiblingPreservesDurablePrefix(backend: RecordRejectionBackend): Promise<void> {
  const connectorId = `route-systemic-prefix-${backend.kind}`;
  const acceptedRecord = JSON.stringify({
    data: { id: "accepted-prefix", value: "accepted" },
    emitted_at: "2026-08-11T13:00:00.000Z",
    key: "accepted-prefix",
  });
  const rejectedRecord = JSON.stringify({
    data: { id: "rejected-private-data", value: "private" },
    emitted_at: "2026-08-11T13:00:01.000Z",
    key: "rejected-private-key",
  });
  const systemicRecord = JSON.stringify({
    data: { id: "later-systemic", value: "accepted-on-replay" },
    emitted_at: "2026-08-11T13:00:02.000Z",
    key: "later-systemic",
  });
  const body = `${acceptedRecord}\n${rejectedRecord}\n${systemicRecord}`;
  const forbidden = [rejectedRecord, "rejected-private-key", "rejected-private-data"];
  let server: ClosableServer | null = null;

  try {
    server = await startJourneyServer(backend);
    const asUrl = `http://localhost:${server.asPort}`;
    const rsUrl = `http://localhost:${server.rsPort}`;
    const ownerSession = await login(asUrl);
    await registerManifest(asUrl, ownerSession, manifest(connectorId));
    const ownerToken = await issueOwnerToken(asUrl, ownerSession);
    const { connectorInstanceId } = await admitOwnerRunConnection({
      connectorId,
      connectorInstanceId: null,
      connectorInstanceStore: createRequestConnectorInstanceStore(),
      ownerSubjectId: OWNER_SUBJECT_ID,
    });
    const ingestUrl = `${rsUrl}/v1/ingest/items?connector_id=${encodeURIComponent(connectorId)}&connector_instance_id=${encodeURIComponent(connectorInstanceId)}`;

    let admittedRecordWrites = 0;
    __setAdmissionPreCheckPhaseHookForTest((point: string) => {
      if (point !== "after-admission-pre-check") {
        return;
      }
      admittedRecordWrites += 1;
      if (admittedRecordWrites === 3) {
        throw Object.assign(new Error("selected later sibling systemic failure"), { code: "ingest_storage_error" });
      }
    });
    const failed = await fetchJson(ingestUrl, {
      body,
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "Content-Type": "application/x-ndjson",
      },
      method: "POST",
    });
    assert.equal(failed.status, 503, `${backend.kind}: later systemic sibling must make the route non-2xx`);
    assert.equal(
      JSON.stringify(failed.body).includes("receipt_id"),
      false,
      "non-2xx response must not claim a receipt"
    );
    assert.equal(
      JSON.stringify(failed.body).includes("rejections"),
      false,
      "non-2xx response must not claim rejections"
    );
    assert.equal(
      JSON.stringify(failed.body).includes("next_cursor"),
      false,
      "non-2xx response must not claim a cursor"
    );
    assertOmitsPrivatePayload(`${backend.kind} systemic error body`, failed.body, forbidden);

    assert.equal(await countDurableRecords(backend, connectorInstanceId), 1);
    assert.equal(await countDurableRejections(backend, connectorInstanceId), 1);
    const receiptAfterFailure = await readRejectedPayload(backend, connectorInstanceId);
    assert.equal(receiptAfterFailure.payload.toString("utf8"), rejectedRecord);

    __setAdmissionPreCheckPhaseHookForTest(null);
    const replay = await fetchJson(ingestUrl, {
      body,
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "Content-Type": "application/x-ndjson",
      },
      method: "POST",
    });
    assert.equal(replay.status, 200, `${backend.kind}: exact replay must succeed once the systemic fault clears`);
    const replayBody = replay.body as {
      records_accepted?: number;
      records_rejected?: number;
      rejections?: { receipt_id?: string }[];
    };
    assert.equal(replayBody.records_rejected, 1);
    assert.equal(replayBody.rejections?.[0]?.receipt_id, receiptAfterFailure.receipt_id);
    assertOmitsPrivatePayload(`${backend.kind} replay body`, replayBody, forbidden);
    assert.equal(await countDurableRecords(backend, connectorInstanceId), 2, "replay must not duplicate the prefix");
    assert.equal(await countDurableRejections(backend, connectorInstanceId), 1, "replay must reuse the receipt");

    const receiptAfterReplay = await readRejectedPayload(backend, connectorInstanceId);
    assert.equal(receiptAfterReplay.receipt_id, receiptAfterFailure.receipt_id);
    assert.equal(receiptAfterReplay.payload.toString("utf8"), rejectedRecord);
  } finally {
    __setAdmissionPreCheckPhaseHookForTest(null);
    if (server) {
      await closeServer(server);
    } else if (backend.kind === "postgres") {
      await closePostgresStorage();
      closeDb();
    }
  }
}

function assertOmitsPrivatePayload(surfaceName: string, surface: unknown, forbidden: readonly string[]) {
  const serialized = JSON.stringify(surface);
  for (const needle of forbidden) {
    assert.equal(serialized.includes(needle), false, `${surfaceName} leaked ${needle}`);
  }
}

interface CapturedIngestEnvelope {
  body: unknown;
  runId: string;
}

function rejectionReceiptIdFromEnvelope(body: unknown): string {
  const { rejections } = body as { rejections?: { receipt_id?: unknown }[] };
  assert.ok(Array.isArray(rejections), "ingest envelope must include rejections array");
  assert.equal(rejections.length, 1);
  const receiptId = rejections[0]?.receipt_id;
  if (typeof receiptId !== "string") {
    assert.fail("ingest envelope rejection must include a string receipt_id");
  }
  return receiptId;
}

async function readPriorRuntimeIngestCounts(response: Response): Promise<{
  records_accepted: number;
  records_rejected: number;
}> {
  assert.equal(response.ok, true, "prior runtime requires a successful ingest response");
  const body = JSON.parse(await response.text()) as Record<string, unknown>;
  const recordsAccepted = body.records_accepted;
  const recordsRejected = body.records_rejected;
  assert.equal(Number.isFinite(recordsAccepted), true, "prior runtime requires a finite accepted count");
  assert.equal(Number.isFinite(recordsRejected), true, "prior runtime requires a finite rejected count");
  return {
    records_accepted: recordsAccepted as number,
    records_rejected: recordsRejected as number,
  };
}

function withCapturedIngestResponses({
  loseResponseForRunId,
  watchedRunIds,
}: {
  loseResponseForRunId: string;
  watchedRunIds: readonly string[];
}): {
  captured: () => readonly CapturedIngestEnvelope[];
  restore: () => void;
  seenLostResponse: () => number;
} {
  const originalFetch = globalThis.fetch;
  const captured: CapturedIngestEnvelope[] = [];
  const watched = new Set(watchedRunIds);
  let seenLostResponse = 0;
  globalThis.fetch = (async (input, init) => {
    let url: URL;
    if (typeof input === "string" || input instanceof URL) {
      url = new URL(input);
    } else {
      url = new URL(input.url);
    }
    const runId = url.searchParams.get("run_id") ?? "";
    if (url.pathname === "/v1/ingest/items" && watched.has(runId)) {
      const response = await originalFetch(input, init);
      captured.push({ body: await response.clone().json(), runId });
      if (runId === loseResponseForRunId) {
        seenLostResponse += 1;
        throw new Error("simulated response loss after durable ingest commit");
      }
      return response;
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  return {
    captured: () => captured,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
    seenLostResponse: () => seenLostResponse,
  };
}

test("runtime/server SQLite journey durably receipts invalid identity rejections and exposes payload only on owner detail", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-runtime-record-rejection-journey-"));
  const dbPath = join(dir, "store.sqlite");
  const connectorId = "runtime-record-rejection-journey";
  const runId = "run_record_rejection_journey";
  const okEmittedAt = "2026-08-11T12:00:00.000Z";
  const badEmittedAt = "2026-08-11T12:00:01.000Z";
  const acceptedRecord = { data: { id: "ok1", value: "ok" }, emitted_at: okEmittedAt, key: "ok1" };
  const rejectedRecord = { data: { id: "bad-data", value: "bad" }, emitted_at: badEmittedAt, key: "bad-key" };
  const rejectedPayloadLine = JSON.stringify(rejectedRecord);
  const forbiddenPayloadNeedles = [
    rejectedPayloadLine,
    "bad-key",
    "bad-data",
    "key and data.id disagree",
    "storage exploded",
    "parser exploded",
  ];
  const serverALogs = capturedLogger();
  const serverBLogs = capturedLogger();
  let serverA: ClosableServer | null = null;
  let serverB: ClosableServer | null = null;

  try {
    serverA = await startServer({
      asPort: 0,
      dbPath,
      logger: serverALogs.logger,
      ownerAuthPassword: OWNER_PASSWORD,
      ownerAuthSubjectId: OWNER_SUBJECT_ID,
      quiet: true,
      rsPort: 0,
    });
    const asUrlA = `http://localhost:${serverA.asPort}`;
    const rsUrlA = `http://localhost:${serverA.rsPort}`;
    const ownerSessionA = await login(asUrlA);
    await registerManifest(asUrlA, ownerSessionA, manifest(connectorId));
    const ownerToken = await issueOwnerToken(asUrlA, ownerSessionA);
    const { connectorInstanceId } = await admitOwnerRunConnection({
      connectorId,
      connectorInstanceId: null,
      connectorInstanceStore: createRequestConnectorInstanceStore(),
      ownerSubjectId: OWNER_SUBJECT_ID,
    });
    const progress: unknown[] = [];
    const { cleanup, connectorPath } = createTestConnector([
      { ...acceptedRecord, stream: "items", type: "RECORD" },
      { ...rejectedRecord, stream: "items", type: "RECORD" },
      { cursor: { cursor: "after_invalid_identity" }, stream: "items", type: "STATE" },
      { records_emitted: 2, status: "succeeded", type: "DONE" },
    ]);

    try {
      const result = await runConnector({
        admitRunConnection: async ({ connectorId: admittedConnectorId, connectorInstanceId: requestedInstanceId }) => ({
          connectorId: admittedConnectorId,
          connectorInstanceId: requestedInstanceId ?? connectorInstanceId,
          ownerSubjectId: OWNER_SUBJECT_ID,
        }),
        collectionMode: "full_refresh",
        connectorId,
        connectorInstanceId,
        connectorPath,
        manifest: runtimeManifest(connectorId),
        onInteraction: async () => ({}),
        onProgress: (message) => progress.push(message),
        ownerToken,
        persistState: true,
        rsUrl: rsUrlA,
        runId,
        scope: { streams: [{ name: "items" }] },
        state: null,
      });

      assert.equal(result.status, "succeeded");
      assert.equal(result.records_emitted, 2);
      assert.equal(result.records_attempted, 2);
      assert.equal(result.records_accepted, 1);
      assert.equal(result.records_permanently_rejected, 1);
      assert.equal(result.records_unresolved_retryable, 0);
      assert.equal(result.checkpoint_summary?.records_flushed, 1);
      assert.equal(result.checkpoint_summary?.records_attempted, 2);
      assert.equal(result.checkpoint_summary?.records_permanently_rejected, 1);
      assertOmitsPrivatePayload("runtime result", result, forbiddenPayloadNeedles);
      assertOmitsPrivatePayload("runtime progress", progress, forbiddenPayloadNeedles);
    } finally {
      cleanup();
    }

    const state = (await loadSyncState(connectorId, ownerToken, { connectorInstanceId, rsUrl: rsUrlA })) as Record<
      string,
      { cursor?: string } | undefined
    > | null;
    assert.equal(state?.items?.cursor, "after_invalid_identity", "complete receipt evidence allows cursor commit");

    const { body: recordsBody, status: recordsStatus } = await fetchJson(
      `${rsUrlA}/v1/streams/items/records?connector_id=${encodeURIComponent(connectorId)}&connector_instance_id=${encodeURIComponent(connectorInstanceId)}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } }
    );
    assert.equal(recordsStatus, 200);
    const records = (recordsBody as { data?: unknown[]; records?: unknown[] }).data ?? [];
    assert.deepEqual(
      records.map((record) => (record as { id?: string }).id),
      ["ok1"]
    );

    const row = getDb()
      .prepare(
        `SELECT receipt_id, reason_code, first_input_index, latest_input_index, payload, payload_sha256,
                payload_bytes, created_at, last_seen_at
         FROM record_rejections
         WHERE connector_instance_id = ?`
      )
      .get<{
        created_at: string;
        first_input_index: number;
        last_seen_at: string;
        latest_input_index: number;
        payload_bytes: number;
        payload_sha256: string;
        payload: Buffer;
        reason_code: string;
        receipt_id: string;
      }>(connectorInstanceId);
    assert.ok(row, "invalid identity must create a durable rejection receipt row");
    assert.equal(row.reason_code, "invalid_record_identity");
    assert.equal(row.first_input_index, 1);
    assert.equal(row.latest_input_index, 1);
    assert.equal(row.payload.toString("utf8"), rejectedPayloadLine);
    assert.equal(row.payload_bytes, Buffer.byteLength(rejectedPayloadLine));
    assert.ok(row.receipt_id.length > 0);
    assert.notEqual(row.receipt_id, row.payload_sha256);
    assert.notEqual(row.receipt_id, row.created_at);
    assert.notEqual(row.receipt_id, row.last_seen_at);

    const count = getDb()
      .prepare("SELECT COUNT(*) AS count FROM record_rejections WHERE connector_instance_id = ?")
      .get<{ count: number }>(connectorInstanceId);
    assert.equal(count?.count, 1);

    const facts = sqliteRunHistoryFacts(runId);
    assert.equal(facts.records_attempted, 2);
    assert.equal(facts.records_accepted, 1);
    assert.equal(facts.records_permanently_rejected, 1);
    assert.equal(facts.records_unresolved_retryable, 0);
    assert.equal(facts.records_flushed, 1);
    assertOmitsPrivatePayload("run history facts", facts, forbiddenPayloadNeedles);
    const spineEvidence = getDb().prepare("SELECT data_json FROM spine_events ORDER BY event_seq").all();
    assertOmitsPrivatePayload("spine timeline and mutation audit", spineEvidence, forbiddenPayloadNeedles);

    const auditEvent = getDb()
      .prepare(
        `SELECT actor_id, actor_type, data_json, event_type, object_id, object_type, trace_id
           FROM spine_events
          WHERE event_type = 'record_rejection.quarantined'`
      )
      .get<{
        actor_id: string;
        actor_type: string;
        data_json: string;
        event_type: string;
        object_id: string;
        object_type: string;
        trace_id: string;
      }>();
    assert.ok(auditEvent, "quarantine insert must commit its audit fact atomically");
    assert.equal(auditEvent.actor_id, OWNER_SUBJECT_ID);
    assert.equal(auditEvent.actor_type, "subject");
    assert.equal(auditEvent.object_id, row.receipt_id);
    assert.equal(auditEvent.object_type, "record_rejection");
    const auditData = JSON.parse(auditEvent.data_json) as Record<string, unknown>;
    assert.deepEqual(Object.keys(auditData).sort(), [
      "connection_id",
      "created_at",
      "last_seen_at",
      "payload_bytes",
      "payload_sha256",
      "reason_code",
      "receipt_id",
      "stream",
    ]);
    assert.equal(auditData.connection_id, connectorInstanceId);
    assert.equal(auditData.receipt_id, row.receipt_id);
    assert.equal(auditData.stream, "items");
    assert.equal(auditData.reason_code, "invalid_record_identity");
    assert.equal(auditData.payload_bytes, Buffer.byteLength(rejectedPayloadLine));
    assert.equal(auditData.payload_sha256, row.payload_sha256);
    assertOmitsPrivatePayload("fixed-field quarantine audit fact", auditData, forbiddenPayloadNeedles);

    const { body: runTimeline, status: runTimelineStatus } = await fetchJson(
      `${asUrlA}/_ref/runs/${encodeURIComponent(runId)}/timeline`,
      { headers: { Cookie: ownerSessionA } }
    );
    assert.equal(runTimelineStatus, 200);
    assertOmitsPrivatePayload("owner run timeline", runTimeline, forbiddenPayloadNeedles);

    const { body: auditTrace, status: auditTraceStatus } = await fetchJson(
      `${asUrlA}/_ref/traces/${encodeURIComponent(auditEvent.trace_id)}`,
      { headers: { Cookie: ownerSessionA } }
    );
    assert.equal(auditTraceStatus, 200);
    assertOmitsPrivatePayload("owner audit trace", auditTrace, forbiddenPayloadNeedles);

    const mutationEvents = getDb()
      .prepare("SELECT data_json FROM spine_events WHERE trace_id = ? AND event_type LIKE 'mutation.%'")
      .all(auditEvent.trace_id);
    assert.ok(mutationEvents.length >= 2, "ingest trace must include requested and completed mutation evidence");
    assertOmitsPrivatePayload("mutation evidence", mutationEvents, forbiddenPayloadNeedles);

    const { body: healthBody, status: healthStatus } = await fetchJson(
      `${asUrlA}/_ref/connectors/${encodeURIComponent(connectorId)}`,
      { headers: { Cookie: ownerSessionA } }
    );
    assert.equal(healthStatus, 200);
    assertOmitsPrivatePayload("connector health projection", healthBody, forbiddenPayloadNeedles);
    assertOmitsPrivatePayload("captured server logger", serverALogs.output(), forbiddenPayloadNeedles);

    await closeServer(serverA);
    serverA = null;

    serverB = await startServer({
      asPort: 0,
      dbPath,
      logger: serverBLogs.logger,
      ownerAuthPassword: OWNER_PASSWORD,
      ownerAuthSubjectId: OWNER_SUBJECT_ID,
      quiet: true,
      rsPort: 0,
    });
    const asUrlB = `http://localhost:${serverB.asPort}`;
    const ownerSessionB = await login(asUrlB);

    const listUrl = `${asUrlB}/_ref/connections/${encodeURIComponent(connectorInstanceId)}/record-rejections`;
    const { body: listBody, status: listStatus } = await fetchJson(listUrl, {
      headers: { Cookie: ownerSessionB },
    });
    assert.equal(listStatus, 200);
    const listItems = (listBody as { data?: Record<string, unknown>[] }).data ?? [];
    assert.equal(listItems.length, 1);
    const [item] = listItems;
    assert.ok(item);
    assert.equal(item.receipt_id, row.receipt_id);
    assert.equal(item.connection_id, connectorInstanceId);
    assert.equal(item.connector_id, connectorId);
    assert.equal(item.stream, "items");
    assert.equal(item.reason_code, "invalid_record_identity");
    assert.equal(item.payload_bytes, Buffer.byteLength(rejectedPayloadLine));
    assert.equal(item.payload_sha256, row.payload_sha256);
    assert.equal(item.status, "pending");
    assert.equal(item.run_id, runId);
    assert.equal("payload" in item, false);
    assert.equal("payloadText" in item, false);
    assertOmitsPrivatePayload("owner rejection list", listBody, [
      ...forbiddenPayloadNeedles,
      "payloadText",
      "rawLine",
      "raw_line",
      "storage exploded",
      "parser exploded",
    ]);

    const detailUrl = `${listUrl}/${encodeURIComponent(row.receipt_id)}`;
    const { body: detailBody, status: detailStatus } = await fetchJson(detailUrl, {
      headers: { Cookie: ownerSessionB },
    });
    assert.equal(detailStatus, 200);
    const detail = detailBody as Record<string, unknown>;
    assert.equal(detail.receipt_id, row.receipt_id);
    assert.equal(detail.payload_base64, Buffer.from(rejectedPayloadLine).toString("base64"));
    assert.equal(detail.payload_text, rejectedPayloadLine);
    assert.equal(JSON.stringify(detail).includes("storage exploded"), false);
    assert.equal(JSON.stringify(detail).includes("parser exploded"), false);
    assertOmitsPrivatePayload("captured restarted-server logger", serverBLogs.output(), forbiddenPayloadNeedles);
  } finally {
    if (serverB) {
      await closeServer(serverB);
    }
    if (serverA) {
      await closeServer(serverA);
    }
    rmSync(dir, { force: true, recursive: true });
  }
});

test("prior-runtime count reader is loss-safe against a fresh new SQLite server", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-prior-runtime-new-server-"));
  const dbPath = join(dir, "store.sqlite");
  const connectorId = "prior-runtime-new-server";
  const rejectedRecord = {
    data: { id: "new-server-retained-data", value: "must survive legacy progress" },
    emitted_at: "2026-08-11T12:05:00.000Z",
    key: "legacy-runtime-wire-key",
  };
  const rejectedPayloadLine = JSON.stringify(rejectedRecord);
  let serverA: ClosableServer | null = null;
  let serverB: ClosableServer | null = null;

  try {
    serverA = await startServer({
      asPort: 0,
      dbPath,
      ownerAuthPassword: OWNER_PASSWORD,
      ownerAuthSubjectId: OWNER_SUBJECT_ID,
      quiet: true,
      rsPort: 0,
    });
    const asUrlA = `http://localhost:${serverA.asPort}`;
    const rsUrlA = `http://localhost:${serverA.rsPort}`;
    const ownerSessionA = await login(asUrlA);
    await registerManifest(asUrlA, ownerSessionA, manifest(connectorId));
    const ownerToken = await issueOwnerToken(asUrlA, ownerSessionA);
    const { connectorInstanceId } = await admitOwnerRunConnection({
      connectorId,
      connectorInstanceId: null,
      connectorInstanceStore: createRequestConnectorInstanceStore(),
      ownerSubjectId: OWNER_SUBJECT_ID,
    });

    const ingestUrl = new URL("/v1/ingest/items", rsUrlA);
    ingestUrl.searchParams.set("connector_id", connectorId);
    ingestUrl.searchParams.set("connector_instance_id", connectorInstanceId);
    const response = await fetch(ingestUrl, {
      body: rejectedPayloadLine,
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "Content-Type": "application/x-ndjson",
      },
      method: "POST",
    });

    // This is the complete pre-receipt consumer boundary: it reads only the
    // two finite counters and ignores every additive field. Importing the old
    // runtime would also import its child-process and checkpoint machinery,
    // which is irrelevant to this server-first compatibility invariant.
    const priorRuntimeCounts = await readPriorRuntimeIngestCounts(response);
    assert.deepEqual(priorRuntimeCounts, { records_accepted: 0, records_rejected: 1 });
    const priorRuntimeWouldClearBatch = priorRuntimeCounts.records_accepted + priorRuntimeCounts.records_rejected === 1;

    const committedReceipt = getDb()
      .prepare(
        `SELECT payload, receipt_id
           FROM record_rejections
          WHERE connector_instance_id = ?`
      )
      .get<{ payload: Buffer; receipt_id: string }>(connectorInstanceId);
    assert.ok(committedReceipt, "new server commits rejection evidence before the legacy reader sees success");
    assert.equal(committedReceipt.payload.toString("utf8"), rejectedPayloadLine);

    await closeServer(serverA);
    serverA = null;
    serverB = await startServer({
      asPort: 0,
      dbPath,
      ownerAuthPassword: OWNER_PASSWORD,
      ownerAuthSubjectId: OWNER_SUBJECT_ID,
      quiet: true,
      rsPort: 0,
    });
    const asUrlB = `http://localhost:${serverB.asPort}`;
    const ownerSessionB = await login(asUrlB);
    const listUrl = `${asUrlB}/_ref/connections/${encodeURIComponent(connectorInstanceId)}/record-rejections`;
    const { body: listBody, status: listStatus } = await fetchJson(listUrl, {
      headers: { Cookie: ownerSessionB },
    });
    assert.equal(listStatus, 200);
    const listItems = (listBody as { data?: { receipt_id?: unknown }[] }).data ?? [];
    assert.deepEqual(
      listItems.map((item) => item.receipt_id),
      [committedReceipt.receipt_id],
      "fresh server exposes the receipt to its owner"
    );

    const { body: detailBody, status: detailStatus } = await fetchJson(
      `${listUrl}/${encodeURIComponent(committedReceipt.receipt_id)}`,
      { headers: { Cookie: ownerSessionB } }
    );
    assert.equal(detailStatus, 200);
    assert.equal(
      (detailBody as { payload_base64?: unknown }).payload_base64,
      Buffer.from(rejectedPayloadLine).toString("base64")
    );
    assert.equal((detailBody as { payload_text?: unknown }).payload_text, rejectedPayloadLine);

    // Only after restart retrieval proves recoverability do the prior
    // runtime's balanced counts constitute a loss-safe progress decision.
    assert.equal(priorRuntimeWouldClearBatch, true);
  } finally {
    if (serverB) {
      await closeServer(serverB);
    }
    if (serverA) {
      await closeServer(serverA);
    }
    rmSync(dir, { force: true, recursive: true });
  }
});

test("SQLite route systemic sibling after a durable prefix keeps accepted record and rejection receipt replay-safe", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-route-systemic-prefix-sqlite-"));
  try {
    await assertLaterSystemicSiblingPreservesDurablePrefix({
      dbPath: join(dir, "store.sqlite"),
      kind: "sqlite",
    });
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

if (POSTGRES_URL) {
  test("Postgres route systemic sibling after a durable prefix keeps accepted record and rejection receipt replay-safe", async () => {
    await withTemporaryPostgresDatabase(
      {
        closeConnections: closePostgresStorage,
        connectionString: POSTGRES_URL,
        databaseName: "pdpp_test_route_systemic_prefix",
      },
      async (databaseUrl) => {
        await assertLaterSystemicSiblingPreservesDurablePrefix({
          databaseUrl,
          kind: "postgres",
        });
      }
    );
  });
} else {
  test("Postgres route systemic sibling durable-prefix parity (skipped: PDPP_TEST_POSTGRES_URL unset)", {
    skip: true,
  }, () => {
    // See this file's SQLite route proof and the repo's Postgres test convention.
  });
}

test("runtime/server SQLite response loss replays the same durable rejection receipt before committing cursor", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-runtime-record-rejection-response-loss-"));
  const dbPath = join(dir, "store.sqlite");
  const connectorId = "runtime-record-rejection-response-loss";
  const firstRunId = "run_record_rejection_response_lost";
  const secondRunId = "run_record_rejection_response_replay";
  const emittedAt = "2026-08-11T12:10:00.000Z";
  const rejectedRecord = { data: { id: "bad-data", value: "bad" }, emitted_at: emittedAt, key: "bad-key" };
  const rejectedPayloadLine = JSON.stringify(rejectedRecord);
  let ingestObserver: ReturnType<typeof withCapturedIngestResponses> | null = null;
  let server: ClosableServer | null = null;

  try {
    server = await startServer({
      asPort: 0,
      dbPath,
      ownerAuthPassword: OWNER_PASSWORD,
      ownerAuthSubjectId: OWNER_SUBJECT_ID,
      quiet: true,
      rsPort: 0,
    });
    const asUrl = `http://localhost:${server.asPort}`;
    const rsUrl = `http://localhost:${server.rsPort}`;
    const ownerSession = await login(asUrl);
    await registerManifest(asUrl, ownerSession, manifest(connectorId));
    const ownerToken = await issueOwnerToken(asUrl, ownerSession);
    const { connectorInstanceId } = await admitOwnerRunConnection({
      connectorId,
      connectorInstanceId: null,
      connectorInstanceStore: createRequestConnectorInstanceStore(),
      ownerSubjectId: OWNER_SUBJECT_ID,
    });

    const firstAttempt = createTestConnector([
      { ...rejectedRecord, stream: "items", type: "RECORD" },
      { cursor: { cursor: "must_not_commit_after_lost_response" }, stream: "items", type: "STATE" },
      { records_emitted: 1, status: "succeeded", type: "DONE" },
    ]);
    const firstProgress: unknown[] = [];
    ingestObserver = withCapturedIngestResponses({
      loseResponseForRunId: firstRunId,
      watchedRunIds: [firstRunId, secondRunId],
    });
    try {
      await assert.rejects(
        () =>
          runConnector({
            admitRunConnection: async ({
              connectorId: admittedConnectorId,
              connectorInstanceId: requestedInstanceId,
            }) => ({
              connectorId: admittedConnectorId,
              connectorInstanceId: requestedInstanceId ?? connectorInstanceId,
              ownerSubjectId: OWNER_SUBJECT_ID,
            }),
            collectionMode: "full_refresh",
            connectorId,
            connectorInstanceId,
            connectorPath: firstAttempt.connectorPath,
            manifest: runtimeManifest(connectorId),
            onInteraction: async () => ({}),
            onProgress: (message) => firstProgress.push(message),
            ownerToken,
            persistState: true,
            rsUrl,
            runId: firstRunId,
            scope: { streams: [{ name: "items" }] },
            state: null,
          }),
        SIMULATED_RESPONSE_LOSS_RE
      );
      assert.equal(ingestObserver.seenLostResponse(), 1, "test wrapper must lose exactly the first ingest response");
      assertOmitsPrivatePayload("lost-response runtime progress", firstProgress, [
        rejectedPayloadLine,
        "bad-key",
        "bad-data",
      ]);
    } finally {
      firstAttempt.cleanup();
    }

    const stateAfterLoss = (await loadSyncState(connectorId, ownerToken, { connectorInstanceId, rsUrl })) as Record<
      string,
      { cursor?: string } | undefined
    > | null;
    assert.notEqual(stateAfterLoss?.items?.cursor, "must_not_commit_after_lost_response");

    const rowAfterLoss = getDb()
      .prepare(
        `SELECT receipt_id, reason_code, payload, replay_count
         FROM record_rejections
         WHERE connector_instance_id = ?`
      )
      .get<{ payload: Buffer; reason_code: string; receipt_id: string; replay_count: number }>(connectorInstanceId);
    assert.ok(rowAfterLoss, "server must commit the receipt before the response is lost");
    assert.equal(rowAfterLoss.reason_code, "invalid_record_identity");
    assert.equal(rowAfterLoss.payload.toString("utf8"), rejectedPayloadLine);
    assert.equal(rowAfterLoss.replay_count, 0);
    const firstEnvelope = ingestObserver.captured().find((envelope) => envelope.runId === firstRunId);
    assert.ok(firstEnvelope, "lost response envelope must be captured before the simulated transport loss");
    assert.equal(rejectionReceiptIdFromEnvelope(firstEnvelope.body), rowAfterLoss.receipt_id);
    assertOmitsPrivatePayload("lost response ingest envelope", firstEnvelope.body, [
      rejectedPayloadLine,
      "bad-key",
      "bad-data",
      "storage exploded",
      "parser exploded",
      "simulated response loss",
    ]);
    assert.equal(
      getDb()
        .prepare("SELECT COUNT(*) AS count FROM record_rejections WHERE connector_instance_id = ?")
        .get<{ count: number }>(connectorInstanceId)?.count,
      1
    );

    const secondAttempt = createTestConnector([
      { ...rejectedRecord, stream: "items", type: "RECORD" },
      { cursor: { cursor: "committed_after_replayed_receipt" }, stream: "items", type: "STATE" },
      { records_emitted: 1, status: "succeeded", type: "DONE" },
    ]);
    const secondProgress: unknown[] = [];
    try {
      const result = await runConnector({
        admitRunConnection: async ({ connectorId: admittedConnectorId, connectorInstanceId: requestedInstanceId }) => ({
          connectorId: admittedConnectorId,
          connectorInstanceId: requestedInstanceId ?? connectorInstanceId,
          ownerSubjectId: OWNER_SUBJECT_ID,
        }),
        collectionMode: "full_refresh",
        connectorId,
        connectorInstanceId,
        connectorPath: secondAttempt.connectorPath,
        manifest: runtimeManifest(connectorId),
        onInteraction: async () => ({}),
        onProgress: (message) => secondProgress.push(message),
        ownerToken,
        persistState: true,
        rsUrl,
        runId: secondRunId,
        scope: { streams: [{ name: "items" }] },
        state: null,
      });

      assert.equal(result.status, "succeeded");
      assert.equal(result.records_emitted, 1);
      assert.equal(result.records_attempted, 1);
      assert.equal(result.records_accepted, 0);
      assert.equal(result.records_permanently_rejected, 1);
      assert.equal(result.records_unresolved_retryable, 0);
      assert.equal(result.checkpoint_summary?.records_flushed, 0);
      assert.equal(result.checkpoint_summary?.records_attempted, 1);
      assert.equal(result.checkpoint_summary?.records_permanently_rejected, 1);
      assertOmitsPrivatePayload("replay runtime result", result, [rejectedPayloadLine, "bad-key", "bad-data"]);
      assertOmitsPrivatePayload("replay runtime progress", secondProgress, [
        rejectedPayloadLine,
        "bad-key",
        "bad-data",
      ]);
    } finally {
      secondAttempt.cleanup();
    }

    const rowAfterReplay = getDb()
      .prepare(
        `SELECT receipt_id, payload, replay_count
         FROM record_rejections
         WHERE connector_instance_id = ?`
      )
      .get<{ payload: Buffer; receipt_id: string; replay_count: number }>(connectorInstanceId);
    assert.ok(rowAfterReplay);
    assert.equal(rowAfterReplay.receipt_id, rowAfterLoss.receipt_id);
    assert.equal(rowAfterReplay.payload.toString("utf8"), rejectedPayloadLine);
    assert.equal(rowAfterReplay.replay_count, 1);
    const secondEnvelope = ingestObserver.captured().find((envelope) => envelope.runId === secondRunId);
    assert.ok(secondEnvelope, "replay response envelope must be captured");
    assert.equal(rejectionReceiptIdFromEnvelope(secondEnvelope.body), rowAfterLoss.receipt_id);
    assert.equal(rejectionReceiptIdFromEnvelope(secondEnvelope.body), rowAfterReplay.receipt_id);
    assertOmitsPrivatePayload("replay response ingest envelope", secondEnvelope.body, [
      rejectedPayloadLine,
      "bad-key",
      "bad-data",
      "storage exploded",
      "parser exploded",
      "simulated response loss",
    ]);
    assert.equal(
      getDb()
        .prepare("SELECT COUNT(*) AS count FROM record_rejections WHERE connector_instance_id = ?")
        .get<{ count: number }>(connectorInstanceId)?.count,
      1
    );

    const replayAuditEvents = getDb()
      .prepare(
        `SELECT actor_id, data_json, event_type
           FROM spine_events
          WHERE object_type = 'record_rejection' AND object_id = ?
          ORDER BY event_seq`
      )
      .all<{ actor_id: string; data_json: string; event_type: string }>(rowAfterReplay.receipt_id);
    assert.deepEqual(
      replayAuditEvents.map((event) => event.event_type),
      ["record_rejection.quarantined"]
    );
    for (const event of replayAuditEvents) {
      assert.equal(event.actor_id, OWNER_SUBJECT_ID);
      assertOmitsPrivatePayload("response-loss quarantine audit", JSON.parse(event.data_json), [
        rejectedPayloadLine,
        "bad-key",
        "bad-data",
        "key and data.id disagree",
      ]);
    }

    const stateAfterReplay = (await loadSyncState(connectorId, ownerToken, { connectorInstanceId, rsUrl })) as Record<
      string,
      { cursor?: string } | undefined
    > | null;
    assert.equal(stateAfterReplay?.items?.cursor, "committed_after_replayed_receipt");

    const facts = sqliteRunHistoryFacts(secondRunId);
    assert.equal(facts.records_attempted, 1);
    assert.equal(facts.records_accepted, 0);
    assert.equal(facts.records_permanently_rejected, 1);
    assert.equal(facts.records_unresolved_retryable, 0);
    assert.equal(facts.records_flushed, 0);
    assertOmitsPrivatePayload("replay run history facts", facts, [rejectedPayloadLine, "bad-key", "bad-data"]);
  } finally {
    ingestObserver?.restore();
    if (server) {
      await closeServer(server);
    }
    rmSync(dir, { force: true, recursive: true });
  }
});

test("runtime cancellation after a committed rejection response preserves the receipt but not the cursor", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-runtime-record-rejection-cancellation-"));
  const dbPath = join(dir, "store.sqlite");
  const connectorId = "runtime-record-rejection-cancellation";
  const runId = "run_record_rejection_cancellation";
  const rejectedRecord = {
    data: { id: "private-rejected-data", value: "private-rejected-value" },
    emitted_at: "2026-08-11T12:00:00.000Z",
    key: "private-rejected-key",
  };
  const rejectedPayloadLine = JSON.stringify(rejectedRecord);
  const forbiddenPayloadNeedles = [
    rejectedPayloadLine,
    "private-rejected-data",
    "private-rejected-key",
    "private-rejected-value",
  ];
  const nativeFetch = globalThis.fetch;
  const cancellation = new AbortController();
  const progress: unknown[] = [];
  let releaseResponse!: () => void;
  const responseRelease = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  let signalResponseCommitted!: (response: { body: string; status: number }) => void;
  const responseCommitted = new Promise<{ body: string; status: number }>((resolve) => {
    signalResponseCommitted = resolve;
  });
  let server: ClosableServer | null = null;

  try {
    server = await startServer({
      asPort: 0,
      dbPath,
      ownerAuthPassword: OWNER_PASSWORD,
      ownerAuthSubjectId: OWNER_SUBJECT_ID,
      quiet: true,
      rsPort: 0,
    });
    const asUrl = `http://localhost:${server.asPort}`;
    const rsUrl = `http://localhost:${server.rsPort}`;
    const ownerSession = await login(asUrl);
    await registerManifest(asUrl, ownerSession, manifest(connectorId));
    const ownerToken = await issueOwnerToken(asUrl, ownerSession);
    const { connectorInstanceId } = await admitOwnerRunConnection({
      connectorId,
      connectorInstanceId: null,
      connectorInstanceStore: createRequestConnectorInstanceStore(),
      ownerSubjectId: OWNER_SUBJECT_ID,
    });
    const { cleanup, connectorPath } = createIdlingTestConnector([
      { ...rejectedRecord, stream: "items", type: "RECORD" },
      { cursor: { cursor: "must_not_commit_after_cancel" }, stream: "items", type: "STATE" },
    ]);

    globalThis.fetch = async (input, init) => {
      const response = await nativeFetch(input, init);
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (
        (init?.method ?? (input instanceof Request ? input.method : "GET")) === "POST" &&
        url.origin === rsUrl &&
        url.pathname === "/v1/ingest/items"
      ) {
        const body = await response.text();
        signalResponseCommitted({ body, status: response.status });
        await responseRelease;
        return new Response(body, {
          headers: response.headers,
          status: response.status,
          statusText: response.statusText,
        });
      }
      return response;
    };

    try {
      const runPromise = runConnector({
        admitRunConnection: async ({ connectorId: admittedConnectorId, connectorInstanceId: requestedInstanceId }) => ({
          connectorId: admittedConnectorId,
          connectorInstanceId: requestedInstanceId ?? connectorInstanceId,
          ownerSubjectId: OWNER_SUBJECT_ID,
        }),
        cancelSignal: cancellation.signal,
        collectionMode: "full_refresh",
        connectorId,
        connectorInstanceId,
        connectorPath,
        manifest: runtimeManifest(connectorId),
        onInteraction: async () => ({}),
        onProgress: (message) => progress.push(message),
        ownerToken,
        persistState: true,
        rsUrl,
        runId,
        scope: { streams: [{ name: "items" }] },
        state: null,
      });

      const deliveredResponse = await responseCommitted;
      assert.equal(deliveredResponse.status, 200);
      const responseBody = JSON.parse(deliveredResponse.body) as {
        records_accepted: number;
        records_attempted: number;
        records_rejected: number;
        rejections: { input_index: number; receipt_id: string }[];
      };
      assert.equal(responseBody.records_attempted, 1);
      assert.equal(responseBody.records_accepted, 0);
      assert.equal(responseBody.records_rejected, 1);
      assert.equal(responseBody.rejections.length, 1);
      assert.equal(responseBody.rejections[0]?.input_index, 0);
      assert.ok(responseBody.rejections[0]?.receipt_id);
      assertOmitsPrivatePayload("cancelled ingest response", responseBody, [
        ...forbiddenPayloadNeedles,
        "parser exploded",
        "storage exploded",
      ]);

      const receiptBeforeCancellation = getDb()
        .prepare(
          `SELECT payload, receipt_id
           FROM record_rejections
           WHERE connector_instance_id = ?`
        )
        .get<{ payload: Buffer; receipt_id: string }>(connectorInstanceId);
      assert.ok(receiptBeforeCancellation, "receipt transaction committed before the response boundary");
      assert.equal(receiptBeforeCancellation.receipt_id, responseBody.rejections[0]?.receipt_id);
      assert.equal(receiptBeforeCancellation.payload.toString("utf8"), rejectedPayloadLine);

      cancellation.abort();
      releaseResponse();
      const result = await runPromise;

      assert.equal(result.status, "cancelled");
      assert.equal(result.terminal_reason, "owner_cancelled");
      assert.equal(result.records_emitted, 1);
      assert.equal(result.records_attempted, 1);
      assert.equal(result.records_accepted, 0);
      assert.equal(result.records_permanently_rejected, 1);
      assert.equal(result.records_unresolved_retryable, 0);
      assert.equal(result.checkpoint_summary?.commit_status, "not_committed");
      assert.equal(result.checkpoint_summary?.records_attempted, 1);
      assert.equal(result.checkpoint_summary?.records_accepted, 0);
      assert.equal(result.checkpoint_summary?.records_permanently_rejected, 1);
      assert.equal(result.checkpoint_summary?.records_unresolved_retryable, 0);
      assertOmitsPrivatePayload("cancelled runtime result", result, forbiddenPayloadNeedles);
      assertOmitsPrivatePayload("cancelled runtime progress", progress, forbiddenPayloadNeedles);

      globalThis.fetch = nativeFetch;
      const state = (await loadSyncState(connectorId, ownerToken, { connectorInstanceId, rsUrl })) as Record<
        string,
        { cursor?: string } | undefined
      > | null;
      assert.notEqual(state?.items?.cursor, "must_not_commit_after_cancel", "cancelled run cannot commit staged state");

      const receiptAfterCancellation = getDb()
        .prepare(
          `SELECT payload, receipt_id
           FROM record_rejections
           WHERE connector_instance_id = ?`
        )
        .get<{ payload: Buffer; receipt_id: string }>(connectorInstanceId);
      assert.deepEqual(
        receiptAfterCancellation,
        receiptBeforeCancellation,
        "cancellation does not erase committed evidence"
      );

      const facts = sqliteRunHistoryFacts(runId);
      assert.equal(facts.records_attempted, 1);
      assert.equal(facts.records_accepted, 0);
      assert.equal(facts.records_permanently_rejected, 1);
      assert.equal(facts.records_unresolved_retryable, 0);
      assert.equal(facts.records_flushed, 0);
      assertOmitsPrivatePayload("cancelled run history facts", facts, forbiddenPayloadNeedles);
      const spineEvidence = getDb().prepare("SELECT data_json FROM spine_events ORDER BY event_seq").all();
      assertOmitsPrivatePayload("cancelled spine timeline", spineEvidence, forbiddenPayloadNeedles);
    } finally {
      globalThis.fetch = nativeFetch;
      cancellation.abort();
      releaseResponse();
      cleanup();
    }
  } finally {
    globalThis.fetch = nativeFetch;
    cancellation.abort();
    releaseResponse();
    if (server) {
      await closeServer(server);
    }
    rmSync(dir, { force: true, recursive: true });
  }
});
