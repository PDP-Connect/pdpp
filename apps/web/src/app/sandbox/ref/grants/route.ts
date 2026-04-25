import { buildGrantsList } from "../../_demo/builders.ts";
import { jsonResponse, readListParams } from "../../v1/_helpers.ts";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const url = new URL(request.url);
  const params = readListParams(url);
  return jsonResponse(
    buildGrantsList({
      cursor: params.cursor,
      limit: params.limit,
      status: params.status,
      client_id: params.client_id,
    })
  );
}
