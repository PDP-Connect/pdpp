import Link from 'next/link';
import { DashboardShell, EmptyState, ServerUnreachable } from '../components/shell';
import { PeekEmpty, PeekPane, PeekTimeline, pivotsFromEnvelope } from '../components/peek';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import {
  DataList,
  FilterSummary,
  PageHeader,
  Pager,
  Section,
  SplitLayout,
  StatusBadge,
  Toolbar,
} from '../components/primitives';
import { getOwnerLoginPath, ReferenceServerUnreachableError } from '../lib/owner-token';
import {
  getGrantTimeline,
  listGrants,
  listPendingApprovals,
  type GrantSummary,
  type ListResponse,
  type PendingApproval,
  type TimelineEnvelope,
} from '../lib/ref-client';
import {
  approvePendingApprovalAction,
  denyPendingApprovalAction,
} from './pending-actions';
import { Timestamp } from '@/components/ui/timestamp';

export const dynamic = 'force-dynamic';

type Params = {
  cursor?: string;
  status?: string;
  client_id?: string;
  provider_id?: string;
  q?: string;
  peek?: string;
  approval_error?: string;
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
  let approvals: ListResponse<PendingApproval>;
  let peekEnvelope: TimelineEnvelope | null = null;
  try {
    [result, approvals] = await Promise.all([
      listGrants(filters),
      listPendingApprovals(),
    ]);
    if (params.peek) {
      peekEnvelope = await getGrantTimeline(params.peek);
    }
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <DashboardShell active="grants">
          <PageHeader title="Grants" />
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
  const ownerLoginUrl = getOwnerLoginPath();
  const activeFilters = [
    params.status ? { label: 'state', value: params.status } : null,
    params.q ? { label: 'query', value: params.q } : null,
  ].filter((item): item is { label: string; value: string } => Boolean(item));

  return (
    <DashboardShell active="grants">
      <PageHeader
        title="Grants"
        description="Issued authorizations and lifecycle decisions for client access to owner data."
        count={`${result.data.length}${result.has_more ? '+' : ''}`}
        actions={
          <>
            <Link href="/dashboard/grants/request" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
              Grant request workspace
            </Link>
            <Link href="/dashboard/grants/bootstrap" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
              Owner device flow
            </Link>
          </>
        }
      />

      {params.approval_error ? (
        <div className="pdpp-caption border-destructive/30 bg-destructive/5 mb-6 rounded-md border-l-4 border-l-destructive/60 border px-4 py-2.5">
          <span className="text-destructive font-medium">Approval error:</span>{' '}
          <span>{params.approval_error}</span>
        </div>
      ) : null}

      <Section
        id="pending-approvals"
        title={`Pending approvals (${approvals.data.length})`}
        description={
          approvals.data.length > 0
            ? `Device-flow and consent requests waiting for the owner.`
            : undefined
        }
      >
        {approvals.data.length === 0 ? (
          <EmptyState
            title="No pending approvals"
            hint="Device-flow and consent requests appear here while waiting for owner approval."
          />
        ) : (
          <>
            <DataList>
              {approvals.data.map((approval) => (
                <li key={approval.approval_id}>
                  <PendingApprovalRow approval={approval} />
                </li>
              ))}
            </DataList>
            <p className="pdpp-caption text-muted-foreground mt-2">
              These dashboard shortcut buttons work in open local-dev mode. If placeholder owner
              auth is enabled, sign in at{' '}
              <a href={ownerLoginUrl} className="underline-offset-2 hover:underline">
                owner access
              </a>{' '}
              and approve there instead.
            </p>
          </>
        )}
      </Section>

      <Section title="All grants">
        <form method="get">
          <Toolbar>
            <label className="flex min-w-0 flex-col gap-1">
              <span className="pdpp-eyebrow">Query</span>
              <Input
                type="search"
                name="q"
                defaultValue={params.q ?? ''}
                placeholder="id contains…"
                className="w-64 font-mono"
              />
            </label>
            <label className="flex min-w-0 flex-col gap-1">
              <span className="pdpp-eyebrow">State</span>
              <Select name="status" defaultValue={params.status ?? ''}>
                <option value="">Any state</option>
                <option value="issued">issued</option>
                <option value="revoked">revoked</option>
                <option value="denied">denied</option>
                <option value="failed">failed</option>
                <option value="pending">pending</option>
              </Select>
            </label>
            <Button type="submit" size="sm" className="mt-5">
              Filter
            </Button>
          </Toolbar>
        </form>

        <FilterSummary items={activeFilters} resetHref="/dashboard/grants" />

        <SplitLayout
          main={
            <>
              {result.data.length === 0 ? (
                <EmptyState
                  title="No grants yet"
                  hint="Grant artifacts appear after client/provider-connect consent flows issue or reject grants."
                />
              ) : (
                <DataList>
                  {result.data.map((g) => (
                    <li key={g.grant_id}>
                      <GrantRow grant={g} params={params} />
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
                  title={`grant ${params.peek}`}
                  closeHref={closePeekHref}
                  openHref={openPeekFullHref}
                  cliCommand={`pdpp grant timeline ${params.peek}`}
                >
                  <Pivots envelope={peekEnvelope} currentKind="grant" />
                  <div className="pdpp-caption text-muted-foreground mb-2">
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
            )
          }
        />
      </Section>
    </DashboardShell>
  );
}

function PendingApprovalRow({ approval }: { approval: PendingApproval }) {
  const previewStreams = Array.isArray(approval.grant_preview?.streams)
    ? approval.grant_preview.streams
        .map((stream) => (typeof stream === 'string' ? stream : stream?.name || ''))
        .filter(Boolean)
    : [];

  return (
    <div className="grid gap-3 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-2">
          <code className="pdpp-caption text-foreground break-all font-mono font-medium">
            {approval.approval_id}
          </code>
          <span className="pdpp-caption text-muted-foreground">
            <Timestamp value={approval.created_at} />
          </span>
          <StatusBadge status={approval.kind} />
        </div>
        <div className="pdpp-caption text-muted-foreground mt-1 break-words">
          client {approval.client_id ?? '—'}
          {approval.grant_preview?.connector_id ? ` · connector ${approval.grant_preview.connector_id}` : ''}
          {approval.grant_preview?.provider_id ? ` · provider ${approval.grant_preview.provider_id}` : ''}
          {previewStreams.length ? ` · streams ${previewStreams.join(', ')}` : ''}
        </div>
      </div>
      <form className="flex flex-wrap gap-2">
        <input type="hidden" name="kind" value={approval.kind} />
        <input type="hidden" name="approval_id" value={approval.approval_id} />
        {approval.user_code ? <input type="hidden" name="user_code" value={approval.user_code} /> : null}
        <Button formAction={approvePendingApprovalAction} type="submit" size="sm">
          Approve
        </Button>
        <Button
          formAction={denyPendingApprovalAction}
          type="submit"
          size="sm"
          variant="destructive"
        >
          Deny
        </Button>
      </form>
    </div>
  );
}

function GrantRow({ grant, params }: { grant: GrantSummary; params: Params }) {
  const peeked = params.peek === grant.grant_id;
  return (
    <Link
      href={listHref(params, { peek: grant.grant_id })}
      scroll={false}
      aria-current={peeked ? 'true' : undefined}
      className={`block px-3 py-2.5 transition-colors ${peeked ? 'bg-muted' : 'hover:bg-muted/40'}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <code className="pdpp-caption text-foreground break-all font-mono font-medium">
          {grant.grant_id}
        </code>
        <div className="flex items-center gap-2">
          <StatusBadge status={grant.status} />
          <span className="pdpp-caption text-muted-foreground tabular-nums">{grant.last_at}</span>
        </div>
      </div>
      <div className="pdpp-caption text-muted-foreground mt-1">
        {grant.event_count} events
        {grant.client_id ? ` · client ${grant.client_id}` : ''}
        {grant.provider_id ? ` · provider ${grant.provider_id}` : ''}
        {grant.connector_id ? ` · ${grant.connector_id}` : ''}
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
