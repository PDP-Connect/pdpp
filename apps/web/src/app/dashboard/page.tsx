import Link from 'next/link';
import { DashboardShell, EmptyState, ServerUnreachable } from './components/shell';
import {
  DataList,
  PageHeader,
  Section,
  StatusBadge,
} from './components/primitives';
import { OverviewHero } from './components/overview-hero';
import { ReferenceServerUnreachableError } from './lib/owner-token';
import {
  getDatasetSummary,
  listGrants,
  listRuns,
  listTraces,
  type DatasetSummary,
  type GrantSummary,
  type RunSummary,
  type TraceSummary,
} from './lib/ref-client';

export const dynamic = 'force-dynamic';

type OverviewData = {
  summary: DatasetSummary;
  failedTraces: TraceSummary[];
  failedRuns: RunSummary[];
  recentDecisions: GrantSummary[];
  recentRuns: RunSummary[];
  actionNeeded: number;
};

async function loadOverview(): Promise<OverviewData> {
  // Scale first. Then the things that need attention: failed traces/runs
  // and recently-decided grants. Recent runs support "what's happening now".
  const [
    summary,
    failedTraces,
    failedRuns,
    revokedGrants,
    deniedGrants,
    issuedGrants,
    recentRuns,
  ] = await Promise.all([
    getDatasetSummary(),
    listTraces({ status: 'failed', limit: 5 }),
    listRuns({ status: 'failed', limit: 5 }),
    listGrants({ status: 'revoked', limit: 5 }),
    listGrants({ status: 'denied', limit: 5 }),
    listGrants({ status: 'issued', limit: 5 }),
    listRuns({ limit: 8 }),
  ]);

  const recentDecisions = [...revokedGrants.data, ...deniedGrants.data, ...issuedGrants.data]
    .sort((a, b) => (a.last_at < b.last_at ? 1 : a.last_at > b.last_at ? -1 : 0))
    .slice(0, 6);

  return {
    summary,
    failedTraces: failedTraces.data,
    failedRuns: failedRuns.data,
    recentDecisions,
    recentRuns: recentRuns.data,
    actionNeeded: failedTraces.data.length + failedRuns.data.length,
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
          <PageHeader title="Overview" />
          <ServerUnreachable />
        </DashboardShell>
      );
    }
    throw err;
  }

  const hasFailures = data.actionNeeded > 0;

  return (
    <DashboardShell active="overview">
      <PageHeader
        title="Overview"
        description="A local-first operator console for the PDPP reference stack. Inspect traces, grants, runs, and retained records."
      />

      <OverviewHero summary={data.summary} />

      <StatusStrip
        actionNeeded={data.actionNeeded}
        hasFailures={hasFailures}
      />

      <div className="grid gap-8 lg:grid-cols-2">
        <Section
          title="Failed traces"
          description="Recent protocol interactions that did not complete."
          action={
            <Link
              href="/dashboard/traces?status=failed"
              className="text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
            >
              view all →
            </Link>
          }
        >
          {data.failedTraces.length === 0 ? (
            <EmptyState title="No failed traces" hint="Nothing has failed in the recent window." />
          ) : (
            <DataList>
              {data.failedTraces.map((t) => (
                <li key={t.trace_id}>
                  <Link
                    href={`/dashboard/traces?peek=${encodeURIComponent(t.trace_id)}`}
                    className="hover:bg-muted/40 block px-3 py-2.5 transition-colors"
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <code className="pdpp-caption text-foreground break-all font-mono font-medium">
                        {t.trace_id}
                      </code>
                      <span className="pdpp-caption text-muted-foreground tabular-nums">{t.last_at}</span>
                    </div>
                    <div className="pdpp-caption mt-1 flex flex-wrap items-center gap-2">
                      <StatusBadge status={t.status} />
                      <span className="text-muted-foreground">
                        {t.failure?.reason ?? t.kinds.slice(0, 3).join(', ')}
                      </span>
                    </div>
                  </Link>
                </li>
              ))}
            </DataList>
          )}
        </Section>

        <Section
          title="Failed runs"
          description="Connector runs that errored or were cancelled."
          action={
            <Link
              href="/dashboard/runs?status=failed"
              className="text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
            >
              view all →
            </Link>
          }
        >
          {data.failedRuns.length === 0 ? (
            <EmptyState title="No failed runs" hint="Nothing has failed in the recent window." />
          ) : (
            <DataList>
              {data.failedRuns.map((r) => (
                <li key={r.run_id}>
                  <Link
                    href={`/dashboard/runs?peek=${encodeURIComponent(r.run_id)}`}
                    className="hover:bg-muted/40 block px-3 py-2.5 transition-colors"
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <code className="pdpp-caption text-foreground break-all font-mono font-medium">
                        {r.run_id}
                      </code>
                      <span className="pdpp-caption text-muted-foreground tabular-nums">{r.last_at}</span>
                    </div>
                    <div className="pdpp-caption mt-1 flex flex-wrap items-center gap-2">
                      <StatusBadge status={r.status} />
                      <span className="text-muted-foreground">
                        {r.failure_reason ?? r.connector_id ?? '—'}
                      </span>
                    </div>
                  </Link>
                </li>
              ))}
            </DataList>
          )}
        </Section>
      </div>

      <Section
        title="Recent grant decisions"
        description="Issued, revoked, or denied in the last window."
        action={
          <Link
            href="/dashboard/grants"
            className="text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
          >
            view all →
          </Link>
        }
      >
        {data.recentDecisions.length === 0 ? (
          <EmptyState title="No recent grant decisions" />
        ) : (
          <DataList>
            {data.recentDecisions.map((g) => (
              <li key={g.grant_id}>
                <Link
                  href={`/dashboard/grants?peek=${encodeURIComponent(g.grant_id)}`}
                  className="pdpp-caption hover:bg-muted/40 grid gap-1 px-3 py-2.5 transition-colors sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_9rem]"
                >
                  <code className="text-foreground break-all font-mono font-medium">{g.grant_id}</code>
                  <span className="text-muted-foreground min-w-0 truncate">
                    client {g.client_id ?? '—'}
                    {g.connector_id ? ` · ${g.connector_id}` : g.provider_id ? ` · ${g.provider_id}` : ''}
                  </span>
                  <span className="pdpp-caption flex items-center gap-2 justify-self-end">
                    <StatusBadge status={g.status} />
                    <span className="text-muted-foreground tabular-nums">{g.last_at}</span>
                  </span>
                </Link>
              </li>
            ))}
          </DataList>
        )}
      </Section>

      <Section
        title="Recent runs"
        action={
          <Link
            href="/dashboard/runs"
            className="text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
          >
            view all →
          </Link>
        }
      >
        {data.recentRuns.length === 0 ? (
          <EmptyState title="No recent runs" />
        ) : (
          <DataList>
            {data.recentRuns.map((r) => (
              <li key={r.run_id}>
                <Link
                  href={`/dashboard/runs?peek=${encodeURIComponent(r.run_id)}`}
                  className="pdpp-caption hover:bg-muted/40 grid gap-1 px-3 py-2.5 transition-colors sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_9rem]"
                >
                  <code className="text-foreground break-all font-mono font-medium">{r.run_id}</code>
                  <span className="text-muted-foreground min-w-0 truncate">
                    {r.connector_id ?? r.provider_id ?? '—'}
                    {r.failure_reason ? ` · ${r.failure_reason}` : ''}
                  </span>
                  <span className="pdpp-caption flex items-center gap-2 justify-self-end">
                    <StatusBadge status={r.status} />
                    <span className="text-muted-foreground tabular-nums">{r.last_at}</span>
                  </span>
                </Link>
              </li>
            ))}
          </DataList>
        )}
      </Section>
    </DashboardShell>
  );
}

function StatusStrip({ actionNeeded, hasFailures }: { actionNeeded: number; hasFailures: boolean }) {
  if (!hasFailures) {
    return (
      <div className="pdpp-caption mb-8 flex items-center gap-2">
        <span
          aria-hidden
          className="inline-block h-1.5 w-1.5 rounded-full"
          style={{ background: 'var(--success)' }}
        />
        <span className="text-foreground font-medium">All clear.</span>
        <span className="text-muted-foreground">No failed traces or runs in the recent window.</span>
      </div>
    );
  }
  return (
    <div className="pdpp-caption border-destructive/30 bg-destructive/5 mb-8 flex flex-wrap items-center gap-3 rounded-md border-l-4 border-l-destructive/60 border px-4 py-2.5">
      <span className="text-destructive font-medium">
        {actionNeeded} recent failure{actionNeeded === 1 ? '' : 's'}
      </span>
      <span className="text-muted-foreground">needs attention</span>
      <div className="ml-auto flex flex-wrap items-center gap-3">
        <Link href="/dashboard/traces?status=failed" className="underline-offset-2 hover:underline">
          review traces →
        </Link>
        <Link href="/dashboard/runs?status=failed" className="underline-offset-2 hover:underline">
          review runs →
        </Link>
      </div>
    </div>
  );
}
