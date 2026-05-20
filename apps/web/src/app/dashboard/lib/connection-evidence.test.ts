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
  formatCoverageAxis,
  formatFreshnessAxis,
  formatLastDurableProgress,
  formatOutboxAxis,
  formatProjectionFreshness,
  resolveRecordCountDisplay,
  summarizeAxisChips,
  summarizeOutboxForRow,
  summarizeSchedule,
} from "./connection-evidence.ts";
import type { RefConnectionHealthSnapshot, RefSchedule } from "./ref-client.ts";
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
  assert.match(formatCoverageAxis("unknown").label, /unknown/i);
  assert.equal(formatCoverageAxis("complete").tone, "success");
  assert.equal(formatCoverageAxis("gaps").tone, "warning");
  assert.equal(formatCoverageAxis("partial").tone, "warning");
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

test("summarizeAxisChips omits attention when none and always includes coverage/freshness/outbox", () => {
  const out = summarizeAxisChips(
    snapshot({ axes: { coverage: "complete", freshness: "fresh", attention: "none", outbox: "idle" } }).axes
  );
  assert.equal(
    out.some((c) => /Attention/.test(c.label)),
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
  assert.match(out.detail, /schedule unavailable/);
  assert.match(out.detail, /freshness unknown/);
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

test("formatLastDurableProgress refuses to substitute 0 when evidence failed", () => {
  const out = formatLastDurableProgress({
    hasError: true,
    lastRun: null,
    lastSuccessfulRun: null,
    totalRecords: 0,
  });
  assert.equal(out.unavailable, true);
  assert.match(out.label, /unavailable/i);
  assert.equal(/^0/.test(out.label), false);
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
  assert.match(out.label, /42 events/);
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
  assert.match(out.label, /Last attempt/);
  assert.match(out.label, /failed/);
});

test("formatLastDurableProgress reports 'records present · no run history' when records exist without runs", () => {
  const out = formatLastDurableProgress({
    hasError: false,
    lastRun: null,
    lastSuccessfulRun: null,
    totalRecords: 7,
  });
  assert.match(out.label, /Records present/);
});

test("formatLastDurableProgress reports 'Never run' when there is no evidence at all", () => {
  const out = formatLastDurableProgress({
    hasError: false,
    lastRun: null,
    lastSuccessfulRun: null,
    totalRecords: 0,
  });
  assert.match(out.label, /Never run/);
  assert.equal(out.unavailable, false);
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
  assert.match(out.backoffLabel ?? "", /Backoff applied/);
  assert.match(out.backoffLabel ?? "", /rate limited/);
  assert.match(out.backoffLabel ?? "", /3 consecutive failures/);
});

test("summarizeSchedule surfaces ineligibility reason without inventing automation", () => {
  const out = summarizeSchedule(baseSchedule({ ineligibility_reason: "browser_runtime_unavailable" }));
  assert.equal(out?.ineligibilityReason, "browser_runtime_unavailable");
});

test("resolveRecordCountDisplay refuses to show 0 when overview has an error", () => {
  const out = resolveRecordCountDisplay(baseOverview({ error: "boom", totalRecords: 0 }));
  assert.equal(out.label, null);
  assert.equal(out.reliable, false);
  assert.match(out.title, /unavailable/);
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
