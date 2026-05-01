import Link from "next/link";
import { Timestamp } from "@/components/ui/timestamp.tsx";
import { PageHeader, StatusBadge } from "../components/primitives.tsx";
import { DashboardShell, ServerUnreachable } from "../components/shell.tsx";
import { type ListWithPeekParams, ListWithPeekView } from "../components/views/list-with-peek.tsx";
import { dashboardRoutes } from "../components/views/routes.ts";
import { ReferenceServerUnreachableError } from "../lib/owner-token.ts";
import {
  getTraceTimeline,
  type ListResponse,
  listTraces,
  type TimelineEnvelope,
  type TraceSummary,
} from "../lib/ref-client.ts";

export const dynamic = "force-dynamic";

interface Params {
  client_id?: string;
  cursor?: string;
  peek?: string;
  provider_id?: string;
  q?: string;
  status?: string;
}

function listHref(params: Params, overrides: Record<string, string | undefined> = {}): string {
  const merged: Record<string, string | undefined> = { ...params, ...overrides };
  const qs = Object.entries(merged)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
  return qs ? `/dashboard/traces?${qs}` : "/dashboard/traces";
}

export default async function TracesPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const filters = {
    cursor: params.cursor,
    status: params.status,
    client_id: params.client_id,
    provider_id: params.provider_id,
    q: params.q,
    limit: 50,
  };

  let result: ListResponse<TraceSummary>;
  let peekEnvelope: TimelineEnvelope | null = null;
  try {
    result = await listTraces(filters);
    if (params.peek) {
      peekEnvelope = await getTraceTimeline(params.peek);
    }
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <DashboardShell active="traces">
          <PageHeader title="Traces" />
          <ServerUnreachable />
        </DashboardShell>
      );
    }
    throw err;
  }

  const activeFilters = [
    params.status ? { label: "status", value: params.status } : null,
    params.q ? { label: "query", value: params.q } : null,
  ].filter((item): item is { label: string; value: string } => Boolean(item));
  const viewParams: ListWithPeekParams<TraceSummary> = {
    active: "traces",
    routes: dashboardRoutes,
    subject: "trace",
    title: "Traces",
    description: "The event-spine view of protocol interactions — provider-connect, owner device flows, /v1 reads.",
    result,
    rowKey: (trace) => trace.trace_id,
    renderRow: (trace, { peeked, href }) => <TraceRow href={href} peeked={peeked} trace={trace} />,
    filters: {
      query: { name: "q", placeholder: "id contains…", defaultValue: params.q ?? "" },
      status: {
        name: "status",
        defaultValue: params.status ?? "",
        options: [
          { value: "succeeded", label: "succeeded" },
          { value: "failed", label: "failed" },
          { value: "rejected", label: "rejected" },
          { value: "started", label: "started" },
        ],
      },
    },
    activeFilterChips: activeFilters,
    resetHref: "/dashboard/traces",
    buildListHref: (overrides) => listHref(params, overrides),
    peekId: params.peek,
    peekEnvelope,
    peekCliCommand: (id) => `pdpp trace show ${id}`,
    emptyTitle: "No traces yet",
    emptyHint: "Trace artifacts appear as provider-connect, owner-device, or /v1 read flows run.",
  };

  return (
    <DashboardShell active="traces">
      <ListWithPeekView params={viewParams} />
    </DashboardShell>
  );
}

function TraceRow({ trace, peeked, href }: { trace: TraceSummary; peeked: boolean; href: string }) {
  return (
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
        {trace.provider_id ? ` · ${trace.provider_id}` : ""}
        {" · "}
        {trace.kinds.slice(0, 4).join(", ")}
      </div>
    </Link>
  );
}
