import { isMarkdownPreferred, rewritePath } from "fumadocs-core/negotiation";
import { type NextRequest, NextResponse } from "next/server";
import { resolveReferenceTopology } from "pdpp-reference-implementation/reference-topology";

const { rewrite: rewriteLLM } = rewritePath("/docs{/*path}", "/llms.mdx/docs{/*path}");
const referenceTopology = resolveReferenceTopology();
const AS_PROXY_TARGET = referenceTopology.asInternalUrl;
const RS_PROXY_TARGET = referenceTopology.rsInternalUrl;

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

function isSandboxInternalAlias(pathname: string): boolean {
  return (
    pathname === "/sandbox/ref" ||
    pathname.startsWith("/sandbox/ref/") ||
    pathname === "/sandbox/well-known" ||
    pathname.startsWith("/sandbox/well-known/")
  );
}

export default function proxy(request: NextRequest) {
  if (isMarkdownPreferred(request)) {
    const result = rewriteLLM(request.nextUrl.pathname);

    if (result) {
      return NextResponse.rewrite(new URL(result, request.nextUrl));
    }
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
    return NextResponse.rewrite(new URL(`${request.nextUrl.pathname}${request.nextUrl.search}`, proxyTarget));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/docs",
    "/docs/:path*",
    "/dashboard",
    "/dashboard/:path*",
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
