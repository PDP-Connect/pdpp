import { buildLiveTraceTimeline } from "../../../_demo/builders.ts";
import { jsonResponse, notFound } from "../../../v1/_helpers.ts";

export const dynamic = "force-static";

export async function GET(_request: Request, ctx: { params: Promise<{ traceId: string }> }) {
  const { traceId } = await ctx.params;
  const timeline = buildLiveTraceTimeline(traceId);
  if (!timeline) {
    return notFound(`trace not found: ${traceId}`);
  }
  return jsonResponse(timeline);
}
