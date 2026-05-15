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
import type { TimelineEnvelope } from "../../lib/ref-client.ts";
import { PageHeader, Section } from "../primitives.tsx";
import { TimelineView } from "../timeline-view.tsx";
import type { Routes } from "./routes.ts";

export type TimelineSubject = "grant" | "trace" | "run";

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

      {pivots.length > 0 ? (
        <div className="mb-6 flex flex-wrap gap-2">
          {pivots.flatMap((p) =>
            p.ids.map((pivotId) => (
              <Link
                className="pdpp-caption inline-flex items-center rounded-md border border-border px-2.5 py-1 hover:bg-muted/60"
                href={pivotHref(p.kind, pivotId)}
                key={`${p.kind}:${pivotId}`}
              >
                {p.kind} <code className="ml-1 font-mono">{pivotId}</code> →
              </Link>
            ))
          )}
        </div>
      ) : null}

      {beforeTimeline}

      <Section title="Timeline">
        <TimelineView events={envelope.events} loadMoreHref={loadMoreHref} />
      </Section>

      <Section title="Reference CLI">
        <pre className="pdpp-caption overflow-x-auto rounded-md border border-border/80 bg-muted/30 p-3 font-mono">
          pnpm exec {cliCommand}
        </pre>
        <p className="pdpp-caption mt-2 text-muted-foreground">
          Run this from a PDPP repo checkout. Owner-gated reference reads require{" "}
          <code className="font-mono">PDPP_OWNER_SESSION_COOKIE</code> when owner auth is enabled. The published{" "}
          <a
            className="underline underline-offset-2 hover:text-foreground"
            href="https://www.npmjs.com/package/@pdpp/cli"
            rel="noreferrer"
            target="_blank"
          >
            @pdpp/cli
          </a>{" "}
          beta currently covers the public connect flow, not these reference-operator commands.
        </p>
        <p className="pdpp-caption mt-1 break-all text-muted-foreground">
          raw: <code>{rawUrl}</code>
        </p>
      </Section>
    </>
  );
}
