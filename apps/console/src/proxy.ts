// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { type NextRequest, NextResponse } from "next/server";
import { OWNER_AUTH_COOKIE_NAME } from "pdpp-reference-implementation/owner-session";
import { resolveReferenceTopology } from "pdpp-reference-implementation/reference-topology";
import { normalizeDashboardReturnTo } from "@/app/(console)/lib/return-to.ts";

const referenceTopology = resolveReferenceTopology();
const AS_PROXY_TARGET = referenceTopology.asInternalUrl;

// Optimistic auth gate at the proxy layer (Next.js 16 BFF pattern). When
// owner-auth is on and the BFF process holds the password, we could HMAC-
// verify here too — but the documented topology allows split deployments
// where only the AS holds the password. So proxy does cookie-presence-only
// for the redirect UX; the DAL ((console)/lib/verify-session.ts) is the
// authoritative gate that runs before any data leaves the AS.
//
// We only redirect when owner-auth is plausibly enabled in this process. When
// `PDPP_OWNER_PASSWORD` is unset, the local-dev open path stays open and the
// AS remains authoritative for downstream `_ref` / `/v1` requests. This
// matches the behavior pinned by `gate-ref-reads-when-owner-auth-enabled`.
const OWNER_AUTH_PROBABLY_ENABLED =
  typeof process.env.PDPP_OWNER_PASSWORD === "string" && process.env.PDPP_OWNER_PASSWORD.length > 0;

// Clean owner-console route prefixes. The console owner control plane lives at
// top-level nouns off root; the overview is `/`. Removed legacy console-prefix
// paths are intentionally not routed or redirected.
const OWNER_ROUTE_PREFIXES = [
  "/sources",
  "/syncs",
  "/audit",
  "/explore",
  "/grants",
  "/connect",
  "/notifications",
  "/schedules",
  "/deployment",
  "/device-exporters",
  "/event-subscriptions",
  "/search",
  "/stream-playground",
] as const;

// Is this an owner control-plane page request (as opposed to an AS-proxied
// protocol path)? The overview `/` matches only itself; every section matches
// its prefix at a segment boundary. AS-proxied paths under a shared prefix
// (e.g. `/grants/:id/revoke`) are handled earlier and never reach here.
function isOwnerRoute(pathname: string): boolean {
  if (pathname === "/") {
    return true;
  }
  for (const prefix of OWNER_ROUTE_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      return true;
    }
  }
  return false;
}

function resolveReferenceProxyTarget(pathname: string): string | null {
  // Public protocol paths use route handlers, not middleware rewrites, so
  // responses do not expose Next's internal x-middleware-rewrite target.
  if (pathname === "/agent-connect" || pathname.startsWith("/agent-connect/")) {
    return AS_PROXY_TARGET;
  }
  if (pathname.startsWith("/grants/") && pathname.endsWith("/revoke")) {
    return AS_PROXY_TARGET;
  }
  if (pathname.startsWith("/_ref/")) {
    return AS_PROXY_TARGET;
  }
  if (pathname === "/neko" || pathname.startsWith("/neko/")) {
    return AS_PROXY_TARGET;
  }
  if (pathname.startsWith("/__pdpp/")) {
    return AS_PROXY_TARGET;
  }
  if (pathname === "/connectors" || pathname.startsWith("/connectors/")) {
    return AS_PROXY_TARGET;
  }
  return null;
}

export default function proxy(request: NextRequest) {
  // AS-proxied protocol paths first, so paths that share a prefix with an owner
  // section (notably `/grants/:id/revoke`) are rewritten to the AS rather than
  // caught by the owner-page gate below.
  const proxyTarget = resolveReferenceProxyTarget(request.nextUrl.pathname);
  if (proxyTarget) {
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set("x-forwarded-host", request.headers.get("host") ?? request.nextUrl.host);
    requestHeaders.set("x-forwarded-proto", request.nextUrl.protocol.replace(":", ""));
    return NextResponse.rewrite(new URL(`${request.nextUrl.pathname}${request.nextUrl.search}`, proxyTarget), {
      request: {
        headers: requestHeaders,
      },
    });
  }

  if (isOwnerRoute(request.nextUrl.pathname)) {
    // Optimistic auth-redirect: if owner-auth might be enabled and the
    // session cookie is missing, bounce to /owner/login *before* any
    // server component renders. This eliminates the layout-vs-page
    // render race that previously surfaced raw 401s on logged-out
    // owner hits. The DAL ((console)/lib/verify-session.ts) is
    // the authoritative gate; this is purely UX.
    if (OWNER_AUTH_PROBABLY_ENABLED) {
      const sessionCookie = request.cookies.get(OWNER_AUTH_COOKIE_NAME);
      if (!sessionCookie?.value) {
        const returnTo = normalizeDashboardReturnTo(`${request.nextUrl.pathname}${request.nextUrl.search}`);
        const loginUrl = new URL("/owner/login", request.nextUrl);
        loginUrl.searchParams.set("return_to", returnTo);
        const redirect = NextResponse.redirect(loginUrl, 307);
        redirect.headers.set("X-Robots-Tag", "noindex, nofollow");
        return redirect;
      }
    }

    const requestHeaders = new Headers(request.headers);
    requestHeaders.set("x-pdpp-return-to", `${request.nextUrl.pathname}${request.nextUrl.search}`);
    // Live operator surface — never indexable, regardless of which layout renders
    // (owner login redirect, server-unreachable shell, or the console itself).
    const response = NextResponse.next({
      request: {
        headers: requestHeaders,
      },
    });
    response.headers.set("X-Robots-Tag", "noindex, nofollow");
    return response;
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // Owner overview at root.
    "/",
    // Clean owner-console sections (redesign-owner-console-product-experience §10.B).
    "/sources",
    "/sources/:path*",
    "/syncs",
    "/syncs/:path*",
    "/audit",
    "/audit/:path*",
    "/explore",
    "/explore/:path*",
    "/grants",
    "/grants/:path*",
    "/connect",
    "/connect/:path*",
    "/notifications",
    "/notifications/:path*",
    "/schedules",
    "/schedules/:path*",
    "/deployment",
    "/deployment/:path*",
    "/device-exporters",
    "/device-exporters/:path*",
    "/event-subscriptions",
    "/event-subscriptions/:path*",
    "/search",
    "/search/:path*",
    "/stream-playground",
    "/stream-playground/:path*",
    // Protocol / AS-proxy paths.
    "/.well-known/:path*",
    "/oauth/:path*",
    "/agent-connect",
    "/agent-connect/:path*",
    "/introspect",
    "/_ref/:path*",
    "/neko",
    "/neko/:path*",
    "/owner/:path*",
    "/device",
    "/device/:path*",
    "/consent",
    "/consent/:path*",
    "/__pdpp/:path*",
    "/connectors",
    "/connectors/:path*",
    "/v1/:path*",
  ],
};
