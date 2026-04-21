import Link from 'next/link';
import { DashboardShell, EmptyState, ServerUnreachable } from '../components/shell';
import { PeekEmpty, PeekPane, PeekTimeline, pivotsFromEnvelope } from '../components/peek';
import { ReferenceServerUnreachableError } from '../lib/owner-token';
import {
  getRunTimeline,
  listRuns,
  type ListResponse,
  type RunSummary,
  type TimelineEnvelope,
} from '../lib/ref-client';

export const dynamic = 'force-dynamic';

type Params = {
  cursor?: string;
  status?: string;
  connector_id?: string;
  q?: string;
  peek?: string;
};

function listHref(params: Params, overrides: Partial<Params> = {}): string {
  const merged = { ...params, ...overrides };
  const qs = Object.entries(merged)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  return qs ? `/dashboard/runs?${qs}` : '/dashboard/runs';
}

export default async function RunsPage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const params = await searchParams;
  const filters = {
    cursor: params.cursor,
    status: params.status,
    connector_id: params.connector_id,
    q: params.q,
    limit: 50,
  };

  let result: ListResponse<RunSummary>;
  let peekEnvelope: TimelineEnvelope | null = null;
  try {
    result = await listRuns(filters);
    if (params.peek) {
      peekEnvelope = await getRunTimeline(params.peek);
    }
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <DashboardShell active="runs">
          <ServerUnreachable />
        </DashboardShell>
      );
    }
    throw err;
  }

  const closePeekHref = listHref(params, { peek: undefined });
  const openPeekFullHref = params.peek
    ? `/dashboard/runs/${encodeURIComponent(params.peek)}`
    : '';

  return (
    <DashboardShell active="runs">
      <header className="mb-4 flex items-baseline justify-between">
        <h1 className="text-lg font-semibold">Runs</h1>
        <span className="text-muted-foreground text-xs">
          {result.data.length} {result.has_more ? '+ more' : ''}
        </span>
      </header>

      <form method="get" className="mb-4 flex flex-wrap items-center gap-2 text-xs">
        <input
          type="search"
          name="q"
          defaultValue={params.q ?? ''}
          placeholder="id contains…"
          className="border-border bg-background rounded border px-2 py-1"
        />
        <input
          type="text"
          name="connector_id"
          defaultValue={params.connector_id ?? ''}
          placeholder="connector_id"
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
          <option value="cancelled">cancelled</option>
          <option value="started">started</option>
        </select>
        <button type="submit" className="border-border hover:bg-muted/50 rounded border px-2 py-1">
          filter
        </button>
      </form>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0">
          {result.data.length === 0 ? (
            <EmptyState title="No runs yet" hint="Run artifacts appear after connector runs stage, advance, or fail." />
          ) : (
            <ul className="divide-border divide-y border-y">
              {result.data.map((r) => (
                <li key={r.run_id}>
                  <RunRow run={r} params={params} />
                </li>
              ))}
            </ul>
          )}
          {result.has_more && result.next_cursor && (
            <div className="mt-4 text-xs">
              <Link
                href={listHref(params, { cursor: result.next_cursor })}
                className="hover:text-foreground text-muted-foreground hover:underline"
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
                title={`run ${params.peek}`}
                closeHref={closePeekHref}
                openHref={openPeekFullHref}
                cliCommand={`pdpp run timeline ${params.peek}`}
              >
                <Pivots envelope={peekEnvelope} currentKind="run" />
                <div className="text-muted-foreground mb-2 text-[11px]">
                  {peekEnvelope.events.length} events
                </div>
                <PeekTimeline events={peekEnvelope.events} />
              </PeekPane>
            ) : (
              <PeekPane
                title={`run ${params.peek}`}
                closeHref={closePeekHref}
                openHref={openPeekFullHref}
              >
                <p className="text-muted-foreground">Run not found.</p>
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

function RunRow({ run, params }: { run: RunSummary; params: Params }) {
  const peeked = params.peek === run.run_id;
  const isFailure = run.status === 'failed' || run.status === 'cancelled';
  return (
    <Link
      href={listHref(params, { peek: run.run_id })}
      scroll={false}
      aria-current={peeked ? 'true' : undefined}
      className={`block px-2 py-2 ${peeked ? 'bg-muted' : 'hover:bg-muted/50'}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
        <code className="break-all font-medium">{run.run_id}</code>
        <span className="text-muted-foreground tabular-nums">{run.last_at}</span>
      </div>
      <div className="text-muted-foreground mt-1 text-[11px]">
        <span className={isFailure ? 'text-destructive' : ''}>{run.status}</span>
        {' · '}
        {run.event_count} events
        {run.connector_id ? ` · ${run.connector_id}` : ''}
        {run.provider_id ? ` · provider ${run.provider_id}` : ''}
        {run.failure_reason ? ` · reason: ${run.failure_reason}` : ''}
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
