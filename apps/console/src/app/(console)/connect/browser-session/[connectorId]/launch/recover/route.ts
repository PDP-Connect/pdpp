import { NextResponse } from "next/server";
import { isBrowserBoundConnector } from "../../../../../lib/connection-modality.ts";
import { requireDashboardAccess } from "../../../../../lib/dashboard-access.ts";
import { listRuns, type RunSummary } from "../../../../../lib/ref-client.ts";
import { isRecoverableBrowserSessionRun } from "../recovery-classification.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteParams {
  connectorId: string;
}

function pagePath(connectorId: string): string {
  return `/connect/browser-session/${encodeURIComponent(connectorId)}/launch`;
}

function matchesConnection(run: RunSummary, connectorId: string, connectionId: string): boolean {
  if (run.connector_id !== connectorId) {
    return false;
  }
  return (
    run.connector_instance_id === connectionId ||
    run.connection_id === connectionId ||
    run.source?.connection_id === connectionId ||
    run.source?.id === connectionId
  );
}

export async function GET(request: Request, { params }: { params: Promise<RouteParams> }): Promise<NextResponse> {
  const { connectorId: rawConnectorId } = await params;
  const connectorId = decodeURIComponent(rawConnectorId);

  await requireDashboardAccess(pagePath(connectorId));

  if (!isBrowserBoundConnector(connectorId)) {
    return NextResponse.json({ message: "This source does not use browser setup." }, { status: 400 });
  }

  const connectionId = new URL(request.url).searchParams.get("connection_id")?.trim();
  if (!connectionId) {
    return NextResponse.json({ message: "connection_id is required" }, { status: 400 });
  }

  const runs = await listRuns({ connector_id: connectorId, limit: 50 });
  const run = runs.data.find(
    (candidate) => matchesConnection(candidate, connectorId, connectionId) && isRecoverableBrowserSessionRun(candidate)
  );
  if (!run) {
    return NextResponse.json({ message: "No active browser run found for this connection." }, { status: 404 });
  }

  return NextResponse.json({
    href: `/syncs/${encodeURIComponent(run.run_id)}/stream`,
    run_id: run.run_id,
    status: run.status,
  });
}
