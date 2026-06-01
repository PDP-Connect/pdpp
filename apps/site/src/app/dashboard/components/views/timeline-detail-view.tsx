/**
 * Shared detail-with-timeline view used by:
 *   - /dashboard/grants/[grantId] and /sandbox/grants/[grantId]
 *   - /dashboard/traces/[traceId] and /sandbox/traces/[traceId]
 *
 * This is the structural body for "show one envelope, surface pivot
 * links to the related artifacts, embed the spine timeline, show the
 * CLI equivalent and raw URL". The page is responsible for fetching
 * the envelope and choosing the section/route, not for layout.
 */

import Link from "next/link";
import { pdppCliNoInstallCommand } from "@/lib/pdpp-cli-command.ts";
import type { TimelineEnvelope } from "../../lib/ref-client.ts";
import { PageHeader, Section } from "../primitives.tsx";
import { TimelineView } from "../timeline-view.tsx";
import { buildExplorerHref } from "./records-explorer-view.tsx";
import type { Routes } from "./routes.ts";

export type TimelineSubject = "grant" | "trace" | "run";

/**
 * Derives a yyyy-mm-dd date window from the first and last event's occurred_at.
 * Returns null when no events are present or timestamps are missing.
 * Gap: does not carry connection identity — Explore will show all records in
 * the window across all connections. A future slice can thread connection_id
 * once the timeline envelope exposes it.
 */
function exploreWindowFromEnvelope(envelope: TimelineEnvelope): { since: string; until: string } | null {
  const timestamps = envelope.events.map((e) => e.occurred_at).filter((t): t is string => Boolean(t));
  if (timestamps.length === 0) {
    return null;
  }
  const sorted = timestamps.slice().sort();
  const firstTimestamp = sorted[0];
  const lastTimestamp = sorted.at(-1);
  if (!(firstTimestamp && lastTimestamp)) {
    return null;
  }
  const since = firstTimestamp.slice(0, 10);
  const lastDay = lastTimestamp.slice(0, 10);
  // until is exclusive-end in the explorer; advance by one day so records from
  // the final event's date are included in the window.
  const untilMs = new Date(lastDay).getTime() + 24 * 60 * 60 * 1000;
  const until = new Date(untilMs).toISOString().slice(0, 10);
  return { since, until };
}

interface PivotKind {
  ids: string[];
  kind: TimelineSubject;
}

function pivotsForSubject(envelope: TimelineEnvelope, subject: TimelineSubject): PivotKind[] {
  const collect = (key: "trace_id" | "grant_id" | "run_id"): string[] =>
    Array.from(new Set(envelope.events.map((e) => e[key]).filter(Boolean) as string[]));
  const all: PivotKind[] = [
    { kind: "trace", ids: collect("trace_id") },
    { kind: "grant", ids: collect("grant_id") },
    { kind: "run", ids: collect("run_id") },
  ];
  return all.filter((p) => p.kind !== subject && p.ids.length > 0);
}

export function TimelineDetailView({
  subject,
  id,
  envelope,
  routes,
  cliCommand,
  rawUrl,
  loadMoreHref,
  count,
  description,
  breadcrumbs,
  beforeTimeline,
  meta,
}: {
  subject: TimelineSubject;
  id: string;
  envelope: TimelineEnvelope;
  routes: Routes;
  cliCommand: string;
  rawUrl: string;
  loadMoreHref?: string | null;
  count?: string;
  description?: React.ReactNode;
  breadcrumbs: { label: string; href?: string }[];
  beforeTimeline?: React.ReactNode;
  meta?: React.ReactNode;
}) {
  const pivots = pivotsForSubject(envelope, subject);
  const pivotHref = (kind: TimelineSubject, pivotId: string) => {
    if (kind === "grant") {
      return routes.grant(pivotId);
    }
    if (kind === "run") {
      return routes.run(pivotId);
    }
    return routes.trace(pivotId);
  };

  return (
    <>
      <PageHeader
        breadcrumbs={breadcrumbs}
        count={count}
        description={description}
        meta={meta}
        title={<code className="font-mono">{id}</code>}
      />

      {(() => {
        const exploreWindow = exploreWindowFromEnvelope(envelope);
        const exploreHref = exploreWindow
          ? buildExplorerHref(routes, { since: exploreWindow.since, until: exploreWindow.until })
          : null;
        const hasPivots = pivots.length > 0;
        if (!(hasPivots || exploreHref)) {
          return null;
        }
        return (
          <div className="mb-6 flex flex-wrap gap-2">
            {hasPivots
              ? pivots.flatMap((p) =>
                  p.ids.map((pivotId) => (
                    <Link
                      className="pdpp-caption inline-flex items-center rounded-md border border-border px-2.5 py-1 hover:bg-muted/60"
                      href={pivotHref(p.kind, pivotId)}
                      key={`${p.kind}:${pivotId}`}
                    >
                      {p.kind} <code className="ml-1 font-mono">{pivotId}</code> →
                    </Link>
                  ))
                )
              : null}
            {exploreHref ? (
              <Link
                className="pdpp-caption inline-flex items-center rounded-md border border-border px-2.5 py-1 hover:bg-muted/60"
                href={exploreHref}
              >
                View records in Explore →
              </Link>
            ) : null}
          </div>
        );
      })()}

      {beforeTimeline}

      <Section title="Timeline">
        <TimelineView events={envelope.events} loadMoreHref={loadMoreHref} />
      </Section>

      <Section title="Reference CLI">
        <pre className="pdpp-caption overflow-x-auto rounded-md border border-border/80 bg-muted/30 p-3 font-mono">
          {cliCommand}
        </pre>
        {(() => {
          const noInstall = pdppCliNoInstallCommand(cliCommand);
          return noInstall ? (
            <pre
              className="pdpp-caption mt-2 overflow-x-auto rounded-md border border-border/80 bg-muted/20 p-3 font-mono"
              data-testid="cli-no-install-command"
            >
              {noInstall}
            </pre>
          ) : null;
        })()}
        <p className="pdpp-caption mt-2 text-muted-foreground">
          The top form requires{" "}
          <a
            className="underline underline-offset-2 hover:text-foreground"
            href="https://www.npmjs.com/package/@pdpp/cli"
            rel="noreferrer"
            target="_blank"
          >
            @pdpp/cli
          </a>{" "}
          on PATH (or <code className="font-mono">pnpm exec</code> in this monorepo). The bottom form runs without an
          install via <code className="font-mono">npx</code>. Set{" "}
          <code className="font-mono">PDPP_OWNER_SESSION_COOKIE</code> when owner auth is enabled.
        </p>
        <p className="pdpp-caption mt-1 break-all text-muted-foreground">
          raw: <code>{rawUrl}</code>
        </p>
      </Section>
    </>
  );
}
