// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { CimdTransportFailureEvent } from "../server/cimd.ts";
import { startServer } from "../server/index.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, "..");

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

interface OAuthErrorBody {
  error?: unknown;
  error_description?: unknown;
  request_id?: unknown;
}

const SPOTIFY_SOURCE_ID = "https://registry.pdpp.dev/connectors/spotify";

async function postForm(
  url: string,
  params: Record<string, string>
): Promise<{ resp: Response; body: OAuthErrorBody }> {
  const resp = await fetch(url, {
    body: new URLSearchParams(params).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  return { body: (await resp.json()) as OAuthErrorBody, resp };
}

function assertOAuthErrorHasRequestId(resp: Response, body: OAuthErrorBody): void {
  assert.equal(typeof body.error, "string");
  assert.equal(typeof body.error_description, "string");
  assert.equal(typeof body.request_id, "string");
  assert.equal(typeof body.request_id === "string" && body.request_id.length > 0, true);
  assert.equal(resp.headers.get("Request-Id"), body.request_id);
}

test("OAuth DCR errors keep RFC shape and include request ids", async () => {
  const server = (await startServer({
    asPort: 0,
    dbPath: ":memory:",
    dynamicClientRegistrationInitialAccessTokens: ["test-initial-access-token"],
    quiet: true,
    rsPort: 0,
  })) as StartedServer;
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const { resp, body } = await fetch(`${asUrl}/oauth/register`, {
      body: JSON.stringify({
        client_name: "Rejected Client",
        token_endpoint_auth_method: "none",
      }),
      headers: {
        Authorization: "Bearer wrong-token",
        "Content-Type": "application/json",
      },
      method: "POST",
      // biome-ignore lint/suspicious/noShadow: the nested fixture scope intentionally uses the domain term from its enclosing scenario.
    }).then(async (resp) => ({ body: (await resp.json()) as OAuthErrorBody, resp }));

    assert.equal(resp.status, 401);
    assert.equal(body.error, "invalid_client");
    assertOAuthErrorHasRequestId(resp, body);
  } finally {
    await closeServer(server);
  }
});

test("OAuth device authorization errors include request ids", async () => {
  const server = (await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 })) as StartedServer;
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const { resp, body } = await postForm(`${asUrl}/oauth/device_authorization`, {});

    assert.equal(resp.status, 400);
    assert.equal(body.error, "invalid_request");
    assertOAuthErrorHasRequestId(resp, body);
  } finally {
    await closeServer(server);
  }
});

test("MCP device authorization emits one CIMD transport event without changing its OAuth error", async () => {
  const events: CimdTransportFailureEvent[] = [];
  const logger = {
    child: () => logger,
    debug: () => undefined,
    error: () => undefined,
    fatal: () => undefined,
    info: () => undefined,
    trace: () => undefined,
    warn: (event: unknown) => {
      if (
        event &&
        typeof event === "object" &&
        (event as { event_type?: string }).event_type === "cimd.transport_failure"
      ) {
        events.push(event as CimdTransportFailureEvent);
      }
    },
  };
  const server = (await startServer({
    asPort: 0,
    cimdFetchDependencies: {
      dnsLookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
      fetchImpl: async () => Promise.reject(Object.assign(new TypeError("fetch failed"), { code: "UND_ERR_CONNECT" })),
      isGlobalUnicastAddressImpl: () => true,
    },
    dbPath: ":memory:",
    logger: logger as never,
    quiet: true,
    rsPort: 0,
  })) as StartedServer;
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const spotifyManifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, "manifests/spotify.json"), "utf8"));
    const registerResp = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(spotifyManifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);
    const { resp, body } = await postForm(`${asUrl}/oauth/device_authorization`, {
      authorization_details: JSON.stringify([
        {
          access_mode: "single_use",
          purpose_code: "https://pdpp.dev/purpose/personal_assistant",
          source: { id: SPOTIFY_SOURCE_ID, kind: "connector" },
          streams: [{ name: "*" }],
          type: "https://pdpp.dev/data-access",
        },
      ]),
      client_id: "https://client.example/oauth/client.json",
      resource: `http://localhost:${server.rsPort}/mcp`,
    });

    assert.equal(resp.status, 400);
    assert.equal(body.error, "cimd_fetch_failed", String(body.error_description));
    assertOAuthErrorHasRequestId(resp, body);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.event_type, "cimd.transport_failure");
    assert.equal(events[0]?.request_id, body.request_id);
    assert.equal(typeof events[0]?.trace_id, "string");
  } finally {
    await closeServer(server);
  }
});

test("OAuth authorize transport event joins the route Request-Id without changing its OAuth error", async () => {
  const events: CimdTransportFailureEvent[] = [];
  const logger = {
    child: () => logger,
    debug: () => undefined,
    error: () => undefined,
    fatal: () => undefined,
    info: () => undefined,
    trace: () => undefined,
    warn: (event: unknown) => {
      if (
        event &&
        typeof event === "object" &&
        (event as { event_type?: string }).event_type === "cimd.transport_failure"
      ) {
        events.push(event as CimdTransportFailureEvent);
      }
    },
  };
  const server = (await startServer({
    asPort: 0,
    cimdFetchDependencies: {
      dnsLookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
      fetchImpl: async () => Promise.reject(Object.assign(new TypeError("fetch failed"), { code: "UND_ERR_CONNECT" })),
      isGlobalUnicastAddressImpl: () => true,
    },
    dbPath: ":memory:",
    logger: logger as never,
    ownerAuthPassword: "",
    quiet: true,
    rsPort: 0,
  })) as StartedServer;
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const query = new URLSearchParams({
      client_id: "https://client.example/oauth/client.json",
      code_challenge: "a".repeat(43),
      code_challenge_method: "S256",
      redirect_uri: "https://client.example/callback",
      response_type: "code",
    });
    const resp = await fetch(`${asUrl}/oauth/authorize?${query}`, {
      headers: { "Request-Id": "req_authorize_join" },
    });
    const body = (await resp.json()) as OAuthErrorBody;

    assert.equal(resp.status, 400);
    assert.equal(body.error, "cimd_fetch_failed");
    assertOAuthErrorHasRequestId(resp, body);
    assert.equal(body.request_id, "req_authorize_join");
    assert.equal(events.length, 1);
    assert.equal(events[0]?.request_id, body.request_id);
    assert.equal(events[0]?.trace_id, null);
  } finally {
    await closeServer(server);
  }
});

test("OAuth token errors include request ids", async () => {
  const server = (await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 })) as StartedServer;
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const { resp, body } = await postForm(`${asUrl}/oauth/token`, {
      client_id: "pdpp_cli",
      device_code: "missing",
      grant_type: "unsupported_grant",
    });

    assert.equal(resp.status, 400);
    assert.equal(body.error, "unsupported_grant_type");
    assertOAuthErrorHasRequestId(resp, body);
  } finally {
    await closeServer(server);
  }
});
