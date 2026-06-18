import { NextResponse } from "next/server";
import { isBrowserBoundConnector } from "../../../../lib/connection-modality.ts";
import { requireDashboardAccess } from "../../../../lib/dashboard-access.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteParams {
  connectorId: string;
}

function pagePath(connectorId: string): string {
  return `/dashboard/connect/browser-session/${encodeURIComponent(connectorId)}`;
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

function readOptionalStringField(formData: FormData, name: string): string | null {
  const value = formData.get(name);
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function POST(request: Request, { params }: { params: Promise<RouteParams> }): Promise<NextResponse> {
  const { connectorId: rawConnectorId } = await params;
  const connectorId = decodeURIComponent(rawConnectorId);

  await requireDashboardAccess(pagePath(connectorId));

  if (!originMatchesHost(request)) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  if (!isBrowserBoundConnector(connectorId)) {
    return redirectTo(
      request,
      `/dashboard/records/add?error=${encodeURIComponent("This source does not use browser setup.")}`
    );
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    formData = new FormData();
  }

  let existingConnectionId: string | null;
  try {
    existingConnectionId = readOptionalStringField(formData, "connection_id");
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid browser-session form";
    return redirectTo(request, errorPath(connectorId, message));
  }

  try {
    if (!existingConnectionId) {
      return redirectTo(
        request,
        errorPath(
          connectorId,
          "Open an existing source and choose Reconnect. Adding a new browser-backed source is not packaged from this page yet."
        )
      );
    }
    const connectionId = existingConnectionId;
    const params = new URLSearchParams({
      connection_id: connectionId,
      draft: "0",
    });
    return redirectTo(request, `${pagePath(connectorId)}/launch?${params.toString()}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to start browser session";
    return redirectTo(request, errorPath(connectorId, message));
  }
}
