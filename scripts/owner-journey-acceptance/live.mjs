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
  const { header, mode } = resolveOwnerAuthFromEnv(env);
  const findings = [];
  const surfaces = [];

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
