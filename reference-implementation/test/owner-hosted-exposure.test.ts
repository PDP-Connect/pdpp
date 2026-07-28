const TOP_LEVEL_REGEX_1 = /<input type="hidden" name="_csrf" value="([^"]+)"\s*\/>/;
const TOP_LEVEL_REGEX_2 = /PDPP_OWNER_PASSWORD/;
const TOP_LEVEL_REGEX_3 = /internet-facing|hosted|exposed/i;

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Hosted-exposure hardening — end-to-end (security audit S-1 + S-2, lane A1).
 *
 * Proves at the live HTTP boundary that:
 *   S-1  hosted posture WITHOUT a password refuses to boot — `startServer`
 *        rejects, no listener binds.
 *   S-2  with a password, an unauthenticated `POST /connectors` (manifest
 *        upsert — a one-request grant-wipe DoS) returns 401; the authenticated
 *        owner can still register.
 *   And that the local-dev posture (no signals) preserves the open
 *        password-optional `POST /connectors` the dev/test harness relies on.
 *
 * Under the Node test runner the INFERRED hosting signals (non-loopback
 * asPublicUrl / origin / bind host, NODE_ENV) are deliberately ignored so the
 * rest of the suite — which sets those for origin/metadata/CIMD purposes —
 * stays hermetic. The hosted posture here is therefore driven by the EXPLICIT
 * operator override `PDPP_HOSTED=1`, which is honored in every context. That is
 * exactly the knob a real hosted deploy would carry (or infer in production).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { closeDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, "..");
const SPOTIFY_MANIFEST = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, "manifests/spotify.json"), "utf8")) as {
  connector_id: string;
};

const TEST_PASSWORD = "hosted-exposure-test-password";

interface TestHttpServer {
  close: (callback: () => void) => void;
  closeAllConnections?: () => void;
}

interface TestServerHandle {
  abortStartupBackfill?: (reason: string) => void;
  asPort: number;
  asServer: TestHttpServer;
  controller?: {
    drainActiveRuns?: (timeoutMs: number) => Promise<unknown>;
  };
  rsPort: number;
  rsServer: TestHttpServer;
  schedulerManager?: {
    stop?: () => void;
  };
}

async function closeServer(server: TestServerHandle | null): Promise<void> {
  if (!server) {
    return;
  }
  server.schedulerManager?.stop?.();
  server.abortStartupBackfill?.("test shutdown");
  try {
    server.asServer.closeAllConnections?.();
  } catch {
    // best-effort
  }
  try {
    server.rsServer.closeAllConnections?.();
  } catch {
    // best-effort
  }
  const closeWithTimeout = (srv: TestHttpServer | undefined) =>
    new Promise<void>((resolve) => {
      if (!srv) {
        resolve();
        return;
      }
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      }, 2000);
      srv.close(() => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve();
      });
    });
  await Promise.allSettled([
    closeWithTimeout(server.asServer),
    closeWithTimeout(server.rsServer),
    server.controller?.drainActiveRuns
      ? server.controller.drainActiveRuns(1000).catch(() => undefined)
      : Promise.resolve(),
  ]);
  closeDb();
}

interface WithServerOptions {
  ownerAuthPassword?: string;
}

async function withServer(
  opts: WithServerOptions,
  fn: (ctx: { asUrl: string; server: TestServerHandle }) => Promise<void>
): Promise<void> {
  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    quiet: true,
    rsPort: 0,
    ...opts,
  });
  const asUrl = `http://localhost:${server.asPort}`;
  try {
    await fn({ asUrl, server });
  } finally {
    await closeServer(server);
  }
}

// Minimal login helper (mirrors owner-auth.test.js) to obtain a session cookie.
function getSetCookies(resp: Response): string[] {
  const headersWithGetSetCookie = resp.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headersWithGetSetCookie.getSetCookie === "function") {
    return headersWithGetSetCookie.getSetCookie();
  }
  const single = resp.headers.get("set-cookie");
  return single ? [single] : [];
}
function findPair(list: string[], name: string): string | null {
  for (const header of list) {
    const [first] = header.split(";");
    if (first?.startsWith(`${name}=`)) {
      return first;
    }
  }
  return null;
}
function extractCsrfField(html: string): string | null {
  const m = html.match(TOP_LEVEL_REGEX_1);
  return m ? (m[1] ?? null) : null;
}
async function login(asUrl: string, password: string): Promise<string | null> {
  const getResp = await fetch(`${asUrl}/owner/login`, {
    headers: { Accept: "text/html" },
    redirect: "manual",
  });
  const csrfCookie = findPair(getSetCookies(getResp), "pdpp_owner_csrf");
  const csrfField = extractCsrfField(await getResp.text());
  const postResp = await fetch(`${asUrl}/owner/login`, {
    body: new URLSearchParams({ _csrf: csrfField || "", password, return_to: "/" }).toString(),
    headers: {
      Accept: "text/html",
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: csrfCookie || "",
    },
    method: "POST",
    redirect: "manual",
  });
  return findPair(getSetCookies(postResp), "pdpp_owner_session");
}

// Run a block with PDPP_HOSTED=1 in the environment, restoring it after. This
// is the explicit operator override that forces the hosted posture in every
// context (the inferred signals are intentionally inert under the test runner).
async function withHostedEnv(fn: () => Promise<void>): Promise<void> {
  const prev = process.env.PDPP_HOSTED;
  process.env.PDPP_HOSTED = "1";
  try {
    await fn();
  } finally {
    if (prev === undefined) {
      delete process.env.PDPP_HOSTED;
    } else {
      process.env.PDPP_HOSTED = prev;
    }
  }
}

// ── S-1: hosted + no password → refuse to boot ───────────────────────────────
test("S-1: hosted posture (PDPP_HOSTED=1) without a password refuses to boot", async () => {
  await withHostedEnv(async () => {
    let server: TestServerHandle | null = null;
    await assert.rejects(
      async () => {
        server = await startServer({
          asPort: 0,
          dbPath: ":memory:",
          quiet: true,
          rsPort: 0,
        });
      },
      (err) => {
        assert.match((err as Error).message, TOP_LEVEL_REGEX_2, "error names the missing password");
        assert.match((err as Error).message, TOP_LEVEL_REGEX_3, "error explains the hosted exposure");
        return true;
      },
      "startServer must reject in a hosted posture without a password"
    );
    // Defensive: if a partial server object leaked, tear it down.
    await closeServer(server);
  });
});

test("S-1: hosted posture + PDPP_ALLOW_UNAUTHENTICATED_OWNER=1 boots (explicit escape hatch)", async () => {
  const prev = process.env.PDPP_ALLOW_UNAUTHENTICATED_OWNER;
  process.env.PDPP_ALLOW_UNAUTHENTICATED_OWNER = "1";
  try {
    await withHostedEnv(async () => {
      await withServer({}, async ({ asUrl }) => {
        const meta = await fetch(`${asUrl}/.well-known/oauth-authorization-server`);
        assert.equal(meta.status, 200, "override allows the server to boot and serve");
      });
    });
  } finally {
    if (prev === undefined) {
      delete process.env.PDPP_ALLOW_UNAUTHENTICATED_OWNER;
    } else {
      process.env.PDPP_ALLOW_UNAUTHENTICATED_OWNER = prev;
    }
  }
});

// ── S-1: hosted + password → boots normally ──────────────────────────────────
test("S-1: hosted posture WITH a password boots and serves", async () => {
  await withHostedEnv(async () => {
    await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
      const meta = await fetch(`${asUrl}/.well-known/oauth-authorization-server`);
      assert.equal(meta.status, 200);
    });
  });
});

// ── S-2: hosted POST /connectors requires an owner session ───────────────────
test("S-2: hosted posture gates POST /connectors behind owner session; GET detail stays open", async () => {
  await withHostedEnv(async () => {
    await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
      // Unauthenticated upsert is rejected — a bumped manifest version cannot
      // wipe grants without an owner session.
      const unauth = await fetch(`${asUrl}/connectors`, {
        body: JSON.stringify(SPOTIFY_MANIFEST),
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(unauth.status, 401, "unauthenticated POST /connectors is rejected in hosted mode");
      const unauthBody = (await unauth.json()) as { error: { code: string } };
      assert.equal(unauthBody.error.code, "owner_session_required");

      // Authenticated owner can still register.
      const cookie = await login(asUrl, TEST_PASSWORD);
      assert.ok(cookie, "owner login issued a session cookie");
      const authed = await fetch(`${asUrl}/connectors`, {
        body: JSON.stringify(SPOTIFY_MANIFEST),
        headers: { Accept: "application/json", "Content-Type": "application/json", Cookie: cookie ?? "" },
        method: "POST",
      });
      assert.equal(authed.status, 201, "authenticated owner can register a connector manifest");

      // GET /connectors/:id (manifest read) remains unauthenticated — it carries
      // no user data and the client-side connect flow needs it.
      const detail = await fetch(`${asUrl}/connectors/${encodeURIComponent(SPOTIFY_MANIFEST.connector_id)}`, {
        headers: { Accept: "application/json" },
      });
      assert.equal(detail.status, 200, "manifest read stays open");
    });
  });
});

// ── local-dev: open POST /connectors preserved ───────────────────────────────
test("local-dev posture leaves POST /connectors open (dev/test harness self-registers)", async () => {
  await withServer({}, async ({ asUrl }) => {
    const resp = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(SPOTIFY_MANIFEST),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(resp.status, 201, "local-dev register stays frictionless");
  });
});
