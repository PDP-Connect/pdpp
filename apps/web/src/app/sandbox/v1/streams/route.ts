import { executeStreamsList } from "pdpp-reference-implementation/operations/rs-streams-list";
import { createSandboxStreamsListDependencies } from "../../_demo/operations-fixtures.ts";
import { jsonResponse, readListParams } from "../_helpers.ts";

// Reads `cursor`, `limit`, `connector_id` from the query string.
export const dynamic = "force-dynamic";

const DEFAULT_PAGE_LIMIT = 25;
const MAX_PAGE_LIMIT = 100;

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
    return DEFAULT_PAGE_LIMIT;
  }
  return Math.min(Math.floor(limit), MAX_PAGE_LIMIT);
}

function decodeCursor(cursor: string | null | undefined): number {
  if (!cursor) {
    return 0;
  }
  const parsed = Number.parseInt(cursor, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return parsed;
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const params = readListParams(url);

  const { streams } = await executeStreamsList(
    { actor: { kind: "owner", subject_id: null } },
    createSandboxStreamsListDependencies({
      ...(params.connector_id !== undefined ? { connectorId: params.connector_id } : {}),
    }),
  );

  // Sandbox-specific envelope: paginated `{object:'list', has_more, data,
  // [next_cursor]}` matches the previous `buildLiveStreamsList` shape and the
  // existing sandbox routes test in `_demo/routes.test.ts`. Pagination,
  // freshness shape, and demo headers are host-shaped because the sandbox
  // chose them; the canonical AS/RS list semantics live in the operation.
  const limit = clampLimit(params.limit);
  const start = decodeCursor(params.cursor);
  const slice = streams.slice(start, start + limit);
  const next = start + limit;
  const hasMore = next < streams.length;

  type SandboxStream = {
    object: "stream";
    name: string;
    record_count: number;
    last_updated: string | null;
    freshness: { last_updated: string | null };
  };
  const data: SandboxStream[] = slice.map((s) => ({
    object: s.object,
    name: s.name,
    record_count: s.record_count,
    last_updated: s.last_updated,
    freshness: { last_updated: s.last_updated },
  }));

  type SandboxStreamsEnvelope = {
    object: "list";
    has_more: boolean;
    data: SandboxStream[];
    next_cursor?: string;
  };
  const envelope: SandboxStreamsEnvelope = {
    object: "list",
    has_more: hasMore,
    data,
  };
  if (hasMore) {
    envelope.next_cursor = String(next);
  }
  return jsonResponse(envelope);
}
