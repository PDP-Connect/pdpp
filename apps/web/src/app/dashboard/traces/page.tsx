import Link from "next/link";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Select } from "@/components/ui/select.tsx";
import { Timestamp } from "@/components/ui/timestamp.tsx";
import { PeekEmpty, PeekPane, PeekTimeline, pivotsFromEnvelope } from "../components/peek.tsx";
import {
  DataList,
  FilterSummary,
  PageHeader,
  Pager,
  SplitLayout,
  StatusBadge,
  Toolbar,
} from "../components/primitives.tsx";
import { DashboardShell, EmptyState, ServerUnreachable } from "../components/shell.tsx";
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
  cursor?: string;
  status?: string;
  client_id?: string;
  provider_id?: string;
  q?: string;
  peek?: string;
}

function listHref(params: Params, overrides: Partial<Params> = {}): string {
  const merged = { ...params, ...overrides };
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

  const closePeekHref = listHref(params, { peek: undefined });
  const openPeekFullHref = params.peek ? `/dashboard/traces/${encodeURIComponent(params.peek)}` : "";

  const activeFilters = [
    params.status ? { label: "status", value: params.status } : null,
    params.q ? { label: "query", value: params.q } : null,
  ].filter((item): item is { label: string; value: string } => Boolean(item));

  return (
    <DashboardShell active="traces">
      <PageHeader
        title="Traces"
        description="The event-spine view of protocol interactions — provider-connect, owner device flows, /v1 reads."
        count={`${result.data.length}${result.has_more ? "+" : ""}`}
      />

      <form method="get">
        <Toolbar>
          <label className="flex min-w-0 flex-col gap-1">
            <span className="pdpp-eyebrow">Query</span>
            <Input
              type="search"
              name="q"
              defaultValue={params.q ?? ""}
              placeholder="id contains…"
              className="w-64 font-mono"
            />
          </label>
          <label className="flex min-w-0 flex-col gap-1">
            <span className="pdpp-eyebrow">Status</span>
            <Select name="status" defaultValue={params.status ?? ""}>
              <option value="">Any</option>
              <option value="succeeded">succeeded</option>
              <option value="failed">failed</option>
              <option value="rejected">rejected</option>
              <option value="started">started</option>
            </Select>
          </label>
          <Button type="submit" size="sm" className="mt-5">
            Filter
          </Button>
        </Toolbar>
      </form>

      <FilterSummary items={activeFilters} resetHref="/dashboard/traces" />

      <SplitLayout
        main={
          <>
            {result.data.length === 0 ? (
              <EmptyState
                title="No traces yet"
                hint="Trace artifacts appear as provider-connect, owner-device, or /v1 read flows run."
              />
            ) : (
              <DataList>
                {result.data.map((t) => (
                  <li key={t.trace_id}>
                    <TraceRow trace={t} params={params} />
                  </li>
                ))}
              </DataList>
            )}
            {result.has_more && result.next_cursor && <Pager next={listHref(params, { cursor: result.next_cursor })} />}
          </>
        }
        peek={
          params.peek ? (
            peekEnvelope ? (
              <PeekPane
                title={`trace ${params.peek}`}
                closeHref={closePeekHref}
                openHref={openPeekFullHref}
                cliCommand={`pdpp trace show ${params.peek}`}
              >
                <Pivots envelope={peekEnvelope} currentKind="trace" />
                <div className="pdpp-caption mb-2 text-muted-foreground">{peekEnvelope.events.length} events</div>
                <PeekTimeline events={peekEnvelope.events} />
              </PeekPane>
            ) : (
              <PeekPane title={`trace ${params.peek}`} closeHref={closePeekHref} openHref={openPeekFullHref}>
                <p className="text-muted-foreground">Trace not found.</p>
              </PeekPane>
            )
          ) : (
            <PeekEmpty />
          )
        }
      />
    </DashboardShell>
  );
}

function TraceRow({ trace, params }: { trace: TraceSummary; params: Params }) {
  const peeked = params.peek === trace.trace_id;
  return (
    <Link
      href={listHref(params, { peek: trace.trace_id })}
      scroll={false}
      aria-current={peeked ? "true" : undefined}
      className={`block px-3 py-2.5 transition-colors ${peeked ? "bg-muted" : "hover:bg-muted/40"}`}
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

function Pivots({ envelope, currentKind }: { envelope: TimelineEnvelope; currentKind: "trace" | "grant" | "run" }) {
  const pivots = pivotsFromEnvelope(envelope).filter((p) => p.kind !== currentKind);
  if (pivots.length === 0) {
    return null;
  }
  return (
    <div className="mb-3 flex flex-wrap gap-1">
      {pivots.map((p) => (
        <Link
          key={`${p.kind}:${p.id}`}
          href={`/dashboard/${p.kind}s?peek=${encodeURIComponent(p.id)}`}
          className="pdpp-eyebrow rounded border border-border px-2 py-0.5 hover:bg-muted/60"
        >
          {p.kind} {p.id} →
        </Link>
      ))}
    </div>
  );
}
