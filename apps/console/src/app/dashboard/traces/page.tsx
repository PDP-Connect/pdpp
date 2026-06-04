import { PageHeader, StatusBadge } from "@pdpp/operator-ui/components/primitives";
import { type ListWithPeekParams, ListWithPeekView } from "@pdpp/operator-ui/components/views/list-with-peek";
import { dashboardRoutes } from "@pdpp/operator-ui/components/views/routes";
import { traceRowLabel } from "@pdpp/operator-ui/lib/summary-row-label";
import Link from "next/link";
import { Timestamp } from "@/components/ui/timestamp.tsx";
import { DashboardShell, ServerUnreachable } from "../components/shell.tsx";
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
    .flatMap(([k, v]) =>
      v === undefined || v === "" ? [] : [`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`]
    )
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
    peekCliCommand: (id) => `pdpp ref trace show ${id}`,
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
  const kinds = trace.kinds.slice(0, 4).join(", ");
  return (
    <Link
      aria-current={peeked ? "true" : undefined}
      className={`block px-3 py-2.5 transition-colors ${peeked ? "bg-muted" : "hover:bg-muted/40"}`}
      href={href}
      scroll={false}
    >
      {/* Lead with the source/client + outcome; the raw trace id is demoted to
          a monospace lookup key on the detail line. */}
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate font-medium text-foreground">{traceRowLabel(trace)}</span>
          <StatusBadge status={trace.status} />
          {kinds ? <span className="pdpp-caption truncate text-muted-foreground">{kinds}</span> : null}
        </div>
        <span className="pdpp-caption shrink-0 text-muted-foreground tabular-nums">
          <Timestamp value={trace.last_at} />
        </span>
      </div>
      <div className="pdpp-caption mt-0.5 flex flex-wrap items-center gap-x-2 text-muted-foreground">
        <code className="break-all font-mono">{trace.trace_id}</code>
        <span className="text-muted-foreground/50">·</span>
        <span className="tabular-nums">{trace.event_count} events</span>
        {trace.client_id ? (
          <>
            <span className="text-muted-foreground/50">·</span>
            <span>client {trace.client_id}</span>
          </>
        ) : null}
      </div>
    </Link>
  );
}
