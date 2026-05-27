/**
 * Proxy posture tests for the sandbox canonical paths.
 *
 * Background: the public sandbox advertises `/sandbox/_ref/**` and
 * `/sandbox/.well-known/**` as the canonical, callable URLs (mirroring the
 * shape of the live PDPP reference at `/_ref/**` and `/.well-known/**`).
 * App Router cannot host directories named `_ref` or `.well-known`, so the
 * underlying handlers live at `/sandbox/ref/**` and `/sandbox/well-known/**`
 * and the proxy rewrites the canonical URLs onto them.
 *
 * The proxy MUST:
 *   1. Rewrite `/sandbox/_ref/**` → `/sandbox/ref/**`.
 *   2. Rewrite `/sandbox/.well-known/**` → `/sandbox/well-known/**`.
 *   3. Redirect direct hits on the underlying alias paths back to their
 *      canonical URL, preserving a single advertised surface while keeping
 *      copied links useful.
 *
 * These tests exercise the pure path helpers and the matcher config rather
 * than booting a full middleware request — `next/server` is not loadable
 * outside the bundler, and the rewrite logic is fully expressible at the
 * pathname level. Wiring the helpers through `proxy()` is covered by the
 * Next.js integration: if `rewriteSandboxCanonicalPath` returns a path,
 * `proxy()` calls `NextResponse.rewrite` against it; if
 * `redirectSandboxAliasPath` returns a path, `proxy()` redirects to it.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { isDashboardAuthRedirectEnabled } from "./proxy-policy.ts";
import { redirectSandboxAliasPath, rewriteSandboxCanonicalPath } from "./proxy-paths.ts";

test("rewriteSandboxCanonicalPath maps /sandbox/_ref/** onto /sandbox/ref/**", () => {
  assert.equal(rewriteSandboxCanonicalPath("/sandbox/_ref/grants"), "/sandbox/ref/grants");
  assert.equal(
    rewriteSandboxCanonicalPath("/sandbox/_ref/grants/grant_sb_quill_paystmt/timeline"),
    "/sandbox/ref/grants/grant_sb_quill_paystmt/timeline"
  );
  assert.equal(
    rewriteSandboxCanonicalPath("/sandbox/_ref/runs/run_sb_acme_2026_04_22/timeline"),
    "/sandbox/ref/runs/run_sb_acme_2026_04_22/timeline"
  );
  assert.equal(rewriteSandboxCanonicalPath("/sandbox/_ref/dataset/summary"), "/sandbox/ref/dataset/summary");
});

test("rewriteSandboxCanonicalPath maps /sandbox/.well-known/** onto /sandbox/well-known/**", () => {
  assert.equal(
    rewriteSandboxCanonicalPath("/sandbox/.well-known/oauth-authorization-server"),
    "/sandbox/well-known/oauth-authorization-server"
  );
  assert.equal(
    rewriteSandboxCanonicalPath("/sandbox/.well-known/oauth-protected-resource"),
    "/sandbox/well-known/oauth-protected-resource"
  );
});

test("rewriteSandboxCanonicalPath maps the bare canonical roots", () => {
  assert.equal(rewriteSandboxCanonicalPath("/sandbox/_ref"), "/sandbox/ref");
  assert.equal(rewriteSandboxCanonicalPath("/sandbox/.well-known"), "/sandbox/well-known");
});

test("rewriteSandboxCanonicalPath leaves other paths alone", () => {
  // Live (non-sandbox) paths must keep flowing to the AS/RS proxy targets.
  assert.equal(rewriteSandboxCanonicalPath("/_ref/grants"), null);
  assert.equal(rewriteSandboxCanonicalPath("/.well-known/oauth-authorization-server"), null);
  // Public-shaped sandbox paths must not be rewritten.
  assert.equal(rewriteSandboxCanonicalPath("/sandbox/v1/schema"), null);
  // Dashboard surfaces must not be rewritten.
  assert.equal(rewriteSandboxCanonicalPath("/dashboard/overview"), null);
  // Underlying alias paths must NOT be rewritten — they should redirect
  // by the alias check below so the canonical URL remains the advertised URL.
  assert.equal(rewriteSandboxCanonicalPath("/sandbox/ref/grants"), null);
  assert.equal(rewriteSandboxCanonicalPath("/sandbox/well-known/oauth-authorization-server"), null);
});

test("rewriteSandboxCanonicalPath does not match same-prefix non-sandbox paths", () => {
  // Avoid matching neighbours like `/sandbox/_reference` or `/sandbox/.well`.
  assert.equal(rewriteSandboxCanonicalPath("/sandbox/_reference"), null);
  assert.equal(rewriteSandboxCanonicalPath("/sandbox/.well"), null);
});

test("redirectSandboxAliasPath maps /sandbox/ref and /sandbox/well-known aliases to canonical paths", () => {
  assert.equal(redirectSandboxAliasPath("/sandbox/ref"), "/sandbox/_ref");
  assert.equal(redirectSandboxAliasPath("/sandbox/ref/grants"), "/sandbox/_ref/grants");
  assert.equal(redirectSandboxAliasPath("/sandbox/well-known"), "/sandbox/.well-known");
  assert.equal(
    redirectSandboxAliasPath("/sandbox/well-known/oauth-authorization-server"),
    "/sandbox/.well-known/oauth-authorization-server"
  );
});

test("redirectSandboxAliasPath does NOT canonicalize already-canonical _ref/.well-known URLs", () => {
  // Canonical URLs must reach the rewrite path, not the 404 path.
  assert.equal(redirectSandboxAliasPath("/sandbox/_ref"), null);
  assert.equal(redirectSandboxAliasPath("/sandbox/_ref/grants"), null);
  assert.equal(redirectSandboxAliasPath("/sandbox/.well-known"), null);
  assert.equal(redirectSandboxAliasPath("/sandbox/.well-known/oauth-authorization-server"), null);
});

test("redirectSandboxAliasPath does not over-match sibling paths", () => {
  assert.equal(redirectSandboxAliasPath("/sandbox/reference"), null);
  assert.equal(redirectSandboxAliasPath("/sandbox/well-known-extra"), null);
  assert.equal(redirectSandboxAliasPath("/sandbox/v1/schema"), null);
});

test("dashboard auth redirect policy defaults on for production operator consoles", () => {
  assert.equal(isDashboardAuthRedirectEnabled({ NODE_ENV: "production" }), true);
  assert.equal(
    isDashboardAuthRedirectEnabled({
      NODE_ENV: "production",
      PDPP_DASHBOARD_AUTH_REDIRECT: "0",
    }),
    false
  );
});

test("dashboard auth redirect policy preserves open local-dev unless owner auth is configured", () => {
  assert.equal(isDashboardAuthRedirectEnabled({ NODE_ENV: "development" }), false);
  assert.equal(
    isDashboardAuthRedirectEnabled({
      NODE_ENV: "development",
      PDPP_OWNER_PASSWORD: "owner-password",
    }),
    true
  );
});
