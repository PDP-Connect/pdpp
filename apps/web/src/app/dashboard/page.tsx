import Link from 'next/link';
import { DashboardShell, ServerUnreachable } from './components/shell';
import { ReferenceServerUnreachableError } from './lib/owner-token';
import {
  listGrants,
  listRuns,
  listTraces,
  type GrantSummary,
  type RunSummary,
  type TraceSummary,
} from './lib/ref-client';

export const dynamic = 'force-dynamic';

type OverviewData = {
  failedTraces: TraceSummary[];
  failedRuns: RunSummary[];
  recentDecisions: GrantSummary[];
  recentRuns: RunSummary[];
  actionNeeded: number;
};

async function loadOverview(): Promise<OverviewData> {
  // Pull small focused slices in parallel. The failed-only slices are what we
  // highlight up top; the lifecycle "decisions" slice surfaces recent issued/
  // revoked/denied grants together for the operator.
  const [failedTracesRes, failedRunsRes, revokedGrantsRes, deniedGrantsRes, issuedGrantsRes, recentRunsRes] =
    await Promise.all([
      listTraces({ status: 'failed', limit: 5 }),
      listRuns({ status: 'failed', limit: 5 }),
      listGrants({ status: 'revoked', limit: 5 }),
      listGrants({ status: 'denied', limit: 5 }),
      listGrants({ status: 'issued', limit: 5 }),
      listRuns({ limit: 10 }),
    ]);

  const recentDecisions = [
    ...revokedGrantsRes.data,
    ...deniedGrantsRes.data,
    ...issuedGrantsRes.data,
  ]
    .sort((a, b) => (a.last_at < b.last_at ? 1 : a.last_at > b.last_at ? -1 : 0))
    .slice(0, 6);

  return {
    failedTraces: failedTracesRes.data,
    failedRuns: failedRunsRes.data,
    recentDecisions,
    recentRuns: recentRunsRes.data,
    actionNeeded: failedTracesRes.data.length + failedRunsRes.data.length,
  };
}

export default async function DashboardPage() {
  let data: OverviewData;
  try {
    data = await loadOverview();
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <DashboardShell active="overview">
          <ServerUnreachable />
        </DashboardShell>
      );
    }
    throw err;
  }

  const hasFailures = data.failedTraces.length > 0 || data.failedRuns.length > 0;

  return (
    <DashboardShell active="overview">
      <header className="mb-4">
        <h1 className="text-lg font-semibold">Overview</h1>
        <p className="text-muted-foreground text-xs">
          Local-first operator console. Inspection of traces, grants, runs, and records.
        </p>
      </header>

      <ActionBanner
        actionNeeded={data.actionNeeded}
        hasFailures={hasFailures}
      />

      <section className="mb-6 grid gap-3 md:grid-cols-2">
        <FailuresPanel title="Recent failed traces" href="/dashboard/traces?status=failed" items={data.failedTraces} render={(t) => (
          <Link
            href={`/dashboard/traces?peek=${encodeURIComponent(t.trace_id)}`}
            className="hover:bg-muted/50 block px-2 py-2"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
              <code className="break-all font-medium">{t.trace_id}</code>
              <span className="text-muted-foreground tabular-nums">{t.last_at}</span>
            </div>
            <div className="text-destructive text-[11px]">
              {t.status}
              {t.failure?.reason ? ` · ${t.failure.reason}` : ''}
              {' · '}
              {t.kinds.slice(0, 3).join(', ')}
            </div>
          </Link>
        )} emptyLabel="No failed traces in the recent window." />

        <FailuresPanel title="Recent failed runs" href="/dashboard/runs?status=failed" items={data.failedRuns} render={(r) => (
          <Link
            href={`/dashboard/runs?peek=${encodeURIComponent(r.run_id)}`}
            className="hover:bg-muted/50 block px-2 py-2"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
              <code className="break-all font-medium">{r.run_id}</code>
              <span className="text-muted-foreground tabular-nums">{r.last_at}</span>
            </div>
            <div className="text-destructive text-[11px]">
              {r.status}
              {r.failure_reason ? ` · ${r.failure_reason}` : ''}
              {r.connector_id ? ` · ${r.connector_id}` : ''}
            </div>
          </Link>
        )} emptyLabel="No failed runs in the recent window." />
      </section>

      <RecentSection title="Recent decisions" href="/dashboard/grants" items={data.recentDecisions} render={(g) => (
        <Link
          href={`/dashboard/grants?peek=${encodeURIComponent(g.grant_id)}`}
          className="hover:bg-muted/50 block px-2 py-2"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
            <code className="break-all font-medium">{g.grant_id}</code>
            <span className="text-muted-foreground tabular-nums">{g.last_at}</span>
          </div>
          <div className="text-[11px]">
            <LifecycleBadge status={g.status} />{' '}
            <span className="text-muted-foreground">
              client {g.client_id ?? '—'}
              {g.connector_id ? ` · connector ${g.connector_id}` : g.provider_id ? ` · provider ${g.provider_id}` : ''}
            </span>
          </div>
        </Link>
      )} emptyLabel="No recent grant decisions." />

      <RecentSection title="Recent runs" href="/dashboard/runs" items={data.recentRuns} render={(r) => {
        const failed = r.status === 'failed' || r.status === 'cancelled';
        return (
          <Link
            href={`/dashboard/runs?peek=${encodeURIComponent(r.run_id)}`}
            className="hover:bg-muted/50 block px-2 py-2"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
              <code className="break-all font-medium">{r.run_id}</code>
              <span className="text-muted-foreground tabular-nums">{r.last_at}</span>
            </div>
            <div className="text-[11px]">
              <span className={failed ? 'text-destructive' : 'text-muted-foreground'}>
                {r.status}
              </span>
              {' · '}
              <span className="text-muted-foreground">
                {r.connector_id ?? r.provider_id ?? '—'}
                {r.failure_reason ? ` · ${r.failure_reason}` : ''}
              </span>
            </div>
          </Link>
        );
      }} emptyLabel="No recent runs." />
    </DashboardShell>
  );
}

function ActionBanner({ actionNeeded, hasFailures }: { actionNeeded: number; hasFailures: boolean }) {
  if (!hasFailures) {
    return (
      <div className="border-border bg-muted/30 mb-6 rounded border px-3 py-2 text-xs">
        <span className="text-muted-foreground">All clear.</span>{' '}
        <span className="text-muted-foreground">
          No failed traces or runs in the recent window.
        </span>
      </div>
    );
  }
  return (
    <div className="border-destructive/40 bg-destructive/5 mb-6 rounded border px-3 py-2 text-xs">
      <span className="text-destructive font-medium">Action needed:</span>{' '}
      <span className="text-foreground">{actionNeeded} recent failure{actionNeeded === 1 ? '' : 's'}.</span>{' '}
      <Link href="/dashboard/traces?status=failed" className="underline-offset-2 hover:underline">
        review traces →
      </Link>{' '}
      <Link href="/dashboard/runs?status=failed" className="underline-offset-2 hover:underline">
        review runs →
      </Link>
    </div>
  );
}

function LifecycleBadge({ status }: { status: string }) {
  const tone =
    status === 'revoked' || status === 'failed' || status === 'denied'
      ? 'bg-destructive/10 text-destructive'
      : status === 'issued'
      ? 'bg-muted text-foreground'
      : 'bg-muted text-muted-foreground';
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] ${tone}`}>{status}</span>
  );
}

function FailuresPanel<T>({
  title,
  href,
  items,
  render,
  emptyLabel,
}: {
  title: string;
  href: string;
  items: T[];
  render: (item: T) => React.ReactNode;
  emptyLabel: string;
}) {
  return (
    <section className="border-border rounded border">
      <h2 className="text-muted-foreground border-border flex items-baseline justify-between border-b px-3 py-2 text-xs uppercase tracking-wide">
        <span>{title}</span>
        <Link href={href} className="hover:text-foreground normal-case tracking-normal">
          all →
        </Link>
      </h2>
      {items.length === 0 ? (
        <p className="text-muted-foreground px-3 py-3 text-xs">{emptyLabel}</p>
      ) : (
        <ul className="divide-border divide-y">
          {items.map((item, i) => (
            <li key={i}>{render(item)}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RecentSection<T>({
  title,
  href,
  items,
  render,
  emptyLabel,
}: {
  title: string;
  href: string;
  items: T[];
  render: (item: T) => React.ReactNode;
  emptyLabel: string;
}) {
  return (
    <section className="mb-6">
      <h2 className="text-muted-foreground mb-2 flex items-baseline justify-between text-xs uppercase tracking-wide">
        <span>{title}</span>
        <Link href={href} className="hover:text-foreground normal-case tracking-normal">
          all →
        </Link>
      </h2>
      {items.length === 0 ? (
        <p className="text-muted-foreground border-border rounded border px-3 py-3 text-xs">
          {emptyLabel}
        </p>
      ) : (
        <ul className="divide-border divide-y border-y">
          {items.map((item, i) => (
            <li key={i}>{render(item)}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
