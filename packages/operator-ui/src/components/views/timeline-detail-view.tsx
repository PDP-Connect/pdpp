// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared detail-with-timeline view used by:
 *   - /grants/[grantId] and /sandbox/grants/[grantId]
 *   - /audit/[traceId] and /sandbox/traces/[traceId]
 *
 * This is the structural body for "show one envelope, surface pivot
 * links to the related artifacts, embed the spine timeline, show the
 * CLI equivalent and raw URL". The page is responsible for fetching
 * the envelope and choosing the section/route, not for layout.
 */

import Link from "next/link";
import { pdppCliNoInstallCommand } from "../../lib/cli-command.ts";
import type { TimelineEnvelope } from "../../lib/ref-client.ts";
import { PageHeader, Section } from "../primitives.tsx";
import { TimelineView } from "../timeline-view.tsx";
import { buildExplorerHref } from "./records-explorer-view.tsx";
import type { Routes } from "./routes.ts";

export type TimelineSubject = "grant" | "trace" | "run";

/**
 * Derives a yyyy-mm-dd date window from the first and last event's occurred_at.
 * Returns null when no events are present or timestamps are missing.
 */
function exploreWindowFromEnvelope(envelope: TimelineEnvelope): { since: string; until: string } | null {
  const timestamps = envelope.events.map((e) => e.occurred_at).filter((t): t is string => Boolean(t));
  if (timestamps.length === 0) {
    return null;
  }
  const sorted = timestamps.slice().sort();
  const [firstTimestamp] = sorted;
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

/**
 * Derives the connection ids scoped to this timeline's events.
 *
 * `event.source.id` is the connector TYPE (e.g. "github"), not a connection
 * instance — the real per-connection identity on a run/grant/trace timeline
 * event lives in `event.data.connector_instance_id` (see the run lifecycle
 * fixtures in `reference-implementation/test/spine-run-summary-status.test.js`),
 * with `event.data.connection_id` as an equivalent alias some emitters use
 * instead. Returns `[]` (no connection scoping) when neither is present —
 * e.g. grant/trace timelines whose events legitimately span connections.
 */
export function connectionIdsFromEnvelope(envelope: TimelineEnvelope): string[] {
  const ids = new Set<string>();
  for (const event of envelope.events) {
    const connectorInstanceId = event.data.connector_instance_id;
    const connectionId = event.data.connection_id;
    if (typeof connectorInstanceId === "string" && connectorInstanceId.length > 0) {
      ids.add(connectorInstanceId);
    } else if (typeof connectionId === "string" && connectionId.length > 0) {
      ids.add(connectionId);
    }
  }
  return Array.from(ids);
}

/** Derives the stream names carried on this timeline's per-record events. */
export function streamsFromEnvelope(envelope: TimelineEnvelope): string[] {
  return Array.from(new Set(envelope.events.flatMap((e) => (e.stream_id ? [e.stream_id] : []))));
}

export function exploreHrefFromEnvelope(routes: Routes, envelope: TimelineEnvelope): string | null {
  const exploreWindow = exploreWindowFromEnvelope(envelope);
  const connectionIds = connectionIdsFromEnvelope(envelope);
  const streams = streamsFromEnvelope(envelope);
  // Stream ids further narrow the Explore query when present, but the safe
  // scoped link only requires connection identity plus the derived time window.
  if (!(exploreWindow && connectionIds.length > 0)) {
    return null;
  }
  return buildExplorerHref(routes, {
    since: exploreWindow.since,
    until: exploreWindow.until,
    connectionIds,
    streams: streams.length > 0 ? streams : undefined,
  });
}

interface PivotKind {
  ids: string[];
  kind: TimelineSubject;
}

function pivotsForSubject(envelope: TimelineEnvelope, subject: TimelineSubject): PivotKind[] {
  const collect = (key: "trace_id" | "grant_id" | "run_id"): string[] =>
    Array.from(new Set(envelope.events.flatMap((e) => (e[key] ? [e[key] as string] : []))));
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
  // Slot-named props (`…Content` suffix) so the Fast-Refresh/perf linter
  // recognises them as legitimate JSX-bearing slots rather than accidental
  // inline-JSX props.
  beforeTimelineContent,
  metaContent,
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
  beforeTimelineContent?: React.ReactNode;
  metaContent?: React.ReactNode;
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
        meta={metaContent}
        title={<code className="font-mono">{id}</code>}
      />

      {(() => {
        const exploreHref = exploreHrefFromEnvelope(routes, envelope);
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

      {beforeTimelineContent}

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
