import { buildLiveRunTimeline } from "../../../../_demo/builders.ts";
import { jsonResponse, notFound } from "../../../../v1/_helpers.ts";

export const dynamic = "force-static";

export async function GET(_request: Request, ctx: { params: Promise<{ runId: string }> }) {
  const { runId } = await ctx.params;
  const timeline = buildLiveRunTimeline(runId);
  if (!timeline) {
    return notFound(`run not found: ${runId}`);
  }
  return jsonResponse(timeline);
}
