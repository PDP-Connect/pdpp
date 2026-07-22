// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { Callout, MetaPill, StatusBadge } from "@pdpp/operator-ui/components/primitives";
import { dashboardRoutes } from "@pdpp/operator-ui/components/views/routes";
import { TimelineDetailView } from "@pdpp/operator-ui/components/views/timeline-detail-view";
import { notFound } from "next/navigation";
import { Fragment } from "react";
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { ServerUnreachable } from "../../components/shell.tsx";
import { getAsInternalUrl, ReferenceServerUnreachableError } from "../../lib/owner-token.ts";
import {
  getRunStatus,
  getRunTimeline,
  type RunStatusEnvelope,
  type SpineEvent,
  type TimelineEnvelope,
} from "../../lib/ref-client.ts";
import {
  type CurrentRunAssistance,
  getCurrentRunAssistance,
  hasAvailableBrowserSurfaceAttachment,
  requiresBrowserSurfaceAssistance,
} from "../../lib/run-assistance.ts";
import {
  classifyKnownGaps,
  extractTerminalKnownGaps,
  formatGapReason,
  formatRecoveryHint,
  type KnownGap,
  type KnownGapSummary,
} from "../../lib/run-gaps.ts";
import { CancelRunControl } from "./cancel-run-control.tsx";
import { RunInteractionForm } from "./interaction-form.tsx";
import { RunDetailPoller } from "./run-detail-poller.tsx";
import {
  isRunActive,
  isRunHandleActive,
  mapRunHandleStatusToDisplay,
  resolveDisplayTerminalStatus,
  type TerminalRunStatus,
} from "./run-terminal-status.ts";

export const dynamic = "force-dynamic";

type RunStateTone = "protocol" | "human" | "success" | "danger";

interface LatestProgress {
  count: number | null;
  message: string;
  percentLabel: string | null;
  stream: string | null;
  total: number | null;
}

type TimelineSearchParams = Promise<{ cursor?: string | string[] }>;

function getCursor(searchParams: { cursor?: string | string[] }): string | null {
  return typeof searchParams.cursor === "string" && searchParams.cursor.length > 0 ? searchParams.cursor : null;
}

function runTimelineHref(runId: string, cursor: string): string {
  return `/syncs/${encodeURIComponent(runId)}?${new URLSearchParams({ cursor }).toString()}`;
}

export default async function RunDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ runId: string }>;
  searchParams: TimelineSearchParams;
}) {
  const { runId: raw } = await params;
  const runId = decodeURIComponent(raw);
  const cursor = getCursor(await searchParams);

  let envelope: TimelineEnvelope | null;
  let runStatus: RunStatusEnvelope | null;
  try {
    [envelope, runStatus] = await Promise.all([getRunTimeline(runId, { cursor }), getRunStatus(runId)]);
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <RecordroomShellWithPalette>
          <ServerUnreachable />
        </RecordroomShellWithPalette>
      );
    }
    throw err;
  }

  if (!envelope) {
    notFound();
  }

  const events = envelope.events;
  const connectorId = events.find((e) => e.actor_type === "runtime")?.actor_id ?? null;

  const checkpoints = summarizeCheckpoints(events);
  const progress = summarizeProgress(events);
  const interactions = summarizeInteractions(events);
  // Authoritative liveness comes from the window-independent envelope
  // `terminal_status`, NOT from scanning a single page of events. The
  // terminal event is emitted last, so for a run longer than the page the
  // page-only scan never sees it and would treat the run as active forever
  // (wrong badge, never-disabled poller, wrongly-rendered Cancel control).
  const envelopeTerminal = envelope.terminal_status ?? null;
  const active = runStatus ? isRunHandleActive(runStatus.status) : isRunActive(envelopeTerminal);
  // In-page scan retained ONLY for the detail nuances it can read off the
  // event object (failed-vs-cancelled reason, succeeded-with-gaps). It is
  // never the source of the active/terminal decision and may be null when
  // the terminal event is not on this page.
  const inPageTerminalStatus = getTerminalRunStatus(events);
  const currentAssistance = active ? getCurrentRunAssistance(events) : null;
  const latestProgress = getLatestProgress(events);
  const failure = events.find((e) => e.event_type === "run.failed");
  const terminalKnownGaps = extractTerminalKnownGaps(events);
  const gapClassification = classifyKnownGaps(terminalKnownGaps.gaps);
  // The displayed terminal class is anchored to the envelope. Where the
  // terminal event IS on this page, prefer the in-page scan's more-specific
  // reading (it distinguishes owner-cancelled crashes via the failure
  // reason and succeeded-with-gaps); otherwise fall back to the envelope's
  // raw class mapped to the page's display type.
  const displayTerminalStatus =
    resolveDisplayTerminalStatus({
      coverageGapCount: gapClassification.coverageGaps.length,
      envelopeTerminal,
      inPageTerminalStatus,
    }) ?? mapRunHandleStatusToDisplay(runStatus?.status ?? null);
  const stateTone = getRunStateTone({ active, currentAssistance, terminalStatus: displayTerminalStatus });
  const stateValue = getRunStateValue({ active, currentAssistance, terminalStatus: displayTerminalStatus });
  const failureRows = summarizeFailure(failure, runStatus);

  // The before-timeline stack, header meta pills, and description are assigned
  // to locals and passed to TimelineDetailView's slot-named props
  // (beforeTimelineContent / metaContent) so this once-per-request server render
  // composes them in the component body rather than constructing JSX inline in
  // the prop position.
  const beforeTimeline = (
    <>
      <CurrentAssistanceSection active={active} currentAssistance={currentAssistance} runId={runId} />
      {active ? <CancelRunControl runId={runId} /> : null}
      <LatestProgressSection active={active} latestProgress={latestProgress} terminalStatus={displayTerminalStatus} />
      <StatsGrid
        checkpoints={checkpoints}
        failure={failure}
        failureRows={failureRows}
        interactions={interactions}
        progress={progress}
      />
      <KnownGapsSection
        coverageGaps={gapClassification.coverageGaps}
        informationalGaps={gapClassification.informationalGaps}
        protocolViolationCount={gapClassification.protocolViolationGaps.length}
        skippedCount={events.filter((e) => e.event_type === "run.stream_skipped").length}
        summary={terminalKnownGaps.summary ?? gapClassification.summary}
      />
      <ViolationDiagnosis failure={failure} />
      <ConnectorStderrTailSection failure={failure} />
    </>
  );
  const description = (
    <>
      {connectorId ? (
        <>
          connector <span className="font-mono text-foreground">{connectorId}</span>
          {" · "}
        </>
      ) : null}
      {events.length} events
    </>
  );
  const meta = (
    <>
      <MetaPill label="state" tone={stateTone} value={stateValue} />
      {latestProgress?.percentLabel ? (
        <MetaPill label="progress" tone="protocol" value={latestProgress.percentLabel} />
      ) : null}
    </>
  );

  return (
    <RecordroomShellWithPalette>
      <RunDetailPoller enabled={active} />
      <TimelineDetailView
        beforeTimelineContent={beforeTimeline}
        breadcrumbs={[{ label: "Syncs", href: dashboardRoutes.section.runs }, { label: "Sync" }]}
        cliCommand={`pdpp ref run timeline ${runId}`}
        description={description}
        envelope={envelope}
        id={runId}
        loadMoreHref={envelope.truncated && envelope.next_cursor ? runTimelineHref(runId, envelope.next_cursor) : null}
        metaContent={meta}
        rawUrl={`${getAsInternalUrl()}/_ref/runs/${encodeURIComponent(runId)}/timeline`}
        routes={dashboardRoutes}
        subject="run"
      />
    </RecordroomShellWithPalette>
  );
}

function CurrentAssistanceSection({
  active,
  currentAssistance,
  runId,
}: {
  active: boolean;
  currentAssistance: CurrentRunAssistance | null;
  runId: string;
}) {
  if (!currentAssistance) {
    return null;
  }
  const supportsStreaming =
    active &&
    requiresBrowserSurfaceAssistance(currentAssistance) &&
    hasAvailableBrowserSurfaceAttachment(currentAssistance);
  const supportsSubmit =
    active &&
    currentAssistance.progressPosture === "blocked" &&
    currentAssistance.responseContract === "response_required" &&
    (currentAssistance.ownerAction === "provide_value" ||
      (currentAssistance.ownerAction === "operate_attachment" &&
        (!requiresBrowserSurfaceAssistance(currentAssistance) || supportsStreaming)));

  return (
    <Callout
      action={<StatusBadge inline status={active ? "pending" : "cancelled"} />}
      className="mb-6 border border-[color:var(--warning)] bg-[color:var(--warning-wash)] shadow-[inset_3px_0_0_0_var(--warning)]"
      description={getAssistanceDescription(currentAssistance, active, supportsStreaming)}
      surface="human"
      title={getAssistanceTitle(currentAssistance, active)}
    >
      {supportsStreaming ? (
        <p className="pdpp-caption mb-2">
          <a className="underline underline-offset-2" href={`/syncs/${encodeURIComponent(runId)}/stream`}>
            Open the streaming companion →
          </a>{" "}
          to satisfy this step from your current device.
        </p>
      ) : null}
      <dl className="pdpp-caption grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="text-muted-foreground">message</dt>
        <dd>{currentAssistance.message}</dd>
        <dt className="text-muted-foreground">state</dt>
        <dd>
          {currentAssistance.progressPosture} · {currentAssistance.ownerAction} · {currentAssistance.responseContract}
        </dd>
        <dt className="text-muted-foreground">kind</dt>
        <dd>{currentAssistance.kind}</dd>
        {currentAssistance.attachments.length > 0 ? (
          <>
            <dt className="text-muted-foreground">attachments</dt>
            <dd>{formatAssistanceAttachments(currentAssistance)}</dd>
          </>
        ) : null}
        {currentAssistance.timeoutLabel ? (
          <>
            <dt className="text-muted-foreground">timeout</dt>
            <dd>{currentAssistance.timeoutLabel}</dd>
          </>
        ) : null}
      </dl>
      {supportsSubmit ? (
        <RunInteractionForm
          fields={currentAssistance.fields}
          interactionId={currentAssistance.id}
          key={currentAssistance.id}
          kind={currentAssistance.kind}
          message={currentAssistance.message}
          runId={runId}
        />
      ) : null}
    </Callout>
  );
}

function getAssistanceTitle(assistance: CurrentRunAssistance, active: boolean): string {
  if (!active) {
    return "Assistance abandoned";
  }
  if (
    assistance.progressPosture === "running" &&
    assistance.ownerAction === "act_elsewhere" &&
    assistance.responseContract === "none"
  ) {
    return "Waiting for external approval";
  }
  if (
    assistance.progressPosture === "waiting_retry" &&
    assistance.ownerAction === "none" &&
    assistance.responseContract === "none"
  ) {
    return "Waiting before retry";
  }
  return "Waiting on operator input";
}

function getAssistanceDescription(
  assistance: CurrentRunAssistance,
  active: boolean,
  supportsStreaming: boolean
): string {
  if (!active) {
    return "This assistance request was still open when the run ended.";
  }
  if (
    assistance.progressPosture === "running" &&
    assistance.ownerAction === "act_elsewhere" &&
    assistance.responseContract === "none"
  ) {
    return "The connector is still running and watching for completion. No dashboard response is required.";
  }
  if (
    assistance.progressPosture === "waiting_retry" &&
    assistance.ownerAction === "none" &&
    assistance.responseContract === "none"
  ) {
    return "The connector is waiting before retrying. No owner action is required right now.";
  }
  if (supportsStreaming) {
    return "This run is blocked until the requested browser-surface action is completed.";
  }
  if (requiresBrowserSurfaceAssistance(assistance)) {
    return "This run is waiting for a browser surface or stream target to register before browser control can open.";
  }
  return "This run is blocked until the requested response is submitted.";
}

function formatAssistanceAttachments(assistance: CurrentRunAssistance): string {
  return assistance.attachments
    .map((attachment) => {
      if (attachment.kind !== "browser_surface") {
        return attachment.kind;
      }
      if (hasAvailableBrowserSurfaceAttachment(assistance)) {
        return "browser_surface available";
      }
      return "browser_surface waiting for stream target";
    })
    .join(", ");
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
  informationalGaps,
  protocolViolationCount,
  skippedCount,
  summary,
}: {
  coverageGaps: KnownGap[];
  informationalGaps: KnownGap[];
  protocolViolationCount: number;
  skippedCount: number;
  summary: KnownGapSummary | null;
}) {
  if (
    coverageGaps.length === 0 &&
    informationalGaps.length === 0 &&
    protocolViolationCount === 0 &&
    skippedCount === 0
  ) {
    return null;
  }

  return (
    <section className="mb-8 rounded-md border border-[color:var(--warning)]/35 bg-[color:var(--warning-wash)]/45 px-4 py-3 shadow-[inset_3px_0_0_0_var(--warning)]">
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
              <GapDiagnosticsPanel diagnostics={gap.diagnostics} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="pdpp-caption text-muted-foreground">
          No partial source-coverage gaps were reported. Protocol failures are shown separately below.
        </p>
      )}

      {informationalGaps.length > 0 ? (
        <div className="mt-3">
          <p className="pdpp-caption mb-2 text-muted-foreground">
            Informational limitations reported by the connector:
          </p>
          <ul className="space-y-2">
            {informationalGaps.map((gap) => (
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
                  {gap.message ? gap.message : "This limitation does not mean selected data was lost."}
                </div>
                <GapDiagnosticsPanel diagnostics={gap.diagnostics} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}

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

/**
 * Bounded connector-authored diagnostics from SKIP_RESULT.diagnostics.
 * Rendered collapsed by default — owner-only evidence, labeled as connector-authored,
 * never as the authoritative runtime failure classification.
 * See openspec/changes/propagate-skip-result-diagnostics.
 */
function GapDiagnosticsPanel({ diagnostics }: { diagnostics?: Record<string, unknown> | null }) {
  if (!diagnostics || typeof diagnostics !== "object" || Array.isArray(diagnostics)) {
    return null;
  }
  const isSentinel = diagnostics.truncated === true && typeof diagnostics.reason === "string";
  return (
    <details className="mt-2">
      <summary className="pdpp-caption cursor-pointer text-muted-foreground hover:text-foreground">
        connector diagnostics
        {isSentinel ? (
          <span className="ml-2 text-muted-foreground/70">(truncated · {String(diagnostics.reason)})</span>
        ) : null}
      </summary>
      <p className="pdpp-caption mt-1.5 text-muted-foreground/80">
        Connector-authored evidence. Bounded and redacted by the runtime, not a verified PDPP error classification.
      </p>
      <pre className="pdpp-caption mt-1.5 overflow-x-auto rounded border border-border/70 bg-background p-2 font-mono">
        {JSON.stringify(diagnostics, null, 2)}
      </pre>
    </details>
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
    <section className="mb-8 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 shadow-[inset_3px_0_0_0_color-mix(in_oklab,var(--destructive)_60%,transparent)]">
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

/**
 * Connector-authored stderr tail diagnostic.
 *
 * Owner-only evidence rendered as a collapsed `<details>` panel by
 * default. The text is connector-authored (not runtime-verified) and
 * therefore must be visibly labelled as such — the runtime-authored
 * `failure_message` already surfaces in the Failure stat.
 *
 * See openspec/changes/persist-connector-failure-diagnostics.
 */
interface StderrTailDiagnostic {
  bytes_captured: number;
  bytes_observed: number;
  encoding?: string;
  object?: string;
  redacted: boolean;
  text: string;
  truncated: boolean;
}

function extractStderrTail(failure: SpineEvent | undefined): StderrTailDiagnostic | null {
  const diagnostics = (failure?.data as { connector_diagnostics?: unknown } | undefined)?.connector_diagnostics;
  if (!diagnostics || typeof diagnostics !== "object") {
    return null;
  }
  const raw = (diagnostics as { stderr_tail?: unknown }).stderr_tail;
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const candidate = raw as Record<string, unknown>;
  const text = typeof candidate.text === "string" ? candidate.text : null;
  if (text === null) {
    return null;
  }
  return {
    text,
    bytes_observed: typeof candidate.bytes_observed === "number" ? candidate.bytes_observed : text.length,
    bytes_captured: typeof candidate.bytes_captured === "number" ? candidate.bytes_captured : text.length,
    truncated: candidate.truncated === true,
    redacted: candidate.redacted === true,
    encoding: typeof candidate.encoding === "string" ? candidate.encoding : undefined,
    object: typeof candidate.object === "string" ? candidate.object : undefined,
  };
}

function ConnectorStderrTailSection({ failure }: { failure: SpineEvent | undefined }) {
  const tail = extractStderrTail(failure);
  if (!tail) {
    return null;
  }
  const metaPills: { label: string; value: string }[] = [
    { label: "bytes captured", value: tail.bytes_captured.toLocaleString() },
    { label: "bytes observed", value: tail.bytes_observed.toLocaleString() },
  ];
  if (tail.truncated) {
    metaPills.push({ label: "truncated", value: "yes" });
  }
  if (tail.redacted) {
    metaPills.push({ label: "redacted", value: "yes" });
  }
  // <summary> may contain only phrasing content per the HTML spec, so the
  // descriptive paragraph, meta list, and stderr <pre> live in the
  // details body. The summary keeps an inline title plus compact
  // metadata, and the body re-states the untrusted-evidence label so it
  // is visible whenever the panel is expanded.
  return (
    <section className="mb-8 rounded-md border border-border/70 bg-muted/20 px-4 py-3">
      <details>
        <summary className="cursor-pointer list-none">
          <span className="pdpp-eyebrow mr-3">Connector stderr (diagnostic)</span>
          <span className="pdpp-caption text-muted-foreground">
            {metaPills.map((pill, index) => (
              <span key={pill.label}>
                {index > 0 ? <span aria-hidden="true"> · </span> : null}
                <span>{pill.label}: </span>
                <span className="text-foreground tabular-nums">{pill.value}</span>
              </span>
            ))}
            <span aria-hidden="true"> · </span>
            <span>click to expand</span>
          </span>
        </summary>
        <p className="pdpp-caption mt-3 text-muted-foreground">
          Connector-authored output captured before exit. This is untrusted evidence, not a verified PDPP error. Use it
          as a hint for what the connector was doing, not as the authoritative failure reason.
        </p>
        <dl className="pdpp-caption mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          {metaPills.map((pill) => (
            <Fragment key={pill.label}>
              <dt className="text-muted-foreground">{pill.label}</dt>
              <dd className="tabular-nums">{pill.value}</dd>
            </Fragment>
          ))}
        </dl>
        <pre className="pdpp-caption mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border/60 bg-background/70 p-3 font-mono text-foreground/90">
          {tail.text}
        </pre>
        {tail.truncated ? (
          <p className="pdpp-caption mt-2 text-muted-foreground">
            Showing the last {tail.bytes_captured.toLocaleString()} bytes of {tail.bytes_observed.toLocaleString()}{" "}
            bytes the connector wrote.
          </p>
        ) : null}
      </details>
    </section>
  );
}

function Stat({ title, rows, emphasis }: { title: string; rows: [string, string][]; emphasis?: boolean }) {
  const className = emphasis
    ? "rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2.5 shadow-[inset_3px_0_0_0_color-mix(in_oklab,var(--destructive)_60%,transparent)]"
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
  currentAssistance,
  terminalStatus,
}: {
  active: boolean;
  currentAssistance: CurrentRunAssistance | null;
  terminalStatus: TerminalRunStatus;
}): RunStateTone {
  if (currentAssistance?.progressPosture === "blocked") {
    return "human";
  }
  if (active) {
    return "protocol";
  }
  if (terminalStatus === "succeeded_with_gaps") {
    return "human";
  }
  if (terminalStatus === "deferred") {
    return "protocol";
  }
  return terminalStatus === "failed" ? "danger" : "success";
}

function getRunStateValue({
  active,
  currentAssistance,
  terminalStatus,
}: {
  active: boolean;
  currentAssistance: CurrentRunAssistance | null;
  terminalStatus: TerminalRunStatus;
}): string | null {
  if (!active) {
    return terminalStatus;
  }
  if (!currentAssistance) {
    return "running";
  }
  if (currentAssistance.progressPosture === "blocked") {
    return "awaiting input";
  }
  if (currentAssistance.progressPosture === "waiting_retry") {
    return "waiting retry";
  }
  return "running";
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
  const progressEvents = events.filter((e) => e.event_type === "run.progress_reported" && isUserFacingProgressEvent(e));
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

function summarizeFailure(failure: SpineEvent | undefined, runStatus: RunStatusEnvelope | null): [string, string][] {
  if (!failure) {
    if (runStatus?.status === "deferred") {
      return [
        ["status", "browser deferred"],
        ["reason", runStatus.terminal_reason ?? "browser slot unavailable"],
      ];
    }
    if (runStatus?.failure) {
      return [
        ["reason", runStatus.failure.reason ?? runStatus.terminal_reason ?? "—"],
        ["origin", runStatus.failure.origin ?? "—"],
        ...(runStatus.failure.message ? [["message", runStatus.failure.message] as [string, string]] : []),
        ...(runStatus.failure.connector_error_message
          ? [["connector", runStatus.failure.connector_error_message] as [string, string]]
          : []),
      ];
    }
    return [["status", "no failure"]];
  }
  const failureOrigin = typeof failure.data.failure_origin === "string" ? failure.data.failure_origin : null;
  const failureMessage = typeof failure.data.failure_message === "string" ? failure.data.failure_message : null;
  return [
    ["reason", String(failure.data.reason ?? failure.data.failure_reason ?? "—")],
    ["retryable", String(failure.data.connector_error_retryable ?? "—")],
    ...(failureOrigin ? [["origin", failureOrigin] as [string, string]] : []),
    ...(failureMessage ? [["message", failureMessage] as [string, string]] : []),
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
  const latest = [...events]
    .reverse()
    .find((event) => event.event_type === "run.progress_reported" && isUserFacingProgressEvent(event));
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

function isUserFacingProgressEvent(event: SpineEvent): boolean {
  const message = typeof event.data?.message === "string" ? event.data.message : "";
  return !(
    message.startsWith("tracing enabled;") ||
    message.startsWith("trace written to ") ||
    message.startsWith("failed to write trace:")
  );
}
