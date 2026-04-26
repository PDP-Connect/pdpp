import Link from "next/link";
import { StatusBadge } from "@/app/dashboard/components/primitives.tsx";
import { DashboardShell } from "@/app/dashboard/components/shell.tsx";
import { type ListWithPeekParams, ListWithPeekView } from "@/app/dashboard/components/views/list-with-peek.tsx";
import { sandboxRoutes } from "@/app/dashboard/components/views/routes.ts";
import type { TraceSummary } from "@/app/dashboard/lib/ref-client.ts";
import { Timestamp } from "@/components/ui/timestamp.tsx";
import { sandboxDashboardDataSource } from "../_demo/data-source.ts";

export const dynamic = "force-static";

interface Params {
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
  return qs ? `/sandbox/traces?${qs}` : "/sandbox/traces";
}

export default async function SandboxTracesPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const ds = sandboxDashboardDataSource;
  const result = await ds.listTraces({
    cursor: params.cursor,
    status: params.status,
    q: params.q,
    limit: 50,
  });
  const peekEnvelope = params.peek ? await ds.getTraceTimeline(params.peek) : null;

  const viewParams: ListWithPeekParams<TraceSummary> = {
    active: "traces",
    routes: sandboxRoutes,
    subject: "trace",
    title: "Traces",
    description: "Event-spine traces across grants and runs.",
    result,
    rowKey: (t) => t.trace_id,
    renderRow: (trace, { peeked, href }) => (
      <Link
        aria-current={peeked ? "true" : undefined}
        className={`block px-3 py-2.5 transition-colors ${peeked ? "bg-muted" : "hover:bg-muted/40"}`}
        href={href}
        scroll={false}
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <code className="pdpp-caption break-all font-medium font-mono text-foreground">{trace.trace_id}</code>
          <div className="flex items-center gap-2">
            <StatusBadge status={trace.status} />
            <span className="pdpp-caption text-muted-foreground">
              <Timestamp value={trace.last_at} />
            </span>
          </div>
        </div>
        <div className="pdpp-caption mt-1 text-muted-foreground">
          {trace.event_count} events
          {trace.client_id ? ` · client ${trace.client_id}` : ""}
          {" · "}
          {trace.kinds.slice(0, 4).join(", ")}
        </div>
      </Link>
    ),
    filters: {
      query: { name: "q", placeholder: "id contains…", defaultValue: params.q ?? "" },
      status: {
        name: "status",
        defaultValue: params.status ?? "",
        options: [
          { value: "succeeded", label: "succeeded" },
          { value: "failed", label: "failed" },
          { value: "denied", label: "denied" },
          { value: "revoked", label: "revoked" },
        ],
      },
    },
    activeFilterChips: [
      params.status ? { label: "status", value: params.status } : null,
      params.q ? { label: "query", value: params.q } : null,
    ].filter((c): c is { label: string; value: string } => Boolean(c)),
    resetHref: "/sandbox/traces",
    buildListHref: (overrides) => listHref(params, overrides),
    peekId: params.peek,
    peekEnvelope,
    peekCliCommand: (id) => `pdpp trace show ${id}`,
    emptyTitle: "No traces",
    emptyHint: "No traces match this filter.",
  };

  return (
    <DashboardShell active="traces" mode="mock-owner">
      <ListWithPeekView params={viewParams} />
    </DashboardShell>
  );
}
