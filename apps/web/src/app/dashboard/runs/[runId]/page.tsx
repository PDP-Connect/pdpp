import { Fragment } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { DashboardShell, ServerUnreachable } from '../../components/shell';
import { PageHeader, Section } from '../../components/primitives';
import { ReferenceServerUnreachableError, getAsInternalUrl } from '../../lib/owner-token';
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
          <PageHeader title="Run" />
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
      <PageHeader
        title={<code className="font-mono">{runId}</code>}
        breadcrumbs={[{ label: 'Runs', href: '/dashboard/runs' }, { label: 'Run' }]}
        description={
          <>
            {connectorId ? (
              <>
                connector <span className="text-foreground font-mono">{connectorId}</span>
                {' · '}
              </>
            ) : null}
            {events.length} events
          </>
        }
      />

      {traceIds.length > 0 || grantIds.length > 0 ? (
        <div className="mb-6 flex flex-wrap gap-2">
          {traceIds.map((id) => (
            <Link
              key={id}
              href={`/dashboard/traces/${encodeURIComponent(id)}`}
              className="pdpp-caption border-border hover:bg-muted/60 inline-flex items-center rounded-md border px-2.5 py-1"
            >
              trace <code className="ml-1 font-mono">{id}</code> →
            </Link>
          ))}
          {grantIds.map((id) => (
            <Link
              key={id}
              href={`/dashboard/grants/${encodeURIComponent(id)}`}
              className="pdpp-caption border-border hover:bg-muted/60 inline-flex items-center rounded-md border px-2.5 py-1"
            >
              grant <code className="ml-1 font-mono">{id}</code> →
            </Link>
          ))}
        </div>
      ) : null}

      <div className="mb-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat title="Checkpoints" rows={checkpoints} />
        <Stat title="Progress" rows={progress} />
        <Stat title="Interactions" rows={interactions} />
        <Stat
          title="Failure"
          rows={
            failure
              ? [
                  ['reason', String(failure.data.reason ?? failure.data.failure_reason ?? '—')],
                  ['retryable', String(failure.data.connector_error_retryable ?? '—')],
                ]
              : [['status', 'no failure']]
          }
          emphasis={Boolean(failure)}
        />
      </div>

      <Section title="Timeline">
        <TimelineView events={events} />
      </Section>

      <Section title="CLI equivalent">
        <pre className="pdpp-caption border-border/80 bg-muted/30 overflow-x-auto rounded-md border p-3 font-mono">
          pdpp run timeline {runId}
        </pre>
        <p className="pdpp-caption text-muted-foreground mt-1 break-all">
          raw: <code>{`${getAsInternalUrl()}/_ref/runs/${encodeURIComponent(runId)}/timeline`}</code>
        </p>
      </Section>
    </DashboardShell>
  );
}

function Stat({
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
      className={
        emphasis
          ? 'border-destructive/30 bg-destructive/5 rounded-md border border-l-4 border-l-destructive/60 px-3 py-2.5'
          : 'border-border/70 bg-muted/20 rounded-md border px-3 py-2.5'
      }
    >
      <h3 className="pdpp-eyebrow mb-2">{title}</h3>
      <dl className="pdpp-caption grid grid-cols-[auto_1fr] gap-x-2 gap-y-1">
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
