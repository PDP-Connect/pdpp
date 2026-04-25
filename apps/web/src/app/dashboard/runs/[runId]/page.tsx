import Link from "next/link";
import { notFound } from "next/navigation";
import { Fragment } from "react";
import { Callout, MetaPill, PageHeader, Section, StatusBadge } from "../../components/primitives.tsx";
import { DashboardShell, ServerUnreachable } from "../../components/shell.tsx";
import { TimelineView } from "../../components/timeline-view.tsx";
import { getAsInternalUrl, ReferenceServerUnreachableError } from "../../lib/owner-token.ts";
import { getRunTimeline, type SpineEvent, type TimelineEnvelope } from "../../lib/ref-client.ts";
import {
  classifyKnownGaps,
  extractTerminalKnownGaps,
  formatGapReason,
  formatRecoveryHint,
  type KnownGap,
  type KnownGapSummary,
} from "../../lib/run-gaps.ts";
import { RunInteractionForm } from "./interaction-form.tsx";
import { RunDetailPoller } from "./run-detail-poller.tsx";

export const dynamic = "force-dynamic";

type TerminalRunStatus = "succeeded" | "failed" | "cancelled" | null;
type RunStateTone = "protocol" | "human" | "success" | "danger";

interface LatestProgress {
  count: number | null;
  message: string;
  percentLabel: string | null;
  stream: string | null;
  total: number | null;
}

export default async function RunDetailPage({ params }: { params: Promise<{ runId: string }> }) {
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

  if (!envelope) {
    notFound();
  }

  const events = envelope.events;
  const traceIds = Array.from(new Set(events.map((e) => e.trace_id).filter(Boolean) as string[]));
  const grantIds = Array.from(new Set(events.map((e) => e.grant_id).filter(Boolean) as string[]));
  const connectorId = events.find((e) => e.actor_type === "runtime")?.actor_id ?? null;

  const checkpoints = summarizeCheckpoints(events);
  const progress = summarizeProgress(events);
  const interactions = summarizeInteractions(events);
  const terminalStatus = getTerminalRunStatus(events);
  const active = terminalStatus == null;
  const pendingInteraction = active ? getPendingInteraction(events) : null;
  const latestProgress = getLatestProgress(events);
  const failure = events.find((e) => e.event_type === "run.failed");
  const terminalKnownGaps = extractTerminalKnownGaps(events);
  const gapClassification = classifyKnownGaps(terminalKnownGaps.gaps);
  const stateTone = getRunStateTone({ active, pendingInteraction: Boolean(pendingInteraction), terminalStatus });
  const stateValue = getRunStateValue({ active, pendingInteraction: Boolean(pendingInteraction), terminalStatus });
  const failureRows = summarizeFailure(failure);

  return (
    <DashboardShell active="runs">
      <RunDetailPoller enabled={active} />
      <RunHeader
        connectorId={connectorId}
        eventCount={events.length}
        latestProgress={latestProgress}
        runId={runId}
        stateTone={stateTone}
        stateValue={stateValue}
      />
      <PendingInteractionSection pendingInteraction={pendingInteraction} runId={runId} />
      <LatestProgressSection active={active} latestProgress={latestProgress} terminalStatus={terminalStatus} />
      <RelatedRunLinks grantIds={grantIds} traceIds={traceIds} />
      <StatsGrid
        checkpoints={checkpoints}
        failure={failure}
        failureRows={failureRows}
        interactions={interactions}
        progress={progress}
      />
      <KnownGapsSection
        coverageGaps={gapClassification.coverageGaps}
        protocolViolationCount={gapClassification.protocolViolationGaps.length}
        skippedCount={events.filter((e) => e.event_type === "run.stream_skipped").length}
        summary={terminalKnownGaps.summary ?? gapClassification.summary}
      />
      <ViolationDiagnosis failure={failure} />
      <Section title="Timeline">
        <TimelineView events={events} />
      </Section>
      <Section title="CLI equivalent">
        <pre className="pdpp-caption overflow-x-auto rounded-md border border-border/80 bg-muted/30 p-3 font-mono">
          pdpp run timeline {runId}
        </pre>
        <p className="pdpp-caption mt-1 break-all text-muted-foreground">
          raw: <code>{`${getAsInternalUrl()}/_ref/runs/${encodeURIComponent(runId)}/timeline`}</code>
        </p>
      </Section>
    </DashboardShell>
  );
}

function RunHeader({
  connectorId,
  eventCount,
  latestProgress,
  runId,
  stateTone,
  stateValue,
}: {
  connectorId: string | null;
  eventCount: number;
  latestProgress: LatestProgress | null;
  runId: string;
  stateTone: RunStateTone;
  stateValue: string | null;
}) {
  return (
    <PageHeader
      breadcrumbs={[{ label: "Runs", href: "/dashboard/runs" }, { label: "Run" }]}
      description={
        <>
          {connectorId ? (
            <>
              connector <span className="font-mono text-foreground">{connectorId}</span>
              {" · "}
            </>
          ) : null}
          {eventCount} events
        </>
      }
      meta={
        <>
          <MetaPill label="state" tone={stateTone} value={stateValue} />
          {latestProgress?.percentLabel ? (
            <MetaPill label="progress" tone="protocol" value={latestProgress.percentLabel} />
          ) : null}
        </>
      }
      title={<code className="font-mono">{runId}</code>}
    />
  );
}

function PendingInteractionSection({
  pendingInteraction,
  runId,
}: {
  pendingInteraction: PendingInteraction | null;
  runId: string;
}) {
  if (!pendingInteraction) {
    return null;
  }

  return (
    <Callout
      action={<StatusBadge inline status="pending" />}
      className="mb-6 border border-[color:var(--warning)] border-l-4 bg-[color:var(--warning-wash)]"
      description="This run is alive, but it cannot continue until the requested interaction is satisfied."
      surface="human"
      title="Waiting on operator input"
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
        fields={pendingInteraction.fields}
        interactionId={pendingInteraction.interactionId}
        key={pendingInteraction.interactionId}
        kind={pendingInteraction.kind}
        message={pendingInteraction.message}
        runId={runId}
      />
    </Callout>
  );
}

function LatestProgressSection({
  active,
  latestProgress,
  terminalStatus,
}: {
  active: boolean;
  latestProgress: LatestProgress | null;
  terminalStatus: TerminalRunStatus;
}) {
  if (!latestProgress) {
    return null;
  }

  return (
    <Callout
      action={<StatusBadge inline status={active ? "started" : (terminalStatus ?? "started")} />}
      className="mb-6"
      description="Most connectors only report phases; percent appears only when a connector emits both count and total."
      surface="protocol"
      title="Latest progress"
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
        {latestProgress.count == null ? null : (
          <>
            <dt className="text-muted-foreground">count</dt>
            <dd>{String(latestProgress.count)}</dd>
          </>
        )}
        {latestProgress.total == null ? null : (
          <>
            <dt className="text-muted-foreground">total</dt>
            <dd>{String(latestProgress.total)}</dd>
          </>
        )}
        {latestProgress.percentLabel ? (
          <>
            <dt className="text-muted-foreground">completion</dt>
            <dd>{latestProgress.percentLabel}</dd>
          </>
        ) : null}
      </dl>
    </Callout>
  );
}

function RelatedRunLinks({ grantIds, traceIds }: { grantIds: string[]; traceIds: string[] }) {
  if (traceIds.length === 0 && grantIds.length === 0) {
    return null;
  }

  return (
    <div className="mb-6 flex flex-wrap gap-2">
      {traceIds.map((id) => (
        <Link
          className="pdpp-caption inline-flex items-center rounded-md border border-border px-2.5 py-1 hover:bg-muted/60"
          href={`/dashboard/traces/${encodeURIComponent(id)}`}
          key={id}
        >
          trace <code className="ml-1 font-mono">{id}</code> →
        </Link>
      ))}
      {grantIds.map((id) => (
        <Link
          className="pdpp-caption inline-flex items-center rounded-md border border-border px-2.5 py-1 hover:bg-muted/60"
          href={`/dashboard/grants/${encodeURIComponent(id)}`}
          key={id}
        >
          grant <code className="ml-1 font-mono">{id}</code> →
        </Link>
      ))}
    </div>
  );
}

function StatsGrid({
  checkpoints,
  failure,
  failureRows,
  interactions,
  progress,
}: {
  checkpoints: [string, string][];
  failure: SpineEvent | undefined;
  failureRows: [string, string][];
  interactions: [string, string][];
  progress: [string, string][];
}) {
  return (
    <div className="mb-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <Stat rows={checkpoints} title="Checkpoints" />
      <Stat rows={progress} title="Progress" />
      <Stat rows={interactions} title="Interactions" />
      <Stat emphasis={Boolean(failure)} rows={failureRows} title="Failure" />
    </div>
  );
}

function KnownGapsSection({
  coverageGaps,
  protocolViolationCount,
  skippedCount,
  summary,
}: {
  coverageGaps: KnownGap[];
  protocolViolationCount: number;
  skippedCount: number;
  summary: KnownGapSummary | null;
}) {
  if (coverageGaps.length === 0 && protocolViolationCount === 0 && skippedCount === 0) {
    return null;
  }

  return (
    <section className="mb-8 rounded-md border border-[color:var(--warning)]/35 border-l-4 border-l-[color:var(--warning)] bg-[color:var(--warning-wash)]/45 px-4 py-3">
      <header className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
        <div>
          <h3 className="pdpp-eyebrow">Known source gaps</h3>
          <p className="pdpp-caption text-muted-foreground">
            Partial coverage means flushed records may be useful, but this run did not collect every requested source.
          </p>
        </div>
        {summary?.count ? (
          <span className="pdpp-caption text-muted-foreground">
            {summary.count} gap{summary.count === 1 ? "" : "s"}
            {summary.truncated ? " · truncated" : ""}
          </span>
        ) : null}
      </header>

      {coverageGaps.length > 0 ? (
        <ul className="space-y-2">
          {coverageGaps.map((gap) => (
            <li className="rounded-md border border-border/70 bg-background/70 px-3 py-2" key={knownGapKey(gap)}>
              <div className="pdpp-caption flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="font-medium text-foreground">{formatGapReason(gap.kind)}</span>
                <span className="text-muted-foreground">reason</span>
                <code>{formatGapReason(gap.reason)}</code>
                {gap.stream ? (
                  <>
                    <span className="text-muted-foreground">stream</span>
                    <code>{gap.stream}</code>
                  </>
                ) : null}
              </div>
              <div className="pdpp-caption mt-1 text-muted-foreground">
                recovery: <span className="text-foreground">{formatRecoveryHint(gap)}</span>
                {gap.message ? ` · ${gap.message}` : ""}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="pdpp-caption text-muted-foreground">
          No partial source-coverage gaps were reported. Protocol failures are shown separately below.
        </p>
      )}

      {protocolViolationCount > 0 ? (
        <p className="pdpp-caption mt-3 text-muted-foreground">
          {protocolViolationCount} protocol-violation gap{protocolViolationCount === 1 ? "" : "s"} omitted here; see
          Failure diagnosis.
        </p>
      ) : null}
      {skippedCount > 0 && coverageGaps.length === 0 ? (
        <p className="pdpp-caption mt-3 text-muted-foreground">
          Timeline includes {skippedCount} skipped stream event{skippedCount === 1 ? "" : "s"} without terminal gap
          details.
        </p>
      ) : null}
    </section>
  );
}

function knownGapKey(gap: KnownGap): string {
  return [gap.kind, gap.reason, gap.stream ?? "run", gap.message ?? "", formatRecoveryHint(gap)].join(":");
}

/**
 * Runtime-authored structured diagnosis of a protocol violation.
 * Additive: when run.failed carries a `data.violation`, render a structured
 * panel. When absent, render nothing — the existing opaque Failure stat
 * block already shows the top-level reason unchanged.
 *
 * Vertical slice: today only `progress_for_undeclared_stream` populates
 * the full field set. Other subtypes (see tmp/opaque-violation-diagnosis-memo.md)
 * will render with the common header + last-valid-event block only.
 */
interface ViolationShape {
  expected?: unknown;
  last_valid_event_id?: unknown;
  last_valid_event_type?: unknown;
  message_type?: unknown;
  received?: unknown;
  stream?: unknown;
  subtype: string;
  truncated?: unknown;
}

function extractViolation(failure: SpineEvent | undefined): ViolationShape | null {
  const raw = (failure?.data as { violation?: unknown } | undefined)?.violation;
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const subtype = (raw as { subtype?: unknown }).subtype;
  if (typeof subtype !== "string" || subtype.length === 0) {
    return null;
  }
  return raw as ViolationShape;
}

function violationStringField(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function violationStringListField(v: unknown): string[] | null {
  if (!Array.isArray(v)) {
    return null;
  }
  const items = v.filter((x): x is string => typeof x === "string" && x.length > 0);
  return items.length > 0 ? items : null;
}

function ViolationDiagnosis({ failure }: { failure: SpineEvent | undefined }) {
  const violation = extractViolation(failure);
  if (!violation) {
    return null;
  }
  const messageType = violationStringField(violation.message_type);
  const stream = violationStringField(violation.stream);
  const received = violationStringField(violation.received);
  const expected = violationStringListField(violation.expected);
  const lastValidEventId = violationStringField(violation.last_valid_event_id);
  const lastValidEventType = violationStringField(violation.last_valid_event_type);
  const truncated = violation.truncated === true;

  return (
    <section className="mb-8 rounded-md border border-destructive/30 border-l-4 border-l-destructive/60 bg-destructive/5 px-4 py-3">
      <header className="mb-2 flex items-baseline justify-between gap-4">
        <h3 className="pdpp-eyebrow">Failure diagnosis</h3>
        <span className="pdpp-caption text-muted-foreground">runtime-authored</span>
      </header>
      <dl className="pdpp-caption grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1">
        <dt className="text-muted-foreground">subtype</dt>
        <dd className="break-all font-mono">{violation.subtype}</dd>
        {messageType ? (
          <>
            <dt className="text-muted-foreground">message</dt>
            <dd className="break-all font-mono">{messageType}</dd>
          </>
        ) : null}
        {stream ? (
          <>
            <dt className="text-muted-foreground">stream</dt>
            <dd className="break-all">
              <span className="font-mono">{stream}</span>
              {received && received !== stream ? null : (
                <span className="ml-2 text-muted-foreground">(not in scope)</span>
              )}
            </dd>
          </>
        ) : null}
        {expected ? (
          <>
            <dt className="text-muted-foreground">expected</dt>
            <dd className="break-all font-mono">
              {expected.join(" · ")}
              {truncated ? <span className="ml-2 text-muted-foreground">(truncated)</span> : null}
            </dd>
          </>
        ) : null}
        {lastValidEventId ? (
          <>
            <dt className="text-muted-foreground">after</dt>
            <dd className="break-all">
              {lastValidEventType ? (
                <span className="font-mono">{lastValidEventType}</span>
              ) : (
                <span className="text-muted-foreground">event</span>
              )}
              <a className="ml-2 text-primary underline-offset-2 hover:underline" href={`#${lastValidEventId}`}>
                {lastValidEventId} →
              </a>
            </dd>
          </>
        ) : null}
      </dl>
    </section>
  );
}

function Stat({ title, rows, emphasis }: { title: string; rows: [string, string][]; emphasis?: boolean }) {
  const className = emphasis
    ? "rounded-md border border-destructive/30 border-l-4 border-l-destructive/60 bg-destructive/5 px-3 py-2.5"
    : "rounded-md border border-border/70 bg-muted/20 px-3 py-2.5";

  return (
    <div className={className}>
      <h3 className="pdpp-eyebrow mb-2">{title}</h3>
      <dl className="pdpp-caption grid grid-cols-[auto_1fr] gap-x-2 gap-y-1">
        {rows.map(([k, v]) => (
          <Fragment key={k}>
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="break-all tabular-nums">{v}</dd>
          </Fragment>
        ))}
      </dl>
    </div>
  );
}

function getRunStateTone({
  active,
  pendingInteraction,
  terminalStatus,
}: {
  active: boolean;
  pendingInteraction: boolean;
  terminalStatus: TerminalRunStatus;
}): RunStateTone {
  if (pendingInteraction) {
    return "human";
  }
  if (active) {
    return "protocol";
  }
  return terminalStatus === "failed" ? "danger" : "success";
}

function getRunStateValue({
  active,
  pendingInteraction,
  terminalStatus,
}: {
  active: boolean;
  pendingInteraction: boolean;
  terminalStatus: TerminalRunStatus;
}): string | null {
  if (!active) {
    return terminalStatus;
  }
  return pendingInteraction ? "awaiting input" : "running";
}

function summarizeCheckpoints(events: SpineEvent[]): [string, string][] {
  const staged = events.filter((e) => e.event_type === "run.state_staged").length;
  const advanced = events.filter((e) => e.event_type === "run.state_advanced").length;
  const commitFailed = events.filter((e) => e.event_type === "run.state_commit_failed").length;
  return [
    ["staged", String(staged)],
    ["advanced", String(advanced)],
    ["commit_failed", String(commitFailed)],
  ];
}

function summarizeProgress(events: SpineEvent[]): [string, string][] {
  const progressEvents = events.filter((e) => e.event_type === "run.progress_reported");
  const skipped = events.filter((e) => e.event_type === "run.stream_skipped").length;
  const last = progressEvents.at(-1);
  return [
    ["reports", String(progressEvents.length)],
    ["last_message", String(last?.data?.message ?? "—")],
    ["last_count", String(last?.data?.count ?? "—")],
    ["last_total", String(last?.data?.total ?? "—")],
    ["skipped", String(skipped)],
  ];
}

function summarizeInteractions(events: SpineEvent[]): [string, string][] {
  const required = events.filter((e) => e.event_type === "run.interaction_required").length;
  const completed = events.filter((e) => e.event_type === "run.interaction_completed").length;
  return [
    ["required", String(required)],
    ["completed", String(completed)],
  ];
}

function summarizeFailure(failure: SpineEvent | undefined): [string, string][] {
  if (!failure) {
    return [["status", "no failure"]];
  }
  return [
    ["reason", String(failure.data.reason ?? failure.data.failure_reason ?? "—")],
    ["retryable", String(failure.data.connector_error_retryable ?? "—")],
  ];
}

function getTerminalRunStatus(events: SpineEvent[]): TerminalRunStatus {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event) {
      continue;
    }
    if (event.event_type === "run.failed") {
      const reason = String(event.data?.reason ?? event.data?.failure_reason ?? "").toLowerCase();
      return reason === "cancelled" ? "cancelled" : "failed";
    }
    if (event.event_type === "run.completed") {
      return event.status === "cancelled" ? "cancelled" : "succeeded";
    }
  }
  return null;
}

function getLatestProgress(events: SpineEvent[]): LatestProgress | null {
  const latest = [...events].reverse().find((event) => event.event_type === "run.progress_reported");
  if (!latest) {
    return null;
  }

  const count = typeof latest.data?.count === "number" ? latest.data.count : null;
  const total = typeof latest.data?.total === "number" ? latest.data.total : null;
  const percentLabel =
    count != null && total != null && total > 0
      ? `${Math.max(0, Math.min(100, Math.round((count / total) * 100)))}%`
      : null;

  return {
    message: String(latest.data?.message ?? "—"),
    stream: typeof latest.stream_id === "string" && latest.stream_id ? latest.stream_id : null,
    count,
    total,
    percentLabel,
  };
}

interface InteractionField {
  format: "password" | "text";
  label: string | null;
  name: string;
  required: boolean;
}

interface PendingInteraction {
  fields: InteractionField[];
  interactionId: string;
  kind: string;
  message: string;
  timeoutLabel: string | null;
}

function getPendingInteraction(events: SpineEvent[]): PendingInteraction | null {
  const completed = new Set(
    events
      .filter((event) => event.event_type === "run.interaction_completed")
      .map((event) => event.interaction_id)
      .filter((value): value is string => typeof value === "string" && value.length > 0)
  );

  const pending = [...events]
    .reverse()
    .find(
      (event) =>
        event.event_type === "run.interaction_required" &&
        typeof event.interaction_id === "string" &&
        !completed.has(event.interaction_id)
    );
  if (!pending || typeof pending.interaction_id !== "string") {
    return null;
  }

  const schema = pending.data?.schema;
  const requiredFields = new Set(
    schema &&
      typeof schema === "object" &&
      !Array.isArray(schema) &&
      Array.isArray((schema as { required?: unknown }).required)
      ? ((schema as { required: unknown[] }).required.filter((value) => typeof value === "string") as string[])
      : []
  );
  const properties =
    schema && typeof schema === "object" && !Array.isArray(schema) && "properties" in schema
      ? (schema as { properties?: unknown }).properties
      : null;
  const fields: InteractionField[] =
    properties && typeof properties === "object" && !Array.isArray(properties)
      ? Object.entries(properties as Record<string, unknown>)
          .map(([name, rawDef]): InteractionField => {
            const def = rawDef && typeof rawDef === "object" ? (rawDef as Record<string, unknown>) : {};
            const format = def.format === "password" ? "password" : "text";
            const label = typeof def.title === "string" && def.title ? def.title : null;
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
    typeof pending.data?.timeout_seconds === "number" && pending.data.timeout_seconds > 0
      ? pending.data.timeout_seconds
      : null;

  return {
    interactionId: pending.interaction_id,
    kind: String(pending.data?.kind ?? "interaction"),
    message: String(pending.data?.message ?? "Awaiting operator response."),
    fields,
    timeoutLabel: timeoutSeconds == null ? null : formatTimeout(timeoutSeconds),
  };
}

function formatTimeout(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}
