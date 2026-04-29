import { executeRefDatasetSummary } from "pdpp-reference-implementation/operations/ref-dataset-summary";
import { createSandboxRefDatasetSummaryDependencies } from "../../../_demo/operations-fixtures.ts";
import { jsonResponse } from "../../../v1/_helpers.ts";

export const dynamic = "force-static";

export async function GET() {
  const summary = await executeRefDatasetSummary(createSandboxRefDatasetSummaryDependencies());
  return jsonResponse(summary);
}
