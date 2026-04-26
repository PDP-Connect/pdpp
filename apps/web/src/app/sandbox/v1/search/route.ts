import { buildLiveSearchResponse } from "../../_demo/builders.ts";
import { jsonResponse } from "../_helpers.ts";

// Search reads `q`, `limit`, `cursor` at request time; cannot be statically
// pre-rendered.
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const url = new URL(request.url);
  const query = url.searchParams.get("q") ?? "";
  const cursor = url.searchParams.get("cursor");
  const rawLimit = url.searchParams.get("limit");
  let limit: number | undefined;
  if (rawLimit !== null) {
    const parsed = Number.parseInt(rawLimit, 10);
    if (Number.isFinite(parsed)) {
      limit = parsed;
    }
  }
  return jsonResponse(buildLiveSearchResponse(query, { cursor, limit }));
}
