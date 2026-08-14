// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadSyncState, runConnector } from "../runtime/index.ts";
import { closeDb, getDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { createRequestConnectorInstanceStore } from "../server/request-store-factories.ts";
import { admitOwnerRunConnection } from "../server/stores/connector-instance-store.ts";

const OWNER_SUBJECT_ID = "owner_alice";
const OWNER_PASSWORD = "runtime-record-rejection-multistream-password";
const CSRF_RE = /<input type="hidden" name="_csrf" value="([^"]+)"\s*\/>/;

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
    display_name: "Runtime Record Rejection Multistream Test Connector",
    manifest_uri: `https://registry.pdpp.dev/connectors/${connectorId}`,
    protocol_version: "0.1.0",
    streams: [
      {
        name: "stream_a",
        primary_key: ["id"],
        schema: streamSchema(),
        selection: { fields: true, resources: true },
        semantics: "append_only",
      },
      {
        name: "stream_b",
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
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-runtime-record-rejection-multistream-connector-"));
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

async function issueOwnerToken(asUrl: string, ownerSession: string): Promise<string> {
  const clientId = "cli_longview";
  const { body } = await fetchJson(`${asUrl}/oauth/device_authorization`, {
    body: JSON.stringify({ client_id: clientId }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const device = body as DeviceAuthorizationBody;
  const approveResp = await fetch(`${asUrl}/device/approve`, {
    body: JSON.stringify({ subject_id: OWNER_SUBJECT_ID, user_code: device.user_code }),
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

function assertOmitsPrivatePayload(surfaceName: string, surface: unknown, forbidden: readonly string[]) {
  const serialized = JSON.stringify(surface);
  for (const needle of forbidden) {
    assert.equal(serialized.includes(needle), false, `${surfaceName} leaked ${needle}`);
  }
}

test("runtime/server SQLite isolates durable record rejections and cursor commits across streams", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-runtime-record-rejection-multistream-"));
  const dbPath = join(dir, "store.sqlite");
  const connectorId = "runtime-record-rejection-multistream";
  const runId = "run_record_rejection_multistream";
  const streamARejectedRecord = {
    data: { id: "stream-a-data-id", value: "stream-a-private" },
    emitted_at: "2026-08-11T12:00:00.000Z",
    key: "stream-a-wrong-key",
  };
  const streamBAcceptedRecord = {
    data: { id: "stream-b-ok", value: "stream-b-accepted" },
    emitted_at: "2026-08-11T12:00:01.000Z",
    key: "stream-b-ok",
  };
  const rejectedPayloadLine = JSON.stringify(streamARejectedRecord);
  const forbiddenPayloadNeedles = [rejectedPayloadLine, "stream-a-wrong-key", "stream-a-data-id", "stream-a-private"];
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
    const progress: unknown[] = [];
    const { cleanup, connectorPath } = createTestConnector([
      { ...streamARejectedRecord, stream: "stream_a", type: "RECORD" },
      { cursor: { cursor: "after_stream_a_rejection" }, stream: "stream_a", type: "STATE" },
      { ...streamBAcceptedRecord, stream: "stream_b", type: "RECORD" },
      { cursor: { cursor: "after_stream_b_accept" }, stream: "stream_b", type: "STATE" },
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
        rsUrl,
        runId,
        scope: { streams: [{ name: "stream_a" }, { name: "stream_b" }] },
        state: null,
      });

      assert.equal(result.status, "succeeded");
      assert.equal(result.records_emitted, 2);
      assert.equal(result.records_attempted, 2);
      assert.equal(result.records_accepted, 1);
      assert.equal(result.records_permanently_rejected, 1);
      assert.equal(result.records_unresolved_retryable, 0);
      assert.equal(result.checkpoint_summary?.records_attempted, 2);
      assert.equal(result.checkpoint_summary?.records_accepted, 1);
      assert.equal(result.checkpoint_summary?.records_flushed, 1);
      assert.equal(result.checkpoint_summary?.records_permanently_rejected, 1);
      assert.equal(result.checkpoint_summary?.records_unresolved_retryable, 0);
      assert.equal(result.checkpoint_summary?.state_streams_staged, 2);
      assert.equal(result.checkpoint_summary?.state_streams_committed, 2);
      assert.equal(result.checkpoint_summary?.commit_status, "committed");
      assertOmitsPrivatePayload("runtime result", result, forbiddenPayloadNeedles);
      assertOmitsPrivatePayload("runtime progress", progress, forbiddenPayloadNeedles);
    } finally {
      cleanup();
    }

    const ingestProgress = progress.filter(
      (message): message is Record<string, unknown> =>
        !!message && typeof message === "object" && (message as { type?: unknown }).type === "ingest"
    );
    assert.deepEqual(
      ingestProgress.map((message) => ({
        accepted: message.records_accepted,
        attempted: message.records_attempted,
        rejected: message.records_permanently_rejected,
        stream: message.stream,
      })),
      [
        { accepted: 0, attempted: 1, rejected: 1, stream: "stream_a" },
        { accepted: 1, attempted: 1, rejected: 0, stream: "stream_b" },
      ]
    );

    const state = (await loadSyncState(connectorId, ownerToken, { connectorInstanceId, rsUrl })) as Record<
      string,
      { cursor?: string } | undefined
    > | null;
    assert.equal(state?.stream_a?.cursor, "after_stream_a_rejection");
    assert.equal(state?.stream_b?.cursor, "after_stream_b_accept");

    const { body: streamARecordsBody, status: streamARecordsStatus } = await fetchJson(
      `${rsUrl}/v1/streams/stream_a/records?connector_id=${encodeURIComponent(connectorId)}&connector_instance_id=${encodeURIComponent(connectorInstanceId)}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } }
    );
    assert.equal(streamARecordsStatus, 200);
    assert.equal(((streamARecordsBody as { data?: unknown[] }).data ?? []).length, 0);

    const { body: streamBRecordsBody, status: streamBRecordsStatus } = await fetchJson(
      `${rsUrl}/v1/streams/stream_b/records?connector_id=${encodeURIComponent(connectorId)}&connector_instance_id=${encodeURIComponent(connectorInstanceId)}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } }
    );
    assert.equal(streamBRecordsStatus, 200);
    assertOmitsPrivatePayload("stream_b record response", streamBRecordsBody, forbiddenPayloadNeedles);
    assert.deepEqual(
      ((streamBRecordsBody as { data?: unknown[] }).data ?? []).map((record) => (record as { id?: string }).id),
      ["stream-b-ok"]
    );
    const { body: streamBDetailBody, status: streamBDetailStatus } = await fetchJson(
      `${rsUrl}/v1/streams/stream_b/records/${encodeURIComponent("stream-b-ok")}?connector_id=${encodeURIComponent(connectorId)}&connector_instance_id=${encodeURIComponent(connectorInstanceId)}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } }
    );
    assert.equal(streamBDetailStatus, 200);
    assertOmitsPrivatePayload("stream_b record detail", streamBDetailBody, forbiddenPayloadNeedles);
    assert.deepEqual((streamBDetailBody as { data?: unknown }).data, {
      id: "stream-b-ok",
      value: "stream-b-accepted",
    });

    const rows = getDb()
      .prepare(
        `SELECT receipt_id, reason_code, stream, first_input_index, latest_input_index, payload, payload_sha256,
                payload_bytes, owner_subject_id, run_id
         FROM record_rejections
         WHERE connector_instance_id = ?
         ORDER BY stream`
      )
      .all<{
        first_input_index: number;
        latest_input_index: number;
        owner_subject_id: string;
        payload_bytes: number;
        payload_sha256: string;
        payload: Buffer;
        reason_code: string;
        receipt_id: string;
        run_id: string;
        stream: string;
      }>(connectorInstanceId);
    assert.equal(rows.length, 1, "only stream_a should create a durable rejection receipt");
    const [row] = rows;
    assert.ok(row);
    assert.equal(row.owner_subject_id, OWNER_SUBJECT_ID);
    assert.equal(row.stream, "stream_a");
    assert.equal(row.reason_code, "invalid_record_identity");
    assert.equal(row.first_input_index, 0);
    assert.equal(row.latest_input_index, 0);
    assert.equal(row.payload.toString("utf8"), rejectedPayloadLine);
    assert.equal(row.payload_bytes, Buffer.byteLength(rejectedPayloadLine));
    assert.equal(row.run_id, runId);
    assert.ok(row.receipt_id.length > 0);
    assert.notEqual(row.receipt_id, row.payload_sha256);

    const listUrl = `${asUrl}/_ref/connections/${encodeURIComponent(connectorInstanceId)}/record-rejections`;
    const { body: listBody, status: listStatus } = await fetchJson(listUrl, {
      headers: { Cookie: ownerSession },
    });
    assert.equal(listStatus, 200);
    const listItems = (listBody as { data?: Record<string, unknown>[] }).data ?? [];
    assert.equal(listItems.length, 1);
    const [item] = listItems;
    assert.ok(item);
    assert.equal(item.receipt_id, row.receipt_id);
    assert.equal(item.connection_id, connectorInstanceId);
    assert.equal(item.connector_id, connectorId);
    assert.equal(item.stream, "stream_a");
    assert.equal(item.reason_code, "invalid_record_identity");
    assert.equal(item.payload_bytes, Buffer.byteLength(rejectedPayloadLine));
    assert.equal(item.payload_sha256, row.payload_sha256);
    assert.equal(item.status, "pending");
    assert.equal(item.run_id, runId);
    assert.equal("payload" in item, false);
    assertOmitsPrivatePayload("owner rejection list", listBody, forbiddenPayloadNeedles);

    const stateEvents = getDb()
      .prepare(
        `SELECT stream_id, data_json
         FROM spine_events
         WHERE run_id = ? AND event_type = 'run.state_advanced'
         ORDER BY event_seq`
      )
      .all<{ data_json: string; stream_id: string }>(runId);
    assert.deepEqual(
      stateEvents.map((event) => ({
        cursor: (JSON.parse(event.data_json) as { cursor?: { cursor?: string } }).cursor?.cursor,
        stream: event.stream_id,
      })),
      [
        { cursor: "after_stream_a_rejection", stream: "stream_a" },
        { cursor: "after_stream_b_accept", stream: "stream_b" },
      ]
    );

    const batchEvents = getDb()
      .prepare(
        `SELECT stream_id, data_json
         FROM spine_events
         WHERE run_id = ? AND event_type = 'run.batch_ingested'
         ORDER BY event_seq`
      )
      .all<{ data_json: string; stream_id: string }>(runId);
    assert.deepEqual(
      batchEvents.map((event) => {
        const data = JSON.parse(event.data_json) as Record<string, unknown>;
        return {
          accepted: data.records_accepted,
          attempted: data.records_attempted,
          rejected: data.records_permanently_rejected,
          stream: event.stream_id,
        };
      }),
      [
        { accepted: 0, attempted: 1, rejected: 1, stream: "stream_a" },
        { accepted: 1, attempted: 1, rejected: 0, stream: "stream_b" },
      ]
    );

    const facts = sqliteRunHistoryFacts(runId);
    assert.equal(facts.records_attempted, 2);
    assert.equal(facts.records_accepted, 1);
    assert.equal(facts.records_permanently_rejected, 1);
    assert.equal(facts.records_unresolved_retryable, 0);
    assert.equal(facts.records_flushed, 1);
    assertOmitsPrivatePayload("run history facts", facts, forbiddenPayloadNeedles);
    assertOmitsPrivatePayload(
      "spine timeline and mutation audit",
      getDb().prepare("SELECT data_json FROM spine_events WHERE run_id = ? ORDER BY event_seq").all(runId),
      forbiddenPayloadNeedles
    );

    const quota = getDb()
      .prepare("SELECT pending_payload_bytes FROM record_rejection_quota WHERE owner_subject_id = ?")
      .get<{ pending_payload_bytes: number }>(OWNER_SUBJECT_ID);
    assert.equal(quota?.pending_payload_bytes, Buffer.byteLength(rejectedPayloadLine));
  } finally {
    if (server) {
      await closeServer(server);
    }
    rmSync(dir, { force: true, recursive: true });
  }
});
