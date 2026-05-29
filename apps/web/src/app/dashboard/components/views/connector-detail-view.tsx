/**
 * Shared connector-detail view (the page after clicking a connector in
 * the records list). Used by /dashboard/records/[connector] and the
 * sandbox equivalent.
 *
 * `extraActions` lets the live page inject the SyncNowButton; the
 * sandbox page passes nothing so the surface is read-only.
 */

import Link from "next/link";
import type { ReactNode } from "react";
import { buttonVariants } from "@/components/ui/button.tsx";
import { Timestamp } from "@/components/ui/timestamp.tsx";
import { formatConnectorKeyForDisplay, formatConnectorNameForDisplay } from "../../lib/connector-display.ts";
import type { RunSummary } from "../../lib/ref-client.ts";
import type { ConnectorManifest, ConnectorOverview, StreamSummary } from "../../lib/rs-client.ts";
import { DataList, PageHeader, Section, StatusBadge } from "../primitives.tsx";
import type { Routes } from "./routes.ts";

const RUNNING_STATES = new Set(["started", "in_progress"]);

export function ConnectorDetailView({
  manifest,
  streams,
  overview,
  recentRuns,
  routes,
  extraActions,
}: {
  manifest: ConnectorManifest;
  streams: StreamSummary[];
  overview: ConnectorOverview | null;
  recentRuns: RunSummary[];
  routes: Routes;
  extraActions?: ReactNode;
}) {
  const connectorId = manifest.connector_id;
  const totalRecords = streams.reduce((sum, s) => sum + s.record_count, 0);
  const displayName = formatConnectorNameForDisplay({
    connectorId,
    displayName: manifest.display_name,
    name: manifest.name,
  });
  const connectorKey = formatConnectorKeyForDisplay(connectorId);
  const running = overview?.isRunning ?? false;
  return (
    <>
      <PageHeader
        actions={
          <>
            {running && overview?.lastRun ? (
              <Link
                className={buttonVariants({ variant: "outline", size: "sm" })}
                href={routes.run(overview.lastRun.run_id)}
              >
                Active run →
              </Link>
            ) : null}
            <Link
              className={buttonVariants({ variant: "outline", size: "sm" })}
              href={`${routes.section.runs}?connector_id=${encodeURIComponent(connectorId)}`}
            >
              All runs →
            </Link>
            {extraActions}
          </>
        }
        breadcrumbs={[{ label: "Connections", href: routes.section.records }, { label: displayName }]}
        count={`${totalRecords.toLocaleString()} records · ${streams.length} stream${streams.length === 1 ? "" : "s"}`}
        description={
          <>
            <code className="font-mono text-xs">{connectorKey}</code>
            {manifest.provider_id ? (
              <>
                {" · "}
                <span>Provider: {manifest.provider_id}</span>
              </>
            ) : null}
          </>
        }
        title={displayName}
      />

      <Section title={`Streams (${streams.length})`}>
        {streams.length === 0 ? (
          <p className="pdpp-caption text-muted-foreground italic">No records for this connector yet.</p>
        ) : (
          <DataList>
            {streams.map((s) => (
              <li key={s.name}>
                <Link
                  className="flex flex-col gap-1 px-3 py-3 transition-colors hover:bg-muted/40 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
                  href={routes.stream(connectorId, s.name)}
                >
                  <span className="pdpp-body break-all font-medium font-mono">{s.name}</span>
                  <span className="pdpp-caption inline-flex flex-wrap items-baseline gap-x-1 text-muted-foreground tabular-nums">
                    <span>{s.record_count.toLocaleString()} records</span>
                    {s.last_updated ? (
                      <>
                        <span aria-hidden>·</span>
                        <Timestamp value={s.last_updated} />
                      </>
                    ) : null}
                  </span>
                </Link>
              </li>
            ))}
          </DataList>
        )}
      </Section>

      <Section
        description="Each run is an artifact you can inspect. Click through for the full trace."
        title={`Recent runs (${recentRuns.length})`}
      >
        {recentRuns.length === 0 ? (
          <p className="pdpp-caption text-muted-foreground italic">No runs yet for this connector.</p>
        ) : (
          <DataList>
            {recentRuns.map((r) => (
              <li key={r.run_id}>
                <Link
                  className="flex flex-col gap-1 px-3 py-3 transition-colors hover:bg-muted/40 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
                  href={routes.run(r.run_id)}
                >
                  <span className="pdpp-caption flex items-center gap-2">
                    <StatusBadge status={r.status} />
                    <span className="font-mono text-muted-foreground text-xs">{r.run_id}</span>
                  </span>
                  <span className="pdpp-caption inline-flex flex-wrap items-baseline gap-x-1 text-muted-foreground tabular-nums">
                    <Timestamp value={r.first_at} />
                    <span aria-hidden>·</span>
                    <span>{durationLabel(r.first_at, r.last_at)}</span>
                    <span aria-hidden>·</span>
                    <span>
                      {r.event_count.toLocaleString()} event{r.event_count === 1 ? "" : "s"}
                    </span>
                    {r.failure_reason ? (
                      <>
                        <span aria-hidden>·</span>
                        <span className="text-destructive">{r.failure_reason}</span>
                      </>
                    ) : null}
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

// Used by the running flag.
export { RUNNING_STATES };

function durationLabel(firstAt: string, lastAt: string): string {
  const a = Date.parse(firstAt);
  const b = Date.parse(lastAt);
  if (!(Number.isFinite(a) && Number.isFinite(b)) || b < a) {
    return "—";
  }
  const ms = b - a;
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const secs = Math.round(ms / 100) / 10;
  if (secs < 60) {
    return `${secs}s`;
  }
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return `${m}m ${s}s`;
}
