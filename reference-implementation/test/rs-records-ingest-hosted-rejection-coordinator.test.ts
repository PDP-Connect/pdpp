// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { __setConnectorInstanceWritePhaseHookForTest } from "../server/connector-instance-write-coordinator.ts";
import { closeDb, getDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { closePostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { mountRefRunCancel, type RunCancelResult } from "../server/routes/run-cancel.ts";

const TEST_DCR_INITIAL_ACCESS_TOKEN = "pdpp-reference-test-initial-access-token";
const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;
const RUN_ID = `${process.pid}_${Date.now()}`;
const OWNER_PASSWORD = "hosted-rejection-owner-password";
const CSRF_HIDDEN_FIELD_RE = /<input type="hidden" name="_csrf" value="([^"]+)"\s*\/>/;
const OWNER_INSPECTION_PAGE_CAP = 2;
const OWNER_INSPECTION_RECEIPT_COUNT = 5;
const OWNER_QUOTA_ENV = "PDPP_RECORD_REJECTION_OWNER_QUOTA_BYTES";
const RECEIPT_ID_RE = /receipt_id/;

interface CloseableServer {
  close: (callback?: (err?: Error) => void) => unknown;
  closeAllConnections: () => void;
}

type StartedServer = Awaited<ReturnType<typeof startServer>> & {
  asServer: CloseableServer;
  rsServer: CloseableServer;
};

interface Harness {
  asUrl: string;
  rsUrl: string;
  server: StartedServer;
}

async function closeServer(server: StartedServer): Promise<void> {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise((resolve) => server.asServer.close(resolve)),
    new Promise((resolve) => server.rsServer.close(resolve)),
  ]);
}

async function fetchJson(url: string, opts: RequestInit = {}): Promise<{ body: unknown; status: number }> {
  const response = await fetch(url, opts);
  const text = await response.text();
  return { body: text ? JSON.parse(text) : null, status: response.status };
}

function rawSetCookieList(response: Response): string[] {
  if (typeof response.headers.getSetCookie === "function") {
    return response.headers.getSetCookie();
  }
  const cookie = response.headers.get("set-cookie");
  return cookie ? [cookie] : [];
}

function findCookiePair(headers: readonly string[], name: string): string | null {
  for (const header of headers) {
    const [pair] = header.split(";");
    if (pair?.startsWith(`${name}=`)) {
      return pair;
    }
  }
  return null;
}

async function loginOwnerSession(asUrl: string): Promise<string> {
  const csrfResponse = await fetch(`${asUrl}/owner/login`, {
    headers: { Accept: "text/html" },
    redirect: "manual",
  });
  const csrfCookie = findCookiePair(rawSetCookieList(csrfResponse), "pdpp_owner_csrf");
  const csrfHtml = await csrfResponse.text();
  const csrfField = csrfHtml.match(CSRF_HIDDEN_FIELD_RE)?.[1] ?? "";
  const loginResponse = await fetch(`${asUrl}/owner/login`, {
    body: new URLSearchParams({ _csrf: csrfField, password: OWNER_PASSWORD, return_to: "/" }).toString(),
    headers: {
      Accept: "text/html",
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: csrfCookie ?? "",
    },
    method: "POST",
    redirect: "manual",
  });
  const sessionCookie = findCookiePair(rawSetCookieList(loginResponse), "pdpp_owner_session");
  assert.ok(sessionCookie, `owner login must issue a session cookie, status=${loginResponse.status}`);
  return sessionCookie;
}

async function issueOwnerToken(asUrl: string, subjectId: string): Promise<string> {
  const clientId = "cli_longview";
  const { body: deviceBody } = await fetchJson(`${asUrl}/oauth/device_authorization`, {
    body: new URLSearchParams({ client_id: clientId }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const device = deviceBody as { device_code: string; user_code: string };
  await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({ subject_id: subjectId, user_code: device.user_code }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const { body: tokenBody } = await fetchJson(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: clientId,
      device_code: device.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  return (tokenBody as { access_token: string }).access_token;
}

function manifest(connectorId: string) {
  return {
    connector_id: connectorId,
    connector_key: connectorId,
    display_name: "Hosted Rejection Coordinator Test",
    protocol_version: "0.1.0",
    streams: [
      {
        name: "items",
        primary_key: ["id"],
        schema: {
          properties: {
            id: { type: "string" },
            value: { type: "string" },
          },
          required: ["id"],
          type: "object",
        },
        selection: { fields: true, resources: true },
        semantics: "mutable_state",
      },
    ],
    version: "1.0.0",
  };
}

async function withHarness(
  opts: Parameters<typeof startServer>[0],
  fn: (harness: Harness) => Promise<void>
): Promise<void> {
  const server = (await startServer({
    asPort: 0,
    dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
    maxRecordRejectionPageSize: OWNER_INSPECTION_PAGE_CAP,
    quiet: true,
    rsPort: 0,
    ...opts,
  })) as StartedServer;
  try {
    await fn({
      asUrl: `http://localhost:${server.asPort}`,
      rsUrl: `http://localhost:${server.rsPort}`,
      server,
    });
  } finally {
    await closeServer(server);
    await closePostgresStorage();
    closeDb();
  }
}

function backendServerOpts(args: {
  backend: "postgres" | "sqlite";
  dbPath?: string;
}): Parameters<typeof startServer>[0] {
  if (args.backend === "postgres") {
    return {
      databaseUrl: POSTGRES_URL,
      dbPath: ":memory:",
      storageBackend: "postgres",
    } as Parameters<typeof startServer>[0];
  }
  return args.dbPath ? { dbPath: args.dbPath } : {};
}

async function registerConnector(asUrl: string, connectorId: string): Promise<void> {
  const response = await fetch(`${asUrl}/connectors`, {
    body: JSON.stringify(manifest(connectorId)),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(response.status, 201, `register ${connectorId}`);
}

async function seedBackendConnector(connectorId: string, backend: "postgres" | "sqlite"): Promise<void> {
  if (backend === "postgres") {
    await postgresQuery(
      "INSERT INTO connectors(connector_id, manifest, created_at) VALUES($1, $2::jsonb, $3) ON CONFLICT(connector_id) DO UPDATE SET manifest = EXCLUDED.manifest",
      [connectorId, JSON.stringify(manifest(connectorId)), new Date().toISOString()]
    );
    const seeded = await postgresQuery<{ count: string }>(
      "SELECT COUNT(*)::bigint AS count FROM connectors WHERE connector_id = $1",
      [connectorId]
    );
    assert.equal(Number(seeded.rows[0]?.count ?? 0), 1, `seed backend connector ${connectorId}`);
  }
}

async function seedPostgresActiveConnection(args: {
  connectorId: string;
  connectorInstanceId: string;
  ownerSubjectId: string;
}): Promise<void> {
  await seedBackendConnector(args.connectorId, "postgres");
  const now = new Date().toISOString();
  const bindingKey = `explicit-${args.connectorInstanceId}`;
  await postgresQuery(
    `INSERT INTO connector_instances(
       connector_instance_id, owner_subject_id, connector_id, display_name, status,
       source_kind, source_binding_key, source_binding_json, created_at, updated_at
     ) VALUES($1, $2, $3, 'Hosted rejection PG fixture', 'active', 'account', $4, $5::jsonb, $6, $7)
     ON CONFLICT(connector_instance_id) DO UPDATE SET status = 'active', updated_at = EXCLUDED.updated_at`,
    [
      args.connectorInstanceId,
      args.ownerSubjectId,
      args.connectorId,
      bindingKey,
      JSON.stringify({ local_binding_name: bindingKey }),
      now,
      now,
    ]
  );
}

function ingestBadLine(
  rsUrl: string,
  token: string,
  connectorId: string,
  connectorInstanceId?: string
): Promise<{ body: { rejections?: Array<{ receipt_id?: string }> }; status: number }> {
  return ingestRejectedLine({
    connectorId,
    id: "declared-id",
    key: "wrong-key",
    rsUrl,
    token,
    value: "private",
    ...(connectorInstanceId ? { connectorInstanceId } : {}),
  });
}

async function ingestRejectedLine(args: {
  connectorId: string;
  connectorInstanceId?: string;
  id: string;
  key: string;
  runId?: string;
  rsUrl: string;
  token: string;
  value: string;
}): Promise<{ body: { rejections?: Array<{ receipt_id?: string }> }; status: number }> {
  const url = new URL(`${args.rsUrl}/v1/ingest/items`);
  url.searchParams.set("connector_id", args.connectorId);
  if (args.connectorInstanceId) {
    url.searchParams.set("connector_instance_id", args.connectorInstanceId);
  }
  if (args.runId) {
    url.searchParams.set("run_id", args.runId);
  }
  const { body, status } = await fetchJson(url.toString(), {
    body: JSON.stringify({ data: { id: args.id, value: args.value }, key: args.key }),
    headers: {
      Authorization: `Bearer ${args.token}`,
      "Content-Type": "application/x-ndjson",
    },
    method: "POST",
  });
  return { body: body as { rejections?: Array<{ receipt_id?: string }> }, status };
}

async function connectionIdForConnector(
  connectorId: string,
  backend: "postgres" | "sqlite",
  ownerSubjectId: string
): Promise<string> {
  if (backend === "postgres") {
    const result = await postgresQuery<{ connector_instance_id: string }>(
      "SELECT connector_instance_id FROM connector_instances WHERE connector_id = $1 AND owner_subject_id = $2 ORDER BY created_at DESC LIMIT 1",
      [connectorId, ownerSubjectId]
    );
    const id = result.rows[0]?.connector_instance_id;
    assert.ok(id, `expected connection for ${connectorId}`);
    return id;
  }
  const id = getDb()
    .prepare(
      "SELECT connector_instance_id FROM connector_instances WHERE connector_id = ? AND owner_subject_id = ? ORDER BY created_at DESC LIMIT 1"
    )
    .get<{ connector_instance_id: string }>(connectorId, ownerSubjectId)?.connector_instance_id;
  assert.ok(id, `expected connection for ${connectorId}`);
  return id;
}

async function makeConnectionDeleteEligible(connectionId: string, backend: "postgres" | "sqlite"): Promise<void> {
  const bindingKey = `explicit-rejection-test-${RUN_ID}`;
  const bindingJson = JSON.stringify({ local_binding_name: bindingKey });
  if (backend === "postgres") {
    await postgresQuery(
      `UPDATE connector_instances
          SET source_binding_key = $1,
              source_binding_json = $2::jsonb
        WHERE connector_instance_id = $3`,
      [bindingKey, bindingJson, connectionId]
    );
    return;
  }
  getDb()
    .prepare(
      `UPDATE connector_instances
          SET source_binding_key = ?,
              source_binding_json = ?
        WHERE connector_instance_id = ?`
    )
    .run(bindingKey, bindingJson, connectionId);
}

async function listRejections(
  asUrl: string,
  sessionCookie: string,
  connectionId: string,
  limit: number,
  cursor?: string
) {
  const url = new URL(`${asUrl}/_ref/connections/${encodeURIComponent(connectionId)}/record-rejections`);
  url.searchParams.set("limit", String(limit));
  if (cursor) {
    url.searchParams.set("cursor", cursor);
  }
  return await fetchJson(url.toString(), { headers: { Cookie: sessionCookie } });
}

async function getRejectionDetail(asUrl: string, sessionCookie: string, connectionId: string, receiptId: string) {
  return await fetchJson(
    `${asUrl}/_ref/connections/${encodeURIComponent(connectionId)}/record-rejections/${encodeURIComponent(receiptId)}`,
    { headers: { Cookie: sessionCookie } }
  );
}

async function deleteConnection(asUrl: string, sessionCookie: string, connectionId: string) {
  return await fetchJson(`${asUrl}/_ref/connections/${encodeURIComponent(connectionId)}`, {
    headers: {
      "Content-Type": "application/json",
      Cookie: sessionCookie,
    },
    method: "DELETE",
  });
}

async function revokeConnectionWithOwnerToken(asUrl: string, token: string, connectionId: string) {
  return await fetchJson(`${asUrl}/v1/owner/connections/${encodeURIComponent(connectionId)}/revoke`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });
}

async function deleteConnectionWithOwnerToken(asUrl: string, token: string, connectionId: string) {
  return await fetchJson(`${asUrl}/v1/owner/connections/${encodeURIComponent(connectionId)}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    method: "DELETE",
  });
}

interface RecordRejectionListBody {
  data?: Record<string, unknown>[];
  has_more?: boolean;
  next_cursor?: string | null;
}

async function collectRejectionReceiptIds(args: {
  asUrl: string;
  connectionId: string;
  excessiveLimit: number;
  expectedFirstPageSize: number;
  sessionCookie: string;
}): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | undefined;
  let pageCount = 0;
  do {
    // biome-ignore lint/performance/noAwaitInLoops: Cursor traversal is intentionally sequential; each page depends on the prior cursor.
    const page = await listRejections(args.asUrl, args.sessionCookie, args.connectionId, args.excessiveLimit, cursor);
    assert.equal(page.status, 200, JSON.stringify(page.body));
    const body = page.body as RecordRejectionListBody;
    const rows = body.data ?? [];
    if (pageCount === 0) {
      assert.equal(rows.length, args.expectedFirstPageSize, "configured max page size must cap excessive limits");
      assert.equal(body.has_more, true, "more rows than the configured cap must produce a cursor");
    }
    for (const row of rows) {
      const receiptId = String(row.receipt_id ?? "");
      assert.ok(receiptId, "list row must include receipt_id");
      assert.equal(seen.includes(receiptId), false, `duplicate receipt across cursor pages: ${receiptId}`);
      seen.push(receiptId);
    }
    cursor = typeof body.next_cursor === "string" ? body.next_cursor : undefined;
    pageCount += 1;
  } while (cursor);
  return seen;
}

function sqliteCounts(connectorId: string, ownerSubjectId: string) {
  const rejections = getDb()
    .prepare("SELECT COUNT(*) AS count FROM record_rejections WHERE connector_id = ?")
    .get<{ count: number }>(connectorId)?.count;
  const audit = getDb()
    .prepare(
      `SELECT COUNT(*) AS count
         FROM spine_events
        WHERE object_type = 'record_rejection'
          AND json_extract(data_json, '$.connection_id') IN (
            SELECT connector_instance_id
              FROM connector_instances
             WHERE connector_id = ? AND owner_subject_id = ?
          )`
    )
    .get<{ count: number }>(connectorId, ownerSubjectId)?.count;
  const quota = getDb()
    .prepare(
      "SELECT COALESCE(SUM(pending_receipt_count), 0) AS count FROM record_rejection_quota WHERE owner_subject_id = ?"
    )
    .get<{ count: number }>(ownerSubjectId)?.count;
  return { audit, quota, rejections };
}

async function postgresCounts(connectorId: string, ownerSubjectId: string) {
  const rejections = await postgresQuery<{ count: string }>(
    "SELECT COUNT(*)::bigint AS count FROM record_rejections WHERE connector_id = $1",
    [connectorId]
  );
  const audit = await postgresQuery<{ count: string }>(
    `SELECT COUNT(*)::bigint AS count
       FROM spine_events
      WHERE object_type = 'record_rejection'
        AND data_json->>'connection_id' IN (
          SELECT connector_instance_id
            FROM connector_instances
           WHERE connector_id = $1 AND owner_subject_id = $2
        )`,
    [connectorId, ownerSubjectId]
  );
  const quota = await postgresQuery<{ count: string }>(
    "SELECT COALESCE(SUM(pending_receipt_count), 0)::bigint AS count FROM record_rejection_quota WHERE owner_subject_id = $1",
    [ownerSubjectId]
  );
  return {
    audit: Number(audit.rows[0]?.count ?? 0),
    quota: Number(quota.rows[0]?.count ?? 0),
    rejections: Number(rejections.rows[0]?.count ?? 0),
  };
}

interface RejectionCounts {
  audit: number | string | undefined;
  quota: number | string | undefined;
  rejections: number | string | undefined;
}

async function backendCounts(
  backend: "postgres" | "sqlite",
  connectorId: string,
  ownerSubjectId: string
): Promise<RejectionCounts> {
  return backend === "postgres"
    ? await postgresCounts(connectorId, ownerSubjectId)
    : sqliteCounts(connectorId, ownerSubjectId);
}

function noReceiptSurface(response: { body: unknown; status: number }): void {
  assert.ok(response.status < 200 || response.status >= 300, JSON.stringify(response.body));
  assert.equal(JSON.stringify(response.body).includes("receipt_id"), false);
}

function installBeforeRejectionWriteGate(connectorInstanceId: string): {
  entered: Promise<void>;
  release: () => void;
} {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let signalEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    signalEntered = resolve;
  });
  let used = false;
  __setConnectorInstanceWritePhaseHookForTest(async (stage, context) => {
    if (used || stage !== "after_acquire" || context.connectorInstanceId !== connectorInstanceId) {
      return;
    }
    used = true;
    signalEntered();
    await released;
  });
  return { entered, release };
}

function installBeforeRejectionKeyGate(connectorInstanceId: string): {
  entered: Promise<void>;
  release: () => void;
} {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let signalEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    signalEntered = resolve;
  });
  let used = false;
  __setConnectorInstanceWritePhaseHookForTest(async (stage, context) => {
    if (used || stage !== "before_key_acquire" || context.connectorInstanceId !== connectorInstanceId) {
      return;
    }
    used = true;
    signalEntered();
    await released;
  });
  return { entered, release };
}

function postgresHostedRejectionCommitGate(): {
  arm: () => void;
  entered: Promise<void>;
  hook: () => Promise<void>;
  release: () => void;
} {
  let armed = false;
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let signalEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    signalEntered = resolve;
  });
  let used = false;
  return {
    arm: () => {
      armed = true;
    },
    entered,
    hook: async () => {
      if (!armed || used) {
        return;
      }
      used = true;
      signalEntered();
      await released;
    },
    release,
  };
}

async function seedRunningRun(args: {
  backend: "postgres" | "sqlite";
  connectorId: string;
  connectorInstanceId: string;
  runId: string;
}): Promise<void> {
  const now = new Date().toISOString();
  if (args.backend === "postgres") {
    await postgresQuery(
      `INSERT INTO controller_active_runs(connector_instance_id, connector_id, run_id, trace_id, scenario_id, started_at, run_generation)
       VALUES($1, $2, $3, $4, $5, $6, 1)
       ON CONFLICT(connector_instance_id) DO UPDATE SET run_id = EXCLUDED.run_id, started_at = EXCLUDED.started_at`,
      [args.connectorInstanceId, args.connectorId, args.runId, `trc_${args.runId}`, "test", now]
    );
    await postgresQuery(
      `INSERT INTO run_history(connector_instance_id, connector_id, run_id, source_json, status, trace_id, started_at, known_gaps_json, scheduler_managed)
       VALUES($1, $2, $3, '{}', 'running', $4, $5, '[]', $6)
       ON CONFLICT(run_id, connector_instance_id) WHERE run_id IS NOT NULL
       DO UPDATE SET status = 'running', completed_at = NULL`,
      [args.connectorInstanceId, args.connectorId, args.runId, `trc_${args.runId}`, now, false]
    );
    return;
  }
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO controller_active_runs(connector_instance_id, connector_id, run_id, trace_id, scenario_id, started_at, run_generation)
       VALUES(?, ?, ?, ?, ?, ?, 1)`
    )
    .run(args.connectorInstanceId, args.connectorId, args.runId, `trc_${args.runId}`, "test", now);
  getDb()
    .prepare(
      `INSERT INTO run_history(connector_instance_id, connector_id, run_id, source_json, status, trace_id, started_at, known_gaps_json, scheduler_managed)
       VALUES(?, ?, ?, '{}', 'running', ?, ?, '[]', 0)
       ON CONFLICT(run_id, connector_instance_id) WHERE run_id IS NOT NULL
       DO UPDATE SET status = 'running', completed_at = NULL`
    )
    .run(args.connectorInstanceId, args.connectorId, args.runId, `trc_${args.runId}`, now);
}

async function terminalizeRun(args: {
  backend: "postgres" | "sqlite";
  connectorInstanceId: string;
  runId: string;
}): Promise<void> {
  const now = new Date().toISOString();
  if (args.backend === "postgres") {
    await postgresQuery("DELETE FROM controller_active_runs WHERE connector_instance_id = $1 AND run_id = $2", [
      args.connectorInstanceId,
      args.runId,
    ]);
    await postgresQuery(
      "UPDATE run_history SET status = 'cancelled', completed_at = $1, terminal_reason = 'owner_cancelled' WHERE connector_instance_id = $2 AND run_id = $3",
      [now, args.connectorInstanceId, args.runId]
    );
    return;
  }
  getDb()
    .prepare("DELETE FROM controller_active_runs WHERE connector_instance_id = ? AND run_id = ?")
    .run(args.connectorInstanceId, args.runId);
  getDb()
    .prepare(
      "UPDATE run_history SET status = 'cancelled', completed_at = ?, terminal_reason = 'owner_cancelled' WHERE connector_instance_id = ? AND run_id = ?"
    )
    .run(now, args.connectorInstanceId, args.runId);
}

async function runStatus(args: {
  backend: "postgres" | "sqlite";
  connectorInstanceId: string;
  runId: string;
}): Promise<string | undefined> {
  if (args.backend === "postgres") {
    const result = await postgresQuery<{ status: string }>(
      "SELECT status FROM run_history WHERE connector_instance_id = $1 AND run_id = $2",
      [args.connectorInstanceId, args.runId]
    );
    return result.rows[0]?.status;
  }
  return getDb()
    .prepare("SELECT status FROM run_history WHERE connector_instance_id = ? AND run_id = ?")
    .get<{ status: string }>(args.connectorInstanceId, args.runId)?.status;
}

async function cancelRunThroughRouteHarness(args: {
  backend: "postgres" | "sqlite";
  connectorInstanceId: string;
  runId: string;
}): Promise<{ body: Record<string, unknown>; status: number }> {
  const routes = new Map<
    string,
    (
      req: { ownerSession?: { sub: string }; params: Record<string, string> },
      res: {
        json: (body: Record<string, unknown>) => unknown;
        status: (code: number) => unknown;
      }
    ) => unknown | Promise<unknown>
  >();
  const app = {
    post(path: string, ...handlers: unknown[]) {
      routes.set(`POST ${path}`, handlers.at(-1) as NonNullable<ReturnType<typeof routes.get>>);
      return app;
    },
  };
  mountRefRunCancel(app, {
    controller: {
      cancelRun: async (runId: string): Promise<RunCancelResult> => {
        await terminalizeRun({ backend: args.backend, connectorInstanceId: args.connectorInstanceId, runId });
        return { run_id: runId, status: "cancel_requested" };
      },
    },
    handleError: (_res, err) => {
      throw err;
    },
    ownerSubjectId: "owner_route_harness",
    pdppError: (response, statusCode, code, message, param) => {
      (response as { status: (code: number) => { json: (body: Record<string, unknown>) => unknown } })
        .status(statusCode)
        .json({ error: { code, message, ...(param ? { param } : {}) } });
    },
    requireOwnerSession: () => {
      /* owner-session behavior is covered by the run-cancel route tests */
    },
  });
  const handler = routes.get("POST /_ref/runs/:runId/cancel");
  assert.ok(handler, "run-cancel route harness must register the cancel handler");
  let status = 200;
  let body: Record<string, unknown> = {};
  const res = {
    json(value: Record<string, unknown>) {
      body = value;
      return res;
    },
    status(code: number) {
      status = code;
      return res;
    },
  };
  await handler(
    { ownerSession: { sub: "owner_route_harness" }, params: { runId: encodeURIComponent(args.runId) } },
    res
  );
  return { body, status };
}

test("SQLite hosted ingest rejection coordinator rolls back joined rejection, quota, and audit effects", async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "pdpp-hosted-rejection-sqlite-")), "pdpp.sqlite");
  const connectorId = `hosted-rejection-sqlite-rollback-${RUN_ID}`;
  const ownerSubjectId = `owner_sqlite_rejection_rollback_${RUN_ID}`;
  let hookCalls = 0;
  await withHarness(
    {
      dbPath,
      hostedRecordRejectionAfterInsertBeforeCommit: () => {
        hookCalls += 1;
        throw new Error("injected hosted rejection coordinator failure");
      },
    },
    async ({ asUrl, rsUrl }) => {
      await registerConnector(asUrl, connectorId);
      const token = await issueOwnerToken(asUrl, ownerSubjectId);
      const response = await ingestBadLine(rsUrl, token, connectorId);
      assert.equal(response.status, 503, JSON.stringify(response.body));
      assert.equal(hookCalls, 1);
      assert.deepEqual(sqliteCounts(connectorId, ownerSubjectId), { audit: 0, quota: 0, rejections: 0 });
    }
  );
});

test("SQLite hosted ingest quota exhaustion is non-2xx and records no receipt, quota, or audit mutation", async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "pdpp-hosted-rejection-sqlite-quota-")), "pdpp.sqlite");
  const connectorId = `hosted-rejection-sqlite-quota-${RUN_ID}`;
  const ownerSubjectId = `owner_sqlite_rejection_quota_${RUN_ID}`;
  const previousQuota = process.env[OWNER_QUOTA_ENV];
  process.env[OWNER_QUOTA_ENV] = "1";
  try {
    await withHarness({ dbPath }, async ({ asUrl, rsUrl }) => {
      await registerConnector(asUrl, connectorId);
      const token = await issueOwnerToken(asUrl, ownerSubjectId);
      const response = await ingestBadLine(rsUrl, token, connectorId);
      assert.equal(response.status, 503, JSON.stringify(response.body));
      assert.equal(JSON.stringify(response.body).includes("receipt_id"), false);
      assert.deepEqual(sqliteCounts(connectorId, ownerSubjectId), { audit: 0, quota: 0, rejections: 0 });
    });
  } finally {
    if (previousQuota === undefined) {
      delete process.env[OWNER_QUOTA_ENV];
    } else {
      process.env[OWNER_QUOTA_ENV] = previousQuota;
    }
  }
});

test("SQLite hosted ingest replays response-loss retry with the exact receipt handle", async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "pdpp-hosted-rejection-sqlite-replay-")), "pdpp.sqlite");
  const connectorId = `hosted-rejection-sqlite-replay-${RUN_ID}`;
  const ownerSubjectId = `owner_sqlite_rejection_replay_${RUN_ID}`;
  await withHarness({ dbPath }, async ({ asUrl, rsUrl }) => {
    await registerConnector(asUrl, connectorId);
    const token = await issueOwnerToken(asUrl, ownerSubjectId);
    const first = await ingestBadLine(rsUrl, token, connectorId);
    const second = await ingestBadLine(rsUrl, token, connectorId);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(second.body.rejections?.[0]?.receipt_id, first.body.rejections?.[0]?.receipt_id);
    assert.deepEqual(sqliteCounts(connectorId, ownerSubjectId), { audit: 1, quota: 1, rejections: 1 });
    const replayCount = getDb()
      .prepare("SELECT replay_count FROM record_rejections WHERE connector_id = ?")
      .get<{ replay_count: number }>(connectorId)?.replay_count;
    assert.equal(replayCount, 1);
  });
});

test("Postgres hosted ingest rejection coordinator rolls back joined rejection, quota, and audit effects", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
}, async () => {
  assert.ok(POSTGRES_URL);
  const connectorId = `hosted-rejection-pg-rollback-${RUN_ID}`;
  const connectorInstanceId = `cin_${connectorId}`;
  const ownerSubjectId = `owner_pg_rejection_rollback_${RUN_ID}`;
  let hookCalls = 0;
  await withHarness(
    {
      databaseUrl: POSTGRES_URL,
      dbPath: ":memory:",
      hostedRecordRejectionAfterInsertBeforeCommit: () => {
        hookCalls += 1;
        throw new Error("injected hosted rejection coordinator failure");
      },
      storageBackend: "postgres",
    } as Parameters<typeof startServer>[0],
    async ({ asUrl, rsUrl }) => {
      await registerConnector(asUrl, connectorId);
      await seedPostgresActiveConnection({ connectorId, connectorInstanceId, ownerSubjectId });
      const token = await issueOwnerToken(asUrl, ownerSubjectId);
      const response = await ingestBadLine(rsUrl, token, connectorId, connectorInstanceId);
      assert.equal(response.status, 503, JSON.stringify(response.body));
      assert.equal(hookCalls, 1);
      assert.deepEqual(await postgresCounts(connectorId, ownerSubjectId), { audit: 0, quota: 0, rejections: 0 });
    }
  );
});

test("Postgres hosted ingest quota exhaustion is non-2xx and records no receipt, quota, or audit mutation", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
}, async () => {
  assert.ok(POSTGRES_URL);
  const connectorId = `hosted-rejection-pg-quota-${RUN_ID}`;
  const connectorInstanceId = `cin_${connectorId}`;
  const ownerSubjectId = `owner_pg_rejection_quota_${RUN_ID}`;
  const previousQuota = process.env[OWNER_QUOTA_ENV];
  process.env[OWNER_QUOTA_ENV] = "1";
  try {
    await withHarness(
      {
        databaseUrl: POSTGRES_URL,
        dbPath: ":memory:",
        storageBackend: "postgres",
      } as Parameters<typeof startServer>[0],
      async ({ asUrl, rsUrl }) => {
        await registerConnector(asUrl, connectorId);
        await seedPostgresActiveConnection({ connectorId, connectorInstanceId, ownerSubjectId });
        const token = await issueOwnerToken(asUrl, ownerSubjectId);
        const response = await ingestBadLine(rsUrl, token, connectorId, connectorInstanceId);
        assert.equal(response.status, 503, JSON.stringify(response.body));
        assert.equal(JSON.stringify(response.body).includes("receipt_id"), false);
        assert.deepEqual(await postgresCounts(connectorId, ownerSubjectId), { audit: 0, quota: 0, rejections: 0 });
      }
    );
  } finally {
    if (previousQuota === undefined) {
      delete process.env[OWNER_QUOTA_ENV];
    } else {
      process.env[OWNER_QUOTA_ENV] = previousQuota;
    }
  }
});

test("Postgres hosted ingest replays response-loss retry with the exact receipt handle", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
}, async () => {
  assert.ok(POSTGRES_URL);
  const connectorId = `hosted-rejection-pg-replay-${RUN_ID}`;
  const connectorInstanceId = `cin_${connectorId}`;
  const ownerSubjectId = `owner_pg_rejection_replay_${RUN_ID}`;
  await withHarness(
    {
      databaseUrl: POSTGRES_URL,
      dbPath: ":memory:",
      storageBackend: "postgres",
    } as Parameters<typeof startServer>[0],
    async ({ asUrl, rsUrl }) => {
      await registerConnector(asUrl, connectorId);
      await seedPostgresActiveConnection({ connectorId, connectorInstanceId, ownerSubjectId });
      const token = await issueOwnerToken(asUrl, ownerSubjectId);
      const first = await ingestBadLine(rsUrl, token, connectorId, connectorInstanceId);
      const second = await ingestBadLine(rsUrl, token, connectorId, connectorInstanceId);
      assert.equal(first.status, 200);
      assert.equal(second.status, 200);
      assert.equal(second.body.rejections?.[0]?.receipt_id, first.body.rejections?.[0]?.receipt_id);
      assert.deepEqual(await postgresCounts(connectorId, ownerSubjectId), { audit: 1, quota: 1, rejections: 1 });
      const replay = await postgresQuery<{ replay_count: string }>(
        "SELECT replay_count FROM record_rejections WHERE connector_id = $1",
        [connectorId]
      );
      assert.equal(Number(replay.rows[0]?.replay_count ?? 0), 1);
    }
  );
});

async function runHostedRejectionRevokeRace(args: {
  backend: "postgres" | "sqlite";
  connectorId: string;
  connectorInstanceId?: string;
  dbPath?: string;
  ownerSubjectId: string;
}): Promise<void> {
  await withHarness(
    {
      ...backendServerOpts(args),
      ownerAuthPassword: "",
      ownerAuthSubjectId: args.ownerSubjectId,
    },
    async ({ asUrl, rsUrl }) => {
      await registerConnector(asUrl, args.connectorId);
      if (args.backend === "postgres") {
        await seedPostgresActiveConnection({
          connectorId: args.connectorId,
          connectorInstanceId: args.connectorInstanceId as string,
          ownerSubjectId: args.ownerSubjectId,
        });
      }
      const token = await issueOwnerToken(asUrl, args.ownerSubjectId);
      const first = await ingestRejectedLine({
        connectorId: args.connectorId,
        id: "baseline",
        key: "wrong-baseline",
        rsUrl,
        token,
        value: "baseline-private",
        ...(args.connectorInstanceId ? { connectorInstanceId: args.connectorInstanceId } : {}),
      });
      assert.equal(first.status, 200, JSON.stringify(first.body));
      const connectionId =
        args.connectorInstanceId ??
        (await connectionIdForConnector(args.connectorId, args.backend, args.ownerSubjectId));
      const before = await backendCounts(args.backend, args.connectorId, args.ownerSubjectId);
      const gate = installBeforeRejectionKeyGate(connectionId);
      try {
        const loser = ingestRejectedLine({
          connectorId: args.connectorId,
          connectorInstanceId: connectionId,
          id: "revoked-loser",
          key: "wrong-revoked-loser",
          rsUrl,
          token,
          value: "must-not-persist",
        });
        await gate.entered;
        const winner = await revokeConnectionWithOwnerToken(rsUrl, token, connectionId);
        assert.equal(winner.status, 200, JSON.stringify(winner.body));
        gate.release();
        noReceiptSurface(await loser);
      } finally {
        __setConnectorInstanceWritePhaseHookForTest(null);
        gate.release();
      }
      assert.deepEqual(await backendCounts(args.backend, args.connectorId, args.ownerSubjectId), before);
    }
  );
}

test("SQLite hosted rejection insert loses cleanly when revoke wins before the writable check", async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "pdpp-hosted-rejection-sqlite-revoke-race-")), "pdpp.sqlite");
  await runHostedRejectionRevokeRace({
    backend: "sqlite",
    connectorId: `hosted-rejection-sqlite-revoke-race-${RUN_ID}`,
    dbPath,
    ownerSubjectId: `owner_sqlite_rejection_revoke_race_${RUN_ID}`,
  });
});

test("Postgres hosted rejection insert loses cleanly when revoke wins before the writable check", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
}, async () => {
  assert.ok(POSTGRES_URL);
  const connectorId = `hosted-rejection-pg-revoke-race-${RUN_ID}`;
  await runHostedRejectionRevokeRace({
    backend: "postgres",
    connectorId,
    connectorInstanceId: `cin_${connectorId}`,
    ownerSubjectId: `owner_pg_rejection_revoke_race_${RUN_ID}`,
  });
});

async function runHostedRejectionDeleteRace(args: {
  backend: "postgres" | "sqlite";
  connectorId: string;
  connectorInstanceId?: string;
  dbPath?: string;
  ownerSubjectId: string;
}): Promise<void> {
  const pgGate = args.backend === "postgres" ? postgresHostedRejectionCommitGate() : null;
  await withHarness(
    {
      ...backendServerOpts(args),
      ...(pgGate ? { hostedRecordRejectionAfterInsertBeforeCommit: pgGate.hook } : {}),
      ownerAuthPassword: "",
      ownerAuthSubjectId: args.ownerSubjectId,
    },
    async ({ asUrl, rsUrl }) => {
      await registerConnector(asUrl, args.connectorId);
      if (args.backend === "postgres") {
        await seedPostgresActiveConnection({
          connectorId: args.connectorId,
          connectorInstanceId: args.connectorInstanceId as string,
          ownerSubjectId: args.ownerSubjectId,
        });
      }
      const token = await issueOwnerToken(asUrl, args.ownerSubjectId);
      const first = await ingestRejectedLine({
        connectorId: args.connectorId,
        id: "baseline",
        key: "wrong-baseline",
        rsUrl,
        token,
        value: "baseline-private",
        ...(args.connectorInstanceId ? { connectorInstanceId: args.connectorInstanceId } : {}),
      });
      assert.equal(first.status, 200, JSON.stringify(first.body));
      const connectionId =
        args.connectorInstanceId ??
        (await connectionIdForConnector(args.connectorId, args.backend, args.ownerSubjectId));
      await makeConnectionDeleteEligible(connectionId, args.backend);
      if (args.backend === "postgres") {
        assert.ok(pgGate);
        pgGate.arm();
        const loser = ingestRejectedLine({
          connectorId: args.connectorId,
          connectorInstanceId: connectionId,
          id: "delete-loser",
          key: "wrong-delete-loser",
          rsUrl,
          token,
          value: "must-not-persist",
        });
        await pgGate.entered;
        const winnerPromise = deleteConnectionWithOwnerToken(rsUrl, token, connectionId);
        pgGate.release();
        const winner = await winnerPromise;
        assert.equal(winner.status, 200, JSON.stringify(winner.body));
        const loserResult = await loser;
        if (loserResult.status >= 200 && loserResult.status < 300) {
          assert.match(JSON.stringify(loserResult.body), RECEIPT_ID_RE);
        } else {
          noReceiptSurface(loserResult);
        }
      } else {
        const gate = installBeforeRejectionKeyGate(connectionId);
        try {
          const loser = ingestRejectedLine({
            connectorId: args.connectorId,
            connectorInstanceId: connectionId,
            id: "delete-loser",
            key: "wrong-delete-loser",
            rsUrl,
            token,
            value: "must-not-persist",
          });
          await gate.entered;
          const winner = await deleteConnectionWithOwnerToken(rsUrl, token, connectionId);
          assert.equal(winner.status, 200, JSON.stringify(winner.body));
          gate.release();
          noReceiptSurface(await loser);
        } finally {
          __setConnectorInstanceWritePhaseHookForTest(null);
          gate.release();
        }
      }
      assert.deepEqual(await backendCounts(args.backend, args.connectorId, args.ownerSubjectId), {
        audit: 0,
        quota: 0,
        rejections: 0,
      });
    }
  );
}

test("SQLite hosted rejection insert loses cleanly after serialized delete winner cleanup", async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "pdpp-hosted-rejection-sqlite-delete-race-")), "pdpp.sqlite");
  await runHostedRejectionDeleteRace({
    backend: "sqlite",
    connectorId: `hosted-rejection-sqlite-delete-race-${RUN_ID}`,
    dbPath,
    ownerSubjectId: `owner_sqlite_rejection_delete_race_${RUN_ID}`,
  });
});

test("Postgres hosted rejection insert loses cleanly after serialized delete winner cleanup", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
}, async () => {
  assert.ok(POSTGRES_URL);
  const connectorId = `hosted-rejection-pg-delete-race-${RUN_ID}`;
  await runHostedRejectionDeleteRace({
    backend: "postgres",
    connectorId,
    connectorInstanceId: `cin_${connectorId}`,
    ownerSubjectId: `owner_pg_rejection_delete_race_${RUN_ID}`,
  });
});

async function runHostedRejectionTerminalRunRace(args: {
  backend: "postgres" | "sqlite";
  connectorId: string;
  connectorInstanceId?: string;
  dbPath?: string;
  ownerSubjectId: string;
}): Promise<void> {
  await withHarness(
    {
      ...backendServerOpts(args),
      ownerAuthPassword: "",
      ownerAuthSubjectId: args.ownerSubjectId,
    },
    async ({ asUrl, rsUrl }) => {
      await registerConnector(asUrl, args.connectorId);
      if (args.backend === "postgres") {
        await seedPostgresActiveConnection({
          connectorId: args.connectorId,
          connectorInstanceId: args.connectorInstanceId as string,
          ownerSubjectId: args.ownerSubjectId,
        });
      }
      const token = await issueOwnerToken(asUrl, args.ownerSubjectId);
      const first = await ingestRejectedLine({
        connectorId: args.connectorId,
        id: "baseline",
        key: "wrong-baseline",
        rsUrl,
        token,
        value: "baseline-private",
        ...(args.connectorInstanceId ? { connectorInstanceId: args.connectorInstanceId } : {}),
      });
      assert.equal(first.status, 200, JSON.stringify(first.body));
      const connectionId =
        args.connectorInstanceId ??
        (await connectionIdForConnector(args.connectorId, args.backend, args.ownerSubjectId));
      const runId = `run_hosted_rejection_terminal_race_${args.backend}_${RUN_ID}`;
      await seedRunningRun({
        backend: args.backend,
        connectorId: args.connectorId,
        connectorInstanceId: connectionId,
        runId,
      });
      const before = await backendCounts(args.backend, args.connectorId, args.ownerSubjectId);
      const gate = installBeforeRejectionWriteGate(connectionId);
      try {
        const loser = ingestRejectedLine({
          connectorId: args.connectorId,
          connectorInstanceId: connectionId,
          id: "terminal-loser",
          key: "wrong-terminal-loser",
          rsUrl,
          runId,
          token,
          value: "must-not-persist",
        });
        await gate.entered;
        const winner = await cancelRunThroughRouteHarness({
          backend: args.backend,
          connectorInstanceId: connectionId,
          runId,
        });
        assert.equal(winner.status, 202, JSON.stringify(winner.body));
        assert.deepEqual(
          { object: winner.body.object, run_id: winner.body.run_id, status: winner.body.status },
          { object: "run_cancel_ack", run_id: runId, status: "cancel_requested" }
        );
        assert.equal(await runStatus({ backend: args.backend, connectorInstanceId: connectionId, runId }), "cancelled");
        gate.release();
        noReceiptSurface(await loser);
      } finally {
        __setConnectorInstanceWritePhaseHookForTest(null);
        gate.release();
      }
      assert.deepEqual(await backendCounts(args.backend, args.connectorId, args.ownerSubjectId), before);
    }
  );
}

test("SQLite hosted rejection insert loses cleanly when its run terminalizes before the writable check", async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "pdpp-hosted-rejection-sqlite-terminal-race-")), "pdpp.sqlite");
  await runHostedRejectionTerminalRunRace({
    backend: "sqlite",
    connectorId: `hosted-rejection-sqlite-terminal-race-${RUN_ID}`,
    dbPath,
    ownerSubjectId: `owner_sqlite_rejection_terminal_race_${RUN_ID}`,
  });
});

test("Postgres hosted rejection insert loses cleanly when its run terminalizes before the writable check", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
}, async () => {
  assert.ok(POSTGRES_URL);
  const connectorId = `hosted-rejection-pg-terminal-race-${RUN_ID}`;
  await runHostedRejectionTerminalRunRace({
    backend: "postgres",
    connectorId,
    connectorInstanceId: `cin_${connectorId}`,
    ownerSubjectId: `owner_pg_rejection_terminal_race_${RUN_ID}`,
  });
});

async function runOwnerInspectionJourney(args: {
  backend: "postgres" | "sqlite";
  dbPath?: string;
  ownerSubjectId: string;
  connectorId: string;
}): Promise<{
  connectionId: string;
  foreignConnectionId: string;
  foreignOwnerSubjectId: string;
  foreignReceiptId: string;
  receiptIds: string[];
}> {
  let connectionId = "";
  let foreignConnectionId = "";
  let foreignReceiptId = "";
  const receiptIds: string[] = [];
  const foreignOwnerSubjectId = `${args.ownerSubjectId}_foreign`;
  await withHarness(
    {
      ...backendServerOpts(args),
      ownerAuthPassword: "",
    },
    async ({ asUrl, rsUrl }) => {
      await registerConnector(asUrl, args.connectorId);
      const seededConnectionId = args.backend === "postgres" ? `cin_${args.connectorId}` : undefined;
      const seededForeignConnectionId = args.backend === "postgres" ? `cin_${args.connectorId}_foreign` : undefined;
      if (seededConnectionId) {
        await seedPostgresActiveConnection({
          connectorId: args.connectorId,
          connectorInstanceId: seededConnectionId,
          ownerSubjectId: args.ownerSubjectId,
        });
        await seedPostgresActiveConnection({
          connectorId: args.connectorId,
          connectorInstanceId: seededForeignConnectionId as string,
          ownerSubjectId: foreignOwnerSubjectId,
        });
      }
      const token = await issueOwnerToken(asUrl, args.ownerSubjectId);
      for (let index = 0; index < OWNER_INSPECTION_RECEIPT_COUNT; index += 1) {
        // biome-ignore lint/performance/noAwaitInLoops: Sequential inserts make cursor order deterministic for this paging oracle.
        const response = await ingestRejectedLine({
          connectorId: args.connectorId,
          id: `owner-one-${index}`,
          key: `wrong-owner-one-${index}`,
          rsUrl,
          token,
          value: `sensitive-owner-one-${index}`,
          ...(seededConnectionId ? { connectorInstanceId: seededConnectionId } : {}),
        });
        assert.equal(response.status, 200, JSON.stringify(response.body));
        const receiptId = response.body.rejections?.[0]?.receipt_id ?? "";
        assert.ok(receiptId, `owner-one receipt ${index} must be returned`);
        receiptIds.push(receiptId);
      }
      const foreignToken = await issueOwnerToken(asUrl, foreignOwnerSubjectId);
      const foreign = await ingestRejectedLine({
        connectorId: args.connectorId,
        id: "owner-two",
        key: "wrong-owner-two",
        rsUrl,
        token: foreignToken,
        value: "sensitive-owner-two",
        ...(seededForeignConnectionId ? { connectorInstanceId: seededForeignConnectionId } : {}),
      });
      assert.equal(foreign.status, 200, JSON.stringify(foreign.body));
      foreignReceiptId = foreign.body.rejections?.[0]?.receipt_id ?? "";
      assert.ok(foreignReceiptId, "owner-two receipt must be returned");
      connectionId = await connectionIdForConnector(args.connectorId, args.backend, args.ownerSubjectId);
      foreignConnectionId = await connectionIdForConnector(args.connectorId, args.backend, foreignOwnerSubjectId);
      await makeConnectionDeleteEligible(connectionId, args.backend);
      await makeConnectionDeleteEligible(foreignConnectionId, args.backend);
    }
  );
  return { connectionId, foreignConnectionId, foreignOwnerSubjectId, foreignReceiptId, receiptIds };
}

async function inspectAndDeleteOwnerRejections(args: {
  backend: "postgres" | "sqlite";
  connectionId: string;
  connectorId: string;
  dbPath?: string;
  foreignConnectionId: string;
  foreignOwnerSubjectId: string;
  foreignReceiptId: string;
  ownerSubjectId: string;
  receiptIds: string[];
}): Promise<void> {
  await withHarness(
    {
      ...backendServerOpts(args),
      ownerAuthPassword: OWNER_PASSWORD,
      ownerAuthSubjectId: args.ownerSubjectId,
    },
    async ({ asUrl }) => {
      const sessionCookie = await loginOwnerSession(asUrl);

      const unauthenticatedList = await fetchJson(
        `${asUrl}/_ref/connections/${encodeURIComponent(args.connectionId)}/record-rejections`,
        { headers: { Accept: "application/json" } }
      );
      assert.equal(unauthenticatedList.status, 401, "owner-session gate must reject bare list callers");
      const unauthenticatedDetail = await fetchJson(
        `${asUrl}/_ref/connections/${encodeURIComponent(args.connectionId)}/record-rejections/${encodeURIComponent(
          args.receiptIds[0] as string
        )}`,
        { headers: { Accept: "application/json" } }
      );
      assert.equal(unauthenticatedDetail.status, 401, "owner-session gate must reject bare detail callers");

      const overLimitPage = await listRejections(asUrl, sessionCookie, args.connectionId, 999);
      assert.equal(overLimitPage.status, 200, JSON.stringify(overLimitPage.body));
      assert.equal(JSON.stringify(overLimitPage.body).includes("payload_text"), false);
      assert.equal(JSON.stringify(overLimitPage.body).includes("payload_base64"), false);
      assert.equal(JSON.stringify(overLimitPage.body).includes("sensitive-"), false);

      const listedReceiptIds = await collectRejectionReceiptIds({
        asUrl,
        connectionId: args.connectionId,
        excessiveLimit: 999,
        expectedFirstPageSize: OWNER_INSPECTION_PAGE_CAP,
        sessionCookie,
      });
      assert.deepEqual(
        listedReceiptIds.sort((a, b) => a.localeCompare(b)),
        args.receiptIds.toSorted((a, b) => a.localeCompare(b))
      );

      const foreignList = await listRejections(asUrl, sessionCookie, args.foreignConnectionId, 999);
      assert.equal(foreignList.status, 404);
      assert.equal(JSON.stringify(foreignList.body).includes(args.foreignReceiptId), false);
      assert.equal(JSON.stringify(foreignList.body).includes("sensitive-owner-two"), false);
      const foreignDetail = await getRejectionDetail(
        asUrl,
        sessionCookie,
        args.foreignConnectionId,
        args.foreignReceiptId
      );
      assert.equal(foreignDetail.status, 404);
      assert.equal(JSON.stringify(foreignDetail.body).includes(args.foreignReceiptId), false);
      assert.equal(JSON.stringify(foreignDetail.body).includes("sensitive-owner-two"), false);

      const detail = await getRejectionDetail(asUrl, sessionCookie, args.connectionId, args.receiptIds[0] as string);
      assert.equal(detail.status, 200, JSON.stringify(detail.body));
      const detailBody = detail.body as Record<string, unknown>;
      assert.equal(detailBody.receipt_id, args.receiptIds[0]);
      assert.equal(detailBody.payload_encoding, "base64");
      assert.equal(
        detailBody.payload_text,
        '{"data":{"id":"owner-one-0","value":"sensitive-owner-one-0"},"key":"wrong-owner-one-0"}'
      );
      assert.equal(
        Buffer.from(String(detailBody.payload_base64), "base64").toString("utf8"),
        '{"data":{"id":"owner-one-0","value":"sensitive-owner-one-0"},"key":"wrong-owner-one-0"}'
      );

      const deleted = await deleteConnection(asUrl, sessionCookie, args.connectionId);
      assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
      const afterDeleteList = await listRejections(asUrl, sessionCookie, args.connectionId, 10);
      assert.equal(afterDeleteList.status, 404, "deleted connection must no longer reveal its rejection inventory");

      if (args.backend === "postgres") {
        const remaining = await postgresQuery<{ count: string }>(
          "SELECT COUNT(*)::bigint AS count FROM record_rejections WHERE connector_instance_id = $1",
          [args.connectionId]
        );
        assert.equal(Number(remaining.rows[0]?.count ?? 0), 0);
      } else {
        const remaining = getDb()
          .prepare("SELECT COUNT(*) AS count FROM record_rejections WHERE connector_instance_id = ?")
          .get<{ count: number }>(args.connectionId)?.count;
        assert.equal(remaining, 0);
      }
    }
  );

  await withHarness(
    {
      ...backendServerOpts(args),
      ownerAuthPassword: OWNER_PASSWORD,
      ownerAuthSubjectId: args.foreignOwnerSubjectId,
    },
    async ({ asUrl }) => {
      const sessionCookie = await loginOwnerSession(asUrl);
      const list = await listRejections(asUrl, sessionCookie, args.foreignConnectionId, 999);
      assert.equal(list.status, 200, JSON.stringify(list.body));
      const listBody = list.body as RecordRejectionListBody;
      assert.deepEqual(
        (listBody.data ?? []).map((row) => row.receipt_id),
        [args.foreignReceiptId]
      );
      assert.equal(JSON.stringify(list.body).includes("payload_text"), false);
      assert.equal(JSON.stringify(list.body).includes("payload_base64"), false);
      assert.equal(JSON.stringify(list.body).includes("sensitive-owner-two"), false);

      const detail = await getRejectionDetail(asUrl, sessionCookie, args.foreignConnectionId, args.foreignReceiptId);
      assert.equal(detail.status, 200, JSON.stringify(detail.body));
      const detailBody = detail.body as Record<string, unknown>;
      assert.equal(detailBody.receipt_id, args.foreignReceiptId);
      assert.equal(
        detailBody.payload_text,
        '{"data":{"id":"owner-two","value":"sensitive-owner-two"},"key":"wrong-owner-two"}'
      );

      const deleted = await deleteConnection(asUrl, sessionCookie, args.foreignConnectionId);
      assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
      if (args.backend === "postgres") {
        const remaining = await postgresQuery<{ count: string }>(
          "SELECT COUNT(*)::bigint AS count FROM record_rejections WHERE connector_instance_id = $1",
          [args.foreignConnectionId]
        );
        assert.equal(Number(remaining.rows[0]?.count ?? 0), 0);
      } else {
        const remaining = getDb()
          .prepare("SELECT COUNT(*) AS count FROM record_rejections WHERE connector_instance_id = ?")
          .get<{ count: number }>(args.foreignConnectionId)?.count;
        assert.equal(remaining, 0);
      }
    }
  );
}

test("SQLite owner rejection inspection is authorized, paged, non-disclosing, fresh-process durable, and delete-cleaned", async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "pdpp-hosted-rejection-sqlite-owner-")), "pdpp.sqlite");
  const ownerSubjectId = `owner_sqlite_rejection_owner_${RUN_ID}`;
  const connectorId = `hosted-rejection-sqlite-owner-${RUN_ID}`;
  const created = await runOwnerInspectionJourney({
    backend: "sqlite",
    connectorId,
    dbPath,
    ownerSubjectId,
  });
  await inspectAndDeleteOwnerRejections({
    ...created,
    backend: "sqlite",
    connectorId,
    dbPath,
    ownerSubjectId,
  });
});

test("Postgres owner rejection inspection is authorized, paged, non-disclosing, fresh-process durable, and delete-cleaned", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
}, async () => {
  assert.ok(POSTGRES_URL);
  const ownerSubjectId = `owner_pg_rejection_owner_${RUN_ID}`;
  const connectorId = `hosted-rejection-pg-owner-${RUN_ID}`;
  const created = await runOwnerInspectionJourney({
    backend: "postgres",
    connectorId,
    ownerSubjectId,
  });
  await inspectAndDeleteOwnerRejections({
    ...created,
    backend: "postgres",
    connectorId,
    ownerSubjectId,
  });
});
