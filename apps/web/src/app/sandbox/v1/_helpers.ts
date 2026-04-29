/**
 * Shared response helpers for sandbox demo route handlers.
 *
 * Demo routes are JSON-only, deterministic, and never call out to live
 * services. They share the same builders the demo UI uses, so the
 * dashboard surface and the HTTP API can never silently diverge.
 */

const DEMO_HEADERS: HeadersInit = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "public, max-age=0, must-revalidate",
  "x-pdpp-demo": "1",
  "x-pdpp-demo-notice": "sandbox-fictional-data-only",
};

export function jsonResponse(body: unknown, init?: { status?: number }): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status: init?.status ?? 200,
    headers: DEMO_HEADERS,
  });
}

export function notFound(message: string): Response {
  return jsonResponse(
    {
      error: {
        type: "not_found_error",
        code: "not_found",
        message,
        request_id: "req_sandbox_not_found",
      },
    },
    { status: 404 }
  );
}

// Hosted/proxied dev (e.g. `next dev --hostname 0.0.0.0`, Vercel, Coolify) makes
// `new URL(request.url).origin` an unreliable source of truth — under
// `--hostname 0.0.0.0` the parsed URL pins to `0.0.0.0`, which is never an
// address a relying party can resolve. Mirror the live AS helper at
// `reference-implementation/server/metadata.ts:resolveRequestPublicUrl`:
// prefer X-Forwarded-Proto/Host (first value of any list), fall back to Host,
// and only treat the request URL as authoritative for the hostname when
// neither header is present. The bind hostname `0.0.0.0` is normalized to
// `localhost` last so a developer hitting `http://localhost:3010/sandbox/...`
// directly still sees a sensible issuer.
const HEADER_LIST_SEPARATOR_RE = /\s*,\s*/;
const TRAILING_COLON_RE = /:$/;

function firstHeaderValue(value: string | null): string | undefined {
  if (!value) {
    return;
  }
  const first = value.split(HEADER_LIST_SEPARATOR_RE, 1)[0]?.trim();
  return first || undefined;
}

// Splits a Host header value into hostname + port suffix while keeping
// bracketed IPv6 literals intact (`[::1]:3010` → hostname `::1`, suffix `:3010`).
// The suffix retains its leading `:` (or `]:`) so callers can reassemble the
// host as `${hostname}${suffix}` without re-bracketing IPv6.
function splitHostHeader(host: string): { hostname: string; suffix: string } {
  if (host.startsWith("[")) {
    const close = host.indexOf("]");
    if (close > 0) {
      return {
        hostname: host.slice(1, close),
        suffix: host.slice(close + 1), // either "" or ":<port>"
      };
    }
    return { hostname: host, suffix: "" };
  }
  const colon = host.indexOf(":");
  if (colon < 0) {
    return { hostname: host, suffix: "" };
  }
  return { hostname: host.slice(0, colon), suffix: host.slice(colon) };
}

function isUnroutableBindHost(hostname: string): boolean {
  return hostname === "0.0.0.0" || hostname === "::";
}

function reassembleHost(hostname: string, suffix: string): string {
  // Re-bracket IPv6 literals (which contain ":"). IPv4 / DNS names pass through.
  return hostname.includes(":") ? `[${hostname}]${suffix}` : `${hostname}${suffix}`;
}

export function sandboxIssuerFromRequest(request: Request): string {
  const headers = request.headers;
  const forwardedHost = firstHeaderValue(headers.get("x-forwarded-host"));
  const forwardedProto = firstHeaderValue(headers.get("x-forwarded-proto"));
  const hostHeader = firstHeaderValue(headers.get("host"));
  const url = new URL(request.url);

  const host = forwardedHost ?? hostHeader ?? url.host;
  const proto = forwardedProto ?? url.protocol.replace(TRAILING_COLON_RE, "") ?? "http";

  // Normalize a bind hostname (`0.0.0.0`, `::`) only as a last resort — when
  // neither forwarded headers nor Host header give us anything routable. The
  // split above is bracket-aware so `[::1]:3010` and `pdpp.example.com:3010`
  // are both handled correctly.
  const { hostname, suffix } = splitHostHeader(host);
  const normalizedHost = isUnroutableBindHost(hostname)
    ? reassembleHost("localhost", suffix)
    : reassembleHost(hostname, suffix);

  return `${proto}://${normalizedHost}/sandbox`;
}

export function readListParams(url: URL): {
  cursor: string | null;
  limit: number | undefined;
  status: string | undefined;
  client_id: string | undefined;
  connector_id: string | undefined;
} {
  const cursor = url.searchParams.get("cursor");
  const rawLimit = url.searchParams.get("limit");
  let limit: number | undefined;
  if (rawLimit !== null) {
    const parsed = Number.parseInt(rawLimit, 10);
    if (Number.isFinite(parsed)) {
      limit = parsed;
    }
  }
  return {
    cursor,
    limit,
    status: url.searchParams.get("status") ?? undefined,
    client_id: url.searchParams.get("client_id") ?? undefined,
    connector_id: url.searchParams.get("connector_id") ?? undefined,
  };
}
