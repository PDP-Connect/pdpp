import { PageHeader } from "@pdpp/operator-ui/components/primitives";
import { RunRow } from "@pdpp/operator-ui/components/run-row";
import { isAwaitingInteraction } from "@pdpp/operator-ui/components/run-row-helpers";
import { type ListWithPeekParams, ListWithPeekView } from "@pdpp/operator-ui/components/views/list-with-peek";
import { dashboardRoutes } from "@pdpp/operator-ui/components/views/routes";
import { redirect } from "next/navigation";
import { LivePoller } from "../components/live-poller.tsx";
import { DashboardShell, ServerUnreachable } from "../components/shell.tsx";
import { ReferenceServerUnreachableError } from "../lib/owner-token.ts";
import { type ListResponse, listRuns, type RunSummary } from "../lib/ref-client.ts";

export const dynamic = "force-dynamic";

interface Params {
  connector_id?: string;
  cursor?: string;
  peek?: string;
  q?: string;
  status?: string;
}

function listHref(params: Params, overrides: Record<string, string | undefined> = {}): string {
  const merged: Record<string, string | undefined> = { ...params, ...overrides };
  const qs = Object.entries(merged)
    .flatMap(([k, v]) =>
      v === undefined || v === "" ? [] : [`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`]
    )
    .join("&");
  return qs ? `/dashboard/runs?${qs}` : "/dashboard/runs";
}

export default async function RunsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  if (params.peek) {
    redirect(dashboardRoutes.run(params.peek));
  }

  const filters = {
    cursor: params.cursor,
    status: params.status,
    connector_id: params.connector_id,
    q: params.q,
    limit: 50,
  };

  let result: ListResponse<RunSummary>;
  try {
    result = await listRuns(filters);
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <DashboardShell active="runs">
          <PageHeader title="Runs" />
          <ServerUnreachable />
        </DashboardShell>
      );
    }
    throw err;
  }

  const activeFilters = [
    params.status ? { label: "status", value: params.status } : null,
    params.connector_id ? { label: "connector", value: params.connector_id } : null,
    params.q ? { label: "query", value: params.q } : null,
  ].filter((item): item is { label: string; value: string } => Boolean(item));

  // Auto-refresh this list whenever a run is still running or waiting on
  // operator input. The reference summary computes `needs_input` from
  // interaction ids; `kinds` is only an event-type vocabulary and is too lossy
  // for pending-interaction state.
  const liveRunCount = result.data.filter(isLiveRun).length;
  const viewParams: ListWithPeekParams<RunSummary> = {
    active: "runs",
    routes: dashboardRoutes,
    subject: "run",
    title: "Runs",
    description: "Connector runs and their lifecycle: staging, advance, progress, and failures.",
    result,
    rowKey: (run) => run.run_id,
    renderRow: (run, { peeked, href }) => <RunRow chips href={href} peeked={peeked} run={run} />,
    filters: {
      query: { name: "q", placeholder: "id contains…", defaultValue: params.q ?? "" },
      connector: { name: "connector_id", defaultValue: params.connector_id ?? "" },
      status: {
        name: "status",
        defaultValue: params.status ?? "",
        options: [
          { value: "succeeded", label: "succeeded" },
          { value: "failed", label: "failed" },
          { value: "cancelled", label: "cancelled" },
          { value: "started", label: "started" },
          { value: "waiting_for_browser_surface", label: "waiting for browser" },
          { value: "deferred", label: "deferred" },
        ],
      },
    },
    activeFilterChips: activeFilters,
    resetHref: "/dashboard/runs",
    buildListHref: (overrides) => listHref(params, overrides),
    peekId: undefined,
    peekEnvelope: null,
    peekCliCommand: (id) => `pdpp ref run timeline ${id}`,
    emptyTitle: "No runs yet",
    emptyHint: "Run artifacts appear after connector runs stage, advance, or fail.",
  };

  return (
    <DashboardShell active="runs">
      <LivePoller enabled={liveRunCount > 0} />
      <ListWithPeekView params={viewParams} />
    </DashboardShell>
  );
}

// A run is "live" (worth auto-polling) if it is non-terminal OR is waiting
// on operator input.
function isLiveRun(run: RunSummary): boolean {
  if (!isTerminalRunStatus(run.status)) {
    return true;
  }
  return isAwaitingInteraction(run);
}

function isTerminalRunStatus(status: string): boolean {
  return ["cancelled", "failed", "rejected", "succeeded"].includes(status);
}
