// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { NextResponse } from "next/server";
import { requireDashboardAccess } from "../../../../lib/dashboard-access.ts";
import { initiateProviderAuthorization } from "../../../../lib/ref-client.ts";
import { originMatchesHost, redirectToPublicPath } from "../../../../lib/same-origin-route.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteParams {
  connectorId: string;
}

function pagePath(connectorId: string): string {
  return `/connect/provider-auth/${encodeURIComponent(connectorId)}`;
}

export async function POST(request: Request, { params }: { params: Promise<RouteParams> }): Promise<NextResponse> {
  const { connectorId } = await params;
  const path = pagePath(connectorId);
  await requireDashboardAccess(path);
  if (!originMatchesHost(request)) {
    return new NextResponse("Forbidden", { status: 403 });
  }
  try {
    const result = await initiateProviderAuthorization(connectorId);
    const authorizationUrl = new URL(result.next_step.authorization_url);
    if (authorizationUrl.protocol !== "http:" && authorizationUrl.protocol !== "https:") {
      throw new Error("Provider authorization returned an invalid URL.");
    }
    return NextResponse.redirect(authorizationUrl, 303);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Provider authorization could not be started.";
    return redirectToPublicPath(request, `${path}?${new URLSearchParams({ error: message }).toString()}`);
  }
}
