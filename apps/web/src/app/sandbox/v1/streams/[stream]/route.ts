import {
  StreamDetailVisibilityError,
  executeStreamDetail,
} from "pdpp-reference-implementation/operations/rs-streams-detail";
import { createSandboxStreamDetailDependencies } from "../../../_demo/operations-fixtures.ts";
import { jsonResponse, notFound } from "../../_helpers.ts";

export const dynamic = "force-static";

export async function GET(_request: Request, ctx: { params: Promise<{ stream: string }> }) {
  const { stream } = await ctx.params;
  try {
    const result = await executeStreamDetail(
      { actor: { kind: "owner", subject_id: null }, streamName: stream },
      createSandboxStreamDetailDependencies()
    );
    return jsonResponse(result.metadata);
  } catch (err) {
    if (err instanceof StreamDetailVisibilityError && err.code === "not_found") {
      return notFound(`stream not found: ${stream}`);
    }
    throw err;
  }
}
