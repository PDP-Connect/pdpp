import { buildLiveStreamsList } from "../../_demo/builders.ts";
import { jsonResponse, readListParams } from "../_helpers.ts";

// Reads `cursor`, `limit`, `connector_id` from the query string.
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const url = new URL(request.url);
  const params = readListParams(url);
  return jsonResponse(
    buildLiveStreamsList({
      cursor: params.cursor,
      limit: params.limit,
      connector_id: params.connector_id,
    })
  );
}
