import Link from "next/link";
import { notFound } from "next/navigation";
import { buttonVariants } from "@/components/ui/button.tsx";
import { Timestamp } from "@/components/ui/timestamp.tsx";
import { DataList, PageHeader, Section, StatusBadge } from "../../components/primitives.tsx";
import { DashboardShell, ServerUnreachable } from "../../components/shell.tsx";
import { ReferenceServerUnreachableError } from "../../lib/owner-token.ts";
import { listRuns, type RunSummary } from "../../lib/ref-client.ts";
import {
  type ConnectorManifest,
  type ConnectorOverview,
  getConnectorOverview,
  listConnectorManifests,
  listStreams,
  type StreamSummary,
} from "../../lib/rs-client.ts";
import { SyncNowButton } from "./sync-now-button.tsx";

export const dynamic = "force-dynamic";

const RECENT_RUNS_LIMIT = 10;

export default async function ConnectorPage({ params }: { params: Promise<{ connector: string }> }) {
  const { connector } = await params;
  const connectorId = decodeURIComponent(connector);

  let manifest: ConnectorManifest | undefined;
  let streams: StreamSummary[];
  let overview: ConnectorOverview | null = null;
  let recentRuns: RunSummary[] = [];
  try {
    const manifests = await listConnectorManifests();
    manifest = manifests.find((m) => m.connector_id === connectorId);
    if (!manifest) {
      notFound();
    }
    streams = await listStreams(connectorId);
    overview = await getConnectorOverview(manifest);
    const runsResp = await listRuns({ connector_id: connectorId, limit: RECENT_RUNS_LIMIT });
    recentRuns = runsResp.data ?? [];
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <DashboardShell active="records">
          <PageHeader title="Records" />
          <ServerUnreachable />
        </DashboardShell>
      );
    }
    throw err;
  }

  const totalRecords = streams.reduce((sum, s) => sum + s.record_count, 0);
  const displayName = manifest.display_name ?? manifest.name ?? connectorId;
  const running = overview?.isRunning ?? false;

  return (
    <DashboardShell active="records">
      <PageHeader
        title={displayName}
        description={
          <>
            <code className="font-mono text-xs">{connectorId}</code>
            {manifest.provider_id ? (
              <>
                {" · "}
                <span>Provider: {manifest.provider_id}</span>
              </>
            ) : null}
          </>
        }
        breadcrumbs={[{ label: "Records", href: "/dashboard/records" }, { label: displayName }]}
        count={`${totalRecords.toLocaleString()} records · ${streams.length} stream${streams.length === 1 ? "" : "s"}`}
        actions={
          <>
            <Link
              href={`/dashboard/runs?connector_id=${encodeURIComponent(connectorId)}`}
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              All runs →
            </Link>
            <SyncNowButton connectorId={connectorId} displayName={displayName} initialRunning={running} />
          </>
        }
      />

      <Section title={`Streams (${streams.length})`}>
        {streams.length === 0 ? (
          <p className="pdpp-caption text-muted-foreground italic">
            No records for this connector yet. Click Sync now to pull your first data.
          </p>
        ) : (
          <DataList>
            {streams.map((s) => (
              <li key={s.name}>
                <Link
                  href={`/dashboard/records/${encodeURIComponent(connectorId)}/${encodeURIComponent(s.name)}`}
                  className="flex flex-col gap-1 px-3 py-3 transition-colors hover:bg-muted/40 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
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
        title={`Recent runs (${recentRuns.length})`}
        description="Each run is an artifact you can inspect. Click through for the full trace."
      >
        {recentRuns.length === 0 ? (
          <p className="pdpp-caption text-muted-foreground italic">No runs yet for this connector.</p>
        ) : (
          <DataList>
            {recentRuns.map((r) => (
              <li key={r.run_id}>
                <Link
                  href={`/dashboard/runs/${encodeURIComponent(r.run_id)}`}
                  className="flex flex-col gap-1 px-3 py-3 transition-colors hover:bg-muted/40 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
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
    </DashboardShell>
  );
}

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
