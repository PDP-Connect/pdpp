// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
/**
 * Regression tests for the hosted-form CSRF mechanism.
 *
 * Coverage matrix (per owner review):
 *   - login: form POST without CSRF -> 403 + no session cookie
 *   - login: form POST with valid CSRF + wrong password -> 401
 *   - login: form POST with valid CSRF + correct password -> 302 + session
 *   - consent/approve, consent/deny: form POST without CSRF -> 403 (session present)
 *   - device/approve, device/deny:   form POST without CSRF -> 403 (session present)
 *   - matching CSRF from rendered consent/device pages allows the positive path
 *   - JSON callers remain compatible (no CSRF required for JSON content-type)
 *   - login Set-Cookie carries both session and CSRF cookies through Fastify
 *   - signature defends against cookie injection / subdomain overwrite
 */
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  getOwnerDeviceAuthorizationByUserCode as getOwnerDeviceAuthorizationByUserCodeUntyped,
  initiateOwnerDeviceAuthorization as initiateOwnerDeviceAuthorizationUntyped,
} from "../server/auth.ts";
import { canonicalConnectorKey } from "../server/connector-key.ts";
import { startServer as startServerUntyped } from "../server/index.ts";
import { deriveOwnerCsrfSecretFromString, issueOwnerCsrfToken } from "../server/owner-csrf.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";

// server/index.js (startServer) and server/auth.ts (device authorization)
// are untyped JS (allowJs, checkJs:false). Local interfaces model only
// the fields this suite reads.
interface CloseableHandle {
  close: (cb: (err?: Error) => void) => unknown;
  closeAllConnections: () => void;
}

interface ClosableServer {
  asPort: number;
  asServer: CloseableHandle;
  rsPort: number;
  rsServer: CloseableHandle;
}

async function startServer(opts: Record<string, unknown>): Promise<ClosableServer> {
  const raw: Record<string, unknown> = await startServerUntyped(opts);
  return {
    asPort: raw.asPort as number,
    asServer: raw.asServer as CloseableHandle,
    rsPort: raw.rsPort as number,
    rsServer: raw.rsServer as CloseableHandle,
  };
}

interface DeviceAuthorization {
  device_code: string;
  user_code: string;
  [key: string]: unknown;
}

const initiateOwnerDeviceAuthorization = initiateOwnerDeviceAuthorizationUntyped as (
  clientId: string,
  opts?: { baseUrl?: string; scenarioId?: string; expiresIn?: number; interval?: number }
) => Promise<DeviceAuthorization>;

const getOwnerDeviceAuthorizationByUserCode = getOwnerDeviceAuthorizationByUserCodeUntyped as (
  userCode: string
) => Promise<unknown>;

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, "..");
const SPOTIFY_MANIFEST: { connector_id: string; [key: string]: unknown } = JSON.parse(
  readFileSync(join(REFERENCE_IMPL_DIR, "fixtures/seed-manifests/spotify.json"), "utf8")
);

const TEST_PASSWORD = "csrf-regression-test-password";
const OWNER_SUBJECT_ID = "owner_local";
const NOW = "2026-05-31T00:00:00.000Z";
const CSRF_FIELD_PATTERN = /<input type="hidden" name="_csrf" value="([^"]+)"\s*\/>/;
const APPROVAL_REVIEW_REVISION_PATTERN = /name="approval_review_revision" value="([^"]+)"/;

async function closeServer(server: ClosableServer): Promise<void> {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  const closeWithTimeout = (srv: CloseableHandle) =>
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

interface ServerHandles {
  asUrl: string;
}

async function withServer(opts: Record<string, unknown>, fn: (handles: ServerHandles) => Promise<void>): Promise<void> {
  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    quiet: true,
    rsPort: 0,
    ...opts,
  });
  try {
    await fn({ asUrl: `http://localhost:${server.asPort}` });
  } finally {
    await closeServer(server);
  }
}

function getRawSetCookieList(resp: Response): string[] {
  const headers = resp.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }
  const single = resp.headers.get("set-cookie");
  return single ? [single] : [];
}

function findSetCookiePair(setCookies: string[], name: string): string | null {
  for (const header of setCookies) {
    const [firstPair] = header.split(";");
    if (firstPair?.startsWith(`${name}=`)) {
      return firstPair;
    }
  }
  return null;
}

function findSetCookieFullEntry(setCookies: string[], name: string): string | null {
  return setCookies.find((h) => h.startsWith(`${name}=`)) || null;
}

function extractCsrfFieldValue(html: string): string | null {
  const match = html.match(CSRF_FIELD_PATTERN);
  return match ? (match[1] as string) : null;
}

interface CsrfFromForm {
  csrfCookie: string | null;
  csrfField: string | null;
  html: string;
  setCookies: string[];
  status: number;
}

async function fetchCsrfFromForm(asUrl: string, path: string, sessionCookie?: string | null): Promise<CsrfFromForm> {
  const resp = await fetch(`${asUrl}${path}`, {
    headers: { Accept: "text/html", Cookie: sessionCookie || "" },
    redirect: "manual",
  });
  const setCookies = getRawSetCookieList(resp);
  const csrfCookie = findSetCookiePair(setCookies, "pdpp_owner_csrf");
  const html = await resp.text();
  return {
    csrfCookie,
    csrfField: extractCsrfFieldValue(html),
    html,
    setCookies,
    status: resp.status,
  };
}

interface LoginResult {
  csrfCookie: string | null;
  csrfField: string | null;
  location: string | null;
  sessionCookie: string | null;
  setCookies: string[];
  status: number;
}

async function login(asUrl: string, password: string): Promise<LoginResult> {
  const csrf = await fetchCsrfFromForm(asUrl, "/owner/login");
  const resp = await fetch(`${asUrl}/owner/login`, {
    body: new URLSearchParams({
      _csrf: csrf.csrfField ?? "",
      password,
      return_to: "/consent",
    }).toString(),
    headers: {
      Accept: "text/html",
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: csrf.csrfCookie ?? "",
    },
    method: "POST",
    redirect: "manual",
  });
  const setCookies = getRawSetCookieList(resp);
  return {
    csrfCookie: csrf.csrfCookie,
    csrfField: csrf.csrfField,
    location: resp.headers.get("location"),
    sessionCookie: findSetCookiePair(setCookies, "pdpp_owner_session"),
    setCookies,
    status: resp.status,
  };
}

async function startPendingConsent(asUrl: string): Promise<string> {
  const registerResp = await fetch(`${asUrl}/connectors`, {
    body: JSON.stringify(SPOTIFY_MANIFEST),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  if (!registerResp.ok && registerResp.status !== 409) {
    throw new Error(`connector registration failed: ${registerResp.status} ${await registerResp.text()}`);
  }
  await seedSpotifyInstance();
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
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  if (!resp.ok) {
    throw new Error(`par failed: ${resp.status} ${await resp.text()}`);
  }
  const body = (await resp.json()) as { request_uri: string };
  return body.request_uri;
}

async function reviewPendingConsent(asUrl: string, requestUri: string, sessionCookie: string): Promise<string> {
  const resp = await fetch(`${asUrl}/consent/review`, {
    body: JSON.stringify({ request_uri: requestUri }),
    headers: { Accept: "application/json", "Content-Type": "application/json", Cookie: sessionCookie },
    method: "POST",
  });
  const text = await resp.text();
  assert.equal(resp.status, 200, text);
  const body = JSON.parse(text) as {
    approval_review?: object;
    approval_review_revision?: string;
    request_uri?: string;
  };
  assert.ok(body.approval_review);
  assert.ok(body.approval_review_revision);
  assert.equal(body.request_uri, requestUri);
  return body.approval_review_revision;
}

async function seedSpotifyInstance(): Promise<void> {
  const connectorId = canonicalConnectorKey(SPOTIFY_MANIFEST.connector_id);
  assert.ok(connectorId, "spotify manifest must resolve to a canonical connector key");
  await createSqliteConnectorInstanceStore().upsert({
    connectorId,
    connectorInstanceId: "cin_owner_csrf_spotify",
    createdAt: NOW,
    displayName: "Owner CSRF Spotify",
    ownerSubjectId: OWNER_SUBJECT_ID,
    sourceBinding: { account_hint: "owner-csrf@example.com" },
    sourceBindingKey: "owner-csrf@example.com",
    sourceKind: "account",
    status: "active",
    updatedAt: NOW,
  });
}

// ── login: form POST without CSRF -> 403 + no session ────────────────────────
test("CSRF: form POST /owner/login without _csrf is rejected with 403 and issues no session", async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const resp = await fetch(`${asUrl}/owner/login`, {
      body: new URLSearchParams({ password: TEST_PASSWORD, return_to: "/consent" }).toString(),
      headers: {
        Accept: "text/html",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      method: "POST",
      redirect: "manual",
    });
    assert.equal(resp.status, 403);
    const setCookies = getRawSetCookieList(resp);
    assert.ok(
      !findSetCookiePair(setCookies, "pdpp_owner_session"),
      "no owner session cookie SHALL be issued on CSRF failure"
    );
    const text = await resp.text();
    assert.ok(text.includes("form replay") || text.includes("CSRF"), "page surfaces a CSRF error");
    assert.ok(!text.includes("Incorrect password"), "CSRF failure SHALL NOT leak password validity");
  });
});

// ── login: matching CSRF + correct password -> 302 + session ────────────────
test("CSRF: form POST /owner/login with valid CSRF and correct password issues a session and redirects", async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const result = await login(asUrl, TEST_PASSWORD);
    assert.equal(result.status, 302);
    assert.equal(result.location, "/consent");
    assert.ok(result.sessionCookie?.startsWith("pdpp_owner_session="), "session cookie SHALL be set");
  });
});

// ── login Set-Cookie carries both session and CSRF cookies through Fastify ──
test("CSRF: login response Set-Cookie carries both session and CSRF rotation cookies through Fastify", async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const result = await login(asUrl, TEST_PASSWORD);
    assert.equal(result.status, 302);
    // Session cookie present.
    assert.ok(findSetCookiePair(result.setCookies, "pdpp_owner_session"));
    // The login flow rotates the CSRF cookie on auth-state change. The
    // rotation Set-Cookie SHALL be present in addition to the session
    // Set-Cookie — Fastify must preserve both header values.
    const csrfRotation = findSetCookieFullEntry(result.setCookies, "pdpp_owner_csrf");
    assert.ok(csrfRotation, "CSRF rotation cookie SHALL be present alongside session cookie");
    assert.ok(csrfRotation.includes("Max-Age=0"), "rotation cookie SHALL be a clear cookie");
  });
});

// ── login: matching CSRF + wrong password -> 401 (CSRF passes, password fails) ─
test("CSRF: form POST /owner/login with valid CSRF and wrong password returns 401 (no session)", async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const csrf = await fetchCsrfFromForm(asUrl, "/owner/login");
    const resp = await fetch(`${asUrl}/owner/login`, {
      body: new URLSearchParams({
        _csrf: csrf.csrfField ?? "",
        password: "definitely-not-the-password",
        return_to: "/consent",
      }).toString(),
      headers: {
        Accept: "text/html",
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: csrf.csrfCookie ?? "",
      },
      method: "POST",
      redirect: "manual",
    });
    assert.equal(resp.status, 401);
    const setCookies = getRawSetCookieList(resp);
    assert.ok(!findSetCookiePair(setCookies, "pdpp_owner_session"));
    const text = await resp.text();
    assert.ok(text.includes("Incorrect password"));
  });
});

// ── consent/approve, consent/deny: form POST without CSRF -> 403 (auth'd) ───
test("CSRF: form POST /consent/approve without _csrf is rejected with 403 even when authenticated", async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const { sessionCookie } = await login(asUrl, TEST_PASSWORD);
    const requestUri = await startPendingConsent(asUrl);
    const resp = await fetch(`${asUrl}/consent/approve`, {
      body: new URLSearchParams({ request_uri: requestUri }).toString(),
      headers: {
        Accept: "text/html",
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: sessionCookie ?? "",
      },
      method: "POST",
      redirect: "manual",
    });
    assert.equal(resp.status, 403);
  });
});

test("CSRF: form POST /consent/deny without _csrf is rejected with 403 even when authenticated", async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const { sessionCookie } = await login(asUrl, TEST_PASSWORD);
    const requestUri = await startPendingConsent(asUrl);

    const resp = await fetch(`${asUrl}/consent/deny`, {
      body: new URLSearchParams({ request_uri: requestUri }).toString(),
      headers: {
        Accept: "text/html",
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: sessionCookie ?? "",
      },
      method: "POST",
      redirect: "manual",
    });
    assert.equal(resp.status, 403);
  });
});

// ── device/approve, device/deny: form POST without CSRF -> 403 (auth'd) ─────
test("CSRF: form POST /device/approve without _csrf is rejected with 403 even when authenticated", async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const { sessionCookie } = await login(asUrl, TEST_PASSWORD);
    const device = await initiateOwnerDeviceAuthorization("longview", { baseUrl: asUrl });

    const resp = await fetch(`${asUrl}/device/approve`, {
      body: new URLSearchParams({ user_code: device.user_code }).toString(),
      headers: {
        Accept: "text/html",
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: sessionCookie ?? "",
      },
      method: "POST",
      redirect: "manual",
    });
    assert.equal(resp.status, 403);
    const stillPending = await getOwnerDeviceAuthorizationByUserCode(device.user_code);
    assert.ok(stillPending, "device authorization SHALL remain pending after blocked POST");
  });
});

test("CSRF: form POST /device/deny without _csrf is rejected with 403 even when authenticated", async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const { sessionCookie } = await login(asUrl, TEST_PASSWORD);
    const device = await initiateOwnerDeviceAuthorization("longview", { baseUrl: asUrl });

    const resp = await fetch(`${asUrl}/device/deny`, {
      body: new URLSearchParams({ user_code: device.user_code }).toString(),
      headers: {
        Accept: "text/html",
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: sessionCookie ?? "",
      },
      method: "POST",
      redirect: "manual",
    });
    assert.equal(resp.status, 403);
    const stillPending = await getOwnerDeviceAuthorizationByUserCode(device.user_code);
    assert.ok(stillPending);
  });
});

// ── matching CSRF from rendered consent page allows the positive path ───────
test("CSRF: matching token from /consent GET allows /consent/approve form POST", async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const { sessionCookie } = await login(asUrl, TEST_PASSWORD);
    const requestUri = await startPendingConsent(asUrl);
    const csrf = await fetchCsrfFromForm(
      asUrl,
      `/consent?request_uri=${encodeURIComponent(requestUri)}`,
      sessionCookie
    );
    assert.ok(csrf.csrfField, "consent GET SHALL embed a CSRF token");
    const reviewResp = await fetch(`${asUrl}/consent/review`, {
      body: new URLSearchParams({ _csrf: csrf.csrfField, request_uri: requestUri }).toString(),
      headers: {
        Accept: "text/html",
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `${sessionCookie}; ${csrf.csrfCookie}`,
      },
      method: "POST",
    });
    const reviewHtml = await reviewResp.text();
    assert.equal(reviewResp.status, 200, reviewHtml);
    const revisionMatch = reviewHtml.match(APPROVAL_REVIEW_REVISION_PATTERN);
    assert.ok(revisionMatch?.[1], "review form SHALL carry an approval review revision");

    const resp = await fetch(`${asUrl}/consent/approve`, {
      body: new URLSearchParams({
        _csrf: csrf.csrfField,
        approval_review_revision: revisionMatch[1],
        request_uri: requestUri,
      }).toString(),
      headers: {
        Accept: "text/html",
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `${sessionCookie}; ${csrf.csrfCookie}`,
      },
      method: "POST",
      redirect: "manual",
    });
    const text = await resp.text();
    assert.equal(resp.status, 200, text);
    assert.ok(text.includes("Access approved"));
  });
});

// ── matching CSRF from rendered device page allows the positive path ────────
test("CSRF: matching token from /device GET allows /device/approve form POST", async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const { sessionCookie } = await login(asUrl, TEST_PASSWORD);
    const device = await initiateOwnerDeviceAuthorization("longview", { baseUrl: asUrl });
    const csrf = await fetchCsrfFromForm(
      asUrl,
      `/device?user_code=${encodeURIComponent(device.user_code)}`,
      sessionCookie
    );
    assert.ok(csrf.csrfField);

    const resp = await fetch(`${asUrl}/device/approve`, {
      body: new URLSearchParams({ _csrf: csrf.csrfField, user_code: device.user_code }).toString(),
      headers: {
        Accept: "text/html",
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `${sessionCookie}; ${csrf.csrfCookie}`,
      },
      method: "POST",
      redirect: "manual",
    });
    assert.equal(resp.status, 200);
    const cleared = await getOwnerDeviceAuthorizationByUserCode(device.user_code);
    assert.equal(cleared, null);
  });
});

// ── JSON callers remain compatible (no CSRF required for JSON) ──────────────
test("CSRF: JSON POST /consent/approve remains compatible without _csrf", async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const { sessionCookie } = await login(asUrl, TEST_PASSWORD);
    const requestUri = await startPendingConsent(asUrl);
    const approvalReviewRevision = await reviewPendingConsent(asUrl, requestUri, sessionCookie ?? "");
    const resp = await fetch(`${asUrl}/consent/approve`, {
      body: JSON.stringify({ approval_review_revision: approvalReviewRevision, request_uri: requestUri }),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Cookie: sessionCookie ?? "",
      },
      method: "POST",
    });
    assert.equal(resp.status, 200);
    const body = (await resp.json()) as { token?: string; grant_id?: string };
    assert.ok(body.token);
    assert.ok(body.grant_id);
  });
});

// ── signature defends against cookie injection / subdomain overwrite ────────
test("CSRF: signed double-submit rejects a forged cookie value paired with the same forged form field", async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const { sessionCookie } = await login(asUrl, TEST_PASSWORD);
    const requestUri = await startPendingConsent(asUrl);
    // Attacker controls a sibling subdomain and can overwrite the
    // pdpp_owner_csrf cookie. Naive double-submit accepts any matching
    // pair; signed double-submit requires the pair to verify against the
    // server-side secret. We forge a cookie + field pair that match each
    // other but do not have a valid signature.
    const forged = "forgednonce.forgedsignature";
    const resp = await fetch(`${asUrl}/consent/approve`, {
      body: new URLSearchParams({ _csrf: forged, request_uri: requestUri }).toString(),
      headers: {
        Accept: "text/html",
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `${sessionCookie}; pdpp_owner_csrf=${forged}`,
      },
      method: "POST",
      redirect: "manual",
    });
    assert.equal(resp.status, 403, "forged cookie+field pair SHALL be rejected even when they match");
  });
});

// ── text/plain is a third browser-submittable form enctype: SHALL require CSRF ──
// Pre-merge regression: HTML forms accept three enctypes —
// `application/x-www-form-urlencoded`, `multipart/form-data`, and
// `text/plain`. The third can be sent cross-origin without a CORS
// preflight, so a CSRF gate that exempts everything except the first
// two is bypassable. We require CSRF for every non-JSON state-
// changing POST when owner-auth is enabled.
test("CSRF: text/plain POST /consent/approve without _csrf is rejected with 403 even when authenticated", async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const { sessionCookie } = await login(asUrl, TEST_PASSWORD);
    const requestUri = await startPendingConsent(asUrl);

    // Mirror the owner-supplied repro exactly: text/plain content-type,
    // request_uri carried in the query string (so the server still
    // resolves the pending grant), session cookie present, dummy
    // body, no CSRF cookie/field.
    const resp = await fetch(`${asUrl}/consent/approve?request_uri=${encodeURIComponent(requestUri)}`, {
      body: "x",
      headers: {
        Accept: "text/html",
        "Content-Type": "text/plain",
        Cookie: sessionCookie ?? "",
      },
      method: "POST",
      redirect: "manual",
    });
    assert.equal(resp.status, 403, "text/plain form bypass SHALL be blocked by CSRF");

    // Confirm no grant was actually issued: a fresh approval through
    // the JSON branch with the same pending request SHALL still
    // succeed (the pending row was not consumed).
    const approvalReviewRevision = await reviewPendingConsent(asUrl, requestUri, sessionCookie ?? "");
    const recover = await fetch(`${asUrl}/consent/approve`, {
      body: JSON.stringify({ approval_review_revision: approvalReviewRevision, request_uri: requestUri }),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Cookie: sessionCookie ?? "",
      },
      method: "POST",
    });
    assert.equal(
      recover.status,
      200,
      "pending request SHALL still be approvable; the text/plain attempt did not consume it"
    );
    const body = (await recover.json()) as { token?: string; grant_id?: string };
    assert.ok(body.grant_id);
    assert.ok(body.token);
  });
});

test("CSRF: text/plain POST /device/approve without _csrf is rejected with 403 and remains pending", async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const { sessionCookie } = await login(asUrl, TEST_PASSWORD);
    const device = await initiateOwnerDeviceAuthorization("longview", { baseUrl: asUrl });

    const resp = await fetch(`${asUrl}/device/approve`, {
      body: `user_code=${device.user_code}`,
      headers: {
        Accept: "text/html",
        "Content-Type": "text/plain",
        Cookie: sessionCookie ?? "",
      },
      method: "POST",
      redirect: "manual",
    });
    assert.equal(resp.status, 403);

    const stillPending = await getOwnerDeviceAuthorizationByUserCode(device.user_code);
    assert.ok(stillPending, "device authorization SHALL remain pending after the text/plain bypass attempt");
  });
});

// ── empty Content-Type is treated as non-JSON: SHALL require CSRF ───────────
test("CSRF: POST /consent/approve with no Content-Type is rejected (browser-fetch shape)", async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const { sessionCookie } = await login(asUrl, TEST_PASSWORD);
    const requestUri = await startPendingConsent(asUrl);

    const resp = await fetch(`${asUrl}/consent/approve?request_uri=${encodeURIComponent(requestUri)}`, {
      headers: { Accept: "text/html", Cookie: sessionCookie ?? "" },
      method: "POST",
      redirect: "manual",
    });
    // fetch() may add a default Content-Type when there's a body; with
    // no body it sends none. Either way the request is *not* JSON, so
    // it SHALL require CSRF.
    assert.equal(resp.status, 403);
  });
});

// ── JSON /owner/login is CSRF-exempt and reaches the password branch ───────
// The hosted owner-auth surface exempts pure JSON callers from CSRF on
// every other state-changing route. /owner/login SHALL be consistent
// with that rule: a JSON caller without _csrf SHALL reach the password
// branch (wrong password → 401, correct password → 302 + session
// cookie). Browser-submittable POSTs (form-encoded, text/plain, no
// Content-Type) SHALL still fail CSRF *before* the password is
// checked so a forged cross-origin POST cannot probe password validity.
test("CSRF: JSON POST /owner/login without _csrf reaches the password branch (wrong → 401)", async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const resp = await fetch(`${asUrl}/owner/login`, {
      body: JSON.stringify({ password: "definitely-not-the-password", return_to: "/consent" }),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      method: "POST",
      redirect: "manual",
    });
    assert.equal(resp.status, 401, "JSON wrong-password SHALL reach the password branch and return 401");
    const setCookies = getRawSetCookieList(resp);
    assert.ok(!findSetCookiePair(setCookies, "pdpp_owner_session"), "no session cookie on wrong password");
  });
});

test("CSRF: JSON POST /owner/login without _csrf reaches the password branch (correct → 302 + session)", async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const resp = await fetch(`${asUrl}/owner/login`, {
      body: JSON.stringify({ password: TEST_PASSWORD, return_to: "/consent" }),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      method: "POST",
      redirect: "manual",
    });
    assert.equal(resp.status, 302, "JSON correct-password SHALL succeed without CSRF");
    assert.equal(resp.headers.get("location"), "/consent");
    const setCookies = getRawSetCookieList(resp);
    assert.ok(findSetCookiePair(setCookies, "pdpp_owner_session"), "session cookie SHALL be set on JSON login success");
  });
});

test("CSRF: text/plain POST /owner/login without _csrf is rejected before the password check", async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const resp = await fetch(`${asUrl}/owner/login`, {
      body: `password=${TEST_PASSWORD}`,
      headers: {
        Accept: "text/html",
        "Content-Type": "text/plain",
      },
      method: "POST",
      redirect: "manual",
    });
    assert.equal(resp.status, 403, "text/plain login bypass SHALL be blocked by CSRF");
    const setCookies = getRawSetCookieList(resp);
    assert.ok(
      !findSetCookiePair(setCookies, "pdpp_owner_session"),
      "CSRF failure SHALL NOT issue a session even if the password would have been correct"
    );
  });
});

test("CSRF: POST /owner/login with no Content-Type is rejected before the password check", async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const resp = await fetch(`${asUrl}/owner/login`, {
      headers: { Accept: "text/html" },
      method: "POST",
      // No body, no Content-Type — the "browser POST without payload"
      // shape that an attacker page can produce cross-origin.
      redirect: "manual",
    });
    assert.equal(resp.status, 403);
  });
});

test("CSRF: form-encoded POST /owner/login without _csrf still fails CSRF before password", async () => {
  // Regression for the original P1: a form-encoded login post WITHOUT
  // a CSRF pair SHALL still 403 before the password check, even though
  // /owner/login is now consistent with the JSON exemption rule.
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const resp = await fetch(`${asUrl}/owner/login`, {
      body: new URLSearchParams({ password: TEST_PASSWORD, return_to: "/consent" }).toString(),
      headers: {
        Accept: "text/html",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      method: "POST",
      redirect: "manual",
    });
    assert.equal(resp.status, 403);
    const setCookies = getRawSetCookieList(resp);
    assert.ok(!findSetCookiePair(setCookies, "pdpp_owner_session"));
    const text = await resp.text();
    assert.ok(!text.includes("Incorrect password"), "CSRF failure SHALL NOT leak password validity");
  });
});

// ── runtime CSRF secret SHALL NOT be derived from the owner password ───────
// Pre-merge regression: the v2 spike derived the CSRF HMAC secret from
// PDPP_OWNER_PASSWORD. Because GET /owner/login is unauthenticated and
// returns one signed (nonce, sig) sample in the hidden field, any
// anonymous fetcher could brute-force a weak password offline. The
// runtime default now uses a random per-process secret; this test
// proves a token forged with a password-derived secret is NOT accepted.
test("CSRF: runtime SHALL NOT accept a token signed with deriveOwnerCsrfSecret(PDPP_OWNER_PASSWORD)", async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const { sessionCookie } = await login(asUrl, TEST_PASSWORD);
    const requestUri = await startPendingConsent(asUrl);

    // Forge a CSRF token using the password-derived secret the prior
    // implementation exposed. This SHALL be rejected because the
    // runtime now signs tokens with a random per-process secret.
    const passwordDerivedSecret = deriveOwnerCsrfSecretFromString(TEST_PASSWORD);
    const passwordDerivedToken = issueOwnerCsrfToken(passwordDerivedSecret);

    const resp = await fetch(`${asUrl}/consent/approve`, {
      body: new URLSearchParams({
        _csrf: passwordDerivedToken,
        request_uri: requestUri,
      }).toString(),
      headers: {
        Accept: "text/html",
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `${sessionCookie}; pdpp_owner_csrf=${passwordDerivedToken}`,
      },
      method: "POST",
      redirect: "manual",
    });
    assert.equal(resp.status, 403, "password-derived CSRF token SHALL be rejected by the running server");

    // And the CSRF token actually rendered into the consent page is
    // NOT the password-derived token — fetching /consent and checking
    // the embedded _csrf SHALL produce a different value.
    const csrf = await fetchCsrfFromForm(
      asUrl,
      `/consent?request_uri=${encodeURIComponent(requestUri)}`,
      sessionCookie
    );
    assert.notEqual(
      csrf.csrfField,
      passwordDerivedToken,
      "rendered CSRF token SHALL NOT equal a token forged from the owner password"
    );
  });
});

// ── signed token from a different password's secret does not validate ───────
test("CSRF: a token signed with a different secret does not validate against the running server", async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const { sessionCookie } = await login(asUrl, TEST_PASSWORD);
    const requestUri = await startPendingConsent(asUrl);
    const otherSecret = deriveOwnerCsrfSecretFromString("completely-different-password");
    const otherToken = issueOwnerCsrfToken(otherSecret);
    const resp = await fetch(`${asUrl}/consent/approve`, {
      body: new URLSearchParams({ _csrf: otherToken, request_uri: requestUri }).toString(),
      headers: {
        Accept: "text/html",
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `${sessionCookie}; pdpp_owner_csrf=${otherToken}`,
      },
      method: "POST",
      redirect: "manual",
    });
    assert.equal(resp.status, 403);
  });
});

// ── Set-Cookie array path: GET /owner/login returns BOTH session-absent and CSRF cookies cleanly through Fastify ─
test("CSRF: GET /owner/login through Fastify exposes a single CSRF Set-Cookie (no duplicate cookies)", async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const resp = await fetch(`${asUrl}/owner/login`, {
      headers: { Accept: "text/html" },
      redirect: "manual",
    });
    assert.equal(resp.status, 200);
    const setCookies = getRawSetCookieList(resp);
    const csrfEntries = setCookies.filter((s) => s.startsWith("pdpp_owner_csrf="));
    assert.equal(csrfEntries.length, 1, "exactly one CSRF Set-Cookie SHALL be issued by GET /owner/login");
    const [csrfEntry] = csrfEntries;
    assert.ok(csrfEntry, "expected exactly one CSRF Set-Cookie entry");
    assert.ok(csrfEntry.includes("HttpOnly"));
    assert.ok(csrfEntry.includes("SameSite=Lax"));
  });
});

// ── SameSite=Strict opt-in toggles cookie attribute ─────────────────────────
test("CSRF: ownerAuthSameSite=strict produces SameSite=Strict on session and CSRF cookies", async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD, ownerAuthSameSite: "strict" }, async ({ asUrl }) => {
    const result = await login(asUrl, TEST_PASSWORD);
    assert.equal(result.status, 302);
    const sessionEntry = result.setCookies.find((s) => s.startsWith("pdpp_owner_session="));
    assert.ok(sessionEntry?.includes("SameSite=Strict"), "session cookie honors strict mode");
    const csrfEntries = result.setCookies.filter((s) => s.startsWith("pdpp_owner_csrf="));
    for (const entry of csrfEntries) {
      assert.ok(entry.includes("SameSite=Strict"), "CSRF cookie honors strict mode");
    }
  });
});

// ── Force-secure knob threads `Secure` even on plain HTTP ───────────────────
test("CSRF: ownerAuthForceSecureCookies=true marks session and CSRF cookies Secure on plain HTTP", async () => {
  await withServer({ ownerAuthForceSecureCookies: true, ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const result = await login(asUrl, TEST_PASSWORD);
    const sessionEntry = result.setCookies.find((s) => s.startsWith("pdpp_owner_session="));
    assert.ok(sessionEntry?.includes("Secure"), "session cookie SHALL be Secure under force-secure");
    const csrfEntries = result.setCookies.filter((s) => s.startsWith("pdpp_owner_csrf="));
    for (const entry of csrfEntries) {
      assert.ok(entry.includes("Secure"), "CSRF cookie SHALL be Secure under force-secure");
    }
  });
});

// ── Regression: owner-auth disabled + form-encoded POST /owner/logout ──────
// The prior contract for the placeholder gate is that, with no
// PDPP_OWNER_PASSWORD set, owner-auth is a no-op and hosted routes stay
// open. A form-encoded logout POST in that mode SHALL NOT 403 just
// because there is no CSRF token to verify.
test("CSRF: owner-auth disabled — form-encoded POST /owner/logout does not 403 (no-op)", async () => {
  await withServer({}, async ({ asUrl }) => {
    // text/html caller: prior behavior is a redirect to /owner/login.
    const htmlResp = await fetch(`${asUrl}/owner/logout`, {
      body: "",
      headers: {
        Accept: "text/html",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      method: "POST",
      redirect: "manual",
    });
    assert.notEqual(htmlResp.status, 403, "form-encoded logout SHALL NOT 403 when owner-auth is disabled");
    assert.equal(htmlResp.status, 302, "HTML caller SHALL be redirected to /owner/login");
    assert.equal(htmlResp.headers.get("location"), "/owner/login");

    // JSON caller: prior behavior is a 204.
    const jsonResp = await fetch(`${asUrl}/owner/logout`, {
      body: "",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      method: "POST",
      redirect: "manual",
    });
    assert.notEqual(jsonResp.status, 403);
    assert.equal(
      jsonResp.status,
      204,
      "JSON caller SHALL receive 204 even with form content-type when owner-auth is disabled"
    );
  });
});

// ── Default local HTTP development still works (no Secure required) ─────────
test("CSRF: default local HTTP development does not require Secure on cookies", async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const result = await login(asUrl, TEST_PASSWORD);
    assert.equal(result.status, 302, "login SHALL succeed over plain HTTP without force-secure");
    const sessionEntry = result.setCookies.find((s) => s.startsWith("pdpp_owner_session="));
    assert.ok(!sessionEntry?.includes("Secure"), "session cookie omits Secure on plain HTTP by default");
  });
});

// ── BFF can drive the canonical RFC 8628 device flow end-to-end via JSON ────
// The dashboard issues owner self-export bearers by running the real public
// device flow against the AS — there is no hidden mint endpoint. Form-encoded
// `/device/approve` requires a hosted-form CSRF token that the server-to-
// server BFF caller doesn't have; JSON content-type uses the documented
// isJsonRequest exemption (server/owner-auth.ts). Pin both the positive JSON
// path and the negative form-encoded-without-CSRF path so a future tightening
// can't silently re-break the dashboard.
test("BFF device flow: JSON-encoded /device/approve with owner session succeeds (no CSRF token)", async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const session = await login(asUrl, TEST_PASSWORD);
    assert.equal(session.status, 302);
    assert.ok(session.sessionCookie);

    const deviceRes = await fetch(`${asUrl}/oauth/device_authorization`, {
      body: JSON.stringify({ client_id: "pdpp-polyfill-owner-bootstrap" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(deviceRes.status, 200);
    const device = (await deviceRes.json()) as { user_code?: string; device_code?: string };
    assert.equal(typeof device.user_code, "string");
    assert.equal(typeof device.device_code, "string");

    const approveRes = await fetch(`${asUrl}/device/approve`, {
      body: JSON.stringify({ user_code: device.user_code }),
      headers: { "Content-Type": "application/json", Cookie: session.sessionCookie ?? "" },
      method: "POST",
    });
    assert.equal(
      approveRes.status,
      200,
      "JSON content-type SHALL bypass hosted-form CSRF for cookie-authed BFF callers"
    );

    const tokenRes = await fetch(`${asUrl}/oauth/token`, {
      body: JSON.stringify({
        client_id: "pdpp-polyfill-owner-bootstrap",
        device_code: device.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(tokenRes.status, 200);
    const token = (await tokenRes.json()) as { access_token?: string; token_type?: string };
    assert.equal(typeof token.access_token, "string");
    assert.ok(token.access_token && token.access_token.length > 0);
    assert.equal(token.token_type, "Bearer");
  });
});

test("BFF device flow: form-encoded /device/approve without CSRF token still 403s (negative pin)", async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const session = await login(asUrl, TEST_PASSWORD);
    assert.ok(session.sessionCookie);
    const deviceRes = await fetch(`${asUrl}/oauth/device_authorization`, {
      body: JSON.stringify({ client_id: "pdpp-polyfill-owner-bootstrap" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const device = (await deviceRes.json()) as { user_code?: string };

    const approveRes = await fetch(`${asUrl}/device/approve`, {
      body: new URLSearchParams({ user_code: device.user_code ?? "" }).toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: session.sessionCookie ?? "",
      },
      method: "POST",
    });
    assert.equal(approveRes.status, 403, "form-encoded POSTs SHALL still require a hosted-form CSRF token");
  });
});

test("BFF device flow: /device/approve without owner session is rejected with 401", async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const deviceRes = await fetch(`${asUrl}/oauth/device_authorization`, {
      body: JSON.stringify({ client_id: "pdpp-polyfill-owner-bootstrap" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const device = (await deviceRes.json()) as { user_code?: string };

    const approveRes = await fetch(`${asUrl}/device/approve`, {
      body: JSON.stringify({ user_code: device.user_code }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(approveRes.status, 401);
  });
});
