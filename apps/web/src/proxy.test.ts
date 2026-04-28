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
 *   3. 404 direct hits on the underlying alias paths so the canonical URL
 *      is the only externally callable surface.
 *
 * These tests exercise the pure path helpers and the matcher config rather
 * than booting a full middleware request — `next/server` is not loadable
 * outside the bundler, and the rewrite logic is fully expressible at the
 * pathname level. Wiring the helpers through `proxy()` is covered by the
 * Next.js integration: if `rewriteSandboxCanonicalPath` returns a path,
 * `proxy()` calls `NextResponse.rewrite` against it; if `isSandboxInternalAlias`
 * returns true, `proxy()` returns a 404 JSON envelope.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { isSandboxInternalAlias, rewriteSandboxCanonicalPath } from "./proxy-paths.ts";

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
  // Underlying alias paths must NOT be rewritten — they should be 404'd
  // by the alias check below so only the canonical URL is callable.
  assert.equal(rewriteSandboxCanonicalPath("/sandbox/ref/grants"), null);
  assert.equal(rewriteSandboxCanonicalPath("/sandbox/well-known/oauth-authorization-server"), null);
});

test("rewriteSandboxCanonicalPath does not match same-prefix non-sandbox paths", () => {
  // Avoid matching neighbours like `/sandbox/_reference` or `/sandbox/.well`.
  assert.equal(rewriteSandboxCanonicalPath("/sandbox/_reference"), null);
  assert.equal(rewriteSandboxCanonicalPath("/sandbox/.well"), null);
});

test("isSandboxInternalAlias flags /sandbox/ref and /sandbox/well-known underlying paths", () => {
  assert.equal(isSandboxInternalAlias("/sandbox/ref"), true);
  assert.equal(isSandboxInternalAlias("/sandbox/ref/grants"), true);
  assert.equal(isSandboxInternalAlias("/sandbox/well-known"), true);
  assert.equal(isSandboxInternalAlias("/sandbox/well-known/oauth-authorization-server"), true);
});

test("isSandboxInternalAlias does NOT flag the canonical _ref/.well-known URLs", () => {
  // Canonical URLs must reach the rewrite path, not the 404 path.
  assert.equal(isSandboxInternalAlias("/sandbox/_ref"), false);
  assert.equal(isSandboxInternalAlias("/sandbox/_ref/grants"), false);
  assert.equal(isSandboxInternalAlias("/sandbox/.well-known"), false);
  assert.equal(isSandboxInternalAlias("/sandbox/.well-known/oauth-authorization-server"), false);
});

test("isSandboxInternalAlias does not over-match sibling paths", () => {
  assert.equal(isSandboxInternalAlias("/sandbox/reference"), false);
  assert.equal(isSandboxInternalAlias("/sandbox/well-known-extra"), false);
  assert.equal(isSandboxInternalAlias("/sandbox/v1/schema"), false);
});
