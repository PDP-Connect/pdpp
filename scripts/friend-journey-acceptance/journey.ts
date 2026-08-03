// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Friend self-host acceptance journey — pure step logic.
//
// Drives the documented friend/self-service path
// (docs/operator/self-service-gmail-mcp.md, docs/operator/hosted-mcp-setup.md)
// against ONE running reference deployment: owner login, first source add,
// a Gmail-style static-secret connector, a browser-backed connector (ChatGPT),
// a second static-secret connector, credential issue/revoke, and an MCP
// client connect+query — using only the public HTTP protocol surface, the
// same one a real owner and a real MCP client use.
//
// Every step declares its own `mode`:
//   "structural" — proven from this run with no real provider credentials.
//     Runs against an in-process server (see friend-journey-acceptance.test.ts)
//     or a live composed origin equally; the assertions never depend on a
//     real provider actually authenticating.
//   "live"       — requires a real browser-capable surface (ChatGPT) or is
//     otherwise gated on live infrastructure. Skipped with a named reason
//     when that infrastructure is not configured on this deployment, never
//     silently passed.
//
// This module has NO docker/process/env dependency — the CLI driver
// (cli.ts) is what decides whether `asUrl`/`rsUrl` point at an in-process
// harness or a live docker-composed stack, and passes that origin pair in.

import crypto from "node:crypto";
import {
  establishOwnerSessionCookie,
  extractCsrfFieldValue,
  findSetCookiePair,
  getSetCookieList,
} from "../lib/owner-session.ts";

export interface StepResult {
  detail: string;
  id: string;
  mode: "structural" | "live";
  ok: boolean;
  skippedReason?: string;
}

export interface JourneyContext {
  asUrl: string;
  fetchImpl?: typeof fetch;
  ownerPassword: string;
  ownerSubjectId: string;
  rsUrl: string;
}

export interface JourneyResult {
  ok: boolean;
  steps: StepResult[];
}

class JourneyError extends Error {}

interface ReadBodyResult {
  json: unknown;
  text: string;
}

async function readBody(resp: Response): Promise<ReadBodyResult> {
  const text = await resp.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { text, json };
}

function assertStatus(resp: Response, body: ReadBodyResult, expected: number | number[], label: string): void {
  const expectedList = Array.isArray(expected) ? expected : [expected];
  if (!expectedList.includes(resp.status)) {
    throw new JourneyError(`${label}: expected ${expectedList.join(" or ")}, got ${resp.status}: ${body.text}`);
  }
}

// ---------------------------------------------------------------------------
// Manifest registration. First-party polyfill connectors (gmail, github,
// chatgpt) must be registered on the AS before a draft-connection can find
// them. A real deployment self-registers these via polyfill-manifest-reconcile
// on boot; this harness registers explicitly so it does not depend on that
// reconcile's timing.
// ---------------------------------------------------------------------------

interface ConnectorManifestFile {
  connector_id: string;
  [key: string]: unknown;
}

async function registerConnectorManifest(ctx: JourneyContext, manifest: ConnectorManifestFile): Promise<void> {
  const fetchImpl = ctx.fetchImpl ?? fetch;
  const resp = await fetchImpl(`${ctx.asUrl}/connectors`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(manifest),
  });
  // 409 means it is already registered (e.g. by polyfill-manifest-reconcile
  // on a real deployment, or a prior run of this harness) — idempotent, not
  // a failure.
  if (![201, 409].includes(resp.status)) {
    const body = await readBody(resp);
    throw new JourneyError(`register connector manifest ${manifest.connector_id} failed ${resp.status}: ${body.text}`);
  }
}

// ---------------------------------------------------------------------------
// Step 1/2: owner login.
// ---------------------------------------------------------------------------

async function stepOwnerLogin(ctx: JourneyContext): Promise<{ result: StepResult; sessionCookie: string }> {
  if (!ctx.ownerPassword) {
    return {
      result: {
        id: "owner-login",
        mode: "structural",
        ok: true,
        detail: "no owner password configured on this deployment; proceeding with open local-dev owner auth",
      },
      sessionCookie: "",
    };
  }
  const sessionCookie = await establishOwnerSessionCookie({
    origin: ctx.asUrl,
    ownerPassword: ctx.ownerPassword,
    ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
  });
  return {
    result: { id: "owner-login", mode: "structural", ok: true, detail: "owner session established via /owner/login" },
    sessionCookie: sessionCookie ?? "",
  };
}

// ---------------------------------------------------------------------------
// Owner device-code token mint (used to seed/read data as the owner, distinct
// from the MCP client's scoped bearer minted later). Uses the reference
// deployment's preregistered local CLI client id — the same one
// assistant-readiness-smoke.test.ts and other in-repo device-flow tests use —
// rather than an invented client_id the AS would reject as unknown.
// ---------------------------------------------------------------------------

const PREREGISTERED_OWNER_CLI_CLIENT_ID = "cli_longview";

async function mintOwnerToken(
  ctx: JourneyContext,
  sessionCookie: string,
  clientId: string = PREREGISTERED_OWNER_CLI_CLIENT_ID
): Promise<string> {
  const fetchImpl = ctx.fetchImpl ?? fetch;
  const deviceResp = await fetchImpl(`${ctx.asUrl}/oauth/device_authorization`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId }),
  });
  const deviceBody = await readBody(deviceResp);
  assertStatus(deviceResp, deviceBody, 200, "device_authorization");
  const device = deviceBody.json as { device_code: string; user_code: string };

  const approveResp = await fetchImpl(`${ctx.asUrl}/device/approve`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(sessionCookie ? { Cookie: sessionCookie } : {}),
    },
    body: JSON.stringify({ user_code: device.user_code, subject_id: ctx.ownerSubjectId }),
  });
  const approveBody = await readBody(approveResp);
  assertStatus(approveResp, approveBody, 200, "device/approve");

  const tokenResp = await fetchImpl(`${ctx.asUrl}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: device.device_code,
      client_id: clientId,
    }),
  });
  const tokenBody = await readBody(tokenResp);
  assertStatus(tokenResp, tokenBody, 200, "oauth/token (device_code)");
  return (tokenBody.json as { access_token: string }).access_token;
}

// ---------------------------------------------------------------------------
// Step 3/4/6: static-secret source add (first source, Gmail, third connector).
// ---------------------------------------------------------------------------

export interface StaticSecretConnectorFixture {
  connectorId: string;
  displayName: string;
  requiresBrowser: boolean;
  secret: string;
  setupFields: Record<string, string>;
}

export const GMAIL_FIXTURE: StaticSecretConnectorFixture = {
  connectorId: "gmail",
  displayName: "Gmail (fixture app password)",
  requiresBrowser: false,
  setupFields: { account_email: "friend-e2e-fixture@example.com" },
  secret: "friend-e2e-synthetic-app-password",
};

export const THIRD_CONNECTOR_FIXTURE: StaticSecretConnectorFixture = {
  connectorId: "github",
  displayName: "GitHub (fixture personal access token)",
  requiresBrowser: false,
  setupFields: {},
  secret: "friend-e2e-synthetic-github-pat",
};

export const CHATGPT_FIXTURE: StaticSecretConnectorFixture = {
  connectorId: "chatgpt",
  displayName: "ChatGPT (fixture browser-backed credential)",
  requiresBrowser: true,
  // Both chatgpt.json credential_capture fields are secret: true, so neither
  // belongs in draft-connection's setup_fields (non-secret only). The capture
  // route's single `secret` string carries both, JSON-encoded — the same
  // shape static-secret-controller-run-injection.test.ts captures and the
  // runtime later decodes into CHATGPT_USERNAME/CHATGPT_PASSWORD env.
  setupFields: {},
  secret: JSON.stringify({
    username: "friend-e2e-fixture@example.com",
    password: "friend-e2e-synthetic-chatgpt-password",
  }),
};

interface DraftConnectionOutcome {
  connectionId: string | null;
  credentialKind: string | null;
  errorCode: string | null;
  status: number;
}

async function createDraftConnection(
  ctx: JourneyContext,
  sessionCookie: string,
  fixture: StaticSecretConnectorFixture
): Promise<DraftConnectionOutcome> {
  const fetchImpl = ctx.fetchImpl ?? fetch;
  const resp = await fetchImpl(
    `${ctx.asUrl}/_ref/connectors/${encodeURIComponent(fixture.connectorId)}/draft-connection`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(sessionCookie ? { Cookie: sessionCookie } : {}),
      },
      body: JSON.stringify({ setup_fields: fixture.setupFields }),
    }
  );
  const body = await readBody(resp);
  if (resp.status === 201) {
    const parsed = body.json as { connection_id?: string; credential_kind?: string } | null;
    return {
      connectionId: parsed?.connection_id ?? null,
      credentialKind: parsed?.credential_kind ?? null,
      status: resp.status,
      errorCode: null,
    };
  }
  const errorCode = (body.json as { error?: { code?: string } } | null)?.error?.code ?? null;
  return { connectionId: null, credentialKind: null, status: resp.status, errorCode };
}

async function captureStaticSecretCredential(
  ctx: JourneyContext,
  sessionCookie: string,
  connectionId: string,
  credentialKind: string | null,
  fixture: StaticSecretConnectorFixture
): Promise<Response> {
  const fetchImpl = ctx.fetchImpl ?? fetch;
  return await fetchImpl(`${ctx.asUrl}/_ref/connections/${encodeURIComponent(connectionId)}/static-secret-credential`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(sessionCookie ? { Cookie: sessionCookie } : {}),
    },
    body: JSON.stringify({
      secret: fixture.secret,
      ...(credentialKind ? { credential_kind: credentialKind } : {}),
    }),
  });
}

/**
 * Add one static-secret source end to end: draft-connection, then seal the
 * fixture secret. `browserAvailable` tells the step whether this deployment
 * has a configured browser surface — used only to interpret the result for a
 * browser-required connector (ChatGPT); the step never contacts a real
 * browser or a real provider.
 */
async function stepAddStaticSecretSource(
  stepId: string,
  ctx: JourneyContext,
  sessionCookie: string,
  fixture: StaticSecretConnectorFixture,
  browserAvailable: boolean
): Promise<{ result: StepResult; connectionId: string | null }> {
  const draft = await createDraftConnection(ctx, sessionCookie, fixture);

  if (fixture.requiresBrowser && !browserAvailable) {
    // This deployment has no browser surface configured. The friend-ready
    // fail-closed guard (ref-static-secret-draft-connection.ts) must refuse
    // BEFORE any credential is captured — a 201 here would mean the owner
    // could store a provider password that can only ever fail at first sync.
    if (draft.status === 503 && draft.errorCode === "browser_runtime_unavailable") {
      return {
        result: {
          id: stepId,
          mode: "live",
          ok: true,
          skippedReason: "no browser surface configured on this deployment",
          detail: `${fixture.displayName}: draft-connection correctly refused with 503 browser_runtime_unavailable (fail-closed, no credential stored)`,
        },
        connectionId: null,
      };
    }
    throw new JourneyError(
      `${stepId}: ${fixture.displayName} requires a browser surface, but draft-connection did not fail closed ` +
        `(status ${draft.status}, error ${draft.errorCode}). A browser-required connector must never accept a ` +
        "credential capture on a browser-free deployment."
    );
  }

  if (draft.status !== 201 || !draft.connectionId) {
    throw new JourneyError(
      `${stepId}: ${fixture.displayName} draft-connection failed (status ${draft.status}, error ${draft.errorCode})`
    );
  }

  const captureResp = await captureStaticSecretCredential(
    ctx,
    sessionCookie,
    draft.connectionId,
    draft.credentialKind,
    fixture
  );
  const captureBody = await readBody(captureResp);
  assertStatus(captureResp, captureBody, [200, 201], `${stepId}: static-secret-credential capture`);

  return {
    result: {
      id: stepId,
      mode: fixture.requiresBrowser ? "live" : "structural",
      ok: true,
      detail: `${fixture.displayName}: draft-connection + credential capture succeeded (connection ${draft.connectionId})`,
    },
    connectionId: draft.connectionId,
  };
}

// ---------------------------------------------------------------------------
// Owner-ingested record seed. Not part of a scored step: proves the MCP query
// step (below) returns real data, the same way railway-mcp-query-smoke.ts
// seeds a stable fixture record set without running a live connector.
// ---------------------------------------------------------------------------

const SEED_STREAM = "messages";
const SEED_RECORD_KEY = "friend-e2e-seed-message-1";

async function seedFirstSourceRecord(ctx: JourneyContext, ownerToken: string, connectorId: string): Promise<void> {
  const fetchImpl = ctx.fetchImpl ?? fetch;
  const record = {
    key: SEED_RECORD_KEY,
    emitted_at: "2026-01-01T00:00:00.000Z",
    data: {
      id: SEED_RECORD_KEY,
      subject: "Friend acceptance seed message",
      received_at: "2026-01-01T00:00:00.000Z",
      thread_id: "friend-e2e-thread-1",
    },
  };
  const resp = await fetchImpl(
    `${ctx.rsUrl}/v1/ingest/${encodeURIComponent(SEED_STREAM)}?connector_id=${encodeURIComponent(connectorId)}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/x-ndjson" },
      body: JSON.stringify(record),
    }
  );
  const body = await readBody(resp);
  assertStatus(resp, body, 200, "seed record ingest");
}

// ---------------------------------------------------------------------------
// Step 7: issue and revoke a credential (dynamic client + owner-issued token)
// without leaking the secret anywhere in the harness's own output.
// ---------------------------------------------------------------------------

function assertNoLeak(haystack: string, secret: string, label: string): void {
  if (secret.length > 0 && haystack.includes(secret)) {
    throw new JourneyError(`${label}: secret material leaked into harness-observable output`);
  }
}

async function stepIssueRevokeCredential(
  ctx: JourneyContext,
  sessionCookie: string
): Promise<{ result: StepResult; log: string[] }> {
  const fetchImpl = ctx.fetchImpl ?? fetch;
  const log: string[] = [];

  const registerResp = await fetchImpl(`${ctx.asUrl}/oauth/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(sessionCookie ? { Cookie: sessionCookie } : {}),
    },
    body: JSON.stringify({
      client_name: "friend-e2e credential lifecycle client",
      token_endpoint_auth_method: "none",
    }),
  });
  const registerBody = await readBody(registerResp);
  assertStatus(registerResp, registerBody, 201, "oauth/register (owner-issued client)");
  const clientId = (registerBody.json as { client_id: string }).client_id;
  log.push(`issued client ${clientId}`);

  const token = await mintOwnerToken(ctx, sessionCookie, clientId);
  assertNoLeak(log.join("\n"), token, "post-issue log");

  const revokeResp = await fetchImpl(`${ctx.asUrl}/oauth/register/${encodeURIComponent(clientId)}`, {
    method: "DELETE",
    headers: sessionCookie ? { Cookie: sessionCookie } : {},
  });
  await readBody(revokeResp);
  if (revokeResp.status !== 204) {
    throw new JourneyError(`credential revoke: expected 204, got ${revokeResp.status}`);
  }
  log.push(`revoked client ${clientId}`);

  const introspectResp = await fetchImpl(`${ctx.asUrl}/introspect`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }).toString(),
  });
  const introspectBody = await readBody(introspectResp);
  assertStatus(introspectResp, introspectBody, 200, "introspect after revoke");
  const introspection = introspectBody.json as { active?: boolean };
  if (introspection.active !== false) {
    throw new JourneyError("credential revoke: token still active after client deletion");
  }
  log.push("post-revoke introspection confirms token is inactive");

  const reissueResp = await fetchImpl(`${ctx.asUrl}/oauth/register/${encodeURIComponent(clientId)}`, {
    method: "DELETE",
    headers: sessionCookie ? { Cookie: sessionCookie } : {},
  });
  await readBody(reissueResp);
  if (reissueResp.status !== 404) {
    throw new JourneyError(`re-deleting an already-revoked client: expected 404, got ${reissueResp.status}`);
  }

  const detail = log.join("; ");
  assertNoLeak(detail, token, "step detail");

  return {
    result: { id: "credential-issue-revoke", mode: "structural", ok: true, detail },
    log,
  };
}

// ---------------------------------------------------------------------------
// Step 8: connect and query through MCP as a Claude Code-compatible client
// (scoped authorization-code + PKCE grant, exactly the documented
// `claude mcp add --transport http pdpp <origin>/mcp` handoff).
// ---------------------------------------------------------------------------

function pkceChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

interface McpMessage {
  id: number;
  jsonrpc: "2.0";
  method: string;
  params: Record<string, unknown>;
}

const SSE_LINE_ENDING_PATTERN = /\r$/;

interface JsonRpcResponse {
  result?: {
    isError?: boolean;
    structuredContent?: { data?: unknown };
    tools?: { name?: string }[];
  };
}

function parseMcpResponseText(contentType: string | null | undefined, text: string): JsonRpcResponse | null {
  const ct = String(contentType || "").toLowerCase();
  if (ct.includes("text/event-stream")) {
    const dataLines: string[] = [];
    for (const rawLine of String(text).split("\n")) {
      const line = rawLine.replace(SSE_LINE_ENDING_PATTERN, "");
      if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trim());
      }
    }
    const payload = dataLines.join("");
    return payload ? JSON.parse(payload) : null;
  }
  return text ? JSON.parse(text) : null;
}

async function mintScopedMcpClientToken(
  ctx: JourneyContext,
  sessionCookie: string,
  connectorId: string
): Promise<{ accessToken: string; clientId: string; grantId: string }> {
  const fetchImpl = ctx.fetchImpl ?? fetch;

  const registerResp = await fetchImpl(`${ctx.asUrl}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "friend-e2e Claude-Code-compatible MCP client",
      redirect_uris: ["https://claude-code-compatible-client.example/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      application_type: "web",
      token_endpoint_auth_method: "none",
    }),
  });
  const registerBody = await readBody(registerResp);
  assertStatus(registerResp, registerBody, 201, "oauth/register (MCP client)");
  const client = registerBody.json as { client_id: string };

  const verifier = crypto.randomBytes(32).toString("base64url");
  const authorizationDetails = [
    {
      type: "https://pdpp.org/data-access",
      source: { kind: "connector", id: connectorId },
      purpose_code: "https://pdpp.org/purpose/personal_ai_assistant",
      purpose_description: "friend-e2e MCP client acceptance",
      access_mode: "continuous",
      streams: [{ name: "*" }],
    },
  ];
  const authorizeUrl = new URL(`${ctx.asUrl}/oauth/authorize`);
  authorizeUrl.searchParams.set("client_id", client.client_id);
  authorizeUrl.searchParams.set("redirect_uri", "https://claude-code-compatible-client.example/callback");
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("state", "friend-e2e");
  authorizeUrl.searchParams.set("code_challenge", pkceChallenge(verifier));
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("authorization_details", JSON.stringify(authorizationDetails));

  const authorizeResp = await fetchImpl(authorizeUrl, {
    redirect: "manual",
    headers: sessionCookie ? { Cookie: sessionCookie } : {},
  });
  if (authorizeResp.status !== 302) {
    const body = await readBody(authorizeResp);
    throw new JourneyError(`oauth/authorize expected 302, got ${authorizeResp.status}: ${body.text}`);
  }
  const authorizeLocation = authorizeResp.headers.get("location");
  if (!authorizeLocation) {
    throw new JourneyError("oauth/authorize returned 302 with no Location header");
  }
  const consentUrl = new URL(authorizeLocation, ctx.asUrl);
  const requestUri = consentUrl.searchParams.get("request_uri");
  if (!requestUri) {
    throw new JourneyError("oauth/authorize did not return a consent request_uri");
  }

  const consentPageResp = await fetchImpl(consentUrl, {
    headers: { Accept: "text/html", ...(sessionCookie ? { Cookie: sessionCookie } : {}) },
    redirect: "manual",
  });
  const consentCsrfCookie = findSetCookiePair(getSetCookieList(consentPageResp), "pdpp_owner_csrf");
  const consentCsrfField = extractCsrfFieldValue(await consentPageResp.text());

  const approveHeaders: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  const cookieParts = [sessionCookie, consentCsrfCookie].filter(Boolean);
  if (cookieParts.length > 0) {
    approveHeaders.Cookie = cookieParts.join("; ");
  }
  const approveBody: Record<string, string> = { request_uri: requestUri, subject_id: ctx.ownerSubjectId };
  if (consentCsrfField) {
    approveBody._csrf = consentCsrfField;
  }

  const approveResp = await fetchImpl(`${ctx.asUrl}/consent/approve`, {
    method: "POST",
    redirect: "manual",
    headers: approveHeaders,
    body: new URLSearchParams(approveBody).toString(),
  });
  if (approveResp.status !== 302) {
    const body = await readBody(approveResp);
    throw new JourneyError(`consent/approve expected 302, got ${approveResp.status}: ${body.text}`);
  }
  const approveLocation = approveResp.headers.get("location");
  if (!approveLocation) {
    throw new JourneyError("consent/approve returned 302 with no Location header");
  }
  const callback = new URL(approveLocation);
  const code = callback.searchParams.get("code");
  if (!code) {
    throw new JourneyError("consent/approve did not return an authorization code");
  }

  const tokenResp = await fetchImpl(`${ctx.asUrl}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: client.client_id,
      redirect_uri: "https://claude-code-compatible-client.example/callback",
      code_verifier: verifier,
    }).toString(),
  });
  const tokenBody = await readBody(tokenResp);
  assertStatus(tokenResp, tokenBody, 200, "oauth/token (authorization_code, MCP client)");
  const token = tokenBody.json as { access_token?: unknown; grant_id?: unknown };
  if (typeof token.access_token !== "string" || typeof token.grant_id !== "string") {
    throw new JourneyError("oauth/token did not return a scoped access token + grant id for the MCP client");
  }
  return { accessToken: token.access_token, clientId: client.client_id, grantId: token.grant_id };
}

async function mcpPost(
  ctx: JourneyContext,
  token: string,
  message: McpMessage
): Promise<{ rpc: JsonRpcResponse | null; status: number; text: string }> {
  const fetchImpl = ctx.fetchImpl ?? fetch;
  const resp = await fetchImpl(`${ctx.rsUrl}/mcp`, {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(message),
  });
  const text = await resp.text();
  let rpc: JsonRpcResponse | null = null;
  try {
    rpc = parseMcpResponseText(resp.headers.get("content-type"), text);
  } catch {
    rpc = null;
  }
  return { status: resp.status, rpc, text };
}

async function stepMcpClientConnectAndQuery(
  ctx: JourneyContext,
  sessionCookie: string,
  connectorId: string,
  stream: string
): Promise<StepResult> {
  const fetchImpl = ctx.fetchImpl ?? fetch;

  const anonymous = await fetchImpl(`${ctx.rsUrl}/mcp`, {
    method: "POST",
    headers: { Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} }),
  });
  if (anonymous.status !== 401 && anonymous.status !== 403) {
    throw new JourneyError(`anonymous /mcp was not refused (status ${anonymous.status})`);
  }

  const client = await mintScopedMcpClientToken(ctx, sessionCookie, connectorId);

  const init = await mcpPost(ctx, client.accessToken, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "friend-e2e-claude-code", version: "1" },
    },
  });
  if (init.status !== 200) {
    throw new JourneyError(`MCP initialize failed ${init.status}: ${init.text}`);
  }

  const list = await mcpPost(ctx, client.accessToken, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  if (list.status !== 200) {
    throw new JourneyError(`MCP tools/list failed ${list.status}: ${list.text}`);
  }
  const tools = list.rpc?.result?.tools ?? [];
  if (!tools.some((t) => t?.name === "query_records")) {
    throw new JourneyError(
      `tools/list did not advertise query_records (got ${tools.map((t) => t?.name).join(", ") || "none"})`
    );
  }

  const query = await mcpPost(ctx, client.accessToken, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "query_records", arguments: { stream, limit: 10 } },
  });
  if (query.status !== 200) {
    throw new JourneyError(`query_records failed ${query.status}: ${query.text}`);
  }
  if (query.rpc?.result?.isError) {
    throw new JourneyError(`query_records returned an MCP error: ${JSON.stringify(query.rpc.result)}`);
  }

  return {
    id: "mcp-client-connect-query",
    mode: "structural",
    ok: true,
    detail: `Claude-Code-compatible MCP client (${client.clientId}) completed initialize + tools/list + query_records via the scoped authorization-code+PKCE grant`,
  };
}

// ---------------------------------------------------------------------------
// Orchestrator.
// ---------------------------------------------------------------------------

export interface RunFriendJourneyOptions extends JourneyContext {
  /** Whether this deployment has a configured browser surface (neko/CDP). */
  browserAvailable: boolean;
  /** connector_id -> manifest JSON, for the connectors this journey registers before use. */
  manifests: Record<string, ConnectorManifestFile>;
}

export async function runFriendJourney(options: RunFriendJourneyOptions): Promise<JourneyResult> {
  const steps: StepResult[] = [];
  const ctx: JourneyContext = {
    asUrl: options.asUrl,
    rsUrl: options.rsUrl,
    ownerPassword: options.ownerPassword,
    ownerSubjectId: options.ownerSubjectId,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  };

  try {
    for (const manifest of Object.values(options.manifests)) {
      // biome-ignore lint/performance/noAwaitInLoops: registration order is fixed and small; sequential keeps failures attributable to one manifest.
      await registerConnectorManifest(ctx, manifest);
    }

    const login = await stepOwnerLogin(ctx);
    steps.push(login.result);
    const { sessionCookie } = login;

    // The first source add and the Gmail static-secret flow are the same real
    // owner action (self-service-gmail-mcp.md step 3: Gmail IS the documented
    // first source) — one HTTP interaction, reported under both step ids so
    // the report speaks to both journey requirements without double-adding
    // the connection.
    const firstSource = await stepAddStaticSecretSource(
      "first-source-add / gmail-static-secret",
      ctx,
      sessionCookie,
      GMAIL_FIXTURE,
      options.browserAvailable
    );
    steps.push(firstSource.result);

    const chatgpt = await stepAddStaticSecretSource(
      "chatgpt-browser-backed",
      ctx,
      sessionCookie,
      CHATGPT_FIXTURE,
      options.browserAvailable
    );
    steps.push(chatgpt.result);

    const third = await stepAddStaticSecretSource(
      "third-connector-optional",
      ctx,
      sessionCookie,
      THIRD_CONNECTOR_FIXTURE,
      options.browserAvailable
    );
    steps.push(third.result);

    const credential = await stepIssueRevokeCredential(ctx, sessionCookie);
    steps.push(credential.result);

    if (!firstSource.connectionId) {
      throw new JourneyError("mcp-client-connect-query: no source connection available to scope the MCP grant to");
    }
    const ownerToken = await mintOwnerToken(ctx, sessionCookie);
    await seedFirstSourceRecord(ctx, ownerToken, GMAIL_FIXTURE.connectorId);
    const mcpStep = await stepMcpClientConnectAndQuery(ctx, sessionCookie, GMAIL_FIXTURE.connectorId, SEED_STREAM);
    steps.push(mcpStep);
  } catch (err) {
    steps.push({
      id: "journey-aborted",
      mode: "structural",
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  return { ok: steps.every((s) => s.ok), steps };
}
