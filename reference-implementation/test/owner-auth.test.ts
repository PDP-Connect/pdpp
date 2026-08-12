// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { getOwnerDeviceAuthorizationByUserCode, initiateOwnerDeviceAuthorization } from "../server/auth.ts";
import { canonicalConnectorKey } from "../server/connector-key.ts";
import { closeDb, getDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, "..");
const SPOTIFY_MANIFEST = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, "manifests/spotify.json"), "utf8")) as {
  connector_id: string;
  [key: string]: unknown;
};

const TEST_DCR_INITIAL_ACCESS_TOKEN = "pdpp-reference-test-initial-access-token";
const TEST_PASSWORD = "placeholder-test-password";
const CUSTOM_SUBJECT_ID = "owner_testing_custom";
const CSRF_HIDDEN_FIELD_PATTERN = /<input type="hidden" name="_csrf" value="([^"]+)"\s*\/>/;

interface CloseableServer {
  close: (callback?: (err?: Error) => void) => unknown;
  closeAllConnections: () => void;
}

interface DrainableController {
  drainActiveRuns?: (timeoutMs: number) => Promise<unknown>;
}

type StartedServer = Awaited<ReturnType<typeof startServer>> & {
  asServer: CloseableServer;
  rsServer: CloseableServer;
  schedulerManager?: { stop?: () => void };
  abortStartupBackfill?: (reason: string) => void;
  startupBackfillDone?: Promise<unknown>;
  controller?: DrainableController;
};

async function closeServer(server: StartedServer): Promise<void> {
  server.schedulerManager?.stop?.();
  server.abortStartupBackfill?.("test shutdown");
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  const backfillDone = server.startupBackfillDone
    ? new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2000);
        Promise.resolve(server.startupBackfillDone)
          .catch(() => undefined)
          .finally(() => {
            clearTimeout(timer);
            resolve();
          });
      })
    : Promise.resolve();
  const closeWithTimeout = (srv: CloseableServer) =>
    new Promise<void>((resolve) => {
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
    backfillDone,
    server.controller?.drainActiveRuns
      ? server.controller.drainActiveRuns(1000).catch(() => undefined)
      : Promise.resolve(),
  ]);
  closeDb();
}

async function withServer(
  opts: Record<string, unknown>,
  fn: (ctx: { asUrl: string; rsUrl: string }) => Promise<void>
): Promise<void> {
  const server = (await startServer({
    asPort: 0,
    dbPath: ":memory:",
    dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
    quiet: true,
    rsPort: 0,
    ...opts,
  })) as StartedServer;
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  try {
    await fn({ asUrl, rsUrl });
  } finally {
    await closeServer(server);
  }
}

async function startPendingConsent(asUrl: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const registerResp = await fetch(`${asUrl}/connectors`, {
    body: JSON.stringify(SPOTIFY_MANIFEST),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  if (!registerResp.ok) {
    const text = await registerResp.text();
    throw new Error(`connector registration failed: ${registerResp.status} ${text}`);
  }
  const resp = await fetch(`${asUrl}/oauth/par`, {
    body: JSON.stringify({
      authorization_details: [
        {
          access_mode: "single_use",
          purpose_code: "https://pdpp.dev/purpose/test",
          purpose_description: "test",
          source: { id: SPOTIFY_MANIFEST.connector_id, kind: "connector" },
          streams: [{ name: "top_artists" }],
          type: "https://pdpp.dev/data-access",
        },
      ],
      client_display: { name: "Longview" },
      client_id: "longview",
      ...overrides,
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`par failed: ${resp.status} ${text}`);
  }
  const body = (await resp.json()) as { request_uri?: string };
  if (!body.request_uri) {
    throw new Error(`par did not return request_uri: ${JSON.stringify(body)}`);
  }
  return body.request_uri;
}

function getRawSetCookieList(resp: Response): string[] {
  // node:fetch's Headers.getSetCookie() returns the full per-cookie list
  // (each value as a separate string) instead of the joined comma-list
  // that .get('set-cookie') yields.
  if (typeof resp.headers.getSetCookie === "function") {
    return resp.headers.getSetCookie();
  }
  const single = resp.headers.get("set-cookie");
  return single ? [single] : [];
}

function findSetCookiePair(setCookies: readonly string[], name: string): string | null {
  for (const header of setCookies) {
    const [firstPair] = header.split(";");
    if (firstPair?.startsWith(`${name}=`)) {
      return firstPair;
    }
  }
  return null;
}

function extractSessionCookie(setCookieList: readonly string[] | null | undefined): string | null {
  if (!setCookieList) {
    return null;
  }
  const list = Array.isArray(setCookieList) ? setCookieList : [setCookieList];
  return findSetCookiePair(list, "pdpp_owner_session");
}

function extractCsrfFieldValue(html: string): string | null {
  // The hidden field renderer in owner-csrf.ts emits exactly:
  //   <input type="hidden" name="_csrf" value="..." />
  const match = html.match(CSRF_HIDDEN_FIELD_PATTERN);
  return match?.[1] ?? null;
}

interface CsrfResult {
  csrfCookie: string | null;
  csrfField: string | null;
  html: string;
  status: number;
}

async function fetchCsrf(asUrl: string, path = "/owner/login"): Promise<CsrfResult> {
  const resp = await fetch(`${asUrl}${path}`, {
    headers: { Accept: "text/html" },
    redirect: "manual",
  });
  const setCookies = getRawSetCookieList(resp);
  const csrfCookie = findSetCookiePair(setCookies, "pdpp_owner_csrf");
  const html = await resp.text();
  const csrfField = extractCsrfFieldValue(html);
  return {
    csrfCookie,
    csrfField,
    html,
    status: resp.status,
  };
}

interface LoginResult {
  cookie: string | null;
  csrfCookie: string | null;
  csrfField: string | null;
  location: string | null;
  setCookies: string[];
  status: number;
}

async function login(asUrl: string, password: string, { returnTo = "/consent" } = {}): Promise<LoginResult> {
  const csrf = await fetchCsrf(asUrl, "/owner/login");
  const body = new URLSearchParams({ _csrf: csrf.csrfField || "", password, return_to: returnTo });
  const resp = await fetch(`${asUrl}/owner/login`, {
    body: body.toString(),
    headers: {
      Accept: "text/html",
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: csrf.csrfCookie || "",
    },
    method: "POST",
    redirect: "manual",
  });
  const setCookies = getRawSetCookieList(resp);
  const sessionCookie = extractSessionCookie(setCookies);
  return {
    cookie: sessionCookie,
    csrfCookie: csrf.csrfCookie,
    csrfField: csrf.csrfField,
    location: resp.headers.get("location"),
    setCookies,
    status: resp.status,
  };
}

interface HostedFormCsrfResult extends CsrfResult {
  setCookies: string[];
}

async function fetchHostedFormCsrf(
  asUrl: string,
  path: string,
  sessionCookie: string | null
): Promise<HostedFormCsrfResult> {
  const resp = await fetch(`${asUrl}${path}`, {
    headers: { Accept: "text/html", Cookie: sessionCookie || "" },
    redirect: "manual",
  });
  const setCookies = getRawSetCookieList(resp);
  const csrfCookie = findSetCookiePair(setCookies, "pdpp_owner_csrf");
  const html = await resp.text();
  const csrfField = extractCsrfFieldValue(html);
  return { csrfCookie, csrfField, html, setCookies, status: resp.status };
}

interface JsonResult {
  body: unknown;
  status: number;
}

async function fetchJson(url: string | URL, opts: RequestInit = {}): Promise<JsonResult> {
  const resp = await fetch(url, opts);
  const text = await resp.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { body, status: resp.status };
}

// ── 1. disabled: unchanged open local-dev behavior ───────────────────────────
test("owner-auth placeholder: when PDPP_OWNER_PASSWORD unset, /consent and /device remain open", async () => {
  await withServer({}, async ({ asUrl }) => {
    const loginPage = await fetch(`${asUrl}/owner/login`, {
      headers: { Accept: "text/html" },
      redirect: "manual",
    });
    assert.equal(loginPage.status, 200, "/owner/login should stay discoverable even when auth is disabled");
    const loginHtml = await loginPage.text();
    assert.ok(loginHtml.includes("owner access"), "renders owner-access landing copy");
    assert.ok(loginHtml.includes("disabled"), "explains that placeholder auth is disabled");
    assert.ok(loginHtml.includes("/device"), "offers a stable device-approval entry point");
    assert.ok(!loginHtml.includes("Owner password"), "does not render a password form when disabled");

    const requestUri = await startPendingConsent(asUrl);

    const consent = await fetch(`${asUrl}/consent?request_uri=${encodeURIComponent(requestUri)}`, {
      headers: { Accept: "text/html" },
      redirect: "manual",
    });
    assert.equal(consent.status, 200, "consent page should render directly");
    const consentText = await consent.text();
    assert.ok(consentText.includes("Consent request"), "renders consent body");
    assert.ok(consentText.includes("Longview"), "renders client details");

    const device = await initiateOwnerDeviceAuthorization("longview", { baseUrl: asUrl });
    const devicePage = await fetch(`${asUrl}/device?user_code=${device.user_code}`, {
      headers: { Accept: "text/html" },
      redirect: "manual",
    });
    assert.equal(devicePage.status, 200);
    const deviceText = await devicePage.text();
    assert.ok(deviceText.includes("Subject ID"), "unauth mode shows freeform subject id field");
  });
});

// ── 2. enabled: unauthenticated HTML requests redirect to /owner/login ────────
test("owner-auth placeholder: enabled — unauthenticated /consent and /device redirect to /owner/login", async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const requestUri = await startPendingConsent(asUrl);

    const consent = await fetch(`${asUrl}/consent?request_uri=${encodeURIComponent(requestUri)}`, {
      headers: { Accept: "text/html" },
      redirect: "manual",
    });
    assert.equal(consent.status, 302);
    const loc = consent.headers.get("location");
    assert.ok(loc?.startsWith("/owner/login?return_to="), `expected login redirect, got ${loc}`);
    assert.ok(loc, "expected a redirect location");
    assert.ok(loc.includes(encodeURIComponent("/consent")), "return_to points back to /consent");

    const device = await fetch(`${asUrl}/device`, {
      headers: { Accept: "text/html" },
      redirect: "manual",
    });
    assert.equal(device.status, 302);
    assert.ok(device.headers.get("location")?.startsWith("/owner/login?return_to="));

    const approveRefererPath = `/consent?request_uri=${encodeURIComponent(requestUri)}`;
    const approve = await fetch(`${asUrl}/consent/approve`, {
      body: new URLSearchParams({ request_uri: requestUri }).toString(),
      headers: {
        Accept: "text/html",
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: `${asUrl}${approveRefererPath}`,
      },
      method: "POST",
      redirect: "manual",
    });
    assert.equal(approve.status, 302);
    assert.ok(
      approve.headers.get("location")?.includes(encodeURIComponent(approveRefererPath)),
      "HTML POST redirects back to the originating consent page after login"
    );

    // non-HTML callers get 401 JSON, not a redirect
    const deviceJson = await fetch(`${asUrl}/device`, {
      headers: { Accept: "application/json" },
      redirect: "manual",
    });
    assert.equal(deviceJson.status, 401);
    const jsonBody = (await deviceJson.json()) as { error?: { code?: string } };
    assert.equal(jsonBody.error?.code, "owner_session_required");
  });
});

// ── 3. wrong password does not issue a session ───────────────────────────────
test("owner-auth placeholder: wrong password with valid CSRF returns 401 and issues no cookie", async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const csrf = await fetchCsrf(asUrl, "/owner/login");
    assert.ok(csrf.csrfField, "login GET embeds a CSRF token field");
    assert.ok(csrf.csrfCookie?.startsWith("pdpp_owner_csrf="), "login GET sets a CSRF cookie");

    const resp = await fetch(`${asUrl}/owner/login`, {
      body: new URLSearchParams({
        _csrf: csrf.csrfField,
        password: "wrong",
        return_to: "/consent",
      }).toString(),
      headers: {
        Accept: "text/html",
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: csrf.csrfCookie || "",
      },
      method: "POST",
      redirect: "manual",
    });
    assert.equal(resp.status, 401);
    const setCookies = getRawSetCookieList(resp);
    assert.ok(!findSetCookiePair(setCookies, "pdpp_owner_session"), "no session cookie on wrong password");
    const text = await resp.text();
    assert.ok(text.includes("Incorrect password"), "login page shows error");
  });
});

// ── 4. correct password issues a valid signed session cookie ─────────────────
test("owner-auth placeholder: correct password issues a session cookie and redirects to return_to", async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const { status, cookie, location } = await login(asUrl, TEST_PASSWORD);
    assert.equal(status, 302);
    assert.equal(location, "/consent");
    assert.ok(cookie?.startsWith("pdpp_owner_session="), "session cookie set");

    // An authenticated GET /consent with the same cookie no longer redirects.
    const requestUri = await startPendingConsent(asUrl);
    const resp = await fetch(`${asUrl}/consent?request_uri=${encodeURIComponent(requestUri)}`, {
      headers: { Accept: "text/html", Cookie: cookie || "" },
      redirect: "manual",
    });
    assert.equal(resp.status, 200);
    const text = await resp.text();
    assert.ok(text.includes("Consent request"));
    assert.ok(text.includes("Longview"));
  });
});

test("owner-auth placeholder: authenticated GET /owner/login becomes a signed-in landing page", async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const { cookie } = await login(asUrl, TEST_PASSWORD);
    const resp = await fetch(`${asUrl}/owner/login`, {
      headers: { Accept: "text/html", Cookie: cookie || "" },
      redirect: "manual",
    });
    assert.equal(resp.status, 200);
    const text = await resp.text();
    assert.ok(text.includes("Signed in"), "shows signed-in state");
    assert.ok(text.includes('href="/"'), "offers a path back to the owner console");
    assert.ok(text.includes("/device"), "offers a stable device approval entry point");
    assert.ok(text.includes("owner_local"), "shows the current owner subject");
  });
});

// ── 5. authenticated approval/deny/device flows work end-to-end ──────────────
test("owner-auth placeholder: authenticated /consent/approve issues a grant and token", async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const { cookie } = await login(asUrl, TEST_PASSWORD);
    const requestUri = await startPendingConsent(asUrl);

    const approveResp = await fetch(`${asUrl}/consent/approve`, {
      body: JSON.stringify({ request_uri: requestUri }),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Cookie: cookie || "",
      },
      method: "POST",
    });
    assert.equal(approveResp.status, 200);
    const body = (await approveResp.json()) as { grant_id?: string; token?: string };
    assert.ok(body.grant_id, "grant issued");
    assert.ok(body.token, "owner/app token issued");
    const tokenRows = getDb().prepare("SELECT subject_id FROM tokens WHERE grant_id = ?").all(body.grant_id) as {
      subject_id: string;
    }[];
    assert.ok(tokenRows.length >= 1);
    assert.equal(tokenRows[0]?.subject_id, "owner_local", "default subject used");
  });

  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const { cookie } = await login(asUrl, TEST_PASSWORD);
    const requestUri = await startPendingConsent(asUrl);

    const denyResp = await fetch(`${asUrl}/consent/deny`, {
      body: JSON.stringify({ request_uri: requestUri }),
      headers: {
        Accept: "text/html",
        "Content-Type": "application/json",
        Cookie: cookie || "",
      },
      method: "POST",
    });
    assert.equal(denyResp.status, 200, "deny succeeds with session");
  });

  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const { cookie } = await login(asUrl, TEST_PASSWORD);
    const device = await initiateOwnerDeviceAuthorization("longview", { baseUrl: asUrl });
    const userCode = device.user_code;
    assert.ok(typeof userCode === "string", "device authorization returns a user code");

    // Fetch the device approval page to capture the rendered CSRF token
    // and matching cookie. The signed token must be paired with the
    // matching cookie or the form POST is rejected.
    const csrf = await fetchHostedFormCsrf(asUrl, `/device?user_code=${encodeURIComponent(userCode)}`, cookie);
    const { csrfField } = csrf;
    assert.ok(typeof csrfField === "string", "/device GET embeds a CSRF token");
    assert.ok(csrf.csrfCookie?.startsWith("pdpp_owner_csrf="), "/device GET sets a CSRF cookie");

    const approveDeviceResp = await fetch(`${asUrl}/device/approve`, {
      body: new URLSearchParams({ _csrf: csrfField, user_code: userCode }).toString(),
      headers: {
        Accept: "text/html",
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `${cookie}; ${csrf.csrfCookie}`,
      },
      method: "POST",
      redirect: "manual",
    });
    assert.equal(approveDeviceResp.status, 200);
    const pending = await getOwnerDeviceAuthorizationByUserCode(userCode);
    assert.equal(pending, null, "pending row cleared after approval");
  });
});

// ── 6. enabled: submitted subject_id is ignored, configured subject wins ─────
test("owner-auth placeholder: enabled — submitted subject_id is ignored on approve", async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD, ownerAuthSubjectId: CUSTOM_SUBJECT_ID }, async ({ asUrl }) => {
    const { cookie } = await login(asUrl, TEST_PASSWORD);
    const requestUri = await startPendingConsent(asUrl);

    const resp = await fetch(`${asUrl}/consent/approve`, {
      body: JSON.stringify({
        request_uri: requestUri,
        subject_id: "attacker_injected_subject",
      }),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Cookie: cookie || "",
      },
      method: "POST",
    });
    assert.equal(resp.status, 200);
    const body = (await resp.json()) as { grant_id?: string };
    const tokenRows = getDb().prepare("SELECT subject_id FROM tokens WHERE grant_id = ?").all(body.grant_id) as {
      subject_id: string;
    }[];
    assert.ok(tokenRows.length >= 1);
    assert.equal(
      tokenRows[0]?.subject_id,
      CUSTOM_SUBJECT_ID,
      "submitted subject_id must be ignored and configured owner subject used"
    );
  });

  // and on /device/approve the configured subject is persisted into the owner session
  await withServer({ ownerAuthPassword: TEST_PASSWORD, ownerAuthSubjectId: CUSTOM_SUBJECT_ID }, async ({ asUrl }) => {
    const { cookie } = await login(asUrl, TEST_PASSWORD);
    const device = await initiateOwnerDeviceAuthorization("longview", { baseUrl: asUrl });
    const userCode = device.user_code;
    assert.ok(typeof userCode === "string", "device authorization returns a user code");

    const csrf = await fetchHostedFormCsrf(asUrl, `/device?user_code=${encodeURIComponent(userCode)}`, cookie);
    const { csrfField } = csrf;
    assert.ok(typeof csrfField === "string", "/device GET embeds a CSRF token");
    const approveDeviceResp = await fetch(`${asUrl}/device/approve`, {
      body: new URLSearchParams({
        _csrf: csrfField,
        subject_id: "attacker_injected_subject",
        user_code: userCode,
      }).toString(),
      headers: {
        Accept: "text/html",
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `${cookie}; ${csrf.csrfCookie}`,
      },
      method: "POST",
      redirect: "manual",
    });
    assert.equal(approveDeviceResp.status, 200);

    const rows = getDb()
      .prepare(`
        SELECT subject_id FROM tokens
        WHERE token_kind = 'owner'
        ORDER BY created_at DESC
    `)
      .all();
    const [ownerTokenRow] = rows;
    assert.ok(ownerTokenRow, "owner token row exists");
    assert.equal(ownerTokenRow.subject_id, CUSTOM_SUBJECT_ID);
  });
});

// ── 7. non-protected public routes still behave as before ────────────────────
test("owner-auth placeholder: public OAuth metadata and /oauth/par routes are not gated", async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const meta = await fetch(`${asUrl}/.well-known/oauth-authorization-server`);
    assert.equal(meta.status, 200);
    const metaBody = (await meta.json()) as { issuer?: string };
    assert.ok(metaBody.issuer, "metadata still returned without owner session");

    // /oauth/par accepts requests without an owner session (client-side flow).
    const requestUri = await startPendingConsent(asUrl);
    assert.ok(typeof requestUri === "string" && requestUri.length > 0);
  });
});

test("owner-auth placeholder: enabled — _ref reads and mutations both require owner session", async () => {
  // Per gate-ref-reads-when-owner-auth-enabled, both `_ref` reads and
  // mutations are owner-gated when PDPP_OWNER_PASSWORD is set.
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    await startPendingConsent(asUrl);
    const connectorId = SPOTIFY_MANIFEST.connector_id;

    const unauthenticatedRead = await fetchJson(`${asUrl}/_ref/connectors?limit=20`, {
      headers: { Accept: "application/json" },
    });
    assert.equal(unauthenticatedRead.status, 401, "_ref reads now require owner session");
    assert.equal((unauthenticatedRead.body as { error?: { code?: string } }).error?.code, "owner_session_required");

    const unauthenticatedMutation = await fetchJson(
      `${asUrl}/_ref/connectors/${encodeURIComponent(connectorId)}/schedule`,
      {
        body: JSON.stringify({ enabled: true, interval_seconds: 300 }),
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        method: "PUT",
      }
    );
    assert.equal(unauthenticatedMutation.status, 401);
    assert.equal((unauthenticatedMutation.body as { error?: { code?: string } }).error?.code, "owner_session_required");

    const { cookie } = await login(asUrl, TEST_PASSWORD);

    const authenticatedRead = await fetchJson(`${asUrl}/_ref/connectors?limit=20`, {
      headers: { Accept: "application/json", Cookie: cookie || "" },
    });
    assert.equal(authenticatedRead.status, 200, "_ref read succeeds with owner session");
    assert.equal((authenticatedRead.body as { object?: string }).object, "list");

    const authenticatedMutation = await fetchJson(
      `${asUrl}/_ref/connectors/${encodeURIComponent(connectorId)}/schedule`,
      {
        body: JSON.stringify({ enabled: true, interval_seconds: 300 }),
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Cookie: cookie || "",
        },
        method: "PUT",
      }
    );
    assert.equal(authenticatedMutation.status, 200);
    const authenticatedMutationBody = authenticatedMutation.body as {
      connector_id?: string;
      interval_seconds?: number;
    };
    // Schedule writes canonicalize URL-shaped connector ids to short keys.
    assert.equal(authenticatedMutationBody.connector_id, canonicalConnectorKey(connectorId));
    assert.equal(authenticatedMutationBody.interval_seconds, 300);
  });
});

// ── extra: logout clears the cookie ──────────────────────────────────────────
test("owner-auth placeholder: logout clears the session cookie", async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const { cookie } = await login(asUrl, TEST_PASSWORD);
    // JSON callers logout with `Content-Type: application/json` to
    // signal "programmatic, not a browser form post." That is what
    // exempts the request from CSRF; an empty body with no
    // Content-Type would otherwise look indistinguishable from a
    // cross-origin browser POST and would now be rejected.
    const resp = await fetch(`${asUrl}/owner/logout`, {
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Cookie: cookie || "",
      },
      method: "POST",
      redirect: "manual",
    });
    assert.equal(resp.status, 204);
    const setCookie = resp.headers.get("set-cookie");
    assert.ok(setCookie?.includes("pdpp_owner_session="), "sets clearing cookie");
    assert.ok(setCookie?.includes("Max-Age=0"), "cookie is expired");
  });
});
