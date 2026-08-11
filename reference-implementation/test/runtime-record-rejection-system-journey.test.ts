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
import { createRequestConnectorInstanceStore } from "../server/request-store-factories.ts";
import { admitOwnerRunConnection } from "../server/stores/connector-instance-store.ts";

const OWNER_SUBJECT_ID = "owner_alice";
const OWNER_PASSWORD = "runtime-record-rejection-password";
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
    display_name: "Runtime Record Rejection Journey Test Connector",
    protocol_version: "0.1.0",
    streams: [{ name: "items", primary_key: ["id"], schema: streamSchema(), semantics: "append_only" }],
    version: "1.0.0",
  };
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

function assertOmitsPrivatePayload(surfaceName: string, surface: unknown, forbidden: readonly string[]) {
  const serialized = JSON.stringify(surface);
  for (const needle of forbidden) {
    assert.equal(serialized.includes(needle), false, `${surfaceName} leaked ${needle}`);
  }
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
  const forbiddenPayloadNeedles = [rejectedPayloadLine, "bad-key", "bad-data"];
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
        manifest: manifest(connectorId),
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
        `SELECT receipt_id, reason_code, first_input_index, latest_input_index, payload_text, payload_sha256,
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
        payload_text: string;
        reason_code: string;
        receipt_id: string;
      }>(connectorInstanceId);
    assert.ok(row, "invalid identity must create a durable rejection receipt row");
    assert.equal(row.reason_code, "invalid_record_identity");
    assert.equal(row.first_input_index, 1);
    assert.equal(row.latest_input_index, 1);
    assert.equal(row.payload_text, rejectedPayloadLine);
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
    assert.equal("payload_text" in item, false);
    assert.equal("payloadText" in item, false);
    assertOmitsPrivatePayload("owner rejection list", listBody, [
      ...forbiddenPayloadNeedles,
      "payloadText",
      "payload_text",
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
    assert.equal(detail.payload_text, rejectedPayloadLine);
    assert.equal(JSON.stringify(detail).includes("storage exploded"), false);
    assert.equal(JSON.stringify(detail).includes("parser exploded"), false);
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
