// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { startServer } from "../server/index.ts";

const REGEXP_1 = /<input type="hidden" name="_csrf" value="([^"]+)"\s*\/>/;

const TEST_PASSWORD = "dcr-owner-session-public-origin-password";
const TEST_SUBJECT = "owner_public_origin_subject";
const DEFAULT_LOCAL_DCR_INITIAL_ACCESS_TOKEN = "pdpp-reference-local-initial-access-token";
// A hostname that isLocalOrPrivateRequestOrigin will NOT classify as
// local/private — simulates the real deployed shape where a reverse proxy
// sets X-Forwarded-Host to the console's public hostname.
const PUBLIC_FORWARDED_HOST = "console.example.com";

/**
 * `server/index.js` is untyped JS (allowJs, checkJs:false) under server/**,
 * forbidden to touch. Same boundary-cast pattern as dcr-per-owner-token.test.ts.
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
  ownerAuthPassword?: string;
  ownerAuthSubjectId?: string;
  quiet?: boolean;
  rsPort?: number;
}

const typedStartServer = startServer as unknown as (opts: StartServerOptions) => Promise<ClosableServer>;

interface RegisterClientBody {
  client_id?: string;
  client_name?: string;
  error?: string;
  error_description?: string;
}

interface DeviceAuthorizationBody {
  device_code?: string;
  user_code?: string;
}

interface DeviceTokenBody {
  access_token?: string;
  token_type?: string;
}

interface IntrospectionBody {
  active?: boolean;
  client_id?: string;
  pdpp_token_kind?: string;
  subject_id?: string;
}

interface FetchJsonResult<T> {
  body: T;
  status: number;
}

async function fetchJson<T>(url: string, opts: RequestInit = {}): Promise<FetchJsonResult<T>> {
  const resp = await fetch(url, opts);
  const rawBody = await resp.text();
  let body: T;
  try {
    body = JSON.parse(rawBody) as T;
  } catch (err) {
    throw new Error(
      `${url} returned non-JSON (${resp.status}, ${resp.headers.get("content-type") ?? "unknown"}): ${rawBody.slice(0, 200)}`,
      { cause: err }
    );
  }
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
    ownerAuthPassword: TEST_PASSWORD,
    ownerAuthSubjectId: TEST_SUBJECT,
    quiet: true,
    rsPort: 0,
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

async function fetchCsrfFromForm(asUrl: string, path: string): Promise<CsrfFromForm> {
  const resp = await fetch(`${asUrl}${path}`, {
    headers: { Accept: "text/html" },
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

/**
 * Reproduces exactly what the console dashboard's `/deployment/tokens` form
 * action sends: a same-origin-to-the-AS server-to-server POST carrying the
 * forwarded owner-session cookie, behind a reverse proxy that sets
 * X-Forwarded-Host to the console's real public hostname. `bearer` mirrors
 * whichever `Authorization` header (if any) `startOwnerBootstrapFlow` sends.
 */
async function registerAsDashboardFormAction(
  asUrl: string,
  clientName: string,
  sessionCookie: string,
  bearer?: string
): Promise<FetchJsonResult<RegisterClientBody>> {
  return await fetchJson<RegisterClientBody>(`${asUrl}/oauth/register`, {
    body: JSON.stringify({
      client_name: clientName,
      token_endpoint_auth_method: "none",
    }),
    headers: {
      "Content-Type": "application/json",
      Cookie: sessionCookie,
      "X-Forwarded-Host": PUBLIC_FORWARDED_HOST,
      "X-Forwarded-Proto": "https",
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    method: "POST",
  });
}

async function issueOwnerTokenViaDashboardFlow(
  asUrl: string,
  clientId: string,
  sessionCookie: string
): Promise<string> {
  const device = await fetchJson<DeviceAuthorizationBody>(`${asUrl}/oauth/device_authorization`, {
    body: JSON.stringify({ client_id: clientId }),
    headers: { "Content-Type": "application/json", Cookie: sessionCookie },
    method: "POST",
  });
  assert.equal(device.status, 200);
  assert.ok(device.body.device_code);
  assert.ok(device.body.user_code);

  const approval = await fetch(`${asUrl}/device/approve`, {
    body: JSON.stringify({ user_code: device.body.user_code }),
    headers: { "Content-Type": "application/json", Cookie: sessionCookie },
    method: "POST",
  });
  assert.equal(approval.status, 200);

  const token = await fetchJson<DeviceTokenBody>(`${asUrl}/oauth/token`, {
    body: JSON.stringify({
      client_id: clientId,
      device_code: device.body.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
    headers: { "Content-Type": "application/json", Cookie: sessionCookie },
    method: "POST",
  });
  assert.equal(token.status, 200);
  assert.equal(token.body.token_type, "Bearer");
  assert.ok(token.body.access_token);
  return token.body.access_token;
}

async function introspectToken(asUrl: string, token: string): Promise<IntrospectionBody> {
  const result = await fetchJson<IntrospectionBody>(`${asUrl}/introspect`, {
    body: JSON.stringify({ token }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(result.status, 200);
  return result.body;
}

test("dashboard form-action DCR: the reference-local IAT bearer fails from a public request origin (pre-fix reproduction)", async () => {
  await withServer(async ({ asUrl }) => {
    const sessionCookie = await login(asUrl);

    // No dynamicClientRegistrationInitialAccessTokens override is passed to
    // startServer, so the AS falls back to DEFAULT_LOCAL_DCR_INITIAL_ACCESS_TOKEN
    // — the exact value the console's old startOwnerBootstrapFlow sent as a
    // bearer on every /oauth/register call, including this dashboard path.
    const result = await registerAsDashboardFormAction(
      asUrl,
      "laptop-export",
      sessionCookie,
      DEFAULT_LOCAL_DCR_INITIAL_ACCESS_TOKEN
    );

    // Public-origin filtering (resolveDynamicClientRegistrationInitialAccessTokensForRequest)
    // strips the local-only default for any non-local/private request origin,
    // so the bearer is rejected as an invalid initial access token — this is
    // the exact failure the dashboard's real form action hit in production
    // (public console origin, X-Forwarded-Host set by the reverse proxy).
    assert.equal(result.status, 401, "the local-default bearer must be rejected from a public request origin");
    assert.equal(result.body.error, "invalid_client");
  });
});

test("dashboard form-action DCR: owner-session mode succeeds from a public request origin with no bearer (post-fix)", async () => {
  await withServer(async ({ asUrl }) => {
    const sessionCookie = await login(asUrl);

    // The fixed startOwnerBootstrapFlow sends no Authorization header at all —
    // registration must authenticate purely via the forwarded owner-session
    // cookie, exercising the AS's owner_session registration mode
    // (executeAsDcrRegister: ownerSessionSubjectId set, no bearer needed).
    const result = await registerAsDashboardFormAction(asUrl, "laptop-export", sessionCookie);

    assert.equal(result.status, 201, "owner-session registration must succeed with no bearer");
    assert.equal(result.body.client_name, "laptop-export");
    assert.ok(result.body.client_id, "registration must return a client_id");

    // Owner attribution: the registered client must show up in this owner's
    // scoped listing — proving issuer_subject_id was stamped from the session,
    // not left unset (which would make it indistinguishable from an anonymous
    // public registration).
    const listResp = await fetch(`${asUrl}/_ref/clients?owner=true`, {
      headers: { Cookie: sessionCookie },
    });
    assert.equal(listResp.status, 200);
    const listed = (await listResp.json()) as { data: { client_id: string }[] };
    assert.ok(
      listed.data.some((row) => row.client_id === result.body.client_id),
      "owner-session-registered client must appear in this owner's client listing"
    );

    // Continue through the same JSON BFF sequence as issueOwnerTokenAction:
    // device authorization, owner-session approval, and RFC 8628 token
    // exchange. This keeps the test at the route boundary rather than only
    // proving that DCR returns a client id.
    const accessToken = await issueOwnerTokenViaDashboardFlow(asUrl, result.body.client_id, sessionCookie);
    const introspection = await introspectToken(asUrl, accessToken);
    assert.equal(introspection.active, true);
    assert.equal(introspection.client_id, result.body.client_id);
    assert.equal(introspection.pdpp_token_kind, "owner");
    assert.equal(introspection.subject_id, TEST_SUBJECT);
  });
});

test("public-origin DCR still rejects an invalid bearer without an owner session", async () => {
  await withServer(async ({ asUrl }) => {
    const result = await registerAsDashboardFormAction(
      asUrl,
      "anonymous-invalid-bearer",
      "",
      "not-a-valid-initial-access-token"
    );
    assert.equal(result.status, 401);
    assert.equal(result.body.error, "invalid_client");
  });
});

test("public-origin DCR without a session remains public and unowned", async () => {
  await withServer(async ({ asUrl }) => {
    // An unauthenticated public request (no owner-session cookie, no bearer)
    // must not silently ride owner-session registration mode. It takes the
    // public self-registration path, with no owner attribution.
    const result = await registerAsDashboardFormAction(asUrl, "anonymous-public-attempt", "");
    assert.equal(result.status, 201, "anonymous public DCR is still allowed by default (unchanged behavior)");
    assert.ok(result.body.client_id);

    const listResp = await fetch(`${asUrl}/_ref/clients?owner=true`, {
      headers: { Cookie: await login(asUrl) },
    });
    const listed = (await listResp.json()) as { data: { client_id: string }[] };
    assert.ok(
      !listed.data.some((row) => row.client_id === result.body.client_id),
      "an anonymous public registration must never appear in an owner's scoped client listing"
    );
  });
});
