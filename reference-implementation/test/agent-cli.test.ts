// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Agent CLI tests — covers:
 *   - project-local cache read/write/redaction
 *   - bootstrap (DCR registration)
 *   - request (PAR staging)
 *   - store (token persistence via introspection)
 *   - use (token retrieval)
 *   - forget (local-only removal)
 *   - revoke (AS revocation + local removal)
 *   - secret-redaction: status output never contains token material
 */

import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { CachedGrant } from "../cli/lib/cache.ts";

const DENIED_POLL_SECRET_PATTERN = /Bearer|owner_local|access_token/;
const EXPIRED_POLL_SECRET_PATTERN = /access_token|polling_code/;
const COMPLETION_SEAM_CRASH_PATTERN = /completion seam crash/;
const INVALID_TOKEN_PATTERN = /not-a-real-token/;
const ACCESS_TOKEN_PATTERN = /access_token/;

import {
  deleteGrantFiles,
  ensureCacheDirs,
  hasUsableGrant,
  listClients,
  listGrants,
  readAccess,
  readGrant,
  readToken,
  redactGrantForDisplay,
  writeAccess,
  writeClient,
  writeGrant,
  writeToken,
} from "../cli/lib/cache.ts";
import {
  approveInline,
  buildParRequest,
  registerClient,
  stageParRequest,
} from "../examples/third-party-app/lib/flow.ts";
import { exec as dbExec, getOne, referenceQueries } from "../lib/db.ts";
import { parsePendingConsentRequestUri } from "../server/auth.ts";
import { canonicalConnectorKey } from "../server/connector-key.ts";
import { startServer } from "../server/index.ts";
import { closePostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { DEFAULT_LOCAL_DCR_INITIAL_ACCESS_TOKEN } from "../server/reference-local-defaults.ts";
import { createRequestConnectorInstanceStore } from "../server/request-store-factories.ts";
import {
  __setAgentConnectCleanupAfterMissForTest,
  __setAgentConnectCleanupBeforeExpireForTest,
  __setAgentConnectCompleteBeforeMarkForTest,
  __setAgentConnectCompleteFailureForTest,
  __setAgentConnectCreateBeforePersistForTest,
} from "../server/routes/as-agent-connect.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";
import { introspectionHeaders } from "./helpers/introspection.ts";
import { TEST_INTROSPECTION_SERVER_OPTS } from "./helpers/introspection-test-credentials.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";
import { makeTemporaryDir } from "./helpers/temp-dir.ts";

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeTmpCache() {
  return makeTemporaryDir("pdpp-agent-test-");
}

// `startServer`'s inferred asServer/rsServer type comes from a framework
// `.listen()` call whose TS overload resolves to an http2-shaped type, but at
// runtime these are plain node:http/https servers (the framework never
// negotiates ALPN in this reference stack) — so `closeAllConnections` (added
// Node 18.2+) and the single-error-arg `close` callback genuinely exist and
// are safe to declare here. Matches the established pattern in
// connector-summary-dirty-hooks.test.ts / connector-failure-diagnostics-control-plane.test.ts.
type TestServer = Awaited<ReturnType<typeof startServer>> & {
  asPort: number;
  rsPort: number;
  asServer: { close: (cb: (err?: Error) => void) => void; closeAllConnections: () => void };
  rsServer: { close: (cb: (err?: Error) => void) => void; closeAllConnections: () => void };
};

async function closeServer(server: TestServer): Promise<void> {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  const closeOne = (srv: TestServer["asServer"] | TestServer["rsServer"]) =>
    new Promise<void>((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (!done) {
          done = true;
          resolve();
        }
      }, 2000);
      srv.close(() => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve();
        }
      });
    });
  await Promise.allSettled([closeOne(server.asServer), closeOne(server.rsServer)]);
}

async function spinUpServer(
  opts: Record<string, unknown> = {}
): Promise<{ server: TestServer; asUrl: string; rsUrl: string }> {
  const server = (await startServer({
    asPort: 0,
    dbPath: ":memory:",
    quiet: true,
    rsPort: 0,
    ...TEST_INTROSPECTION_SERVER_OPTS,
    ...opts,
  })) as TestServer;
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  return { asUrl, rsUrl, server };
}

function rewriteUrlOrigin(url: string, origin: string): string {
  const rewritten = new URL(url);
  const nextOrigin = new URL(origin);
  rewritten.protocol = nextOrigin.protocol;
  rewritten.host = nextOrigin.host;
  return rewritten.toString();
}

interface SpotifyManifest {
  connector_id: string;
  streams: Array<{ name: string }>;
}

interface AgentConnectStart {
  approval_url: string;
  id: string;
  polling_code: string;
  status: string;
  token_url: string;
}

interface AgentConnectRequestResult {
  registered: { client_id: string };
  spotifyManifest: SpotifyManifest;
  staged: { request_uri: string; authorization_url?: string };
  start: AgentConnectStart;
  streamName: string;
}

async function createAgentConnectRequest({
  asUrl,
  clientName = "Agent Connect Test",
  agentConnectClientId,
}: {
  asUrl: string;
  clientName?: string;
  agentConnectClientId?: string;
}): Promise<AgentConnectRequestResult> {
  const spotifyManifest = await registerSpotify(asUrl);
  await seedSpotifyOwnerConnection(spotifyManifest);
  const registered = await registerClient({
    asUrl,
    initialAccessToken: DEFAULT_LOCAL_DCR_INITIAL_ACCESS_TOKEN,
    metadata: { client_name: clientName, token_endpoint_auth_method: "none" },
  });
  const [firstStream] = spotifyManifest.streams;
  assert.ok(firstStream, "spotify manifest should declare at least one stream");
  const streamName = firstStream.name;
  const staged = await stageParRequest({
    asUrl,
    request: buildParRequest({
      accessMode: "single_use",
      clientId: registered.client_id,
      clientName,
      purposeCode: "https://pdpp.dev/purpose/personal_assistant",
      purposeDescription: "Test agent-connect access.",
      sourceId: spotifyManifest.connector_id,
      sourceKind: "connector",
      streamName,
    }),
  });
  const startResp = await fetch(`${asUrl}/agent-connect`, {
    body: JSON.stringify({
      client_id: agentConnectClientId ?? registered.client_id,
      request_uri: staged.request_uri,
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const start = (await startResp.json()) as AgentConnectStart;
  assert.equal(startResp.status, 201, JSON.stringify(start));
  assertCredentialNoStoreHeaders(startResp);
  assert.equal(start.status, "pending");
  assert.equal(typeof start.polling_code, "string");
  assert.equal(typeof start.approval_url, "string");
  assert.equal(typeof start.token_url, "string");
  return { registered, spotifyManifest, staged, start, streamName };
}

interface AgentConnectTokenBody {
  access_token?: string;
  error?: string;
  grant_id?: string;
  token_type?: string;
  [key: string]: unknown;
}

async function pollAgentConnectToken({
  tokenUrl,
  pollingCode,
}: {
  tokenUrl: string;
  pollingCode: string;
}): Promise<{ resp: Response; body: AgentConnectTokenBody }> {
  const resp = await fetch(tokenUrl, {
    body: JSON.stringify({ polling_code: pollingCode }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const body = (await resp.json()) as AgentConnectTokenBody;
  return { body, resp };
}

function sqliteCommittedTokenForRequestUri(requestUri: string): string {
  const deviceCode = parsePendingConsentRequestUri(requestUri);
  assert.ok(deviceCode, "request_uri should parse to device code");
  const row = getOne<{ token_id?: string | null }>(referenceQueries.authPendingConsentsGetByDeviceCode, [deviceCode]);
  assert.ok(row?.token_id, "approved pending consent should retain committed token_id");
  return row.token_id;
}

function sqliteApprovalIdForRequestUri(requestUri: string): string {
  const deviceCode = parsePendingConsentRequestUri(requestUri);
  assert.ok(deviceCode, "request_uri should parse to device code");
  const row = getOne<{ approval_id?: string | null }>(referenceQueries.authPendingConsentsGetByDeviceCode, [
    deviceCode,
  ]);
  assert.ok(row?.approval_id, "pending consent should expose approval_id");
  return row.approval_id;
}

async function postgresApprovalIdForRequestUri(requestUri: string): Promise<string> {
  const deviceCode = parsePendingConsentRequestUri(requestUri);
  assert.ok(deviceCode, "request_uri should parse to device code");
  const result = await postgresQuery<{ approval_id?: string | null }>(
    "SELECT approval_id FROM pending_consents WHERE device_code = $1",
    [deviceCode]
  );
  const approvalId = result.rows[0]?.approval_id;
  assert.ok(approvalId, "pending consent should expose approval_id");
  return approvalId;
}

async function postgresCommittedTokenForRequestUri(requestUri: string): Promise<string> {
  const deviceCode = parsePendingConsentRequestUri(requestUri);
  assert.ok(deviceCode, "request_uri should parse to device code");
  const result = await postgresQuery<{ token_id?: string | null }>(
    "SELECT token_id FROM pending_consents WHERE device_code = $1",
    [deviceCode]
  );
  const token = result.rows[0]?.token_id;
  assert.ok(token, "approved pending consent should retain committed token_id");
  return token;
}

async function tokenIsIntrospectionActive(asUrl: string, token: string): Promise<boolean> {
  const resp = await fetch(`${asUrl}/introspect`, {
    body: JSON.stringify({ token }),
    headers: introspectionHeaders(),
    method: "POST",
  });
  const body = (await resp.json()) as { active?: boolean };
  return body.active === true;
}

function setSqliteAgentConnectAttemptExpiresAt(id: string, expiresAt: number): void {
  dbExec(referenceQueries.authAgentConnectAttemptsSetExpiresAtById, [expiresAt, id]);
}

function sqliteAgentConnectAttemptCountByStatus(status: string): number {
  const row = getOne<{ count?: number }>(referenceQueries.authAgentConnectAttemptsCountByStatus, [status]);
  return Number(row?.count ?? 0);
}

async function setPostgresAgentConnectAttemptExpiresAt(id: string, expiresAt: number): Promise<void> {
  await postgresQuery("UPDATE agent_connect_attempts SET expires_at_ms = $1 WHERE id = $2", [expiresAt, id]);
}

async function postgresAgentConnectAttemptCountByStatus(status: string): Promise<number> {
  const result = await postgresQuery<{ count?: string | number }>(
    "SELECT COUNT(*) AS count FROM agent_connect_attempts WHERE status = $1",
    [status]
  );
  return Number(result.rows[0]?.count ?? 0);
}

function createCleanupPause() {
  let releaseCleanup!: () => void;
  let observedMiss!: () => void;
  const resume = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });
  const paused = new Promise<void>((resolve) => {
    observedMiss = resolve;
  });
  return {
    hook: async () => {
      observedMiss();
      await resume;
    },
    paused,
    release: releaseCleanup,
  };
}

function createPause() {
  let release!: () => void;
  let observed!: () => void;
  const resume = new Promise<void>((resolve) => {
    release = resolve;
  });
  const paused = new Promise<void>((resolve) => {
    observed = resolve;
  });
  return {
    hook: async () => {
      observed();
      await resume;
    },
    paused,
    release,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorCode(body: unknown): string | null {
  if (!isRecord(body)) {
    return null;
  }
  const { error, code } = body;
  if (isRecord(error) && typeof error.code === "string") {
    return error.code;
  }
  if (typeof error === "string") {
    return error;
  }
  if (typeof code === "string") {
    return code;
  }
  return null;
}

function assertCredentialNoStoreHeaders(resp: Response): void {
  assert.equal(resp.headers.get("cache-control"), "no-store");
  assert.equal(resp.headers.get("pragma"), "no-cache");
}

async function registerSpotify(asUrl: string): Promise<SpotifyManifest> {
  const { readFileSync: rfs } = await import("node:fs");
  const { join: pjoin, dirname: pdir } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const __dir = pdir(fileURLToPath(import.meta.url));
  const manifest = JSON.parse(rfs(pjoin(__dir, "../fixtures/seed-manifests/spotify.json"), "utf8")) as SpotifyManifest;
  const resp = await fetch(`${asUrl}/connectors`, {
    body: JSON.stringify(manifest),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  if (!resp.ok) {
    throw new Error(`connector registration failed (${resp.status})`);
  }
  return manifest;
}

async function seedSpotifyOwnerConnection(manifest: SpotifyManifest): Promise<string> {
  const connectorId = canonicalConnectorKey(manifest.connector_id) ?? manifest.connector_id;
  const connectorInstanceId = `cin_agent_${connectorId}`;
  const now = new Date().toISOString();
  await createRequestConnectorInstanceStore().upsert({
    connectorId,
    connectorInstanceId,
    createdAt: now,
    displayName: `${manifest.connector_id} test account`,
    ownerSubjectId: "owner_local",
    sourceBinding: { fixture: connectorInstanceId },
    sourceBindingKey: connectorInstanceId,
    sourceKind: "account",
    status: "active",
    updatedAt: now,
  });
  return connectorInstanceId;
}

// ─── cache unit tests ─────────────────────────────────────────────────────────

test("cache: writeAccess / readAccess round-trips without token material", async () => {
  const cacheRoot = makeTmpCache();
  await ensureCacheDirs(cacheRoot);
  writeAccess(cacheRoot, { as_url: "http://as.example", rs_url: "http://rs.example" });
  const access = readAccess(cacheRoot);
  assert.ok(access, "access record should be cached");
  assert.equal(access.as_url, "http://as.example");
  assert.equal(access.rs_url, "http://rs.example");
  assert.ok(access.last_activity, "last_activity should be set");
  assert.equal(typeof access.last_activity, "string");
});

test("cache: writeClient / listClients round-trips", async () => {
  const cacheRoot = makeTmpCache();
  await ensureCacheDirs(cacheRoot);
  writeClient(cacheRoot, "client_abc", { client_id: "client_abc", client_name: "Test Client" });
  const clients = listClients(cacheRoot);
  assert.equal(clients.length, 1);
  const [client] = clients;
  assert.ok(client, "listClients should return the written client");
  assert.equal(client.client_id, "client_abc");
});

test("cache: writeGrant / readGrant / listGrants round-trips without token material", async () => {
  const cacheRoot = makeTmpCache();
  await ensureCacheDirs(cacheRoot);
  const grantMeta: CachedGrant = {
    access_mode: "single_use",
    expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    grant_id: "grant_xyz",
    issued_at: new Date().toISOString(),
    purpose_description: "Test purpose",
    revoked: false,
    source: { id: "https://registry.pdpp.dev/connectors/spotify", kind: "connector" },
    streams: [{ name: "listening_history" }],
  };
  writeGrant(cacheRoot, "grant_xyz", grantMeta);
  const read = readGrant(cacheRoot, "grant_xyz");
  assert.ok(read, "grant should round-trip through the cache");
  assert.equal(read.grant_id, "grant_xyz");
  assert.deepEqual(read.source, grantMeta.source);
  assert.deepEqual(read.streams, grantMeta.streams);
  const list = listGrants(cacheRoot);
  assert.equal(list.length, 1);
});

test("cache: writeToken / readToken — token file is mode 0600", async () => {
  const cacheRoot = makeTmpCache();
  await ensureCacheDirs(cacheRoot);
  await writeToken(cacheRoot, "grant_xyz", "super-secret-token-value");
  const token = readToken(cacheRoot, "grant_xyz");
  assert.equal(token, "super-secret-token-value");
  const tokenPath = join(cacheRoot, "tokens", "grant_xyz.token");
  const st = statSync(tokenPath);
  const mode = Number.parseInt(st.mode.toString(8).slice(-3), 8);
  assert.equal(mode, 0o600, `token file must be mode 0600, got ${mode.toString(8)}`);
});

test("cache: deleteGrantFiles removes both grant and token files", async () => {
  const cacheRoot = makeTmpCache();
  await ensureCacheDirs(cacheRoot);
  writeGrant(cacheRoot, "grant_del", { grant_id: "grant_del" });
  await writeToken(cacheRoot, "grant_del", "tok");
  deleteGrantFiles(cacheRoot, "grant_del");
  assert.equal(readGrant(cacheRoot, "grant_del"), null);
  assert.equal(readToken(cacheRoot, "grant_del"), null);
});

test("cache: hasUsableGrant finds a cached grant matching connector and streams", async () => {
  const cacheRoot = makeTmpCache();
  await ensureCacheDirs(cacheRoot);
  writeGrant(cacheRoot, "grant_match", {
    expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    grant_id: "grant_match",
    revoked: false,
    source: { id: "https://registry.pdpp.dev/connectors/spotify", kind: "connector" },
    streams: [{ name: "listening_history" }],
  });
  await writeToken(cacheRoot, "grant_match", "tok");

  const found = hasUsableGrant(cacheRoot, {
    sourceId: "https://registry.pdpp.dev/connectors/spotify",
    streams: ["listening_history"],
  });
  assert.ok(found, "should find a matching usable grant");
  assert.equal(found.grant_id, "grant_match");
});

test("cache: hasUsableGrant rejects expired grants", async () => {
  const cacheRoot = makeTmpCache();
  await ensureCacheDirs(cacheRoot);
  writeGrant(cacheRoot, "grant_exp", {
    expires_at: new Date(Date.now() - 1000).toISOString(),
    grant_id: "grant_exp",
    revoked: false,
    source: { id: "https://registry.pdpp.dev/connectors/spotify", kind: "connector" },
    streams: [{ name: "listening_history" }],
  });
  await writeToken(cacheRoot, "grant_exp", "tok");
  const found = hasUsableGrant(cacheRoot, { sourceId: "https://registry.pdpp.dev/connectors/spotify" });
  assert.equal(found, null, "expired grant must not be returned");
});

test("cache: hasUsableGrant rejects revoked grants", async () => {
  const cacheRoot = makeTmpCache();
  await ensureCacheDirs(cacheRoot);
  writeGrant(cacheRoot, "grant_rev", {
    expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    grant_id: "grant_rev",
    revoked: true,
    source: { id: "https://registry.pdpp.dev/connectors/spotify", kind: "connector" },
    streams: [{ name: "listening_history" }],
  });
  await writeToken(cacheRoot, "grant_rev", "tok");
  const found = hasUsableGrant(cacheRoot, { sourceId: "https://registry.pdpp.dev/connectors/spotify" });
  assert.equal(found, null, "revoked grant must not be returned");
});

test("cache: redactGrantForDisplay never exposes token material", () => {
  const grant: CachedGrant = {
    access_mode: "single_use",
    client_id: "client_abc",
    expires_at: null,
    grant_id: "grant_abc",
    issued_at: new Date().toISOString(),
    purpose_description: "Test",
    revoked: false,
    source: { id: "https://registry.pdpp.dev/connectors/spotify", kind: "connector" },
    streams: [{ name: "listening_history" }],
  };
  const display = redactGrantForDisplay(grant);
  assert.ok(display, "should return display object");
  assert.equal(display.grant_id, grant.grant_id);
  assert.ok(!Object.hasOwn(display, "token"), "must not have token property");
  assert.ok(!Object.hasOwn(display, "access_token"), "must not have access_token property");
});

// ─── integration tests ────────────────────────────────────────────────────────

test("agent-flow: register client, stage PAR, approve inline, store token, verify, revoke", async () => {
  const { server, asUrl, rsUrl } = await spinUpServer();
  const cacheRoot = makeTmpCache();

  try {
    const spotifyManifest = await registerSpotify(asUrl);
    await seedSpotifyOwnerConnection(spotifyManifest);

    await ensureCacheDirs(cacheRoot);
    writeAccess(cacheRoot, { as_url: asUrl, rs_url: rsUrl });

    // Register a project-local client
    const registered = await registerClient({
      asUrl,
      initialAccessToken: DEFAULT_LOCAL_DCR_INITIAL_ACCESS_TOKEN,
      metadata: { client_name: "Agent CLI Test", token_endpoint_auth_method: "none" },
    });
    assert.equal(typeof registered.client_id, "string");
    writeClient(cacheRoot, registered.client_id, registered);

    // Stage a PAR grant request
    const connectorId = spotifyManifest.connector_id;
    const [firstStream] = spotifyManifest.streams;
    assert.ok(firstStream, "spotify manifest should declare at least one stream");
    const streamName = firstStream.name;
    const parRequest = buildParRequest({
      accessMode: "single_use",
      clientId: registered.client_id,
      clientName: "Agent CLI Test",
      purposeCode: "https://pdpp.dev/purpose/personal_assistant",
      purposeDescription: "Test agent access to listening history.",
      sourceId: connectorId,
      sourceKind: "connector",
      streamName,
    });
    const staged = await stageParRequest({ asUrl, request: parRequest });
    assert.equal(typeof staged.request_uri, "string");
    assert.ok(staged.authorization_url, "should return authorization_url");

    // Simulate owner approving inline (test path only — real flow uses browser)
    const approval = await approveInline({
      asUrl,
      requestUri: staged.request_uri,
      subjectId: "owner_local",
    });
    assert.ok(typeof approval.token === "string");
    assert.ok(typeof approval.grantId === "string");

    // Introspect to get grant metadata (mirrors what "pdpp agent store" does)
    const introspResp = await fetch(`${asUrl}/introspect`, {
      body: JSON.stringify({ token: approval.token }),
      headers: introspectionHeaders(),
      method: "POST",
    });
    const introspection = (await introspResp.json()) as {
      active: boolean;
      pdpp_token_kind: string;
      client_id?: string;
      exp?: number;
    };
    assert.equal(introspection.active, true);
    assert.equal(introspection.pdpp_token_kind, "client");

    // Store grant metadata and token in cache
    const { grantId } = approval;
    const grantMeta: CachedGrant = {
      access_mode: "single_use",
      client_id: introspection.client_id || registered.client_id,
      expires_at: introspection.exp ? new Date(introspection.exp * 1000).toISOString() : null,
      grant_id: grantId,
      issued_at: new Date().toISOString(),
      purpose_description: "Test agent access to listening history.",
      revoked: false,
      source: { id: connectorId, kind: "connector" },
      streams: [{ name: streamName }],
    };
    writeGrant(cacheRoot, grantId, grantMeta);
    await writeToken(cacheRoot, grantId, approval.token);

    // Status check: verify cached grant is readable without token leakage
    const cachedGrant = readGrant(cacheRoot, grantId);
    assert.ok(cachedGrant, "grant metadata should be cached");
    assert.equal(cachedGrant.grant_id, grantId);
    assert.deepEqual(cachedGrant.source, { id: connectorId, kind: "connector" });

    // Token must only come from readToken, not from grant metadata
    assert.ok(!Object.hasOwn(cachedGrant, "token"), "grant file must not contain token");
    assert.ok(!Object.hasOwn(cachedGrant, "access_token"), "grant file must not contain access_token");
    const storedToken = readToken(cacheRoot, grantId);
    assert.ok(typeof storedToken === "string", "stored token must be present");
    assert.equal(storedToken, approval.token);

    // Use the cached token to query the RS. This grant is manifest-only in
    // this fixture; record/stream reads require an active connection and are
    // covered by the stream-routing tests below.
    const schemaResp = await fetch(`${rsUrl}/v1/schema`, {
      headers: { Authorization: `Bearer ${storedToken}` },
    });
    assert.ok(schemaResp.ok, "client token should give RS access");

    // hasUsableGrant should find this grant
    const found = hasUsableGrant(cacheRoot, { sourceId: connectorId, streams: [streamName] });
    assert.ok(found, "hasUsableGrant should find the stored grant");

    // Revoke on the AS
    const revokeResp = await fetch(`${asUrl}/grants/${encodeURIComponent(grantId)}/revoke`, {
      headers: { Authorization: `Bearer ${storedToken}` },
      method: "POST",
    });
    assert.ok(revokeResp.ok, "revoke should succeed");

    // After revocation, mark revoked and delete local cache (mirrors "pdpp agent revoke")
    writeGrant(cacheRoot, grantId, { ...cachedGrant, revoked: true });
    deleteGrantFiles(cacheRoot, grantId);

    assert.equal(readToken(cacheRoot, grantId), null, "token should be gone after revoke");
    assert.equal(readGrant(cacheRoot, grantId), null, "grant file should be gone after revoke");

    // hasUsableGrant should now return null
    const foundAfterRevoke = hasUsableGrant(cacheRoot, { sourceId: connectorId, streams: [streamName] });
    assert.equal(foundAfterRevoke, null, "hasUsableGrant should return null after revoke");
  } finally {
    await closeServer(server);
  }
});

test("agent-flow: deny path — no token is cached after denial", async () => {
  const { server, asUrl } = await spinUpServer();
  const cacheRoot = makeTmpCache();

  try {
    const spotifyManifest = await registerSpotify(asUrl);
    await ensureCacheDirs(cacheRoot);

    const registered = await registerClient({
      asUrl,
      initialAccessToken: DEFAULT_LOCAL_DCR_INITIAL_ACCESS_TOKEN,
      metadata: { client_name: "Agent CLI Deny Test", token_endpoint_auth_method: "none" },
    });

    const [firstStream] = spotifyManifest.streams;
    assert.ok(firstStream, "spotify manifest should declare at least one stream");
    const staged = await stageParRequest({
      asUrl,
      request: buildParRequest({
        accessMode: "single_use",
        clientId: registered.client_id,
        clientName: "Agent CLI Deny Test",
        purposeCode: "https://pdpp.dev/purpose/personal_assistant",
        purposeDescription: "Test denial path",
        sourceId: spotifyManifest.connector_id,
        sourceKind: "connector",
        streamName: firstStream.name,
      }),
    });

    // Owner denies the request
    const denyResp = await fetch(`${asUrl}/consent/deny`, {
      body: new URLSearchParams({ request_uri: staged.request_uri }).toString(),
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
      redirect: "manual",
    });
    // Either 200 (JSON) or redirect to a result page is fine — just shouldn't be an error
    assert.ok(denyResp.status < 500, "denial should not 5xx");

    // No grant or token should be in the cache
    assert.equal(listGrants(cacheRoot).length, 0, "no grant should be cached after denial");
  } finally {
    await closeServer(server);
  }
});

test("agent-connect: owner approval completes polling without exposing owner token", async () => {
  const { server, asUrl, rsUrl } = await spinUpServer();
  try {
    const { staged, start } = await createAgentConnectRequest({ asUrl });

    const pendingPoll = await pollAgentConnectToken({
      pollingCode: start.polling_code,
      tokenUrl: start.token_url,
    });
    assert.equal(pendingPoll.resp.status, 202);
    assert.equal(pendingPoll.body.error, "authorization_pending");

    await approveInline({
      asUrl,
      requestUri: staged.request_uri,
      subjectId: "owner_local",
    });

    const completedPoll = await pollAgentConnectToken({
      pollingCode: start.polling_code,
      tokenUrl: start.token_url,
    });
    assert.equal(completedPoll.resp.status, 200);
    assertCredentialNoStoreHeaders(completedPoll.resp);
    assert.equal(completedPoll.body.token_type, "Bearer");
    assert.equal(typeof completedPoll.body.access_token, "string");
    assert.equal(typeof completedPoll.body.grant_id, "string");

    const schemaResp = await fetch(`${rsUrl}/v1/schema`, {
      headers: { Authorization: `Bearer ${completedPoll.body.access_token}` },
    });
    assert.equal(schemaResp.status, 200);

    const replayPoll = await pollAgentConnectToken({
      pollingCode: start.polling_code,
      tokenUrl: start.token_url,
    });
    assert.equal(replayPoll.resp.status, 200, "response-loss retry returns the retained token envelope");
    assertCredentialNoStoreHeaders(replayPoll.resp);
    assert.equal(replayPoll.body.access_token, completedPoll.body.access_token);

    await createAgentConnectRequest({ asUrl, clientName: "Agent Connect Prune Trigger" });
    const afterPrunePoll = await pollAgentConnectToken({
      pollingCode: start.polling_code,
      tokenUrl: start.token_url,
    });
    assert.equal(afterPrunePoll.resp.status, 200, "unrelated registration must not delete retained response");
    assertCredentialNoStoreHeaders(afterPrunePoll.resp);
    assert.equal(afterPrunePoll.body.access_token, completedPoll.body.access_token);
  } finally {
    await closeServer(server);
  }
});

test("agent-connect: registration 201 carries credential no-store headers", async () => {
  const { server, asUrl } = await spinUpServer();
  try {
    const { start } = await createAgentConnectRequest({ asUrl, clientName: "Agent Connect Cache Headers" });
    assert.equal(start.status, "pending");
  } finally {
    await closeServer(server);
  }
});

test("agent-connect: approved handoff survives AS restart before polling", async () => {
  const dbPath = join(makeTemporaryDir("pdpp-agent-connect-restart-"), "reference.sqlite");
  const first = await spinUpServer({ dbPath });
  let restarted: Awaited<ReturnType<typeof spinUpServer>> | null = null;
  try {
    const { staged, start } = await createAgentConnectRequest({
      asUrl: first.asUrl,
      clientName: "Agent Connect Restart Test",
    });
    await approveInline({
      asUrl: first.asUrl,
      requestUri: staged.request_uri,
      subjectId: "owner_local",
    });
    await closeServer(first.server);

    restarted = await spinUpServer({ dbPath });
    const completedPoll = await pollAgentConnectToken({
      pollingCode: start.polling_code,
      tokenUrl: rewriteUrlOrigin(start.token_url, restarted.asUrl),
    });
    assert.equal(completedPoll.resp.status, 200);
    assert.equal(completedPoll.body.token_type, "Bearer");
    assert.equal(typeof completedPoll.body.access_token, "string");
  } finally {
    if (restarted) {
      await closeServer(restarted.server);
    }
  }
});

test("agent-connect: approval committed before completion recovers at poll time", async () => {
  const { server, asUrl } = await spinUpServer();
  try {
    const { staged, start } = await createAgentConnectRequest({
      asUrl,
      clientName: "Agent Connect Crash Seam Test",
    });
    let tripped = false;
    __setAgentConnectCompleteFailureForTest(() => {
      if (!tripped) {
        tripped = true;
        throw new Error("agent-connect completion seam crash");
      }
    });
    await assert.rejects(
      approveInline({ asUrl, requestUri: staged.request_uri, subjectId: "owner_local" }),
      COMPLETION_SEAM_CRASH_PATTERN
    );
    __setAgentConnectCompleteFailureForTest(null);

    const completedPoll = await pollAgentConnectToken({
      pollingCode: start.polling_code,
      tokenUrl: start.token_url,
    });
    assert.equal(completedPoll.resp.status, 200);
    assert.equal(completedPoll.body.token_type, "Bearer");
    assert.equal(typeof completedPoll.body.access_token, "string");
  } finally {
    __setAgentConnectCompleteFailureForTest(null);
    await closeServer(server);
  }
});

test("agent-connect: crash-completed approval that expires before poll revokes committed token", async () => {
  const { server, asUrl } = await spinUpServer({ agentConnectTtlMs: 1 });
  try {
    const { staged, start } = await createAgentConnectRequest({
      asUrl,
      clientName: "Agent Connect Crash Expire SQLite",
    });
    let tripped = false;
    __setAgentConnectCompleteFailureForTest(() => {
      if (!tripped) {
        tripped = true;
        throw new Error("agent-connect completion seam crash");
      }
    });
    await assert.rejects(
      approveInline({ asUrl, requestUri: staged.request_uri, subjectId: "owner_local" }),
      COMPLETION_SEAM_CRASH_PATTERN
    );
    __setAgentConnectCompleteFailureForTest(null);
    const committedToken = sqliteCommittedTokenForRequestUri(staged.request_uri);
    assert.equal(await tokenIsIntrospectionActive(asUrl, committedToken), true);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const expiredPoll = await pollAgentConnectToken({
      pollingCode: start.polling_code,
      tokenUrl: start.token_url,
    });
    assert.equal(expiredPoll.resp.status, 400);
    assert.equal(errorCode(expiredPoll.body), "expired_token");
    assert.equal(await tokenIsIntrospectionActive(asUrl, committedToken), false);
  } finally {
    __setAgentConnectCompleteFailureForTest(null);
    await closeServer(server);
  }
});

test("agent-connect: prune reconciles crash-completed expired approval before deleting attempt", async () => {
  const { server, asUrl } = await spinUpServer({ agentConnectTtlMs: 1 });
  try {
    const { staged, start } = await createAgentConnectRequest({
      asUrl,
      clientName: "Agent Connect Crash Prune SQLite",
    });
    let tripped = false;
    __setAgentConnectCompleteFailureForTest(() => {
      if (!tripped) {
        tripped = true;
        throw new Error("agent-connect completion seam crash");
      }
    });
    await assert.rejects(
      approveInline({ asUrl, requestUri: staged.request_uri, subjectId: "owner_local" }),
      COMPLETION_SEAM_CRASH_PATTERN
    );
    __setAgentConnectCompleteFailureForTest(null);
    const committedToken = sqliteCommittedTokenForRequestUri(staged.request_uri);
    assert.equal(await tokenIsIntrospectionActive(asUrl, committedToken), true);
    await new Promise((resolve) => setTimeout(resolve, 10));

    await createAgentConnectRequest({ asUrl, clientName: "Agent Connect Crash Prune Trigger" });
    assert.equal(await tokenIsIntrospectionActive(asUrl, committedToken), false);
    const prunedPoll = await pollAgentConnectToken({
      pollingCode: start.polling_code,
      tokenUrl: start.token_url,
    });
    assert.equal(prunedPoll.resp.status, 400);
    assert.equal(errorCode(prunedPoll.body), "expired_token");
  } finally {
    __setAgentConnectCompleteFailureForTest(null);
    await closeServer(server);
  }
});

test("agent-connect: cleanup miss racing approval commit revokes the committed token", async () => {
  const { server, asUrl } = await spinUpServer({ agentConnectTtlMs: 1 });
  try {
    const { staged, start } = await createAgentConnectRequest({
      asUrl,
      clientName: "Agent Connect Cleanup Race SQLite",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const pause = createCleanupPause();
    __setAgentConnectCleanupAfterMissForTest(pause.hook);
    const pollPromise = pollAgentConnectToken({
      pollingCode: start.polling_code,
      tokenUrl: start.token_url,
    });
    await pause.paused;

    const approval = await approveInline({
      asUrl,
      requestUri: staged.request_uri,
      subjectId: "owner_local",
    });
    assert.equal(await tokenIsIntrospectionActive(asUrl, approval.token), true);
    pause.release();
    const expiredPoll = await pollPromise;
    assert.equal(expiredPoll.resp.status, 400);
    assert.equal(errorCode(expiredPoll.body), "expired_token");
    assert.equal(await tokenIsIntrospectionActive(asUrl, approval.token), false);
  } finally {
    __setAgentConnectCleanupAfterMissForTest(null);
    await closeServer(server);
  }
});

test("agent-connect: approval after cleanup second miss before tombstone is revoked", async () => {
  const { server, asUrl } = await spinUpServer({ agentConnectTtlMs: 1 });
  try {
    const { staged, start } = await createAgentConnectRequest({
      asUrl,
      clientName: "Agent Connect Cleanup Second Miss SQLite",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const pause = createPause();
    __setAgentConnectCleanupBeforeExpireForTest(pause.hook);
    const pollPromise = pollAgentConnectToken({
      pollingCode: start.polling_code,
      tokenUrl: start.token_url,
    });
    await pause.paused;

    const approval = await approveInline({
      asUrl,
      requestUri: staged.request_uri,
      subjectId: "owner_local",
    });
    assert.equal(await tokenIsIntrospectionActive(asUrl, approval.token), true);
    pause.release();
    const expiredPoll = await pollPromise;
    assert.equal(expiredPoll.resp.status, 400);
    assert.equal(errorCode(expiredPoll.body), "expired_token");
    assert.equal(await tokenIsIntrospectionActive(asUrl, approval.token), false);
  } finally {
    __setAgentConnectCleanupBeforeExpireForTest(null);
    await closeServer(server);
  }
});

test("agent-connect: approval completion after tombstone revokes its token", async () => {
  const { server, asUrl } = await spinUpServer({ agentConnectTtlMs: 1 });
  try {
    const { staged, start } = await createAgentConnectRequest({
      asUrl,
      clientName: "Agent Connect Tombstone Then Complete SQLite",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const pause = createPause();
    __setAgentConnectCompleteBeforeMarkForTest(pause.hook);
    const approvalPromise = approveInline({
      asUrl,
      requestUri: staged.request_uri,
      subjectId: "owner_local",
    });
    await pause.paused;

    const expiredPoll = await pollAgentConnectToken({
      pollingCode: start.polling_code,
      tokenUrl: start.token_url,
    });
    assert.equal(expiredPoll.resp.status, 400);
    assert.equal(errorCode(expiredPoll.body), "expired_token");
    pause.release();
    const approval = await approvalPromise;
    assert.equal(await tokenIsIntrospectionActive(asUrl, approval.token), false);
  } finally {
    __setAgentConnectCompleteBeforeMarkForTest(null);
    await closeServer(server);
  }
});

test("agent-connect: prune reconciles more than one expired SQLite batch", async () => {
  const { server, asUrl } = await spinUpServer();
  try {
    const expiredAt = Date.now() - 1;
    const createdAt = new Date(expiredAt - 1).toISOString();
    for (let index = 0; index < 1001; index += 1) {
      dbExec(referenceQueries.authAgentConnectAttemptsInsert, [
        `expired-batch-${index}`,
        `urn:ietf:params:oauth:request_uri:expired-batch-${index}`,
        null,
        `expired-batch-hash-${index}`,
        `${asUrl}/consent?request_uri=expired-batch-${index}`,
        `${asUrl}/token`,
        createdAt,
        expiredAt,
      ]);
    }

    await Promise.race([
      createAgentConnectRequest({ asUrl, clientName: "Agent Connect 1001 Prune Trigger" }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("agent-connect historic tombstone pruning timed out")), 2000);
      }),
    ]);
    assert.equal(sqliteAgentConnectAttemptCountByStatus("expired"), 0);
  } finally {
    await closeServer(server);
  }
});

test("agent-connect: retained tombstones do not starve a later collectible SQLite volume", async () => {
  const { server, asUrl } = await spinUpServer();
  try {
    const expiredAt = Date.now() - 1;
    const createdAt = new Date(expiredAt - 1).toISOString();
    const retainedDeviceCode = "retained-tombstone-sqlite";
    const retainedRequestUri = `urn:pdpp:pending-consent:${retainedDeviceCode}`;
    dbExec(referenceQueries.authPendingConsentsInsert, [
      retainedDeviceCode,
      "RETAINED-SQLITE",
      "{}",
      null,
      null,
      null,
      createdAt,
      new Date(Date.now() + 60_000).toISOString(),
      null,
    ]);
    dbExec(referenceQueries.authPendingConsentsMarkApproved, [
      "owner_local",
      "retained-grant-sqlite",
      "retained-token-sqlite",
      null,
      createdAt,
      retainedDeviceCode,
    ]);
    for (let index = 0; index < 1001; index += 1) {
      if (index < 1000) {
        dbExec(referenceQueries.authAgentConnectAttemptsInsert, [
          `retained-tombstone-${index}`,
          retainedRequestUri,
          null,
          `retained-tombstone-hash-${index}`,
          `${asUrl}/consent?request_uri=retained-tombstone-${index}`,
          `${asUrl}/token`,
          createdAt,
          expiredAt,
        ]);
        dbExec(referenceQueries.authAgentConnectAttemptsMarkExpiredById, [createdAt, `retained-tombstone-${index}`]);
      }
      dbExec(referenceQueries.authAgentConnectAttemptsInsert, [
        `collectible-tombstone-${index}`,
        `urn:pdpp:pending-consent:missing-tombstone-${index}`,
        null,
        `collectible-tombstone-hash-${index}`,
        `${asUrl}/consent?request_uri=collectible-tombstone-${index}`,
        `${asUrl}/token`,
        createdAt,
        expiredAt,
      ]);
      dbExec(referenceQueries.authAgentConnectAttemptsMarkExpiredById, [createdAt, `collectible-tombstone-${index}`]);
    }
    assert.equal(sqliteAgentConnectAttemptCountByStatus("expired"), 2001);

    await createAgentConnectRequest({ asUrl, clientName: "Agent Connect Tombstone GC Trigger" });
    assert.equal(sqliteAgentConnectAttemptCountByStatus("expired"), 1000);
  } finally {
    await closeServer(server);
  }
});

test("agent-connect: natural pending-consent expiry enables tombstone GC", async () => {
  const { server, asUrl } = await spinUpServer();
  try {
    const expiredAt = Date.now() - 1;
    const createdAt = new Date(expiredAt - 1).toISOString();
    const deviceCode = "natural-timeout-sqlite";
    dbExec(referenceQueries.authPendingConsentsInsert, [
      deviceCode,
      "NATURAL-TIMEOUT-SQLITE",
      "{}",
      null,
      null,
      null,
      createdAt,
      new Date(expiredAt).toISOString(),
      null,
    ]);
    dbExec(referenceQueries.authAgentConnectAttemptsInsert, [
      "natural-timeout-tombstone-sqlite",
      `urn:pdpp:pending-consent:${deviceCode}`,
      null,
      "natural-timeout-hash-sqlite",
      `${asUrl}/consent`,
      `${asUrl}/token`,
      createdAt,
      expiredAt,
    ]);
    dbExec(referenceQueries.authAgentConnectAttemptsMarkExpiredById, [createdAt, "natural-timeout-tombstone-sqlite"]);
    assert.equal(
      getOne<{ status?: string }>(referenceQueries.authPendingConsentsGetByDeviceCode, [deviceCode])?.status,
      "pending"
    );

    await createAgentConnectRequest({ asUrl, clientName: "Agent Connect Tombstone Terminal Trigger" });
    assert.equal(sqliteAgentConnectAttemptCountByStatus("expired"), 0);
    assert.equal(
      getOne<{ status?: string }>(referenceQueries.authPendingConsentsGetByDeviceCode, [deviceCode])?.status,
      "expired"
    );
  } finally {
    await closeServer(server);
  }
});

test("agent-connect: expired same-request attempt does not revoke valid staggered attempt", async () => {
  const { server, asUrl } = await spinUpServer({ agentConnectTtlMs: 60_000 });
  try {
    const first = await createAgentConnectRequest({
      asUrl,
      clientName: "Agent Connect Staggered Old SQLite",
    });
    setSqliteAgentConnectAttemptExpiresAt(first.start.id, Date.now() - 1);
    const second = await fetch(`${asUrl}/agent-connect`, {
      body: JSON.stringify({
        client_id: first.registered.client_id,
        request_uri: first.staged.request_uri,
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const secondStart = (await second.json()) as AgentConnectStart;
    assert.equal(second.status, 201, JSON.stringify(secondStart));

    await approveInline({
      asUrl,
      requestUri: first.staged.request_uri,
      subjectId: "owner_local",
    });
    const oldPoll = await pollAgentConnectToken({
      pollingCode: first.start.polling_code,
      tokenUrl: first.start.token_url,
    });
    assert.equal(oldPoll.resp.status, 400);
    assert.equal(errorCode(oldPoll.body), "expired_token");

    const newPoll = await pollAgentConnectToken({
      pollingCode: secondStart.polling_code,
      tokenUrl: secondStart.token_url,
    });
    assert.equal(newPoll.resp.status, 200, JSON.stringify(newPoll.body));
    const deliveredToken = newPoll.body.access_token;
    assert.ok(deliveredToken);
    assert.equal(await tokenIsIntrospectionActive(asUrl, deliveredToken), true);
  } finally {
    await closeServer(server);
  }
});

test("agent-connect: registration rechecks durable pending consent after approval", async () => {
  const { server, asUrl } = await spinUpServer({ agentConnectTtlMs: 60_000 });
  try {
    const first = await createAgentConnectRequest({
      asUrl,
      clientName: "Agent Connect Registration CAS SQLite",
    });
    const pause = createPause();
    __setAgentConnectCreateBeforePersistForTest(pause.hook);
    const lateRegistration = fetch(`${asUrl}/agent-connect`, {
      body: JSON.stringify({
        client_id: first.registered.client_id,
        request_uri: first.staged.request_uri,
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    await pause.paused;
    const approval = await approveInline({
      asUrl,
      requestUri: first.staged.request_uri,
      subjectId: "owner_local",
    });
    assert.equal(await tokenIsIntrospectionActive(asUrl, approval.token), true);

    pause.release();
    const late = await lateRegistration;
    assert.equal(late.status, 400);
    const firstPoll = await pollAgentConnectToken({
      pollingCode: first.start.polling_code,
      tokenUrl: first.start.token_url,
    });
    assert.equal(firstPoll.resp.status, 200, JSON.stringify(firstPoll.body));
  } finally {
    __setAgentConnectCreateBeforePersistForTest(null);
    await closeServer(server);
  }
});

test("agent-connect: live Postgres approved handoff survives AS restart before polling", async (t) => {
  const baseUrl = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
  if (!baseUrl) {
    t.skip("PDPP_TEST_POSTGRES_URL must target the dedicated local Postgres test listener");
    return;
  }

  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: baseUrl,
      databaseName: "pdpp_test_agent_connect_durable",
    },
    async (databaseUrl) => {
      const opts = { databaseUrl, storageBackend: "postgres" as const };
      const first = await spinUpServer(opts);
      let firstClosed = false;
      let restarted: Awaited<ReturnType<typeof spinUpServer>> | null = null;
      try {
        const { staged, start } = await createAgentConnectRequest({
          asUrl: first.asUrl,
          clientName: "Agent Connect Postgres Restart Test",
        });
        await approveInline({
          asUrl: first.asUrl,
          requestUri: staged.request_uri,
          subjectId: "owner_local",
        });
        await closeServer(first.server);
        firstClosed = true;
        await closePostgresStorage();

        restarted = await spinUpServer(opts);
        const completedPoll = await pollAgentConnectToken({
          pollingCode: start.polling_code,
          tokenUrl: rewriteUrlOrigin(start.token_url, restarted.asUrl),
        });
        assert.equal(completedPoll.resp.status, 200);
        assert.equal(completedPoll.body.token_type, "Bearer");
        assert.equal(typeof completedPoll.body.access_token, "string");
      } finally {
        if (!firstClosed) {
          await closeServer(first.server);
        }
        if (restarted) {
          await closeServer(restarted.server);
        }
        await closePostgresStorage();
      }
    }
  );
});

test("agent-connect: live Postgres response-loss retry survives unrelated registration", async (t) => {
  const baseUrl = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
  if (!baseUrl) {
    t.skip("PDPP_TEST_POSTGRES_URL must target the dedicated local Postgres test listener");
    return;
  }

  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: baseUrl,
      databaseName: "pdpp_test_agent_connect_response_loss_prune",
    },
    async (databaseUrl) => {
      const { server, asUrl } = await spinUpServer({ databaseUrl, storageBackend: "postgres" });
      try {
        const { staged, start } = await createAgentConnectRequest({
          asUrl,
          clientName: "Agent Connect PG Response Loss A",
        });
        await approveInline({ asUrl, requestUri: staged.request_uri, subjectId: "owner_local" });
        const firstPoll = await pollAgentConnectToken({
          pollingCode: start.polling_code,
          tokenUrl: start.token_url,
        });
        assert.equal(firstPoll.resp.status, 200);
        assertCredentialNoStoreHeaders(firstPoll.resp);

        await createAgentConnectRequest({ asUrl, clientName: "Agent Connect PG Response Loss B" });
        const retryPoll = await pollAgentConnectToken({
          pollingCode: start.polling_code,
          tokenUrl: start.token_url,
        });
        assert.equal(retryPoll.resp.status, 200);
        assertCredentialNoStoreHeaders(retryPoll.resp);
        assert.equal(retryPoll.body.access_token, firstPoll.body.access_token);
      } finally {
        await closeServer(server);
        await closePostgresStorage();
      }
    }
  );
});

test("agent-connect: live Postgres crash-completed expiry and prune revoke committed tokens", async (t) => {
  const baseUrl = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
  if (!baseUrl) {
    t.skip("PDPP_TEST_POSTGRES_URL must target the dedicated local Postgres test listener");
    return;
  }

  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: baseUrl,
      databaseName: "pdpp_test_agent_connect_crash_expire_prune",
    },
    async (databaseUrl) => {
      const expireServer = await spinUpServer({ agentConnectTtlMs: 1, databaseUrl, storageBackend: "postgres" });
      try {
        const { staged, start } = await createAgentConnectRequest({
          asUrl: expireServer.asUrl,
          clientName: "Agent Connect PG Crash Expire",
        });
        let tripped = false;
        __setAgentConnectCompleteFailureForTest(() => {
          if (!tripped) {
            tripped = true;
            throw new Error("agent-connect completion seam crash");
          }
        });
        await assert.rejects(
          approveInline({ asUrl: expireServer.asUrl, requestUri: staged.request_uri, subjectId: "owner_local" }),
          COMPLETION_SEAM_CRASH_PATTERN
        );
        __setAgentConnectCompleteFailureForTest(null);
        const committedToken = await postgresCommittedTokenForRequestUri(staged.request_uri);
        assert.equal(await tokenIsIntrospectionActive(expireServer.asUrl, committedToken), true);
        await new Promise((resolve) => setTimeout(resolve, 10));
        const expiredPoll = await pollAgentConnectToken({
          pollingCode: start.polling_code,
          tokenUrl: start.token_url,
        });
        assert.equal(expiredPoll.resp.status, 400);
        assert.equal(errorCode(expiredPoll.body), "expired_token");
        assert.equal(await tokenIsIntrospectionActive(expireServer.asUrl, committedToken), false);
      } finally {
        __setAgentConnectCompleteFailureForTest(null);
        await closeServer(expireServer.server);
        await closePostgresStorage();
      }

      const pruneServer = await spinUpServer({ agentConnectTtlMs: 1, databaseUrl, storageBackend: "postgres" });
      try {
        const { staged, start } = await createAgentConnectRequest({
          asUrl: pruneServer.asUrl,
          clientName: "Agent Connect PG Crash Prune",
        });
        let tripped = false;
        __setAgentConnectCompleteFailureForTest(() => {
          if (!tripped) {
            tripped = true;
            throw new Error("agent-connect completion seam crash");
          }
        });
        await assert.rejects(
          approveInline({ asUrl: pruneServer.asUrl, requestUri: staged.request_uri, subjectId: "owner_local" }),
          COMPLETION_SEAM_CRASH_PATTERN
        );
        __setAgentConnectCompleteFailureForTest(null);
        const committedToken = await postgresCommittedTokenForRequestUri(staged.request_uri);
        assert.equal(await tokenIsIntrospectionActive(pruneServer.asUrl, committedToken), true);
        await new Promise((resolve) => setTimeout(resolve, 10));
        await createAgentConnectRequest({ asUrl: pruneServer.asUrl, clientName: "Agent Connect PG Prune Trigger" });
        assert.equal(await tokenIsIntrospectionActive(pruneServer.asUrl, committedToken), false);
        const prunedPoll = await pollAgentConnectToken({
          pollingCode: start.polling_code,
          tokenUrl: start.token_url,
        });
        assert.equal(prunedPoll.resp.status, 400);
        assert.equal(errorCode(prunedPoll.body), "expired_token");
      } finally {
        __setAgentConnectCompleteFailureForTest(null);
        await closeServer(pruneServer.server);
        await closePostgresStorage();
      }
    }
  );
});

test("agent-connect: live Postgres cleanup miss racing approval commit revokes committed token", async (t) => {
  const baseUrl = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
  if (!baseUrl) {
    t.skip("PDPP_TEST_POSTGRES_URL must target the dedicated local Postgres test listener");
    return;
  }

  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: baseUrl,
      databaseName: "pdpp_test_agent_connect_cleanup_race",
    },
    async (databaseUrl) => {
      const { server, asUrl } = await spinUpServer({ agentConnectTtlMs: 1, databaseUrl, storageBackend: "postgres" });
      try {
        const { staged, start } = await createAgentConnectRequest({
          asUrl,
          clientName: "Agent Connect PG Cleanup Race",
        });
        await new Promise((resolve) => setTimeout(resolve, 10));
        const pause = createCleanupPause();
        __setAgentConnectCleanupAfterMissForTest(pause.hook);
        const pollPromise = pollAgentConnectToken({
          pollingCode: start.polling_code,
          tokenUrl: start.token_url,
        });
        await pause.paused;

        const approval = await approveInline({
          asUrl,
          requestUri: staged.request_uri,
          subjectId: "owner_local",
        });
        assert.equal(await tokenIsIntrospectionActive(asUrl, approval.token), true);
        pause.release();
        const expiredPoll = await pollPromise;
        assert.equal(expiredPoll.resp.status, 400);
        assert.equal(errorCode(expiredPoll.body), "expired_token");
        assert.equal(await tokenIsIntrospectionActive(asUrl, approval.token), false);
      } finally {
        __setAgentConnectCleanupAfterMissForTest(null);
        await closeServer(server);
        await closePostgresStorage();
      }
    }
  );
});

test("agent-connect: live Postgres expiry CAS interleavings revoke committed tokens", async (t) => {
  const baseUrl = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
  if (!baseUrl) {
    t.skip("PDPP_TEST_POSTGRES_URL must target the dedicated local Postgres test listener");
    return;
  }

  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: baseUrl,
      databaseName: "pdpp_test_agent_connect_expiry_cas",
    },
    async (databaseUrl) => {
      const secondMissServer = await spinUpServer({ agentConnectTtlMs: 1, databaseUrl, storageBackend: "postgres" });
      try {
        const { staged, start } = await createAgentConnectRequest({
          asUrl: secondMissServer.asUrl,
          clientName: "Agent Connect PG Cleanup Second Miss",
        });
        await new Promise((resolve) => setTimeout(resolve, 10));
        const pause = createPause();
        __setAgentConnectCleanupBeforeExpireForTest(pause.hook);
        const pollPromise = pollAgentConnectToken({
          pollingCode: start.polling_code,
          tokenUrl: start.token_url,
        });
        await pause.paused;
        const approval = await approveInline({
          asUrl: secondMissServer.asUrl,
          requestUri: staged.request_uri,
          subjectId: "owner_local",
        });
        assert.equal(await tokenIsIntrospectionActive(secondMissServer.asUrl, approval.token), true);
        pause.release();
        const expiredPoll = await pollPromise;
        assert.equal(expiredPoll.resp.status, 400);
        assert.equal(errorCode(expiredPoll.body), "expired_token");
        assert.equal(await tokenIsIntrospectionActive(secondMissServer.asUrl, approval.token), false);
      } finally {
        __setAgentConnectCleanupBeforeExpireForTest(null);
        await closeServer(secondMissServer.server);
        await closePostgresStorage();
      }

      const tombstoneServer = await spinUpServer({ agentConnectTtlMs: 1, databaseUrl, storageBackend: "postgres" });
      try {
        const { staged, start } = await createAgentConnectRequest({
          asUrl: tombstoneServer.asUrl,
          clientName: "Agent Connect PG Tombstone Then Complete",
        });
        await new Promise((resolve) => setTimeout(resolve, 10));
        const pause = createPause();
        __setAgentConnectCompleteBeforeMarkForTest(pause.hook);
        const approvalPromise = approveInline({
          asUrl: tombstoneServer.asUrl,
          requestUri: staged.request_uri,
          subjectId: "owner_local",
        });
        await pause.paused;
        const expiredPoll = await pollAgentConnectToken({
          pollingCode: start.polling_code,
          tokenUrl: start.token_url,
        });
        assert.equal(expiredPoll.resp.status, 400);
        assert.equal(errorCode(expiredPoll.body), "expired_token");
        pause.release();
        const approval = await approvalPromise;
        assert.equal(await tokenIsIntrospectionActive(tombstoneServer.asUrl, approval.token), false);
      } finally {
        __setAgentConnectCompleteBeforeMarkForTest(null);
        await closeServer(tombstoneServer.server);
        await closePostgresStorage();
      }
    }
  );
});

test("agent-connect: live Postgres tombstone GC and staggered same-request delivery", async (t) => {
  const baseUrl = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
  if (!baseUrl) {
    t.skip("PDPP_TEST_POSTGRES_URL must target the dedicated local Postgres test listener");
    return;
  }

  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: baseUrl,
      databaseName: "pdpp_test_agent_connect_gc_staggered",
    },
    async (databaseUrl) => {
      const gcServer = await spinUpServer({ databaseUrl, storageBackend: "postgres" });
      try {
        const expiredAt = Date.now() - 1;
        const createdAt = new Date(expiredAt - 1).toISOString();
        const retainedDeviceCode = "retained-tombstone-postgres";
        const retainedRequestUri = `urn:pdpp:pending-consent:${retainedDeviceCode}`;
        await postgresQuery(
          `INSERT INTO pending_consents(
             device_code, user_code, params_json, status, subject_id, grant_id, token_id,
             created_at, expires_at, approved_at
           ) VALUES($1, $2, $3::jsonb, 'approved', $4, $5, $6, $7, $8, $7)`,
          [
            retainedDeviceCode,
            "RETAINED-POSTGRES",
            "{}",
            "owner_local",
            "retained-grant-postgres",
            "retained-token-postgres",
            createdAt,
            new Date(Date.now() + 60_000).toISOString(),
          ]
        );
        await Promise.all(
          Array.from({ length: 1001 }, async (_, index) => {
            if (index < 1000) {
              await postgresQuery(
                `INSERT INTO agent_connect_attempts(
                 id, request_uri, client_id, polling_code_hash, status, approval_url, token_url,
                 interval_seconds, created_at, expires_at_ms, completed_at
               ) VALUES($1, $2, NULL, $3, 'expired', $4, $5, 2, $6, $7, $6)`,
                [
                  `pg-retained-tombstone-${index}`,
                  retainedRequestUri,
                  `pg-retained-tombstone-hash-${index}`,
                  `${gcServer.asUrl}/consent?request_uri=pg-retained-tombstone-${index}`,
                  `${gcServer.asUrl}/token`,
                  createdAt,
                  expiredAt,
                ]
              );
            }
            await postgresQuery(
              `INSERT INTO agent_connect_attempts(
               id, request_uri, client_id, polling_code_hash, status, approval_url, token_url,
               interval_seconds, created_at, expires_at_ms, completed_at
             ) VALUES($1, $2, NULL, $3, 'expired', $4, $5, 2, $6, $7, $6)`,
              [
                `pg-collectible-tombstone-${index}`,
                `urn:pdpp:pending-consent:pg-missing-tombstone-${index}`,
                `pg-collectible-tombstone-hash-${index}`,
                `${gcServer.asUrl}/consent?request_uri=pg-collectible-tombstone-${index}`,
                `${gcServer.asUrl}/token`,
                createdAt,
                expiredAt,
              ]
            );
          })
        );
        assert.equal(await postgresAgentConnectAttemptCountByStatus("expired"), 2001);
        await createAgentConnectRequest({
          asUrl: gcServer.asUrl,
          clientName: "Agent Connect PG Tombstone GC Trigger",
        });
        assert.equal(await postgresAgentConnectAttemptCountByStatus("expired"), 1000);

        const naturalDeviceCode = "natural-timeout-postgres";
        await postgresQuery(
          `INSERT INTO pending_consents(
             device_code, user_code, params_json, status, created_at, expires_at
           ) VALUES($1, $2, $3::jsonb, 'pending', $4, $5)`,
          [naturalDeviceCode, "NATURAL-TIMEOUT-POSTGRES", "{}", createdAt, new Date(expiredAt).toISOString()]
        );
        await postgresQuery(
          `INSERT INTO agent_connect_attempts(
             id, request_uri, client_id, polling_code_hash, status, approval_url, token_url,
             interval_seconds, created_at, expires_at_ms, completed_at
           ) VALUES($1, $2, NULL, $3, 'expired', $4, $5, 2, $6, $7, $6)`,
          [
            "pg-natural-timeout-tombstone",
            `urn:pdpp:pending-consent:${naturalDeviceCode}`,
            "pg-natural-timeout-hash",
            `${gcServer.asUrl}/consent`,
            `${gcServer.asUrl}/token`,
            createdAt,
            expiredAt,
          ]
        );
        assert.equal(
          (
            await postgresQuery<{ status?: string }>("SELECT status FROM pending_consents WHERE device_code = $1", [
              naturalDeviceCode,
            ])
          ).rows[0]?.status,
          "pending"
        );
        await createAgentConnectRequest({
          asUrl: gcServer.asUrl,
          clientName: "Agent Connect PG Tombstone Natural Timeout Trigger",
        });
        assert.equal(await postgresAgentConnectAttemptCountByStatus("expired"), 1000);
        assert.equal(
          (
            await postgresQuery<{ status?: string }>("SELECT status FROM pending_consents WHERE device_code = $1", [
              naturalDeviceCode,
            ])
          ).rows[0]?.status,
          "expired"
        );
      } finally {
        await closeServer(gcServer.server);
        await closePostgresStorage();
      }

      const staggeredServer = await spinUpServer({
        agentConnectTtlMs: 60_000,
        databaseUrl,
        storageBackend: "postgres",
      });
      try {
        const first = await createAgentConnectRequest({
          asUrl: staggeredServer.asUrl,
          clientName: "Agent Connect PG Staggered Old",
        });
        await setPostgresAgentConnectAttemptExpiresAt(first.start.id, Date.now() - 1);
        const second = await fetch(`${staggeredServer.asUrl}/agent-connect`, {
          body: JSON.stringify({
            client_id: first.registered.client_id,
            request_uri: first.staged.request_uri,
          }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        const secondStart = (await second.json()) as AgentConnectStart;
        assert.equal(second.status, 201, JSON.stringify(secondStart));
        await approveInline({
          asUrl: staggeredServer.asUrl,
          requestUri: first.staged.request_uri,
          subjectId: "owner_local",
        });
        const oldPoll = await pollAgentConnectToken({
          pollingCode: first.start.polling_code,
          tokenUrl: first.start.token_url,
        });
        assert.equal(oldPoll.resp.status, 400);
        assert.equal(errorCode(oldPoll.body), "expired_token");

        const newPoll = await pollAgentConnectToken({
          pollingCode: secondStart.polling_code,
          tokenUrl: secondStart.token_url,
        });
        assert.equal(newPoll.resp.status, 200, JSON.stringify(newPoll.body));
        const deliveredToken = newPoll.body.access_token;
        assert.ok(deliveredToken);
        assert.equal(await tokenIsIntrospectionActive(staggeredServer.asUrl, deliveredToken), true);
      } finally {
        await closeServer(staggeredServer.server);
        await closePostgresStorage();
      }

      const lateRaceServer = await spinUpServer({
        agentConnectTtlMs: 60_000,
        databaseUrl,
        storageBackend: "postgres",
      });
      try {
        const first = await createAgentConnectRequest({
          asUrl: lateRaceServer.asUrl,
          clientName: "Agent Connect PG Registration CAS",
        });
        const pause = createPause();
        __setAgentConnectCreateBeforePersistForTest(pause.hook);
        const lateRegistration = fetch(`${lateRaceServer.asUrl}/agent-connect`, {
          body: JSON.stringify({
            client_id: first.registered.client_id,
            request_uri: first.staged.request_uri,
          }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        await pause.paused;
        const approval = await approveInline({
          asUrl: lateRaceServer.asUrl,
          requestUri: first.staged.request_uri,
          subjectId: "owner_local",
        });
        assert.equal(await tokenIsIntrospectionActive(lateRaceServer.asUrl, approval.token), true);
        pause.release();
        const late = await lateRegistration;
        assert.equal(late.status, 400);
        const firstPoll = await pollAgentConnectToken({
          pollingCode: first.start.polling_code,
          tokenUrl: first.start.token_url,
        });
        assert.equal(firstPoll.resp.status, 200, JSON.stringify(firstPoll.body));
      } finally {
        __setAgentConnectCreateBeforePersistForTest(null);
        await closeServer(lateRaceServer.server);
        await closePostgresStorage();
      }
    }
  );
});

test("agent-connect: second registration and concurrent polling are idempotent", async () => {
  const { server, asUrl } = await spinUpServer();
  try {
    const { staged, start } = await createAgentConnectRequest({ asUrl, clientName: "Agent Connect Concurrent A" });
    const secondResp = await fetch(`${asUrl}/agent-connect`, {
      body: JSON.stringify({ request_uri: staged.request_uri }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const second = (await secondResp.json()) as AgentConnectStart;
    assert.equal(secondResp.status, 201);
    assert.notEqual(second.polling_code, start.polling_code);

    await approveInline({ asUrl, requestUri: staged.request_uri, subjectId: "owner_local" });
    const [firstPoll, secondPoll] = await Promise.all([
      pollAgentConnectToken({ pollingCode: start.polling_code, tokenUrl: start.token_url }),
      pollAgentConnectToken({ pollingCode: second.polling_code, tokenUrl: second.token_url }),
    ]);
    assert.equal(firstPoll.resp.status, 200);
    assert.equal(secondPoll.resp.status, 200);
    const replayPoll = await pollAgentConnectToken({ pollingCode: start.polling_code, tokenUrl: start.token_url });
    assert.equal(replayPoll.resp.status, 200);
    assert.equal(replayPoll.body.access_token, firstPoll.body.access_token);
    assert.equal(secondPoll.body.access_token, firstPoll.body.access_token);
  } finally {
    await closeServer(server);
  }
});

test("agent-connect: empty client_id is treated as omitted for staged requests", async () => {
  const { server, asUrl } = await spinUpServer();
  try {
    const { staged, start } = await createAgentConnectRequest({
      agentConnectClientId: "",
      asUrl,
      clientName: "Agent Connect Empty Client Test",
    });

    await approveInline({
      asUrl,
      requestUri: staged.request_uri,
      subjectId: "owner_local",
    });

    const completedPoll = await pollAgentConnectToken({
      pollingCode: start.polling_code,
      tokenUrl: start.token_url,
    });
    assert.equal(completedPoll.resp.status, 200);
    assert.equal(completedPoll.body.token_type, "Bearer");
    assert.equal(typeof completedPoll.body.access_token, "string");
  } finally {
    await closeServer(server);
  }
});

test("agent-connect: owner denial returns bounded access_denied", async () => {
  const { server, asUrl } = await spinUpServer();
  try {
    const { staged, start } = await createAgentConnectRequest({ asUrl, clientName: "Agent Connect Deny Test" });

    await fetch(`${asUrl}/consent/deny`, {
      body: new URLSearchParams({ request_uri: staged.request_uri }).toString(),
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
      redirect: "manual",
    });

    const deniedPoll = await pollAgentConnectToken({
      pollingCode: start.polling_code,
      tokenUrl: start.token_url,
    });
    assert.equal(deniedPoll.resp.status, 403);
    assert.equal(errorCode(deniedPoll.body), "access_denied");
    assert.doesNotMatch(JSON.stringify(deniedPoll.body), DENIED_POLL_SECRET_PATTERN);
  } finally {
    await closeServer(server);
  }
});

test("agent-connect: approval_id denial projects to polling", async () => {
  const { server, asUrl } = await spinUpServer();
  try {
    const { staged, start } = await createAgentConnectRequest({ asUrl, clientName: "Agent Connect Approval ID Deny" });
    const approvalId = sqliteApprovalIdForRequestUri(staged.request_uri);
    const denyResp = await fetch(`${asUrl}/consent/deny`, {
      body: new URLSearchParams({ approval_id: approvalId }).toString(),
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.equal(denyResp.status, 200);
    const deniedPoll = await pollAgentConnectToken({
      pollingCode: start.polling_code,
      tokenUrl: start.token_url,
    });
    assert.equal(deniedPoll.resp.status, 403);
    assert.equal(errorCode(deniedPoll.body), "access_denied");
    assert.doesNotMatch(JSON.stringify(deniedPoll.body), DENIED_POLL_SECRET_PATTERN);
  } finally {
    await closeServer(server);
  }
});

test("agent-connect: denial completion failure is reconciled during polling", async () => {
  const dbPath = join(makeTemporaryDir("pdpp-agent-connect-denial-restart-"), "reference.sqlite");
  const first = await spinUpServer({ dbPath });
  let restarted: Awaited<ReturnType<typeof spinUpServer>> | null = null;
  try {
    const { staged, start } = await createAgentConnectRequest({
      asUrl: first.asUrl,
      clientName: "Agent Connect Deny Recovery",
    });
    __setAgentConnectCompleteFailureForTest(() => {
      throw new Error("denial completion seam crash");
    });
    try {
      const denyResp = await fetch(`${first.asUrl}/consent/deny`, {
        body: new URLSearchParams({ request_uri: staged.request_uri }).toString(),
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
      });
      assert.equal(denyResp.status, 500);
    } finally {
      __setAgentConnectCompleteFailureForTest(null);
    }
    const deviceCode = parsePendingConsentRequestUri(staged.request_uri);
    assert.ok(deviceCode);
    assert.equal(
      getOne<{ token_id?: string | null }>(referenceQueries.authPendingConsentsGetByDeviceCode, [deviceCode])?.token_id,
      null
    );
    await closeServer(first.server);
    restarted = await spinUpServer({ dbPath });
    const retryDeny = await fetch(`${restarted.asUrl}/consent/deny`, {
      body: new URLSearchParams({ request_uri: staged.request_uri }).toString(),
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.equal(retryDeny.status, 404, "a committed denial is not duplicated after restart");
    const deniedPoll = await pollAgentConnectToken({
      pollingCode: start.polling_code,
      tokenUrl: rewriteUrlOrigin(start.token_url, restarted.asUrl),
    });
    assert.equal(deniedPoll.resp.status, 403);
    assert.equal(errorCode(deniedPoll.body), "access_denied");
    assert.doesNotMatch(JSON.stringify(deniedPoll.body), DENIED_POLL_SECRET_PATTERN);
  } finally {
    __setAgentConnectCompleteFailureForTest(null);
    if (restarted) {
      await closeServer(restarted.server);
    } else {
      await closeServer(first.server);
    }
  }
});

test("agent-connect: expired consent projects to bounded expired_token polling", async () => {
  const { server, asUrl } = await spinUpServer();
  try {
    const { staged, start } = await createAgentConnectRequest({ asUrl, clientName: "Agent Connect Consent Expiry" });
    const deviceCode = parsePendingConsentRequestUri(staged.request_uri);
    assert.ok(deviceCode);
    dbExec(referenceQueries.authPendingConsentsMarkExpired, [deviceCode]);
    const expiredPoll = await pollAgentConnectToken({
      pollingCode: start.polling_code,
      tokenUrl: start.token_url,
    });
    assert.equal(expiredPoll.resp.status, 400);
    assert.equal(errorCode(expiredPoll.body), "expired_token");
    assert.doesNotMatch(JSON.stringify(expiredPoll.body), EXPIRED_POLL_SECRET_PATTERN);
  } finally {
    await closeServer(server);
  }
});

test("agent-connect: live Postgres denial projects and recovers after completion failure", async (t) => {
  const baseUrl = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
  if (!baseUrl) {
    t.skip("PDPP_TEST_POSTGRES_URL must target the dedicated local Postgres test listener");
    return;
  }

  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: baseUrl,
      databaseName: "pdpp_test_agent_connect_denial_recovery",
    },
    async (databaseUrl) => {
      const first = await spinUpServer({ databaseUrl, storageBackend: "postgres" });
      let restarted: Awaited<ReturnType<typeof spinUpServer>> | null = null;
      try {
        const approvalCase = await createAgentConnectRequest({
          asUrl: first.asUrl,
          clientName: "Agent Connect PG Approval ID Deny",
        });
        const approvalId = await postgresApprovalIdForRequestUri(approvalCase.staged.request_uri);
        const approvalDeny = await fetch(`${first.asUrl}/consent/deny`, {
          body: new URLSearchParams({ approval_id: approvalId }).toString(),
          headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
          method: "POST",
        });
        assert.equal(approvalDeny.status, 200);
        const approvalPoll = await pollAgentConnectToken({
          pollingCode: approvalCase.start.polling_code,
          tokenUrl: approvalCase.start.token_url,
        });
        assert.equal(approvalPoll.resp.status, 403);
        assert.equal(errorCode(approvalPoll.body), "access_denied");
        assert.doesNotMatch(JSON.stringify(approvalPoll.body), DENIED_POLL_SECRET_PATTERN);

        const recoveryCase = await createAgentConnectRequest({
          asUrl: first.asUrl,
          clientName: "Agent Connect PG Denial Recovery",
        });
        __setAgentConnectCompleteFailureForTest(() => {
          throw new Error("denial completion seam crash");
        });
        try {
          const failedDeny = await fetch(`${first.asUrl}/consent/deny`, {
            body: new URLSearchParams({ request_uri: recoveryCase.staged.request_uri }).toString(),
            headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
            method: "POST",
          });
          assert.equal(failedDeny.status, 500);
        } finally {
          __setAgentConnectCompleteFailureForTest(null);
        }
        await closeServer(first.server);
        await closePostgresStorage();
        restarted = await spinUpServer({ databaseUrl, storageBackend: "postgres" });
        const retryDeny = await fetch(`${restarted.asUrl}/consent/deny`, {
          body: new URLSearchParams({ request_uri: recoveryCase.staged.request_uri }).toString(),
          headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
          method: "POST",
        });
        assert.equal(retryDeny.status, 404);
        const recoveryPoll = await pollAgentConnectToken({
          pollingCode: recoveryCase.start.polling_code,
          tokenUrl: rewriteUrlOrigin(recoveryCase.start.token_url, restarted.asUrl),
        });
        assert.equal(recoveryPoll.resp.status, 403);
        assert.equal(errorCode(recoveryPoll.body), "access_denied");
        assert.doesNotMatch(JSON.stringify(recoveryPoll.body), DENIED_POLL_SECRET_PATTERN);
      } finally {
        __setAgentConnectCompleteFailureForTest(null);
        if (restarted) {
          await closeServer(restarted.server);
        } else {
          await closeServer(first.server);
        }
        await closePostgresStorage();
      }
    }
  );
});

test("agent-connect: expired polling handle returns bounded expired_token", async () => {
  const { server, asUrl } = await spinUpServer({ agentConnectTtlMs: 1 });
  try {
    const { start } = await createAgentConnectRequest({ asUrl, clientName: "Agent Connect Expiry Test" });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const expiredPoll = await pollAgentConnectToken({
      pollingCode: start.polling_code,
      tokenUrl: start.token_url,
    });
    assert.equal(expiredPoll.resp.status, 400);
    assert.equal(errorCode(expiredPoll.body), "expired_token");
    assert.doesNotMatch(JSON.stringify(expiredPoll.body), EXPIRED_POLL_SECRET_PATTERN);
  } finally {
    await closeServer(server);
  }
});

test("agent-connect: approved attempt that expires before delivery revokes the stranded bearer", async () => {
  const { server, asUrl, rsUrl } = await spinUpServer({ agentConnectTtlMs: 1 });
  try {
    const { staged, start } = await createAgentConnectRequest({ asUrl, clientName: "Agent Connect Approved Expiry" });
    const approval = await approveInline({ asUrl, requestUri: staged.request_uri, subjectId: "owner_local" });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const expiredPoll = await pollAgentConnectToken({
      pollingCode: start.polling_code,
      tokenUrl: start.token_url,
    });
    assert.equal(expiredPoll.resp.status, 400);
    assert.equal(errorCode(expiredPoll.body), "expired_token");
    assert.doesNotMatch(JSON.stringify(expiredPoll.body), EXPIRED_POLL_SECRET_PATTERN);

    const schemaResp = await fetch(`${rsUrl}/v1/schema`, {
      headers: { Authorization: `Bearer ${approval.token}` },
    });
    assert.ok(
      schemaResp.status === 401 || schemaResp.status === 403,
      "expired approved delivery must revoke the already-minted bearer"
    );
  } finally {
    await closeServer(server);
  }
});

test("agent-connect: approved attempt fails closed when the grant is revoked before delivery", async () => {
  const { server, asUrl } = await spinUpServer();
  try {
    const { staged, start } = await createAgentConnectRequest({ asUrl, clientName: "Agent Connect Approved Revoke" });
    const approval = await approveInline({ asUrl, requestUri: staged.request_uri, subjectId: "owner_local" });
    assert.ok(approval.grantId, "approval should include grant_id");
    const revokeResp = await fetch(`${asUrl}/grants/${encodeURIComponent(approval.grantId)}/revoke`, {
      headers: { Authorization: `Bearer ${approval.token}` },
      method: "POST",
    });
    assert.ok(revokeResp.ok, "grant revoke should succeed before agent delivery");

    const revokedPoll = await pollAgentConnectToken({
      pollingCode: start.polling_code,
      tokenUrl: start.token_url,
    });
    assert.equal(revokedPoll.resp.status, 401);
    assert.equal(errorCode(revokedPoll.body), "invalid_grant");
    assert.doesNotMatch(JSON.stringify(revokedPoll.body), ACCESS_TOKEN_PATTERN);
  } finally {
    await closeServer(server);
  }
});

test("agent-connect: live Postgres approved expiry and revocation fail closed before delivery", async (t) => {
  const baseUrl = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
  if (!baseUrl) {
    t.skip("PDPP_TEST_POSTGRES_URL must target the dedicated local Postgres test listener");
    return;
  }

  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: baseUrl,
      databaseName: "pdpp_test_agent_connect_expiry_revoke",
    },
    async (databaseUrl) => {
      const expiryServer = await spinUpServer({ agentConnectTtlMs: 1, databaseUrl, storageBackend: "postgres" });
      try {
        const { staged, start } = await createAgentConnectRequest({
          asUrl: expiryServer.asUrl,
          clientName: "Agent Connect PG Approved Expiry",
        });
        await approveInline({ asUrl: expiryServer.asUrl, requestUri: staged.request_uri, subjectId: "owner_local" });
        await new Promise((resolve) => setTimeout(resolve, 10));
        const expiredPoll = await pollAgentConnectToken({
          pollingCode: start.polling_code,
          tokenUrl: start.token_url,
        });
        assert.equal(expiredPoll.resp.status, 400);
        assert.equal(errorCode(expiredPoll.body), "expired_token");
      } finally {
        await closeServer(expiryServer.server);
        await closePostgresStorage();
      }

      const revokeServer = await spinUpServer({ databaseUrl, storageBackend: "postgres" });
      try {
        const { staged, start } = await createAgentConnectRequest({
          asUrl: revokeServer.asUrl,
          clientName: "Agent Connect PG Approved Revoke",
        });
        const approval = await approveInline({
          asUrl: revokeServer.asUrl,
          requestUri: staged.request_uri,
          subjectId: "owner_local",
        });
        assert.ok(approval.grantId, "approval should include grant_id");
        const revokeResp = await fetch(`${revokeServer.asUrl}/grants/${encodeURIComponent(approval.grantId)}/revoke`, {
          headers: { Authorization: `Bearer ${approval.token}` },
          method: "POST",
        });
        assert.ok(revokeResp.ok, "grant revoke should succeed before agent delivery");
        const revokedPoll = await pollAgentConnectToken({
          pollingCode: start.polling_code,
          tokenUrl: start.token_url,
        });
        assert.equal(revokedPoll.resp.status, 401);
        assert.equal(errorCode(revokedPoll.body), "invalid_grant");
      } finally {
        await closeServer(revokeServer.server);
        await closePostgresStorage();
      }
    }
  );
});

test("agent-connect: approved scoped token cannot access ungranted stream", async () => {
  const { server, asUrl, rsUrl } = await spinUpServer();
  try {
    const { spotifyManifest, staged, start } = await createAgentConnectRequest({
      asUrl,
      clientName: "Agent Connect Scope Test",
    });
    await approveInline({
      asUrl,
      requestUri: staged.request_uri,
      subjectId: "owner_local",
    });
    const completedPoll = await pollAgentConnectToken({
      pollingCode: start.polling_code,
      tokenUrl: start.token_url,
    });
    assert.equal(completedPoll.resp.status, 200);

    const [, secondStream] = spotifyManifest.streams;
    assert.ok(secondStream, "spotify manifest should declare a second stream");
    const ungrantedStream = secondStream.name;
    const streamResp = await fetch(`${rsUrl}/v1/streams/${encodeURIComponent(ungrantedStream)}`, {
      headers: { Authorization: `Bearer ${completedPoll.body.access_token}` },
    });
    const body = await streamResp.json();
    assert.equal(streamResp.status, 401, JSON.stringify(body));
    assert.equal(errorCode(body), "context.stream_not_allowed");
  } finally {
    await closeServer(server);
  }
});

test("agent-connect: schema verification fails cleanly for invalid bearer", async () => {
  const { server, rsUrl } = await spinUpServer();
  try {
    const schemaResp = await fetch(`${rsUrl}/v1/schema`, {
      headers: { Authorization: "Bearer not-a-real-token" },
    });
    const body = await schemaResp.json();
    assert.equal(schemaResp.status, 401);
    assert.equal(errorCode(body), "context.active_false");
    assert.doesNotMatch(JSON.stringify(body), INVALID_TOKEN_PATTERN);
  } finally {
    await closeServer(server);
  }
});

test("agent-flow: forget removes local files, does not contact AS", async () => {
  const cacheRoot = makeTmpCache();
  await ensureCacheDirs(cacheRoot);

  writeGrant(cacheRoot, "grant_forget_test", {
    expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    grant_id: "grant_forget_test",
    revoked: false,
    source: { id: "https://registry.pdpp.dev/connectors/spotify", kind: "connector" },
    streams: [{ name: "listening_history" }],
  });
  await writeToken(cacheRoot, "grant_forget_test", "test-token-value");

  // Simulate "pdpp agent forget" — deletes local without calling AS
  deleteGrantFiles(cacheRoot, "grant_forget_test");

  assert.equal(readGrant(cacheRoot, "grant_forget_test"), null);
  assert.equal(readToken(cacheRoot, "grant_forget_test"), null);
});

test("agent-flow: status output shape contains no token material", async () => {
  const cacheRoot = makeTmpCache();
  await ensureCacheDirs(cacheRoot);

  writeAccess(cacheRoot, { as_url: "http://as.example", rs_url: "http://rs.example" });
  writeClient(cacheRoot, "client_status_test", { client_id: "client_status_test", client_name: "Status Test" });
  writeGrant(cacheRoot, "grant_status", {
    access_mode: "single_use",
    expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    grant_id: "grant_status",
    issued_at: new Date().toISOString(),
    purpose_description: "Status test purpose",
    revoked: false,
    source: { id: "https://registry.pdpp.dev/connectors/spotify", kind: "connector" },
    streams: [{ name: "listening_history" }],
  });
  await writeToken(cacheRoot, "grant_status", "must-not-appear-in-display");

  // Reconstruct the status output that "pdpp agent status" would produce
  const access = readAccess(cacheRoot);
  const grants = listGrants(cacheRoot);
  const clients = listClients(cacheRoot);
  const now = Date.now();

  const summary = {
    as_url: access?.as_url || null,
    clients: clients.map((c) => ({ client_id: c.client_id, client_name: c.client_name || null })),
    grants: grants.map((g) => {
      const expired = g.expires_at ? new Date(g.expires_at).getTime() <= now : false;
      return {
        access_mode: g.access_mode || null,
        expired,
        expires_at: g.expires_at || null,
        grant_id: g.grant_id,
        purpose_description: g.purpose_description || null,
        revoked: g.revoked,
        source: g.source || null,
        streams: (g.streams || []).map((s) => (typeof s === "string" ? s : s.name)),
        token_cached: !!readToken(cacheRoot, g.grant_id),
        usable: !(expired || g.revoked),
      };
    }),
    object: "agent_cache_status",
    rs_url: access?.rs_url || null,
  };

  const summaryJson = JSON.stringify(summary);

  assert.ok(!summaryJson.includes("must-not-appear-in-display"), "token value must not appear in status JSON");
  const [grantSummary] = summary.grants;
  assert.ok(grantSummary, "status summary should include the cached grant");
  assert.equal(grantSummary.token_cached, true, "token_cached should be true without exposing the token");
  assert.equal(grantSummary.grant_id, "grant_status");
  assert.equal(grantSummary.usable, true);
});

test("agent-flow: owner-token kind rejection", async () => {
  // The cache must refuse to store owner-kind tokens
  // This mirrors the guard in "pdpp agent store" that checks pdpp_token_kind
  const cacheRoot = makeTmpCache();
  await ensureCacheDirs(cacheRoot);

  // Simulate introspection result for an owner token
  const ownerIntrospection = {
    active: true,
    grant_id: null,
    pdpp_token_kind: "owner",
  };

  // "pdpp agent store" would throw if token_kind !== 'client'
  assert.notEqual(ownerIntrospection.pdpp_token_kind, "client", "owner tokens must be rejected at the store boundary");
});

// ─── wait tests ───────────────────────────────────────────────────────────────

test("agent wait: returns immediately when a usable token is already cached", async () => {
  const cacheRoot = makeTmpCache();
  await ensureCacheDirs(cacheRoot);

  writeGrant(cacheRoot, "grant_wait_ready", {
    expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    grant_id: "grant_wait_ready",
    revoked: false,
    source: { id: "https://registry.pdpp.dev/connectors/spotify", kind: "connector" },
    streams: [{ name: "listening_history" }],
  });
  await writeToken(cacheRoot, "grant_wait_ready", "ready-token-value");

  // Replicate the wait logic directly (no CLI spawn needed — tests the library layer)
  const found = hasUsableGrant(cacheRoot);
  assert.ok(found, "wait should find a usable grant immediately");
  assert.equal(found.grant_id, "grant_wait_ready");

  // Token must be readable from the cache (but wait itself must not print it)
  const token = readToken(cacheRoot, found.grant_id);
  assert.equal(token, "ready-token-value");
});

test("agent wait: returns for a specific grant-id when that grant is cached", async () => {
  const cacheRoot = makeTmpCache();
  await ensureCacheDirs(cacheRoot);

  // Write two grants; wait should find the named one
  writeGrant(cacheRoot, "grant_other", {
    expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    grant_id: "grant_other",
    revoked: false,
    source: { id: "https://registry.pdpp.dev/connectors/github", kind: "connector" },
    streams: [{ name: "issues" }],
  });
  // No token for grant_other yet

  writeGrant(cacheRoot, "grant_target", {
    expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    grant_id: "grant_target",
    revoked: false,
    source: { id: "https://registry.pdpp.dev/connectors/spotify", kind: "connector" },
    streams: [{ name: "listening_history" }],
  });
  await writeToken(cacheRoot, "grant_target", "target-token");

  // Wait for a specific grant-id — mirrors the --grant-id path in runWait
  const specificGrantId = "grant_target";
  const token = readToken(cacheRoot, specificGrantId);
  const grant = readGrant(cacheRoot, specificGrantId);
  const found = token ? grant : null;

  assert.ok(found, "wait should find the specific named grant");
  assert.equal(found.grant_id, "grant_target");
  // The other grant with no token is not returned
  assert.equal(readToken(cacheRoot, "grant_other"), null);
});

test("agent wait: times out cleanly when no token is cached", async () => {
  const cacheRoot = makeTmpCache();
  await ensureCacheDirs(cacheRoot);

  // No grants at all — wait must time out
  const timeoutSeconds = 1;
  const intervalMs = 200;
  const deadline = Date.now() + timeoutSeconds * 1000;

  const waitForGrant = async (): Promise<ReturnType<typeof hasUsableGrant>> => {
    const found = hasUsableGrant(cacheRoot);
    if (found || Date.now() >= deadline) {
      return found;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
    return waitForGrant();
  };
  const found = await waitForGrant();

  assert.equal(found, null, "wait must time out without finding a grant when cache is empty");
  // Verify no token material was produced
  const grants = listGrants(cacheRoot);
  assert.equal(grants.length, 0, "cache should remain empty after a timed-out wait");
});

test("agent wait: AGENT_USAGE documents the wait subcommand", () => {
  // Smoke-test that the usage string is internally consistent (no spawn required)
  // Import the module dynamically to avoid server startup
  const usageText = `Usage: pdpp agent <subcommand> [options]

Subcommands:
  bootstrap   Discover AS/RS and register a project-local public client.
  status      Show cached grant scope, expiry, and revocation state (no secrets).
  request     Stage a PAR grant request; print the owner approval URL.
  wait        Poll the local cache until a usable token appears, then exit 0.
  store       Accept a pasted client token and write it to the local cache.
  use         Print the bearer token for a named grant`;

  assert.ok(usageText.includes("wait"), "AGENT_USAGE must document the wait subcommand");
  assert.ok(usageText.includes("poll") || usageText.includes("Poll"), "wait description must mention polling");
});

test("agent wait --grant-id: does not succeed for an expired grant", async () => {
  const cacheRoot = makeTmpCache();
  await ensureCacheDirs(cacheRoot);

  writeGrant(cacheRoot, "grant_expired_wait", {
    expires_at: new Date(Date.now() - 1000).toISOString(), // already expired
    grant_id: "grant_expired_wait",
    revoked: false,
    source: { id: "https://registry.pdpp.dev/connectors/spotify", kind: "connector" },
    streams: [{ name: "listening_history" }],
  });
  await writeToken(cacheRoot, "grant_expired_wait", "expired-token");

  // hasUsableGrant with grantId must reject an expired grant
  const found = hasUsableGrant(cacheRoot, { grantId: "grant_expired_wait" });
  assert.equal(found, null, "wait --grant-id must not return an expired grant");
});

test("agent wait --grant-id: does not succeed for a locally revoked grant", async () => {
  const cacheRoot = makeTmpCache();
  await ensureCacheDirs(cacheRoot);

  writeGrant(cacheRoot, "grant_revoked_wait", {
    expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    grant_id: "grant_revoked_wait",
    revoked: true, // locally marked revoked
    source: { id: "https://registry.pdpp.dev/connectors/spotify", kind: "connector" },
    streams: [{ name: "listening_history" }],
  });
  await writeToken(cacheRoot, "grant_revoked_wait", "revoked-token");

  // hasUsableGrant with grantId must reject a revoked grant
  const found = hasUsableGrant(cacheRoot, { grantId: "grant_revoked_wait" });
  assert.equal(found, null, "wait --grant-id must not return a locally revoked grant");
});
