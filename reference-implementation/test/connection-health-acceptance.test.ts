// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Acceptance suite for the RI operator console connection-health surface.
 *
 * Covers `complete-ri-operator-console-reliability` tasks:
 *
 *   - 7.1: every canonical headline state (healthy, degraded, needs_attention,
 *     cooling_off, blocked, idle, unknown) projects from durable evidence
 *     through the same `projectConnectorSummaryConnectionHealth` function the
 *     dashboard list and `ref.connectors.detail` operations consume.
 *
 *   - 7.2: syncing/activity, stale freshness, coverage gaps, and outbox
 *     backlog all surface as axes or badges. None of them is allowed to
 *     become a headline pill.
 *
 *   - 7.3 (evidence-backed portion): success-with-gaps — whether the gaps
 *     are known_gaps emitted by the run or pending detail-gap rows owned by
 *     the runtime — must not project as `healthy`. The
 *     `unsupported`/`deferred`/`unavailable`/`inventory_only` distinctions
 *     require manifest-declared required-stream policy plus accepted-
 *     coverage tracking that has not landed yet (see task 3.3 residual
 *     note); they are intentionally not asserted here.
 *
 * These tests stay pure and deterministic: they pass synthetic evidence
 * directly into the projection, never read clocks, and never hit a store.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { AttentionLifecycle } from "../runtime/attention.ts";
import { createAttention, transition } from "../runtime/attention.ts";
import type { ProviderInvalidationProof } from "../runtime/browser-surface/repair-decision.ts";
import type {
  ConnectionAxes,
  ConnectionHealthSnapshot,
  ConnectionHealthState,
  ConnectionRemoteSurfaceEvidence,
} from "../runtime/connection-health.ts";
import { BLOCKED_PROMOTION_THRESHOLD } from "../runtime/connection-health-policy.ts";
import type { SchedulerBackoffApi } from "../runtime/controller.ts";
import type { CollectionReportEntry, ConnectorRunSummary } from "../server/ref-control.ts";
import {
  projectConnectorSummaryConnectionHealth,
  refineConnectionHealthWithCollectionReport,
} from "../server/ref-control.ts";

interface ScheduleWithBackoffFixture {
  readonly enabled: boolean;
  readonly scheduler_backoff: SchedulerBackoffApi;
}

const NOW = "2026-05-19T12:00:00.000Z";
const RUN_AT = "2026-05-19T11:59:00.000Z";
const FRESH = { captured_at: NOW, status: "current" as const };
const STALE_FRESHNESS = { captured_at: NOW, status: "stale" as const };
const UNKNOWN_FRESHNESS = { captured_at: NOW, status: "unknown" as const };

const HEADLINE_STATES: readonly ConnectionHealthState[] = Object.freeze([
  "blocked",
  "cooling_off",
  "degraded",
  "healthy",
  "idle",
  "needs_attention",
  "unknown",
]);

function succeededRun(overrides: Partial<ConnectorRunSummary> = {}): ConnectorRunSummary {
  return {
    collection_facts: null,
    event_count: 3,
    failure_reason: null,
    finished_at: NOW,
    first_at: RUN_AT,
    known_gaps: [],
    last_at: NOW,
    recovery_only: false,
    run_id: "run_success",
    started_at: RUN_AT,
    status: "succeeded",
    terminal_reason: null,
    ...overrides,
  };
}

function failedRun(overrides: Partial<ConnectorRunSummary> = {}): ConnectorRunSummary {
  return {
    collection_facts: null,
    event_count: 0,
    failure_reason: "transient_500",
    finished_at: NOW,
    first_at: RUN_AT,
    known_gaps: [],
    last_at: NOW,
    recovery_only: false,
    run_id: "run_failed",
    started_at: RUN_AT,
    status: "failed",
    terminal_reason: null,
    ...overrides,
  };
}

function chatGptSessionRequiredRun(): ConnectorRunSummary {
  return failedRun({
    failure_reason: "connector_reported_failed",
    known_gaps: [
      {
        kind: "run_failed",
        message:
          "chatgpt_preprogress_failure: refresh_credentials: chatgpt_session_failed: chatgpt_session_required: ChatGPT session is not active.",
        reason: "connector_reported_failed",
        recovery_hint: { action: "refresh_credentials", retryable: false },
        severity: "actionable",
        stream: null,
      },
    ],
  });
}

function readyBrowserSurface(): ConnectionRemoteSurfaceEvidence {
  return {
    axis: "idle",
    leaseId: null,
    leaseStatus: null,
    profileKey: "chatgpt:cin_test",
    surfaceHealth: "ready",
    surfaceId: "surface_chatgpt",
    waitReason: null,
  };
}

function backoffSchedule({
  failures = 3,
  reasonClass = "failure:rate_limited",
  backoffApplied = true,
}: {
  failures?: number;
  reasonClass?: string;
  backoffApplied?: boolean;
} = {}): ScheduleWithBackoffFixture {
  return {
    enabled: true,
    scheduler_backoff: {
      backoff_applied: backoffApplied,
      consecutive_failures: failures,
      next_run_at: "2026-05-19T13:00:00.000Z",
      reason_class: reasonClass,
      recommended_health_state: failures >= BLOCKED_PROMOTION_THRESHOLD ? "blocked" : "cooling_off",
    },
  };
}

function openOtpAttention() {
  return createAttention({
    action_target: "dashboard",
    connection_id: "codex",
    dedupe_key: "codex:otp",
    id: "att_otp",
    now: "2026-05-19T11:50:00.000Z",
    owner_action: "provide_value",
    progress_posture: "blocked",
    reason_code: "otp_required",
    response_contract: "response_required",
    run_id: "run_failed",
    sensitivity: "non_secret",
  });
}

function secretOtpAttention() {
  return createAttention({
    action_target: "dashboard",
    connection_id: "codex",
    dedupe_key: "codex:secret-otp",
    id: "att_secret_otp",
    now: "2026-05-19T11:50:00.000Z",
    owner_action: "provide_value",
    progress_posture: "blocked",
    reason_code: "otp_required",
    response_contract: "response_required",
    run_id: "run_secret_otp",
    sensitivity: "secret",
  });
}

function terminalOtpAttention(lifecycle: AttentionLifecycle) {
  return transition(openOtpAttention(), { now: NOW, to: lifecycle });
}

const AXIS_KEYS: readonly (keyof ConnectionAxes)[] = ["attention", "coverage", "freshness", "outbox"];

function assertAxesPresent(snap: ConnectionHealthSnapshot) {
  assert.ok(snap.axes, "axes must be populated");
  for (const key of AXIS_KEYS) {
    assert.ok(typeof snap.axes[key] === "string", `axis ${key} must be a string`);
  }
  assert.ok(snap.badges, "badges must be populated");
  assert.equal(typeof snap.badges.stale, "boolean");
  assert.equal(typeof snap.badges.syncing, "boolean");
}

function assertHeadline(snap: ConnectionHealthSnapshot, expected: ConnectionHealthState) {
  assert.ok(HEADLINE_STATES.includes(snap.state), `state ${snap.state} not in canonical headline set`);
  assert.equal(snap.state, expected);
  assertAxesPresent(snap);
}

// ─── 7.1 Acceptance: every canonical headline state ───────────────────────

test("acceptance 7.1: never-run connection projects idle", () => {
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: UNKNOWN_FRESHNESS,
    lastRun: null,
    lastSuccessfulRun: null,
    schedule: null,
  });
  assertHeadline(snap, "idle");
  assert.equal(snap.last_success_at, null);
});

test("acceptance 7.1: never-run does not hide a failed managed runtime surface", () => {
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: UNKNOWN_FRESHNESS,
    lastRun: null,
    lastSuccessfulRun: null,
    remoteSurface: {
      axis: "failed",
      leaseId: null,
      leaseStatus: null,
      profileKey: "chatgpt:cin_active",
      surfaceHealth: "unhealthy",
      surfaceId: "surface_unhealthy",
      waitReason: "surface_unhealthy",
    },
    schedule: null,
  });
  assertHeadline(snap, "degraded");
  assert.equal(snap.axes.remote_surface, "failed");
  assert.equal(snap.reason_code, "remote_surface:surface_unhealthy");
});

test("acceptance 7.1: never-run does not hide durable coverage gaps", () => {
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: FRESH,
    lastRun: null,
    lastSuccessfulRun: null,
    pendingDetailGaps: [{ reason: "rate_limited", status: "pending", stream: "messages" }],
    schedule: null,
  });
  assertHeadline(snap, "degraded");
  assert.equal(snap.axes.coverage, "retryable_gap");
  assert.equal(snap.reason_code, "rate_limited");
});

test("undefined coverage override axis preserves derived coverage", () => {
  const snap = projectConnectorSummaryConnectionHealth({
    coverageOverride: { axis: undefined } as unknown as NonNullable<
      Parameters<typeof projectConnectorSummaryConnectionHealth>[0]["coverageOverride"]
    >,
    freshness: FRESH,
    lastRun: null,
    lastSuccessfulRun: null,
    pendingDetailGaps: [{ reason: "rate_limited", status: "pending", stream: "messages" }],
    schedule: null,
  });

  assert.equal(snap.axes.coverage, "retryable_gap");
  assert.equal(snap.reason_code, "rate_limited");
});

test("acceptance 7.1: fresh local-device evidence without a terminal collection verdict projects unknown, not idle", () => {
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: FRESH,
    lastRun: null,
    lastSuccessfulRun: null,
    outbox: { axis: "idle" },
    schedule: null,
  });
  assertHeadline(snap, "unknown");
  assert.deepEqual([...snap.unknown_reasons], ["collection"]);
  assert.equal(snap.axes.freshness, "fresh");
  assert.equal(snap.axes.outbox, "idle");
});

test("acceptance 7.1: owner-paused schedule projects idle even with failed last run", () => {
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: STALE_FRESHNESS,
    lastRun: failedRun(),
    lastSuccessfulRun: null,
    schedule: { enabled: false },
  });
  assertHeadline(snap, "idle");
  assert.equal(snap.next_attempt_at, null, "paused schedules emit no next_attempt");
});

// Manual + background-unsafe raw manifest refresh policy (a connector that
// cannot be background-scheduled even with explicit owner opt-in).
const MANUAL_BACKGROUND_UNSAFE_REFRESH_POLICY = {
  background_safe: false,
  maximum_staleness_seconds: 86_400,
  recommended_mode: "manual",
};
const SCHEDULABLE_REFRESH_POLICY = {
  background_safe: true,
  maximum_staleness_seconds: 86_400,
  recommended_mode: "automatic",
};
const PAUSED_REFRESH_POLICY = {
  background_safe: true,
  maximum_staleness_seconds: 86_400,
  recommended_mode: "paused",
};

test("acceptance 7.1: manual/background-unsafe connector that is complete+succeeded+stale projects idle advisory, not degraded", () => {
  // The raw manifest refresh_policy declares manual + background_safe:false,
  // so stale data is an owner-action advisory the caller wiring
  // (buildRefreshEvidence) recognizes end-to-end.
  const run = succeededRun();
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: STALE_FRESHNESS,
    lastRun: run,
    lastSuccessfulRun: run,
    outbox: { axis: "idle" },
    refreshPolicy: MANUAL_BACKGROUND_UNSAFE_REFRESH_POLICY,
    schedule: { enabled: true },
  });
  assertHeadline(snap, "idle");
  assert.equal(snap.reason_code, "stale_manual_refresh");
  assert.equal(snap.axes.freshness, "stale");
  assert.equal(snap.badges.stale, true);
});

test("acceptance 7.1: manual-default background-safe connector with an enabled owner schedule is scheduled, not stale_manual_refresh", () => {
  const run = succeededRun();
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: STALE_FRESHNESS,
    lastRun: run,
    lastSuccessfulRun: run,
    outbox: { axis: "idle" },
    refreshPolicy: {
      assisted_after_owner_auth: true,
      background_safe: true,
      maximum_staleness_seconds: 86_400,
      recommended_mode: "manual",
    },
    schedule: { enabled: true },
  });
  assertHeadline(snap, "degraded");
  assert.equal(snap.reason_code, null);
  assert.equal(snap.axes.freshness, "stale");
  assert.equal(snap.badges.stale, true);
  assert.equal(snap.forward_disposition, "complete");
  assert.notEqual(snap.forward_disposition, "owner_refresh_due");
});

test("acceptance 7.1: schedulable connector with the SAME stale evidence still degrades", () => {
  const run = succeededRun();
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: STALE_FRESHNESS,
    lastRun: run,
    lastSuccessfulRun: run,
    outbox: { axis: "idle" },
    refreshPolicy: SCHEDULABLE_REFRESH_POLICY,
    schedule: { enabled: true },
  });
  assertHeadline(snap, "degraded");
  assert.equal(snap.axes.freshness, "stale");
});

test("acceptance 7.1: paused connector that is complete+succeeded+stale projects idle advisory, not degraded", () => {
  const run = succeededRun();
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: STALE_FRESHNESS,
    lastRun: run,
    lastSuccessfulRun: run,
    outbox: { axis: "idle" },
    refreshPolicy: PAUSED_REFRESH_POLICY,
    schedule: { enabled: true },
  });
  assertHeadline(snap, "idle");
  assert.equal(snap.reason_code, "stale_manual_refresh");
});

test("acceptance 7.1: a manual connector with no refresh policy still degrades on stale (default = schedulable)", () => {
  const run = succeededRun();
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: STALE_FRESHNESS,
    lastRun: run,
    lastSuccessfulRun: run,
    outbox: { axis: "idle" },
    schedule: { enabled: true },
  });
  assertHeadline(snap, "degraded");
});

test("acceptance 7.1: a manual connector with incomplete coverage still degrades even when stale", () => {
  const run = succeededRun();
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: STALE_FRESHNESS,
    lastRun: run,
    lastSuccessfulRun: run,
    pendingDetailGaps: [{ reason: "rate_limited", status: "pending", stream: "posts" }],
    refreshPolicy: MANUAL_BACKGROUND_UNSAFE_REFRESH_POLICY,
    schedule: { enabled: true },
  });
  assertHeadline(snap, "degraded");
});

test("acceptance 7.1: a manual connector whose last run failed still degrades even when stale", () => {
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: STALE_FRESHNESS,
    lastRun: failedRun(),
    lastSuccessfulRun: null,
    refreshPolicy: MANUAL_BACKGROUND_UNSAFE_REFRESH_POLICY,
    schedule: { enabled: true },
  });
  assertHeadline(snap, "degraded");
});

test("acceptance 7.1: succeeded run + complete coverage + fresh + no attention projects healthy", () => {
  const run = succeededRun();
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: FRESH,
    lastRun: run,
    lastSuccessfulRun: run,
    outbox: { axis: "idle" },
    schedule: { enabled: true },
  });
  assertHeadline(snap, "healthy");
  assert.equal(snap.reason_code, null);
  assert.equal(snap.next_action, null);
});

test("acceptance 7.1: newer successful run clears stale scheduler backoff evidence", () => {
  const run = succeededRun({
    finished_at: "2026-05-24T23:20:25.909Z",
    last_at: "2026-05-24T23:20:25.909Z",
    run_id: "run_success_after_backoff",
    started_at: "2026-05-24T23:20:02.398Z",
  });
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: { captured_at: "2026-05-24T23:20:25.909Z", status: "current" },
    lastRun: run,
    lastSuccessfulRun: run,
    schedule: {
      enabled: true,
      last_error_code: "schedule.gave_up",
      last_finished_at: "2026-05-21T02:04:39.188Z",
      last_started_at: "2026-05-21T02:03:39.190Z",
      next_due_at: "2026-05-21T18:04:39.188Z",
      scheduler_backoff: {
        backoff_applied: true,
        consecutive_failures: BLOCKED_PROMOTION_THRESHOLD,
        next_run_at: "2026-05-21T18:04:39.188Z",
        reason_class: "terminal:connector_reported_failed",
        recommended_health_state: "blocked",
      },
    },
  });
  assertHeadline(snap, "healthy");
  assert.equal(snap.reason_code, null);
  assert.equal(snap.next_attempt_at, null);
});

test("acceptance 7.1: structured open attention drives needs_attention with structured CTA", () => {
  const snap = projectConnectorSummaryConnectionHealth({
    attentionRecords: [openOtpAttention()],
    freshness: FRESH,
    lastRun: failedRun(),
    lastSuccessfulRun: null,
    nowIso: NOW,
    schedule: null,
  });
  assertHeadline(snap, "needs_attention");
  assert.equal(snap.reason_code, "otp_required");
  assert.equal(snap.next_action?.source, "structured");
  assert.equal(snap.next_action?.attention_id, "att_otp");
  assert.equal(snap.next_action?.action_target, "dashboard");
  assert.equal(snap.axes.attention, "open");
});

test("acceptance 7.1: secret structured attention keeps next_action.action_target suppressed", () => {
  const snap = projectConnectorSummaryConnectionHealth({
    attentionRecords: [secretOtpAttention()],
    freshness: FRESH,
    lastRun: failedRun(),
    lastSuccessfulRun: null,
    nowIso: NOW,
    schedule: null,
  });
  assertHeadline(snap, "needs_attention");
  assert.equal(snap.reason_code, "otp_required");
  assert.equal(snap.next_action?.source, "structured");
  assert.equal(snap.next_action?.attention_id, "att_secret_otp");
  assert.equal(snap.next_action?.action_target, null);
  assert.equal(snap.axes.attention, "open");
});

test("acceptance 7.1: terminal attention rows are history, not current owner action", () => {
  const terminalLifecycles: readonly AttentionLifecycle[] = ["resolved", "expired", "cancelled"];
  for (const lifecycle of terminalLifecycles) {
    const run = succeededRun();
    const snap = projectConnectorSummaryConnectionHealth({
      attentionRecords: [terminalOtpAttention(lifecycle)],
      freshness: FRESH,
      lastRun: run,
      lastSuccessfulRun: run,
      nowIso: NOW,
      outbox: { axis: "idle" },
      schedule: { enabled: true },
    });

    assertHeadline(snap, "healthy");
    assert.equal(snap.reason_code, null, `${lifecycle} attention should not supply the current reason`);
    assert.equal(snap.next_action, null, `${lifecycle} attention should not supply a current CTA`);
    assert.equal(snap.axes.attention, "none", `${lifecycle} attention should not count as open attention`);
  }
});

test("acceptance 7.1: expired prompt does not heal unresolved session-readiness evidence", () => {
  const snap = projectConnectorSummaryConnectionHealth({
    attentionRecords: [terminalOtpAttention("expired")],
    browserSessionRepairCapable: true,
    freshness: FRESH,
    lastRun: chatGptSessionRequiredRun(),
    lastSuccessfulRun: null,
    nowIso: NOW,
    remoteSurface: readyBrowserSurface(),
    schedule: { enabled: true },
  });

  assertHeadline(snap, "blocked");
  assert.equal(snap.reason_code, "session_required");
  assert.equal(snap.axes.attention, "none");
  assert.equal(
    snap.conditions?.find((c) => c.type === "CredentialsValid")?.remediation?.surface?.kind,
    "browser_session"
  );
});

test("acceptance 7.1: cooling_off when scheduler backoff is delaying a retry below the give-up threshold", () => {
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: STALE_FRESHNESS,
    lastRun: failedRun({ failure_reason: "rate_limited" }),
    lastSuccessfulRun: null,
    nowIso: NOW,
    schedule: backoffSchedule({ failures: 3, reasonClass: "failure:rate_limited" }),
  });
  assertHeadline(snap, "cooling_off");
  assert.equal(snap.reason_code, "rate_limited");
  assert.equal(snap.next_attempt_at, "2026-05-19T13:00:00.000Z");
});

test("acceptance 7.1: blocked when the scheduler give-up streak crosses the promotion threshold", () => {
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: STALE_FRESHNESS,
    lastRun: failedRun({ failure_reason: "auth_expired" }),
    lastSuccessfulRun: null,
    schedule: backoffSchedule({
      failures: BLOCKED_PROMOTION_THRESHOLD,
      reasonClass: "connector:auth_expired",
    }),
  });
  assertHeadline(snap, "blocked");
  assert.equal(snap.reason_code, "auth_expired");
});

test("acceptance 7.1: failed last run with no backoff/attention/coverage evidence projects degraded", () => {
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: FRESH,
    lastRun: failedRun({ failure_reason: "transient_400" }),
    lastSuccessfulRun: null,
    schedule: { enabled: true },
  });
  assertHeadline(snap, "degraded");
  assert.equal(snap.reason_code, "transient_400");
});

test("acceptance 7.1: unreliable evidence sources project unknown and name the source", () => {
  const run = succeededRun();
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: FRESH,
    lastRun: run,
    lastSuccessfulRun: run,
    schedule: { enabled: true },
    unreliableSources: ["detail_gaps"],
  });
  assertHeadline(snap, "unknown");
  assert.deepEqual([...snap.unknown_reasons], ["detail_gaps"]);
});

test("acceptance 7.1: succeeded run with unknown coverage and unknown freshness falls through to unknown", () => {
  // The fallback (rule 8) prevents a silent false green when the projection
  // cannot prove coverage or freshness.
  const run = succeededRun();
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: UNKNOWN_FRESHNESS,
    lastRun: run,
    lastSuccessfulRun: run,
    schedule: { enabled: true },
  });
  assertHeadline(snap, "unknown");
});

test("acceptance 7.1: every canonical headline state is reachable through projectConnectorSummaryConnectionHealth", () => {
  // Exhaustiveness guard: if a new state is ever added to the union, this
  // test must be updated to demonstrate a projection path that reaches it.
  // Conversely, if a current state ever becomes unreachable through the
  // dashboard/CLI projection, this test will catch the regression.
  const observed = new Set<ConnectionHealthState>();
  const cases: Array<{
    state: ConnectionHealthState;
    input: Parameters<typeof projectConnectorSummaryConnectionHealth>[0];
  }> = [
    {
      input: {
        freshness: UNKNOWN_FRESHNESS,
        lastRun: null,
        lastSuccessfulRun: null,
        schedule: null,
      },
      state: "idle",
    },
    {
      input: {
        attentionRecords: [openOtpAttention()],
        freshness: FRESH,
        lastRun: failedRun(),
        lastSuccessfulRun: null,
        nowIso: NOW,
        schedule: null,
      },
      state: "needs_attention",
    },
    {
      input: {
        freshness: STALE_FRESHNESS,
        lastRun: failedRun(),
        lastSuccessfulRun: null,
        nowIso: NOW,
        schedule: backoffSchedule({ failures: 2 }),
      },
      state: "cooling_off",
    },
    {
      input: {
        freshness: STALE_FRESHNESS,
        lastRun: failedRun(),
        lastSuccessfulRun: null,
        nowIso: NOW,
        schedule: backoffSchedule({ failures: BLOCKED_PROMOTION_THRESHOLD }),
      },
      state: "blocked",
    },
    {
      input: {
        freshness: FRESH,
        lastRun: failedRun(),
        lastSuccessfulRun: null,
        schedule: { enabled: true },
      },
      state: "degraded",
    },
    {
      input: {
        freshness: FRESH,
        lastRun: succeededRun(),
        lastSuccessfulRun: succeededRun(),
        schedule: { enabled: true },
      },
      state: "healthy",
    },
    {
      input: {
        freshness: FRESH,
        lastRun: succeededRun(),
        lastSuccessfulRun: succeededRun(),
        schedule: { enabled: true },
        unreliableSources: ["coverage_read_model"],
      },
      state: "unknown",
    },
  ];
  for (const { state, input } of cases) {
    const snap = projectConnectorSummaryConnectionHealth(input);
    assertHeadline(snap, state);
    observed.add(snap.state);
  }
  assert.deepEqual([...observed].sort(), [...HEADLINE_STATES].sort());
});

// ─── 7.2 Acceptance: non-headline signals stay as axes/badges ─────────────

test("acceptance 7.2: active scheduled run surfaces a syncing badge without replacing the healthy headline", () => {
  const run = succeededRun();
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: FRESH,
    lastRun: run,
    lastSuccessfulRun: run,
    outbox: { axis: "idle" },
    schedule: { active_run_id: "run_inflight", enabled: true },
  });
  // Syncing is a badge: the headline must still be the underlying state.
  assertHeadline(snap, "healthy");
  assert.equal(snap.badges.syncing, true, "active_run_id should light up the syncing badge");
  assert.notEqual(snap.state, "syncing", "syncing is never a headline state");
});

test("acceptance 7.2: durable active-run row surfaces syncing when schedule metadata is absent", () => {
  const snap = projectConnectorSummaryConnectionHealth({
    activeRun: {
      connector_id: "chase",
      connector_instance_id: "cin_chase",
      run_generation: 1,
      run_id: "run_inflight",
      scenario_id: "default",
      started_at: NOW,
      trace_id: "trace_inflight",
    },
    freshness: UNKNOWN_FRESHNESS,
    lastRun: null,
    lastSuccessfulRun: null,
    outbox: { axis: "idle" },
    schedule: null,
  });
  assertHeadline(snap, "idle");
  assert.equal(snap.badges.syncing, true, "controller_active_runs should light up the syncing badge");
});

test("acceptance 7.2: active scheduled run does not promote a degraded headline back to healthy", () => {
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: FRESH,
    lastRun: failedRun({ failure_reason: "transient_500" }),
    lastSuccessfulRun: null,
    schedule: { active_run_id: "run_inflight", enabled: true },
  });
  assertHeadline(snap, "degraded");
  assert.equal(snap.badges.syncing, true, "syncing badge sits orthogonal to degraded headline");
});

test("acceptance 7.2: stale freshness surfaces as axis+badge, not a stale headline pill", () => {
  const run = succeededRun();
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: STALE_FRESHNESS,
    lastRun: run,
    lastSuccessfulRun: run,
    schedule: { enabled: true },
  });
  // Stale-but-otherwise-clean degrades while the badge and axis carry the
  // precise freshness signal — the dashboard never invents a "stale" pill.
  assertHeadline(snap, "degraded");
  assert.equal(snap.axes.freshness, "stale");
  assert.equal(snap.badges.stale, true);
  assert.notEqual(snap.state, "stale");
});

test("acceptance 7.2: known-gap coverage surfaces as terminal_gap axis, headline pill is degraded", () => {
  const run = succeededRun({
    known_gaps: [{ reason: "auth_expired", severity: "actionable", stream: "messages" }],
  });
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: FRESH,
    lastRun: run,
    lastSuccessfulRun: run,
    schedule: { enabled: true },
  });
  assertHeadline(snap, "degraded");
  assert.equal(snap.axes.coverage, "terminal_gap");
  assert.notEqual(snap.state, "gaps", "gaps is never a headline state");
});

test("acceptance 7.2: pending durable detail gaps surface as retryable_gap axis, not a backlog pill", () => {
  const run = succeededRun();
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: FRESH,
    lastRun: run,
    lastSuccessfulRun: run,
    pendingDetailGaps: [{ reason: "rate_limited", status: "pending", stream: "messages" }],
    schedule: { enabled: true },
  });
  assertHeadline(snap, "degraded");
  assert.equal(snap.axes.coverage, "retryable_gap");
  assert.equal(snap.reason_code, "rate_limited");
});

test("acceptance 7.2: stalled outbox surfaces as outbox axis, headline pill is degraded", () => {
  const run = succeededRun();
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: FRESH,
    lastRun: run,
    lastSuccessfulRun: run,
    outbox: { axis: "stalled" },
    schedule: { enabled: true },
  });
  // Outbox backlog draining failure must surface as an axis, not as a new
  // "stalled" headline pill — the dashboard's small canonical pill set
  // stays small.
  assertHeadline(snap, "degraded");
  assert.equal(snap.axes.outbox, "stalled");
});

test("acceptance 7.2: active outbox lets healthy stand while the axis carries the signal", () => {
  const run = succeededRun();
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: FRESH,
    lastRun: run,
    lastSuccessfulRun: run,
    outbox: { axis: "active" },
    schedule: { enabled: true },
  });
  // `active` outbox is normal draining work, not a stall — must not
  // degrade the headline.
  assertHeadline(snap, "healthy");
  assert.equal(snap.axes.outbox, "active");
});

test("acceptance 7.2: every axis remains populated even when the headline is needs_attention", () => {
  // Axes must not be collapsed into the headline pill: the dashboard
  // wants to render coverage / freshness / outbox / attention precision
  // alongside the headline. This pins that contract.
  const snap = projectConnectorSummaryConnectionHealth({
    attentionRecords: [openOtpAttention()],
    freshness: STALE_FRESHNESS,
    lastRun: failedRun(),
    lastSuccessfulRun: null,
    nowIso: NOW,
    outbox: { axis: "stalled" },
    pendingDetailGaps: [{ reason: "rate_limited", status: "pending", stream: "messages" }],
    schedule: { active_run_id: "run_inflight", enabled: true },
  });
  assertHeadline(snap, "needs_attention");
  assert.equal(snap.axes.attention, "open");
  assert.equal(snap.axes.freshness, "stale");
  assert.equal(snap.axes.outbox, "stalled");
  assert.ok(
    snap.axes.coverage === "retryable_gap" || snap.axes.coverage === "terminal_gap",
    `coverage axis should expose gap evidence, got ${snap.axes.coverage}`
  );
  assert.equal(snap.badges.syncing, true);
  assert.equal(snap.badges.stale, true);
});

// ─── 7.3 Acceptance: success-with-gaps must not project healthy ───────────

test("acceptance 7.3: succeeded run with actionable known_gap is degraded, never healthy", () => {
  const run = succeededRun({
    failure_reason: "auth_expired",
    known_gaps: [{ reason: "auth_expired", severity: "actionable", stream: "messages" }],
  });
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: FRESH,
    lastRun: run,
    lastSuccessfulRun: run,
    schedule: { enabled: true },
  });
  assertHeadline(snap, "degraded");
  assert.notEqual(snap.state, "healthy");
  assert.equal(snap.axes.coverage, "terminal_gap");
});

test("acceptance 7.3: succeeded run with unclassified known_gap conservatively projects terminal_gap", () => {
  // No severity attached — the runtime cannot prove a retry path exists,
  // so the conservative rollup is `terminal_gap`. Health degrades.
  const run = succeededRun({
    known_gaps: [{ reason: "http_429", stream: "messages" }],
  });
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: FRESH,
    lastRun: run,
    lastSuccessfulRun: run,
    schedule: { enabled: true },
  });
  assertHeadline(snap, "degraded");
  assert.notEqual(snap.state, "healthy");
  assert.equal(snap.axes.coverage, "terminal_gap");
  assert.equal(snap.reason_code, "http_429");
});

test("acceptance 7.3: succeeded run with transient known_gap projects retryable_gap and is not healthy", () => {
  const run = succeededRun({
    known_gaps: [{ reason: "http_429", severity: "transient", stream: "messages" }],
  });
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: FRESH,
    lastRun: run,
    lastSuccessfulRun: run,
    schedule: { enabled: true },
  });
  assertHeadline(snap, "degraded");
  assert.notEqual(snap.state, "healthy");
  assert.equal(snap.axes.coverage, "retryable_gap");
});

test("acceptance 7.3: manual-action known_gap projects retryable_gap, not terminal code-fix coverage", () => {
  const run = failedRun({
    failure_reason: "connector_reported_failed",
    known_gaps: [
      {
        kind: "interaction_required",
        message: "The owner prompt timed out before a code was provided.",
        reason: "interaction_timeout",
        recovery_hint: { action: "manual_action_required", retryable: false },
        severity: "actionable",
        stream: null,
      },
    ],
  });
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: STALE_FRESHNESS,
    lastRun: run,
    lastSuccessfulRun: null,
    schedule: null,
  });

  assertHeadline(snap, "degraded");
  assert.notEqual(snap.state, "healthy");
  assert.equal(snap.axes.coverage, "retryable_gap");
  assert.equal(snap.forward_disposition, "resumable");
});

test("acceptance 7.3: underscore-separated OTP failure text is owner-recoverable even with unknown hint", () => {
  const run = failedRun({
    failure_reason: "connector_reported_failed",
    known_gaps: [
      {
        kind: "run_failed",
        message: "chase_session_failed: chase_otp_not_provided",
        reason: "connector_reported_failed",
        recovery_hint: { action: "unknown", retryable: false },
        severity: "actionable",
        stream: null,
      },
    ],
  });
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: STALE_FRESHNESS,
    lastRun: run,
    lastSuccessfulRun: null,
    schedule: null,
  });

  assertHeadline(snap, "degraded");
  assert.equal(snap.axes.coverage, "retryable_gap");
  assert.equal(snap.forward_disposition, "resumable");
});

test("acceptance 7.3: live-shaped OTP timeout plus checkpoint retry stays recoverable", () => {
  const run = failedRun({
    failure_reason: "connector_reported_failed",
    known_gaps: [
      {
        kind: "interaction_required",
        message: "Chase sent a 2FA code. Reply with it.",
        reason: "interaction_timeout",
        recovery_hint: { action: "manual_action_required", retryable: false },
        severity: "actionable",
        stream: null,
      },
      {
        kind: "run_failed",
        message: "chase_session_failed: chase_otp_not_provided",
        reason: "connector_reported_failed",
        recovery_hint: { action: "unknown", retryable: false },
        severity: "actionable",
        stream: null,
      },
      {
        kind: "checkpoint_commit",
        message: "Staged stream state was not committed",
        reason: "not_committed",
        recovery_hint: { action: "retry_by_runtime", retryable: true },
        severity: "actionable",
        stream: null,
      },
    ],
  });
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: STALE_FRESHNESS,
    lastRun: run,
    lastSuccessfulRun: null,
    schedule: null,
  });

  assertHeadline(snap, "degraded");
  assert.equal(snap.axes.coverage, "retryable_gap");
  assert.equal(snap.forward_disposition, "resumable");
});

test("acceptance 7.3: succeeded run with pending durable detail gap is degraded, never healthy", () => {
  const run = succeededRun();
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: FRESH,
    lastRun: run,
    lastSuccessfulRun: run,
    pendingDetailGaps: [{ reason: "rate_limited", status: "pending", stream: "messages" }],
    schedule: { enabled: true },
  });
  assertHeadline(snap, "degraded");
  assert.notEqual(snap.state, "healthy");
  assert.equal(snap.axes.coverage, "retryable_gap");
});

test("acceptance 7.3: succeeded run with both known and pending gaps surfaces the more urgent (terminal) axis", () => {
  // Terminal gaps dominate retryable backlog so the owner sees the
  // owner-action claim rather than a misleading retry-only label.
  const run = succeededRun({
    known_gaps: [{ reason: "auth_expired", severity: "actionable", stream: "inbox" }],
  });
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: FRESH,
    lastRun: run,
    lastSuccessfulRun: run,
    pendingDetailGaps: [{ reason: "rate_limited", status: "pending", stream: "messages" }],
    schedule: { enabled: true },
  });
  assertHeadline(snap, "degraded");
  assert.notEqual(snap.state, "healthy");
  assert.equal(snap.axes.coverage, "terminal_gap");
});

// ─── 7.3 / 3.3: manifest-declared accepted-coverage and required-stream
// policy must surface in the coverage axis without painting the connection
// healthy when the manifest is contradictory (required + unsupported).

test("acceptance 7.3: required stream marked unsupported in the manifest never projects healthy", () => {
  // A `required: true` + `coverage_policy: "unsupported"` declaration is
  // contradictory: the stream is both load-bearing AND accepted-absent.
  // The projection must refuse healthy and surface the contradiction
  // through the coverage axis so the dashboard can explain why.
  const run = succeededRun();
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: FRESH,
    lastRun: run,
    lastSuccessfulRun: run,
    manifestStreams: [{ coverage_policy: "unsupported", name: "messages", required: true }],
    schedule: { enabled: true },
  });
  assert.notEqual(snap.state, "healthy");
  assertHeadline(snap, "degraded");
  assert.equal(snap.axes.coverage, "unsupported");
});

test("acceptance 7.3: required stream marked unavailable in the manifest never projects healthy", () => {
  const run = succeededRun();
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: FRESH,
    lastRun: run,
    lastSuccessfulRun: run,
    manifestStreams: [{ coverage_policy: "unavailable", name: "archive", required: true }],
    schedule: { enabled: true },
  });
  assert.notEqual(snap.state, "healthy");
  assertHeadline(snap, "degraded");
  assert.equal(snap.axes.coverage, "unavailable");
});

test("acceptance 7.3: required stream marked deferred in the manifest never projects healthy", () => {
  const run = succeededRun();
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: FRESH,
    lastRun: run,
    lastSuccessfulRun: run,
    manifestStreams: [{ coverage_policy: "deferred", name: "attachments", required: true }],
    schedule: { enabled: true },
  });
  assert.notEqual(snap.state, "healthy");
  assertHeadline(snap, "degraded");
  assert.equal(snap.axes.coverage, "deferred");
});

test("acceptance 3.3: accepted unsupported coverage on a non-required stream still allows healthy", () => {
  // Inverse of the above: when the manifest declares the absence as
  // accepted AND the stream is NOT required, the connection can still
  // be healthy; the axis just surfaces the most-precise accepted label
  // so the dashboard can render "no `archive` stream by design".
  const run = succeededRun();
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: FRESH,
    lastRun: run,
    lastSuccessfulRun: run,
    manifestStreams: [
      { name: "conversations", required: true },
      { coverage_policy: "unsupported", name: "archive", required: false },
    ],
    schedule: { enabled: true },
  });
  assertHeadline(snap, "healthy");
  assert.equal(snap.axes.coverage, "unsupported");
});

test("acceptance 3.3: accepted-coverage precedence is unsupported > unavailable > deferred > inventory_only", () => {
  const run = succeededRun();
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: FRESH,
    lastRun: run,
    lastSuccessfulRun: run,
    manifestStreams: [
      { coverage_policy: "inventory_only", name: "inv", required: false },
      { coverage_policy: "deferred", name: "def", required: false },
      { coverage_policy: "unavailable", name: "avail", required: false },
      { coverage_policy: "unsupported", name: "sup", required: false },
      { name: "core", required: true },
    ],
    schedule: { enabled: true },
  });
  assertHeadline(snap, "healthy");
  assert.equal(snap.axes.coverage, "unsupported");
});

test("acceptance 3.3: inventory_only accepted-coverage labels the axis without degrading health", () => {
  const run = succeededRun();
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: FRESH,
    lastRun: run,
    lastSuccessfulRun: run,
    manifestStreams: [{ coverage_policy: "inventory_only", name: "inventory", required: false }],
    schedule: { enabled: true },
  });
  assertHeadline(snap, "healthy");
  assert.equal(snap.axes.coverage, "inventory_only");
});

test("acceptance 3.3: contradictory required+unsupported beats success path even with otherwise clean evidence", () => {
  // Sanity: no detail gaps, no known_gaps, fresh, succeeded — the only
  // thing keeping this from healthy is the contradictory manifest. The
  // projection must still refuse green.
  const run = succeededRun();
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: FRESH,
    lastRun: run,
    lastSuccessfulRun: run,
    manifestStreams: [
      { coverage_policy: "unsupported", name: "messages", required: true },
      { coverage_policy: "inventory_only", name: "optional_extras", required: false },
    ],
    schedule: { enabled: true },
  });
  assert.notEqual(snap.state, "healthy");
  assert.equal(snap.axes.coverage, "unsupported");
});

test("acceptance 7.3: no manifest policy keeps the prior complete behaviour intact", () => {
  // Regression guard: a clean succeeded run with no manifest hints still
  // projects healthy with a `complete` axis. The new manifest-aware
  // rollup must not change behavior for connectors that omit policy.
  const run = succeededRun();
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: FRESH,
    lastRun: run,
    lastSuccessfulRun: run,
    schedule: { enabled: true },
  });
  assertHeadline(snap, "healthy");
  assert.equal(snap.axes.coverage, "complete");
});

// ─── §10-C: a flattened auth failure must surface as a credential prompt ──────

test("§10-C: a failed run whose known_gap is an auth 401 (flattened to a generic reason) drives a credential prompt, not a silent failure", () => {
  // The live ChatGPT case: a terminal 401 is reported as the GENERIC
  // `connector_reported_failed`, but the auth signal survives in the gap's
  // `recovery_hint.action` + message. `firstDegradingKnownGapReason` must
  // surface a credential reason so the headline routes to a reconnect path
  // (and the §10-F escalation push) instead of a silent generic failure.
  const run = failedRun({
    failure_reason: "connector_reported_failed",
    known_gaps: [
      {
        kind: "run_failed",
        message: "apiFetch got 401 on GET /conversation/abc (auth - not retryable)",
        reason: "connector_reported_failed",
        recovery_hint: { action: "refresh_credentials", retryable: false },
        severity: "actionable",
        stream: null,
      },
    ],
  });
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: FRESH,
    lastRun: run,
    lastSuccessfulRun: null,
    schedule: { enabled: true },
  });
  // The credential signal is recovered: the connection is NOT silently
  // generic-failed. It surfaces a credentials condition that drives the
  // owner-facing reconnect path (the same `isCredentialReason` gate the
  // dashboard reads for its "Reconnect" CTA).
  assert.notEqual(snap.state, "healthy");
  const credentialCondition = snap.conditions?.find((c) => c.type === "CredentialsValid" && c.status === "false");
  assert.ok(
    credentialCondition,
    `expected a CredentialsValid:false condition (reconnect prompt), got conditions: ${JSON.stringify(snap.conditions?.map((c) => `${c.type}:${c.status}`))}`
  );
  assert.equal(credentialCondition.remediation?.action, "refresh_credentials");
});

test("§10-C: a browser-capable idle ChatGPT session-required gap projects session repair", () => {
  const run = chatGptSessionRequiredRun();
  const snap = projectConnectorSummaryConnectionHealth({
    browserSessionRepairCapable: true,
    freshness: FRESH,
    lastRun: run,
    lastSuccessfulRun: null,
    remoteSurface: {
      axis: "none",
      leaseId: null,
      leaseStatus: null,
      profileKey: null,
      surfaceHealth: null,
      surfaceId: null,
      waitReason: null,
    },
    schedule: { enabled: true },
  });

  const credentialCondition = snap.conditions?.find((c) => c.type === "CredentialsValid" && c.status === "false");
  assert.ok(credentialCondition, "session-required gap should produce a reconnect condition");
  assert.equal(credentialCondition.reason, "session_required");
  assert.equal(credentialCondition.remediation?.action, "refresh_credentials");
  assert.equal(credentialCondition.remediation?.surface?.kind, "browser_session");
  assert.equal(credentialCondition.remediation?.target, "browser_session");
  assert.equal(credentialCondition.message, "The authenticated browser session is not active.");
});

test("§10-C: ref-control preserves exact typed provider-proof dedupe", () => {
  const proof: ProviderInvalidationProof = {
    connection_id: "connection_chatgpt",
    evidence_id: "provider-event-1",
    kind: "provider_invalidation_proof",
    observed_at: NOW,
    provider: "chatgpt",
    verified: true,
  };
  const base = {
    freshness: FRESH,
    lastRun: chatGptSessionRequiredRun(),
    lastSuccessfulRun: null,
    remoteSurface: readyBrowserSurface(),
    schedule: { enabled: true },
  };
  const authorized = projectConnectorSummaryConnectionHealth({
    ...base,
    browserSurfaceRepair: {
      connectionId: proof.connection_id,
      evidence: proof,
      provider: proof.provider,
    },
  });
  assert.equal(
    authorized.conditions?.find((c) => c.type === "CredentialsValid")?.remediation?.surface?.kind,
    "browser_session"
  );

  const deduped = projectConnectorSummaryConnectionHealth({
    ...base,
    browserSurfaceRepair: {
      connectionId: proof.connection_id,
      evidence: proof,
      provider: proof.provider,
      repairedProofKeys: [`${proof.connection_id}\n${proof.provider}\n${proof.evidence_id}`],
    },
  });
  assert.equal(deduped.conditions?.find((c) => c.type === "CredentialsValid")?.remediation, null);

  const wrongProvider = projectConnectorSummaryConnectionHealth({
    ...base,
    browserSurfaceRepair: {
      connectionId: proof.connection_id,
      evidence: proof,
      provider: "other-provider",
    },
  });
  assert.equal(wrongProvider.conditions?.find((c) => c.type === "CredentialsValid")?.remediation, null);
});

test("§10-C control: a non-auth generic failure does NOT manufacture a credential prompt", () => {
  // A genuine non-credential failure (e.g. a parser error) must stay generic —
  // the credential-awareness must not over-fire on every failed run.
  const run = failedRun({
    failure_reason: "connector_reported_failed",
    known_gaps: [
      {
        kind: "run_failed",
        message: "parser error: unexpected token in stream payload",
        reason: "connector_reported_failed",
        recovery_hint: { action: "retry_on_connector_upgrade", retryable: false },
        severity: "actionable",
        stream: null,
      },
    ],
  });
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: FRESH,
    lastRun: run,
    lastSuccessfulRun: null,
    schedule: { enabled: true },
  });
  const credentialCondition = snap.conditions?.find((c) => c.type === "CredentialsValid" && c.status === "false");
  assert.equal(credentialCondition, undefined, "a non-auth failure must NOT manufacture a credential/reconnect prompt");
});

test("§10-C control: source_unavailable login outage does NOT manufacture a credential prompt", () => {
  // Live USAA shape: the connector has a stored credential, but the provider
  // login system reported source_unavailable after the username step. The
  // runtime gap may still carry the generic refresh_credentials action because
  // the message is login-shaped; the projection must not turn that source
  // outage into an owner "reconnect credentials" prompt.
  const run = failedRun({
    failure_reason: "connector_reported_failed",
    known_gaps: [
      {
        kind: "run_failed",
        message:
          "usaa_session_failed: source_unavailable: USAA reported its login system is currently unavailable after Next click.",
        reason: "connector_reported_failed",
        recovery_hint: { action: "refresh_credentials", retryable: false },
        severity: "actionable",
        stream: null,
      },
    ],
  });
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: FRESH,
    lastRun: run,
    lastSuccessfulRun: null,
    schedule: { enabled: true },
  });
  const credentialCondition = snap.conditions?.find((c) => c.type === "CredentialsValid" && c.status === "false");
  assert.equal(credentialCondition, undefined, "source_unavailable must NOT manufacture a credential/reconnect prompt");
  assert.notEqual(snap.next_action?.reason_code, "refresh_credentials");
  assert.equal(snap.axes.coverage, "retryable_gap");
  assert.equal(snap.forward_disposition, "resumable");
});

test("§10-C control: a login-flow stall with a competing manual_action gap does NOT manufacture a credential prompt", () => {
  // Live evidence: USAA connection cin_a8ec... run_1783787246728 (2026-07-11,
  // read via docker exec pdpp-postgres-1 psql, metadata only). The credential
  // store shows this connection's credential as `status: active`,
  // `rejected_at`/`rejection_reason` both null — never actually rejected. The
  // SAME run's known_gaps array carries two entries for the SAME underlying
  // failure: an `interaction_required`/`manual_action_required` gap (the
  // connector's own, more specific classification — its message
  // self-describes "this exact failure has recurred") and a generic
  // `run_failed` gap whose message merely CONTAINS the substring
  // "session_failed" (from the connector-neutral `establishSession` terminal-
  // error builder, `${name}_session_failed: ${message}`) with a
  // `refresh_credentials` recovery_hint. Before this fix, the second gap's
  // recovery_hint alone was enough to fabricate a `credentials_required`
  // reason and render "Reconnect this account" — even though the credential
  // was never rejected and a more specific sibling gap already existed.
  const run = failedRun({
    failure_reason: "connector_reported_failed",
    known_gaps: [
      {
        kind: "interaction_required",
        message:
          "USAA could not finish sign-in automatically; open the browser to continue. PDPP resumes when sign-in succeeds. USAA's page reported its own system as unavailable, but this exact failure has recurred.",
        reason: "interaction_timeout",
        recovery_hint: { action: "manual_action_required", retryable: false },
        severity: "actionable",
        stream: null,
      },
      {
        kind: "run_failed",
        message: "usaa_session_failed: USAA login stalled after Next click (url=https://www.usaa.com/my/logon)",
        reason: "connector_reported_failed",
        recovery_hint: { action: "refresh_credentials", retryable: false },
        severity: "actionable",
        stream: null,
      },
      {
        kind: "checkpoint_commit",
        message: "Staged stream state was not committed",
        reason: "not_committed",
        recovery_hint: { action: "retry_by_runtime", retryable: true },
        severity: "actionable",
        stream: null,
      },
    ],
  });
  const snap = projectConnectorSummaryConnectionHealth({
    credential: { capable: true, present: true, rejected: false },
    freshness: FRESH,
    lastRun: run,
    lastSuccessfulRun: null,
    schedule: { enabled: true },
  });
  const credentialCondition = snap.conditions?.find((c) => c.type === "CredentialsValid" && c.status === "false");
  assert.equal(
    credentialCondition,
    undefined,
    "a login-flow stall with a competing manual_action gap must NOT manufacture a credential/reconnect prompt for an active, non-rejected credential"
  );
});

test("§10-C control: a genuine 401/403 auth failure still drives a credential prompt EVEN alongside a competing manual_action gap", () => {
  // Evidence-specific guard against over-correction: a competing
  // manual_action gap must defer to a DEFINITIVE credential-rejection signal
  // (401/403/authentication_error/credential_rejected/invalid_token), never
  // suppress one. This is the control the memory/task instruction calls for —
  // do not broadly suppress authentication_error or credential reasons when
  // current credentials are actually invalid.
  const run = failedRun({
    failure_reason: "connector_reported_failed",
    known_gaps: [
      {
        kind: "interaction_required",
        message: "Manual action requested for an unrelated interactive step.",
        reason: "interaction_timeout",
        recovery_hint: { action: "manual_action_required", retryable: false },
        severity: "actionable",
        stream: null,
      },
      {
        kind: "run_failed",
        message: "apiFetch got 401 on GET /accounts (auth - not retryable)",
        reason: "connector_reported_failed",
        recovery_hint: { action: "refresh_credentials", retryable: false },
        severity: "actionable",
        stream: null,
      },
    ],
  });
  const snap = projectConnectorSummaryConnectionHealth({
    credential: { capable: true, present: true, rejected: false },
    freshness: FRESH,
    lastRun: run,
    lastSuccessfulRun: null,
    schedule: { enabled: true },
  });
  const credentialCondition = snap.conditions?.find((c) => c.type === "CredentialsValid" && c.status === "false");
  assert.ok(
    credentialCondition,
    "a definitive 401 signal must still drive a credential prompt even alongside a competing manual_action gap"
  );
  assert.equal(credentialCondition.remediation?.action, "refresh_credentials");
});

// ─── Per-Stream Evidence Carry-Forward: proof-age freshness anchor ─────────
//
// design.md "Connection Rollup Honesty" / "Per-Stream Evidence Carry-Forward":
// carrying a stream's coverage proof forward preserves WHETHER it is proven,
// but not WHEN. A narrow scoped run's own terminal timestamp anchors the
// connection's freshness axis by default, so a stream carried forward from
// an OLD run could otherwise ride a falsely-Fresh headline. The connection's
// Healthy gate must instead be anchored to the OLDEST required-stream proof
// it actually relies on: `refineConnectionHealthWithCollectionReport`
// re-derives freshness with `oldestRequiredProofAt(report)` as the anchor
// whenever it is older than the run-derived anchor already in
// `healthInput.freshness`, via `clampFreshnessToOldestProof`.
//
// A manifest with `maximum_staleness_seconds` set makes freshness a pure
// function of `(captured_at, now)` — no wall-clock dependency — matching the
// synthetic-evidence style the rest of this suite already uses.
const STALENESS_REFRESH_POLICY = { maximum_staleness_seconds: 3600 }; // 1 hour

function collectionReportEntry(overrides: Partial<CollectionReportEntry> = {}): CollectionReportEntry {
  return {
    checkpoint: "committed",
    collected: 10,
    considered: 10,
    coverage_condition: "complete",
    coverage_strategy: null,
    covered: "unknown",
    evidence_as_of: NOW,
    forward_disposition: "complete",
    freshness_strategy: null,
    pending_detail_gaps: 0,
    pending_detail_gaps_is_floor: false,
    required: true,
    skipped: null,
    stream: "s1",
    ...overrides,
  };
}

/** Baseline healthy/complete/fresh snapshot + matching `healthInput`, as `refineConnectionHealthWithCollectionReport` expects. */
function baselineHealthyRefineInputs(nowIso: string) {
  const run = succeededRun({ finished_at: nowIso, last_at: nowIso, started_at: nowIso });
  const healthInput: Parameters<typeof projectConnectorSummaryConnectionHealth>[0] = {
    freshness: { captured_at: nowIso, status: "current" },
    lastRun: run,
    lastSuccessfulRun: run,
    nowIso,
    outbox: { axis: "idle" },
    refreshPolicy: STALENESS_REFRESH_POLICY,
    schedule: { enabled: true },
  };
  const initialConnectionHealth = projectConnectorSummaryConnectionHealth(healthInput);
  return { healthInput, initialConnectionHealth };
}

test("proof-age anchor: an old omitted-stream proof anchors freshness to stale even under a brand-new scoped run", () => {
  const { healthInput, initialConnectionHealth } = baselineHealthyRefineInputs(NOW);
  assert.equal(initialConnectionHealth.state, "healthy", "premise: the run-only projection is healthy/fresh");

  // messages' only proof is 3 hours old (older than the 1-hour staleness
  // window); the classifying run itself is brand new (NOW).
  const oldProofAt = "2026-05-19T09:00:00.000Z";
  const report = [
    collectionReportEntry({ evidence_as_of: oldProofAt, required: true, stream: "messages" }),
    collectionReportEntry({ evidence_as_of: NOW, required: true, stream: "files" }),
  ];

  const refined = refineConnectionHealthWithCollectionReport(healthInput, initialConnectionHealth, report);
  assert.notEqual(refined.axes.freshness, "fresh", "the oldest required proof anchors freshness, not the newest run");
  assert.equal(refined.axes.freshness, "stale");
  assert.notEqual(refined.state, "healthy", "a stale-anchored connection must not render Healthy");
});

test("proof-age anchor: a recent omitted-stream proof preserves Healthy (no false degrade)", () => {
  const { healthInput, initialConnectionHealth } = baselineHealthyRefineInputs(NOW);

  // messages' carried proof is only 5 minutes old — well within the 1-hour
  // staleness window — so the connection may still render Healthy.
  const recentProofAt = "2026-05-19T11:55:00.000Z";
  const report = [
    collectionReportEntry({ evidence_as_of: recentProofAt, required: true, stream: "messages" }),
    collectionReportEntry({ evidence_as_of: NOW, required: true, stream: "files" }),
  ];

  const refined = refineConnectionHealthWithCollectionReport(healthInput, initialConnectionHealth, report);
  assert.equal(refined.axes.freshness, "fresh", "recent proof age does not degrade freshness");
  assert.equal(refined.state, "healthy", "recent full-scope proof + recent scoped run stays Healthy");
});

test("proof-age anchor: a required stream with NO evidence at all (window exceeded) blocks Healthy via coverage, never silently green", () => {
  const { healthInput, initialConnectionHealth } = baselineHealthyRefineInputs(NOW);

  // `messages` carries no evidence_as_of at all — its only proof fell outside
  // the carry-forward window (the run-count cap is an I/O bound, not a
  // correctness boundary: exceeding it degrades to unknown, never silent
  // green). The coverage rollup override — not the freshness anchor — is
  // what blocks Healthy here, since `oldestRequiredProofAt` only considers
  // streams that DO carry evidence.
  const report = [
    collectionReportEntry({
      coverage_condition: "unknown",
      evidence_as_of: null,
      forward_disposition: "unmeasured",
      required: true,
      stream: "messages",
    }),
    collectionReportEntry({ evidence_as_of: NOW, required: true, stream: "files" }),
  ];

  const refined = refineConnectionHealthWithCollectionReport(healthInput, initialConnectionHealth, report);
  assert.equal(refined.axes.coverage, "unknown", "the count-cap-exceeded stream degrades coverage to unknown");
  assert.notEqual(refined.state, "healthy", "no-evidence required stream blocks Healthy, never silently greened");
});

test("proof-age anchor: accepted-policy and non-required streams never anchor the freshness override", () => {
  const { healthInput, initialConnectionHealth } = baselineHealthyRefineInputs(NOW);

  const veryOldProofAt = "2026-01-01T00:00:00.000Z";
  const report = [
    // Non-required stream with an ancient proof: must NOT anchor freshness.
    collectionReportEntry({ evidence_as_of: veryOldProofAt, required: false, stream: "optional_stream" }),
    // Accepted-policy (deferred) required-false stream with an ancient proof: must NOT anchor freshness either.
    collectionReportEntry({
      coverage_condition: "deferred",
      evidence_as_of: veryOldProofAt,
      forward_disposition: "complete",
      required: false,
      stream: "drafts",
    }),
    collectionReportEntry({ evidence_as_of: NOW, required: true, stream: "files" }),
  ];

  const refined = refineConnectionHealthWithCollectionReport(healthInput, initialConnectionHealth, report);
  assert.equal(
    refined.axes.freshness,
    "fresh",
    "accepted-policy/non-required proof age must not anchor the connection"
  );
  assert.equal(refined.state, "healthy");
});
