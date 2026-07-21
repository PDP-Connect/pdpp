// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { NextResponse } from "next/server";
import { isBrowserBoundConnector } from "../../../../../lib/connection-modality.ts";
import { requireDashboardAccess } from "../../../../../lib/dashboard-access.ts";
import { runConnectionNow } from "../../../../../lib/operator-runs.ts";
import { abandonBrowserEnrollmentShell } from "../../../../../lib/ref-client.ts";
import { type BrowserSessionRunStartResult, classifyBrowserSessionLaunchResult } from "../launch-result.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteParams {
  connectorId: string;
}

function pagePath(connectorId: string): string {
  return `/connect/browser-session/${encodeURIComponent(connectorId)}/launch`;
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

function readRequiredStringField(formData: FormData, name: string): string {
  const value = formData.get(name);
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function readBooleanField(formData: FormData, name: string): boolean {
  const value = formData.get(name);
  return value === "1" || value === "true";
}

export async function POST(request: Request, { params }: { params: Promise<RouteParams> }): Promise<NextResponse> {
  const { connectorId: rawConnectorId } = await params;
  const connectorId = decodeURIComponent(rawConnectorId);

  await requireDashboardAccess(pagePath(connectorId));

  if (!originMatchesHost(request)) {
    return NextResponse.json({ message: "Forbidden" }, { status: 403 });
  }

  if (!isBrowserBoundConnector(connectorId)) {
    return NextResponse.json({ message: "This source does not use browser setup." }, { status: 400 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ message: "Invalid browser-session form." }, { status: 400 });
  }

  let connectionId: string;
  try {
    connectionId = readRequiredStringField(formData, "connection_id");
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid browser-session form.";
    return NextResponse.json({ message }, { status: 400 });
  }
  const draft = readBooleanField(formData, "draft");

  try {
    const runStart = (await runConnectionNow(connectionId)) as BrowserSessionRunStartResult;
    const result = classifyBrowserSessionLaunchResult(runStart);
    if (!result.ok) {
      if (draft) {
        try {
          await abandonBrowserEnrollmentShell(connectionId);
        } catch {
          // Best effort; TTL retirement will clean up any orphaned draft.
        }
      }
      return NextResponse.json({ message: result.message, run_status: result.run_status }, { status: result.status });
    }
    return NextResponse.json({
      href: result.href,
      run_id: result.run_id,
    });
  } catch (err) {
    if (draft) {
      try {
        await abandonBrowserEnrollmentShell(connectionId);
      } catch {
        // Best effort; TTL retirement will clean up any orphaned draft.
      }
    }
    const message = err instanceof Error ? err.message : "Failed to start browser session";
    return NextResponse.json({ message }, { status: 502 });
  }
}
