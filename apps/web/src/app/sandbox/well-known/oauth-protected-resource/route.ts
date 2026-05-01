import { executeRsProtectedResourceMetadata } from "pdpp-reference-implementation/operations/rs-protected-resource-metadata";
import {
  buildSandboxProtectedResourceMetadataDocument,
  createSandboxRsProtectedResourceMetadataDependencies,
} from "../../_demo/operations-fixtures.ts";
import { jsonResponse, sandboxIssuerFromRequest } from "../../v1/_helpers.ts";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const issuer = sandboxIssuerFromRequest(request);
  const { composition } = executeRsProtectedResourceMetadata(
    {},
    createSandboxRsProtectedResourceMetadataDependencies(issuer)
  );
  return jsonResponse(buildSandboxProtectedResourceMetadataDocument(issuer, composition));
}
