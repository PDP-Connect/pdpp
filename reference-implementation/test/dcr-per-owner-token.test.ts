// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { getDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { introspectionHeaders } from "./helpers/introspection.ts";
import { TEST_INTROSPECTION_SERVER_OPTS } from "./helpers/introspection-test-credentials.ts";

const REGEXP_1 = /<input type="hidden" name="_csrf" value="([^"]+)"\s*\/>/;

const TEST_PASSWORD = "dcr-owner-token-test-password";
const TEST_SUBJECT = "owner_test_subject";
const TEST_DCR_INITIAL_ACCESS_TOKEN = "pdpp-reference-test-initial-access-token";

/**
 * `server/index.js` (startServer) and `server/db.js` (getDb) are untyped JS
 * (allowJs, checkJs:false) under server/**, forbidden to touch. Same
 * boundary-cast pattern established in control-plane.test.ts and
 * run-interaction-stream-routes.test.ts: model the real call/return shapes
 * locally from the source and cast the untyped imports once, rather than
 * fighting incomplete structural inference at dozens of call sites.
 */
interface ClosableServer {
  asPort: number;
  asServer: { close: (cb: () => void) => void; closeAllConnections: () => void };
  rsServer: { close: (cb: () => void) => void; closeAllConnections: () => void };
}

interface StartServerOptions {
  asPort?: number;
  dbPath?: string;
  dynamicClientRegistrationInitialAccessTokens?: string[];
  introspectionCallerCredentials?: unknown;
  ownerAuthPassword?: string;
  ownerAuthSubjectId?: string;
  quiet?: boolean;
  rsIntrospectionCredentials?: unknown;
  rsPort?: number;
}

const typedStartServer = startServer as unknown as (opts: StartServerOptions) => Promise<ClosableServer>;

/**
 * `db.prepare(sql).run(...)` / `.get(...)` calls in this file only ever bind
 * positional params and read back rows the test itself constructed, so a
 * minimal `better-sqlite3`-shaped interface covers every call site here
 * without importing the real (also untyped) driver types. Same pattern as
 * control-plane.test.ts.
 */
interface PreparedStatement {
  get: (...params: unknown[]) => unknown;
  run: (...params: unknown[]) => unknown;
}

interface DbHandle {
  prepare: (sql: string) => PreparedStatement;
}

const typedGetDb = getDb as unknown as () => DbHandle;

interface GrantPackageRow {
  revoked_at: string | null;
  status: string;
}

interface TokenRow {
  revoked: number;
}

interface RefreshTokenRow {
  revoked_at: string | null;
  status: string;
}

interface OwnerClientSummary {
  active_token_count: number;
  client_id: string;
  client_name: string;
}

interface OwnerClientListBody {
  data: OwnerClientSummary[];
}

interface RegisterClientBody {
  client_id?: string;
  client_name?: string;
  client_uri?: string;
  logo_uri?: string;
  policy_uri?: string;
  tos_uri?: string;
}

interface DeviceAuthorizationBody {
  device_code: string;
  user_code: string;
}

interface DeviceTokenBody {
  access_token: string;
}

interface IntrospectBody {
  active: boolean;
  client_id?: string;
  inactive_reason?: string;
  pdpp_token_kind?: string;
  subject_id?: string;
}

interface FetchJsonResult<T> {
  body: T;
  status: number;
}

async function fetchJson<T>(url: string, opts: RequestInit = {}): Promise<FetchJsonResult<T>> {
  const resp = await fetch(url, opts);
  const body = (await resp.json()) as T;
  return { body, status: resp.status };
}

async function closeServer(server: ClosableServer): Promise<void> {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  const closeWithTimeout = (srv: ClosableServer["asServer"]) =>
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
  const server = await typedStartServer({
    asPort: 0,
    dbPath: ":memory:",
    dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
    ownerAuthPassword: TEST_PASSWORD,
    ownerAuthSubjectId: TEST_SUBJECT,
    quiet: true,
    rsPort: 0,
    ...TEST_INTROSPECTION_SERVER_OPTS,
  });
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

function findSetCookiePair(setCookies: string[], name: string): string | null {
  for (const header of setCookies) {
    // biome-ignore lint/style/useDestructuring: Indexed access expresses the protocol field position under test.
    const firstPair = header.split(";")[0];
    if (firstPair?.startsWith(`${name}=`)) {
      return firstPair;
    }
  }
  return null;
}

function extractCsrfFieldValue(html: string): string | null {
  const match = html.match(REGEXP_1);
  return match ? (match[1] ?? null) : null;
}

interface CsrfFromForm {
  csrfCookie: string | null;
  csrfField: string | null;
}

async function fetchCsrfFromForm(asUrl: string, path: string, sessionCookie = ""): Promise<CsrfFromForm> {
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
  assert.ok(csrf.csrfCookie, "login form should issue a csrf cookie");
  assert.ok(csrf.csrfField, "login form should embed a csrf field");
  const resp = await fetch(`${asUrl}/owner/login`, {
    body: new URLSearchParams({
      _csrf: csrf.csrfField,
      password: TEST_PASSWORD,
      return_to: "/deployment/tokens",
    }).toString(),
    headers: {
      Accept: "text/html",
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: csrf.csrfCookie,
    },
    method: "POST",
    redirect: "manual",
  });
  assert.equal(resp.status, 302);
  const sessionCookie = findSetCookiePair(getRawSetCookieList(resp), "pdpp_owner_session");
  assert.ok(sessionCookie, "login should issue owner session cookie");
  return sessionCookie;
}

async function registerClient(
  asUrl: string,
  body: Record<string, unknown>,
  cookie = ""
): Promise<FetchJsonResult<RegisterClientBody>> {
  return await fetchJson<RegisterClientBody>(`${asUrl}/oauth/register`, {
    body: JSON.stringify(body),
    headers: {
      Authorization: `Bearer ${TEST_DCR_INITIAL_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    method: "POST",
  });
}

async function listOwnerClients(asUrl: string, cookie: string): Promise<OwnerClientListBody> {
  const resp = await fetch(`${asUrl}/_ref/clients?owner=true`, {
    headers: { Cookie: cookie },
  });
  assert.equal(resp.status, 200);
  return (await resp.json()) as OwnerClientListBody;
}

async function issueOwnerTokenViaDeviceFlow(asUrl: string, clientId: string, cookie: string): Promise<DeviceTokenBody> {
  const deviceResp = await fetch(`${asUrl}/oauth/device_authorization`, {
    body: JSON.stringify({ client_id: clientId }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(deviceResp.status, 200);
  const device = (await deviceResp.json()) as DeviceAuthorizationBody;

  const approveResp = await fetch(`${asUrl}/device/approve`, {
    body: JSON.stringify({ subject_id: "attacker_ignored_when_owner_auth_enabled", user_code: device.user_code }),
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
  return (await tokenResp.json()) as DeviceTokenBody;
}

async function introspect(asUrl: string, token: string): Promise<IntrospectBody> {
  const resp = await fetch(`${asUrl}/introspect`, {
    body: JSON.stringify({ token }),
    headers: introspectionHeaders(),
    method: "POST",
  });
  assert.equal(resp.status, 200);
  return (await resp.json()) as IntrospectBody;
}

interface SeededPackageState {
  packageId: string;
  packageTokenId: string;
  refreshTokenHash: string;
}

function seedActiveHostedMcpPackageForClient(clientId: string): SeededPackageState {
  const now = new Date().toISOString();
  const packageId = "gpkg_dcr_delete_cascade";
  const packageTokenId = "tok_dcr_delete_cascade";
  const refreshTokenHash = "rt_hash_dcr_delete_cascade";
  const db = typedGetDb();

  db.prepare(`
    INSERT INTO grant_packages(
      package_id, subject_id, client_id, status, package_json,
      trace_id, scenario_id, created_at, approved_at, revoked_at
    ) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, NULL)
  `).run(
    packageId,
    TEST_SUBJECT,
    clientId,
    JSON.stringify({ package_id: packageId, version: "test" }),
    "trace_dcr_delete_cascade",
    "scenario_dcr_delete_cascade",
    now,
    now
  );

  db.prepare(`
    INSERT INTO tokens(token_id, grant_id, package_id, subject_id, client_id, token_kind, expires_at, revoked)
    VALUES (?, NULL, ?, ?, ?, 'mcp_package', NULL, FALSE)
  `).run(packageTokenId, packageId, TEST_SUBJECT, clientId);

  db.prepare(`
    INSERT INTO oauth_refresh_tokens(
      refresh_token_hash, family_id, generation, parent_generation,
      client_id, grant_id, package_id, subject_id, status,
      created_at, expires_at, last_used_at, superseded_at, revoked_at
    ) VALUES (?, ?, 0, NULL, ?, NULL, ?, ?, 'active', ?, NULL, NULL, NULL, NULL)
  `).run(refreshTokenHash, "rtf_dcr_delete_cascade", clientId, packageId, TEST_SUBJECT, now);

  return { packageId, packageTokenId, refreshTokenHash };
}

test("DCR per owner token: owner-issued clients list and cascade-revoke owner bearer", async () => {
  await withServer(async ({ asUrl }) => {
    const sessionCookie = await login(asUrl);

    const ownerRegistered = await registerClient(
      asUrl,
      {
        client_name: "laptop-export",
        issuer_subject_id: "body_must_not_win",
        token_endpoint_auth_method: "none",
      },
      sessionCookie
    );
    assert.equal(ownerRegistered.status, 201);
    assert.equal(ownerRegistered.body.client_name, "laptop-export");
    assert.ok(ownerRegistered.body.client_id);
    const ownerClientId = ownerRegistered.body.client_id;

    const anonymousRegistered = await registerClient(asUrl, {
      client_name: "Anonymous extension attempt",
      issuer_subject_id: "body_must_be_dropped",
      token_endpoint_auth_method: "none",
    });
    assert.equal(anonymousRegistered.status, 201);
    assert.ok(anonymousRegistered.body.client_id);
    const anonymousClientId = anonymousRegistered.body.client_id;

    const listed = await listOwnerClients(asUrl, sessionCookie);
    const clientIds = listed.data.map((row) => row.client_id);
    assert.ok(clientIds.includes(ownerClientId));
    assert.ok(!clientIds.includes(anonymousClientId));
    const listedOwnerClient = listed.data.find((row) => row.client_id === ownerClientId);
    assert.ok(listedOwnerClient, "owner client must appear in owner client listing");
    assert.equal(listedOwnerClient.client_name, "laptop-export");
    assert.equal(listedOwnerClient.active_token_count, 0);

    const token = await issueOwnerTokenViaDeviceFlow(asUrl, ownerClientId, sessionCookie);
    assert.ok(token.access_token);
    const active = await introspect(asUrl, token.access_token);
    assert.equal(active.active, true);
    assert.equal(active.pdpp_token_kind, "owner");
    assert.equal(active.subject_id, TEST_SUBJECT);
    assert.equal(active.client_id, ownerClientId);

    const listedAfterIssue = await listOwnerClients(asUrl, sessionCookie);
    const issuedClient = listedAfterIssue.data.find((row) => row.client_id === ownerClientId);
    assert.ok(issuedClient, "owner client must still appear in listing after token issuance");
    assert.equal(issuedClient.client_name, "laptop-export");
    assert.equal(issuedClient.active_token_count, 1);

    const packageState = seedActiveHostedMcpPackageForClient(ownerClientId);

    const deleteResp = await fetch(`${asUrl}/oauth/register/${encodeURIComponent(ownerClientId)}`, {
      headers: { Cookie: sessionCookie },
      method: "DELETE",
    });
    assert.equal(deleteResp.status, 204);

    const inactive = await introspect(asUrl, token.access_token);
    assert.equal(inactive.active, false);
    assert.equal(inactive.inactive_reason, "token_revoked");

    const listedAfterDelete = await listOwnerClients(asUrl, sessionCookie);
    assert.ok(!listedAfterDelete.data.some((row) => row.client_id === ownerClientId));

    const revokedPackage = typedGetDb()
      .prepare("SELECT status, revoked_at FROM grant_packages WHERE package_id = ?")
      .get(packageState.packageId) as GrantPackageRow;
    assert.equal(revokedPackage.status, "revoked");
    assert.ok(revokedPackage.revoked_at, "client deletion must revoke package row");

    const revokedPackageToken = typedGetDb()
      .prepare("SELECT revoked FROM tokens WHERE token_id = ?")
      .get(packageState.packageTokenId) as TokenRow;
    assert.equal(revokedPackageToken.revoked, 1);

    const revokedRefresh = typedGetDb()
      .prepare("SELECT status, revoked_at FROM oauth_refresh_tokens WHERE refresh_token_hash = ?")
      .get(packageState.refreshTokenHash) as RefreshTokenRow;
    assert.equal(revokedRefresh.status, "revoked");
    assert.ok(revokedRefresh.revoked_at, "client deletion must revoke package refresh token");

    const deleteAgainResp = await fetch(`${asUrl}/oauth/register/${encodeURIComponent(ownerClientId)}`, {
      headers: { Cookie: sessionCookie },
      method: "DELETE",
    });
    assert.equal(deleteAgainResp.status, 404);

    const deleteAnonymousResp = await fetch(`${asUrl}/oauth/register/${encodeURIComponent(anonymousClientId)}`, {
      headers: { Cookie: sessionCookie },
      method: "DELETE",
    });
    assert.equal(deleteAnonymousResp.status, 403);

    const deletePreRegisteredResp = await fetch(`${asUrl}/oauth/register/pdpp-web-dashboard`, {
      headers: { Cookie: sessionCookie },
      method: "DELETE",
    });
    assert.equal(deletePreRegisteredResp.status, 403);
  });
});

test("owner device approval binds a public dynamic client to the approving owner for revoke", async () => {
  await withServer(async ({ asUrl }) => {
    const sessionCookie = await login(asUrl);

    const registered = await registerClient(asUrl, {
      client_name: "Daisy local owner agent",
      token_endpoint_auth_method: "none",
    });
    assert.equal(registered.status, 201);
    assert.ok(registered.body.client_id);
    const registeredClientId = registered.body.client_id;

    const listedBeforeApproval = await listOwnerClients(asUrl, sessionCookie);
    assert.ok(!listedBeforeApproval.data.some((row) => row.client_id === registeredClientId));

    const token = await issueOwnerTokenViaDeviceFlow(asUrl, registeredClientId, sessionCookie);
    assert.ok(token.access_token);
    const active = await introspect(asUrl, token.access_token);
    assert.equal(active.active, true);
    assert.equal(active.pdpp_token_kind, "owner");
    assert.equal(active.subject_id, TEST_SUBJECT);
    assert.equal(active.client_id, registeredClientId);

    const listedAfterApproval = await listOwnerClients(asUrl, sessionCookie);
    const ownerClient = listedAfterApproval.data.find((row) => row.client_id === registeredClientId);
    assert.ok(ownerClient, "approval should bind the dynamic client to the approving owner");
    assert.equal(ownerClient.client_name, "Daisy local owner agent");
    assert.equal(ownerClient.active_token_count, 1);

    const deleteResp = await fetch(`${asUrl}/oauth/register/${encodeURIComponent(registeredClientId)}`, {
      headers: { Cookie: sessionCookie },
      method: "DELETE",
    });
    assert.equal(deleteResp.status, 204);

    const inactive = await introspect(asUrl, token.access_token);
    assert.equal(inactive.active, false);
    assert.equal(inactive.inactive_reason, "token_revoked");
  });
});

// ── DCR optional URI seeding from AS_PUBLIC_URL ──────────────────────────────

test("DCR seeds client_uri / logo_uri / policy_uri / tos_uri from AS_PUBLIC_URL when registrant omits them", async () => {
  const prior = process.env.AS_PUBLIC_URL;
  process.env.AS_PUBLIC_URL = "https://as.example.com";
  try {
    await withServer(async ({ asUrl }) => {
      const result = await registerClient(asUrl, {
        client_name: "minimal-client",
        token_endpoint_auth_method: "none",
      });
      assert.equal(result.status, 201, "registration must succeed");
      assert.equal(result.body.client_uri, "https://as.example.com", "client_uri must be seeded from AS_PUBLIC_URL");
      assert.equal(result.body.logo_uri, "https://as.example.com/icon.svg", "logo_uri must be seeded as base/icon.svg");
      assert.equal(result.body.policy_uri, "https://as.example.com", "policy_uri must be seeded from AS_PUBLIC_URL");
      assert.equal(result.body.tos_uri, "https://as.example.com", "tos_uri must be seeded from AS_PUBLIC_URL");
    });
  } finally {
    if (prior === undefined) {
      delete process.env.AS_PUBLIC_URL;
    } else {
      process.env.AS_PUBLIC_URL = prior;
    }
  }
});

test("DCR does not override explicit client_uri / logo_uri / policy_uri / tos_uri from registrant", async () => {
  const prior = process.env.AS_PUBLIC_URL;
  process.env.AS_PUBLIC_URL = "https://as.example.com";
  try {
    await withServer(async ({ asUrl }) => {
      const result = await registerClient(asUrl, {
        client_name: "explicit-uri-client",
        client_uri: "https://my-client.example.com",
        logo_uri: "https://my-client.example.com/logo.png",
        policy_uri: "https://my-client.example.com/privacy",
        token_endpoint_auth_method: "none",
        tos_uri: "https://my-client.example.com/terms",
      });
      assert.equal(result.status, 201, "registration must succeed");
      assert.equal(
        result.body.client_uri,
        "https://my-client.example.com",
        "explicit client_uri must not be overridden"
      );
      assert.equal(
        result.body.logo_uri,
        "https://my-client.example.com/logo.png",
        "explicit logo_uri must not be overridden"
      );
      assert.equal(
        result.body.policy_uri,
        "https://my-client.example.com/privacy",
        "explicit policy_uri must not be overridden"
      );
      assert.equal(
        result.body.tos_uri,
        "https://my-client.example.com/terms",
        "explicit tos_uri must not be overridden"
      );
    });
  } finally {
    if (prior === undefined) {
      delete process.env.AS_PUBLIC_URL;
    } else {
      process.env.AS_PUBLIC_URL = prior;
    }
  }
});

test("DCR omits URI fields when AS_PUBLIC_URL is not set", async () => {
  const prior = process.env.AS_PUBLIC_URL;
  delete process.env.AS_PUBLIC_URL;
  try {
    await withServer(async ({ asUrl }) => {
      const result = await registerClient(asUrl, {
        client_name: "no-public-url-client",
        token_endpoint_auth_method: "none",
      });
      assert.equal(result.status, 201, "registration must succeed");
      assert.equal(result.body.client_uri, undefined, "client_uri must be absent when AS_PUBLIC_URL unset");
      assert.equal(result.body.logo_uri, undefined, "logo_uri must be absent when AS_PUBLIC_URL unset");
      assert.equal(result.body.policy_uri, undefined, "policy_uri must be absent when AS_PUBLIC_URL unset");
      assert.equal(result.body.tos_uri, undefined, "tos_uri must be absent when AS_PUBLIC_URL unset");
    });
  } finally {
    if (prior === undefined) {
      delete process.env.AS_PUBLIC_URL;
    } else {
      process.env.AS_PUBLIC_URL = prior;
    }
  }
});
