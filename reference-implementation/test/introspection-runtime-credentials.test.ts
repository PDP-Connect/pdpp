// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { startServer } from "../server/index.ts";
import { basicIntrospectionAuthorization, type IntrospectionCallerCredentials } from "../server/introspection-http.ts";
import { TEST_RS_INTROSPECTION_CREDENTIALS } from "./helpers/introspection-test-credentials.ts";

type TestServer = Awaited<ReturnType<typeof startServer>> & {
  asServer: { close: (callback: () => void) => void; closeAllConnections?: () => void };
  rsServer: { close: (callback: () => void) => void; closeAllConnections?: () => void };
};

async function closeServer(server: TestServer): Promise<void> {
  server.asServer.closeAllConnections?.();
  server.rsServer.closeAllConnections?.();
  await Promise.allSettled([
    new Promise<void>((resolve) => server.asServer.close(() => resolve())),
    new Promise<void>((resolve) => server.rsServer.close(() => resolve())),
  ]);
}

function introspect(asPort: number, credentials: IntrospectionCallerCredentials): Promise<Response> {
  return fetch(`http://localhost:${asPort}/introspect`, {
    body: new URLSearchParams({ token: "tok_missing" }).toString(),
    headers: {
      Authorization: basicIntrospectionAuthorization(credentials),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    method: "POST",
  });
}

async function withoutNodeTestContext<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.NODE_TEST_CONTEXT;
    } else {
      process.env.NODE_TEST_CONTEXT = previous;
    }
  }
}

test("production default startup does not accept the repository test introspection credential", async () => {
  await withoutNodeTestContext(async () => {
    const server = (await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 })) as TestServer;
    try {
      const response = await introspect(server.asPort, TEST_RS_INTROSPECTION_CREDENTIALS);
      assert.equal(response.status, 401);
    } finally {
      await closeServer(server);
    }
  });
});

test("test-run startup also generates credentials unless the test injects them", async () => {
  const server = (await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 })) as TestServer;
  try {
    const response = await introspect(server.asPort, TEST_RS_INTROSPECTION_CREDENTIALS);
    assert.equal(response.status, 401);
  } finally {
    await closeServer(server);
  }
});
test("operator-provided introspection credentials are accepted", async () => {
  await withoutNodeTestContext(async () => {
    const credentials = { clientId: "operator-rs", clientSecret: "operator-rs-secret" };
    const server = (await startServer({
      asPort: 0,
      dbPath: ":memory:",
      introspectionCallerCredentials: credentials,
      quiet: true,
      rsIntrospectionCredentials: credentials,
      rsPort: 0,
    })) as TestServer;
    try {
      const response = await introspect(server.asPort, credentials);
      assert.equal(response.status, 200);
      const body = (await response.json()) as Record<string, unknown>;
      assert.equal(body.active, false);
    } finally {
      await closeServer(server);
    }
  });
});
