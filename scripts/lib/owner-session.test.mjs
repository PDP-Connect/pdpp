// Unit tests for the shared owner-session acquisition helper
// (scripts/lib/owner-session.mjs) — the one place that drives the
// CSRF-protected /owner/login form. Every consumer (stream-health-audit,
// owner-journey-acceptance, railway-mcp-query-smoke, read-surface-smoke)
// depends on this contract, so it is pinned directly here rather than only
// indirectly through each consumer's own tests.
//
// Run: node --test scripts/lib/owner-session.test.mjs

import assert from "node:assert/strict";
import test from "node:test";

import {
  establishOwnerSessionCookie,
  extractCsrfFieldValue,
  findSetCookiePair,
  getSetCookieList,
  loginWithOwnerPassword,
  OWNER_LANDING_RETURN_TO,
  resolveOwnerAuthForLive,
} from "./owner-session.mjs";

function response(status, body, setCookieHeaders = []) {
  return {
    status,
    headers: {
      getSetCookie: () => setCookieHeaders,
      get: (name) => (name.toLowerCase() === "set-cookie" ? setCookieHeaders[0] ?? null : null),
    },
    text: async () => body,
  };
}

test("OWNER_LANDING_RETURN_TO is the current console root", () => {
  // reference-implementation/test/dashboard-proxy-redirect.test.js pins
  // GET / -> 307 to /owner/login?return_to=%2F.
  assert.equal(OWNER_LANDING_RETURN_TO, "/");
});

test("findSetCookiePair: extracts the named pair, ignores attributes/others", () => {
  const headers = [
    "pdpp_owner_csrf=abc123; Path=/; HttpOnly; SameSite=Lax",
    "pdpp_owner_session=sess999; Path=/; Secure; HttpOnly",
  ];
  assert.equal(findSetCookiePair(headers, "pdpp_owner_csrf"), "pdpp_owner_csrf=abc123");
  assert.equal(findSetCookiePair(headers, "pdpp_owner_session"), "pdpp_owner_session=sess999");
  assert.equal(findSetCookiePair(headers, "missing"), null);
});

test("extractCsrfFieldValue: reads the hidden _csrf input", () => {
  const html = '<form><input type="hidden" name="_csrf" value="tok-42" /><input name="password"></form>';
  assert.equal(extractCsrfFieldValue(html), "tok-42");
  assert.equal(extractCsrfFieldValue("<form>no csrf here</form>"), null);
});

test("getSetCookieList: prefers getSetCookie(), falls back to a single set-cookie header", () => {
  assert.deepEqual(getSetCookieList(response(200, "", ["a=1", "b=2"])), ["a=1", "b=2"]);
  const singleHeaderResp = { status: 200, headers: { get: (n) => (n === "set-cookie" ? "c=3" : null) } };
  assert.deepEqual(getSetCookieList(singleHeaderResp), ["c=3"]);
  const noHeaderResp = { status: 200, headers: { get: () => null } };
  assert.deepEqual(getSetCookieList(noHeaderResp), []);
});

test("loginWithOwnerPassword: drives the CSRF form with return_to=/ and returns the session cookie", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("/owner/login") && init.method !== "POST") {
      return response(200, '<input type="hidden" name="_csrf" value="csrf-1" />', ["pdpp_owner_csrf=csrf-cookie; Path=/"]);
    }
    if (String(url).endsWith("/owner/login") && init.method === "POST") {
      return response(302, "", ["pdpp_owner_session=session-cookie; Path=/; HttpOnly"]);
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const result = await loginWithOwnerPassword({ base: "https://pdpp.example.com", password: "hunter2", fetchImpl });

  assert.deepEqual(result, { header: { cookie: "pdpp_owner_session=session-cookie" }, mode: "password-session", error: null });
  const getCall = calls.find((c) => c.init.method !== "POST");
  assert.equal(getCall.url, "https://pdpp.example.com/owner/login?return_to=%2F");
  const postCall = calls.find((c) => c.init.method === "POST");
  const postParams = new URLSearchParams(postCall.init.body);
  assert.equal(postParams.get("return_to"), "/");
  assert.equal(postParams.get("password"), "hunter2");
  assert.equal(postParams.get("_csrf"), "csrf-1");
});

test("loginWithOwnerPassword: fails closed (no cookie leaked) when the login page has no CSRF cookie/field", async () => {
  const fetchImpl = async () => response(200, "<html>no csrf here</html>", []);
  const result = await loginWithOwnerPassword({ base: "https://pdpp.example.com", password: "hunter2", fetchImpl });
  assert.equal(result.header.cookie, undefined);
  assert.match(result.error, /CSRF/);
});

test("loginWithOwnerPassword: fails closed when the POST does not issue a session cookie", async () => {
  const fetchImpl = async (url, init = {}) => {
    if (init.method !== "POST") {
      return response(200, '<input type="hidden" name="_csrf" value="csrf-1" />', ["pdpp_owner_csrf=csrf-cookie; Path=/"]);
    }
    return response(401, "", []);
  };
  const result = await loginWithOwnerPassword({ base: "https://pdpp.example.com", password: "wrong", fetchImpl });
  assert.equal(result.header.cookie, undefined);
  assert.match(result.error, /did not issue a session cookie \(status 401\)/);
});

test("resolveOwnerAuthForLive: PDPP_OWNER_SESSION_COOKIE precedence — never calls /owner/login", async () => {
  let loginCalled = false;
  const fetchImpl = async (url) => {
    if (String(url).includes("/owner/login")) {
      loginCalled = true;
      throw new Error("must not log in when a cookie is already supplied");
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const result = await resolveOwnerAuthForLive({
    base: "https://pdpp.example.com",
    env: { PDPP_OWNER_SESSION_COOKIE: "pdpp_owner_session=explicit", PDPP_OWNER_PASSWORD: "ignored" },
    fetchImpl,
  });
  assert.equal(loginCalled, false);
  assert.deepEqual(result, { header: { cookie: "pdpp_owner_session=explicit" }, mode: "cookie", error: null });
});

test("resolveOwnerAuthForLive: falls back to PDPP_OWNER_PASSWORD when no cookie is set", async () => {
  const fetchImpl = async (url, init = {}) => {
    if (String(url).includes("/owner/login") && init.method !== "POST") {
      return response(200, '<input type="hidden" name="_csrf" value="csrf-1" />', ["pdpp_owner_csrf=csrf-cookie; Path=/"]);
    }
    return response(302, "", ["pdpp_owner_session=session-cookie; Path=/; HttpOnly"]);
  };
  const result = await resolveOwnerAuthForLive({
    base: "https://pdpp.example.com",
    env: { PDPP_OWNER_PASSWORD: "hunter2" },
    fetchImpl,
  });
  assert.equal(result.mode, "password-session");
  assert.equal(result.header.cookie, "pdpp_owner_session=session-cookie");
});

test("resolveOwnerAuthForLive: mode none when neither cookie nor password is set", async () => {
  const result = await resolveOwnerAuthForLive({
    base: "https://pdpp.example.com",
    env: {},
    fetchImpl: async () => {
      throw new Error("must not fetch");
    },
  });
  assert.deepEqual(result, { header: {}, mode: "none", error: null });
});

test("establishOwnerSessionCookie: resolves to the bare Cookie header string on success", async () => {
  const fetchImpl = async (url, init = {}) => {
    if (init.method !== "POST") {
      return response(200, '<input type="hidden" name="_csrf" value="csrf-1" />', ["pdpp_owner_csrf=csrf-cookie; Path=/"]);
    }
    return response(302, "", ["pdpp_owner_session=session-cookie; Path=/; HttpOnly"]);
  };
  const cookie = await establishOwnerSessionCookie({ origin: "https://pdpp.example.com", ownerPassword: "hunter2", fetchImpl });
  assert.equal(cookie, "pdpp_owner_session=session-cookie");
});

test("establishOwnerSessionCookie: throws (does not silently return undefined) on failure", async () => {
  const fetchImpl = async () => response(200, "<html>no csrf</html>", []);
  await assert.rejects(
    () => establishOwnerSessionCookie({ origin: "https://pdpp.example.com", ownerPassword: "hunter2", fetchImpl }),
    /owner login failed/
  );
});

test("no secret ever appears in a thrown error or returned result", async () => {
  const fetchImpl = async () => response(200, "<html>no csrf</html>", []);
  let thrown = null;
  try {
    await establishOwnerSessionCookie({ origin: "https://pdpp.example.com", ownerPassword: "super-secret-pw", fetchImpl });
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown);
  assert.ok(!String(thrown.message).includes("super-secret-pw"));

  const loginResult = await loginWithOwnerPassword({
    base: "https://pdpp.example.com",
    password: "super-secret-pw",
    fetchImpl,
  });
  assert.ok(!JSON.stringify(loginResult).includes("super-secret-pw"));
});
