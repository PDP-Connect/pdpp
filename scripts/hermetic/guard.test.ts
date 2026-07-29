// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Unit coverage for the hermetic network guard's bind-derived origin
// authority and its allowlist/patch logic. These tests run from repo root
// (scripts/ is a top-level test dir per the root test-accounting suite), so
// undici is not resolvable here -- exactly the "degrades to legacy-http-only"
// branch documented in guard.ts. That is exercised deliberately: it proves
// legacy http/https guarding is correct standalone, independent of whether
// undici happens to be on the path.
//
// The discriminator proof for fetch()/undici interception specifically
// (which requires reference-implementation's dependency tree) is reported
// separately as reproducible commands in the delivery report, not encoded
// as an automated test here, to avoid this suite silently depending on
// reference-implementation's node_modules layout.

import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { installHermeticNetworkGuard, isHermeticNetworkGuardInstalled, isOriginAllowed } from "./guard.ts";

const BLOCKED_ORIGIN_MESSAGE_PATTERN = /blocked non-allowlisted origin/;
const BLOCKED_7662_PATTERN = /blocked non-allowlisted origin http:\/\/localhost:7662/;
const EADDRINUSE_PATTERN = /EADDRINUSE/;

/** Bind a fresh loopback http server on an ephemeral port and resolve when listening. */
function startEphemeralServer(): Promise<http.Server> {
  const server = http.createServer((_req, res) => {
    res.end("hello-from-ephemeral-server");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function boundPort(server: http.Server): number {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a bound AddressInfo");
  }
  return address.port;
}

/**
 * Assert that a blocked http.request surfaces the guard's block as an
 * ASYNCHRONOUS 'error' event (matching Node's real connection-failure
 * contract), not a synchronous throw. Resolves with the error's message.
 */
function expectBlockedAsyncError(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, () => reject(new Error("blocked request unexpectedly produced a response")));
    req.on("error", (err) => resolve(err.message));
    req.end();
  });
}

function httpGetBody(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => resolve(data));
    });
    req.on("error", reject);
  });
}

test("an unbound origin (7662, the production port) is blocked", () => {
  assert.equal(isOriginAllowed("http://localhost:7662"), false);
});

test("a server bound BEFORE install is not retroactively trusted; a server bound AFTER install becomes reachable only once listening", async () => {
  // Under the guard, authority is derived from a successful bind that the
  // installed patch observes. A server bound before install is not covered.
  const handle = await installHermeticNetworkGuard();
  try {
    assert.equal(isHermeticNetworkGuardInstalled(), true);

    // 7662 stays blocked -- prove via the guard's own rejection path (an async
    // 'error' event), never by dialling it.
    assert.match(await expectBlockedAsyncError("http://localhost:7662/nope"), BLOCKED_7662_PATTERN);

    // Bind a server AFTER install. Before listen resolves nothing is granted;
    // after listen the exact bound port over its loopback spellings is.
    const server = await startEphemeralServer();
    try {
      const port = boundPort(server);
      assert.equal(isOriginAllowed(`http://127.0.0.1:${port}`), true, "bound port allowed after listening");
      assert.equal(isOriginAllowed(`http://localhost:${port}`), true, "localhost spelling allowed");
      assert.equal(isOriginAllowed(`http://[::1]:${port}`), true, "ipv6 loopback spelling allowed");

      const body = await httpGetBody(`http://127.0.0.1:${port}`);
      assert.equal(body, "hello-from-ephemeral-server");

      // Narrowness: a different port and a different host are NOT granted.
      assert.equal(isOriginAllowed(`http://127.0.0.1:${port + 1}`), false, "adjacent port not granted");
      assert.equal(isOriginAllowed(`http://example.com:${port}`), false, "unrelated host not granted");

      // Close revokes: after the server closes its origin is blocked again.
      await new Promise<void>((resolve) => server.close(() => resolve()));
      assert.equal(isOriginAllowed(`http://127.0.0.1:${port}`), false, "origin revoked on close");
      assert.match(await expectBlockedAsyncError(`http://127.0.0.1:${port}/`), BLOCKED_ORIGIN_MESSAGE_PATTERN);
    } finally {
      if (server.listening) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  } finally {
    handle.uninstall();
  }
  assert.equal(isHermeticNetworkGuardInstalled(), false);
});

test("a failed bind grants nothing", async () => {
  // Hold a port, then attempt to bind a second server to the SAME port so
  // the second bind fails with EADDRINUSE and never emits 'listening'.
  const holder = await startEphemeralServer();
  const heldPort = boundPort(holder);

  const handle = await installHermeticNetworkGuard();
  try {
    const clashing = http.createServer();
    const bindError = await new Promise<Error>((resolve) => {
      clashing.once("error", (err) => resolve(err));
      clashing.listen(heldPort, "127.0.0.1");
    });
    assert.match(bindError.message, EADDRINUSE_PATTERN);
    // The clashing server never listened, so no authority was granted for it.
    // (The holder itself was bound BEFORE install, so it is not granted
    // either -- the port must stay blocked.)
    assert.equal(isOriginAllowed(`http://127.0.0.1:${heldPort}`), false, "failed bind granted nothing");
    clashing.close();
  } finally {
    handle.uninstall();
    await new Promise<void>((resolve) => holder.close(() => resolve()));
  }
});

test("installHermeticNetworkGuard blocks legacy http.request to a non-allowlisted origin (async error), then uninstall restores it", async () => {
  const handle = await installHermeticNetworkGuard();
  try {
    assert.equal(isHermeticNetworkGuardInstalled(), true);
    // The block surfaces as an async 'error' event, matching Node's real
    // connection-failure contract (see blockRequest in guard.ts).
    assert.match(await expectBlockedAsyncError("http://127.0.0.1:1/nope"), BLOCKED_ORIGIN_MESSAGE_PATTERN);
  } finally {
    handle.uninstall();
  }
  assert.equal(isHermeticNetworkGuardInstalled(), false);

  // After uninstall, request() is restored to something that at least
  // attempts to dispatch (it will fail with ECONNREFUSED/similar rather
  // than the guard's own error) -- proving the guard, not a permanent
  // monkeypatch, was responsible for the earlier block.
  await new Promise<void>((resolve) => {
    const req = http.request("http://127.0.0.1:1/nope", () => resolve());
    req.on("error", (err) => {
      assert.doesNotMatch(err.message, BLOCKED_ORIGIN_MESSAGE_PATTERN);
      resolve();
    });
    req.on("close", () => resolve());
    req.end();
    // Safety net in case neither error nor response ever fires.
    req.setTimeout(2000, () => {
      req.destroy();
      resolve();
    });
  });
});

test("installHermeticNetworkGuard is idempotent", async () => {
  const first = await installHermeticNetworkGuard();
  const second = await installHermeticNetworkGuard();
  assert.equal(first, second);
  first.uninstall();
  assert.equal(isHermeticNetworkGuardInstalled(), false);
});
