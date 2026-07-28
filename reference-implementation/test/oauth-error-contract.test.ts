// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { startServer } from "../server/index.ts";

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
