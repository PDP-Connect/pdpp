import { buildSearchResponse } from "../../_demo/builders.ts";
import { jsonResponse } from "../_helpers.ts";

// Search reads the `q` query parameter at request time; it cannot be statically
// pre-rendered.
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const url = new URL(request.url);
  const query = url.searchParams.get("q") ?? "";
  return jsonResponse(buildSearchResponse(query));
}
