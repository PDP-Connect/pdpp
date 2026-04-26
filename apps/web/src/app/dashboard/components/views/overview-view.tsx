/**
 * Shared dashboard overview view. Used by /dashboard and /sandbox.
 *
 * The page calls its data source for the summary, failed traces/runs,
 * grant decisions, and recent runs, then passes them in. The view
 * renders the hero, status strip, and four sections.
 */

import Link from "next/link";
import { Timestamp } from "@/components/ui/timestamp.tsx";
import type { DatasetSummary, GrantSummary, RunSummary, TraceSummary } from "../../lib/ref-client.ts";
import { OverviewHero } from "../overview-hero.tsx";
import { DataList, PageHeader, Section, StatusBadge } from "../primitives.tsx";
import { EmptyState } from "../shell.tsx";
import type { Routes } from "./routes.ts";

export interface OverviewViewData {
  actionNeeded: number;
  failedRuns: RunSummary[];
  failedTraces: TraceSummary[];
  recentDecisions: GrantSummary[];
  recentRuns: RunSummary[];
  summary: DatasetSummary;
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
  const hasFailures = data.actionNeeded > 0;
  return (
    <>
      <PageHeader description={description} title="Overview" />
      <OverviewHero summary={data.summary} />
      <StatusStrip actionNeeded={data.actionNeeded} hasFailures={hasFailures} routes={routes} />
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
          {data.failedTraces.length === 0 ? (
            <EmptyState hint="Nothing has failed in the recent window." title="No failed traces" />
          ) : (
            <DataList>
              {data.failedTraces.map((t) => (
                <li key={t.trace_id}>
                  <Link
                    className="block px-3 py-2.5 transition-colors hover:bg-muted/40"
                    href={routes.peek(routes.section.traces, t.trace_id)}
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <code className="pdpp-caption break-all font-medium font-mono text-foreground">{t.trace_id}</code>
                      <span className="pdpp-caption text-muted-foreground">
                        <Timestamp value={t.last_at} />
                      </span>
                    </div>
                    <div className="pdpp-caption mt-1 flex flex-wrap items-center gap-2">
                      <StatusBadge status={t.status} />
                      <span className="text-muted-foreground">
                        {t.failure?.reason ?? t.kinds.slice(0, 3).join(", ")}
                      </span>
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
        >
          {data.failedRuns.length === 0 ? (
            <EmptyState hint="Nothing has failed in the recent window." title="No failed runs" />
          ) : (
            <DataList>
              {data.failedRuns.map((r) => (
                <li key={r.run_id}>
                  <Link
                    className="block px-3 py-2.5 transition-colors hover:bg-muted/40"
                    href={routes.peek(routes.section.runs, r.run_id)}
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <code className="pdpp-caption break-all font-medium font-mono text-foreground">{r.run_id}</code>
                      <span className="pdpp-caption text-muted-foreground">
                        <Timestamp value={r.last_at} />
                      </span>
                    </div>
                    <div className="pdpp-caption mt-1 flex flex-wrap items-center gap-2">
                      <StatusBadge status={r.status} />
                      <span className="text-muted-foreground">{r.failure_reason ?? r.connector_id ?? "—"}</span>
                    </div>
                  </Link>
                </li>
              ))}
            </DataList>
          )}
        </Section>
      </div>

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
            {data.recentDecisions.map((g) => {
              let providerSuffix = "";
              if (g.connector_id) {
                providerSuffix = ` · ${g.connector_id}`;
              } else if (g.provider_id) {
                providerSuffix = ` · ${g.provider_id}`;
              }
              return (
                <li key={g.grant_id}>
                  <Link
                    className="pdpp-caption grid gap-1 px-3 py-2.5 transition-colors hover:bg-muted/40 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_9rem]"
                    href={routes.peek(routes.section.grants, g.grant_id)}
                  >
                    <code className="break-all font-medium font-mono text-foreground">{g.grant_id}</code>
                    <span className="min-w-0 truncate text-muted-foreground">
                      client {g.client_id ?? "—"}
                      {providerSuffix}
                    </span>
                    <span className="pdpp-caption flex items-center gap-2 justify-self-end">
                      <StatusBadge status={g.status} />
                      <span className="text-muted-foreground">
                        <Timestamp value={g.last_at} />
                      </span>
                    </span>
                  </Link>
                </li>
              );
            })}
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
      >
        {data.recentRuns.length === 0 ? (
          <EmptyState title="No recent runs" />
        ) : (
          <DataList>
            {data.recentRuns.map((r) => (
              <li key={r.run_id}>
                <Link
                  className="pdpp-caption grid gap-1 px-3 py-2.5 transition-colors hover:bg-muted/40 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_9rem]"
                  href={routes.peek(routes.section.runs, r.run_id)}
                >
                  <code className="break-all font-medium font-mono text-foreground">{r.run_id}</code>
                  <span className="min-w-0 truncate text-muted-foreground">
                    {r.connector_id ?? r.provider_id ?? "—"}
                    {r.failure_reason ? ` · ${r.failure_reason}` : ""}
                  </span>
                  <span className="pdpp-caption flex items-center gap-2 justify-self-end">
                    <StatusBadge status={r.status} />
                    <span className="text-muted-foreground">
                      <Timestamp value={r.last_at} />
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </DataList>
        )}
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
    <div className="pdpp-caption mb-8 flex flex-wrap items-center gap-3 rounded-md border border-destructive/30 border-l-4 border-l-destructive/60 bg-destructive/5 px-4 py-2.5">
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
