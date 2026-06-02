import { PageHeader, StatusBadge } from "@pdpp/operator-ui/components/primitives";
import { type ListWithPeekParams, ListWithPeekView } from "@pdpp/operator-ui/components/views/list-with-peek";
import { dashboardRoutes } from "@pdpp/operator-ui/components/views/routes";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Timestamp } from "@/components/ui/timestamp.tsx";
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
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
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
    renderRow: (run, { peeked, href }) => <RunRow href={href} peeked={peeked} run={run} />,
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

function RunRow({ run, peeked, href }: { run: RunSummary; peeked: boolean; href: string }) {
  const awaitingInput = isAwaitingInteraction(run);
  const browserSurfaceCopy = browserSurfaceStatusCopy(run);
  return (
    <Link
      aria-current={peeked ? "true" : undefined}
      className={`block px-3 py-2.5 transition-colors ${peeked ? "bg-muted" : "hover:bg-muted/40"}`}
      href={href}
      scroll={false}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <code className="pdpp-caption break-all font-medium font-mono text-foreground">{run.run_id}</code>
        <div className="flex items-center gap-2">
          {awaitingInput ? <AwaitingInputChip /> : null}
          {browserSurfaceCopy ? <BrowserSurfaceChip label={browserSurfaceCopy.label} /> : null}
          <StatusBadge status={run.status} />
          <span className="pdpp-caption text-muted-foreground">
            <Timestamp value={run.last_at} />
          </span>
        </div>
      </div>
      <div className="pdpp-caption mt-1 text-muted-foreground">
        {run.event_count} events
        {run.connector_id ? ` · ${run.connector_id}` : ""}
        {run.provider_id ? ` · provider ${run.provider_id}` : ""}
        {run.failure_reason ? ` · ${run.failure_reason}` : ""}
      </div>
      {browserSurfaceCopy ? (
        <div className="pdpp-caption mt-1 text-muted-foreground">{browserSurfaceCopy.detail}</div>
      ) : null}
    </Link>
  );
}

function AwaitingInputChip() {
  return (
    <span
      className="pdpp-eyebrow rounded-[3px] bg-[color:var(--warning-wash)] px-1.5 py-0.5 font-medium text-[color:var(--warning)]"
      data-surface="human"
      title="This run is paused and requires operator input. Open it to respond."
    >
      needs input
    </span>
  );
}

function BrowserSurfaceChip({ label }: { label: string }) {
  return (
    <span
      className="pdpp-eyebrow rounded-[3px] bg-muted px-1.5 py-0.5 font-medium text-foreground"
      title="This is browser-surface resource backpressure, not connector auth or protocol failure."
    >
      {label}
    </span>
  );
}

function browserSurfaceStatusCopy(run: RunSummary): { detail: string; label: string } | null {
  if (!run.browser_surface_status) {
    return null;
  }
  const reason = run.browser_surface_wait_reason
    ? ` Reason: ${run.browser_surface_wait_reason.replaceAll("_", " ")}.`
    : "";
  if (run.browser_surface_status === "waiting_for_browser_surface") {
    return {
      label: "browser queued",
      detail: `Waiting for an available n.eko browser surface. This is runtime resource backpressure, not connector auth or protocol failure.${reason}`,
    };
  }
  if (run.browser_surface_status === "deferred") {
    return {
      label: "browser deferred",
      detail: `Deferred by the n.eko browser-surface lease policy. This is runtime resource backpressure, not connector auth or protocol failure.${reason}`,
    };
  }
  return {
    label: "browser surface",
    detail: `Browser-surface lease status: ${run.browser_surface_status.replaceAll("_", " ")}.${reason}`,
  };
}

// A run is "live" (worth auto-polling) if it is non-terminal OR is waiting
// on operator input.
function isLiveRun(run: RunSummary): boolean {
  if (!isTerminalRunStatus(run.status)) {
    return true;
  }
  return isAwaitingInteraction(run);
}

function isAwaitingInteraction(run: RunSummary): boolean {
  return run.needs_input === true;
}

function isTerminalRunStatus(status: string): boolean {
  return ["cancelled", "failed", "rejected", "succeeded"].includes(status);
}
