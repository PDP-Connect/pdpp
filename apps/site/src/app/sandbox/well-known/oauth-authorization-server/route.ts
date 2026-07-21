// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { executeAsAuthorizationServerMetadata } from "pdpp-reference-implementation/operations/as-authorization-server-metadata";
import { createSandboxAsAuthorizationServerMetadataDependencies } from "../../_demo/operations-fixtures.ts";
import { jsonResponse, sandboxIssuerFromRequest } from "../../v1/_helpers.ts";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return jsonResponse(
    executeAsAuthorizationServerMetadata(
      { issuer: sandboxIssuerFromRequest(request), dynamicClientRegistrationEnabled: false },
      createSandboxAsAuthorizationServerMetadataDependencies()
    )
  );
}
