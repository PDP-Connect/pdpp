import { executeRefSpineEventsPage } from "pdpp-reference-implementation/operations/ref-spine-events-page";
import { createSandboxRefSpineEventsPageInput } from "../../../_demo/operations-fixtures.ts";
import { jsonResponse, notFound } from "../../../v1/_helpers.ts";

export const dynamic = "force-static";

export async function GET(request: Request, ctx: { params: Promise<{ traceId: string }> }) {
  const { traceId } = await ctx.params;
  const input = createSandboxRefSpineEventsPageInput("trace", traceId, new URL(request.url));
  if (!input) {
    return notFound(`trace not found: ${traceId}`);
  }
  return jsonResponse(executeRefSpineEventsPage(input));
}
