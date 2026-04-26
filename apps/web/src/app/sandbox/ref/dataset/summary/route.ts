import { buildLiveDatasetSummary } from "../../../_demo/builders.ts";
import { jsonResponse } from "../../../v1/_helpers.ts";

export const dynamic = "force-static";

export function GET() {
  return jsonResponse(buildLiveDatasetSummary());
}
