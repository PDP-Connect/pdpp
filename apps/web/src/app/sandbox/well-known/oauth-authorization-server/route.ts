import { buildAuthServerMetadata } from "../../_demo/builders.ts";
import { jsonResponse, sandboxIssuerFromRequest } from "../../v1/_helpers.ts";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return jsonResponse(buildAuthServerMetadata(sandboxIssuerFromRequest(request)));
}
