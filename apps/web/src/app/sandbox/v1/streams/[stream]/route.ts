import { buildLiveStreamMetadataResponse } from "../../../_demo/builders.ts";
import { jsonResponse, notFound } from "../../_helpers.ts";

export const dynamic = "force-static";

export async function GET(_request: Request, ctx: { params: Promise<{ stream: string }> }) {
  const { stream } = await ctx.params;
  const detail = buildLiveStreamMetadataResponse(stream);
  if (!detail) {
    return notFound(`stream not found: ${stream}`);
  }
  return jsonResponse(detail);
}
