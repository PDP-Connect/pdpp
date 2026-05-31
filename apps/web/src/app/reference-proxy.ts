export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type ReferenceTarget = "as" | "rs";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

interface CatchAllRouteContext {
  params: Promise<{
    path?: string[];
  }>;
}

function referenceBaseUrl(target: ReferenceTarget): string {
  const configured = target === "as" ? process.env.PDPP_AS_URL : process.env.PDPP_RS_URL;
  if (configured?.trim()) {
    return configured;
  }
  return target === "as" ? "http://localhost:7662" : "http://localhost:7663";
}

function forwardedProto(request: Request, url: URL): string {
  return request.headers.get("x-forwarded-proto") || url.protocol.replace(/:$/, "");
}

function buildProxyHeaders(request: Request, url: URL): Headers {
  const headers = new Headers(request.headers);
  for (const header of HOP_BY_HOP_HEADERS) {
    headers.delete(header);
  }
  headers.delete("host");
  headers.delete("content-length");
  headers.set("x-forwarded-host", request.headers.get("x-forwarded-host") || request.headers.get("host") || url.host);
  headers.set("x-forwarded-proto", forwardedProto(request, url));
  headers.set("x-forwarded-for", request.headers.get("x-forwarded-for") || "127.0.0.1");
  return headers;
}

function buildResponseHeaders(headers: Headers): Headers {
  const nextHeaders = new Headers(headers);
  for (const header of HOP_BY_HOP_HEADERS) {
    nextHeaders.delete(header);
  }
  // Undici may transparently decode upstream bodies. Avoid stale length/encoding
  // metadata on proxied responses.
  nextHeaders.delete("content-length");
  nextHeaders.delete("content-encoding");
  return nextHeaders;
}

function targetUrl(target: ReferenceTarget, path: readonly string[], requestUrl: URL): URL {
  const base = new URL(referenceBaseUrl(target));
  const encodedPath = path.map((part) => encodeURIComponent(part)).join("/");
  return new URL(`/${encodedPath}${requestUrl.search}`, base);
}

export async function proxyReferenceRequest(
  request: Request,
  target: ReferenceTarget,
  path: readonly string[]
): Promise<Response> {
  const sourceUrl = new URL(request.url);
  const upstreamUrl = targetUrl(target, path, sourceUrl);
  const method = request.method.toUpperCase();
  const body = method === "GET" || method === "HEAD" ? undefined : await request.arrayBuffer();

  try {
    const upstream = await fetch(upstreamUrl, {
      body,
      headers: buildProxyHeaders(request, sourceUrl),
      method,
      redirect: "manual",
    });
    return new Response(upstream.body, {
      headers: buildResponseHeaders(upstream.headers),
      status: upstream.status,
      statusText: upstream.statusText,
    });
  } catch (error) {
    return Response.json(
      {
        error: {
          code: "reference_unreachable",
          message: `Cannot reach PDPP ${target.toUpperCase()} service.`,
          detail: error instanceof Error ? error.message : String(error),
        },
      },
      { status: 502 }
    );
  }
}

export async function proxyReferenceCatchAll(
  request: Request,
  target: ReferenceTarget,
  prefix: readonly string[],
  context: CatchAllRouteContext
): Promise<Response> {
  const { path = [] } = await context.params;
  return proxyReferenceRequest(request, target, [...prefix, ...path]);
}
