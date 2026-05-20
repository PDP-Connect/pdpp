import Link from "next/link";
import { Timestamp } from "@/components/ui/timestamp.tsx";
import { DataList, Section } from "../../components/primitives.tsx";
import {
  formatProjectionFreshness,
  summarizeAxisChips,
  summarizeOutboxForRow,
  summarizeSchedule,
} from "../../lib/connection-evidence.ts";
import type { DeviceSourceInstance, RefConnectionHealthSnapshot, RefSchedule } from "../../lib/ref-client.ts";

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
  schedule,
  scheduleError,
  sourceInstances,
  sourceInstancesError,
}: ConnectionDiagnosticsProps) {
  const projection = formatProjectionFreshness(connectionHealth);
  const axisChips = summarizeAxisChips(connectionHealth?.axes);
  const outbox = summarizeOutboxForRow(connectionHealth);
  const scheduleSummary = summarizeSchedule(schedule);

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
            {connectionHealth ? (
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
                {axisChips.length > 0 ? (
                  <ul className="flex flex-wrap items-center gap-1.5" data-testid="diagnostics-axes">
                    {axisChips.map((c) => (
                      <li
                        className="pdpp-caption inline-flex items-center gap-1 border border-muted-foreground/30 bg-muted/30 px-2 py-0.5 text-muted-foreground"
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
                {outbox ? (
                  <p className="pdpp-caption text-muted-foreground" data-testid="diagnostics-outbox">
                    {outbox.label}
                  </p>
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
            ) : (
              <p
                className="pdpp-caption text-muted-foreground"
                data-testid="diagnostics-projection-missing"
                title="The reference did not return a connection_health snapshot for this connector."
              >
                Projection evidence unavailable.
              </p>
            )}
          </DiagnosticsBlock>

          <DiagnosticsBlock title="Schedule & backoff">
            {scheduleError ? (
              <p
                className="pdpp-caption text-muted-foreground"
                data-testid="diagnostics-schedule-error"
                title={scheduleError}
              >
                Schedule unavailable: {scheduleError}
              </p>
            ) : scheduleSummary ? (
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
            ) : (
              <p className="pdpp-caption text-muted-foreground">No schedule configured.</p>
            )}
          </DiagnosticsBlock>

          <DiagnosticsBlock title="Source instances">
            {sourceInstancesError ? (
              <p
                className="pdpp-caption text-muted-foreground"
                data-testid="diagnostics-sources-error"
                title={sourceInstancesError}
              >
                Device-exporter diagnostics unavailable: {sourceInstancesError}
              </p>
            ) : sourceInstances.length === 0 ? (
              <p className="pdpp-caption text-muted-foreground">No source instances bound to this connector.</p>
            ) : (
              <DataList ariaLabel="Source instances">
                {sourceInstances.map((s) => (
                  <li className="px-3 py-2" key={`${s.device_id}:${s.source_instance_id}`}>
                    <div className="flex flex-col gap-0.5">
                      <span className="pdpp-caption font-mono text-foreground">
                        {s.display_name ?? s.local_binding_name}
                      </span>
                      <span className="pdpp-caption text-muted-foreground tabular-nums">
                        Source {s.source_instance_id}
                        {s.connector_instance_id ? ` · connection ${s.connector_instance_id}` : ""}
                      </span>
                      <span className="pdpp-caption text-muted-foreground tabular-nums">
                        {typeof s.accepted_record_count === "number"
                          ? `${s.accepted_record_count.toLocaleString()} accepted`
                          : "accepted count unknown"}
                        {typeof s.rejected_record_count === "number" ? (
                          <>
                            {" · "}
                            <span className={s.rejected_record_count > 0 ? "text-[color:var(--warning)]" : ""}>
                              {s.rejected_record_count.toLocaleString()} rejected
                            </span>
                          </>
                        ) : null}
                        {s.last_ingest_at ? (
                          <>
                            {" · last ingest "}
                            <Timestamp value={s.last_ingest_at} />
                          </>
                        ) : (
                          <>
                            {" · "}
                            <span data-testid="diagnostics-source-no-ingest">never ingested</span>
                          </>
                        )}
                      </span>
                      <span className="pdpp-caption text-muted-foreground tabular-nums">
                        Heartbeat: {s.last_heartbeat_status ?? "status unknown"}
                        {s.last_heartbeat_at ? (
                          <>
                            {" · "}
                            <Timestamp value={s.last_heartbeat_at} />
                          </>
                        ) : (
                          " · never seen"
                        )}
                      </span>
                      <span className="pdpp-caption text-muted-foreground tabular-nums">
                        {typeof s.records_pending === "number"
                          ? `${s.records_pending.toLocaleString()} pending on device`
                          : "pending count unknown"}
                      </span>
                      {s.local_collector_gaps ? (
                        <span
                          className={[
                            "pdpp-caption tabular-nums",
                            s.local_collector_gaps.unreliable || s.local_collector_gaps.pending_count > 0
                              ? "text-[color:var(--warning)]"
                              : "text-muted-foreground",
                          ].join(" ")}
                          data-testid="diagnostics-local-gaps"
                          title={
                            s.local_collector_gaps.reasons.length > 0
                              ? `Reasons: ${s.local_collector_gaps.reasons.join(", ")}`
                              : undefined
                          }
                        >
                          {formatLocalCollectorGaps(s.local_collector_gaps)}
                        </span>
                      ) : (
                        <span className="pdpp-caption text-muted-foreground" data-testid="diagnostics-local-gaps-missing">
                          Local gap diagnostics unavailable.
                        </span>
                      )}
                      {s.last_error ? (
                        <span
                          className="pdpp-caption text-destructive"
                          data-testid="diagnostics-source-error"
                          title={JSON.stringify(s.last_error)}
                        >
                          Last error reported
                        </span>
                      ) : null}
                      <Link
                        className="pdpp-caption text-muted-foreground underline-offset-2 hover:underline"
                        href={`/dashboard/device-exporters#${encodeURIComponent(s.device_id)}`}
                      >
                        {s.device_id}
                      </Link>
                    </div>
                  </li>
                ))}
              </DataList>
            )}
          </DiagnosticsBlock>
        </div>
      </details>
    </Section>
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

function DiagnosticsBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="pdpp-eyebrow mb-1.5 text-muted-foreground">{title}</h3>
      {children}
    </div>
  );
}
