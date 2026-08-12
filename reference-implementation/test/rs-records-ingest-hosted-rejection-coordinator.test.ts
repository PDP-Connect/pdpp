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

async function registerConnector(asUrl: string, connectorId: string): Promise<void> {
  const response = await fetch(`${asUrl}/connectors`, {
    body: JSON.stringify(manifest(connectorId)),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(response.status, 201, `register ${connectorId}`);
}

async function ingestBadLine(
  rsUrl: string,
  token: string,
  connectorId: string
): Promise<{ body: { rejections?: Array<{ receipt_id?: string }> }; status: number }> {
  const { body, status } = await fetchJson(`${rsUrl}/v1/ingest/items?connector_id=${encodeURIComponent(connectorId)}`, {
    body: JSON.stringify({ data: { id: "declared-id", value: "private" }, key: "wrong-key" }),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-ndjson",
    },
    method: "POST",
  });
  return { body: body as { rejections?: Array<{ receipt_id?: string }> }, status };
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
      const token = await issueOwnerToken(asUrl, ownerSubjectId);
      const response = await ingestBadLine(rsUrl, token, connectorId);
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
  const ownerSubjectId = `owner_pg_rejection_replay_${RUN_ID}`;
  await withHarness(
    {
      databaseUrl: POSTGRES_URL,
      dbPath: ":memory:",
      storageBackend: "postgres",
    } as Parameters<typeof startServer>[0],
    async ({ asUrl, rsUrl }) => {
      await registerConnector(asUrl, connectorId);
      const token = await issueOwnerToken(asUrl, ownerSubjectId);
      const first = await ingestBadLine(rsUrl, token, connectorId);
      const second = await ingestBadLine(rsUrl, token, connectorId);
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
