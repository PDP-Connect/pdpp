// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Shared owner-session acquisition for live-origin operator scripts.
//
// This is the ONE place that knows how to turn owner credentials from the
// environment (or an explicit password) into a `Cookie` header for
// `/_ref/*` and other cookie-gated owner routes, by driving the
// CSRF-protected `/owner/login` HTML form. Any script that needs an owner
// session against a live origin should import from here rather than
// re-implementing the `/owner/login` GET+POST dance or its cookie/CSRF
// parsing. Two call shapes are exported because existing callers differ in
// how they want failure reported, not in what they do on the wire:
//   - `loginWithOwnerPassword` / `resolveOwnerAuthForLive` return a result
//     object (`{ header, mode, error }`); used by harnesses that build a
//     structured report (owner-journey-acceptance, stream-health-audit).
//   - `establishOwnerSessionCookie` throws on failure and resolves to the
//     bare `Cookie` header string; used by imperative CLI smoke scripts
//     (railway-mcp-query-smoke, read-surface-smoke) that already fail via
//     thrown errors for every other step of their live run.
// Both call the same `loginWithOwnerPassword` underneath — there is exactly
// one implementation of the CSRF/cookie parsing and the POST body shape.
//
// `return_to` is fixed to `/` — the current owner-console landing route
// (reference-implementation/test/dashboard-proxy-redirect.test.js pins
// `GET /` -> 307 to `/owner/login?return_to=%2F`).
//
// Recognized environment variables for `resolveOwnerAuthForLive` (first
// match wins):
//   PDPP_OWNER_SESSION_COOKIE   full Cookie header for an already-established
//                               owner session — used as-is, no network call.
//   PDPP_OWNER_PASSWORD         owner password — POSTs the CSRF-protected
//                               `/owner/login` form and returns the session
//                               cookie `/owner/login` issues.
//
// Never logs or returns the password or session cookie value in any error
// message; callers must also avoid printing `header.cookie` / the resolved
// cookie string.

export const OWNER_LANDING_RETURN_TO = "/";

export function getSetCookieList(res) {
  if (typeof res.headers?.getSetCookie === "function") {
    return res.headers.getSetCookie();
  }
  const raw = res.headers?.get?.("set-cookie");
  return raw ? [raw] : [];
}

export function findSetCookiePair(cookies, name) {
  const prefix = `${name}=`;
  for (const header of cookies) {
    const firstPair = String(header).split(";")[0];
    if (firstPair.startsWith(prefix)) {
      return firstPair;
    }
  }
  return null;
}

export function extractCsrfFieldValue(html) {
  return String(html).match(/<input type="hidden" name="_csrf" value="([^"]+)"\s*\/>/)?.[1] ?? null;
}

/**
 * Log in with the owner password via the CSRF-protected `/owner/login` form
 * and return the resulting session cookie header.
 *
 * @param {object} args
 * @param {string} args.base   origin, no trailing slash
 * @param {string} args.password
 * @param {Function} args.fetchImpl
 * @returns {Promise<{ header: Record<string,string>, mode: "password-session", error: string|null }>}
 */
export async function loginWithOwnerPassword({ base, password, fetchImpl }) {
  const loginPage = await fetchImpl(`${base}/owner/login?return_to=${encodeURIComponent(OWNER_LANDING_RETURN_TO)}`, {
    headers: { accept: "text/html" },
    redirect: "manual",
  });
  const csrfCookie = findSetCookiePair(getSetCookieList(loginPage), "pdpp_owner_csrf");
  const csrfField = extractCsrfFieldValue(await loginPage.text());
  if (!(csrfCookie && csrfField)) {
    return { header: {}, mode: "password-session", error: "owner login did not return a CSRF cookie and field" };
  }

  const resp = await fetchImpl(`${base}/owner/login`, {
    method: "POST",
    headers: {
      accept: "text/html",
      "content-type": "application/x-www-form-urlencoded",
      cookie: csrfCookie,
    },
    redirect: "manual",
    body: new URLSearchParams({ password, return_to: OWNER_LANDING_RETURN_TO, _csrf: csrfField }).toString(),
  });
  const sessionCookie = findSetCookiePair(getSetCookieList(resp), "pdpp_owner_session");
  if (!sessionCookie) {
    return {
      header: {},
      mode: "password-session",
      error: `owner login did not issue a session cookie (status ${resp.status})`,
    };
  }
  return { header: { cookie: sessionCookie }, mode: "password-session", error: null };
}

/**
 * Resolve an owner session for a live origin from the environment.
 * Precedence: PDPP_OWNER_SESSION_COOKIE (used as-is) then PDPP_OWNER_PASSWORD
 * (logs in via `/owner/login`). Neither present resolves to mode "none".
 *
 * @param {object} args
 * @param {string} args.base       origin, no trailing slash
 * @param {NodeJS.ProcessEnv} args.env
 * @param {Function} args.fetchImpl
 * @returns {Promise<{ header: Record<string,string>, mode: "cookie"|"password-session"|"none", error: string|null }>}
 */
export async function resolveOwnerAuthForLive({ base, env, fetchImpl }) {
  const cookie = env.PDPP_OWNER_SESSION_COOKIE?.trim();
  if (cookie) {
    return { header: { cookie }, mode: "cookie", error: null };
  }

  const password = env.PDPP_OWNER_PASSWORD?.trim();
  if (password) {
    return loginWithOwnerPassword({ base, password, fetchImpl });
  }

  return { header: {}, mode: "none", error: null };
}

/**
 * Establish an owner session and return the bare `Cookie` header string
 * (e.g. `pdpp_owner_session=...`), throwing on any failure. This is the
 * calling convention imperative CLI smoke scripts use — they already fail
 * fast by throwing at every other step of a live run (register manifest,
 * seed records, mint tokens, ...), so a throwing wrapper around
 * `loginWithOwnerPassword` keeps this call site consistent with its
 * neighbors instead of forcing every caller to unpack a result object.
 *
 * @param {object} args
 * @param {string} args.origin       origin, no trailing slash
 * @param {string} args.ownerPassword
 * @param {Function} [args.fetchImpl] defaults to global fetch
 * @returns {Promise<string>} the `Cookie` header value, e.g. `pdpp_owner_session=...`
 */
export async function establishOwnerSessionCookie({ origin, ownerPassword, fetchImpl = fetch }) {
  const result = await loginWithOwnerPassword({ base: origin, password: ownerPassword, fetchImpl });
  if (result.error) {
    throw new Error(`owner login failed: ${result.error}`);
  }
  return result.header.cookie;
}
