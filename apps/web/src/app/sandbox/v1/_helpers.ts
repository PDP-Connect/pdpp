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

export function sandboxIssuerFromRequest(request: Request): string {
  const url = new URL(request.url);
  return `${url.origin}/sandbox`;
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
