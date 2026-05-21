import Link from "next/link";
import { StatusBadge } from "@/app/dashboard/components/primitives.tsx";
import { DashboardShell } from "@/app/dashboard/components/shell.tsx";
import { type ListWithPeekParams, ListWithPeekView } from "@/app/dashboard/components/views/list-with-peek.tsx";
import { sandboxRoutes } from "@/app/dashboard/components/views/routes.ts";
import type { RunSummary } from "@/app/dashboard/lib/ref-client.ts";
import { Timestamp } from "@/components/ui/timestamp.tsx";
import { sandboxDashboardDataSource } from "../_demo/data-source.ts";

export const dynamic = "force-dynamic";

interface Params {
  connector_id?: string;
  cursor?: string;
  peek?: string;
  q?: string;
  status?: string;
}

function listHref(params: Params, overrides: Record<string, string | undefined>): string {
  const merged: Record<string, string | undefined> = { ...params, ...overrides };
  const qs = Object.entries(merged)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
  return qs ? `/sandbox/runs?${qs}` : "/sandbox/runs";
}

export default async function SandboxRunsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const ds = sandboxDashboardDataSource;
  const result = await ds.listRuns({
    cursor: params.cursor,
    status: params.status,
    connector_id: params.connector_id,
    q: params.q,
    limit: 50,
  });
  const peekEnvelope = params.peek ? await ds.getRunTimeline(params.peek) : null;

  const viewParams: ListWithPeekParams<RunSummary> = {
    active: "runs",
    routes: sandboxRoutes,
    subject: "run",
    title: "Runs",
    description: "Connector runs and their outcomes.",
    result,
    rowKey: (r) => r.run_id,
    renderRow: (run, { peeked, href }) => (
      <Link
        aria-current={peeked ? "true" : undefined}
        className={`block px-3 py-2.5 transition-colors ${peeked ? "bg-muted" : "hover:bg-muted/40"}`}
        href={href}
        scroll={false}
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <code className="pdpp-caption break-all font-medium font-mono text-foreground">{run.run_id}</code>
          <div className="flex items-center gap-2">
            {run.needs_input ? (
              <span className="pdpp-eyebrow rounded-[3px] bg-[color:var(--warning-wash)] px-1.5 py-0.5 font-medium text-[color:var(--warning)]">
                needs input
              </span>
            ) : null}
            <StatusBadge status={run.status} />
            <span className="pdpp-caption text-muted-foreground">
              <Timestamp value={run.last_at} />
            </span>
          </div>
        </div>
        <div className="pdpp-caption mt-1 text-muted-foreground">
          {run.event_count} events · {run.connector_id ?? "—"}
          {run.failure_reason ? ` · ${run.failure_reason}` : ""}
        </div>
      </Link>
    ),
    filters: {
      query: { name: "q", placeholder: "id contains…", defaultValue: params.q ?? "" },
      connector: { name: "connector_id", defaultValue: params.connector_id ?? "" },
      status: {
        name: "status",
        defaultValue: params.status ?? "",
        options: [
          { value: "succeeded", label: "succeeded" },
          { value: "failed", label: "failed" },
          { value: "needs_input", label: "needs input" },
          { value: "started", label: "started" },
        ],
      },
    },
    activeFilterChips: [
      params.status ? { label: "status", value: params.status } : null,
      params.connector_id ? { label: "connector", value: params.connector_id } : null,
      params.q ? { label: "query", value: params.q } : null,
    ].filter((c): c is { label: string; value: string } => Boolean(c)),
    resetHref: "/sandbox/runs",
    buildListHref: (overrides) => listHref(params, overrides),
    peekId: params.peek,
    peekEnvelope,
    peekCliCommand: (id) => `pdpp ref run timeline ${id}`,
    emptyTitle: "No runs",
    emptyHint: "No runs match this filter.",
  };

  return (
    <DashboardShell active="runs" mode="mock-owner">
      <ListWithPeekView params={viewParams} />
    </DashboardShell>
  );
}
