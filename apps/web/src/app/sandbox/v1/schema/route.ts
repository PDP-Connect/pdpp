import { buildSchemaResponse } from "../../_demo/builders.ts";
import { jsonResponse } from "../_helpers.ts";

export const dynamic = "force-static";

export function GET() {
  return jsonResponse(buildSchemaResponse());
}
