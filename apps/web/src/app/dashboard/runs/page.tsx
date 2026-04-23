import Link from 'next/link';
import { DashboardShell, EmptyState, ServerUnreachable } from '../components/shell';
import { PeekEmpty, PeekPane, PeekTimeline, pivotsFromEnvelope } from '../components/peek';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import {
  DataList,
  FilterSummary,
  PageHeader,
  Pager,
  SplitLayout,
  StatusBadge,
  Toolbar,
} from '../components/primitives';
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
          <PageHeader title="Runs" />
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

  const activeFilters = [
    params.status ? { label: 'status', value: params.status } : null,
    params.connector_id ? { label: 'connector', value: params.connector_id } : null,
    params.q ? { label: 'query', value: params.q } : null,
  ].filter((item): item is { label: string; value: string } => Boolean(item));

  return (
    <DashboardShell active="runs">
      <PageHeader
        title="Runs"
        description="Connector runs and their lifecycle: staging, advance, progress, and failures."
        count={`${result.data.length}${result.has_more ? '+' : ''}`}
      />

      <form method="get">
        <Toolbar>
          <label className="flex min-w-0 flex-col gap-1">
            <span className="pdpp-eyebrow">Query</span>
            <Input
              type="search"
              name="q"
              defaultValue={params.q ?? ''}
              placeholder="id contains…"
              className="w-56 font-mono"
            />
          </label>
          <label className="flex min-w-0 flex-col gap-1">
            <span className="pdpp-eyebrow">Connector</span>
            <Input
              type="text"
              name="connector_id"
              defaultValue={params.connector_id ?? ''}
              placeholder="connector_id"
              className="w-48 font-mono"
            />
          </label>
          <label className="flex min-w-0 flex-col gap-1">
            <span className="pdpp-eyebrow">Status</span>
            <Select name="status" defaultValue={params.status ?? ''}>
              <option value="">Any</option>
              <option value="succeeded">succeeded</option>
              <option value="failed">failed</option>
              <option value="cancelled">cancelled</option>
              <option value="started">started</option>
            </Select>
          </label>
          <Button type="submit" size="sm" className="mt-5">
            Filter
          </Button>
        </Toolbar>
      </form>

      <FilterSummary items={activeFilters} resetHref="/dashboard/runs" />

      <SplitLayout
        main={
          <>
            {result.data.length === 0 ? (
              <EmptyState
                title="No runs yet"
                hint="Run artifacts appear after connector runs stage, advance, or fail."
              />
            ) : (
              <DataList>
                {result.data.map((r) => (
                  <li key={r.run_id}>
                    <RunRow run={r} params={params} />
                  </li>
                ))}
              </DataList>
            )}
            {result.has_more && result.next_cursor && (
              <Pager next={listHref(params, { cursor: result.next_cursor })} />
            )}
          </>
        }
        peek={
          params.peek ? (
            peekEnvelope ? (
              <PeekPane
                title={`run ${params.peek}`}
                closeHref={closePeekHref}
                openHref={openPeekFullHref}
                cliCommand={`pdpp run timeline ${params.peek}`}
              >
                <Pivots envelope={peekEnvelope} currentKind="run" />
                <div className="pdpp-caption text-muted-foreground mb-2">
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
          )
        }
      />
    </DashboardShell>
  );
}

function RunRow({ run, params }: { run: RunSummary; params: Params }) {
  const peeked = params.peek === run.run_id;
  return (
    <Link
      href={listHref(params, { peek: run.run_id })}
      scroll={false}
      aria-current={peeked ? 'true' : undefined}
      className={`block px-3 py-2.5 transition-colors ${peeked ? 'bg-muted' : 'hover:bg-muted/40'}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <code className="pdpp-caption text-foreground break-all font-mono font-medium">
          {run.run_id}
        </code>
        <div className="flex items-center gap-2">
          <StatusBadge status={run.status} />
          <span className="pdpp-caption text-muted-foreground tabular-nums">{run.last_at}</span>
        </div>
      </div>
      <div className="pdpp-caption text-muted-foreground mt-1">
        {run.event_count} events
        {run.connector_id ? ` · ${run.connector_id}` : ''}
        {run.provider_id ? ` · provider ${run.provider_id}` : ''}
        {run.failure_reason ? ` · ${run.failure_reason}` : ''}
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
          className="pdpp-eyebrow border-border hover:bg-muted/60 rounded border px-2 py-0.5"
        >
          {p.kind} {p.id} →
        </Link>
      ))}
    </div>
  );
}
