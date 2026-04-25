import { buildRecordsList } from "../../../../_demo/builders.ts";
import { jsonResponse, notFound, readListParams } from "../../../_helpers.ts";

// Reads `cursor`, `limit`, `connector_id` from the query string.
export const dynamic = "force-dynamic";

export async function GET(request: Request, ctx: { params: Promise<{ stream: string }> }) {
  const { stream } = await ctx.params;
  const url = new URL(request.url);
  const params = readListParams(url);
  const list = buildRecordsList({
    stream,
    cursor: params.cursor,
    limit: params.limit,
    connector_id: params.connector_id,
  });
  if (!list) {
    return notFound(`stream not found: ${stream}`);
  }
  return jsonResponse(list);
}
