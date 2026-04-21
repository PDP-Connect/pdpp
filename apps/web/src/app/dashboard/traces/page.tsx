import Link from 'next/link';
import { DashboardShell, EmptyState, ServerUnreachable } from '../components/shell';
import { PeekEmpty, PeekPane, PeekTimeline, pivotsFromEnvelope } from '../components/peek';
import { ReferenceServerUnreachableError } from '../lib/owner-token';
import {
  getTraceTimeline,
  listTraces,
  type ListResponse,
  type TimelineEnvelope,
  type TraceSummary,
} from '../lib/ref-client';

export const dynamic = 'force-dynamic';

type Params = {
  cursor?: string;
  status?: string;
  client_id?: string;
  provider_id?: string;
  q?: string;
  peek?: string;
};

function listHref(params: Params, overrides: Partial<Params> = {}): string {
  const merged = { ...params, ...overrides };
  const qs = Object.entries(merged)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  return qs ? `/dashboard/traces?${qs}` : '/dashboard/traces';
}

export default async function TracesPage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
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
          <ServerUnreachable />
        </DashboardShell>
      );
    }
    throw err;
  }

  const closePeekHref = listHref(params, { peek: undefined });
  const openPeekFullHref = params.peek
    ? `/dashboard/traces/${encodeURIComponent(params.peek)}`
    : '';

  return (
    <DashboardShell active="traces">
      <header className="mb-4 flex items-baseline justify-between">
        <h1 className="text-lg font-semibold">Traces</h1>
        <span className="text-muted-foreground text-xs">
          {result.data.length} {result.has_more ? '+ more' : ''}
        </span>
      </header>
      <TraceFilters params={params} />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0">
          {result.data.length === 0 ? (
            <EmptyState title="No traces yet" hint="Trace artifacts appear as provider-connect, owner-device, or /v1 read flows run." />
          ) : (
            <ul className="divide-border divide-y border-y">
              {result.data.map((t) => (
                <li key={t.trace_id}>
                  <TraceRow trace={t} params={params} />
                </li>
              ))}
            </ul>
          )}
          {result.has_more && result.next_cursor && (
            <div className="mt-4 text-xs">
              <Link
                href={listHref(params, { cursor: result.next_cursor })}
                className="hover:text-foreground text-muted-foreground underline-offset-2 hover:underline"
              >
                next page →
              </Link>
            </div>
          )}
        </div>

        <div className="min-w-0">
          {params.peek ? (
            peekEnvelope ? (
              <PeekPane
                title={`trace ${params.peek}`}
                closeHref={closePeekHref}
                openHref={openPeekFullHref}
                cliCommand={`pdpp trace show ${params.peek}`}
              >
                <Pivots envelope={peekEnvelope} currentKind="trace" />
                <div className="text-muted-foreground mb-2 text-[11px]">
                  {peekEnvelope.events.length} events
                </div>
                <PeekTimeline events={peekEnvelope.events} />
              </PeekPane>
            ) : (
              <PeekPane
                title={`trace ${params.peek}`}
                closeHref={closePeekHref}
                openHref={openPeekFullHref}
              >
                <p className="text-muted-foreground">Trace not found.</p>
              </PeekPane>
            )
          ) : (
            <PeekEmpty />
          )}
        </div>
      </div>
    </DashboardShell>
  );
}

function TraceRow({ trace, params }: { trace: TraceSummary; params: Params }) {
  const peeked = params.peek === trace.trace_id;
  return (
    <Link
      href={listHref(params, { peek: trace.trace_id })}
      scroll={false}
      aria-current={peeked ? 'true' : undefined}
      className={`block px-2 py-2 ${peeked ? 'bg-muted' : 'hover:bg-muted/50'}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
        <code className="break-all font-medium">{trace.trace_id}</code>
        <span className="text-muted-foreground tabular-nums">{trace.last_at}</span>
      </div>
      <div className="text-muted-foreground mt-1 text-[11px]">
        <span className={trace.status === 'failed' || trace.status === 'rejected' ? 'text-destructive' : ''}>
          {trace.status}
        </span>
        {' · '}
        {trace.event_count} events
        {trace.client_id ? ` · client ${trace.client_id}` : ''}
        {trace.provider_id ? ` · ${trace.provider_id}` : ''}
        {' · '}
        {trace.kinds.slice(0, 4).join(', ')}
      </div>
    </Link>
  );
}

function Pivots({
  envelope,
  currentKind,
}: {
  envelope: TimelineEnvelope;
  currentKind: 'trace' | 'grant' | 'run';
}) {
  const pivots = pivotsFromEnvelope(envelope).filter((p) => p.kind !== currentKind);
  if (pivots.length === 0) return null;
  return (
    <div className="mb-3 flex flex-wrap gap-1">
      {pivots.map((p) => (
        <Link
          key={`${p.kind}:${p.id}`}
          href={`/dashboard/${p.kind}s?peek=${encodeURIComponent(p.id)}`}
          className="border-border hover:bg-muted/50 rounded border px-2 py-0.5 text-[10px]"
        >
          {p.kind} {p.id} →
        </Link>
      ))}
    </div>
  );
}

function TraceFilters({ params }: { params: Params }) {
  return (
    <form method="get" className="mb-4 flex flex-wrap items-center gap-2 text-xs">
      <input
        type="search"
        name="q"
        defaultValue={params.q ?? ''}
        placeholder="id contains…"
        className="border-border bg-background rounded border px-2 py-1"
      />
      <select
        name="status"
        defaultValue={params.status ?? ''}
        className="border-border bg-background rounded border px-2 py-1"
      >
        <option value="">any status</option>
        <option value="succeeded">succeeded</option>
        <option value="failed">failed</option>
        <option value="rejected">rejected</option>
        <option value="started">started</option>
      </select>
      <button type="submit" className="border-border hover:bg-muted/50 rounded border px-2 py-1">
        filter
      </button>
    </form>
  );
}
