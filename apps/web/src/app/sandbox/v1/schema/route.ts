import { buildSchemaResponse } from "../../_demo/builders.ts";
import { jsonResponse, sandboxIssuerFromRequest } from "../_helpers.ts";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return jsonResponse(buildSchemaResponse(sandboxIssuerFromRequest(request)));
}
