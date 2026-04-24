import { Fragment } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { DashboardShell, ServerUnreachable } from '../../components/shell';
import { Callout, MetaPill, PageHeader, Section, StatusBadge } from '../../components/primitives';
import { ReferenceServerUnreachableError, getAsInternalUrl } from '../../lib/owner-token';
import { getRunTimeline, type SpineEvent, type TimelineEnvelope } from '../../lib/ref-client';
import { TimelineView } from '../../components/timeline-view';
import { RunDetailPoller } from './run-detail-poller';
import { RunInteractionForm } from './interaction-form';

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
  const terminalStatus = getTerminalRunStatus(events);
  const active = terminalStatus == null;
  const pendingInteraction = getPendingInteraction(events);
  const latestProgress = getLatestProgress(events);
  const failure = events.find((e) => e.event_type === 'run.failed');

  return (
    <DashboardShell active="runs">
      <RunDetailPoller enabled={active} />
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
        meta={
          <>
            <MetaPill
              label="state"
              value={active ? (pendingInteraction ? 'awaiting input' : 'running') : terminalStatus}
              tone={pendingInteraction ? 'human' : active ? 'protocol' : terminalStatus === 'failed' ? 'danger' : 'success'}
            />
            {latestProgress?.count != null && latestProgress?.total != null && latestProgress.total > 0 ? (
              <MetaPill
                label="progress"
                value={`${Math.max(0, Math.min(100, Math.round((latestProgress.count / latestProgress.total) * 100)))}%`}
                tone="protocol"
              />
            ) : null}
          </>
        }
      />

      {pendingInteraction ? (
        <Callout
          title="Waiting for your input"
          description="This run is alive, but it cannot continue until the requested interaction is satisfied."
          surface="human"
          className="mb-6"
          action={<StatusBadge status="pending" inline />}
        >
          <dl className="pdpp-caption grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-muted-foreground">kind</dt>
            <dd>{pendingInteraction.kind}</dd>
            {pendingInteraction.timeoutLabel ? (
              <>
                <dt className="text-muted-foreground">timeout</dt>
                <dd>{pendingInteraction.timeoutLabel}</dd>
              </>
            ) : null}
          </dl>
          <RunInteractionForm
            runId={runId}
            interactionId={pendingInteraction.interactionId}
            kind={pendingInteraction.kind}
            message={pendingInteraction.message}
            fields={pendingInteraction.fields}
          />
        </Callout>
      ) : null}

      {latestProgress ? (
        <Callout
          title="Latest progress"
          description="Most connectors only report phases; percent appears only when a connector emits both count and total."
          surface="protocol"
          className="mb-6"
          action={<StatusBadge status={active ? 'started' : terminalStatus ?? 'started'} inline />}
        >
          <dl className="pdpp-caption grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-muted-foreground">message</dt>
            <dd>{latestProgress.message}</dd>
            {latestProgress.stream ? (
              <>
                <dt className="text-muted-foreground">stream</dt>
                <dd>{latestProgress.stream}</dd>
              </>
            ) : null}
            {latestProgress.count != null ? (
              <>
                <dt className="text-muted-foreground">count</dt>
                <dd>{String(latestProgress.count)}</dd>
              </>
            ) : null}
            {latestProgress.total != null ? (
              <>
                <dt className="text-muted-foreground">total</dt>
                <dd>{String(latestProgress.total)}</dd>
              </>
            ) : null}
            {latestProgress.percentLabel ? (
              <>
                <dt className="text-muted-foreground">completion</dt>
                <dd>{latestProgress.percentLabel}</dd>
              </>
            ) : null}
          </dl>
        </Callout>
      ) : null}

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
    ['last_message', String(last?.data?.message ?? '—')],
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

function getTerminalRunStatus(events: SpineEvent[]): 'succeeded' | 'failed' | 'cancelled' | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.event_type === 'run.failed') {
      const reason = String(event.data?.reason ?? event.data?.failure_reason ?? '').toLowerCase();
      return reason === 'cancelled' ? 'cancelled' : 'failed';
    }
    if (event.event_type === 'run.completed') {
      return event.status === 'cancelled' ? 'cancelled' : 'succeeded';
    }
  }
  return null;
}

function getLatestProgress(events: SpineEvent[]): {
  message: string;
  stream: string | null;
  count: number | null;
  total: number | null;
  percentLabel: string | null;
} | null {
  const latest = [...events].reverse().find((event) => event.event_type === 'run.progress_reported');
  if (!latest) return null;

  const count = typeof latest.data?.count === 'number' ? latest.data.count : null;
  const total = typeof latest.data?.total === 'number' ? latest.data.total : null;
  const percentLabel =
    count != null && total != null && total > 0
      ? `${Math.max(0, Math.min(100, Math.round((count / total) * 100)))}%`
      : null;

  return {
    message: String(latest.data?.message ?? '—'),
    stream: typeof latest.stream_id === 'string' && latest.stream_id ? latest.stream_id : null,
    count,
    total,
    percentLabel,
  };
}

type InteractionField = {
  name: string;
  label: string | null;
  format: 'password' | 'text';
  required: boolean;
};

type PendingInteraction = {
  interactionId: string;
  kind: string;
  message: string;
  fields: InteractionField[];
  timeoutLabel: string | null;
};

function getPendingInteraction(events: SpineEvent[]): PendingInteraction | null {
  const completed = new Set(
    events
      .filter((event) => event.event_type === 'run.interaction_completed')
      .map((event) => event.interaction_id)
      .filter((value): value is string => typeof value === 'string' && value.length > 0),
  );

  const pending = [...events].reverse().find(
    (event) =>
      event.event_type === 'run.interaction_required' &&
      typeof event.interaction_id === 'string' &&
      !completed.has(event.interaction_id),
  );
  if (!pending || typeof pending.interaction_id !== 'string') return null;

  const schema = pending.data?.schema;
  const requiredFields = new Set(
    schema && typeof schema === 'object' && !Array.isArray(schema) && Array.isArray((schema as { required?: unknown }).required)
      ? ((schema as { required: unknown[] }).required.filter((value) => typeof value === 'string') as string[])
      : [],
  );
  const properties =
    schema && typeof schema === 'object' && !Array.isArray(schema) && 'properties' in schema
      ? (schema as { properties?: unknown }).properties
      : null;
  const fields: InteractionField[] =
    properties && typeof properties === 'object' && !Array.isArray(properties)
      ? Object.entries(properties as Record<string, unknown>)
          .map(([name, rawDef]): InteractionField => {
            const def = rawDef && typeof rawDef === 'object' ? (rawDef as Record<string, unknown>) : {};
            const format = def.format === 'password' ? 'password' : 'text';
            const label = typeof def.title === 'string' && def.title ? def.title : null;
            return {
              name,
              label,
              format,
              required: requiredFields.has(name),
            };
          })
          .sort((left, right) => left.name.localeCompare(right.name))
      : [];
  const timeoutSeconds =
    typeof pending.data?.timeout_seconds === 'number' && pending.data.timeout_seconds > 0
      ? pending.data.timeout_seconds
      : null;

  return {
    interactionId: pending.interaction_id,
    kind: String(pending.data?.kind ?? 'interaction'),
    message: String(pending.data?.message ?? 'Awaiting operator response.'),
    fields,
    timeoutLabel: timeoutSeconds == null ? null : formatTimeout(timeoutSeconds),
  };
}

function formatTimeout(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}
