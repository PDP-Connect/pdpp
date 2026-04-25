import { buildRecordDetail } from "../../../../../_demo/builders.ts";
import { jsonResponse, notFound } from "../../../../_helpers.ts";

export const dynamic = "force-static";

export async function GET(_request: Request, ctx: { params: Promise<{ stream: string; recordId: string }> }) {
  const { stream, recordId } = await ctx.params;
  const detail = buildRecordDetail(stream, recordId);
  if (!detail) {
    return notFound(`record not found: stream=${stream} record_id=${recordId}`);
  }
  return jsonResponse(detail);
}
