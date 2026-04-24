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
  client_id?: string;
  cursor?: string;
  peek?: string;
  provider_id?: string;
  q?: string;
  status?: string;
}

function renderTracesPeek({
  peekId,
  peekEnvelope,
  closePeekHref,
  openPeekFullHref,
}: {
  peekId: string | undefined;
  peekEnvelope: TimelineEnvelope | null;
  closePeekHref: string;
  openPeekFullHref: string;
}) {
  if (!peekId) {
    return <PeekEmpty />;
  }
  if (!peekEnvelope) {
    return (
      <PeekPane closeHref={closePeekHref} openHref={openPeekFullHref} title={`trace ${peekId}`}>
        <p className="text-muted-foreground">Trace not found.</p>
      </PeekPane>
    );
  }
  return (
    <PeekPane
      cliCommand={`pdpp trace show ${peekId}`}
      closeHref={closePeekHref}
      openHref={openPeekFullHref}
      title={`trace ${peekId}`}
    >
      <Pivots currentKind="trace" envelope={peekEnvelope} />
      <div className="pdpp-caption mb-2 text-muted-foreground">{peekEnvelope.events.length} events</div>
      <PeekTimeline events={peekEnvelope.events} />
    </PeekPane>
  );
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
        count={`${result.data.length}${result.has_more ? "+" : ""}`}
        description="The event-spine view of protocol interactions — provider-connect, owner device flows, /v1 reads."
        title="Traces"
      />

      <form method="get">
        <Toolbar>
          <label className="flex min-w-0 flex-col gap-1" htmlFor="traces-query">
            <span className="pdpp-eyebrow">Query</span>
            <Input
              className="w-64 font-mono"
              defaultValue={params.q ?? ""}
              id="traces-query"
              name="q"
              placeholder="id contains…"
              type="search"
            />
          </label>
          <label className="flex min-w-0 flex-col gap-1" htmlFor="traces-status">
            <span className="pdpp-eyebrow">Status</span>
            <Select defaultValue={params.status ?? ""} id="traces-status" name="status">
              <option value="">Any</option>
              <option value="succeeded">succeeded</option>
              <option value="failed">failed</option>
              <option value="rejected">rejected</option>
              <option value="started">started</option>
            </Select>
          </label>
          <Button className="mt-5" size="sm" type="submit">
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
                hint="Trace artifacts appear as provider-connect, owner-device, or /v1 read flows run."
                title="No traces yet"
              />
            ) : (
              <DataList>
                {result.data.map((t) => (
                  <li key={t.trace_id}>
                    <TraceRow params={params} trace={t} />
                  </li>
                ))}
              </DataList>
            )}
            {result.has_more && result.next_cursor && <Pager next={listHref(params, { cursor: result.next_cursor })} />}
          </>
        }
        peek={renderTracesPeek({ peekId: params.peek, peekEnvelope, closePeekHref, openPeekFullHref })}
      />
    </DashboardShell>
  );
}

function TraceRow({ trace, params }: { trace: TraceSummary; params: Params }) {
  const peeked = params.peek === trace.trace_id;
  return (
    <Link
      aria-current={peeked ? "true" : undefined}
      className={`block px-3 py-2.5 transition-colors ${peeked ? "bg-muted" : "hover:bg-muted/40"}`}
      href={listHref(params, { peek: trace.trace_id })}
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

function Pivots({ envelope, currentKind }: { envelope: TimelineEnvelope; currentKind: "trace" | "grant" | "run" }) {
  const pivots = pivotsFromEnvelope(envelope).filter((p) => p.kind !== currentKind);
  if (pivots.length === 0) {
    return null;
  }
  return (
    <div className="mb-3 flex flex-wrap gap-1">
      {pivots.map((p) => (
        <Link
          className="pdpp-eyebrow rounded border border-border px-2 py-0.5 hover:bg-muted/60"
          href={`/dashboard/${p.kind}s?peek=${encodeURIComponent(p.id)}`}
          key={`${p.kind}:${p.id}`}
        >
          {p.kind} {p.id} →
        </Link>
      ))}
    </div>
  );
}
