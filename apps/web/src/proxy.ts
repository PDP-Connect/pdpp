import { isMarkdownPreferred, rewritePath } from "fumadocs-core/negotiation";
import { type NextRequest, NextResponse } from "next/server";
import { OWNER_AUTH_COOKIE_NAME } from "pdpp-reference-implementation/owner-session";
import { resolveReferenceTopology } from "pdpp-reference-implementation/reference-topology";
import { normalizeDashboardReturnTo } from "@/app/dashboard/lib/return-to.ts";
import { isSandboxInternalAlias, rewriteSandboxCanonicalPath } from "./proxy-paths.ts";

const { rewrite: rewriteLLM } = rewritePath("/docs{/*path}", "/llms.mdx/docs{/*path}");
const referenceTopology = resolveReferenceTopology();
const AS_PROXY_TARGET = referenceTopology.asInternalUrl;
const RS_PROXY_TARGET = referenceTopology.rsInternalUrl;

// Optimistic auth gate at the proxy layer (Next.js 16 BFF pattern). When
// owner-auth is on and the BFF process holds the password, we could HMAC-
// verify here too — but the documented topology allows split deployments
// where only the AS holds the password. So proxy does cookie-presence-only
// for the redirect UX; the DAL (dashboard/lib/verify-session.ts) is the
// authoritative gate that runs before any data leaves the AS.
//
// We only redirect when owner-auth is plausibly enabled in this process. When
// `PDPP_OWNER_PASSWORD` is unset, the local-dev open path stays open and the
// AS remains authoritative for downstream `_ref` / `/v1` requests. This
// matches the behavior pinned by `gate-ref-reads-when-owner-auth-enabled`.
const OWNER_AUTH_PROBABLY_ENABLED =
  typeof process.env.PDPP_OWNER_PASSWORD === "string" && process.env.PDPP_OWNER_PASSWORD.length > 0;

function resolveReferenceProxyTarget(pathname: string): string | null {
  if (pathname === "/.well-known/oauth-protected-resource") {
    return RS_PROXY_TARGET;
  }
  if (pathname === "/.well-known/oauth-authorization-server") {
    return AS_PROXY_TARGET;
  }
  if (pathname.startsWith("/oauth/")) {
    return AS_PROXY_TARGET;
  }
  if (pathname === "/introspect") {
    return AS_PROXY_TARGET;
  }
  if (pathname.startsWith("/grants/") && pathname.endsWith("/revoke")) {
    return AS_PROXY_TARGET;
  }
  if (pathname.startsWith("/_ref/")) {
    return AS_PROXY_TARGET;
  }
  if (pathname.startsWith("/owner/")) {
    return AS_PROXY_TARGET;
  }
  if (pathname === "/device" || pathname.startsWith("/device/")) {
    return AS_PROXY_TARGET;
  }
  if (pathname === "/consent" || pathname.startsWith("/consent/")) {
    return AS_PROXY_TARGET;
  }
  if (pathname.startsWith("/__pdpp/")) {
    return AS_PROXY_TARGET;
  }
  if (pathname === "/connectors" || pathname.startsWith("/connectors/")) {
    return AS_PROXY_TARGET;
  }
  if (pathname.startsWith("/v1/")) {
    return RS_PROXY_TARGET;
  }
  return null;
}

export default function proxy(request: NextRequest) {
  if (isMarkdownPreferred(request)) {
    const result = rewriteLLM(request.nextUrl.pathname);

    if (result) {
      return NextResponse.rewrite(new URL(result, request.nextUrl));
    }
  }

  const canonicalRewrite = rewriteSandboxCanonicalPath(request.nextUrl.pathname);
  if (canonicalRewrite) {
    return NextResponse.rewrite(new URL(`${canonicalRewrite}${request.nextUrl.search}`, request.nextUrl));
  }

  if (isSandboxInternalAlias(request.nextUrl.pathname)) {
    return NextResponse.json(
      {
        object: "error",
        error: "not_found",
        message: "Use the canonical sandbox paths: /sandbox/_ref/** or /sandbox/.well-known/**.",
      },
      { status: 404 }
    );
  }

  if (request.nextUrl.pathname === "/dashboard" || request.nextUrl.pathname.startsWith("/dashboard/")) {
    // Optimistic auth-redirect: if owner-auth might be enabled and the
    // session cookie is missing, bounce to /owner/login *before* any
    // server component renders. This eliminates the layout-vs-page
    // render race that previously surfaced raw 401s on logged-out
    // /dashboard hits. The DAL (dashboard/lib/verify-session.ts) is
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
    // (owner login redirect, server-unreachable shell, or the dashboard itself).
    const response = NextResponse.next({
      request: {
        headers: requestHeaders,
      },
    });
    response.headers.set("X-Robots-Tag", "noindex, nofollow");
    return response;
  }

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

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/docs",
    "/docs/:path*",
    "/dashboard",
    "/dashboard/:path*",
    "/sandbox/_ref",
    "/sandbox/_ref/:path*",
    "/sandbox/.well-known",
    "/sandbox/.well-known/:path*",
    "/sandbox/ref",
    "/sandbox/ref/:path*",
    "/sandbox/well-known",
    "/sandbox/well-known/:path*",
    "/.well-known/:path*",
    "/oauth/:path*",
    "/introspect",
    "/grants/:path*",
    "/_ref/:path*",
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
