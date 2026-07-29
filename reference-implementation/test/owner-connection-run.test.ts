// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration suite for the bearer-authed owner-agent run-now control routes
 * (mounted from `server/routes/owner-connection-run.ts`):
 *
 *   POST /v1/owner/connections/:connectionId/run
 *   POST /v1/owner/connectors/:connectorId/run
 *
 * Covers the instance-scoped owner-agent run slice (tasks 6.1-6.3) plus the
 * authorization/audit hardening (tasks 3.1-3.3, 8.1, 8.4):
 *
 *   - a trusted owner-agent bearer starts a run for an instance-scoped
 *     connection by `connection_id` and receives a 202 with the run handle;
 *   - the connector-only route auto-selects the single active connection
 *     (single-instance compatibility, task 6.3);
 *   - the connector-only route rejects a connector with two active connections
 *     using a typed `ambiguous_connection` (409) carrying the available
 *     `connection_id` values and `retry_with: connection_id` (task 6.2);
 *   - every run attempt emits non-secret `owner_agent.connection.run` audit
 *     evidence; failures are typed and audited without secrets (task 3.3);
 *   - client grant tokens (403), missing bearers (401), and `/mcp` owner
 *     bearers (403) cannot reach the routes (tasks 3.1, 3.2);
 *   - the control surface advertises run_connection as supported (task 2.3).
 *
 * The run path requires a runnable connector implementation, so these tests
 * inject a trivial echo connector via `connectorPathResolver` (the same hook
 * `run-interaction-control.test.js` uses) that completes immediately, so the
 * 202 resolves and the run drains cleanly on teardown.
 *
 * Spec: openspec/changes/add-owner-agent-control-surface
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { listSpineEventsPage, type SpineEventRecord } from "../lib/spine.ts";
import { canonicalConnectorKey } from "../server/connector-key.ts";
import { startServer as startServerUntyped } from "../server/index.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";

const REGEXP_1 = /owner-agent/i;

// server/index.js (startServer) is untyped JS (allowJs, checkJs:false).
// Same boundary-cast pattern as owner-connection-revoke.test.ts: read
// each field this suite actually uses off an indexed `Record<string,
// unknown>` view of the awaited result rather than casting the whole
// (deeply, incompletely inferred) object at once.
interface CloseableHandle {
  close: (cb: (err?: Error) => void) => unknown;
  closeAllConnections: () => void;
}

interface ClosableServer {
  asPort: number;
  asServer: CloseableHandle;
  rsPort: number;
  rsServer: CloseableHandle;
  schedulerManager?: { stop?: () => void };
}

interface StartServerOptions {
  asPort?: number;
  connectorPathResolver?: () => string;
  dbPath?: string;
  ownerAuthPassword?: string;
  quiet?: boolean;
  rsPort?: number;
}

async function startServer(opts: StartServerOptions): Promise<ClosableServer> {
  const raw: Record<string, unknown> = await startServerUntyped(opts);
  const result: ClosableServer = {
    asPort: raw.asPort as number,
    asServer: raw.asServer as CloseableHandle,
    rsPort: raw.rsPort as number,
    rsServer: raw.rsServer as CloseableHandle,
  };
  if (raw.schedulerManager !== undefined) {
    result.schedulerManager = raw.schedulerManager as { stop?: () => void };
  }
  return result;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, "..");
const OWNER_SUBJECT_ID = "owner_local";
const OTHER_SUBJECT_ID = "owner_other";
const OWNER_CLIENT_ID = "cli_longview";
const NOW = "2026-05-31T00:00:00.000Z";

async function closeServer(server: ClosableServer): Promise<void> {
  server.schedulerManager?.stop?.();
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise((resolve) => server.asServer.close(() => resolve(undefined))),
    new Promise((resolve) => server.rsServer.close(() => resolve(undefined))),
  ]);
}

// Response body shape across every route this suite exercises.
interface RunResponseBody {
  actions?: { family: string; status: string; method: string; url: string }[];
  error?: {
    code?: string;
    type?: string;
    message?: string;
    retry_with?: string;
    available_connections?: { connection_id: string; display_name?: string }[];
  };
  run_id?: string;
}

interface FetchJsonResult {
  body: RunResponseBody | null;
  resp: Response;
  status: number;
}

async function fetchJson(url: string, opts: RequestInit = {}): Promise<FetchJsonResult> {
  const resp = await fetch(url, opts);
  const text = await resp.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { body: body as RunResponseBody | null, resp, status: resp.status };
}

interface ConnectorFixture {
  path: string;
  startPath: string;
}

// A connector that completes immediately on START so run-now returns a 202
// handle and the run drains without lingering on teardown.
function buildImmediateConnectorFixture(tmpDir: string): ConnectorFixture {
  const path = join(tmpDir, "connector.mjs");
  const startPath = join(tmpDir, "start.json");
  writeFileSync(
    path,
    `
import { writeFileSync } from 'node:fs';
import { createInterface } from 'readline';

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === 'START') {
    writeFileSync(${JSON.stringify(startPath)}, JSON.stringify(msg));
    process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 0 }) + '\\n');
    rl.close();
    process.exit(0);
  }
});
`,
    "utf8"
  );
  return { path, startPath };
}

interface ServerHandles {
  asUrl: string;
  rsUrl: string;
  startPath: string;
}

async function withServer(fn: (handles: ServerHandles) => Promise<void>): Promise<void> {
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-owner-run-"));
  const connectorFixture = buildImmediateConnectorFixture(tmpDir);
  const server = await startServer({
    asPort: 0,
    connectorPathResolver: () => connectorFixture.path,
    dbPath: ":memory:",
    ownerAuthPassword: "",
    quiet: true,
    rsPort: 0,
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  try {
    await fn({ asUrl, rsUrl, startPath: connectorFixture.startPath });
  } finally {
    await closeServer(server);
    rmSync(tmpDir, { force: true, recursive: true });
  }
}

// Device-code exchange yields an owner-kind bearer (pdpp_token_kind: "owner").
async function issueOwnerToken(asUrl: string, subjectId = OWNER_SUBJECT_ID): Promise<string> {
  const device = (
    await fetchJson(`${asUrl}/oauth/device_authorization`, {
      body: new URLSearchParams({ client_id: OWNER_CLIENT_ID }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    })
  ).body as { device_code: string; user_code: string };
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
  return tok.access_token as string;
}

// PAR + consent yields a grant-scoped client-kind bearer (pdpp_token_kind:
// "client"). These must NOT reach the owner-agent control surface.
async function approveClientGrant(asUrl: string, connectorId: string, streamName: string): Promise<string> {
  const par = (
    await fetchJson(`${asUrl}/oauth/par`, {
      body: JSON.stringify({
        authorization_details: [
          {
            access_mode: "continuous",
            purpose_code: "https://pdpp.org/purpose/analytics",
            purpose_description: "owner-connection run boundary test",
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
  ).body as { request_uri: string };
  const approved = (
    await fetchJson(`${asUrl}/consent/approve`, {
      body: JSON.stringify({ request_uri: par.request_uri, subject_id: OWNER_SUBJECT_ID }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    })
  ).body as { token?: string };
  assert.ok(approved.token, "consent approval should issue a client grant token");
  return approved.token as string;
}

interface ReferenceManifest {
  connector_id: string;
  streams: { name: string }[];
  [key: string]: unknown;
}

function loadReferenceManifest(name: string): ReferenceManifest {
  return JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, "manifests", `${name}.json`), "utf8"));
}

// canonicalConnectorKey returns string | null for arbitrary `unknown`
// input; every reference manifest in this suite has a well-formed
// connector_id, so a null result is a fixture bug, not a real outcome to
// carry through every call site as `| null`.
function mustCanonicalConnectorKey(connectorId: unknown): string {
  const key = canonicalConnectorKey(connectorId);
  assert.ok(key, `expected a canonical connector key for ${JSON.stringify(connectorId)}`);
  return key;
}

function mustFirstStreamName(manifest: ReferenceManifest): string {
  // biome-ignore lint/style/useDestructuring: Indexed access expresses the protocol field position under test.
  const stream = manifest.streams[0];
  assert.ok(stream, `expected at least one stream on ${manifest.connector_id}`);
  return stream.name;
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
  sourceBindingKey: string;
}

async function seedInstance({
  connectorInstanceId,
  connectorId,
  displayName,
  sourceBindingKey,
  ownerSubjectId = OWNER_SUBJECT_ID,
}: SeedInstanceOptions): Promise<void> {
  const store = createSqliteConnectorInstanceStore();
  await store.upsert({
    connectorId,
    connectorInstanceId,
    createdAt: NOW,
    displayName,
    ownerSubjectId,
    sourceBinding: { account_hint: sourceBindingKey },
    sourceBindingKey,
    sourceKind: "account",
    status: "active",
    updatedAt: NOW,
  });
}

// biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
async function postRun(
  rsUrl: string,
  ownerToken: string,
  path: string,
  body: Record<string, unknown> | null = null
): Promise<FetchJsonResult> {
  return fetchJson(`${rsUrl}${path}`, {
    headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
    method: "POST",
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

interface StartEnvelope {
  scope: { streams: { name: string; resources: string[] }[] };
  [key: string]: unknown;
}

async function readStartEnvelope(startPath: string): Promise<StartEnvelope> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (existsSync(startPath)) {
      return JSON.parse(readFileSync(startPath, "utf8"));
    }
    // biome-ignore lint/performance/noAwaitInLoops: Sequential test setup and assertion order is intentional.
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`START envelope was not written: ${startPath}`);
}

// data is `unknown` on the real SpineEventRecord; this suite reads a fixed
// set of run-audit-specific keys off it, modeled locally.
interface RunAuditData {
  actor_kind?: string;
  auth_token_kind?: string;
  connection_id?: string;
  connector_key?: string;
  error?: { code?: string; http_status?: number };
  forced?: boolean;
  operation?: string;
  run_id?: string;
  selector?: string;
}

function findRunAuditEvent(resp: Response): SpineEventRecord & { data: RunAuditData | null } {
  const traceId = resp.headers.get("PDPP-Reference-Trace-Id");
  assert.ok(traceId?.startsWith("trc_"), "run response should carry an audit trace id");
  const page = listSpineEventsPage("trace", traceId as string, { limit: 20 });
  const event = page.events.find((entry) => entry.event_type === "owner_agent.connection.run");
  assert.ok(event, "expected owner-agent run audit event");
  assert.equal(event.request_id, resp.headers.get("Request-Id"));
  assert.equal(event.token_id, null, "audit event must not store bearer tokens");
  return event as SpineEventRecord & { data: RunAuditData | null };
}

test("owner-agent bearer starts an instance-scoped connection run (202) and audits it", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const connectorKey = mustCanonicalConnectorKey(manifest.connector_id);
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_spotify_personal",
      displayName: "My Spotify",
      sourceBindingKey: "the owner@example.com",
    });

    const ownerToken = await issueOwnerToken(asUrl);
    const run = await postRun(rsUrl, ownerToken, "/v1/owner/connections/cin_spotify_personal/run");
    assert.equal(run.status, 202);
    assert.ok(typeof run.body?.run_id === "string" && run.body.run_id.length > 0, "run handle must carry a run_id");

    const audit = findRunAuditEvent(run.resp);
    assert.equal(audit.actor_type, "owner_agent");
    assert.equal(audit.actor_id, OWNER_CLIENT_ID);
    assert.equal(audit.client_id, OWNER_CLIENT_ID);
    assert.equal(audit.subject_id, OWNER_SUBJECT_ID);
    assert.equal(audit.object_type, "connection");
    assert.equal(audit.object_id, "cin_spotify_personal");
    assert.equal(audit.status, "succeeded");
    assert.equal(audit.data?.actor_kind, "owner_agent");
    assert.equal(audit.data?.auth_token_kind, "owner");
    assert.equal(audit.data?.operation, "run_now");
    assert.equal(audit.data?.selector, "connection_id");
    assert.equal(audit.data?.connection_id, "cin_spotify_personal");
    assert.equal(audit.data?.connector_key, connectorKey);
    assert.equal(audit.data?.forced, false);
    assert.equal(audit.data?.run_id, run.body.run_id, "audit records the run handle id");
  });
});

test("owner-agent connection force run audits the forced admission path", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const connectorKey = mustCanonicalConnectorKey(manifest.connector_id);
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_spotify_force",
      displayName: "Spotify force path",
      sourceBindingKey: "spotify-force",
    });

    const ownerToken = await issueOwnerToken(asUrl);
    const run = await postRun(rsUrl, ownerToken, "/v1/owner/connections/cin_spotify_force/run", { force: true });
    assert.equal(run.status, 202);

    const audit = findRunAuditEvent(run.resp);
    assert.equal(audit.status, "succeeded");
    assert.equal(audit.data?.connection_id, "cin_spotify_force");
    assert.equal(audit.data?.operation, "run_now");
    assert.equal(audit.data?.forced, true);
    assert.equal(audit.data?.run_id, run.body?.run_id);
  });
});

test("owner-agent connector-only run auto-selects the single active connection", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const connectorKey = mustCanonicalConnectorKey(manifest.connector_id);
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_spotify_only",
      displayName: "My Spotify",
      sourceBindingKey: "the owner@example.com",
    });

    const ownerToken = await issueOwnerToken(asUrl);
    const run = await postRun(rsUrl, ownerToken, `/v1/owner/connectors/${encodeURIComponent(connectorKey)}/run`);
    assert.equal(run.status, 202);
    assert.ok(typeof run.body?.run_id === "string");

    const audit = findRunAuditEvent(run.resp);
    assert.equal(audit.data?.selector, "connector_id");
    // The auto-selected connection's concrete id is recorded for audit.
    assert.equal(audit.data?.connection_id, "cin_spotify_only");
    assert.equal(audit.data?.operation, "run_now");
  });
});

test("owner-agent connection run forwards scoped resources into connector START", async () => {
  await withServer(async ({ asUrl, rsUrl, startPath }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const connectorKey = mustCanonicalConnectorKey(manifest.connector_id);
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_spotify_personal",
      displayName: "Spotify",
      sourceBindingKey: "spotify-account",
    });

    const ownerToken = await issueOwnerToken(asUrl);
    const run = await postRun(rsUrl, ownerToken, "/v1/owner/connections/cin_spotify_personal/run", {
      resources: { saved_tracks: ["track_1", "track_1", ""] },
    });
    assert.equal(run.status, 202);

    const start = await readStartEnvelope(startPath);
    assert.deepEqual(start.scope.streams, [{ name: "saved_tracks", resources: ["track_1"] }]);
  });
});

test("owner-agent connector-only run rejects two active connections with typed ambiguous_connection", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const connectorKey = mustCanonicalConnectorKey(manifest.connector_id);
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_spotify_personal",
      displayName: "the owner personal",
      sourceBindingKey: "the owner@example.com",
    });
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_spotify_shared",
      displayName: "Shared Spotify",
      sourceBindingKey: "shared@example.com",
    });

    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body, resp } = await postRun(
      rsUrl,
      ownerToken,
      `/v1/owner/connectors/${encodeURIComponent(connectorKey)}/run`
    );
    assert.equal(status, 409);
    assert.equal(body?.error?.code, "ambiguous_connection");
    // The envelope carries the available connection ids + retry guidance so the
    // agent can recover without a probe.
    assert.equal(body?.error?.retry_with, "connection_id");
    const ids = (body?.error?.available_connections ?? []).map((c) => c.connection_id).sort();
    assert.deepEqual(ids, ["cin_spotify_personal", "cin_spotify_shared"]);
    // Owner-meaningful labels travel with the available connections.
    const labels = (body?.error?.available_connections ?? [])
      .map((c) => c.display_name)
      .filter(Boolean)
      .sort();
    assert.deepEqual(labels, ["Shared Spotify", "the owner personal"]);

    const audit = findRunAuditEvent(resp);
    assert.equal(audit.status, "failed");
    assert.equal(audit.data?.selector, "connector_id");
    assert.equal(audit.data?.connector_key, connectorKey);
    assert.equal(audit.data?.operation, "run_now");
    assert.equal(audit.data?.error?.code, "ambiguous_connection");
    assert.equal(audit.data?.error?.http_status, 409);
  });
});

test("owner-agent run on an unknown connection_id returns a typed 404", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body, resp } = await postRun(rsUrl, ownerToken, "/v1/owner/connections/cin_missing/run");
    assert.equal(status, 404);
    assert.equal(body?.error?.code, "connector_instance_not_found");
    const audit = findRunAuditEvent(resp);
    assert.equal(audit.status, "failed");
    assert.equal(audit.object_id, "cin_missing");
    assert.equal(audit.data?.connection_id, "cin_missing");
    assert.equal(audit.data?.error?.code, "connector_instance_not_found");
  });
});

test("owner-agent run cannot cross owners (other-owner instance is not found)", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const connectorKey = mustCanonicalConnectorKey(manifest.connector_id);
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_spotify_other",
      displayName: "Other Spotify",
      ownerSubjectId: OTHER_SUBJECT_ID,
      sourceBindingKey: "other@example.com",
    });
    const ownerToken = await issueOwnerToken(asUrl);
    const { status } = await postRun(rsUrl, ownerToken, "/v1/owner/connections/cin_spotify_other/run");
    // Resolver rejects the foreign instance.
    assert.ok(status === 404 || status === 403, `expected 404/403, got ${status}`);
  });
});

test("owner-agent run rejects a client grant token with 403 and audits it", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const connectorKey = mustCanonicalConnectorKey(manifest.connector_id);
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_spotify_personal",
      displayName: "My Spotify",
      sourceBindingKey: "the owner@example.com",
    });
    const clientToken = await approveClientGrant(asUrl, connectorKey, mustFirstStreamName(manifest));

    const { status, body, resp } = await postRun(rsUrl, clientToken, "/v1/owner/connections/cin_spotify_personal/run");
    assert.equal(status, 403);
    assert.equal(body?.error?.code, "permission_error");

    const audit = findRunAuditEvent(resp);
    assert.equal(audit.status, "failed");
    assert.equal(audit.actor_type, "client");
    assert.equal(audit.data?.actor_kind, "client");
    assert.equal(audit.data?.operation, "run_now");
    assert.equal(audit.data?.error?.code, "permission_error");
  });
});

test("owner-agent run rejects a request with no bearer (401)", async () => {
  await withServer(async ({ rsUrl }) => {
    const { status, body } = await fetchJson(`${rsUrl}/v1/owner/connections/cin_spotify_personal/run`, {
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(status, 401);
    assert.equal(body?.error?.type, "authentication_error");
  });
});

test("/mcp continues to reject owner-agent bearers after run control lands", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body } = await fetchJson(`${rsUrl}/mcp`, {
      body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/list", params: {} }),
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${ownerToken}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    assert.equal(status, 403);
    assert.equal(body?.error?.code, "permission_error");
    assert.match(body?.error?.message ?? "", REGEXP_1);
  });
});

test("owner-agent control document advertises run_connection as supported with a run URL", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const { body } = await fetchJson(`${rsUrl}/v1/owner/control`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const run = body?.actions?.find((a) => a.family === "run_connection");
    assert.ok(run, "run_connection must be advertised");
    assert.equal(run.status, "supported");
    assert.equal(run.method, "POST");
    assert.equal(run.url, `${rsUrl}/v1/owner/connections/{connection_id}/run`);
  });
});
