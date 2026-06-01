/**
 * Unit tests for the connection-evidence formatters. These cover the
 * honest-by-default rules required by tasks 6.1 and 6.5: never render
 * `0` records when evidence failed, never label coverage `complete`
 * when the axis is `unknown`, and surface unreliable projection
 * evidence explicitly rather than silently.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveConnectionNextStep,
  deriveConnectionStatusDisplay,
  derivePrimaryRowAction,
  formatCoverageAxis,
  formatDominantCondition,
  formatFreshnessAxis,
  formatLastDurableProgress,
  formatOutboxAxis,
  formatProjectionFreshness,
  formatSourceOutboxState,
  resolveRecordCountDisplay,
  summarizeAxisChips,
  summarizeOutboxForRow,
  summarizeOutboxStallRemediation,
  summarizeSchedule,
} from "./connection-evidence.ts";
import type { RefConnectionHealthCondition, RefConnectionHealthSnapshot, RefSchedule } from "./ref-client.ts";
import type { ConnectorOverview } from "./rs-client.ts";

function snapshot(overrides: Partial<RefConnectionHealthSnapshot> = {}): RefConnectionHealthSnapshot {
  return {
    state: "healthy",
    reason_code: null,
    unknown_reasons: [],
    last_success_at: "2026-05-19T12:00:00Z",
    next_attempt_at: null,
    next_action: null,
    badges: { stale: false, syncing: false },
    axes: { coverage: "complete", freshness: "fresh", attention: "none", outbox: "idle" },
    conditions: [],
    dominant_condition_id: null,
    ...overrides,
  };
}

function baseOverview(overrides: Partial<ConnectorOverview> = {}): ConnectorOverview {
  return {
    connector: { connector_id: "demo", display_name: "Demo" },
    streams: [],
    totalRecords: 0,
    lastRun: null,
    lastSuccessfulRun: null,
    isRunning: false,
    ...overrides,
  };
}

test("coverage axis never labels 'unknown' as 'complete'", () => {
  assert.equal(formatCoverageAxis("unknown").tone, "neutral");
  assert.equal(formatCoverageAxis("unknown").label.toLowerCase().includes("unknown"), true);
  assert.equal(formatCoverageAxis("complete").tone, "success");
  assert.equal(formatCoverageAxis("gaps").tone, "warning");
  assert.equal(formatCoverageAxis("partial").tone, "warning");
});

test("coverage axis covers the full reference-server vocabulary", () => {
  assert.equal(formatCoverageAxis("retryable_gap").tone, "warning");
  assert.equal(formatCoverageAxis("terminal_gap").tone, "danger");
  for (const axis of ["deferred", "inventory_only", "unavailable", "unsupported"] as const) {
    const chip = formatCoverageAxis(axis);
    assert.equal(chip.tone, "neutral");
    assert.equal(chip.label.startsWith("Coverage"), true);
  }
});

test("axis chips degrade safely when runtime axes are missing or novel", () => {
  const out = summarizeAxisChips({
    attention: "none",
    coverage: "future_gap",
    freshness: undefined,
    outbox: "future_outbox",
  } as unknown as RefConnectionHealthSnapshot["axes"]);
  assert.equal(out.length, 3);
  assert.deepEqual(
    out.map((c) => c.label),
    ["Coverage · unknown", "Freshness · unknown", "Outbox · unknown"]
  );
  assert.equal(
    out.every((c) => c.tone === "neutral"),
    true
  );
});

test("freshness axis maps known states honestly", () => {
  assert.equal(formatFreshnessAxis("fresh").tone, "success");
  assert.equal(formatFreshnessAxis("stale").tone, "warning");
  assert.equal(formatFreshnessAxis("unknown").tone, "neutral");
});

test("outbox stalled is danger, unknown is neutral, idle is success", () => {
  assert.equal(formatOutboxAxis("stalled").tone, "danger");
  assert.equal(formatOutboxAxis("unknown").tone, "neutral");
  assert.equal(formatOutboxAxis("idle").tone, "success");
});

test("formatSourceOutboxState distinguishes granular local collector states", () => {
  assert.equal(
    formatSourceOutboxState({ outbox_state: "dead_letter", outbox_diagnostics: { dead_letter: 1 } }).tone,
    "danger"
  );
  assert.equal(
    formatSourceOutboxState({ outbox_state: "stale", outbox_diagnostics: { stale_leases: 1 } }).tone,
    "danger"
  );
  assert.equal(
    formatSourceOutboxState({ outbox_state: "retrying", outbox_diagnostics: { retrying: 1 } }).tone,
    "warning"
  );
  assert.equal(
    formatSourceOutboxState({ outbox_state: "pending", outbox_diagnostics: { pending: 1 } }).label,
    "Outbox · pending"
  );
  assert.equal(
    formatSourceOutboxState({ outbox_state: "backlog", outbox_diagnostics: { backlog_open: 1 } }).tone,
    "warning"
  );
  assert.equal(
    formatSourceOutboxState({ outbox_state: "drained", outbox_diagnostics: { total: 2, succeeded: 2 } }).tone,
    "success"
  );
  assert.equal(formatSourceOutboxState({ outbox_state: undefined, outbox_diagnostics: null }).tone, "neutral");
});

test("summarizeAxisChips omits attention when none and always includes coverage/freshness/outbox", () => {
  const out = summarizeAxisChips(
    snapshot({ axes: { coverage: "complete", freshness: "fresh", attention: "none", outbox: "idle" } }).axes
  );
  assert.equal(
    out.some((c) => c.label.startsWith("Attention")),
    false
  );
  assert.equal(out.length, 3);
  const labels = out.map((c) => c.label);
  assert.ok(labels.some((l) => l.startsWith("Coverage")));
  assert.ok(labels.some((l) => l.startsWith("Freshness")));
  assert.ok(labels.some((l) => l.startsWith("Outbox")));
});

test("summarizeAxisChips surfaces attention when open", () => {
  const out = summarizeAxisChips(
    snapshot({ axes: { coverage: "gaps", freshness: "fresh", attention: "open", outbox: "idle" } }).axes
  );
  assert.equal(out.length, 4);
  assert.ok(out.some((c) => c.label.startsWith("Attention")));
});

test("summarizeAxisChips returns empty when axes are missing (no false success)", () => {
  assert.deepEqual(summarizeAxisChips(null), []);
  assert.deepEqual(summarizeAxisChips(undefined), []);
});

test("formatProjectionFreshness flags unreliable when unknown_reasons is non-empty", () => {
  const out = formatProjectionFreshness(
    snapshot({ state: "unknown", unknown_reasons: ["schedule_unavailable", "freshness_unknown"] })
  );
  assert.equal(out.unreliable, true);
  assert.equal(out.reasons.length, 2);
  assert.equal(out.detail.includes("schedule unavailable"), true);
  assert.equal(out.detail.includes("freshness unknown"), true);
});

test("formatProjectionFreshness returns reliable when no unknown_reasons", () => {
  const out = formatProjectionFreshness(snapshot());
  assert.equal(out.unreliable, false);
  assert.equal(out.reasons.length, 0);
});

test("formatProjectionFreshness handles missing snapshot", () => {
  const out = formatProjectionFreshness(null);
  assert.equal(out.unreliable, false);
});

test("formatDominantCondition surfaces only false dominant evidence", () => {
  const out = formatDominantCondition(
    snapshot({
      state: "blocked",
      dominant_condition_id: "CredentialsValid:auth_expired",
      conditions: [
        {
          id: "CredentialsValid:auth_expired",
          type: "CredentialsValid",
          status: "false",
          severity: "blocked",
          reason: "auth_expired",
          message: "The source rejected the configured credentials.",
          origin: "readiness",
          observed_at: null,
          expires_at: null,
          sensitivity: "secret_redacted",
          remediation: {
            action: "refresh_credentials",
            label: "Reconnect or update the source credentials",
            retryable: false,
            target: "credentials",
          },
        },
      ],
    })
  );
  assert.equal(out?.tone, "danger");
  assert.equal(out?.label.includes("rejected"), true);
  assert.equal(out?.title.includes("Reconnect"), true);
});

test("formatLastDurableProgress refuses to substitute 0 when evidence failed", () => {
  const out = formatLastDurableProgress({
    hasError: true,
    lastRun: null,
    lastSuccessfulRun: null,
    totalRecords: 0,
  });
  assert.equal(out.unavailable, true);
  assert.equal(out.label.toLowerCase().includes("unavailable"), true);
  assert.equal(out.label.startsWith("0"), false);
});

test("formatLastDurableProgress reports last successful event count when present", () => {
  const out = formatLastDurableProgress({
    hasError: false,
    lastRun: null,
    lastSuccessfulRun: {
      run_id: "r1",
      first_at: "x",
      last_at: "y",
      event_count: 42,
      status: "succeeded",
      failure_reason: null,
    },
    totalRecords: 50,
  });
  assert.equal(out.unavailable, false);
  assert.equal(out.label.includes("42 events"), true);
});

test("formatLastDurableProgress reports last attempt when no success and no error", () => {
  const out = formatLastDurableProgress({
    hasError: false,
    lastRun: {
      run_id: "r2",
      first_at: "x",
      last_at: "y",
      event_count: 0,
      status: "failed",
      failure_reason: "boom",
    },
    lastSuccessfulRun: null,
    totalRecords: 0,
  });
  assert.equal(out.unavailable, false);
  assert.equal(out.label.includes("Last attempt"), true);
  assert.equal(out.label.includes("failed"), true);
});

test("formatLastDurableProgress reports 'records present · no scheduler run yet' when records exist without runs", () => {
  const out = formatLastDurableProgress({
    hasError: false,
    lastRun: null,
    lastSuccessfulRun: null,
    totalRecords: 7,
  });
  assert.equal(out.label.includes("Records present"), true);
  assert.equal(out.label.includes("no scheduler run"), true);
});

test("formatLastDurableProgress reports 'Never run' when there is no evidence at all", () => {
  const out = formatLastDurableProgress({
    hasError: false,
    lastRun: null,
    lastSuccessfulRun: null,
    totalRecords: 0,
  });
  assert.equal(out.label.includes("Never run"), true);
  assert.equal(out.unavailable, false);
});

test("formatLastDurableProgress surfaces last ingest for push-mode local-device connectors with no scheduler run", () => {
  const out = formatLastDurableProgress({
    hasError: false,
    lastRun: null,
    lastSuccessfulRun: null,
    localDeviceProgress: {
      last_heartbeat_at: "2026-05-22T16:30:00Z",
      last_heartbeat_status: "healthy",
      last_ingest_at: "2026-05-22T16:35:00Z",
      records_pending: 0,
      source_count: 1,
    },
    totalRecords: 12,
  });
  assert.equal(out.unavailable, false);
  assert.equal(out.label.includes("Last ingest"), true);
  // Must not fall back to the "no scheduler run yet" caveat once we have
  // honest local-device evidence.
  assert.equal(out.label.includes("no scheduler run"), false);
});

test("formatLastDurableProgress falls back to last checked when no ingest timestamp is present", () => {
  const out = formatLastDurableProgress({
    hasError: false,
    lastRun: null,
    lastSuccessfulRun: null,
    localDeviceProgress: {
      last_heartbeat_at: "2026-05-22T16:30:00Z",
      last_heartbeat_status: "healthy",
      last_ingest_at: null,
      records_pending: 0,
      source_count: 1,
    },
    totalRecords: 0,
  });
  assert.equal(out.label.includes("Last checked"), true);
});

test("formatLastDurableProgress still prefers scheduler-run evidence over local-device heartbeat when both exist", () => {
  const out = formatLastDurableProgress({
    hasError: false,
    lastRun: null,
    lastSuccessfulRun: {
      run_id: "r9",
      first_at: "x",
      last_at: "y",
      event_count: 3,
      status: "succeeded",
      failure_reason: null,
      known_gaps: [],
    },
    localDeviceProgress: {
      last_heartbeat_at: "2026-05-22T16:30:00Z",
      last_heartbeat_status: "healthy",
      last_ingest_at: "2026-05-22T16:35:00Z",
      records_pending: 0,
      source_count: 1,
    },
    totalRecords: 12,
  });
  assert.equal(out.label.includes("Last success"), true);
  assert.equal(out.label.includes("Last device"), false);
});

test("summarizeOutboxForRow returns null for idle and a label otherwise", () => {
  assert.equal(summarizeOutboxForRow(snapshot()), null);
  const stalled = summarizeOutboxForRow(
    snapshot({ axes: { coverage: "complete", freshness: "fresh", attention: "none", outbox: "stalled" } })
  );
  assert.equal(stalled?.tone, "danger");
  const unknown = summarizeOutboxForRow(
    snapshot({ axes: { coverage: "complete", freshness: "fresh", attention: "none", outbox: "unknown" } })
  );
  assert.equal(unknown?.tone, "neutral");
});

test("summarizeOutboxForRow returns null when there is no snapshot at all", () => {
  assert.equal(summarizeOutboxForRow(null), null);
});

function clearBacklogCondition(overrides: Partial<RefConnectionHealthCondition> = {}): RefConnectionHealthCondition {
  return {
    id: "cond-backlog",
    type: "LocalExporterAvailable",
    status: "false",
    severity: "error",
    reason: "local_exporter_stalled",
    message: "Local exporter work is stalled or blocked.",
    origin: "local_device",
    observed_at: "2026-05-19T12:00:00Z",
    expires_at: null,
    sensitivity: "owner",
    remediation: {
      action: "clear_backlog",
      label: "Inspect the local collector backlog",
      retryable: true,
      target: "local_device",
    },
    ...overrides,
  };
}

test("summarizeOutboxStallRemediation surfaces the reference remediation label for a clear_backlog condition", () => {
  const remediation = summarizeOutboxStallRemediation(
    snapshot({
      state: "degraded",
      axes: { coverage: "complete", freshness: "fresh", attention: "none", outbox: "stalled" },
      conditions: [clearBacklogCondition()],
    })
  );
  assert.equal(remediation?.label, "Inspect the local collector backlog");
  assert.equal(remediation?.reason, "local exporter stalled");
});

test("summarizeOutboxStallRemediation fires on the stalled axis even without a matching condition", () => {
  const remediation = summarizeOutboxStallRemediation(
    snapshot({ axes: { coverage: "complete", freshness: "fresh", attention: "none", outbox: "stalled" } })
  );
  assert.equal(remediation?.label, "Inspect the local collector backlog");
  assert.equal(remediation?.reason, null);
});

test("summarizeOutboxStallRemediation stays quiet for healthy/idle/active/unknown outboxes", () => {
  for (const outbox of ["idle", "active", "unknown"] as const) {
    assert.equal(
      summarizeOutboxStallRemediation(
        snapshot({ axes: { coverage: "complete", freshness: "fresh", attention: "none", outbox } })
      ),
      null,
      `expected no remediation for outbox=${outbox}`
    );
  }
  assert.equal(summarizeOutboxStallRemediation(null), null);
});

test("summarizeOutboxStallRemediation ignores a clear_backlog remediation on a resolved (status=true) condition", () => {
  // A backlog condition that has cleared (status true) must not keep showing
  // remediation noise once the outbox is no longer stalled.
  const remediation = summarizeOutboxStallRemediation(
    snapshot({
      axes: { coverage: "complete", freshness: "fresh", attention: "none", outbox: "idle" },
      conditions: [clearBacklogCondition({ status: "true" })],
    })
  );
  assert.equal(remediation, null);
});

test("summarizeOutboxStallRemediation: scale is null when no count rollup is available", () => {
  const remediation = summarizeOutboxStallRemediation(
    snapshot({
      axes: { coverage: "complete", freshness: "fresh", attention: "none", outbox: "stalled" },
      conditions: [clearBacklogCondition()],
    })
  );
  assert.equal(remediation?.scale, null);
});

test("summarizeOutboxStallRemediation: surfaces a count-backed scale from outbox_counts on a stall", () => {
  const remediation = summarizeOutboxStallRemediation(
    snapshot({
      axes: { coverage: "complete", freshness: "fresh", attention: "none", outbox: "stalled" },
      conditions: [clearBacklogCondition()],
    }),
    {
      last_heartbeat_at: "2026-05-19T11:55:00Z",
      last_heartbeat_status: "blocked",
      last_ingest_at: null,
      outbox_counts: { pending: 12, dead_letter: 2, stale_leases: 1, total: 15 },
      records_pending: 12,
      source_count: 1,
    }
  );
  assert.equal(remediation?.scale, "12 pending · 1 stale lease · 2 dead-letter");
});

test("summarizeOutboxStallRemediation: scale omits zero categories so it never reads as alarming noise", () => {
  const remediation = summarizeOutboxStallRemediation(
    snapshot({
      axes: { coverage: "complete", freshness: "fresh", attention: "none", outbox: "stalled" },
    }),
    {
      last_heartbeat_at: "2026-05-19T11:55:00Z",
      last_heartbeat_status: "blocked",
      last_ingest_at: null,
      outbox_counts: { pending: 0, dead_letter: 3, stale_leases: 0, total: 3 },
      records_pending: 0,
      source_count: 1,
    }
  );
  assert.equal(remediation?.scale, "3 dead-letter");
});

test("summarizeOutboxStallRemediation: counts never attach to a quiet (non-stalled) connection", () => {
  // Even with a populated rollup, an idle/active/unknown outbox returns null —
  // so the count-backed scale can never appear on a healthy connection.
  for (const outbox of ["idle", "active", "unknown"] as const) {
    assert.equal(
      summarizeOutboxStallRemediation(
        snapshot({ axes: { coverage: "complete", freshness: "fresh", attention: "none", outbox } }),
        {
          last_heartbeat_at: "2026-05-19T11:55:00Z",
          last_heartbeat_status: "healthy",
          last_ingest_at: "2026-05-19T11:55:00Z",
          outbox_counts: { pending: 5, dead_letter: 1 },
          records_pending: 5,
          source_count: 1,
        }
      ),
      null,
      `expected no remediation (and thus no counts) for outbox=${outbox}`
    );
  }
});

function baseSchedule(overrides: Partial<RefSchedule> = {}): RefSchedule {
  return {
    active_run_id: null,
    automation_mode: "manual_only",
    automation_summary: "manual only",
    connector_id: "demo",
    created_at: "2026-05-19T11:00:00Z",
    effective_mode: "manual",
    enabled: true,
    human_attention_needed: false,
    ineligibility_reason: null,
    interval_seconds: 3600,
    jitter_seconds: 0,
    last_error_code: null,
    last_finished_at: null,
    last_started_at: null,
    last_successful_at: null,
    minimum_interval_warning: null,
    next_due_at: null,
    notification_posture: "none",
    object: "schedule",
    recommended_policy: null,
    scheduler_backoff: null,
    trigger_kind: "scheduled",
    updated_at: "2026-05-19T11:00:00Z",
    ...overrides,
  };
}

test("summarizeSchedule returns null when no schedule", () => {
  assert.equal(summarizeSchedule(null), null);
});

test("summarizeSchedule surfaces backoff when applied", () => {
  const out = summarizeSchedule(
    baseSchedule({
      scheduler_backoff: {
        backoff_applied: true,
        consecutive_failures: 3,
        next_run_at: "2026-05-19T13:00:00Z",
        reason_class: "rate_limited",
        recommended_health_state: "cooling_off",
      },
    })
  );
  assert.ok(out);
  assert.equal(out.backoffLabel?.includes("Backoff applied"), true);
  assert.equal(out.backoffLabel?.includes("rate limited"), true);
  assert.equal(out.backoffLabel?.includes("3 consecutive failures"), true);
});

test("summarizeSchedule surfaces ineligibility reason without inventing automation", () => {
  const out = summarizeSchedule(baseSchedule({ ineligibility_reason: "browser_runtime_unavailable" }));
  assert.equal(out?.ineligibilityReason, "browser_runtime_unavailable");
});

test("resolveRecordCountDisplay refuses to show 0 when overview has an error", () => {
  const out = resolveRecordCountDisplay(baseOverview({ error: "boom", totalRecords: 0 }));
  assert.equal(out.label, null);
  assert.equal(out.reliable, false);
  assert.equal(out.title.includes("unavailable"), true);
});

test("resolveRecordCountDisplay renders the count normally when reliable", () => {
  const out = resolveRecordCountDisplay(baseOverview({ totalRecords: 1234 }));
  assert.equal(out.label, "1,234");
  assert.equal(out.reliable, true);
});

test("resolveRecordCountDisplay handles 0 records as honest 0 when there is no error", () => {
  const out = resolveRecordCountDisplay(baseOverview({ totalRecords: 0 }));
  assert.equal(out.label, "0");
  assert.equal(out.reliable, true);
});

// ─── deriveConnectionStatusDisplay: vocabulary separation ────────────────
//
// The records row pill must read as a health/readiness/activity verdict,
// never recomplecting the spine's evidence model. These tests pin the
// vocabulary so the operator sees the three required cases correctly:
//
//   1. A healthy scheduled connection with recent durable progress reads
//      as a strong health verdict (success tone), distinct from activity.
//   2. A local collector with ingest evidence and an idle outbox does
//      not read as "Idle" alongside the same word used for paused /
//      never-run connections. It reads as "Ready"; the progress line
//      owns the timing/activity details.
//   3. Blocked, degraded, and needs_attention connections still surface a
//      strong verdict that drives operators to the dominant condition's
//      remediation, not to a vague "Idle".

test("deriveConnectionStatusDisplay: healthy scheduled connection reads as a health verdict", () => {
  const out = deriveConnectionStatusDisplay({
    hasDurableProgress: true,
    health: snapshot({
      state: "healthy",
      axes: { coverage: "complete", freshness: "fresh", attention: "none", outbox: "idle" },
    }),
    localDeviceProgress: null,
  });
  assert.equal(out.label, "Healthy");
  assert.equal(out.tone, "success");
  assert.equal(out.title.toLowerCase().includes("coverage"), true);
});

test("deriveConnectionStatusDisplay: healthy projection without durable progress reads as Ready, not Healthy", () => {
  // The spine emits `healthy` when readiness checks pass even before the
  // first record lands. The pill must distinguish that from a connection
  // with retained records: "Ready" reads as a readiness statement.
  const out = deriveConnectionStatusDisplay({
    hasDurableProgress: false,
    health: snapshot({ state: "healthy" }),
    localDeviceProgress: null,
  });
  assert.equal(out.label, "Ready");
  assert.equal(out.tone, "neutral");
  assert.equal(out.title.toLowerCase().includes("no retained records"), true);
});

test("deriveConnectionStatusDisplay: local collector with ingest evidence and idle outbox reads as Ready, not Idle", () => {
  // The dominant failure mode this change addresses: a local-device
  // collector that has successfully pushed records (so the spine sees a
  // recent `last_ingest_at`) but has no scheduler terminal verdict. The
  // spine projects `idle` to mean "no verdict yet" — the row must not
  // collapse that to a vague "Idle" pill that reads as a health label.
  const out = deriveConnectionStatusDisplay({
    hasDurableProgress: true,
    health: snapshot({
      state: "idle",
      axes: { coverage: "unknown", freshness: "unknown", attention: "none", outbox: "idle" },
    }),
    localDeviceProgress: {
      last_heartbeat_at: "2026-05-22T16:30:00Z",
      last_heartbeat_status: "healthy",
      last_ingest_at: "2026-05-22T16:35:00Z",
      records_pending: 0,
      source_count: 1,
    },
  });
  assert.equal(out.label, "Ready");
  assert.equal(out.tone, "neutral");
  assert.equal(out.title.toLowerCase().includes("last ingest"), true);
  assert.equal(out.label.toLowerCase() === "idle", false);
});

test("deriveConnectionStatusDisplay: idle projection with no durable progress reads as Awaiting first sync", () => {
  // The spine's `idle` for a fresh connection should not read as a
  // health verdict — there is no verdict yet. "Awaiting first sync"
  // describes readiness/activity honestly.
  const out = deriveConnectionStatusDisplay({
    hasDurableProgress: false,
    health: snapshot({ state: "idle" }),
    localDeviceProgress: null,
  });
  assert.equal(out.label, "Awaiting first sync");
  assert.equal(out.tone, "neutral");
});

test("deriveConnectionStatusDisplay: idle projection with durable progress reads as Ready", () => {
  // A connection with durable progress that the spine still marks `idle`
  // (no current terminal verdict, nothing actively wrong) should read as
  // "Ready" — a readiness statement, not a health verdict.
  const out = deriveConnectionStatusDisplay({
    hasDurableProgress: true,
    health: snapshot({ state: "idle" }),
    localDeviceProgress: null,
  });
  assert.equal(out.label, "Ready");
  assert.equal(out.tone, "neutral");
});

test("deriveConnectionStatusDisplay: outbox=active overrides idle as Syncing regardless of device progress", () => {
  // Push-mode collectors with an actively-draining outbox should read as
  // "Syncing" even when no device-progress snapshot has been recorded
  // yet. The outbox axis alone carries that signal.
  const out = deriveConnectionStatusDisplay({
    hasDurableProgress: true,
    health: snapshot({
      state: "idle",
      axes: { coverage: "complete", freshness: "fresh", attention: "none", outbox: "active" },
    }),
    localDeviceProgress: null,
  });
  assert.equal(out.label, "Syncing");
  assert.equal(out.tone, "running");
});

test("deriveConnectionStatusDisplay: blocked connection surfaces dominant condition title, never Idle", () => {
  const out = deriveConnectionStatusDisplay({
    hasDurableProgress: false,
    health: snapshot({
      state: "blocked",
      reason_code: "credential_rejected",
      dominant_condition_id: "CredentialsValid:credential_rejected",
      conditions: [
        {
          id: "CredentialsValid:credential_rejected",
          type: "CredentialsValid",
          status: "false",
          severity: "blocked",
          reason: "credential_rejected",
          message: "The source rejected the configured credentials.",
          origin: "readiness",
          observed_at: null,
          expires_at: null,
          sensitivity: "secret_redacted",
          remediation: {
            action: "refresh_credentials",
            label: "Reconnect or update the source credentials",
            retryable: false,
            target: "credentials",
          },
        },
      ],
    }),
    localDeviceProgress: null,
  });
  assert.equal(out.label, "Blocked");
  assert.equal(out.tone, "danger");
  assert.equal(out.shape, "triangle");
  assert.equal(out.title.includes("rejected"), true);
  assert.equal(out.title.includes("Reconnect"), true);
});

test("deriveConnectionStatusDisplay: degraded with partial coverage reads as Partial", () => {
  const out = deriveConnectionStatusDisplay({
    hasDurableProgress: true,
    health: snapshot({
      state: "degraded",
      axes: { coverage: "partial", freshness: "fresh", attention: "none", outbox: "idle" },
    }),
    localDeviceProgress: null,
  });
  assert.equal(out.label, "Partial");
  assert.equal(out.tone, "warning");
  assert.equal(out.shape, "diamond");
});

test("deriveConnectionStatusDisplay: needs_attention surfaces dominant condition rather than generic copy", () => {
  const out = deriveConnectionStatusDisplay({
    hasDurableProgress: true,
    health: snapshot({
      state: "needs_attention",
      dominant_condition_id: "AttentionClear:otp_required",
      conditions: [
        {
          id: "AttentionClear:otp_required",
          type: "AttentionClear",
          status: "false",
          severity: "warning",
          reason: "otp_required",
          message: "A one-time passcode is required to continue.",
          origin: "operator",
          observed_at: null,
          expires_at: null,
          sensitivity: "owner",
          remediation: {
            action: "provide_value",
            label: "Provide the OTP",
            retryable: true,
            target: "dashboard",
          },
        },
      ],
    }),
    localDeviceProgress: null,
  });
  assert.equal(out.label, "Needs attention");
  assert.equal(out.tone, "warning");
  assert.equal(out.title.toLowerCase().includes("one-time passcode"), true);
});

test("deriveConnectionStatusDisplay: unknown projection lists unknown reasons in the tooltip", () => {
  const out = deriveConnectionStatusDisplay({
    hasDurableProgress: true,
    health: snapshot({
      state: "unknown",
      unknown_reasons: ["schedule_unavailable", "freshness_unknown"],
    }),
    localDeviceProgress: null,
  });
  assert.equal(out.label, "Unknown");
  assert.equal(out.title.includes("schedule_unavailable"), true);
});

// ─── deriveConnectionNextStep ─────────────────────────────────────────────
//
// The "what can I do next" guidance for states the structured next_action
// doesn't already cover. It must never duplicate a structured CTA, never
// invent a remote action the dashboard can't perform, and only suggest
// "Sync now" when the connector supports an owner-triggered pull.

const OPEN_CONNECTION_RE = /open the connection/i;
const COOLING_OFF_NEXT_ATTEMPT_RE = /2026-05-19T13:00:00Z/;
const COVERAGE_RE = /coverage/i;
const SYNC_NOW_RE = /sync now/i;
const COLLECTOR_RE = /collector/i;
const HOST_RE = /host/i;

test("next-step guidance is suppressed when a structured next_action already renders", () => {
  const out = deriveConnectionNextStep({
    hasDominantCondition: false,
    hasStructuredNextAction: true,
    health: snapshot({
      state: "needs_attention",
      axes: { coverage: "complete", freshness: "stale", attention: "open", outbox: "idle" },
    }),
    supportsOwnerSync: true,
  });
  assert.equal(out, null);
});

test("next-step guidance is null for healthy / idle / unknown without staleness", () => {
  for (const state of ["healthy", "idle", "unknown"] as const) {
    const out = deriveConnectionNextStep({
      hasDominantCondition: false,
      hasStructuredNextAction: false,
      health: snapshot({ state }),
      supportsOwnerSync: true,
    });
    assert.equal(out, null, `expected null for ${state}`);
  }
});

test("blocked guidance points the owner at the connection detail, danger tone", () => {
  const out = deriveConnectionNextStep({
    hasDominantCondition: false,
    hasStructuredNextAction: false,
    health: snapshot({ state: "blocked" }),
    supportsOwnerSync: true,
  });
  assert.ok(out);
  assert.equal(out?.tone, "danger");
  assert.match(out?.label ?? "", OPEN_CONNECTION_RE);
});

test("blocked / needs_attention generic guidance is suppressed when a dominant condition already explains it", () => {
  for (const state of ["blocked", "needs_attention"] as const) {
    const out = deriveConnectionNextStep({
      hasDominantCondition: true,
      hasStructuredNextAction: false,
      health: snapshot({ state }),
      supportsOwnerSync: true,
    });
    assert.equal(out, null, `expected null for ${state} when a dominant condition is shown`);
  }
});

test("action-bearing guidance still fires even when a dominant condition is present", () => {
  // A stalled outbox carries a concrete host step the condition message does
  // not, so it is NOT suppressed by a dominant-condition notice.
  const out = deriveConnectionNextStep({
    hasDominantCondition: true,
    hasStructuredNextAction: false,
    health: snapshot({
      state: "degraded",
      axes: { coverage: "complete", freshness: "fresh", attention: "none", outbox: "stalled" },
    }),
    supportsOwnerSync: true,
  });
  assert.ok(out);
  assert.match(out?.label ?? "", HOST_RE);
});

test("cooling_off guidance names the next attempt time when known", () => {
  const out = deriveConnectionNextStep({
    hasDominantCondition: false,
    hasStructuredNextAction: false,
    health: snapshot({ state: "cooling_off", next_attempt_at: "2026-05-19T13:00:00Z" }),
    supportsOwnerSync: true,
  });
  assert.ok(out);
  assert.equal(out?.tone, "warning");
  assert.match(out?.detail ?? "", COOLING_OFF_NEXT_ATTEMPT_RE);
});

test("degraded+partial coverage routes to a coverage review, not a sync", () => {
  const out = deriveConnectionNextStep({
    hasDominantCondition: false,
    hasStructuredNextAction: false,
    health: snapshot({
      state: "degraded",
      axes: { coverage: "gaps", freshness: "fresh", attention: "none", outbox: "idle" },
    }),
    supportsOwnerSync: true,
  });
  assert.ok(out);
  assert.match(out?.label ?? "", COVERAGE_RE);
  assert.doesNotMatch(out?.label ?? "", SYNC_NOW_RE);
});

test("stale freshness suggests Sync now only when owner sync is supported", () => {
  const supported = deriveConnectionNextStep({
    hasDominantCondition: false,
    hasStructuredNextAction: false,
    health: snapshot({
      state: "degraded",
      axes: { coverage: "complete", freshness: "stale", attention: "none", outbox: "idle" },
    }),
    supportsOwnerSync: true,
  });
  assert.match(supported?.label ?? "", SYNC_NOW_RE);

  const pushMode = deriveConnectionNextStep({
    hasDominantCondition: false,
    hasStructuredNextAction: false,
    health: snapshot({
      state: "degraded",
      axes: { coverage: "complete", freshness: "stale", attention: "none", outbox: "idle" },
    }),
    supportsOwnerSync: false,
  });
  assert.doesNotMatch(pushMode?.label ?? "", SYNC_NOW_RE);
  assert.match(pushMode?.label ?? "", COLLECTOR_RE);
});

test("a stalled outbox always routes to the host, never a remote button", () => {
  const out = deriveConnectionNextStep({
    hasDominantCondition: false,
    hasStructuredNextAction: false,
    health: snapshot({
      state: "degraded",
      axes: { coverage: "complete", freshness: "fresh", attention: "none", outbox: "stalled" },
    }),
    supportsOwnerSync: true,
  });
  assert.ok(out);
  assert.equal(out?.tone, "danger");
  assert.match(out?.label ?? "", HOST_RE);
});

test("an otherwise-healthy but stale connection still gets a nudge", () => {
  const out = deriveConnectionNextStep({
    hasDominantCondition: false,
    hasStructuredNextAction: false,
    health: snapshot({
      state: "healthy",
      axes: { coverage: "complete", freshness: "stale", attention: "none", outbox: "idle" },
    }),
    supportsOwnerSync: true,
  });
  assert.ok(out);
  assert.match(out?.label ?? "", SYNC_NOW_RE);
});

// ─── derivePrimaryRowAction: the row's modality-aware primary action ───────
//
// "Sync now" starts a scheduler-managed pull and is only honest for connectors
// the owner can trigger from the dashboard. These tests pin that:
//   - owner-syncable connectors keep the clickable sync action,
//   - push-mode (local-device progress) connectors get a "wait for the device"
//     status instead of a dead button,
//   - browser-bound connectors point at the runbook, never a dead sync.

const DEVICE_WAIT_DETAIL_RE = /local-collector device|local collector/i;

test("derivePrimaryRowAction keeps Sync now for an owner-syncable connector", () => {
  const action = derivePrimaryRowAction({ connectorId: "gmail", hasLocalDeviceProgress: false });
  assert.equal(action.kind, "sync");
});

test("derivePrimaryRowAction never returns sync for a push-mode local-collector row", () => {
  const action = derivePrimaryRowAction({ connectorId: "claude_code", hasLocalDeviceProgress: true });
  assert.equal(action.kind, "device_wait");
  assert.notEqual(action.kind, "sync");
  if (action.kind === "device_wait") {
    assert.ok(action.label.trim().length > 0);
    assert.match(action.detail, DEVICE_WAIT_DETAIL_RE);
  }
});

test("derivePrimaryRowAction points a browser-bound connector at the runbook, not a sync", () => {
  const action = derivePrimaryRowAction({ connectorId: "amazon", hasLocalDeviceProgress: false });
  assert.equal(action.kind, "browser_runbook");
  assert.notEqual(action.kind, "sync");
  if (action.kind === "browser_runbook") {
    assert.equal(action.runbookPath, "docs/operator/browser-collector-proof-runbook.md");
    assert.ok(action.label.trim().length > 0);
  }
});

test("derivePrimaryRowAction treats browser-bound as non-syncable even with device progress", () => {
  // A browser-bound connector with a heartbeat is still set up via the runbook;
  // the runbook pointer is the more actionable next step, and it is never an
  // owner-triggerable sync.
  const action = derivePrimaryRowAction({ connectorId: "chase", hasLocalDeviceProgress: true });
  assert.equal(action.kind, "browser_runbook");
});

test("derivePrimaryRowAction defaults to sync for an unknown connector with no device progress", () => {
  // Unknown/no-data owner-syncable rows: the clickable Sync now IS the honest
  // next step. The false-affordance suppression only fires for push-mode and
  // browser-bound modalities.
  assert.equal(derivePrimaryRowAction({ connectorId: "demo", hasLocalDeviceProgress: false }).kind, "sync");
  assert.equal(derivePrimaryRowAction({ connectorId: null, hasLocalDeviceProgress: false }).kind, "sync");
  assert.equal(derivePrimaryRowAction({ connectorId: undefined, hasLocalDeviceProgress: false }).kind, "sync");
});
