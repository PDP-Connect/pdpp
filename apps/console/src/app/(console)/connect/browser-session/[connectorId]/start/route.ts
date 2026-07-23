// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { NextResponse } from "next/server";
import { isBrowserBoundConnector, isSupportedBrowserCollectorConnector } from "../../../../lib/connection-modality.ts";
import { requireDashboardAccess } from "../../../../lib/dashboard-access.ts";
import { createBrowserEnrollmentShell } from "../../../../lib/ref-client.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteParams {
  connectorId: string;
}

function pagePath(connectorId: string): string {
  return `/connect/browser-session/${encodeURIComponent(connectorId)}`;
}

function errorPath(connectorId: string, message: string): string {
  return `${pagePath(connectorId)}?error=${encodeURIComponent(message)}`;
}

function publicOrigin(request: Request): string {
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? new URL(request.url).host;
  const proto =
    request.headers.get("x-forwarded-proto") ??
    (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return `${proto}://${host}`;
}

function redirectTo(request: Request, path: string): NextResponse {
  return NextResponse.redirect(new URL(path, publicOrigin(request)), 303);
}

function originMatchesHost(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) {
    return true;
  }
  const host = request.headers.get("host");
  if (!host) {
    return false;
  }
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function readConnectionIdField(formData: FormData): string | null {
  if (!formData.has("connection_id")) {
    return null;
  }
  const value = formData.get("connection_id");
  if (typeof value !== "string") {
    throw new Error("connection_id must be a string");
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("connection_id must be a non-empty string");
  }
  return trimmed;
}

function readOptionalDisplayNameField(formData: FormData): string | null {
  if (!formData.has("display_name")) {
    return null;
  }
  const value = formData.get("display_name");
  if (typeof value !== "string") {
    throw new Error("display_name must be a string");
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.length > 200) {
    throw new Error("display_name must be 200 characters or fewer");
  }
  return trimmed;
}

export async function POST(
  request: Request,
  { params: routeParams }: { params: Promise<RouteParams> }
): Promise<NextResponse> {
  const { connectorId: rawConnectorId } = await routeParams;
  const connectorId = decodeURIComponent(rawConnectorId);

  await requireDashboardAccess(pagePath(connectorId));

  if (!originMatchesHost(request)) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  if (!isBrowserBoundConnector(connectorId)) {
    return redirectTo(request, `/sources/add?error=${encodeURIComponent("This source does not use browser setup.")}`);
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return redirectTo(request, errorPath(connectorId, "Invalid browser-session form."));
  }

  let existingConnectionId: string | null;
  try {
    existingConnectionId = readConnectionIdField(formData);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid browser-session form";
    return redirectTo(request, errorPath(connectorId, message));
  }

  try {
    if (existingConnectionId) {
      const redirectParams = new URLSearchParams({
        connection_id: existingConnectionId,
        draft: "0",
      });
      return redirectTo(request, `${pagePath(connectorId)}/launch?${redirectParams.toString()}`);
    }

    let displayName: string | null = null;
    try {
      displayName = readOptionalDisplayNameField(formData);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invalid browser-session form";
      return redirectTo(request, errorPath(connectorId, message));
    }

    if (!isSupportedBrowserCollectorConnector(connectorId)) {
      return redirectTo(
        request,
        `/sources/add?error=${encodeURIComponent("This browser-backed source is not available for self-service setup.")}`
      );
    }

    const shell = await createBrowserEnrollmentShell(connectorId, { displayName });
    const redirectParams = new URLSearchParams({
      connection_id: shell.connection_id,
      draft: "1",
    });
    return redirectTo(request, `${pagePath(connectorId)}/launch?${redirectParams.toString()}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to start browser session";
    return redirectTo(request, errorPath(connectorId, message));
  }
}
