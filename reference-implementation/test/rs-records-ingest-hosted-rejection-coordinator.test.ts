// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { closeDb, getDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { closePostgresStorage, postgresQuery } from "../server/postgres-storage.ts";

const TEST_DCR_INITIAL_ACCESS_TOKEN = "pdpp-reference-test-initial-access-token";
const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;
const RUN_ID = `${process.pid}_${Date.now()}`;
const OWNER_PASSWORD = "hosted-rejection-owner-password";
const CSRF_HIDDEN_FIELD_RE = /<input type="hidden" name="_csrf" value="([^"]+)"\s*\/>/;

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

async function ingestBadLine(
  rsUrl: string,
  token: string,
  connectorId: string,
  connectorInstanceId?: string
): Promise<{ body: { rejections?: Array<{ receipt_id?: string }> }; status: number }> {
  const url = new URL(`${rsUrl}/v1/ingest/items`);
  url.searchParams.set("connector_id", connectorId);
  if (connectorInstanceId) {
    url.searchParams.set("connector_instance_id", connectorInstanceId);
  }
  const { body, status } = await fetchJson(url.toString(), {
    body: JSON.stringify({ data: { id: "declared-id", value: "private" }, key: "wrong-key" }),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-ndjson",
    },
    method: "POST",
  });
  return { body: body as { rejections?: Array<{ receipt_id?: string }> }, status };
}

async function connectionIdForConnector(connectorId: string, backend: "postgres" | "sqlite"): Promise<string> {
  if (backend === "postgres") {
    const result = await postgresQuery<{ connector_instance_id: string }>(
      "SELECT connector_instance_id FROM connector_instances WHERE connector_id = $1 ORDER BY created_at DESC LIMIT 1",
      [connectorId]
    );
    const id = result.rows[0]?.connector_instance_id;
    assert.ok(id, `expected connection for ${connectorId}`);
    return id;
  }
  const id = getDb()
    .prepare(
      "SELECT connector_instance_id FROM connector_instances WHERE connector_id = ? ORDER BY created_at DESC LIMIT 1"
    )
    .get<{ connector_instance_id: string }>(connectorId)?.connector_instance_id;
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

test("SQLite hosted ingest rejection coordinator rolls back joined rejection, quota, and audit effects", async () => {
  const dbPath = join(mkdtempSync(join(homedir(), ".tmp", "pdpp-hosted-rejection-sqlite-")), "pdpp.sqlite");
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

test("SQLite hosted ingest replays response-loss retry with the exact receipt handle", async () => {
  const dbPath = join(mkdtempSync(join(homedir(), ".tmp", "pdpp-hosted-rejection-sqlite-replay-")), "pdpp.sqlite");
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

async function runOwnerInspectionJourney(args: {
  backend: "postgres" | "sqlite";
  dbPath?: string;
  ownerSubjectId: string;
  connectorId: string;
}): Promise<{ connectionId: string; firstReceiptId: string; secondReceiptId: string }> {
  let connectionId = "";
  let firstReceiptId = "";
  let secondReceiptId = "";
  await withHarness(
    {
      ...backendServerOpts(args),
      ownerAuthPassword: "",
    },
    async ({ asUrl, rsUrl }) => {
      await registerConnector(asUrl, args.connectorId);
      const seededConnectionId = args.backend === "postgres" ? `cin_${args.connectorId}` : undefined;
      if (seededConnectionId) {
        await seedPostgresActiveConnection({
          connectorId: args.connectorId,
          connectorInstanceId: seededConnectionId,
          ownerSubjectId: args.ownerSubjectId,
        });
      }
      const token = await issueOwnerToken(asUrl, args.ownerSubjectId);
      const first = await ingestBadLine(rsUrl, token, args.connectorId, seededConnectionId);
      const second = await fetchJson(
        `${rsUrl}/v1/ingest/items?connector_id=${encodeURIComponent(args.connectorId)}${
          seededConnectionId ? `&connector_instance_id=${encodeURIComponent(seededConnectionId)}` : ""
        }`,
        {
          body: JSON.stringify({ data: { id: "second-id", value: "sensitive-second" }, key: "wrong-second" }),
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/x-ndjson",
          },
          method: "POST",
        }
      );
      assert.equal(first.status, 200, JSON.stringify(first.body));
      assert.equal(second.status, 200, JSON.stringify(second.body));
      connectionId = await connectionIdForConnector(args.connectorId, args.backend);
      await makeConnectionDeleteEligible(connectionId, args.backend);
      firstReceiptId = first.body.rejections?.[0]?.receipt_id ?? "";
      secondReceiptId =
        ((second.body as { rejections?: Array<{ receipt_id?: string }> }).rejections ?? [])[0]?.receipt_id ?? "";
      assert.ok(firstReceiptId, "first ingest must return a receipt id");
      assert.ok(secondReceiptId, "second ingest must return a receipt id");
    }
  );
  return { connectionId, firstReceiptId, secondReceiptId };
}

async function inspectAndDeleteOwnerRejections(args: {
  backend: "postgres" | "sqlite";
  connectionId: string;
  connectorId: string;
  dbPath?: string;
  firstReceiptId: string;
  ownerSubjectId: string;
  secondReceiptId: string;
}): Promise<void> {
  await withHarness(
    {
      ...backendServerOpts(args),
      ownerAuthPassword: OWNER_PASSWORD,
      ownerAuthSubjectId: args.ownerSubjectId,
    },
    async ({ asUrl }) => {
      const sessionCookie = await loginOwnerSession(asUrl);

      const unauthenticated = await fetchJson(
        `${asUrl}/_ref/connections/${encodeURIComponent(args.connectionId)}/record-rejections`,
        { headers: { Accept: "application/json" } }
      );
      assert.equal(unauthenticated.status, 401, "owner-session gate must reject bare callers");

      const firstPage = await listRejections(asUrl, sessionCookie, args.connectionId, 1);
      assert.equal(firstPage.status, 200, JSON.stringify(firstPage.body));
      const firstPageBody = firstPage.body as {
        data?: Record<string, unknown>[];
        has_more?: boolean;
        next_cursor?: string | null;
      };
      assert.equal(firstPageBody.data?.length, 1, "limit=1 must page, not disclose all rows");
      assert.equal(firstPageBody.has_more, true);
      assert.equal(typeof firstPageBody.next_cursor, "string");
      assert.equal(JSON.stringify(firstPageBody).includes("payload_text"), false);
      assert.equal(JSON.stringify(firstPageBody).includes("payload_base64"), false);
      assert.equal(JSON.stringify(firstPageBody).includes("sensitive-"), false);

      const secondPage = await listRejections(
        asUrl,
        sessionCookie,
        args.connectionId,
        10,
        firstPageBody.next_cursor ?? ""
      );
      assert.equal(secondPage.status, 200, JSON.stringify(secondPage.body));
      const secondPageBody = secondPage.body as { data?: Record<string, unknown>[]; has_more?: boolean };
      assert.equal(secondPageBody.data?.length, 1);
      assert.equal(secondPageBody.has_more, false);
      assert.deepEqual(
        [...(firstPageBody.data ?? []), ...(secondPageBody.data ?? [])]
          .map((item) => item.receipt_id)
          .sort((a, b) => String(a).localeCompare(String(b))),
        [args.firstReceiptId, args.secondReceiptId].sort((a, b) => a.localeCompare(b))
      );

      const wrongConnection = await getRejectionDetail(asUrl, sessionCookie, "cin_other_owner", args.firstReceiptId);
      assert.equal(wrongConnection.status, 404);

      const detail = await getRejectionDetail(asUrl, sessionCookie, args.connectionId, args.firstReceiptId);
      assert.equal(detail.status, 200, JSON.stringify(detail.body));
      const detailBody = detail.body as Record<string, unknown>;
      assert.equal(detailBody.receipt_id, args.firstReceiptId);
      assert.equal(detailBody.payload_encoding, "base64");
      assert.equal(detailBody.payload_text, '{"data":{"id":"declared-id","value":"private"},"key":"wrong-key"}');
      assert.equal(
        Buffer.from(String(detailBody.payload_base64), "base64").toString("utf8"),
        '{"data":{"id":"declared-id","value":"private"},"key":"wrong-key"}'
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
}

test("SQLite owner rejection inspection is authorized, paged, non-disclosing, fresh-process durable, and delete-cleaned", async () => {
  const dbPath = join(mkdtempSync(join(homedir(), ".tmp", "pdpp-hosted-rejection-sqlite-owner-")), "pdpp.sqlite");
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
