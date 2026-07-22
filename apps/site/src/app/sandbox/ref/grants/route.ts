// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { executeRefSpineCorrelationsList } from "pdpp-reference-implementation/operations/ref-spine-correlations-list";
import { createSandboxRefSpineCorrelationsListDependencies } from "../../_demo/operations-fixtures.ts";
import { jsonResponse, readListParams } from "../../v1/_helpers.ts";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const params = readListParams(url);
  return jsonResponse(
    await executeRefSpineCorrelationsList(
      {
        kind: "grant",
        filters: {
          cursor: params.cursor,
          limit: params.limit,
          status: params.status,
          client_id: params.client_id,
        },
      },
      createSandboxRefSpineCorrelationsListDependencies()
    )
  );
}
