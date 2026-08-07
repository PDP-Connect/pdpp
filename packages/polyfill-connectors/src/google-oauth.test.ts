// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
  GoogleOAuthError,
  isGoogleOAuthGrantInvalid,
  refreshGoogleAccessToken,
  resolveGoogleOAuthCredentials,
} from "./google-oauth.ts";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" }, status: 200, ...init });
}

interface CapturedRequest {
  readonly body: string | null;
  readonly headers: Headers;
  readonly method: string;
  readonly url: string;
}

function makeFetch(responses: readonly Response[]): {
  readonly calls: CapturedRequest[];
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
} {
  const calls: CapturedRequest[] = [];
  const queue = [...responses];
  return {
    calls,
    fetch(url, init) {
      calls.push({
        body: typeof init.body === "string" ? init.body : null,
        headers: new Headers(init.headers),
        method: init.method ?? "GET",
        url,
      });
      const response = queue.shift();
      assert.ok(response, `unexpected fetch call to ${url}`);
      return Promise.resolve(response);
    },
  };
}

const CREDENTIALS = { clientId: "client-id", clientSecret: "client-secret", refreshToken: "refresh-token-value" };

// ─── resolveGoogleOAuthCredentials ──────────────────────────────────────

test("resolveGoogleOAuthCredentials reads client id/secret and the named refresh-token env var", () => {
  const env = {
    GOOGLE_OAUTH_CLIENT_ID: "id-1",
    GOOGLE_OAUTH_CLIENT_SECRET: "secret-1",
    GOOGLE_CALENDAR_REFRESH_TOKEN: "cal-refresh",
    GOOGLE_CONTACTS_REFRESH_TOKEN: "contacts-refresh",
  };
  const calendarCreds = resolveGoogleOAuthCredentials(env, "GOOGLE_CALENDAR_REFRESH_TOKEN");
  assert.deepEqual(calendarCreds, { clientId: "id-1", clientSecret: "secret-1", refreshToken: "cal-refresh" });
  const contactsCreds = resolveGoogleOAuthCredentials(env, "GOOGLE_CONTACTS_REFRESH_TOKEN");
  assert.equal(contactsCreds.refreshToken, "contacts-refresh");
});

test("resolveGoogleOAuthCredentials throws a distinct code per missing field", () => {
  assert.throws(
    () =>
      resolveGoogleOAuthCredentials(
        { GOOGLE_OAUTH_CLIENT_SECRET: "s", GOOGLE_CALENDAR_REFRESH_TOKEN: "r" },
        "GOOGLE_CALENDAR_REFRESH_TOKEN"
      ),
    /google_oauth_client_id_missing/
  );
  assert.throws(
    () =>
      resolveGoogleOAuthCredentials(
        { GOOGLE_OAUTH_CLIENT_ID: "i", GOOGLE_CALENDAR_REFRESH_TOKEN: "r" },
        "GOOGLE_CALENDAR_REFRESH_TOKEN"
      ),
    /google_oauth_client_secret_missing/
  );
  assert.throws(
    () =>
      resolveGoogleOAuthCredentials(
        { GOOGLE_OAUTH_CLIENT_ID: "i", GOOGLE_OAUTH_CLIENT_SECRET: "s" },
        "GOOGLE_CALENDAR_REFRESH_TOKEN"
      ),
    /google_oauth_refresh_token_missing:GOOGLE_CALENDAR_REFRESH_TOKEN/
  );
});

test("resolveGoogleOAuthCredentials rejects whitespace-only values the same as missing", () => {
  assert.throws(
    () =>
      resolveGoogleOAuthCredentials(
        { GOOGLE_OAUTH_CLIENT_ID: "   ", GOOGLE_OAUTH_CLIENT_SECRET: "s", GOOGLE_CALENDAR_REFRESH_TOKEN: "r" },
        "GOOGLE_CALENDAR_REFRESH_TOKEN"
      ),
    /google_oauth_client_id_missing/
  );
});

// ─── refreshGoogleAccessToken: request shape + no token leakage ────────

test("refreshGoogleAccessToken POSTs the documented refresh_token grant body and never leaks the token into the URL", async () => {
  const transport = makeFetch([jsonResponse({ access_token: "ya29.new", expires_in: 3600 })]);
  await refreshGoogleAccessToken(CREDENTIALS, { fetch: transport.fetch, now: () => 1_000_000 });

  assert.equal(transport.calls.length, 1);
  const [call] = transport.calls;
  assert.ok(call);
  assert.equal(call.method, "POST");
  assert.equal(call.headers.get("Content-Type"), "application/x-www-form-urlencoded");
  // The refresh token must travel in the POST body, never as a URL query
  // param (which would land in server access logs / proxy logs / browser
  // history in a browser context) — the load-bearing no-leakage assertion.
  assert.ok(!call.url.includes("refresh-token-value"), "refresh token must not appear in the request URL");
  assert.ok(!call.url.includes("client-secret"), "client secret must not appear in the request URL");
  assert.equal(call.url, "https://oauth2.googleapis.com/token");

  const params = new URLSearchParams(call.body ?? "");
  assert.equal(params.get("client_id"), "client-id");
  assert.equal(params.get("client_secret"), "client-secret");
  assert.equal(params.get("refresh_token"), "refresh-token-value");
  assert.equal(params.get("grant_type"), "refresh_token");
});

test("refreshGoogleAccessToken respects an injected tokenUrl override", async () => {
  const transport = makeFetch([jsonResponse({ access_token: "ya29.custom", expires_in: 3600 })]);
  await refreshGoogleAccessToken(CREDENTIALS, {
    fetch: transport.fetch,
    tokenUrl: "https://example.test/token",
    now: () => 0,
  });
  assert.equal(transport.calls[0]?.url, "https://example.test/token");
});

// ─── refreshGoogleAccessToken: success ──────────────────────────────────

test("refreshGoogleAccessToken returns the access token and now()+expires_in*1000 as expiresAt", async () => {
  const transport = makeFetch([jsonResponse({ access_token: "ya29.abc123", expires_in: 1800 })]);
  const result = await refreshGoogleAccessToken(CREDENTIALS, { fetch: transport.fetch, now: () => 10_000_000 });
  assert.equal(result.accessToken, "ya29.abc123");
  assert.equal(result.expiresAt, 10_000_000 + 1_800_000);
});

test("refreshGoogleAccessToken defaults expiresAt to a 3600s window when expires_in is absent", async () => {
  const transport = makeFetch([jsonResponse({ access_token: "ya29.no-expiry" })]);
  const result = await refreshGoogleAccessToken(CREDENTIALS, { fetch: transport.fetch, now: () => 0 });
  assert.equal(result.expiresAt, 3_600_000);
});

// ─── refreshGoogleAccessToken: malformed success (200 but unusable body) ─

test("refreshGoogleAccessToken throws on a 200 response with no access_token field", async () => {
  const transport = makeFetch([jsonResponse({ expires_in: 3600 })]);
  await assert.rejects(
    () => refreshGoogleAccessToken(CREDENTIALS, { fetch: transport.fetch }),
    /google_oauth_access_token_missing/
  );
});

test("refreshGoogleAccessToken throws on a 200 response with an empty-string access_token", async () => {
  const transport = makeFetch([jsonResponse({ access_token: "   ", expires_in: 3600 })]);
  await assert.rejects(
    () => refreshGoogleAccessToken(CREDENTIALS, { fetch: transport.fetch }),
    /google_oauth_access_token_missing/
  );
});

test("refreshGoogleAccessToken throws on a 200 response with a non-string access_token", async () => {
  const transport = makeFetch([jsonResponse({ access_token: 12_345, expires_in: 3600 })]);
  await assert.rejects(
    () => refreshGoogleAccessToken(CREDENTIALS, { fetch: transport.fetch }),
    /google_oauth_access_token_missing/
  );
});

test("refreshGoogleAccessToken ignores a non-numeric expires_in and falls back to the 3600s default", async () => {
  const transport = makeFetch([jsonResponse({ access_token: "ya29.ok", expires_in: "not-a-number" })]);
  const result = await refreshGoogleAccessToken(CREDENTIALS, { fetch: transport.fetch, now: () => 0 });
  assert.equal(result.expiresAt, 3_600_000);
});

// ─── refreshGoogleAccessToken: transient HTTP error ─────────────────────

test("refreshGoogleAccessToken throws GoogleOAuthError with status+bodySnippet on a transient 503", async () => {
  const transport = makeFetch([jsonResponse({ error: "backend_error" }, { status: 503 })]);
  await assert.rejects(
    () => refreshGoogleAccessToken(CREDENTIALS, { fetch: transport.fetch }),
    (error: unknown) => {
      assert.ok(error instanceof GoogleOAuthError);
      assert.equal(error.status, 503);
      assert.ok(error.bodySnippet.includes("backend_error"));
      return true;
    }
  );
});

test("refreshGoogleAccessToken truncates an oversized error body to 500 chars in bodySnippet", async () => {
  const hugeBody = JSON.stringify({ error: "x".repeat(2000) });
  const transport = makeFetch([
    new Response(hugeBody, { status: 502, headers: { "Content-Type": "application/json" } }),
  ]);
  await assert.rejects(
    () => refreshGoogleAccessToken(CREDENTIALS, { fetch: transport.fetch }),
    (error: unknown) => {
      assert.ok(error instanceof GoogleOAuthError);
      assert.equal(error.bodySnippet.length, 500);
      return true;
    }
  );
});

// ─── refreshGoogleAccessToken: invalid_grant (400) ──────────────────────

test("refreshGoogleAccessToken throws GoogleOAuthError with status 400 on invalid_grant (revoked/expired refresh token)", async () => {
  const transport = makeFetch([
    jsonResponse({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, { status: 400 }),
  ]);
  await assert.rejects(
    () => refreshGoogleAccessToken(CREDENTIALS, { fetch: transport.fetch }),
    (error: unknown) => {
      assert.ok(error instanceof GoogleOAuthError);
      assert.equal(error.status, 400);
      assert.ok(error.bodySnippet.includes("invalid_grant"));
      return true;
    }
  );
});

// ─── isGoogleOAuthGrantInvalid: classification ──────────────────────────

test("isGoogleOAuthGrantInvalid returns true for a 400 GoogleOAuthError (invalid_grant)", () => {
  assert.equal(isGoogleOAuthGrantInvalid(new GoogleOAuthError(400, "invalid_grant")), true);
});

test("isGoogleOAuthGrantInvalid returns true for a 401 GoogleOAuthError (bad client credentials)", () => {
  assert.equal(isGoogleOAuthGrantInvalid(new GoogleOAuthError(401, "invalid_client")), true);
});

test("isGoogleOAuthGrantInvalid returns false for a non-invalid-grant 4xx (e.g. 403)", () => {
  assert.equal(isGoogleOAuthGrantInvalid(new GoogleOAuthError(403, "forbidden")), false);
});

test("isGoogleOAuthGrantInvalid returns false for a transient 5xx GoogleOAuthError", () => {
  assert.equal(isGoogleOAuthGrantInvalid(new GoogleOAuthError(503, "backend_error")), false);
});

test("isGoogleOAuthGrantInvalid returns false for a 429 GoogleOAuthError", () => {
  assert.equal(isGoogleOAuthGrantInvalid(new GoogleOAuthError(429, "rate_limited")), false);
});

test("isGoogleOAuthGrantInvalid returns false for a non-GoogleOAuthError value", () => {
  assert.equal(isGoogleOAuthGrantInvalid(new Error("some other error")), false);
  assert.equal(isGoogleOAuthGrantInvalid("not an error"), false);
  assert.equal(isGoogleOAuthGrantInvalid(null), false);
  assert.equal(isGoogleOAuthGrantInvalid(undefined), false);
});
