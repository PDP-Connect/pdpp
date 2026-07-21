// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { executeRefSpineEventsPage } from "pdpp-reference-implementation/operations/ref-spine-events-page";
import { createSandboxRefSpineEventsPageInput } from "../../../../_demo/operations-fixtures.ts";
import { jsonResponse, notFound } from "../../../../v1/_helpers.ts";

export const dynamic = "force-static";

export async function GET(request: Request, ctx: { params: Promise<{ grantId: string }> }) {
  const { grantId } = await ctx.params;
  const input = createSandboxRefSpineEventsPageInput("grant", grantId, new URL(request.url));
  if (!input) {
    return notFound(`grant not found: ${grantId}`);
  }
  return jsonResponse(executeRefSpineEventsPage(input));
}
