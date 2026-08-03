// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Guards the live-probe owner-bearer helper (test/support/live-owner-bearer.mjs).
 *
 * The defect it closes: live acceptance probes each ran the owner device flow
 * inline and never revoked, minting a fresh FULL-READ owner bearer per run.
 * On a real deployment that accumulated 9,215 live owner-scoped credentials
 * from a single client id — ~80% of the whole token store, ~1,000/month.
 *
 * Two properties are load-bearing, and this test pins both against a stub AS
 * so it exercises the real fetch path without touching any live deployment:
 *
 *   1. REUSE — N acquisitions for the same (origin, clientId) run the device
 *      flow exactly ONCE. This is the mechanism that survives a crash, since
 *      a credential never minted cannot be orphaned.
 *   2. TEARDOWN — revocation targets the non-reversible `tok_<sha256>` public
 *      id (never the literal bearer, which is not a valid revoke handle on the
 *      wire) and is best-effort: a failing revoke reports rather than throwing,
 *      so cleanup can never fail the probe it was protecting.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";

type Calls = { approve: number; device: number; revoke: string[]; token: number };
type Handler = (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, calls: Calls) => void;

async function withStubAs<T>(handler: Handler, run: (origin: string, calls: Calls) => Promise<T>): Promise<T> {
  const calls: Calls = { device: 0, approve: 0, token: 0, revoke: [] };
  const server = createServer((req, res) => handler(req, res, calls));
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as import("node:net").AddressInfo;
  try {
    return await run(`http://127.0.0.1:${port}`, calls);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}

const defaultHandler: Handler = (req, res, calls) => {
  const send = (code: number, body: unknown) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.url === "/oauth/device_authorization") {
    calls.device += 1;
    return send(200, { device_code: `dev_${calls.device}`, user_code: `USER${calls.device}` });
  }
  if (req.url === "/device/approve") {
    calls.approve += 1;
    return send(200, { ok: true });
  }
  if (req.url === "/oauth/token") {
    calls.token += 1;
    return send(200, { access_token: `bearer_value_${calls.token}` });
  }
  if (req.method === "DELETE") {
    calls.revoke.push(req.url ?? "");
    return send(200, { revoked: true });
  }
  return send(404, { error: "unexpected" });
};

test("reuses one owner bearer per (origin, clientId) instead of minting per call", async () => {
  const mod = await import("./support/live-owner-bearer.ts");
  await withStubAs(defaultHandler, async (origin, calls) => {
    const a = await mod.getLiveOwnerBearer({ origin, clientId: "cli_probe", cookieHeader: "s=1" });
    const b = await mod.getLiveOwnerBearer({ origin, clientId: "cli_probe", cookieHeader: "s=1" });
    const c = await mod.getLiveOwnerBearer({ origin, clientId: "cli_probe", cookieHeader: "s=1" });

    assert.equal(a, b);
    assert.equal(b, c);
    // The whole point: three acquisitions, ONE device flow.
    assert.equal(calls.device, 1, "device_authorization must run once, not once per acquisition");
    assert.equal(calls.token, 1, "token exchange must run once, not once per acquisition");

    await mod.revokeLiveOwnerBearers({ log: () => {} });
  });
});

test("revokes by non-reversible public id, never by the literal bearer", async () => {
  const mod = await import("./support/live-owner-bearer.ts");
  await withStubAs(defaultHandler, async (origin, calls) => {
    const bearer = await mod.getLiveOwnerBearer({ origin, clientId: "cli_probe2", cookieHeader: "s=1" });
    const result = await mod.revokeLiveOwnerBearers({ log: () => {} });

    assert.equal(result.revoked, 1);
    assert.deepEqual(result.failed, []);
    assert.equal(calls.revoke.length, 1);

    const expected = `tok_${createHash("sha256").update(bearer).digest("base64url")}`;
    const url = calls.revoke[0] ?? "";
    assert.ok(url.includes(encodeURIComponent(expected)), `revoke URL must carry the public id, got ${url}`);
    assert.ok(!url.includes(bearer), "the literal bearer must never appear in a revoke URL");
    assert.equal(mod.liveOwnerBearerCacheSize(), 0, "cache must be cleared after teardown");
  });
});

test("a failing revoke reports rather than throwing, so cleanup cannot fail the probe", async () => {
  const mod = await import("./support/live-owner-bearer.ts");
  const failingHandler: Handler = (req, res, calls) => {
    if (req.method === "DELETE") {
      calls.revoke.push(req.url ?? "");
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "boom" }));
    }
    return defaultHandler(req, res, calls);
  };
  await withStubAs(failingHandler, async (origin) => {
    await mod.getLiveOwnerBearer({ origin, clientId: "cli_probe3", cookieHeader: "s=1" });
    const warnings: string[] = [];
    const result = await mod.revokeLiveOwnerBearers({ log: (m: string) => warnings.push(m) });

    assert.equal(result.revoked, 0);
    assert.equal(result.failed.length, 1);
    // Silence would be the real defect: an un-revoked full-read owner bearer
    // stays live for its whole TTL, so the operator must be told.
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /NOT revoked and still live/);
  });
});

test("surfaces a failed device flow instead of returning a null bearer", async () => {
  const mod = await import("./support/live-owner-bearer.ts");
  const brokenHandler: Handler = (req, res, calls) => {
    if (req.url === "/oauth/device_authorization") {
      calls.device += 1;
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "owner_session_required" }));
    }
    return defaultHandler(req, res, calls);
  };
  await withStubAs(brokenHandler, async (origin) => {
    await assert.rejects(
      () => mod.getLiveOwnerBearer({ origin, clientId: "cli_probe4", cookieHeader: "" }),
      /device_authorization failed \(401\)/
    );
  });
});
