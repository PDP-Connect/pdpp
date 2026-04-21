import Link from 'next/link';
import { DashboardShell, EmptyState, ServerUnreachable } from '../components/shell';
import { PeekEmpty, PeekPane, PeekTimeline, pivotsFromEnvelope } from '../components/peek';
import { ReferenceServerUnreachableError } from '../lib/owner-token';
import {
  getGrantTimeline,
  listGrants,
  type GrantSummary,
  type ListResponse,
  type TimelineEnvelope,
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
  return qs ? `/dashboard/grants?${qs}` : '/dashboard/grants';
}

export default async function GrantsPage({
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

  let result: ListResponse<GrantSummary>;
  let peekEnvelope: TimelineEnvelope | null = null;
  try {
    result = await listGrants(filters);
    if (params.peek) {
      peekEnvelope = await getGrantTimeline(params.peek);
    }
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <DashboardShell active="grants">
          <ServerUnreachable />
        </DashboardShell>
      );
    }
    throw err;
  }

  const closePeekHref = listHref(params, { peek: undefined });
  const openPeekFullHref = params.peek
    ? `/dashboard/grants/${encodeURIComponent(params.peek)}`
    : '';

  return (
    <DashboardShell active="grants">
      <header className="mb-4 flex items-baseline justify-between">
        <h1 className="text-lg font-semibold">Grants</h1>
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
        <select
          name="status"
          defaultValue={params.status ?? ''}
          className="border-border bg-background rounded border px-2 py-1"
        >
          <option value="">any state</option>
          <option value="issued">issued</option>
          <option value="revoked">revoked</option>
          <option value="denied">denied</option>
          <option value="failed">failed</option>
          <option value="pending">pending</option>
        </select>
        <button type="submit" className="border-border hover:bg-muted/50 rounded border px-2 py-1">
          filter
        </button>
      </form>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0">
          {result.data.length === 0 ? (
            <EmptyState title="No grants yet" hint="Grant artifacts appear after client/provider-connect consent flows issue or reject grants." />
          ) : (
            <ul className="divide-border divide-y border-y">
              {result.data.map((g) => (
                <li key={g.grant_id}>
                  <GrantRow grant={g} params={params} />
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
                title={`grant ${params.peek}`}
                closeHref={closePeekHref}
                openHref={openPeekFullHref}
                cliCommand={`pdpp grant timeline ${params.peek}`}
              >
                <Pivots envelope={peekEnvelope} currentKind="grant" />
                <div className="text-muted-foreground mb-2 text-[11px]">
                  {peekEnvelope.events.length} events
                </div>
                <PeekTimeline events={peekEnvelope.events} />
              </PeekPane>
            ) : (
              <PeekPane
                title={`grant ${params.peek}`}
                closeHref={closePeekHref}
                openHref={openPeekFullHref}
              >
                <p className="text-muted-foreground">Grant not found.</p>
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

function GrantRow({ grant, params }: { grant: GrantSummary; params: Params }) {
  const peeked = params.peek === grant.grant_id;
  return (
    <Link
      href={listHref(params, { peek: grant.grant_id })}
      scroll={false}
      aria-current={peeked ? 'true' : undefined}
      className={`block px-2 py-2 ${peeked ? 'bg-muted' : 'hover:bg-muted/50'}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
        <code className="break-all font-medium">{grant.grant_id}</code>
        <span className="text-muted-foreground tabular-nums">{grant.last_at}</span>
      </div>
      <div className="text-muted-foreground mt-1 text-[11px]">
        <span className={grant.status === 'failed' || grant.status === 'revoked' || grant.status === 'denied' ? 'text-destructive' : ''}>
          {grant.status}
        </span>
        {' · '}
        {grant.event_count} events
        {grant.client_id ? ` · client ${grant.client_id}` : ''}
        {grant.provider_id ? ` · provider ${grant.provider_id}` : ''}
        {grant.connector_id ? ` · connector ${grant.connector_id}` : ''}
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
