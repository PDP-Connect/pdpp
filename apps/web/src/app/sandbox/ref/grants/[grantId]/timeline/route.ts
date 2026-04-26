import { buildLiveGrantTimeline } from "../../../../_demo/builders.ts";
import { jsonResponse, notFound } from "../../../../v1/_helpers.ts";

export const dynamic = "force-static";

export async function GET(_request: Request, ctx: { params: Promise<{ grantId: string }> }) {
  const { grantId } = await ctx.params;
  const timeline = buildLiveGrantTimeline(grantId);
  if (!timeline) {
    return notFound(`grant not found: ${grantId}`);
  }
  return jsonResponse(timeline);
}
