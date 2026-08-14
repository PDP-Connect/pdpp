// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { getDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { introspectionHeaders } from "./helpers/introspection.ts";
import { TEST_RS_INTROSPECTION_CREDENTIALS } from "./helpers/introspection-test-credentials.ts";

interface CloseableServer {
  close: (callback?: (err?: Error) => void) => unknown;
  closeAllConnections: () => void;
}

type StartedServer = Awaited<ReturnType<typeof startServer>> & {
  asServer: CloseableServer;
  rsServer: CloseableServer;
};

// Integration coverage for the additive owner-access reference contracts
// (OpenSpec change redesign-owner-console-product-experience, tasks 10.C.1-4):
//   - PATCH /oauth/register/:clientId          (client-name update)
//   - GET   /_ref/clients/:clientId/tokens      (per-client token listing)
//   - DELETE /_ref/clients/:clientId/tokens/:id (per-token revoke)
//   - GET   /_ref/grant-packages/count          (grant-package count)
//
// The security boundaries under test: no literal bearer is ever returned by
// the token listing, per-token revoke targets exactly one bearer (not the
// whole client), and every surface is owner-session-gated + owner-scoped.

const TEST_PASSWORD = "owner-access-contracts-test-password";
const TEST_SUBJECT = "owner_test_subject";
const TEST_DCR_INITIAL_ACCESS_TOKEN = "pdpp-reference-test-initial-access-token";

async function closeServer(server: StartedServer): Promise<void> {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  const closeWithTimeout = (srv: CloseableServer) =>
    new Promise<void>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve();
        }
      }, 2000);
      srv.close(() => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve();
        }
      });
    });
  await Promise.allSettled([closeWithTimeout(server.asServer), closeWithTimeout(server.rsServer)]);
}

async function withServer(fn: (ctx: { asUrl: string }) => Promise<void>): Promise<void> {
  const server = (await startServer({
    asPort: 0,
    dbPath: ":memory:",
    dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
    introspectionCallerCredentials: TEST_RS_INTROSPECTION_CREDENTIALS,
    ownerAuthPassword: TEST_PASSWORD,
    ownerAuthSubjectId: TEST_SUBJECT,
    quiet: true,
    rsIntrospectionCredentials: TEST_RS_INTROSPECTION_CREDENTIALS,
    rsPort: 0,
  })) as StartedServer;
  try {
    await fn({ asUrl: `http://localhost:${server.asPort}` });
  } finally {
    await closeServer(server);
  }
}

function getRawSetCookieList(resp: Response): string[] {
  if (typeof resp.headers.getSetCookie === "function") {
    return resp.headers.getSetCookie();
  }
  const single = resp.headers.get("set-cookie");
  return single ? [single] : [];
}

function findSetCookiePair(setCookies: readonly string[], name: string): string | null {
  for (const header of setCookies) {
    // biome-ignore lint/style/useDestructuring: the property access names the fixture value at its point of use.
    const firstPair = header.split(";")[0];
    if (firstPair?.startsWith(`${name}=`)) {
      return firstPair;
    }
  }
  return null;
}

function extractCsrfFieldValue(html: string): string | null {
  // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
  const match = html.match(/<input type="hidden" name="_csrf" value="([^"]+)"\s*\/>/);
  return match?.[1] ?? null;
}

async function fetchCsrfFromForm(
  asUrl: string,
  path: string,
  sessionCookie = ""
): Promise<{ csrfCookie: string | null; csrfField: string | null }> {
  const resp = await fetch(`${asUrl}${path}`, {
    headers: { Accept: "text/html", Cookie: sessionCookie },
    redirect: "manual",
  });
  const setCookies = getRawSetCookieList(resp);
  const html = await resp.text();
  return {
    csrfCookie: findSetCookiePair(setCookies, "pdpp_owner_csrf"),
    csrfField: extractCsrfFieldValue(html),
  };
}

async function login(asUrl: string): Promise<string> {
  const csrf = await fetchCsrfFromForm(asUrl, "/owner/login");
  const resp = await fetch(`${asUrl}/owner/login`, {
    body: new URLSearchParams({
      _csrf: csrf.csrfField || "",
      password: TEST_PASSWORD,
      return_to: "/deployment/tokens",
    }).toString(),
    headers: {
      Accept: "text/html",
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: csrf.csrfCookie || "",
    },
    method: "POST",
    redirect: "manual",
  });
  assert.equal(resp.status, 302);
  const sessionCookie = findSetCookiePair(getRawSetCookieList(resp), "pdpp_owner_session");
  assert.ok(sessionCookie, "login should issue owner session cookie");
  return sessionCookie;
}

interface RegisteredClientBody {
  client_id: string;
  client_name?: string;
  [key: string]: unknown;
}

async function registerClient(
  asUrl: string,
  body: unknown,
  cookie = ""
): Promise<{ body: RegisteredClientBody; status: number }> {
  const resp = await fetch(`${asUrl}/oauth/register`, {
    body: JSON.stringify(body),
    headers: {
      Authorization: `Bearer ${TEST_DCR_INITIAL_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    method: "POST",
  });
  const json = (await resp.json()) as RegisteredClientBody;
  return { body: json, status: resp.status };
}

interface OwnerClientRow {
  active_token_count?: number;
  client_id: string;
  client_name?: string;
  [key: string]: unknown;
}

interface OwnerClientsList {
  data: OwnerClientRow[];
  [key: string]: unknown;
}

async function listOwnerClients(asUrl: string, cookie: string): Promise<OwnerClientsList> {
  const resp = await fetch(`${asUrl}/_ref/clients?owner=true`, { headers: { Cookie: cookie } });
  assert.equal(resp.status, 200);
  return (await resp.json()) as OwnerClientsList;
}

interface OwnerTokenResult {
  access_token: string;
  [key: string]: unknown;
}

async function issueOwnerTokenViaDeviceFlow(
  asUrl: string,
  clientId: string,
  cookie: string
): Promise<OwnerTokenResult> {
  const deviceResp = await fetch(`${asUrl}/oauth/device_authorization`, {
    body: JSON.stringify({ client_id: clientId }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(deviceResp.status, 200);
  const device = (await deviceResp.json()) as { user_code: string; device_code: string };

  const approveResp = await fetch(`${asUrl}/device/approve`, {
    body: JSON.stringify({ user_code: device.user_code }),
    headers: { "Content-Type": "application/json", Cookie: cookie },
    method: "POST",
  });
  assert.equal(approveResp.status, 200);

  const tokenResp = await fetch(`${asUrl}/oauth/token`, {
    body: JSON.stringify({
      client_id: clientId,
      device_code: device.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
    headers: introspectionHeaders(),
    method: "POST",
  });
  assert.equal(tokenResp.status, 200);
  return (await tokenResp.json()) as OwnerTokenResult;
}

interface IntrospectResult {
  active: boolean;
  [key: string]: unknown;
}

interface OwnerClientTokenRow {
  object: string;
  token_id_public: string;
  [key: string]: unknown;
}

interface OwnerClientTokenList {
  data: OwnerClientTokenRow[];
  object: string;
}

interface RevokeResult {
  revoked: boolean;
  token_id_public?: string;
}

async function introspect(asUrl: string, token: string): Promise<IntrospectResult> {
  const resp = await fetch(`${asUrl}/introspect`, {
    body: JSON.stringify({ token }),
    headers: introspectionHeaders(),
    method: "POST",
  });
  assert.equal(resp.status, 200);
  return (await resp.json()) as IntrospectResult;
}

// ── 10.C.1 client-name update ────────────────────────────────────────────────

test("10.C.1 PATCH /oauth/register/:clientId renames the client and reflects on the next read", async () => {
  await withServer(async ({ asUrl }) => {
    const sessionCookie = await login(asUrl);
    const registered = await registerClient(
      asUrl,
      {
        client_name: "laptop-export",
        token_endpoint_auth_method: "none",
      },
      sessionCookie
    );
    assert.equal(registered.status, 201);
    const clientId = registered.body.client_id;

    const before = getDb().prepare("SELECT updated_at FROM oauth_clients WHERE client_id = ?").get(clientId) as
      | { updated_at?: string }
      | undefined;

    const patchResp = await fetch(`${asUrl}/oauth/register/${encodeURIComponent(clientId)}`, {
      body: JSON.stringify({ client_name: "backup laptop" }),
      headers: { "Content-Type": "application/json", Cookie: sessionCookie },
      method: "PATCH",
    });
    assert.equal(patchResp.status, 200);
    const patched = (await patchResp.json()) as { client_id?: string; client_name?: string };
    assert.equal(patched.client_id, clientId);
    assert.equal(patched.client_name, "backup laptop");

    // updated_at was driven by the rename.
    const after = getDb().prepare("SELECT updated_at FROM oauth_clients WHERE client_id = ?").get(clientId) as {
      updated_at?: string;
    };
    assert.ok(after.updated_at, "updated_at must be set after a rename");
    assert.notEqual(after.updated_at, undefined);
    // The rename reflects across the same read the overview/tokens page uses.
    const listed = await listOwnerClients(asUrl, sessionCookie);
    const row = listed.data.find((r) => r.client_id === clientId);
    assert.ok(row, "expected the renamed client to appear in the owner client list");
    assert.equal(row.client_name, "backup laptop", "rename must reflect in the owner client list");
    // Sanity: updated_at is a real timestamp string.
    assert.equal(typeof after.updated_at, "string");
    assert.ok(!before || typeof before.updated_at === "string");
  });
});

test("10.C.1 rename rejects empty names, cross-owner edits, and pre-registered clients", async () => {
  await withServer(async ({ asUrl }) => {
    const sessionCookie = await login(asUrl);
    const registered = await registerClient(
      asUrl,
      {
        client_name: "owned",
        token_endpoint_auth_method: "none",
      },
      sessionCookie
    );
    const clientId = registered.body.client_id;

    // Empty name → 400 invalid_client_metadata.
    const emptyResp = await fetch(`${asUrl}/oauth/register/${encodeURIComponent(clientId)}`, {
      body: JSON.stringify({ client_name: "   " }),
      headers: { "Content-Type": "application/json", Cookie: sessionCookie },
      method: "PATCH",
    });
    assert.equal(emptyResp.status, 400);

    // Unsupported field → 400 (scope is not editable here).
    const scopeResp = await fetch(`${asUrl}/oauth/register/${encodeURIComponent(clientId)}`, {
      body: JSON.stringify({ client_name: "ok", redirect_uris: ["https://evil.example"] }),
      headers: { "Content-Type": "application/json", Cookie: sessionCookie },
      method: "PATCH",
    });
    assert.equal(scopeResp.status, 400);

    // Anonymous client (registered by no owner) → 403 forbidden.
    const anon = await registerClient(asUrl, { client_name: "anon", token_endpoint_auth_method: "none" });
    const anonResp = await fetch(`${asUrl}/oauth/register/${encodeURIComponent(anon.body.client_id)}`, {
      body: JSON.stringify({ client_name: "stolen" }),
      headers: { "Content-Type": "application/json", Cookie: sessionCookie },
      method: "PATCH",
    });
    assert.equal(anonResp.status, 403);

    // Pre-registered seed → 403 forbidden.
    const seedResp = await fetch(`${asUrl}/oauth/register/pdpp-web-dashboard`, {
      body: JSON.stringify({ client_name: "renamed seed" }),
      headers: { "Content-Type": "application/json", Cookie: sessionCookie },
      method: "PATCH",
    });
    assert.equal(seedResp.status, 403);

    // Unauthenticated → not 200 (owner-session-gated).
    const noAuthResp = await fetch(`${asUrl}/oauth/register/${encodeURIComponent(clientId)}`, {
      body: JSON.stringify({ client_name: "noauth" }),
      headers: { "Content-Type": "application/json" },
      method: "PATCH",
    });
    assert.notEqual(noAuthResp.status, 200);
  });
});

// ── 10.C.2 per-client token listing + 10.C.3 per-token revoke ────────────────

test("10.C.2/10.C.3 per-client token listing exposes no bearer; per-token revoke targets one bearer", async () => {
  await withServer(async ({ asUrl }) => {
    const sessionCookie = await login(asUrl);
    const registered = await registerClient(
      asUrl,
      {
        client_name: "multi-token client",
        token_endpoint_auth_method: "none",
      },
      sessionCookie
    );
    const clientId = registered.body.client_id;

    // Issue two bearers against the same client so active_token_count > 1.
    const tokenA = await issueOwnerTokenViaDeviceFlow(asUrl, clientId, sessionCookie);
    const tokenB = await issueOwnerTokenViaDeviceFlow(asUrl, clientId, sessionCookie);
    assert.ok(tokenA.access_token && tokenB.access_token);
    assert.notEqual(tokenA.access_token, tokenB.access_token);

    const listed = await listOwnerClients(asUrl, sessionCookie);
    const clientRow = listed.data.find((r) => r.client_id === clientId);
    assert.ok(clientRow, "expected the multi-token client to appear in the owner client list");
    assert.equal(clientRow.active_token_count, 2);

    // Per-client token listing.
    const tokensResp = await fetch(`${asUrl}/_ref/clients/${encodeURIComponent(clientId)}/tokens?owner=true`, {
      headers: { Cookie: sessionCookie },
    });
    assert.equal(tokensResp.status, 200);
    const tokens = (await tokensResp.json()) as OwnerClientTokenList;
    assert.equal(tokens.object, "list");
    assert.equal(tokens.data.length, 2);

    // SECURITY: no literal bearer leaks. Each row carries a non-bearer public
    // id and issued/expiry facts, never the raw access_token.
    const serialized = JSON.stringify(tokens);
    assert.ok(!serialized.includes(tokenA.access_token), "listing must not contain bearer A");
    assert.ok(!serialized.includes(tokenB.access_token), "listing must not contain bearer B");
    for (const row of tokens.data) {
      assert.equal(row.object, "owner_client_token");
      assert.equal(typeof row.token_id_public, "string");
      assert.ok(row.token_id_public.startsWith("tok_"));
      assert.ok(!("token_id" in row), "no raw token_id field may be present");
      assert.notEqual(row.token_id_public, tokenA.access_token);
      assert.notEqual(row.token_id_public, tokenB.access_token);
      assert.ok("created_at" in row);
      assert.ok("expires_at" in row);
    }

    // The `owner=true` requirement mirrors ref.clients.list.
    const missingOwner = await fetch(`${asUrl}/_ref/clients/${encodeURIComponent(clientId)}/tokens`, {
      headers: { Cookie: sessionCookie },
    });
    assert.equal(missingOwner.status, 400);

    // Revoke exactly ONE token by its public id.
    // biome-ignore lint/style/useDestructuring: the property access names the fixture value at its point of use.
    const firstToken = tokens.data[0];
    assert.ok(firstToken, "expected at least one token row");
    const targetPublicId = firstToken.token_id_public;
    const revokeResp = await fetch(
      `${asUrl}/_ref/clients/${encodeURIComponent(clientId)}/tokens/${encodeURIComponent(targetPublicId)}`,
      { headers: { Cookie: sessionCookie }, method: "DELETE" }
    );
    assert.equal(revokeResp.status, 200);
    const revokeBody = (await revokeResp.json()) as RevokeResult;
    assert.equal(revokeBody.revoked, true);
    assert.equal(revokeBody.token_id_public, targetPublicId);

    // Exactly one bearer is now inactive; the client itself and its other
    // bearer remain (revoke did NOT cascade the whole client).
    const afterList = await fetch(`${asUrl}/_ref/clients/${encodeURIComponent(clientId)}/tokens?owner=true`, {
      headers: { Cookie: sessionCookie },
    });
    const afterTokens = (await afterList.json()) as OwnerClientTokenList;
    assert.equal(afterTokens.data.length, 1, "one active token should remain after per-token revoke");
    assert.notEqual(afterTokens.data[0]?.token_id_public, targetPublicId);

    const clientStillListed = await listOwnerClients(asUrl, sessionCookie);
    assert.ok(
      clientStillListed.data.some((r) => r.client_id === clientId),
      "per-token revoke must not delete the client"
    );

    // Confirm via introspection: the two bearers now split active/inactive.
    const introA = await introspect(asUrl, tokenA.access_token);
    const introB = await introspect(asUrl, tokenB.access_token);
    const activeCount = [introA.active, introB.active].filter(Boolean).length;
    assert.equal(activeCount, 1, "exactly one of the two bearers should remain active");

    // Idempotent re-revoke of the same public id → revoked:false.
    const reRevoke = await fetch(
      `${asUrl}/_ref/clients/${encodeURIComponent(clientId)}/tokens/${encodeURIComponent(targetPublicId)}`,
      { headers: { Cookie: sessionCookie }, method: "DELETE" }
    );
    assert.equal(reRevoke.status, 200);
    assert.equal(((await reRevoke.json()) as RevokeResult).revoked, false);
  });
});

test("10.C.2/10.C.3 token listing + revoke are owner-scoped (cross-owner and unknown clients rejected)", async () => {
  await withServer(async ({ asUrl }) => {
    const sessionCookie = await login(asUrl);

    // Anonymous client (not owned by the session subject).
    const anon = await registerClient(asUrl, { client_name: "anon", token_endpoint_auth_method: "none" });
    const anonClientId = anon.body.client_id;

    const listResp = await fetch(`${asUrl}/_ref/clients/${encodeURIComponent(anonClientId)}/tokens?owner=true`, {
      headers: { Cookie: sessionCookie },
    });
    assert.equal(listResp.status, 403, "listing another owner's client tokens must be forbidden");

    const revokeResp = await fetch(`${asUrl}/_ref/clients/${encodeURIComponent(anonClientId)}/tokens/tok_whatever`, {
      headers: { Cookie: sessionCookie },
      method: "DELETE",
    });
    assert.equal(revokeResp.status, 403);

    // Unknown client → 404.
    const unknownResp = await fetch(`${asUrl}/_ref/clients/cli_does_not_exist/tokens?owner=true`, {
      headers: { Cookie: sessionCookie },
    });
    assert.equal(unknownResp.status, 404);

    // Unauthenticated → not 200 (owner-session-gated).
    const noAuth = await fetch(`${asUrl}/_ref/clients/${encodeURIComponent(anonClientId)}/tokens?owner=true`);
    assert.notEqual(noAuth.status, 200);
  });
});

// ── 10.C.4 grant-package count ───────────────────────────────────────────────

test("10.C.4 GET /_ref/grant-packages/count returns the total without paging the list", async () => {
  await withServer(async ({ asUrl }) => {
    const sessionCookie = await login(asUrl);

    const zero = await fetch(`${asUrl}/_ref/grant-packages/count`, { headers: { Cookie: sessionCookie } });
    assert.equal(zero.status, 200);
    const zeroBody = (await zero.json()) as { object?: string; count?: number };
    assert.equal(zeroBody.object, "grant_package_count");
    assert.equal(zeroBody.count, 0);

    // Seed two package rows directly (the runtime consent flow is out of scope
    // for a contract test; the count reads the same table the list pages).
    const now = new Date().toISOString();
    const db = getDb();
    for (const pid of ["gpkg_count_a", "gpkg_count_b"]) {
      const grantId = `${pid}_grant`;
      db.prepare(`
        INSERT INTO grants(grant_id, subject_id, client_id, storage_binding_json, grant_json,
          access_mode, status, consumed, issued_at, expires_at, trace_id, scenario_id)
        VALUES (?, ?, 'cli_x', ?, ?, 'continuous', 'active', 0, ?, NULL, 't', 's')
      `).run(
        grantId,
        TEST_SUBJECT,
        JSON.stringify({ connector_id: "spotify" }),
        JSON.stringify({
          access_mode: "continuous",
          client: { client_id: "cli_x" },
          grant_id: grantId,
          issued_at: now,
          source: { id: "https://registry.pdpp.dev/connectors/spotify", kind: "connector" },
          source_declaration: { version: "reference.source-declaration.test.v1" },
          streams: [],
          subject: { id: TEST_SUBJECT },
          version: "0.1.0",
        }),
        now
      );
      db.prepare(`
        INSERT INTO grant_packages(package_id, subject_id, client_id, status, package_json,
          trace_id, scenario_id, created_at, approved_at, revoked_at)
        VALUES (?, ?, 'cli_x', 'active', ?, 't', 's', ?, ?, NULL)
      `).run(
        pid,
        TEST_SUBJECT,
        JSON.stringify({
          approved_source_count: 1,
          client: { client_display: null, client_id: "cli_x", registration_mode: "dynamic" },
          package_id: pid,
          source_bounded_child_grants: true,
          subject: { id: TEST_SUBJECT },
          version: "reference.mcp_package.v2",
        }),
        now,
        now
      );
      db.prepare(`
        INSERT INTO grant_package_members(package_id, grant_id, token_id, source_json, status, added_at, revoked_at)
        VALUES (?, ?, ?, ?, 'active', ?, NULL)
      `).run(
        pid,
        grantId,
        `${pid}_token`,
        JSON.stringify({ id: "https://registry.pdpp.dev/connectors/spotify", kind: "connector" }),
        now
      );
    }

    const two = await fetch(`${asUrl}/_ref/grant-packages/count`, { headers: { Cookie: sessionCookie } });
    assert.equal(two.status, 200);
    assert.equal(((await two.json()) as { count?: number }).count, 2);

    // The count matches the length of the (bounded) list surface.
    const listResp = await fetch(`${asUrl}/_ref/grant-packages`, { headers: { Cookie: sessionCookie } });
    const list = (await listResp.json()) as { data: unknown[] };
    assert.equal(list.data.length, 2, "count should agree with the list length for this small fixture");

    // Owner-session-gated.
    const noAuth = await fetch(`${asUrl}/_ref/grant-packages/count`);
    assert.notEqual(noAuth.status, 200);

    // "count" must not be captured as a package id by the /:id route.
    const notAnId = await fetch(`${asUrl}/_ref/grant-packages/count`, { headers: { Cookie: sessionCookie } });
    const notAnIdBody = (await notAnId.json()) as { object?: string };
    assert.equal(notAnIdBody.object, "grant_package_count");
    assert.ok(!("package_id" in notAnIdBody));
  });
});
