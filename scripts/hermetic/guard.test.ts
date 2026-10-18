// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Unit coverage for the hermetic network guard's bind-derived origin
// authority and its allowlist/patch logic. These tests run from repo root
// (scripts/ is a top-level test dir per the root test-accounting suite), where
// npm's undici package is not resolvable. The separate canonical-launch test
// proves default fetch and launcher wiring in that missing-undici condition.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { installHermeticNetworkGuard, isHermeticNetworkGuardInstalled, isOriginAllowed } from "./guard.ts";

const BLOCKED_ORIGIN_MESSAGE_PATTERN = /blocked non-allowlisted origin/;
const BLOCKED_7662_PATTERN = /blocked non-allowlisted origin http:\/\/localhost:7662/;
const REDIRECT_REFUSED_PATTERN = /hermetic guard: automatic redirects are refused in tests/;
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

/** Like startEphemeralServer, with a caller-supplied request handler. */
function startEphemeralServerWith(handler: http.RequestListener): Promise<http.Server> {
  const server = http.createServer(handler);
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
      // A 127.0.0.1 bind says nothing about ::1, which a foreign process may hold.
      assert.equal(isOriginAllowed(`http://[::1]:${port}`), false, "ipv6 loopback not granted by an IPv4 bind");

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

// ─── Bypass canaries ────────────────────────────────────────────────────────
// Each canary starts a FOREIGN loopback server BEFORE the guard is installed,
// so the guard never grants it, and counts the requests it receives. A guard
// bypass shows up as a non-zero count. Every server here is owned by this test
// and bound on loopback.

/** Close a server and any keep-alive connections a canary request left open. */
function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

interface CountingServer {
  close: () => Promise<void>;
  port: number;
  requests: () => number;
  server: http.Server;
}

async function startCountingServer(host: string, port = 0, handler?: http.RequestListener): Promise<CountingServer> {
  let count = 0;
  const server = http.createServer((req, res) => {
    count += 1;
    if (handler) {
      handler(req, res);
      return;
    }
    res.end("foreign");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  return {
    server,
    port: boundPort(server),
    requests: () => count,
    close: () => closeServer(server),
  };
}

/** Run a `http.request`-shaped call and resolve with the guard error message. */
function blockedMessage(start: () => http.ClientRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = start();
    req.on("response", () => reject(new Error("request unexpectedly produced a response")));
    req.on("error", (err) => resolve(err.message));
    req.end();
  });
}

test("fetch refuses automatic redirects, to foreign and to owned origins alike", async () => {
  const foreign = await startCountingServer("127.0.0.1");
  const handle = await installHermeticNetworkGuard();
  try {
    let ownedHits = 0;
    const owned = await startEphemeralServerWith((req, res) => {
      if (req.url === "/to-foreign") {
        res.writeHead(307, { location: `http://127.0.0.1:${foreign.port}/secret` });
        res.end();
      } else if (req.url === "/to-final") {
        res.writeHead(302, { location: "/final" });
        res.end();
      } else {
        ownedHits += 1;
        res.end("final");
      }
    });
    try {
      const base = `http://127.0.0.1:${boundPort(owned)}`;
      const refused = ["/to-foreign", "/to-final"].flatMap((path) => [
        { label: `GET ${path}`, attempt: fetch(`${base}${path}`) },
        { label: `POST ${path}`, attempt: fetch(`${base}${path}`, { method: "POST", body: "payload" }) },
        { label: `Request ${path}`, attempt: fetch(new Request(`${base}${path}`)) },
      ]);
      await Promise.all(refused.map(({ label, attempt }) => assert.rejects(attempt, REDIRECT_REFUSED_PATTERN, label)));
      assert.equal(foreign.requests(), 0, "redirect reached the foreign server");
      assert.equal(ownedHits, 0, "redirect was followed to the owned server");

      // Manual hands the redirect back untouched; error keeps rejecting.
      const manual = await fetch(`${base}/to-foreign`, { redirect: "manual" });
      assert.equal(manual.status, 307);
      assert.equal(manual.headers.get("location"), `http://127.0.0.1:${foreign.port}/secret`);
      await assert.rejects(fetch(`${base}/to-final`, { redirect: "error" }), (error: Error) => {
        assert.doesNotMatch(error.message, REDIRECT_REFUSED_PATTERN);
        return error instanceof TypeError;
      });
      assert.equal(foreign.requests(), 0);
      assert.equal(ownedHits, 0);

      // A response that is not a redirect passes through unchanged.
      assert.equal(await (await fetch(`${base}/final`)).text(), "final");
    } finally {
      await closeServer(owned);
    }
  } finally {
    handle.uninstall();
    await foreign.close();
  }
});

test("http.request resolves the destination the way Node does when options override the URL", async () => {
  const foreign = await startCountingServer("127.0.0.1");
  const handle = await installHermeticNetworkGuard();
  try {
    const owned = await startEphemeralServer();
    try {
      const ownedUrl = `http://127.0.0.1:${boundPort(owned)}/`;
      const overrides = [
        { port: foreign.port },
        { hostname: "127.0.0.1", port: String(foreign.port) },
        { host: "127.0.0.1", hostname: "", port: foreign.port },
      ];
      const attempts = overrides.flatMap((options) => [
        { label: `string url + ${JSON.stringify(options)}`, start: () => http.request(ownedUrl, options) },
        { label: `URL + ${JSON.stringify(options)}`, start: () => http.request(new URL(ownedUrl), options) },
        { label: `http.get + ${JSON.stringify(options)}`, start: () => http.get(ownedUrl, options) },
      ]);
      const messages = await Promise.all(attempts.map(({ start }) => blockedMessage(start)));
      messages.forEach((message, index) => {
        assert.match(message, BLOCKED_ORIGIN_MESSAGE_PATTERN, attempts[index]?.label);
      });
      assert.equal(foreign.requests(), 0, "an options override reached the foreign server");
      // An override that stays on the owned origin is still allowed.
      const body = await new Promise<string>((resolve, reject) => {
        const req = http.get("http://127.0.0.1:1/", { port: boundPort(owned) }, (res) => {
          let data = "";
          res.on("data", (chunk) => {
            data += chunk;
          });
          res.on("end", () => resolve(data));
        });
        req.on("error", reject);
      });
      assert.equal(body, "hello-from-ephemeral-server");
    } finally {
      await closeServer(owned);
    }
  } finally {
    handle.uninstall();
    await foreign.close();
  }
});

test("a socketPath request is refused unless a server in this process bound that socket", async () => {
  const dir = await mkdtemp(join(homedir(), ".tmp", "pdpp-hermetic-socket-"));
  const foreignPath = join(dir, "foreign.sock");
  const ownedPath = join(dir, "owned.sock");
  let foreignRequests = 0;
  const foreign = http.createServer((_req, res) => {
    foreignRequests += 1;
    res.end("foreign");
  });
  await new Promise<void>((resolve) => foreign.listen(foreignPath, resolve));
  const handle = await installHermeticNetworkGuard();
  try {
    assert.match(
      await blockedMessage(() => http.request({ socketPath: foreignPath, path: "/" })),
      BLOCKED_ORIGIN_MESSAGE_PATTERN
    );
    assert.match(
      await blockedMessage(() => http.request("http://127.0.0.1:1/", { socketPath: foreignPath })),
      BLOCKED_ORIGIN_MESSAGE_PATTERN
    );
    assert.equal(foreignRequests, 0, "a socketPath request reached the foreign socket");

    const owned = http.createServer((_req, res) => res.end("owned-socket"));
    await new Promise<void>((resolve) => owned.listen(ownedPath, resolve));
    try {
      const body = await new Promise<string>((resolve, reject) => {
        const req = http.get({ socketPath: ownedPath, path: "/" }, (res) => {
          let data = "";
          res.on("data", (chunk) => {
            data += chunk;
          });
          res.on("end", () => resolve(data));
        });
        req.on("error", reject);
      });
      assert.equal(body, "owned-socket");
    } finally {
      await closeServer(owned);
    }
    assert.match(
      await blockedMessage(() => http.request({ socketPath: ownedPath, path: "/" })),
      BLOCKED_ORIGIN_MESSAGE_PATTERN,
      "socket grant revoked on close"
    );
  } finally {
    handle.uninstall();
    await closeServer(foreign);
    await rm(dir, { recursive: true, force: true });
  }
});

test("a bind grants only the address family it bound", async (t) => {
  // The foreign server holds ::1:P; the owned server then binds 127.0.0.1:P.
  // The grant must not extend to [::1]:P, which the foreign server answers.
  let foreign: CountingServer;
  try {
    foreign = await startCountingServer("::1");
  } catch {
    t.skip("host cannot bind IPv6 loopback");
    return;
  }
  const handle = await installHermeticNetworkGuard();
  try {
    let owned: http.Server;
    try {
      owned = await new Promise<http.Server>((resolve, reject) => {
        const server = http.createServer((_req, res) => res.end("owned-v4"));
        server.once("error", reject);
        server.listen(foreign.port, "127.0.0.1", () => resolve(server));
      });
    } catch {
      t.skip("port is not free on IPv4 loopback");
      return;
    }
    try {
      assert.equal(isOriginAllowed(`http://127.0.0.1:${foreign.port}`), true);
      assert.equal(isOriginAllowed(`http://[::1]:${foreign.port}`), false, "IPv4 bind granted ::1");
      assert.match(
        await blockedMessage(() => http.request(`http://[::1]:${foreign.port}/`)),
        BLOCKED_ORIGIN_MESSAGE_PATTERN
      );
      await assert.rejects(fetch(`http://[::1]:${foreign.port}/`), BLOCKED_ORIGIN_MESSAGE_PATTERN);
      assert.equal(foreign.requests(), 0, "an IPv4 bind exposed the foreign IPv6 server");
    } finally {
      await closeServer(owned);
    }
  } finally {
    handle.uninstall();
    await foreign.close();
  }
});

test("bind grants follow the bound family: ::1 only, 0.0.0.0 only IPv4, :: both", async (t) => {
  const handle = await installHermeticNetworkGuard();
  try {
    const cases: Array<{ host: string; v4: boolean; v6: boolean }> = [
      { host: "127.0.0.1", v4: true, v6: false },
      { host: "0.0.0.0", v4: true, v6: false },
      { host: "::1", v4: false, v6: true },
      { host: "::", v4: true, v6: true },
    ];
    await Promise.all(
      cases.map(async ({ host, v4, v6 }) => {
        let server: CountingServer;
        try {
          server = await startCountingServer(host);
        } catch (error) {
          if (!host.includes(":")) {
            throw error;
          }
          t.diagnostic(`skipped ${host}: host cannot bind it`);
          return;
        }
        try {
          assert.equal(isOriginAllowed(`http://127.0.0.1:${server.port}`), v4, `${host}: 127.0.0.1`);
          assert.equal(isOriginAllowed(`http://[::1]:${server.port}`), v6, `${host}: [::1]`);
        } finally {
          await server.close();
        }
      })
    );
  } finally {
    handle.uninstall();
  }
});

test("a server rebound with different options is granted by its current options only", async (t) => {
  // The foreign IPv4 server is bound before install, so it is not trusted.
  let port: number;
  let foreign: CountingServer;
  try {
    const probe = await startCountingServer("::1");
    ({ port } = probe);
    await probe.close();
    foreign = await startCountingServer("127.0.0.1", port);
  } catch {
    t.skip("host cannot bind IPv6 loopback, or the port is not free on IPv4 loopback");
    return;
  }
  const handle = await installHermeticNetworkGuard();
  try {
    const server = http.createServer((_req, res) => res.end("owned"));
    const listen = (options: Parameters<http.Server["listen"]>[0]) =>
      new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(options, () => {
          server.off("error", reject);
          resolve();
        });
      });
    await listen({ host: "::1", port });
    await closeServer(server);
    await listen({ host: "::", ipv6Only: true, port });
    try {
      assert.equal(isOriginAllowed(`http://[::1]:${port}`), true);
      assert.equal(isOriginAllowed(`http://127.0.0.1:${port}`), false, "stale options granted IPv4");
      await assert.rejects(fetch(`http://127.0.0.1:${port}/`), BLOCKED_ORIGIN_MESSAGE_PATTERN);
      assert.equal(foreign.requests(), 0, "an IPv6-only rebind exposed the foreign IPv4 server");
    } finally {
      await closeServer(server);
    }
  } finally {
    handle.uninstall();
    await foreign.close();
  }
});
