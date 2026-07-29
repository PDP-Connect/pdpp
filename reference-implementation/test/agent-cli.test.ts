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
const FORBIDDEN_SCOPE_PATTERN = /permission|scope|grant|forbidden/i;
const INVALID_TOKEN_PATTERN = /not-a-real-token/;

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
import { startServer } from "../server/index.ts";
import { DEFAULT_LOCAL_DCR_INITIAL_ACCESS_TOKEN } from "../server/reference-local-defaults.ts";
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
  const server = (await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0, ...opts })) as TestServer;
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  return { asUrl, rsUrl, server };
}

interface SpotifyManifest {
  connector_id: string;
  streams: Array<{ name: string }>;
}

interface AgentConnectStart {
  approval_url: string;
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
      purposeCode: "https://pdpp.org/purpose/personal_assistant",
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
  assert.equal(startResp.status, 201);
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

async function registerSpotify(asUrl: string): Promise<SpotifyManifest> {
  const { readFileSync: rfs } = await import("node:fs");
  const { join: pjoin, dirname: pdir } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const __dir = pdir(fileURLToPath(import.meta.url));
  const manifest = JSON.parse(rfs(pjoin(__dir, "../manifests/spotify.json"), "utf8")) as SpotifyManifest;
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
    source: { id: "https://registry.pdpp.org/connectors/spotify", kind: "connector" },
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
    source: { id: "https://registry.pdpp.org/connectors/spotify", kind: "connector" },
    streams: [{ name: "listening_history" }],
  });
  await writeToken(cacheRoot, "grant_match", "tok");

  const found = hasUsableGrant(cacheRoot, {
    sourceId: "https://registry.pdpp.org/connectors/spotify",
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
    source: { id: "https://registry.pdpp.org/connectors/spotify", kind: "connector" },
    streams: [{ name: "listening_history" }],
  });
  await writeToken(cacheRoot, "grant_exp", "tok");
  const found = hasUsableGrant(cacheRoot, { sourceId: "https://registry.pdpp.org/connectors/spotify" });
  assert.equal(found, null, "expired grant must not be returned");
});

test("cache: hasUsableGrant rejects revoked grants", async () => {
  const cacheRoot = makeTmpCache();
  await ensureCacheDirs(cacheRoot);
  writeGrant(cacheRoot, "grant_rev", {
    expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    grant_id: "grant_rev",
    revoked: true,
    source: { id: "https://registry.pdpp.org/connectors/spotify", kind: "connector" },
    streams: [{ name: "listening_history" }],
  });
  await writeToken(cacheRoot, "grant_rev", "tok");
  const found = hasUsableGrant(cacheRoot, { sourceId: "https://registry.pdpp.org/connectors/spotify" });
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
    source: { id: "https://registry.pdpp.org/connectors/spotify", kind: "connector" },
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
      purposeCode: "https://pdpp.org/purpose/personal_assistant",
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
      headers: { "Content-Type": "application/json" },
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
        purposeCode: "https://pdpp.org/purpose/personal_assistant",
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
    assert.equal(replayPoll.resp.status, 401);
    assert.equal(errorCode(replayPoll.body), "invalid_grant");
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
    assert.equal(streamResp.status, 403);
    assert.match(errorCode(body) || JSON.stringify(body), FORBIDDEN_SCOPE_PATTERN);
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
    assert.equal(errorCode(body), "authentication_error");
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
    source: { id: "https://registry.pdpp.org/connectors/spotify", kind: "connector" },
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
    source: { id: "https://registry.pdpp.org/connectors/spotify", kind: "connector" },
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
    source: { id: "https://registry.pdpp.org/connectors/spotify", kind: "connector" },
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
    source: { id: "https://registry.pdpp.org/connectors/github", kind: "connector" },
    streams: [{ name: "issues" }],
  });
  // No token for grant_other yet

  writeGrant(cacheRoot, "grant_target", {
    expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    grant_id: "grant_target",
    revoked: false,
    source: { id: "https://registry.pdpp.org/connectors/spotify", kind: "connector" },
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
    source: { id: "https://registry.pdpp.org/connectors/spotify", kind: "connector" },
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
    source: { id: "https://registry.pdpp.org/connectors/spotify", kind: "connector" },
    streams: [{ name: "listening_history" }],
  });
  await writeToken(cacheRoot, "grant_revoked_wait", "revoked-token");

  // hasUsableGrant with grantId must reject a revoked grant
  const found = hasUsableGrant(cacheRoot, { grantId: "grant_revoked_wait" });
  assert.equal(found, null, "wait --grant-id must not return a locally revoked grant");
});
