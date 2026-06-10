/**
 * Shared dashboard overview view. Used by /dashboard and /sandbox.
 *
 * The page calls its data source for the summary, failed traces/runs,
 * grant decisions, and recent runs, then passes them in. The view
 * renders the hero, status strip, and four sections.
 */

import Link from "next/link";
import { formatSourceForDisplay } from "../../lib/connector-display.ts";
import type { DatasetSummary, GrantSummary, RunSummary, TraceSummary } from "../../lib/ref-client.ts";
import { grantRowLabel, traceRowLabel } from "../../lib/summary-row-label.ts";
import { Timestamp } from "../../ui/timestamp.tsx";
import { EmptyState } from "../empty-state.tsx";
import { OverviewHero } from "../overview-hero.tsx";
import { DataList, PageHeader, Section, StatusBadge } from "../primitives.tsx";
import { RunRow } from "../run-row.tsx";
import type { Routes } from "./routes.ts";

export interface OverviewViewData {
  actionNeeded: number;
  failedRuns: RunSummary[];
  failedTraces: TraceSummary[];
  recentDecisions: GrantSummary[];
  recentRuns: RunSummary[];
  summary: DatasetSummary;
}

export interface AttentionOverviewData {
  actionNeeded: number;
  failedRuns: RunSummary[];
  failedTraces: TraceSummary[];
}

export interface RecentActivityOverviewData {
  recentDecisions: GrantSummary[];
  recentRuns: RunSummary[];
}

export function OverviewView({
  data,
  routes,
  description,
}: {
  data: OverviewViewData;
  routes: Routes;
  description: string;
}) {
  return (
    <>
      <PageHeader description={description} title="Overview" />
      <OverviewHero
        addSourceHref={routes.section.addSource}
        exploreHref={routes.section.explore}
        recordsHref={routes.section.records}
        summary={data.summary}
      />
      <AttentionOverview
        data={{ actionNeeded: data.actionNeeded, failedRuns: data.failedRuns, failedTraces: data.failedTraces }}
        routes={routes}
      />
      <RecentActivityOverview
        data={{ recentDecisions: data.recentDecisions, recentRuns: data.recentRuns }}
        routes={routes}
      />
    </>
  );
}

export function AttentionOverview({ data, routes }: { data: AttentionOverviewData; routes: Routes }) {
  const hasFailures = data.actionNeeded > 0;
  return (
    <>
      <StatusStrip actionNeeded={data.actionNeeded} hasFailures={hasFailures} routes={routes} />
      <FailedOverviewLists failedRuns={data.failedRuns} failedTraces={data.failedTraces} routes={routes} />
    </>
  );
}

export function AttentionOverviewPlaceholder() {
  return (
    <>
      <div className="pdpp-caption mb-8 flex items-center gap-2">
        <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
        <span className="font-medium text-foreground">Checking failures…</span>
        <span className="text-muted-foreground">Failed traces and runs are loading independently.</span>
      </div>
      <div className="grid gap-8 lg:grid-cols-2">
        <Section description="Recent protocol interactions that did not complete." title="Failed traces">
          <EmptyState hint="Checking the recent failure window." title="Loading failed traces" />
        </Section>
        <Section description="Connector runs that errored or were cancelled." title="Failed runs">
          <EmptyState hint="Checking the recent failure window." title="Loading failed runs" />
        </Section>
      </div>
    </>
  );
}

export function AttentionOverviewError() {
  return (
    <>
      <div className="pdpp-caption mb-8 flex items-center gap-2">
        <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
        <span className="font-medium text-foreground">Could not check failures.</span>
        <span className="text-muted-foreground">Refresh the dashboard to retry.</span>
      </div>
      <div className="grid gap-8 lg:grid-cols-2">
        <Section description="Recent protocol interactions that did not complete." title="Failed traces">
          <EmptyState hint="Refresh the dashboard to retry." title="Could not load failed traces" />
        </Section>
        <Section description="Connector runs that errored or were cancelled." title="Failed runs">
          <EmptyState hint="Refresh the dashboard to retry." title="Could not load failed runs" />
        </Section>
      </div>
    </>
  );
}

function FailedOverviewLists({
  failedRuns,
  failedTraces,
  routes,
}: {
  failedRuns: RunSummary[];
  failedTraces: TraceSummary[];
  routes: Routes;
}) {
  return (
    <div className="grid gap-8 lg:grid-cols-2">
      <Section
        action={
          <Link
            className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            href={`${routes.section.traces}?status=failed`}
          >
            view all →
          </Link>
        }
        description="Recent protocol interactions that did not complete."
        title="Failed traces"
      >
        {failedTraces.length === 0 ? (
          <EmptyState hint="Nothing has failed in the recent window." title="No failed traces" />
        ) : (
          <DataList>
            {failedTraces.map((t) => (
              <li key={t.trace_id}>
                <Link
                  className="block px-3 py-2.5 transition-colors hover:bg-muted/40"
                  href={routes.peek(routes.section.traces, t.trace_id)}
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="truncate font-medium text-foreground">{traceRowLabel(t)}</span>
                      <StatusBadge status={t.status} />
                    </div>
                    <span className="pdpp-caption shrink-0 text-muted-foreground tabular-nums">
                      <Timestamp value={t.last_at} />
                    </span>
                  </div>
                  <div className="pdpp-caption mt-0.5 flex flex-wrap items-center gap-x-2 text-muted-foreground">
                    <code className="break-all font-mono">{t.trace_id}</code>
                    {(t.failure?.reason ?? t.kinds.slice(0, 3).join(", ")) ? (
                      <>
                        <span className="text-muted-foreground/50">·</span>
                        <span className="text-destructive/90">
                          {t.failure?.reason ?? t.kinds.slice(0, 3).join(", ")}
                        </span>
                      </>
                    ) : null}
                  </div>
                </Link>
              </li>
            ))}
          </DataList>
        )}
      </Section>
      <Section
        action={
          <Link
            className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            href={`${routes.section.runs}?status=failed`}
          >
            view all →
          </Link>
        }
        description="Connector runs that errored or were cancelled."
        title="Failed runs"
      >
        {failedRuns.length === 0 ? (
          <EmptyState hint="Nothing has failed in the recent window." title="No failed runs" />
        ) : (
          <DataList>
            {failedRuns.map((r) => (
              <li key={r.run_id}>
                <RunRow href={routes.peek(routes.section.runs, r.run_id)} run={r} />
              </li>
            ))}
          </DataList>
        )}
      </Section>
    </div>
  );
}

export function RecentActivityOverview({ data, routes }: { data: RecentActivityOverviewData; routes: Routes }) {
  return (
    <>
      <Section
        action={
          <Link
            className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            href={routes.section.grants}
          >
            view all →
          </Link>
        }
        description="Issued, revoked, or denied in the last window."
        title="Recent grant decisions"
      >
        {data.recentDecisions.length === 0 ? (
          <EmptyState title="No recent grant decisions" />
        ) : (
          <DataList>
            {data.recentDecisions.map((g) => (
              <li key={g.grant_id}>
                <Link
                  className="block px-3 py-2.5 transition-colors hover:bg-muted/40"
                  href={routes.peek(routes.section.grants, g.grant_id)}
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="truncate font-medium text-foreground">{grantRowLabel(g)}</span>
                      <StatusBadge status={g.status} />
                      {g.client_id ? (
                        <span className="pdpp-caption truncate text-muted-foreground">client {g.client_id}</span>
                      ) : null}
                    </div>
                    <span className="pdpp-caption shrink-0 text-muted-foreground tabular-nums">
                      <Timestamp value={g.last_at} />
                    </span>
                  </div>
                  <div className="pdpp-caption mt-0.5 flex flex-wrap items-center gap-x-2 text-muted-foreground">
                    <code className="break-all font-mono">{g.grant_id}</code>
                    {g.source ? (
                      <>
                        <span className="text-muted-foreground/50">·</span>
                        <span>source {formatSourceForDisplay(g.source)}</span>
                      </>
                    ) : null}
                  </div>
                </Link>
              </li>
            ))}
          </DataList>
        )}
      </Section>

      <Section
        action={
          <Link
            className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            href={routes.section.runs}
          >
            view all →
          </Link>
        }
        description="Connector runs started in the last window."
        title="Recent runs"
      >
        {data.recentRuns.length === 0 ? (
          <EmptyState title="No recent runs" />
        ) : (
          <DataList>
            {data.recentRuns.map((r) => (
              <li key={r.run_id}>
                <RunRow href={routes.peek(routes.section.runs, r.run_id)} run={r} />
              </li>
            ))}
          </DataList>
        )}
      </Section>
    </>
  );
}

export function RecentActivityPlaceholder() {
  return (
    <>
      <Section description="Issued, revoked, or denied in the last window." title="Recent grant decisions">
        <EmptyState title="Loading recent grant decisions" />
      </Section>
      <Section description="Connector runs started in the last window." title="Recent runs">
        <EmptyState title="Loading recent runs" />
      </Section>
    </>
  );
}

export function RecentActivityError() {
  return (
    <>
      <Section description="Issued, revoked, or denied in the last window." title="Recent grant decisions">
        <EmptyState hint="Refresh the dashboard to retry." title="Could not load recent grant decisions" />
      </Section>
      <Section description="Connector runs started in the last window." title="Recent runs">
        <EmptyState hint="Refresh the dashboard to retry." title="Could not load recent runs" />
      </Section>
    </>
  );
}

function StatusStrip({
  actionNeeded,
  hasFailures,
  routes,
}: {
  actionNeeded: number;
  hasFailures: boolean;
  routes: Routes;
}) {
  if (!hasFailures) {
    return (
      <div className="pdpp-caption mb-8 flex items-center gap-2">
        <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: "var(--success)" }} />
        <span className="font-medium text-foreground">All clear.</span>
        <span className="text-muted-foreground">No failed traces or runs in the recent window.</span>
      </div>
    );
  }
  return (
    <div className="pdpp-caption mb-8 flex flex-wrap items-center gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-2.5 shadow-[inset_3px_0_0_0_color-mix(in_oklab,var(--destructive)_60%,transparent)]">
      <span className="font-medium text-destructive">
        {actionNeeded} recent failure{actionNeeded === 1 ? "" : "s"}
      </span>
      <span className="text-muted-foreground">needs attention</span>
      <div className="ml-auto flex flex-wrap items-center gap-3">
        <Link className="underline-offset-2 hover:underline" href={`${routes.section.traces}?status=failed`}>
          review traces →
        </Link>
        <Link className="underline-offset-2 hover:underline" href={`${routes.section.runs}?status=failed`}>
          review runs →
        </Link>
      </div>
    </div>
  );
}
