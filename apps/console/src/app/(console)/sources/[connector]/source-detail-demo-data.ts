import { formatStreamCollectionFacts, type StreamCollectionFacts } from "../../lib/collection-report.ts";
import type {
  DeviceSourceInstance,
  RefCollectionReportEntry,
  RefConnectionHealthSnapshot,
  RefConnectorRunSummary,
  RefRenderedVerdict,
  RunSummary,
} from "../../lib/ref-client.ts";
import type { StreamSummary } from "../../lib/rs-client.ts";
import type { ConnectorPageModel } from "./page.tsx";

function toRunRef(summary: RefConnectorRunSummary | null) {
  if (!summary) {
    return null;
  }
  return {
    event_count: summary.event_count,
    failure_reason: summary.failure_reason,
    first_at: summary.first_at,
    known_gaps: summary.known_gaps,
    last_at: summary.last_at,
    run_id: summary.run_id,
    status: summary.status,
  };
}

export function buildRecoveryDemoModel(): ConnectorPageModel {
  const connectionId = "cin_demo_claude_code_workstation";
  const run: RunSummary = {
    connection_id: connectionId,
    connector_id: "claude_code",
    connector_instance_id: connectionId,
    event_count: 14,
    failure_reason: "local collector outbox has dead-lettered rows",
    first_at: "2026-07-01T11:15:00.000Z",
    grant_id: null,
    kinds: ["messages"],
    last_at: "2026-07-01T11:18:00.000Z",
    needs_input: false,
    object: "run_summary",
    run_id: "run_demo_recovery",
    status: "failed",
  };
  const streams: StreamSummary[] = [
    {
      last_updated: "2026-07-01T10:40:00.000Z",
      name: "messages",
      object: "stream",
      record_count: 428,
    },
    {
      last_updated: "2026-06-30T17:12:00.000Z",
      name: "sessions",
      object: "stream",
      record_count: 36,
    },
  ];
  const collectionReport: RefCollectionReportEntry[] = [
    {
      checkpoint: "committed",
      collected: 24,
      considered: 27,
      coverage_condition: "retryable_gap",
      covered: 24,
      forward_disposition: "resumable",
      pending_detail_gaps: 3,
      skipped: null,
      stream: "messages",
    },
  ];
  const collectionFactsByStream = new Map<string, StreamCollectionFacts>(
    collectionReport.map((entry) => [entry.stream, formatStreamCollectionFacts(entry)])
  );
  const renderedVerdict: RefRenderedVerdict = {
    annotations: [{ kind: "freshness", text: "collector checked in 12 minutes ago" }],
    channel: "attention",
    detail: { suppressed: [] },
    forward_statement: "The local collector has saved records that did not upload to this server.",
    pill: { label: "Can't collect", tone: "red" },
    progress: {
      gaps_drained_last_run: null,
      headline: "3 local rows need recovery before collection can resume.",
      last_refreshed_at: "2026-07-01T12:00:00.000Z",
      mode: "local_device",
      records_committed_last_run: 24,
      retained_records: 464,
    },
    required_actions: [
      {
        affects: ["messages"],
        audience: "owner",
        cta: "See recovery steps",
        kind: "retry_gap",
        remediation: {
          cause: "dead_letter_backlog",
          commands: [
            {
              command_template: "npx -y @pdpp/local-collector doctor --source-instance-id <source-instance-id>",
              kind: "local_collector_doctor",
              label: "Inspect the local queue",
            },
            {
              command_template:
                "npx -y @pdpp/local-collector retry-dead-letters --source-instance-id <source-instance-id> --apply",
              kind: "local_collector_retry_dead_letters_apply",
              label: "Retry failed rows",
            },
          ],
          kind: "local_collector_recovery",
          label: "Recover local collector outbox",
          summary: "Run these on the workstation that owns this source.",
          target: { identity_source: "source_instance_bindings", kind: "local_device" },
        },
        satisfied_when: { kind: "gap_recovered" },
        terminal: false,
        urgency: "now",
      },
    ],
    streams: [
      {
        action_ref: 0,
        collected: 24,
        considered: 27,
        coverage: "retryable_gap",
        disposition: "resumable",
        statement: "24 collected; 3 local rows need retry.",
        stream_id: "messages",
      },
    ],
    trace: { demo: true },
  };
  const connectionHealth: RefConnectionHealthSnapshot = {
    axes: {
      attention: "open",
      coverage: "retryable_gap",
      freshness: "stale",
      outbox: "stalled",
    },
    badges: { stale: true, syncing: false },
    conditions: [
      {
        current: true,
        expires_at: null,
        id: "cond_demo_dead_letter",
        message: "The local collector reported dead-lettered rows.",
        observed_at: "2026-07-01T11:58:00.000Z",
        origin: "local_collector",
        reason: "dead_letter_backlog",
        remediation: {
          action: "retry_local_outbox",
          label: "Retry local outbox",
          retryable: true,
          target: "source_instance",
        },
        sensitivity: "owner",
        severity: "blocked",
        status: "true",
        type: "local_collector_dead_letter",
      },
    ],
    detail_gap_backlog: {
      max_attempt_count: 6,
      next_attempt_at: null,
      pending: 3,
      pending_is_floor: false,
      recovered: 0,
      terminal: 0,
    },
    dominant_condition_id: "cond_demo_dead_letter",
    forward_disposition: "awaiting_owner",
    last_success_at: "2026-07-01T10:40:00.000Z",
    next_action: null,
    next_attempt_at: null,
    reason_code: "local_collector_dead_letter",
    state: "needs_attention",
    supporting_condition_ids: ["cond_demo_dead_letter"],
    unknown_reasons: [],
  };
  const sourceInstances: DeviceSourceInstance[] = [
    {
      accepted_record_count: 464,
      connector_id: "claude_code",
      connector_instance_id: connectionId,
      created_at: "2026-06-24T12:00:00.000Z",
      device_id: "device_demo_workstation",
      display_name: "workstation",
      last_error: null,
      last_heartbeat_at: "2026-07-01T11:58:00.000Z",
      last_heartbeat_status: "ok",
      last_ingest_at: "2026-07-01T10:40:00.000Z",
      local_binding_name: "workstation",
      object: "device_source_instance",
      outbox_diagnostics: { dead_letter: 3, pending: 3, total: 27 },
      outbox_state: "dead_letter",
      records_pending: 3,
      rejected_record_count: 3,
      source_instance_id: "src_demo_workstation",
    },
  ];
  const overview = {
    collectionReport,
    connectionHealth,
    connectionId,
    connectionStatus: "active",
    connector: {
      connector_id: "claude_code",
      display_name: "Claude Code",
      name: "Claude Code",
      streams: [{ name: "messages" }, { name: "sessions" }],
    },
    connectorDisplayName: "Claude Code",
    connectorInstanceId: connectionId,
    isRunning: false,
    lastRun: toRunRef({
      event_count: run.event_count,
      failure_reason: run.failure_reason,
      finished_at: "2026-07-01T11:18:00.000Z",
      first_at: run.first_at,
      last_at: run.last_at,
      run_id: run.run_id,
      started_at: run.first_at,
      status: run.status,
    }),
    lastSuccessfulRun: toRunRef({
      event_count: 8,
      failure_reason: null,
      finished_at: "2026-07-01T10:40:00.000Z",
      first_at: "2026-07-01T10:39:00.000Z",
      last_at: "2026-07-01T10:40:00.000Z",
      run_id: "run_demo_previous_success",
      started_at: "2026-07-01T10:39:00.000Z",
      status: "succeeded",
    }),
    localDeviceProgress: {
      last_heartbeat_at: "2026-07-01T11:58:00.000Z",
      last_heartbeat_status: "ok",
      last_ingest_at: "2026-07-01T10:40:00.000Z",
      outbox_counts: { dead_letter: 3, pending: 3, total: 27 },
      records_pending: 3,
      source_count: 1,
    },
    streams,
    streamCount: streams.length,
    totalRecords: 464,
    totalRetainedBytes: null,
  };
  return {
    collectionFactsByStream,
    collectionOwnerActionByStream: { messages: true, sessions: true },
    activeRunId: null,
    connectionHealth,
    connectionId,
    connectionLabelSeed: "Claude Code workstation",
    connectionPrimaryAction: renderedVerdict.required_actions[0] ?? null,
    connectionRenderedVerdict: renderedVerdict,
    connectorId: "claude_code",
    connectorInstanceId: connectionId,
    deviceLabels: ["workstation"],
    sourceBindingKind: null,
    displayName: "Claude Code workstation",
    headerCount: "464 records, 2 streams",
    manifest: {
      connector_id: "claude_code",
      display_name: "Claude Code",
      name: "Claude Code",
      streams: [{ name: "messages" }, { name: "sessions" }],
    },
    manualUploadHref: null,
    overview,
    providerOrigin: "https://pdpp.example.test",
    recentRuns: [run],
    schedule: null,
    scheduleError: null,
    sourceInstances,
    sourceInstancesError: null,
    streams,
    totalRecords: 464,
  };
}
