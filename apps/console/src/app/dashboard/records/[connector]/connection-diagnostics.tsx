import { CopyButton } from "@pdpp/operator-ui/components/copy-button";
import { DataList, Section } from "@pdpp/operator-ui/components/primitives";
import Link from "next/link";
import { Timestamp } from "@/components/ui/timestamp.tsx";
import { pdppLocalCollectorDoctorCommand, pdppLocalCollectorRetryDeadLettersCommand } from "@/lib/pdpp-cli-command.ts";
import {
  formatDominantCondition,
  formatForwardDisposition,
  formatProjectionFreshness,
  formatSourceOutboxState,
  summarizeAxisChips,
  summarizeOutboxStallRemediation,
  summarizeSchedule,
} from "../../lib/connection-evidence.ts";
import type {
  DeviceSourceInstance,
  RefConnectionHealthSnapshot,
  RefLocalDeviceProgress,
  RefSchedule,
} from "../../lib/ref-client.ts";

/**
 * Server-rendered diagnostics block for the connector detail page.
 *
 * The honest-by-default rules the row applies for 6.5 (no false zeroes,
 * no false greens, unknown reasons explicit) also apply here. Anything
 * we don't have evidence for renders as "—" / "Unknown" with a tooltip
 * — never as a polished zero.
 */
export interface ConnectionDiagnosticsProps {
  connectionHealth: RefConnectionHealthSnapshot | null;
  /**
   * Stable, non-secret source identity for this connection. Used to scope the
   * local collector `doctor` command shown when the outbox is stalled. May be
   * null for legacy single-instance rows; the command then runs unscoped.
   */
  connectionId: string | null;
  /**
   * Connection-summary local-device progress, including the count-backed
   * `outbox_counts` rollup. Used to show the scale of stuck work in the
   * stalled-outbox remediation. `null` for scheduler-managed connections.
   */
  localDeviceProgress: RefLocalDeviceProgress | null;
  schedule: RefSchedule | null;
  /** Optional load-error message for the schedule fetch. */
  scheduleError: string | null;
  /** Per-connector source instances exposed by `/_ref/device-exporters/source-instances`. */
  sourceInstances: readonly DeviceSourceInstance[];
  /** Optional per-source-instance load failure, surfaced honestly. */
  sourceInstancesError: string | null;
}

export function ConnectionDiagnostics({
  connectionHealth,
  connectionId,
  localDeviceProgress,
  schedule,
  scheduleError,
  sourceInstances,
  sourceInstancesError,
}: ConnectionDiagnosticsProps) {
  return (
    <Section
      description="Evidence the dashboard derives from the reference's connection projection, scheduler, and device-exporter diagnostics. Unknown fields render explicitly, never as zeroes or green."
      title="Diagnostics"
    >
      <details className="group border-border/70 border-y" data-testid="diagnostics-details">
        <summary className="pdpp-body flex cursor-pointer items-center justify-between px-3 py-3 hover:bg-muted/40">
          <span className="font-medium">Projection, schedule, sources</span>
          <span className="pdpp-caption text-muted-foreground group-open:hidden">Expand</span>
          <span className="pdpp-caption hidden text-muted-foreground group-open:inline">Collapse</span>
        </summary>

        <div className="flex flex-col gap-5 px-3 py-4">
          <DiagnosticsBlock title="Projected state">
            <ProjectedStateDiagnostics
              connectionHealth={connectionHealth}
              connectionId={connectionId}
              localDeviceProgress={localDeviceProgress}
              sourceInstances={sourceInstances}
            />
          </DiagnosticsBlock>

          <DiagnosticsBlock title="Schedule & backoff">
            <ScheduleDiagnostics schedule={schedule} scheduleError={scheduleError} />
          </DiagnosticsBlock>

          <DiagnosticsBlock title="Source instances">
            <SourceInstancesDiagnostics sourceInstances={sourceInstances} sourceInstancesError={sourceInstancesError} />
          </DiagnosticsBlock>
        </div>
      </details>
    </Section>
  );
}

/**
 * The bound device/host label(s) for a connection, derived from its source
 * instances. The stalled-outbox remediation tells the owner to "run this on
 * the host that holds the data" — but an owner who did not personally set up
 * the collector cannot act on that without knowing *which* host. We surface the
 * owner-meaningful label (display name, else the local binding) so the command
 * has a named target. Falls back to `[]` when no source instance carries a
 * usable label, so the panel degrades to the generic "the host that holds the
 * data" wording rather than printing an opaque device id.
 */
function boundHostLabels(sourceInstances: readonly DeviceSourceInstance[]): string[] {
  const labels: string[] = [];
  for (const source of sourceInstances) {
    const label = source.display_name ?? source.local_binding_name;
    if (typeof label === "string" && label.length > 0 && !labels.includes(label)) {
      labels.push(label);
    }
  }
  return labels;
}

function ProjectedStateDiagnostics({
  connectionHealth,
  connectionId,
  localDeviceProgress,
  sourceInstances,
}: {
  connectionHealth: RefConnectionHealthSnapshot | null;
  connectionId: string | null;
  localDeviceProgress: RefLocalDeviceProgress | null;
  sourceInstances: readonly DeviceSourceInstance[];
}) {
  if (!connectionHealth) {
    return (
      <p
        className="pdpp-caption text-muted-foreground"
        data-testid="diagnostics-projection-missing"
        title="The reference did not return a connection_health snapshot for this connector."
      >
        Projection evidence unavailable.
      </p>
    );
  }

  const projection = formatProjectionFreshness(connectionHealth);
  // Mirror the records-row gate: the outbox axis only renders for
  // local/device-backed connections (or when it carries a concrete verdict).
  // The diagnostics block already receives the connection's local-device
  // progress, so reuse it as the local-backing signal.
  const axisChips = summarizeAxisChips(connectionHealth.axes, {
    isLocalDeviceBacked: Boolean(localDeviceProgress),
  });
  const outboxRemediation = summarizeOutboxStallRemediation(connectionHealth, localDeviceProgress);
  const forwardDisposition = formatForwardDisposition(connectionHealth.forward_disposition);
  const dominantCondition = formatDominantCondition(connectionHealth);
  const conditionById = new Map((connectionHealth.conditions ?? []).map((condition) => [condition.id, condition]));
  const visibleConditions = (connectionHealth.supporting_condition_ids ?? [])
    .map((id) => conditionById.get(id))
    .filter((condition): condition is NonNullable<typeof condition> => Boolean(condition));

  return (
    <div className="flex flex-col gap-2">
      <p className="pdpp-caption text-muted-foreground">
        Health: <span className="text-foreground">{connectionHealth.state.replace(/_/g, " ")}</span>
        {connectionHealth.reason_code ? (
          <>
            {" · "}
            <span className="text-muted-foreground">{connectionHealth.reason_code}</span>
          </>
        ) : null}
      </p>
      {forwardDisposition ? (
        <p
          className="pdpp-caption text-muted-foreground"
          data-disposition={forwardDisposition.value}
          data-testid="diagnostics-forward-disposition"
          title={forwardDisposition.title}
        >
          Next run:{" "}
          <span className={forwardDispositionTextClass(forwardDisposition.tone)}>{forwardDisposition.label}</span>
          {forwardDisposition.ownerActionNeeded ? (
            <span className="ml-1 text-muted-foreground">(needs you)</span>
          ) : null}
        </p>
      ) : null}
      {dominantCondition ? (
        <p
          className="pdpp-caption text-muted-foreground"
          data-testid="diagnostics-dominant-condition"
          title={dominantCondition.title}
        >
          Dominant condition: <span className="text-foreground">{dominantCondition.label}</span>
        </p>
      ) : null}
      {axisChips.length > 0 ? (
        <ul className="flex flex-wrap items-center gap-1.5" data-testid="diagnostics-axes">
          {axisChips.map((c) => (
            <li
              className={`pdpp-caption inline-flex items-center gap-1 px-2 py-0.5 ${diagnosticsAxisChipClass(c.tone)}`}
              data-axis-tone={c.tone}
              key={c.label}
              title={c.title}
            >
              {c.label}
            </li>
          ))}
        </ul>
      ) : null}
      {projection.unreliable ? (
        <p
          className="pdpp-caption text-muted-foreground"
          data-testid="diagnostics-projection-unreliable"
          title={projection.detail}
        >
          Projection unreliable: {projection.reasons.join(", ")}.
        </p>
      ) : null}
      {outboxRemediation ? (
        <OutboxStallRemediationPanel
          connectionId={connectionId}
          hostLabels={boundHostLabels(sourceInstances)}
          remediation={outboxRemediation}
        />
      ) : null}
      {visibleConditions.length ? (
        <ul className="pdpp-caption flex flex-col gap-1 text-muted-foreground" data-testid="diagnostics-conditions">
          {visibleConditions.map((condition) => (
            <li key={condition.id} title={condition.reason}>
              {condition.type}: <span className="text-foreground">{condition.status}</span>
              {condition.status === "false" ? (
                <>
                  {" · "}
                  {condition.message}
                </>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {connectionHealth.last_success_at ? (
        <p className="pdpp-caption text-muted-foreground">
          Last success at <Timestamp value={connectionHealth.last_success_at} />.
        </p>
      ) : (
        <p className="pdpp-caption text-muted-foreground" data-testid="diagnostics-no-last-success">
          No durable success recorded.
        </p>
      )}
    </div>
  );
}

/**
 * Inline text colour for the forward-disposition word. It is one word in a muted
 * sentence (not a chip), so we tint only the value text by tone and leave the
 * surrounding "Next run:" / "(needs you)" muted. Mirrors the axis-chip tone
 * vocabulary so the disposition reads consistently with the rest of the block.
 */
function forwardDispositionTextClass(tone: "neutral" | "success" | "warning" | "danger"): string {
  if (tone === "success") {
    return "text-emerald-700 dark:text-emerald-300";
  }
  if (tone === "warning") {
    return "text-[color:var(--warning)]";
  }
  if (tone === "danger") {
    return "text-destructive";
  }
  return "text-foreground";
}

function diagnosticsAxisChipClass(tone: "neutral" | "success" | "warning" | "danger"): string {
  if (tone === "success") {
    return "border border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300";
  }
  if (tone === "warning") {
    return "border border-[color:var(--warning)]/40 bg-[color:var(--warning)]/5 text-[color:var(--warning)]";
  }
  if (tone === "danger") {
    return "border border-destructive/40 bg-destructive/5 text-destructive";
  }
  return "border border-muted-foreground/30 bg-muted/40 text-muted-foreground";
}

function ScheduleDiagnostics({
  schedule,
  scheduleError,
}: Pick<ConnectionDiagnosticsProps, "schedule" | "scheduleError">) {
  if (scheduleError) {
    return (
      <p className="pdpp-caption text-muted-foreground" data-testid="diagnostics-schedule-error" title={scheduleError}>
        Schedule unavailable: {scheduleError}
      </p>
    );
  }

  const scheduleSummary = summarizeSchedule(schedule);
  if (!scheduleSummary) {
    return <p className="pdpp-caption text-muted-foreground">No schedule configured.</p>;
  }

  return (
    <ul className="pdpp-caption flex flex-col gap-1 text-muted-foreground">
      <li>
        Mode: <span className="text-foreground">{scheduleSummary.mode}</span>
        {scheduleSummary.enabled ? null : <span className="ml-1">(disabled)</span>}
      </li>
      {scheduleSummary.nextAttemptLabel ? <li>{scheduleSummary.nextAttemptLabel}</li> : null}
      {scheduleSummary.backoffLabel ? (
        <li className="text-[color:var(--warning)]" data-testid="diagnostics-backoff">
          {scheduleSummary.backoffLabel}
        </li>
      ) : null}
      {scheduleSummary.ineligibilityReason ? (
        <li className="text-[color:var(--warning)]" data-testid="diagnostics-ineligibility">
          Ineligible: {scheduleSummary.ineligibilityReason.replace(/[_-]+/g, " ")}
        </li>
      ) : null}
    </ul>
  );
}

function SourceInstancesDiagnostics({
  sourceInstances,
  sourceInstancesError,
}: Pick<ConnectionDiagnosticsProps, "sourceInstances" | "sourceInstancesError">) {
  if (sourceInstancesError) {
    return (
      <p
        className="pdpp-caption text-muted-foreground"
        data-testid="diagnostics-sources-error"
        title={sourceInstancesError}
      >
        Device-exporter diagnostics unavailable: {sourceInstancesError}
      </p>
    );
  }
  if (sourceInstances.length === 0) {
    return <p className="pdpp-caption text-muted-foreground">No source instances bound to this connector.</p>;
  }
  return (
    <DataList ariaLabel="Source instances">
      {sourceInstances.map((source) => (
        <SourceInstanceDiagnostics key={`${source.device_id}:${source.source_instance_id}`} source={source} />
      ))}
    </DataList>
  );
}

function SourceInstanceDiagnostics({ source }: { source: DeviceSourceInstance }) {
  const accepted =
    typeof source.accepted_record_count === "number"
      ? `${source.accepted_record_count.toLocaleString()} accepted`
      : "accepted count unknown";
  const rejected =
    typeof source.rejected_record_count === "number"
      ? `${source.rejected_record_count.toLocaleString()} rejected`
      : null;
  const recordsPending =
    typeof source.records_pending === "number"
      ? `${source.records_pending.toLocaleString()} pending on device`
      : "pending count unknown";

  return (
    <li className="px-3 py-2">
      <div className="flex flex-col gap-0.5">
        <span className="pdpp-caption font-mono text-foreground">
          {source.display_name ?? source.local_binding_name}
        </span>
        <span className="pdpp-caption text-muted-foreground tabular-nums">
          Source {source.source_instance_id}
          {source.connector_instance_id ? ` · connection ${source.connector_instance_id}` : ""}
        </span>
        <span className="pdpp-caption text-muted-foreground tabular-nums">
          {accepted}
          {rejected ? (
            <>
              {" · "}
              <span
                className={
                  source.rejected_record_count && source.rejected_record_count > 0 ? "text-[color:var(--warning)]" : ""
                }
              >
                {rejected}
              </span>
            </>
          ) : null}
          {source.last_ingest_at ? (
            <>
              {" · last ingest "}
              <Timestamp value={source.last_ingest_at} />
            </>
          ) : (
            <>
              {" · "}
              <span data-testid="diagnostics-source-no-ingest">never ingested</span>
            </>
          )}
        </span>
        <span className="pdpp-caption text-muted-foreground tabular-nums">
          Heartbeat: {source.last_heartbeat_status ?? "status unknown"}
          {source.last_heartbeat_at ? (
            <>
              {" · "}
              <Timestamp value={source.last_heartbeat_at} />
            </>
          ) : (
            " · never seen"
          )}
        </span>
        <span className="pdpp-caption text-muted-foreground tabular-nums">{recordsPending}</span>
        <SourceOutboxState source={source} />
        <LocalCollectorGapDiagnostics source={source} />
        {source.last_error ? (
          <span
            className="pdpp-caption text-destructive"
            data-testid="diagnostics-source-error"
            title={JSON.stringify(source.last_error)}
          >
            Last error: {formatSourceLastError(source.last_error)}
          </span>
        ) : null}
        <Link
          className="pdpp-caption text-muted-foreground underline-offset-2 hover:underline"
          href={`/dashboard/device-exporters#${encodeURIComponent(source.device_id)}`}
        >
          {source.device_id}
        </Link>
      </div>
    </li>
  );
}

/**
 * Render a source instance's structured `last_error` as one short operator
 * line. The reference reports `last_error` as a free-form object; we surface
 * the most specific human field we can find (`message`, else `reason`, else
 * `code`/`type`) and cap its length so a stalled collector shows *what* failed
 * inline — not just "Last error reported" with the detail hidden in a title.
 * The full object stays in the `title` for deeper inspection.
 */
function formatSourceLastError(error: Record<string, unknown>): string {
  const pick = (key: string): string | null => {
    const value = error[key];
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  };
  const message = pick("message") ?? pick("reason") ?? pick("error") ?? pick("detail");
  const code = pick("code") ?? pick("type");
  const human = message ?? code ?? "reported (open the device for detail)";
  const withCode = message && code ? `${human} (${code})` : human;
  const MAX = 160;
  return withCode.length > MAX ? `${withCode.slice(0, MAX - 1)}…` : withCode;
}

function LocalCollectorGapDiagnostics({ source }: { source: DeviceSourceInstance }) {
  const gaps = source.local_collector_gaps;
  if (!gaps) {
    return (
      <span className="pdpp-caption text-muted-foreground" data-testid="diagnostics-local-gaps-missing">
        Local gap diagnostics unavailable.
      </span>
    );
  }
  return (
    <span
      className={["pdpp-caption tabular-nums", localCollectorGapToneClass(gaps)].join(" ")}
      data-testid="diagnostics-local-gaps"
      title={gaps.reasons.length > 0 ? `Reasons: ${gaps.reasons.join(", ")}` : undefined}
    >
      {formatLocalCollectorGaps(gaps)}
    </span>
  );
}

function formatLocalCollectorGaps(gaps: NonNullable<DeviceSourceInstance["local_collector_gaps"]>): string {
  if (gaps.unreliable) {
    return "Local gap diagnostics unreliable.";
  }
  if (gaps.pending_count > 0) {
    const reason = gaps.reasons.length > 0 ? ` · ${gaps.reasons.join(", ")}` : "";
    return `${gaps.pending_count.toLocaleString()} local collector gap${
      gaps.pending_count === 1 ? "" : "s"
    } pending${reason}.`;
  }
  return "No local collector gaps pending.";
}

function localCollectorGapToneClass(gaps: NonNullable<DeviceSourceInstance["local_collector_gaps"]>): string {
  if (gaps.unreliable || gaps.pending_count > 0) {
    return "text-[color:var(--warning)]";
  }
  return "text-muted-foreground";
}

function SourceOutboxState({ source }: { source: DeviceSourceInstance }) {
  const outbox = formatSourceOutboxState(source);
  return (
    <span
      className={["pdpp-caption tabular-nums", sourceOutboxToneClass(outbox.tone)].join(" ")}
      data-testid="diagnostics-outbox-state"
      title={outbox.title}
    >
      {outbox.label}
    </span>
  );
}

function sourceOutboxToneClass(tone: ReturnType<typeof formatSourceOutboxState>["tone"]): string {
  switch (tone) {
    case "danger":
      return "text-destructive";
    case "warning":
      return "text-[color:var(--warning)]";
    default:
      return "text-muted-foreground";
  }
}

/**
 * Visible operator remediation for a stalled local-device outbox.
 *
 * The reference projects the stall and an `Inspect the local collector backlog`
 * remediation, but the dashboard cannot drain a device-local outbox remotely —
 * the host that owns the data has to run the local collector. So we surface the
 * reference's own remediation label as readable copy (not hover-only) plus the
 * exact, deterministic commands the operator runs on that host. Each command
 * carries no base URL, token, or filesystem path.
 *
 * Crucially, we surface the *recovery* flow, not just diagnosis. `doctor` only
 * reports the dead-letter rows; the operator then has to know that
 * `retry-dead-letters` is what requeues them. Leaving that as an exercise was
 * the owner-reported gap — "Check the collector host" did not tell the operator
 * which command to run. We render the collector's own documented three steps:
 *
 *   1. diagnose (`doctor`)
 *   2. preview the requeue (`retry-dead-letters`, dry-run by default)
 *   3. apply it (`retry-dead-letters --apply`, which backs up the DB first)
 *
 * One subtlety the earlier copy left implicit and an operator could trip on:
 * `retry-dead-letters --apply` only moves dead-lettered rows back to `pending`.
 * It does not itself ingest them — the next `@pdpp/local-collector run` pass on
 * the host drains the requeued work. The same re-run is the recovery for the
 * other cause of a stalled axis: a `blocked` heartbeat means the runner could
 * not read prior state (`state_get_failed`) and refused to advance, so there may
 * be no dead-letter rows to requeue at all — re-running the collector re-reads
 * state and clears the block. We therefore close with an explicit "run the
 * collector again" note so neither cause leaves the owner at a dead end.
 */
function OutboxStallRemediationPanel({
  connectionId,
  hostLabels,
  remediation,
}: {
  connectionId: string | null;
  /**
   * Owner-meaningful label(s) for the host(s) bound to this connection. Names
   * the remediation target so an owner who did not set up the collector knows
   * which host to run the command on. Empty → generic "the host that holds
   * the data" wording.
   */
  hostLabels: readonly string[];
  remediation: NonNullable<ReturnType<typeof summarizeOutboxStallRemediation>>;
}) {
  const scope = connectionId ? { connectionId } : undefined;
  // The three documented dead-letter requeue steps, in the order the operator
  // runs them, followed by a "run the collector again" note (rendered after the
  // list) that drains the requeued rows and also covers the no-dead-letter
  // blocked-state-read cause. Commands are sourced from the safe CLI builders so
  // none can leak a base URL, token, or device-local filesystem path.
  const steps: { caption: string; command: string; label: string }[] = [
    {
      label: "1. Diagnose",
      caption: "See the dead-letter rows and outbox health.",
      command: pdppLocalCollectorDoctorCommand(scope),
    },
    {
      label: "2. Preview the requeue",
      caption: "Dry run — shows what would be requeued, changes nothing.",
      command: pdppLocalCollectorRetryDeadLettersCommand(scope),
    },
    {
      label: "3. Requeue",
      caption:
        "Moves the dead-letter rows back to pending after backing up the database first. The next collector run drains them — it does not ingest on its own.",
      command: pdppLocalCollectorRetryDeadLettersCommand({ ...scope, apply: true }),
    },
  ];
  // Name the host when we know it; otherwise keep the honest generic phrasing.
  const hostPhrase =
    hostLabels.length === 0
      ? "the host that holds the data"
      : `the host${hostLabels.length === 1 ? "" : "s"} that hold${hostLabels.length === 1 ? "s" : ""} the data (${hostLabels.join(", ")})`;
  return (
    <div
      className="flex flex-col gap-1.5 border border-destructive/40 bg-destructive/5 px-3 py-2"
      data-testid="diagnostics-outbox-remediation"
    >
      <p className="pdpp-caption font-medium text-foreground" data-testid="diagnostics-outbox-remediation-label">
        {remediation.label}
      </p>
      {hostLabels.length > 0 ? (
        <p className="pdpp-caption text-muted-foreground" data-testid="diagnostics-outbox-remediation-host">
          Bound device{hostLabels.length === 1 ? "" : "s"}:{" "}
          <span className="font-medium text-foreground">{hostLabels.join(", ")}</span>
        </p>
      ) : null}
      <p className="pdpp-caption text-muted-foreground" title={remediation.reason ?? undefined}>
        Retryable outbound work on the local collector is not draining. The dashboard cannot clear it remotely — run
        these on {hostPhrase}, in order:
      </p>
      {remediation.scale ? (
        <p
          className="pdpp-caption text-muted-foreground tabular-nums"
          data-testid="diagnostics-outbox-remediation-scale"
        >
          Stuck on the device: {remediation.scale}.
        </p>
      ) : null}
      <ol className="flex flex-col gap-2" data-testid="diagnostics-outbox-remediation-steps">
        {steps.map((step) => (
          <li className="flex flex-col gap-0.5" key={step.label}>
            <span className="pdpp-caption font-medium text-foreground">{step.label}</span>
            <span className="pdpp-caption text-muted-foreground">{step.caption}</span>
            <div className="flex min-w-0 items-center gap-2 border border-border/70 bg-muted/30 px-3 py-2">
              <code
                className="pdpp-caption min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-foreground"
                data-testid="diagnostics-outbox-remediation-command"
              >
                {step.command}
              </code>
              <CopyButton ariaLabel={`Copy command: ${step.label}`} value={step.command} />
            </div>
          </li>
        ))}
      </ol>
      <p className="pdpp-caption text-muted-foreground" data-testid="diagnostics-outbox-remediation-run-note">
        Then run the collector again on {hostPhrase} (the same{" "}
        <code className="font-mono">@pdpp/local-collector run</code> command used to enroll it) so the requeued work
        actually drains. If <code className="font-mono">doctor</code> reports zero dead-letter rows, the stall is a
        blocked state read, not a backlog — re-running the collector re-reads state and clears it on its own.
      </p>
    </div>
  );
}

function DiagnosticsBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="pdpp-eyebrow mb-1.5 text-muted-foreground">{title}</h3>
      {children}
    </div>
  );
}
