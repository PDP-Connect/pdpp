// Optional live-origin probe for the owner-journey acceptance harness.
//
// When the owner supplies a live origin (and owner auth), the harness fetches
// the rendered owner setup surfaces over HTTP and runs the same forbidden-string
// rules over the served HTML. This catches a leak that only appears in the
// deployed render (e.g. a server-injected string) — without any browser
// automation; a plain authenticated fetch is enough for static-string checks.
//
// Auth is read from the environment and NEVER printed. The harness passes the
// owner session cookie or bearer through to the fetch and reports only whether
// auth was supplied, never its value.

import { FORBIDDEN_STRING_RULES } from "./surface-manifest.mjs";
import { lineOf, scanForbiddenStrings } from "./scan.mjs";

/**
 * Owner setup surfaces to probe on a live origin. Path + tier; the forbidden
 * rules for that tier are applied to the served HTML.
 */
export const LIVE_SURFACES = [
  { path: "/dashboard/connect", tier: "normal" },
  { path: "/dashboard/records", tier: "normal" },
  { path: "/dashboard/records/add", tier: "normal" },
  { path: "/dashboard/device-exporters", tier: "advanced" },
];

/**
 * Resolve owner auth from the environment without exposing its value.
 * Recognized (first match wins):
 *   PDPP_OWNER_SESSION_COOKIE — full Cookie header value for an owner session.
 *   PDPP_OWNER_TOKEN          — owner bearer token.
 *
 * @returns {{ header: Record<string,string>, mode: "cookie"|"bearer"|"none" }}
 */
export function resolveOwnerAuthFromEnv(env = process.env) {
  const cookie = env.PDPP_OWNER_SESSION_COOKIE?.trim();
  if (cookie) {
    return { header: { cookie }, mode: "cookie" };
  }
  const token = env.PDPP_OWNER_TOKEN?.trim();
  if (token) {
    return { header: { authorization: `Bearer ${token}` }, mode: "bearer" };
  }
  return { header: {}, mode: "none" };
}

function setCookiePairs(res) {
  if (typeof res.headers?.getSetCookie === "function") {
    return res.headers.getSetCookie();
  }
  const raw = res.headers?.get?.("set-cookie");
  return raw ? [raw] : [];
}

function findCookiePair(cookies, name) {
  const prefix = `${name}=`;
  const entry = cookies.find((cookie) => cookie.startsWith(prefix));
  return entry ? entry.split(";")[0] : null;
}

function extractCsrfField(html) {
  return html.match(/<input type="hidden" name="_csrf" value="([^"]+)"\s*\/>/)?.[1] ?? null;
}

async function loginWithOwnerPassword({ base, password, fetchImpl }) {
  const loginPage = await fetchImpl(`${base}/owner/login?return_to=%2Fdashboard`, {
    headers: { accept: "text/html" },
    redirect: "manual",
  });
  const csrfCookie = findCookiePair(setCookiePairs(loginPage), "pdpp_owner_csrf");
  const csrfField = extractCsrfField(await loginPage.text());
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
    body: new URLSearchParams({ password, return_to: "/dashboard", _csrf: csrfField }).toString(),
  });
  const sessionCookie = findCookiePair(setCookiePairs(resp), "pdpp_owner_session");
  if (!sessionCookie) {
    return { header: {}, mode: "password-session", error: `owner login did not issue a session cookie (status ${resp.status})` };
  }
  return { header: { cookie: sessionCookie }, mode: "password-session", error: null };
}

async function resolveOwnerAuthForLive({ base, env, fetchImpl }) {
  const cookie = env.PDPP_OWNER_SESSION_COOKIE?.trim();
  if (cookie) {
    return { header: { cookie }, mode: "cookie", error: null };
  }

  const password = env.PDPP_OWNER_PASSWORD?.trim();
  if (password) {
    return loginWithOwnerPassword({ base, password, fetchImpl });
  }

  // `_ref` owner-session routes do not generally accept owner bearer tokens on
  // the composed dashboard origin, but keep this as a best-effort fallback for
  // older/local references that did.
  const token = env.PDPP_OWNER_TOKEN?.trim();
  if (token) {
    return { header: { authorization: `Bearer ${token}` }, mode: "bearer", error: null };
  }

  return { header: {}, mode: "none", error: null };
}

/**
 * Fetch and scan the live owner surfaces. Network and auth failures are captured
 * as surface-level errors, not thrown, so the harness can still emit a report.
 *
 * @param {object} args
 * @param {string} args.origin   e.g. https://pdpp.example.com (no trailing slash required)
 * @param {object} [args.env]    defaults to process.env
 * @param {Function} [args.fetchImpl] injectable for tests; defaults to global fetch
 * @returns {Promise<{ origin:string, authMode:string, surfaces:Array, findings:Array, ok:boolean }>}
 */
export async function runLiveAcceptance({ origin, env = process.env, fetchImpl = fetch }) {
  const base = origin.replace(/\/+$/, "");
  const { header, mode, error: authError } = await resolveOwnerAuthForLive({ base, env, fetchImpl });
  const findings = [];
  const surfaces = [];

  if (authError) {
    findings.push({
      ruleId: "live-owner-auth-failed",
      class: "live-probe-inconclusive",
      path: "live:owner-auth",
      line: 0,
      excerpt: authError,
      rationale:
        "The live acceptance gate must inspect authenticated owner renders. Login/auth failure makes the live probe inconclusive, not passing.",
    });
  }

  for (const surface of LIVE_SURFACES) {
    const url = `${base}${surface.path}`;
    try {
      const res = await fetchImpl(url, {
        headers: { accept: "text/html", ...header },
        redirect: "manual",
      });
      const status = res.status;
      const html = await res.text();
      // A login redirect / 401 means the probe could not see the owner surface;
      // record it as inconclusive rather than a pass.
      const reachedOwnerSurface = status >= 200 && status < 300;
      const surfaceFindings = reachedOwnerSurface
        ? scanForbiddenStrings({
            path: `live:${surface.path}`,
            src: html,
            tier: surface.tier,
            rules: FORBIDDEN_STRING_RULES,
          }).map((f) => ({ ...f, live: true, line: f.line || lineOf(html, 0) }))
        : [];
      findings.push(...surfaceFindings);
      if (!reachedOwnerSurface) {
        findings.push({
          ruleId: "live-owner-surface-not-reached",
          class: "live-probe-inconclusive",
          path: `live:${surface.path}`,
          line: 0,
          excerpt: `status ${status}`,
          rationale:
            "The live probe did not reach the authenticated owner surface. A login redirect, 401, 404, or server error cannot prove the rendered journey is clean.",
        });
      }
      surfaces.push({
        path: surface.path,
        tier: surface.tier,
        status,
        reachedOwnerSurface,
        bytes: html.length,
        findingCount: surfaceFindings.length,
      });
    } catch (err) {
      surfaces.push({
        path: surface.path,
        tier: surface.tier,
        status: null,
        reachedOwnerSurface: false,
        error: err instanceof Error ? err.message : String(err),
      });
      findings.push({
        ruleId: "live-owner-surface-fetch-failed",
        class: "live-probe-inconclusive",
        path: `live:${surface.path}`,
        line: 0,
        excerpt: err instanceof Error ? err.message : String(err),
        rationale:
          "The live probe could not fetch the owner surface. Network or runtime failures are acceptance failures until the rendered journey is observed.",
      });
    }
  }

  return {
    origin: base,
    authMode: mode,
    surfaces,
    findings,
    ok: findings.length === 0,
  };
}
