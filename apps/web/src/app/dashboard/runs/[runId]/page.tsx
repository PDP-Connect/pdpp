import { Fragment } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { DashboardShell, ServerUnreachable } from '../../components/shell';
import { ReferenceServerUnreachableError, getAsUrl } from '../../lib/owner-token';
import { getRunTimeline, type SpineEvent, type TimelineEnvelope } from '../../lib/ref-client';
import { TimelineView } from '../../components/timeline-view';

export const dynamic = 'force-dynamic';

export default async function RunDetailPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId: raw } = await params;
  const runId = decodeURIComponent(raw);

  let envelope: TimelineEnvelope | null;
  try {
    envelope = await getRunTimeline(runId);
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <DashboardShell active="runs">
          <ServerUnreachable />
        </DashboardShell>
      );
    }
    throw err;
  }

  if (!envelope) notFound();

  const events = envelope.events;
  const traceIds = Array.from(new Set(events.map((e) => e.trace_id).filter(Boolean) as string[]));
  const grantIds = Array.from(new Set(events.map((e) => e.grant_id).filter(Boolean) as string[]));
  const connectorId = events.find((e) => e.actor_type === 'runtime')?.actor_id ?? null;

  const checkpoints = summarizeCheckpoints(events);
  const progress = summarizeProgress(events);
  const interactions = summarizeInteractions(events);
  const failure = events.find((e) => e.event_type === 'run.failed');

  return (
    <DashboardShell active="runs">
      <nav className="text-muted-foreground mb-3 text-xs">
        <Link href="/dashboard/runs" className="hover:text-foreground">
          runs
        </Link>
        <span className="mx-1">/</span>
        <span className="text-foreground">run</span>
      </nav>
      <header className="mb-4">
        <h1 className="text-lg font-semibold break-all">run {runId}</h1>
        <div className="text-muted-foreground mt-1 text-xs">
          {connectorId ? `${connectorId} · ` : ''}
          {events.length} events
        </div>
      </header>

      {(traceIds.length > 0 || grantIds.length > 0) && (
        <section className="mb-4 flex flex-wrap gap-2 text-xs">
          {traceIds.map((id) => (
            <Link
              key={id}
              href={`/dashboard/traces/${encodeURIComponent(id)}`}
              className="border-border hover:bg-muted/50 rounded border px-2 py-1"
            >
              trace {id} →
            </Link>
          ))}
          {grantIds.map((id) => (
            <Link
              key={id}
              href={`/dashboard/grants/${encodeURIComponent(id)}`}
              className="border-border hover:bg-muted/50 rounded border px-2 py-1"
            >
              grant {id} →
            </Link>
          ))}
        </section>
      )}

      <section className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Panel title="checkpoints" rows={checkpoints} />
        <Panel title="progress" rows={progress} />
        <Panel title="interactions" rows={interactions} />
        <Panel
          title="failure"
          rows={
            failure
              ? [
                  ['reason', String(failure.data.reason ?? failure.data.failure_reason ?? '—')],
                  ['retryable', String(failure.data.connector_error_retryable ?? '—')],
                ]
              : [['—', 'no failure']]
          }
          emphasis={Boolean(failure)}
        />
      </section>

      <TimelineView events={events} />

      <section className="mt-6">
        <h2 className="text-muted-foreground mb-2 text-xs uppercase tracking-wide">
          CLI equivalent
        </h2>
        <pre className="bg-muted overflow-x-auto rounded p-3 text-[11px]">
          pdpp run timeline {runId}
        </pre>
        <p className="text-muted-foreground mt-1 text-[11px] break-all">
          raw: <code>{`${getAsUrl()}/_ref/runs/${encodeURIComponent(runId)}/timeline`}</code>
        </p>
      </section>
    </DashboardShell>
  );
}

function Panel({
  title,
  rows,
  emphasis,
}: {
  title: string;
  rows: Array<[string, string]>;
  emphasis?: boolean;
}) {
  return (
    <div
      className={`border-border rounded border px-3 py-2 ${
        emphasis ? 'border-destructive/40 bg-destructive/5' : ''
      }`}
    >
      <h3 className="text-muted-foreground mb-2 text-[10px] uppercase tracking-wide">{title}</h3>
      <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-[11px]">
        {rows.map(([k, v], i) => (
          <Fragment key={i}>
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="break-all tabular-nums">{v}</dd>
          </Fragment>
        ))}
      </dl>
    </div>
  );
}

function summarizeCheckpoints(events: SpineEvent[]): Array<[string, string]> {
  const staged = events.filter((e) => e.event_type === 'run.state_staged').length;
  const advanced = events.filter((e) => e.event_type === 'run.state_advanced').length;
  const commitFailed = events.filter((e) => e.event_type === 'run.state_commit_failed').length;
  return [
    ['staged', String(staged)],
    ['advanced', String(advanced)],
    ['commit_failed', String(commitFailed)],
  ];
}

function summarizeProgress(events: SpineEvent[]): Array<[string, string]> {
  const progressEvents = events.filter((e) => e.event_type === 'run.progress_reported');
  const skipped = events.filter((e) => e.event_type === 'run.stream_skipped').length;
  const last = progressEvents[progressEvents.length - 1];
  return [
    ['reports', String(progressEvents.length)],
    ['last_count', String(last?.data?.count ?? '—')],
    ['last_total', String(last?.data?.total ?? '—')],
    ['skipped', String(skipped)],
  ];
}

function summarizeInteractions(events: SpineEvent[]): Array<[string, string]> {
  const required = events.filter((e) => e.event_type === 'run.interaction_required').length;
  const completed = events.filter((e) => e.event_type === 'run.interaction_completed').length;
  return [
    ['required', String(required)],
    ['completed', String(completed)],
  ];
}
