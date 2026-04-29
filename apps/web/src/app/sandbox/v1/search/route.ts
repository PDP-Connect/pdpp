import {
  executeSearchLexical,
  SearchLexicalRequestError,
} from "pdpp-reference-implementation/operations/rs-search-lexical";
import { createSandboxSearchLexicalDependencies } from "../../_demo/operations-fixtures.ts";
import { jsonResponse } from "../_helpers.ts";

// Search reads `q`, `limit`, `cursor`, `streams[]`, and `filter[...]` at
// request time; cannot be statically pre-rendered.
export const dynamic = "force-dynamic";

// Dependencies are constructed once at module load. The fixture's snapshot
// cache is in-memory and process-scoped, which is exactly what the
// canonical operation expects from `loadSnapshot` for cursor pagination
// across requests.
const dependencies = createSandboxSearchLexicalDependencies();

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  // Mirror Fastify's `qs`-style query parsing: `streams` and `streams[]`
  // both fold into `streams[]`; bracketed `filter[...]` keys collapse into
  // a `filter` object. The operation owns normalization but not parsing,
  // so we hand it a plain object derived from `URLSearchParams`.
  const query = parseSandboxSearchQuery(url.searchParams);

  try {
    // Sandbox is owner-shaped — see operations-fixtures.ts for why every
    // demo record is owner-visible. Client-actor flows are out of scope
    // for this slice (no live client tokens in sandbox).
    const result = await executeSearchLexical({ actor: { kind: "owner", subject_id: null }, query }, dependencies);
    return jsonResponse({
      ...result.envelope,
      url: "/sandbox/v1/search",
    });
  } catch (err) {
    if (err instanceof SearchLexicalRequestError) {
      return errorResponse(err);
    }
    throw err;
  }
}

function parseSandboxSearchQuery(params: URLSearchParams): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // `getAll('streams')` and `getAll('streams[]')` both feed the operation's
  // `streams ?? streams[]` lookup; the operation accepts either shape.
  const streams: string[] = [];
  const filter: Record<string, unknown> = {};
  let hasFilter = false;
  for (const [key, value] of params.entries()) {
    if (key === "streams" || key === "streams[]") {
      streams.push(value);
      continue;
    }
    if (key.startsWith("filter[") && key.endsWith("]")) {
      hasFilter = true;
      // Reduce `filter[a][b]=c` to a nested object so the operation's
      // `filter[...] requires exactly one streams[]` rule fires uniformly.
      const path = key.slice("filter[".length, -1).split("][");
      assignNested(filter, path, value);
      continue;
    }
    if (key === "filter") {
      hasFilter = true;
      out.filter = value;
      continue;
    }
    out[key] = value;
  }
  if (streams.length === 1) {
    out.streams = streams[0];
  } else if (streams.length > 1) {
    out.streams = streams;
  }
  if (hasFilter && !("filter" in out)) {
    out.filter = filter;
  }
  return out;
}

function assignNested(target: Record<string, unknown>, path: string[], value: string): void {
  let cursor: Record<string, unknown> = target;
  for (let i = 0; i < path.length - 1; i += 1) {
    const segment = path[i] as string;
    const existing = cursor[segment];
    if (existing && typeof existing === "object" && !Array.isArray(existing)) {
      cursor = existing as Record<string, unknown>;
    } else {
      const next: Record<string, unknown> = {};
      cursor[segment] = next;
      cursor = next;
    }
  }
  cursor[path.at(-1) as string] = value;
}

function errorResponse(err: SearchLexicalRequestError): Response {
  // Sandbox error envelopes mirror the existing `notFound` shape — same
  // top-level `error: { type, code, message, request_id }` so dashboard
  // consumers see one error shape across `/sandbox/v1/**`. Status is 400
  // for invalid request / cursor / grant_stream rejection.
  const status = 400;
  const type = err.code === "grant_stream_not_allowed" ? "invalid_grant_error" : "invalid_request_error";
  return jsonResponse(
    {
      error: {
        type,
        code: err.code,
        message: err.message,
        ...(err.param ? { param: err.param } : {}),
        request_id: "req_sandbox_search_invalid",
      },
    },
    { status }
  );
}
