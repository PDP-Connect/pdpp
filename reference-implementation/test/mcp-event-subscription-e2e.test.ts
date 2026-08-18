// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression guard for the normal hosted MCP surface.
 *
 * Event-subscription management remains a reference-implementation capability,
 * but it is no longer exposed through the recommended `/mcp` agent entrypoint.
 */

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { canonicalConnectorKeyFromManifest } from "../server/connector-key.ts";
import { startServer } from "../server/index.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, "..");
const OWNER_SUBJECT_ID = "owner_local";
const NOW = "2026-05-31T00:00:00.000Z";

interface CloseableServer {
  close: (callback?: (err?: Error) => void) => unknown;
  closeAllConnections: () => void;
}

type StartedServer = Awaited<ReturnType<typeof startServer>> & {
  asServer: CloseableServer;
  rsServer: CloseableServer;
};

async function closeServer(server: StartedServer): Promise<void> {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise((resolve) => server.asServer.close(resolve)),
    new Promise((resolve) => server.rsServer.close(resolve)),
  ]);
}

function startTestServer(): Promise<StartedServer> {
  return startServer({
    asPort: 0,
    dbPath: ":memory:",
    ownerAuthPassword: "",
    quiet: true,
    rsPort: 0,
  }) as Promise<StartedServer>;
}

interface JsonResult {
  body: unknown;
  resp: Response;
  status: number;
}

async function fetchJson(url: string | URL, opts: RequestInit = {}): Promise<JsonResult> {
  const resp = await fetch(url, opts);
  const text = await resp.text();
  const body = text ? JSON.parse(text) : null;
  return { body, resp, status: resp.status };
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

interface Manifest {
  connector_id: string;
  [key: string]: unknown;
}

async function registerSpotify(asUrl: string): Promise<Manifest> {
  const manifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, "fixtures/seed-manifests/spotify.json"), "utf8")) as Manifest;
  const { status } = await fetchJson(`${asUrl}/connectors`, {
    body: JSON.stringify(manifest),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(status, 201);
  await seedSpotifyInstance(manifest);
  return manifest;
}

async function seedSpotifyInstance(manifest: Manifest): Promise<void> {
  const connectorId = canonicalConnectorKeyFromManifest(manifest);
  assert.ok(connectorId, "spotify manifest must resolve to a canonical connector key");
  await createSqliteConnectorInstanceStore().upsert({
    connectorId,
    connectorInstanceId: "cin_mcp_event_subscription_spotify",
    createdAt: NOW,
    displayName: "MCP Event Subscription Spotify",
    ownerSubjectId: OWNER_SUBJECT_ID,
    sourceBinding: { account_hint: "mcp-event-subscription@example.com" },
    sourceBindingKey: "mcp-event-subscription@example.com",
    sourceKind: "account",
    status: "active",
    updatedAt: NOW,
  });
}

interface AuthCodeClient {
  client_id: string;
  [key: string]: unknown;
}

async function registerAuthCodeClient(asUrl: string): Promise<AuthCodeClient> {
  const { status, body } = await fetchJson(`${asUrl}/oauth/register`, {
    body: JSON.stringify({
      application_type: "web",
      client_name: "Hosted MCP surface test client",
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: ["https://client.example/callback"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(status, 201);
  return body as AuthCodeClient;
}

async function completeOauthCodeFlow({
  asUrl,
  client,
  manifest,
}: {
  asUrl: string;
  client: AuthCodeClient;
  manifest: Manifest;
}): Promise<string> {
  const verifier = randomBytes(32).toString("base64url");
  const authorizationDetails = [
    {
      access_mode: "continuous",
      purpose_code: "https://pdpp.dev/purpose/personal_ai_assistant",
      purpose_description: "Use PDPP data through hosted MCP.",
      source: { id: manifest.connector_id, kind: "connector" },
      streams: [{ name: "*" }],
      type: "https://pdpp.dev/data-access",
    },
  ];
  const authorizeUrl = new URL(`${asUrl}/oauth/authorize`);
  authorizeUrl.searchParams.set("client_id", client.client_id);
  authorizeUrl.searchParams.set("redirect_uri", "https://client.example/callback");
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("state", "state-123");
  authorizeUrl.searchParams.set("code_challenge", pkceChallenge(verifier));
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("authorization_details", JSON.stringify(authorizationDetails));

  const authorizeResp = await fetch(authorizeUrl, { redirect: "manual" });
  assert.equal(authorizeResp.status, 302);
  const authorizeLocation = authorizeResp.headers.get("location");
  assert.ok(authorizeLocation, "expected a redirect location from /oauth/authorize");
  const consentUrl = new URL(authorizeLocation, asUrl);
  const requestUri = consentUrl.searchParams.get("request_uri");
  assert.ok(requestUri);

  const reviewResp = await fetch(`${asUrl}/consent/review`, {
    body: JSON.stringify({ request_uri: requestUri, subject_id: "owner_local" }),
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    method: "POST",
  });
  const reviewBody = (await reviewResp.json()) as { approval_review?: unknown; approval_review_revision?: unknown };
  assert.equal(reviewResp.status, 200, JSON.stringify(reviewBody));
  assert.ok(reviewBody.approval_review && typeof reviewBody.approval_review === "object");
  assert.equal(typeof reviewBody.approval_review_revision, "string");
  const approveResp = await fetch(`${asUrl}/consent/approve`, {
    body: JSON.stringify({
      approval_review_revision: reviewBody.approval_review_revision,
      request_uri: requestUri,
    }),
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    method: "POST",
    redirect: "manual",
  });
  assert.equal(approveResp.status, 302);
  const approveLocation = approveResp.headers.get("location");
  assert.ok(approveLocation, "expected a redirect location from /consent/approve");
  const callback = new URL(approveLocation);
  const code = callback.searchParams.get("code");
  assert.ok(code);

  const { status, body } = await fetchJson(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: client.client_id,
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: "https://client.example/callback",
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  assert.equal(status, 200);
  return (body as { access_token: string }).access_token;
}

async function postMcpJson(rsUrl: string, token: string, message: unknown): Promise<{ status: number; body: unknown }> {
  const { status, body } = await fetchJson(`${rsUrl}/mcp`, {
    body: JSON.stringify(message),
    headers: {
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });
  return { body, status };
}

interface McpToolsListResult {
  result?: { tools?: { name: string }[] };
}

test("hosted MCP does not expose event-subscription management tools", async () => {
  const server = await startTestServer();
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    const manifest = await registerSpotify(asUrl);
    const client = await registerAuthCodeClient(asUrl);
    const accessToken = await completeOauthCodeFlow({ asUrl, client, manifest });

    const tools = await postMcpJson(rsUrl, accessToken, {
      id: 1,
      jsonrpc: "2.0",
      method: "tools/list",
      params: {},
    });
    assert.equal(tools.status, 200);
    const toolsBody = tools.body as McpToolsListResult;
    const toolNames = (toolsBody.result?.tools ?? []).map((tool) => tool.name).sort();
    assert.deepEqual(toolNames, ["aggregate", "fetch", "query_records", "read_record_field", "schema", "search"]);
    assert.equal(
      toolNames.some((name) => name.includes("event_subscription")),
      false
    );
    assert.equal(toolNames.includes("send_test_event"), false);

    const removedTool = await postMcpJson(rsUrl, accessToken, {
      id: 2,
      jsonrpc: "2.0",
      method: "tools/call",
      params: { arguments: { callback_url: "http://localhost:9999/hook" }, name: "create_event_subscription" },
    });
    assert.equal(removedTool.status, 200);
    // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    assert.match(JSON.stringify(removedTool.body), /Tool not found|not found|unknown/i);
  } finally {
    await closeServer(server);
  }
});
