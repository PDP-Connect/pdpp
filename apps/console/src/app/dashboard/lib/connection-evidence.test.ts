/**
 * biome-ignore-all lint/performance/useTopLevelRegex: This copy-heavy test
 * suite uses local regex assertions intentionally.
 *
 * Unit tests for the connection-evidence formatters. These cover the
 * honest-by-default rules required by tasks 6.1 and 6.5: never render
 * `0` records when evidence failed, never label coverage `complete`
 * when the axis is `unknown`, and surface unreliable projection
 * evidence explicitly rather than silently.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveAutoPausedBanner,
  deriveConnectionNextStep,
  deriveConnectionStatusDisplay,
  deriveFailureSummary,
  derivePrimaryRowAction,
  deriveStreakDots,
  formatCollectionRateReadout,
  formatCoverageAxis,
  formatDominantCondition,
  formatForwardDisposition,
  formatFreshnessAxis,
  formatLastDurableProgress,
  formatOutboxAxis,
  formatProjectionFreshness,
  formatSourceOutboxState,
  outboxAxisIsApplicable,
  resolveRecordCountDisplay,
  summarizeAxisChips,
  summarizeOutboxForRow,
  summarizeOutboxStallRemediation,
  summarizeSchedule,
  syncActionIdleLabel,
  syncStartFailureLead,
  synthesizeConnectionVerdict,
} from "./connection-evidence.ts";
import type {
  RefConnectionHealthCondition,
  RefConnectionHealthSnapshot,
  RefDetailGapBacklog,
  RefSchedule,
} from "./ref-client.ts";
import type { ConnectorOverview } from "./rs-client.ts";

test("formatForwardDisposition renders checking coverage as neutral, not resumable", () => {
  const out = formatForwardDisposition("checking");
  assert.equal(out?.label, "checking coverage");
  assert.equal(out?.tone, "neutral");
  assert.equal(out?.ownerActionNeeded, false);
  assert.doesNotMatch(out?.title ?? "", /retry|resum/i);
});

function backlog(overrides: Partial<RefDetailGapBacklog> = {}): RefDetailGapBacklog {
  return {
    pending: 0,
    pending_is_floor: false,
    pending_other: 0,
    pending_other_is_floor: false,
    max_attempt_count: 0,
    next_attempt_at: null,
    recovered: null,
    ...overrides,
  };
}

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

const TERMINAL_GAP_JARGON_RE = /terminal gap/i;
const RECORDS_SAFE_RE = /stay valid|not current data loss/i;
const RECOVERY_POINTER_RE = /run|stream|recovery/i;
const RETRYABLE_REASSURANCE_RE = /later run|no owner action|stay valid/i;

test("terminal_gap copy reassures records are safe and points at a recovery step (report 3)", () => {
  // The owner reported "Coverage · terminal gap" was unclear: it did not say
  // what terminated, whether records are safe, or how to recover. The chip
  // value drops the jargon; the title carries the three required signals.
  const chip = formatCoverageAxis("terminal_gap");
  assert.equal(chip.tone, "danger");
  assert.doesNotMatch(chip.value, TERMINAL_GAP_JARGON_RE);
  // Records-safe reassurance (not current data loss).
  assert.match(chip.title, RECORDS_SAFE_RE);
  // A concrete recovery pointer (the latest run / affected streams).
  assert.match(chip.title, RECOVERY_POINTER_RE);
});

test("retryable_gap copy reassures no owner action is needed yet (report 3)", () => {
  const chip = formatCoverageAxis("retryable_gap");
  assert.equal(chip.tone, "warning");
  assert.match(chip.title, RETRYABLE_REASSURANCE_RE);
});

test("axis chips degrade safely when runtime axes are missing or novel", () => {
  // A novel outbox value is not a concrete verdict (stalled/active/idle), so for
  // a non-local connection it is suppressed like the absence-default `unknown`.
  const out = summarizeAxisChips({
    attention: "none",
    coverage: "future_gap",
    freshness: undefined,
    outbox: "future_outbox",
  } as unknown as RefConnectionHealthSnapshot["axes"]);
  assert.equal(out.length, 2);
  assert.deepEqual(
    out.map((c) => c.label),
    ["Coverage · unknown", "Freshness · unknown"]
  );
  assert.equal(
    out.every((c) => c.tone === "neutral"),
    true
  );
});

test("axis chips: a novel outbox value still degrades to neutral 'unknown' for a local-backed connection", () => {
  const out = summarizeAxisChips(
    {
      attention: "none",
      coverage: "future_gap",
      freshness: undefined,
      outbox: "future_outbox",
    } as unknown as RefConnectionHealthSnapshot["axes"],
    { isLocalDeviceBacked: true }
  );
  // Local-backed: the outbox axis is applicable. A novel (non-"unknown") value
  // degrades through formatOutboxAxis to the neutral unknown fallback chip; the
  // "evidence unavailable" sharpening only applies to a literal `unknown` axis.
  assert.equal(out.length, 3);
  assert.equal(out[2]?.label, "Outbox · unknown");
  assert.equal(out[2]?.tone, "neutral");
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

test("outbox active is colour-coded as a progressing (non-neutral) state", () => {
  // Report 2 (2026-06-01): `Outbox · active` previously shared the muted
  // `neutral` tone with `unknown`, so a draining outbox was visually
  // indistinguishable from one whose evidence we could not read. It must now
  // carry a distinct, non-neutral tone.
  const active = formatOutboxAxis("active");
  assert.equal(active.tone, "success");
  assert.notEqual(active.tone, "neutral");
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

const OUTBOX_NOT_DATA_LOSS_RE = /not a current data-loss signal/i;

// ─── outbox applicability gate (report 1) ─────────────────────────────────
//
// The reference defaults `outbox: "unknown"` for every non-local connection
// (no device-exporter heartbeats). The console must NOT render that as an
// "Outbox · unknown" chip on API/browser connectors. It renders only for
// local/device-backed connections, or when the axis carries a real verdict.

test("outboxAxisIsApplicable: concrete verdicts always apply, even for non-local", () => {
  for (const axis of ["stalled", "active", "idle"] as const) {
    assert.equal(outboxAxisIsApplicable(axis, false), true, `verdict ${axis} should apply`);
  }
});

test("outboxAxisIsApplicable: unknown applies only for local-device-backed connections", () => {
  assert.equal(outboxAxisIsApplicable("unknown", false), false);
  assert.equal(outboxAxisIsApplicable("unknown", true), true);
  // A novel / absent value behaves like unknown.
  assert.equal(outboxAxisIsApplicable("future_outbox", false), false);
  assert.equal(outboxAxisIsApplicable(null, false), false);
  assert.equal(outboxAxisIsApplicable(undefined, true), true);
});

test("summarizeAxisChips omits the outbox chip for a non-local connection with unknown outbox", () => {
  // The exact owner-reported defect: a Gmail/Chase-class connection shows
  // "Outbox · unknown" purely because the reference has no heartbeats for it.
  const out = summarizeAxisChips(
    snapshot({ axes: { coverage: "complete", freshness: "fresh", attention: "none", outbox: "unknown" } }).axes,
    { isLocalDeviceBacked: false }
  );
  assert.equal(out.length, 2);
  assert.equal(
    out.some((c) => c.dimension === "Outbox"),
    false
  );
});

test("summarizeAxisChips keeps the outbox chip for a local-backed connection with unknown outbox, sharpened to 'evidence unavailable'", () => {
  const out = summarizeAxisChips(
    snapshot({ axes: { coverage: "complete", freshness: "fresh", attention: "none", outbox: "unknown" } }).axes,
    { isLocalDeviceBacked: true }
  );
  assert.equal(out.length, 3);
  const outbox = out.find((c) => c.dimension === "Outbox");
  assert.ok(outbox);
  assert.equal(outbox?.label, "Outbox · evidence unavailable");
  // Still neutral — an unreadable outbox is not a current data-loss signal.
  assert.equal(outbox?.tone, "neutral");
  assert.match(outbox?.title ?? "", OUTBOX_NOT_DATA_LOSS_RE);
});

test("summarizeAxisChips shows a stalled outbox even for a non-local connection (concrete verdict wins)", () => {
  // Defensive: if the reference ever projects a real stalled verdict without a
  // local_device_progress row, the danger signal must not be hidden.
  const out = summarizeAxisChips(
    snapshot({ axes: { coverage: "complete", freshness: "fresh", attention: "none", outbox: "stalled" } }).axes,
    { isLocalDeviceBacked: false }
  );
  const outbox = out.find((c) => c.dimension === "Outbox");
  assert.ok(outbox);
  assert.equal(outbox?.tone, "danger");
});

test("summarizeAxisChips shows a colour-coded active outbox for a local-backed connection", () => {
  const out = summarizeAxisChips(
    snapshot({ axes: { coverage: "complete", freshness: "fresh", attention: "none", outbox: "active" } }).axes,
    { isLocalDeviceBacked: true }
  );
  const outbox = out.find((c) => c.dimension === "Outbox");
  assert.equal(outbox?.value, "active");
  assert.equal(outbox?.tone, "success");
});

test("summarizeAxisChips defaults to omitting an unknown outbox when no local-backing signal is passed", () => {
  // Back-compat: callers that have not threaded the signal get the honest
  // (non-local) default — an absence-default unknown outbox is suppressed.
  const out = summarizeAxisChips(
    snapshot({ axes: { coverage: "complete", freshness: "fresh", attention: "none", outbox: "unknown" } }).axes
  );
  assert.equal(
    out.some((c) => c.dimension === "Outbox"),
    false
  );
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

// ─── syncStartFailureLead (report 5) ──────────────────────────────────────
//
// A failed `Sync now` must stay a row-local toast that tells the owner whether
// the run-start request reached the reference server, never fall through to the
// dashboard error boundary.

const LEAD_UNREACHABLE_RE = /reach the reference server/i;
const LEAD_DID_NOT_START_RE = /did not start/i;
const LEAD_REJECTED_RE = /reference server rejected/i;

test("syncStartFailureLead distinguishes a before-server (unreachable) failure", () => {
  const lead = syncStartFailureLead("before_server");
  assert.match(lead, LEAD_UNREACHABLE_RE);
  assert.match(lead, LEAD_DID_NOT_START_RE);
});

test("syncStartFailureLead distinguishes an after-server (rejected) failure", () => {
  const lead = syncStartFailureLead("after_server");
  assert.match(lead, LEAD_REJECTED_RE);
  assert.match(lead, LEAD_DID_NOT_START_RE);
  // The two phases must read differently so the owner knows where the failure
  // happened.
  assert.notEqual(lead, syncStartFailureLead("before_server"));
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

test("summarizeSchedule labels a source-pressure cooldown without inventing failures", () => {
  // The cross-run source-pressure cooldown sets `backoff_applied: true` with
  // `reason_class: "source_pressure"` and `consecutive_failures: 0` (the run
  // succeeded). The label must not read as "0 consecutive failures."
  const out = summarizeSchedule(
    baseSchedule({
      scheduler_backoff: {
        backoff_applied: true,
        consecutive_failures: 0,
        next_run_at: "2026-05-19T13:00:00Z",
        reason_class: "source_pressure",
        recommended_health_state: "cooling_off",
      },
    })
  );
  assert.ok(out);
  assert.match(out.backoffLabel ?? "", /source pressure/i);
  assert.match(out.backoffLabel ?? "", /progress retained/i);
  assert.doesNotMatch(out.backoffLabel ?? "", /failure/i);
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

// Phase-2 healthy-headline honesty: a stale healthy connection must not claim
// its data is current. Regexes hoisted to module scope (lint: useTopLevelRegex).
const CURRENT_AND_COMPLETE_RE = /current and complete/i;
const FRESHNESS_DUE_RE = /freshness window|refresh is due/i;

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

test("deriveConnectionStatusDisplay: stale-but-healthy connection does not claim its data is current (phase 2 lie fix)", () => {
  // An assisted scheduled connector can project `healthy` while its freshness
  // axis is `stale` (awaiting a scheduled refresh; see `stale_assisted_refresh`).
  // The old copy hardcoded "Required coverage is current and complete", which
  // lies — the data is NOT current. The headline must disclose the staleness.
  const out = deriveConnectionStatusDisplay({
    hasDurableProgress: true,
    health: snapshot({
      state: "healthy",
      axes: { coverage: "complete", freshness: "stale", attention: "none", outbox: "idle" },
    }),
    localDeviceProgress: null,
  });
  assert.equal(out.label, "Healthy");
  assert.equal(out.tone, "success");
  // Still claims completeness (the healthy state earns it) but NOT currency.
  assert.doesNotMatch(out.title, CURRENT_AND_COMPLETE_RE);
  assert.match(out.title, FRESHNESS_DUE_RE);
});

test("deriveConnectionStatusDisplay: fresh-and-healthy connection still reads current and complete", () => {
  const out = deriveConnectionStatusDisplay({
    hasDurableProgress: true,
    health: snapshot({
      state: "healthy",
      axes: { coverage: "complete", freshness: "fresh", attention: "none", outbox: "idle" },
    }),
    localDeviceProgress: null,
  });
  assert.match(out.title, CURRENT_AND_COMPLETE_RE);
});

test("synthesizeConnectionVerdict: stale-but-healthy connection does not claim its data is current (phase 2 lie fix)", () => {
  const verdict = synthesizeConnectionVerdict(
    snapshot({
      state: "healthy",
      axes: { coverage: "complete", freshness: "stale", attention: "none", outbox: "idle" },
    })
  );
  assert.equal(verdict.badgeState, "healthy");
  assert.doesNotMatch(verdict.runbook, CURRENT_AND_COMPLETE_RE);
  assert.match(verdict.runbook, FRESHNESS_DUE_RE);
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

test("deriveConnectionStatusDisplay: source-pressure cooling_off reads as catch-up, never a raw token", () => {
  const out = deriveConnectionStatusDisplay({
    hasDurableProgress: true,
    health: snapshot({ state: "cooling_off", reason_code: "source_pressure" }),
    localDeviceProgress: null,
  });
  assert.equal(out.label, "Cooling off");
  assert.equal(out.tone, "warning");
  assert.match(out.title, /source pressure/i);
  assert.match(out.title, /retain/i);
  // The internal snake_case token must never leak into operator-facing copy.
  assert.doesNotMatch(out.title, /source_pressure/);
  assert.doesNotMatch(out.title, /failure/i);
});

test("deriveConnectionStatusDisplay: failure-backoff cooling_off keeps the retry-wait copy", () => {
  const out = deriveConnectionStatusDisplay({
    hasDurableProgress: true,
    health: snapshot({ state: "cooling_off", reason_code: "scheduler_backoff_active" }),
    localDeviceProgress: null,
  });
  assert.equal(out.label, "Cooling off");
  assert.match(out.title, /next retry/i);
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

test("deriveConnectionStatusDisplay: degraded with retryable coverage reads as Resuming", () => {
  const out = deriveConnectionStatusDisplay({
    hasDurableProgress: true,
    health: snapshot({
      state: "degraded",
      axes: { coverage: "retryable_gap", freshness: "unknown", attention: "none", outbox: "unknown" },
    }),
    localDeviceProgress: null,
  });
  assert.equal(out.label, "Resuming");
  assert.equal(out.tone, "warning");
  assert.equal(out.shape, "diamond");
  assert.match(out.title, /recoverable/i);
  assert.match(out.title, /stay valid/i);
  assert.doesNotMatch(out.title, /no owner action/i);
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
const HOW_MUCH_IS_LEFT_RE = /how much is left/i;
const RESUMES_AFTER_RE = /resumes after/;
const AT_LEAST_100_RE = /at least 100 detail items/;
const BACKLOG_NOT_BROKEN_RE = /broken|error|fail/i;

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

test("cooling_off with no source-pressure reason still reads as failure backoff", () => {
  // The default `reason_code` is null (a failure-backoff cooldown), so the copy
  // must remain the failure-detail framing — not source pressure.
  const out = deriveConnectionNextStep({
    hasDominantCondition: false,
    hasStructuredNextAction: false,
    health: snapshot({ state: "cooling_off", next_attempt_at: "2026-05-19T13:00:00Z" }),
    supportsOwnerSync: true,
  });
  assert.ok(out);
  assert.match(out?.detail ?? "", /failure/i);
  assert.doesNotMatch(out?.detail ?? "", /source/i);
});

test("source-pressure cooling_off reads as catching up, not a failure", () => {
  // ChatGPT's large-history catch-up: the run succeeded but deferred the rest as
  // resumable gaps under upstream throttling. The reference stamps
  // `reason_code: "source_pressure"`. The guidance must NOT call this a failure
  // or "scheduler backoff after recent failures," and must say progress is kept.
  const out = deriveConnectionNextStep({
    hasDominantCondition: false,
    hasStructuredNextAction: false,
    health: snapshot({
      state: "cooling_off",
      reason_code: "source_pressure",
      next_attempt_at: "2026-05-19T13:00:00Z",
    }),
    supportsOwnerSync: true,
  });
  assert.ok(out);
  assert.equal(out?.tone, "warning");
  assert.match(out?.detail ?? "", COOLING_OFF_NEXT_ATTEMPT_RE);
  assert.match(out?.detail ?? "", /throttl|source/i);
  assert.match(out?.detail ?? "", /retain|catch/i);
  assert.doesNotMatch(out?.detail ?? "", /failure/i);
  assert.doesNotMatch(out?.label ?? "", /retry/i);
});

test("source-pressure cooling_off without a next attempt still reads as catching up", () => {
  const out = deriveConnectionNextStep({
    hasDominantCondition: false,
    hasStructuredNextAction: false,
    health: snapshot({ state: "cooling_off", reason_code: "source_pressure", next_attempt_at: null }),
    supportsOwnerSync: true,
  });
  assert.ok(out);
  assert.match(out?.detail ?? "", /throttl|source/i);
  assert.doesNotMatch(out?.detail ?? "", /failure/i);
});

// ─── source-pressure detail-gap backlog cue ───────────────────────────────
//
// The reference's additive `detail_gap_backlog` rollup turns the old, unkeepable
// "open the connection to see how much is left" into a concrete, honest cue on
// the source-pressure paths (`cooling_off` under `source_pressure` and
// `degraded` + `retryable_gap`). The cue MUST:
//   - never invent a count (a `null`/absent rollup yields no `backlogScale`);
//   - present a bounded read as a floor ("at least N"), never as exact;
//   - read a drained backlog as caught-up, not broken;
//   - show the backlog's own retry floor as a resume time, not a completion
//     promise.

test("source-pressure cooling_off attaches a backlog count plus the backlog's own resume floor", () => {
  // The resume floor sourced into the cue is the *backlog's* `next_attempt_at`
  // (its Retry-After / cooldown), not the connection-level scheduler dispatch —
  // the contract keeps them separate so a manual connector can carry a backlog
  // retry floor even when its scheduler `next_attempt_at` is null.
  const out = deriveConnectionNextStep({
    hasDominantCondition: false,
    hasStructuredNextAction: false,
    health: snapshot({
      state: "cooling_off",
      reason_code: "source_pressure",
      next_attempt_at: "2026-05-19T13:00:00Z",
      detail_gap_backlog: backlog({ pending: 42, next_attempt_at: "2026-05-19T13:30:00Z" }),
    }),
    supportsOwnerSync: true,
  });
  assert.ok(out);
  assert.equal(out?.backlogScale, "42 detail items to catch up · resumes after 2026-05-19T13:30:00Z");
  // The unkeepable "see how much is left to catch up" promise is gone from the
  // detail copy now that the count is carried by the cue.
  assert.doesNotMatch(out?.detail ?? "", HOW_MUCH_IS_LEFT_RE);
});

test("the backlog resume floor is independent of the connection-level scheduler dispatch", () => {
  // Manual connector: scheduler `next_attempt_at` is null, but the backlog still
  // carries its own Retry-After floor. The cue must show the backlog floor.
  const out = deriveConnectionNextStep({
    hasDominantCondition: false,
    hasStructuredNextAction: false,
    health: snapshot({
      state: "cooling_off",
      reason_code: "source_pressure",
      next_attempt_at: null,
      detail_gap_backlog: backlog({ pending: 8, next_attempt_at: "2026-05-19T14:00:00Z" }),
    }),
    supportsOwnerSync: true,
  });
  assert.ok(out);
  assert.equal(out?.backlogScale, "8 detail items to catch up · resumes after 2026-05-19T14:00:00Z");
});

test("source-pressure backlog with a bounded read reads as a floor, never exact", () => {
  const out = deriveConnectionNextStep({
    hasDominantCondition: false,
    hasStructuredNextAction: false,
    health: snapshot({
      state: "cooling_off",
      reason_code: "source_pressure",
      next_attempt_at: null,
      detail_gap_backlog: backlog({ pending: 100, pending_is_floor: true }),
    }),
    supportsOwnerSync: true,
  });
  assert.ok(out);
  assert.match(out?.backlogScale ?? "", AT_LEAST_100_RE);
  // No backlog-level retry floor → no "resumes after" overpromise.
  assert.doesNotMatch(out?.backlogScale ?? "", RESUMES_AFTER_RE);
});

test("an unreadable backlog rollup never invents a count", () => {
  const out = deriveConnectionNextStep({
    hasDominantCondition: false,
    hasStructuredNextAction: false,
    health: snapshot({
      state: "cooling_off",
      reason_code: "source_pressure",
      next_attempt_at: "2026-05-19T13:00:00Z",
      detail_gap_backlog: null,
    }),
    supportsOwnerSync: true,
  });
  assert.ok(out);
  assert.equal(out?.backlogScale, null);
});

test("a drained backlog with recoveries reads as caught up, not broken", () => {
  const out = deriveConnectionNextStep({
    hasDominantCondition: false,
    hasStructuredNextAction: false,
    health: snapshot({
      state: "cooling_off",
      reason_code: "source_pressure",
      next_attempt_at: null,
      detail_gap_backlog: backlog({ pending: 0, recovered: 17 }),
    }),
    supportsOwnerSync: true,
  });
  assert.ok(out);
  assert.equal(out?.backlogScale, "caught up — 17 recovered");
  assert.doesNotMatch(out?.backlogScale ?? "", BACKLOG_NOT_BROKEN_RE);
});

test("a drained backlog with no recovery aggregate still reads as caught up (real 0, not null)", () => {
  const out = deriveConnectionNextStep({
    hasDominantCondition: false,
    hasStructuredNextAction: false,
    health: snapshot({
      state: "cooling_off",
      reason_code: "source_pressure",
      next_attempt_at: null,
      detail_gap_backlog: backlog({ pending: 0, recovered: null }),
    }),
    supportsOwnerSync: true,
  });
  assert.ok(out);
  assert.equal(out?.backlogScale, "caught up");
});

test("a source-pressure-drained backlog does not say caught up when other detail gaps remain", () => {
  const out = deriveConnectionNextStep({
    hasDominantCondition: false,
    hasStructuredNextAction: false,
    health: snapshot({
      state: "cooling_off",
      reason_code: "source_pressure",
      next_attempt_at: null,
      detail_gap_backlog: backlog({ pending: 0, pending_other: 1899, pending_other_is_floor: true }),
    }),
    supportsOwnerSync: true,
  });
  assert.ok(out);
  assert.equal(out?.backlogScale, "at least 1,899 other detail items still pending");
  assert.notEqual(out?.backlogScale, "caught up");
});

test("degraded+retryable_gap manual path carries the backlog count", () => {
  const out = deriveConnectionNextStep({
    hasDominantCondition: false,
    hasStructuredNextAction: false,
    health: snapshot({
      state: "degraded",
      next_attempt_at: null,
      axes: { coverage: "retryable_gap", freshness: "unknown", attention: "none", outbox: "unknown" },
      detail_gap_backlog: backlog({ pending: 3 }),
    }),
    supportsOwnerSync: true,
  });
  assert.ok(out);
  assert.equal(out?.label, "Continue the sync");
  assert.equal(out?.backlogScale, "3 detail items to catch up");
});

test("a singular pending gap uses singular noun", () => {
  const out = deriveConnectionNextStep({
    hasDominantCondition: false,
    hasStructuredNextAction: false,
    health: snapshot({
      state: "degraded",
      next_attempt_at: null,
      axes: { coverage: "retryable_gap", freshness: "unknown", attention: "none", outbox: "idle" },
      detail_gap_backlog: backlog({ pending: 1 }),
    }),
    supportsOwnerSync: false,
  });
  assert.ok(out);
  assert.equal(out?.backlogScale, "1 detail item to catch up");
});

test("the device-outbox scale and the source-pressure backlog scale never collide on one row", () => {
  // The cooling-off / retryable-gap source-pressure paths carry a backlog scale
  // but no device-outbox scale; the stalled-outbox path carries the device scale
  // but no backlog scale. They are distinct slots and must not cross-render.
  const sourcePressure = deriveConnectionNextStep({
    hasDominantCondition: false,
    hasStructuredNextAction: false,
    health: snapshot({
      state: "cooling_off",
      reason_code: "source_pressure",
      detail_gap_backlog: backlog({ pending: 5 }),
    }),
    supportsOwnerSync: true,
  });
  assert.ok(sourcePressure?.backlogScale);
  assert.equal(sourcePressure?.scale, null);
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

test("degraded+retryable_gap with owner sync offers a non-alarming way to continue", () => {
  const out = deriveConnectionNextStep({
    hasDominantCondition: false,
    hasStructuredNextAction: false,
    health: snapshot({
      state: "degraded",
      next_attempt_at: null,
      axes: { coverage: "retryable_gap", freshness: "unknown", attention: "none", outbox: "unknown" },
    }),
    supportsOwnerSync: true,
  });
  assert.ok(out, "owner-syncable retryable_gap must offer a next step, not null");
  assert.equal(out?.label, "Continue the sync");
  assert.match(out?.detail ?? "", /stay valid/i);
  assert.doesNotMatch(out?.detail ?? "", /corrupt|failed/i);
});

test("degraded+retryable_gap without owner sync points at the collector host", () => {
  const out = deriveConnectionNextStep({
    hasDominantCondition: false,
    hasStructuredNextAction: false,
    health: snapshot({
      state: "degraded",
      next_attempt_at: null,
      axes: { coverage: "retryable_gap", freshness: "unknown", attention: "none", outbox: "idle" },
    }),
    supportsOwnerSync: false,
  });
  assert.ok(out, "push-mode retryable_gap must offer collector guidance, not null");
  assert.equal(out?.label, "Check the collector");
  assert.match(out?.detail ?? "", /host/i);
  assert.match(out?.detail ?? "", /stay valid/i);
});

test("degraded+retryable_gap suppresses the CTA only when an automatic attempt is scheduled", () => {
  const out = deriveConnectionNextStep({
    hasDominantCondition: false,
    hasStructuredNextAction: false,
    health: snapshot({
      state: "degraded",
      next_attempt_at: "2026-05-19T13:00:00Z",
      axes: { coverage: "retryable_gap", freshness: "unknown", attention: "none", outbox: "unknown" },
    }),
    supportsOwnerSync: true,
  });
  assert.equal(out, null);
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

// ─── deriveConnectionNextStep: stalled-row count-backed scale ──────────────
//
// The records-list row surfaces a compact count cue ONLY on the stalled-outbox
// next step, and only when the connection summary carries a non-null
// `outbox_counts` rollup with at least one positive stuck-work category. Every
// other guidance — and a stalled outbox with no counts — carries `scale: null`
// so quiet/healthy/active/unknown rows never grow a numeric cue.

function stalledHealth(): RefConnectionHealthSnapshot {
  return snapshot({
    state: "degraded",
    axes: { coverage: "complete", freshness: "fresh", attention: "none", outbox: "stalled" },
  });
}

function localDeviceProgress(outboxCounts: Record<string, number | string | null> | null) {
  return {
    last_heartbeat_at: "2026-05-19T11:55:00Z",
    last_heartbeat_status: "blocked",
    last_ingest_at: null,
    outbox_counts: outboxCounts,
    records_pending: 12,
    source_count: 1,
  } as Parameters<typeof deriveConnectionNextStep>[0]["localDeviceProgress"];
}

test("stalled-row guidance carries a count-backed scale from outbox_counts", () => {
  const out = deriveConnectionNextStep({
    hasDominantCondition: false,
    hasStructuredNextAction: false,
    health: stalledHealth(),
    localDeviceProgress: localDeviceProgress({ pending: 12, dead_letter: 2, stale_leases: 1, total: 15 }),
    supportsOwnerSync: false,
  });
  assert.ok(out);
  assert.equal(out?.tone, "danger");
  assert.match(out?.label ?? "", HOST_RE);
  assert.equal(out?.scale, "12 pending · 1 stale lease · 2 dead-letter");
});

test("stalled-row scale omits zero categories so a counted rollup never reads as alarming", () => {
  const out = deriveConnectionNextStep({
    hasDominantCondition: false,
    hasStructuredNextAction: false,
    health: stalledHealth(),
    localDeviceProgress: localDeviceProgress({ pending: 0, dead_letter: 3, stale_leases: 0, total: 3 }),
    supportsOwnerSync: false,
  });
  assert.equal(out?.scale, "3 dead-letter");
});

test("stalled-row scale is null when the summary carries no count rollup", () => {
  // Stalled but no outbox_counts: the host guidance still renders, but the cue
  // is suppressed so the row never shows a misleading "0".
  const noCounts = deriveConnectionNextStep({
    hasDominantCondition: false,
    hasStructuredNextAction: false,
    health: stalledHealth(),
    localDeviceProgress: localDeviceProgress(null),
    supportsOwnerSync: false,
  });
  assert.ok(noCounts);
  assert.equal(noCounts?.scale, null);

  // Stalled with no local-device progress at all (scheduler-managed): same.
  const noProgress = deriveConnectionNextStep({
    hasDominantCondition: false,
    hasStructuredNextAction: false,
    health: stalledHealth(),
    supportsOwnerSync: true,
  });
  assert.ok(noProgress);
  assert.equal(noProgress?.scale, null);
});

test("stalled-row scale is null when every stuck-work category is zero", () => {
  // succeeded/total are present but no decision-relevant stuck work — the cue
  // must not appear just because the rollup is non-null.
  const out = deriveConnectionNextStep({
    hasDominantCondition: false,
    hasStructuredNextAction: false,
    health: stalledHealth(),
    localDeviceProgress: localDeviceProgress({ pending: 0, dead_letter: 0, stale_leases: 0, succeeded: 40, total: 40 }),
    supportsOwnerSync: false,
  });
  assert.equal(out?.scale, null);
});

test("non-stalled guidance never carries a count scale, even with a populated rollup", () => {
  // A populated rollup on an idle/active/unknown outbox must not leak a cue into
  // a non-stalled guidance row. These states either return null guidance or a
  // guidance with scale=null.
  for (const outbox of ["idle", "active", "unknown"] as const) {
    const out = deriveConnectionNextStep({
      hasDominantCondition: false,
      hasStructuredNextAction: false,
      health: snapshot({
        // freshness=stale forces a non-null guidance (Sync now / collector) so
        // we can assert scale is still null on that non-stalled path.
        state: "degraded",
        axes: { coverage: "complete", freshness: "stale", attention: "none", outbox },
      }),
      localDeviceProgress: localDeviceProgress({ pending: 9, dead_letter: 4, total: 13 }),
      supportsOwnerSync: false,
    });
    assert.ok(out, `expected guidance for outbox=${outbox}`);
    assert.equal(out?.scale, null, `expected scale=null for non-stalled outbox=${outbox}`);
  }
});

test("a stalled outbox attaches the scale even when a dominant condition is present", () => {
  // Action-bearing stalled guidance is not suppressed by a dominant-condition
  // notice, and it keeps its count cue — the condition message has no count.
  const out = deriveConnectionNextStep({
    hasDominantCondition: true,
    hasStructuredNextAction: false,
    health: stalledHealth(),
    localDeviceProgress: localDeviceProgress({ pending: 5, total: 5 }),
    supportsOwnerSync: false,
  });
  assert.ok(out);
  assert.equal(out?.scale, "5 pending");
});

// ─── derivePrimaryRowAction: the row's modality-aware primary action ───────
//
// "Sync now" starts an owner-controlled connector run. Existing browser-bound
// connections are owner-runnable and may surface manual browser assistance after
// the run starts. Push-mode (local-device progress) connections still get a
// "wait for the device" status instead of a dead remote-run button.

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

test("derivePrimaryRowAction keeps Sync now for an existing browser-bound connection", () => {
  assert.equal(derivePrimaryRowAction({ connectorId: "chatgpt", hasLocalDeviceProgress: false }).kind, "sync");
  assert.equal(derivePrimaryRowAction({ connectorId: "amazon", hasLocalDeviceProgress: false }).kind, "sync");
});

test("derivePrimaryRowAction disables ordinary sync during source-pressure cooldown", () => {
  const action = derivePrimaryRowAction({
    connectorId: "chatgpt",
    health: snapshot({
      state: "cooling_off",
      reason_code: "source_pressure",
      next_attempt_at: "2026-06-10T22:30:00.000Z",
    }),
    hasLocalDeviceProgress: false,
  });
  assert.equal(action.kind, "cooldown_wait");
  if (action.kind === "cooldown_wait") {
    assert.equal(action.label, "Cooling off");
    assert.match(action.detail, /2026-06-10T22:30:00\.000Z/);
    assert.match(action.detail, /retained/i);
  }
});

test("derivePrimaryRowAction disables ordinary sync when source-pressure backlog coexists with a blocked headline state", () => {
  const action = derivePrimaryRowAction({
    connectorId: "chatgpt",
    health: snapshot({
      state: "blocked",
      reason_code: "connector_reported_failed",
      next_attempt_at: "2026-06-11T14:17:24.984Z",
      detail_gap_backlog: backlog({
        pending: 100,
        pending_is_floor: true,
        max_attempt_count: 10,
      }),
    }),
    hasLocalDeviceProgress: false,
  });
  assert.equal(action.kind, "cooldown_wait");
  if (action.kind === "cooldown_wait") {
    assert.equal(action.label, "Cooling off");
    assert.ok(action.detail.includes("at least 100 pending provider-pressure gaps"));
    assert.ok(action.detail.includes("ordinary sync may be rejected"));
    assert.ok(action.detail.includes("retained"));
  }
});

test("derivePrimaryRowAction keeps ordinary sync for non-pressure cooling-off", () => {
  const action = derivePrimaryRowAction({
    connectorId: "github",
    health: snapshot({ state: "cooling_off", reason_code: "scheduler_backoff_active" }),
    hasLocalDeviceProgress: false,
  });
  assert.equal(action.kind, "sync");
});

test("derivePrimaryRowAction keeps local-device push mode non-clickable even for a browser-bound key", () => {
  const action = derivePrimaryRowAction({ connectorId: "chase", hasLocalDeviceProgress: true });
  assert.equal(action.kind, "device_wait");
});

test("derivePrimaryRowAction defaults to sync for an unknown connector with no device progress", () => {
  // Unknown/no-data owner-syncable rows: the clickable Sync now IS the honest
  // next step. The false-affordance suppression only fires for push-mode
  // local-device connections.
  assert.equal(derivePrimaryRowAction({ connectorId: "demo", hasLocalDeviceProgress: false }).kind, "sync");
  assert.equal(derivePrimaryRowAction({ connectorId: null, hasLocalDeviceProgress: false }).kind, "sync");
  assert.equal(derivePrimaryRowAction({ connectorId: undefined, hasLocalDeviceProgress: false }).kind, "sync");
});

test("syncActionIdleLabel names failed and cancelled runs as retries", () => {
  assert.equal(syncActionIdleLabel("failed"), "Retry sync");
  assert.equal(syncActionIdleLabel("cancelled"), "Retry sync");
  assert.equal(syncActionIdleLabel("canceled"), "Retry sync");
});

test("syncActionIdleLabel keeps non-failed idle sync copy", () => {
  assert.equal(syncActionIdleLabel("succeeded"), "Sync now");
  assert.equal(syncActionIdleLabel("started"), "Sync now");
  assert.equal(syncActionIdleLabel(null), "Sync now");
  assert.equal(syncActionIdleLabel(undefined), "Sync now");
});

// ─── deriveFailureSummary ─────────────────────────────────────────────────────

// Top-level regex constants for useTopLevelRegex compliance
const PROSE_GAP_RE = /gap/i;
const PROSE_INCOMPLETE_RE = /incomplete/i;
const PROSE_THROTTLE_RE = /throttl/i;
const PROSE_BACKOFF_RE = /back-off|backoff|retry/i;
const PROSE_RECONNECT_RE = /reconnect/i;

test("deriveFailureSummary returns null for healthy state", () => {
  assert.equal(deriveFailureSummary(snapshot({ state: "healthy" })), null);
});

test("deriveFailureSummary returns null for idle state", () => {
  assert.equal(deriveFailureSummary(snapshot({ state: "idle" })), null);
});

test("deriveFailureSummary returns null for null input", () => {
  assert.equal(deriveFailureSummary(null), null);
});

test("deriveFailureSummary degraded → 'What's missing?' trigger, view_runs CTA", () => {
  const result = deriveFailureSummary(
    snapshot({ state: "degraded", axes: { coverage: "gaps", freshness: "fresh", attention: "none", outbox: "idle" } })
  );
  assert.ok(result);
  assert.equal(result.triggerLabel, "What's missing?");
  assert.equal(result.cta, "view_runs");
  assert.match(result.prose, PROSE_GAP_RE);
});

test("deriveFailureSummary degraded with complete coverage → generic prose", () => {
  const result = deriveFailureSummary(
    snapshot({
      state: "degraded",
      axes: { coverage: "complete", freshness: "stale", attention: "none", outbox: "idle" },
    })
  );
  assert.ok(result);
  assert.equal(result.triggerLabel, "What's missing?");
  assert.match(result.prose, PROSE_INCOMPLETE_RE);
});

test("deriveFailureSummary cooling_off source_pressure → honest prose about throttling", () => {
  const result = deriveFailureSummary(snapshot({ state: "cooling_off", reason_code: "source_pressure" }));
  assert.ok(result);
  assert.equal(result.triggerLabel, "What's wrong?");
  assert.equal(result.cta, "wait");
  assert.match(result.prose, PROSE_THROTTLE_RE);
});

test("deriveFailureSummary cooling_off failure back-off → retry prose", () => {
  const result = deriveFailureSummary(snapshot({ state: "cooling_off", reason_code: "reddit_login_unexpected_ui" }));
  assert.ok(result);
  assert.equal(result.cta, "wait");
  assert.match(result.prose, PROSE_BACKOFF_RE);
});

test("deriveFailureSummary blocked → reconnect CTA", () => {
  const result = deriveFailureSummary(snapshot({ state: "blocked" }));
  assert.ok(result);
  assert.equal(result.triggerLabel, "What's wrong?");
  assert.equal(result.cta, "reconnect");
  assert.match(result.prose, PROSE_RECONNECT_RE);
});

test("deriveFailureSummary needs_attention → reconnect CTA", () => {
  const result = deriveFailureSummary(snapshot({ state: "needs_attention" }));
  assert.ok(result);
  assert.equal(result.cta, "reconnect");
});

test("deriveFailureSummary passes through reason_code", () => {
  const result = deriveFailureSummary(snapshot({ state: "blocked", reason_code: "browser_context_died" }));
  assert.ok(result);
  assert.equal(result.reasonCode, "browser_context_died");
});

test("deriveFailureSummary passes through next_attempt_at", () => {
  const result = deriveFailureSummary(snapshot({ state: "cooling_off", next_attempt_at: "2026-05-15T15:36:00Z" }));
  assert.ok(result);
  assert.equal(result.nextAttemptAt, "2026-05-15T15:36:00Z");
});

test("deriveFailureSummary passes through last_success_at", () => {
  const result = deriveFailureSummary(snapshot({ state: "blocked", last_success_at: "2026-04-28T19:33:00Z" }));
  assert.ok(result);
  assert.equal(result.lastSuccessAt, "2026-04-28T19:33:00Z");
});

// §6.2 invariant: source-pressure blocked must NEVER emit cta:"reconnect".
// A blocked state whose root cause is source-pressure is self-resolving; a
// Reconnect CTA would direct the owner to a manual action that is unnecessary
// and confusing. deriveFailureSummary MUST apply the same isSourcePressureCooldown
// guard that synthesizeConnectionVerdict already applies. (spec §6.2)
test("deriveFailureSummary blocked + source_pressure reason_code → cta is 'wait', NOT 'reconnect'", () => {
  const result = deriveFailureSummary(snapshot({ state: "blocked", reason_code: "source_pressure" }));
  assert.ok(result);
  assert.notEqual(result.cta, "reconnect", "source-pressure blocked must not yield reconnect CTA");
  assert.equal(result.cta, "wait");
});

test("deriveFailureSummary blocked + backlog + next_attempt_at (inferred source-pressure) → cta is 'wait', NOT 'reconnect'", () => {
  // isSourcePressureCooldown also fires when there is a pending backlog AND a
  // scheduled next_attempt_at, even without an explicit reason_code. The
  // deriveFailureSummary blocked branch must honour the same inference.
  const result = deriveFailureSummary(
    snapshot({
      state: "blocked",
      reason_code: null,
      next_attempt_at: "2026-05-20T10:00:00Z",
      detail_gap_backlog: backlog({ pending: 5 }),
    })
  );
  assert.ok(result);
  assert.notEqual(result.cta, "reconnect", "inferred source-pressure blocked must not yield reconnect CTA");
  assert.equal(result.cta, "wait");
});

// §6.3 invariant: "done" (caught up) must be false when terminal > 0.
// If the backlog reports terminal gaps, the honest copy is NOT "caught up" but
// "recovered all still-available; N no longer retrievable." Emitting "caught up"
// while terminal>0 is a silent-lie per the red-team correction in §10-A.
const TERMINAL_CAVEAT_RE = /no longer retrievable|terminal|not retrievable/i;
const CAUGHT_UP_RE = /^caught up/;

test("§6.3 backlog with terminal>0 does NOT say 'caught up' — emits caveat about unretrievable items", () => {
  const out = deriveConnectionNextStep({
    hasDominantCondition: false,
    hasStructuredNextAction: false,
    health: snapshot({
      state: "cooling_off",
      reason_code: "source_pressure",
      next_attempt_at: null,
      detail_gap_backlog: backlog({ pending: 0, recovered: 10, terminal: 3 }),
    }),
    supportsOwnerSync: true,
  });
  assert.ok(out);
  assert.doesNotMatch(out?.backlogScale ?? "", CAUGHT_UP_RE, "must not claim caught up when terminal>0");
  assert.match(out?.backlogScale ?? "", TERMINAL_CAVEAT_RE, "must surface a caveat about unretrievable items");
});

test("§6.3 backlog with terminal===0 still says 'caught up' (no false caveat)", () => {
  const out = deriveConnectionNextStep({
    hasDominantCondition: false,
    hasStructuredNextAction: false,
    health: snapshot({
      state: "cooling_off",
      reason_code: "source_pressure",
      next_attempt_at: null,
      detail_gap_backlog: backlog({ pending: 0, recovered: 10, terminal: 0 }),
    }),
    supportsOwnerSync: true,
  });
  assert.ok(out);
  assert.match(out?.backlogScale ?? "", CAUGHT_UP_RE, "zero terminal must still say caught up");
});

// ─── deriveStreakDots ─────────────────────────────────────────────────────────

test("deriveStreakDots returns empty array for no runs", () => {
  assert.deepEqual(deriveStreakDots([]), []);
});

test("deriveStreakDots maps succeeded → ✓ success", () => {
  const dots = deriveStreakDots([{ status: "succeeded", first_at: "2026-05-15T00:00:00Z" }]);
  assert.equal(dots.length, 1);
  assert.ok(dots[0]);
  assert.equal(dots[0].symbol, "✓");
  assert.equal(dots[0].tone, "success");
});

test("deriveStreakDots maps failed → ✕ danger", () => {
  const dots = deriveStreakDots([
    { status: "failed", first_at: "2026-05-15T00:00:00Z", failure_reason: "browser_timeout" },
  ]);
  assert.ok(dots[0]);
  assert.equal(dots[0].symbol, "✕");
  assert.equal(dots[0].tone, "danger");
  assert.equal(dots[0].statusLabel, "browser_timeout");
});

test("deriveStreakDots maps cancelled → ⊘ neutral", () => {
  const dots = deriveStreakDots([{ status: "cancelled", first_at: "2026-05-15T00:00:00Z" }]);
  assert.ok(dots[0]);
  assert.equal(dots[0].symbol, "⊘");
  assert.equal(dots[0].tone, "neutral");
});

test("deriveStreakDots maps degraded → ⚠ warning", () => {
  const dots = deriveStreakDots([{ status: "degraded", first_at: "2026-05-15T00:00:00Z" }]);
  assert.ok(dots[0]);
  assert.equal(dots[0].symbol, "⚠");
  assert.equal(dots[0].tone, "warning");
});

test("deriveStreakDots caps at 14 runs", () => {
  const runs = Array.from({ length: 20 }, (_, i) => ({
    status: "succeeded",
    first_at: `2026-05-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
  }));
  assert.equal(deriveStreakDots(runs).length, 14);
});

test("deriveStreakDots preserves the at timestamp for tooltip", () => {
  const ts = "2026-05-15T13:00:00Z";
  const dots = deriveStreakDots([{ status: "succeeded", first_at: ts }]);
  assert.ok(dots[0]);
  assert.equal(dots[0].at, ts);
});

// ─── deriveAutoPausedBanner ───────────────────────────────────────────────────

test("deriveAutoPausedBanner returns null when no schedule", () => {
  assert.equal(deriveAutoPausedBanner(null), null);
  assert.equal(deriveAutoPausedBanner(undefined), null);
});

test("deriveAutoPausedBanner returns null when backoff not applied", () => {
  const schedule = {
    scheduler_backoff: {
      backoff_applied: false,
      consecutive_failures: 0,
      next_run_at: null,
      reason_class: null,
      recommended_health_state: null as "blocked" | "cooling_off" | null,
    },
  };
  assert.equal(deriveAutoPausedBanner(schedule), null);
});

test("deriveAutoPausedBanner returns null when scheduler_backoff is null", () => {
  assert.equal(deriveAutoPausedBanner({ scheduler_backoff: null }), null);
});

test("deriveAutoPausedBanner returns banner with consecutive failures and reason", () => {
  const schedule = {
    scheduler_backoff: {
      backoff_applied: true,
      consecutive_failures: 5,
      next_run_at: "2026-05-15T15:36:00Z",
      reason_class: "reddit_login_unexpected_ui",
      recommended_health_state: "cooling_off" as const,
    },
  };
  const banner = deriveAutoPausedBanner(schedule);
  assert.ok(banner);
  assert.equal(banner.consecutiveFailures, 5);
  assert.equal(banner.nextRunAt, "2026-05-15T15:36:00Z");
  assert.equal(banner.reasonLabel, "reddit login unexpected ui");
  assert.equal(banner.isTerminal, false);
});

test("deriveAutoPausedBanner marks terminal when recommended_health_state is blocked", () => {
  const schedule = {
    scheduler_backoff: {
      backoff_applied: true,
      consecutive_failures: 47,
      next_run_at: null,
      reason_class: "connector_reported_failed",
      recommended_health_state: "blocked" as const,
    },
  };
  const banner = deriveAutoPausedBanner(schedule);
  assert.ok(banner);
  assert.equal(banner.isTerminal, true);
});

test("deriveAutoPausedBanner handles null reason_class gracefully", () => {
  const schedule = {
    scheduler_backoff: {
      backoff_applied: true,
      consecutive_failures: 3,
      next_run_at: null,
      reason_class: null,
      recommended_health_state: "cooling_off" as const,
    },
  };
  const banner = deriveAutoPausedBanner(schedule);
  assert.ok(banner);
  assert.equal(banner.reasonLabel, null);
});

test("formatCollectionRateReadout degrades to null when no controller state is present (honest unknown)", () => {
  assert.equal(formatCollectionRateReadout(null), null, "null state → no false rate");
  assert.equal(formatCollectionRateReadout(undefined), null, "absent field → no false rate");
});

test("formatCollectionRateReadout surfaces current rate, ceiling, and last back-off", () => {
  const readout = formatCollectionRateReadout({
    ceiling_interval_ms: 250,
    ceiling_rate_per_min: 240,
    current_interval_ms: 500,
    effective_rate_per_min: 120,
    last_backoff: { at: null, at_interval_ms: 1000, reason: "throttle" },
  });
  assert.ok(readout);
  assert.match(readout.currentLabel, /120\/min/);
  assert.match(readout.currentLabel, /500ms/);
  assert.match(readout.ceilingLabel, /240\/min/);
  assert.equal(readout.backoffLabel, "last backed off to 1,000ms (throttle)");
});

test("formatCollectionRateReadout omits the back-off line when none has fired", () => {
  const readout = formatCollectionRateReadout({
    ceiling_interval_ms: 250,
    ceiling_rate_per_min: 240,
    current_interval_ms: 250,
    effective_rate_per_min: 240,
    last_backoff: null,
  });
  assert.ok(readout);
  assert.equal(readout.backoffLabel, null, "no back-off → no back-off line");
});

// ─── synthesizeConnectionVerdict: the single-voice "handling it" layer [SLVP §1.3]
//
// The decisive ChatGPT-card fix: a rate-limited connection whose root cause is a
// source-pressure cooldown must read as "handling it" (cooling off, warning,
// no button), NEVER as "broken" (blocked, danger). A genuine blocked connection
// (no cooldown) keeps its danger badge and reconnect CTA.

const DANGER_WORDS_RE = /broken|failed|error/i;

test("synthesizeConnectionVerdict: blocked + source_pressure reads as cooling off, NOT blocked", () => {
  // The live ChatGPT shape from Defect 4: the scheduler hit its retry threshold
  // (state projected `blocked`) but the root cause is a 429 source-pressure
  // cooldown — the last run succeeded and deferred detail as resumable gaps.
  const verdict = synthesizeConnectionVerdict(
    snapshot({
      state: "blocked",
      reason_code: "source_pressure",
      next_attempt_at: "2026-05-19T13:00:00Z",
      detail_gap_backlog: backlog({ pending: 137, pending_is_floor: true, next_attempt_at: "2026-05-19T13:00:00Z" }),
      axes: { coverage: "retryable_gap", freshness: "fresh", attention: "none", outbox: "idle" },
    })
  );
  // The badge is suppressed from blocked → cooling_off (warning, not danger).
  assert.equal(verdict.badgeState, "cooling_off");
  assert.equal(verdict.suppressedBlocked, true);
  // The system is handling it: no danger, no owner button.
  assert.equal(verdict.handlingItself, true);
  // One honest sentence: throttled, resuming on its own, data safe.
  assert.match(verdict.runbook, /throttled/i);
  assert.match(verdict.runbook, /no action needed/i);
  assert.match(verdict.runbook, /2026-05-19T13:00:00Z/);
  assert.doesNotMatch(verdict.runbook, DANGER_WORDS_RE);
});

test("synthesizeConnectionVerdict: cooling_off + source_pressure also reads as handling-it", () => {
  const verdict = synthesizeConnectionVerdict(
    snapshot({
      state: "cooling_off",
      reason_code: "source_pressure",
      next_attempt_at: "2026-05-19T14:00:00Z",
      detail_gap_backlog: backlog({ pending: 0, recovered: 12 }),
    })
  );
  assert.equal(verdict.badgeState, "cooling_off");
  assert.equal(verdict.handlingItself, true);
  assert.equal(verdict.suppressedBlocked, false, "the raw state was already cooling_off — nothing to suppress");
  assert.match(verdict.runbook, /no action needed/i);
});

test("synthesizeConnectionVerdict: a blocked + backlog + scheduled-retry connection is treated as a cooldown", () => {
  // No explicit source_pressure reason_code, but a pending backlog plus a
  // scheduled next attempt is a deferral, not a terminal stop.
  const verdict = synthesizeConnectionVerdict(
    snapshot({
      state: "blocked",
      reason_code: null,
      next_attempt_at: "2026-05-19T15:00:00Z",
      detail_gap_backlog: backlog({ pending: 40 }),
    })
  );
  assert.equal(verdict.badgeState, "cooling_off");
  assert.equal(verdict.suppressedBlocked, true);
  assert.equal(verdict.handlingItself, true);
});

test("synthesizeConnectionVerdict: genuine blocked (no cooldown) keeps danger + reconnect framing", () => {
  // Credential expiry / provider block: no source-pressure cooldown, no pending
  // backlog, no scheduled retry. This MUST stay blocked so the owner acts.
  const verdict = synthesizeConnectionVerdict(
    snapshot({
      state: "blocked",
      reason_code: "credentials_expired",
      next_attempt_at: null,
      detail_gap_backlog: null,
    })
  );
  assert.equal(verdict.badgeState, "blocked");
  assert.equal(verdict.handlingItself, false, "a genuinely blocked connection needs owner action");
  assert.equal(verdict.suppressedBlocked, false);
  assert.match(verdict.runbook, /reconnect/i);
});

test("synthesizeConnectionVerdict: needs_attention surfaces the dominant condition and needs action", () => {
  const verdict = synthesizeConnectionVerdict(snapshot({ state: "needs_attention", reason_code: "reauth_required" }));
  assert.equal(verdict.badgeState, "needs_attention");
  assert.equal(verdict.handlingItself, false);
});

test("synthesizeConnectionVerdict: healthy reads as handling-it with no scary copy", () => {
  const verdict = synthesizeConnectionVerdict(snapshot({ state: "healthy" }));
  assert.equal(verdict.badgeState, "healthy");
  assert.equal(verdict.handlingItself, true);
  assert.doesNotMatch(verdict.runbook, DANGER_WORDS_RE);
});

test("synthesizeConnectionVerdict: degraded retryable_gap reads as recoverable handling-it", () => {
  const verdict = synthesizeConnectionVerdict(
    snapshot({
      state: "degraded",
      axes: { coverage: "retryable_gap", freshness: "fresh", attention: "none", outbox: "idle" },
      detail_gap_backlog: backlog({ pending: 250, pending_is_floor: true }),
    })
  );
  assert.equal(verdict.badgeState, "degraded");
  assert.equal(verdict.handlingItself, true, "a retryable gap remains system-handled on ordinary runs");
  assert.match(verdict.runbook, /recoverable|stay valid/i);
  assert.match(verdict.runbook, /250/);
});
