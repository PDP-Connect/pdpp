import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { emitSpineEvent } from "../lib/spine.ts";
import { closeDb, initDb } from "../server/db.js";
import { __resetControllerInteractionStateForTests, createController } from "../runtime/controller.ts";
import { synthesizeRenderedVerdict } from "../runtime/rendered-verdict.ts";
import {
  evaluateSatisfactionContract,
  satisfiedOwnerActions,
} from "../runtime/satisfaction-watcher.ts";

const CONNECTOR_ID = "https://registry.pdpp.org/connectors/self-heal-test";
const INSTANCE_ID = "cin_self_heal";
const MANIFEST = {
  connector_id: CONNECTOR_ID,
  connector_key: "self-heal-test",
  display_name: "Self Heal Test",
  version: "1.0.0",
  streams: [],
};
const MANUAL_REFRESH = { backgroundSafe: false, interactionPosture: "otp_likely", recommendedMode: "manual" };

function action(overrides = {}) {
  return {
    affects: [],
    audience: "owner",
    cta: "Reconnect",
    kind: "reauth",
    satisfied_when: { kind: "credential_present_and_unrejected" },
    terminal: false,
    urgency: "now",
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  const axes = {
    attention: "none",
    coverage: "complete",
    freshness: "fresh",
    outbox: "idle",
    remote_surface: "none",
    ...(overrides.axes ?? {}),
  };
  return {
    axes,
    badges: { stale: false, syncing: false, ...(overrides.badges ?? {}) },
    collection_rate: null,
    conditions: overrides.conditions ?? [],
    detail_gap_backlog: overrides.detail_gap_backlog ?? null,
    dominant_condition_id: overrides.dominant_condition_id ?? null,
    forward_disposition: overrides.forward_disposition ?? "complete",
    last_success_at: overrides.last_success_at ?? null,
    next_action: null,
    next_attempt_at: overrides.next_attempt_at ?? null,
    reason_code: overrides.reason_code ?? null,
    remote_surface: null,
    state: overrides.state ?? "healthy",
    supporting_condition_ids: [],
    unknown_reasons: [],
  };
}

function stream(overrides = {}) {
  return {
    attention_open: false,
    collected: null,
    considered: null,
    coverage: "complete",
    gap_retryable: false,
    priority: "required",
    stream_id: "s1",
    ...overrides,
  };
}

function condition(overrides = {}) {
  return {
    current: true,
    expires_at: null,
    id: "Cond:reason",
    message: "m",
    observed_at: null,
    origin: "connector",
    reason: "reason",
    remediation: null,
    sensitivity: "owner",
    severity: "error",
    status: "false",
    type: "CredentialsValid",
    ...overrides,
  };
}

function detailGapBacklog(overrides = {}) {
  return {
    max_attempt_count: 0,
    next_attempt_at: null,
    pending: 0,
    pending_is_floor: false,
    pending_other: 0,
    pending_other_is_floor: false,
    recovered: null,
    terminal: null,
    ...overrides,
  };
}

function createSchedulerStore() {
  const activeRuns = new Map();
  const schedules = new Map();
  return {
    appendRunHistory: () => {},
    createSchedule: (record) => {
      const key = record.connector_instance_id ?? record.connector_id;
      schedules.set(key, {
        connector_instance_id: key,
        connector_id: record.connector_id,
        interval_seconds: record.interval_seconds,
        jitter_seconds: record.jitter_seconds,
        enabled: record.enabled,
        created_at: record.created_at,
        updated_at: record.updated_at,
      });
    },
    deleteActiveRun: (connectorInstanceId, runId) => {
      if (activeRuns.get(connectorInstanceId)?.run_id === runId) {
        activeRuns.delete(connectorInstanceId);
      }
    },
    deleteSchedule: (connectorInstanceId) => schedules.delete(connectorInstanceId),
    getSchedule: (connectorInstanceId) => schedules.get(connectorInstanceId) ?? null,
    listActiveRuns: () => [...activeRuns.values()],
    listLastRunTimes: () => [],
    listRunHistory: () => [],
    listSchedules: () => [...schedules.values()],
    setScheduleEnabled: (connectorInstanceId, enabled, updatedAt) => {
      const existing = schedules.get(connectorInstanceId);
      if (existing) {
        schedules.set(connectorInstanceId, { ...existing, enabled, updated_at: updatedAt });
      }
    },
    updateSchedule: (connectorInstanceId, patch) => {
      const existing = schedules.get(connectorInstanceId);
      if (existing) {
        schedules.set(connectorInstanceId, { ...existing, ...patch });
      }
    },
    upsertActiveRun: (record) => activeRuns.set(record.connector_instance_id ?? record.connector_id, record),
    upsertLastRunTime: () => {},
  };
}

function freshDb(t) {
  closeDb();
  initDb(join(mkdtempSync(join(tmpdir(), "pdpp-self-heal-")), "pdpp.sqlite"));
  __resetControllerInteractionStateForTests();
  t.after(() => {
    __resetControllerInteractionStateForTests();
    closeDb();
  });
}

function completeRunConnector(calls) {
  return async (opts) => {
    calls.push(opts);
    await emitSpineEvent({
      actor_id: opts.connectorId,
      actor_type: "runtime",
      event_type: "run.completed",
      object_id: opts.runId,
      object_type: "run",
      run_id: opts.runId,
      scenario_id: opts.traceContext?.scenario_id,
      status: "completed",
      trace_id: opts.traceContext?.trace_id,
      data: { records_emitted: 1, source: { connector_id: opts.connectorId } },
    });
    return { records_emitted: 1, status: "succeeded" };
  };
}

function failRunConnector(calls) {
  return async (opts) => {
    calls.push(opts);
    await emitSpineEvent({
      actor_id: opts.connectorId,
      actor_type: "runtime",
      event_type: "run.failed",
      object_id: opts.runId,
      object_type: "run",
      run_id: opts.runId,
      scenario_id: opts.traceContext?.scenario_id,
      status: "failed",
      trace_id: opts.traceContext?.trace_id,
      data: { failure_reason: "same_gap_recurred", reason: "same_gap_recurred" },
    });
    return { records_emitted: 0, status: "failed" };
  };
}

test("satisfaction watcher evaluates every unified contract kind from durable evidence", () => {
  assert.equal(
    evaluateSatisfactionContract(action(), {
      credential: { present: true, rejected: false, status: "active" },
    }),
    true
  );
  assert.equal(
    evaluateSatisfactionContract(action({ satisfied_when: { kind: "attention_resolved" } }), {
      conditions: [condition({ status: "true", severity: "info" })],
    }),
    true
  );
  assert.equal(
    evaluateSatisfactionContract(action({ satisfied_when: { kind: "confirming_run_succeeded" } }), {
      lastRun: { status: "succeeded" },
    }),
    true
  );
  assert.equal(
    evaluateSatisfactionContract(action({ affects: ["messages"], satisfied_when: { kind: "gap_recovered" } }), {
      streams: [{ stream_id: "messages", coverage: "complete" }],
    }),
    true
  );
  assert.equal(
    evaluateSatisfactionContract(action({ satisfied_when: { kind: "schedule_attached_and_enabled" } }), {
      schedule: { enabled: true },
    }),
    true
  );
  assert.equal(
    evaluateSatisfactionContract(action({ affects: ["messages"], satisfied_when: { kind: "backfill_window_covered" } }), {
      streams: [{ stream_id: "messages", coverage: "complete" }],
    }),
    true
  );
  assert.equal(
    satisfiedOwnerActions([action({ audience: "none", satisfied_when: { kind: "none" } })], {}).length,
    0,
    "none contracts are not owner-satisfiable even though they are terminally satisfied"
  );
});

test("satisfying a reauth action auto-resumes on the existing connection and can flip green", async (t) => {
  freshDb(t);
  const calls = [];
  const controller = createController({
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: () => {}, warn: () => {} },
    schedulerStore: createSchedulerStore(),
    runConnectorImpl: completeRunConnector(calls),
  });

  const before = synthesizeRenderedVerdict(
    snapshot({ conditions: [condition({ reason: "credential_rejected" })], state: "needs_attention" }),
    [stream()],
    null,
    true
  );
  assert.equal(before.required_actions[0].kind, "reauth");

  const resumed = await controller.autoResumeSatisfiedActions({
    awaitCompletion: true,
    connectorId: CONNECTOR_ID,
    connectorInstanceId: INSTANCE_ID,
    evidence: { credential: { present: true, rejected: false, status: "active" } },
    manifest: MANIFEST,
    ownerToken: "owner-token",
    requiredActions: before.required_actions,
    runId: "run_self_heal_reauth",
  });

  assert.equal(resumed.status, "started");
  assert.equal(resumed.terminal_status, "succeeded");
  assert.equal(resumed.confirming_run?.run_id, "run_self_heal_reauth");
  assert.equal(calls.length, 1, "exactly one confirming run is launched");
  assert.equal(calls[0].connectorInstanceId, INSTANCE_ID, "connection_id is preserved");
  assert.equal(calls[0].triggerKind, "manual", "owner repair clears owner-attention state without a second click");

  const after = synthesizeRenderedVerdict(snapshot({ last_success_at: "2026-06-15T12:00:00.000Z" }), [stream()], null, true);
  assert.equal(after.pill.tone, "green");
  assert.equal(after.required_actions.length, 0);
});

test("an identical re-failure re-presents the same action and does not paint green", async (t) => {
  freshDb(t);
  const calls = [];
  const controller = createController({
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: () => {}, warn: () => {} },
    schedulerStore: createSchedulerStore(),
    runConnectorImpl: failRunConnector(calls),
  });
  const before = synthesizeRenderedVerdict(
    snapshot({
      axes: { coverage: "retryable_gap", freshness: "stale" },
      forward_disposition: "resumable",
      state: "degraded",
    }),
    [stream({ coverage: "retryable_gap", gap_retryable: true, stream_id: "transactions" })],
    MANUAL_REFRESH,
    true
  );
  const retry = before.required_actions.find((entry) => entry.kind === "retry_gap");
  assert.ok(retry);

  const resumed = await controller.autoResumeSatisfiedActions({
    awaitCompletion: true,
    connectorId: CONNECTOR_ID,
    connectorInstanceId: INSTANCE_ID,
    evidence: { detailGapBacklog: detailGapBacklog({ pending: 0 }) },
    manifest: MANIFEST,
    ownerToken: "owner-token",
    requiredActions: [retry],
    runId: "run_self_heal_refailure",
  });

  assert.equal(resumed.status, "started");
  assert.equal(resumed.terminal_status, "failed");
  assert.equal(calls.length, 1, "re-failure still launches only the one confirming run");

  const after = synthesizeRenderedVerdict(
    snapshot({
      axes: { coverage: "retryable_gap", freshness: "stale" },
      conditions: [condition({ id: "TransactionsFetch:same_gap_recurred", reason: "same_gap_recurred", type: "StreamCoverage" })],
      forward_disposition: "resumable",
      reason_code: "same_gap_recurred",
      state: "degraded",
    }),
    [stream({ coverage: "retryable_gap", gap_retryable: true, stream_id: "transactions" })],
    MANUAL_REFRESH,
    true
  );
  assert.equal(after.pill.tone, "amber");
  assert.equal(after.detail.reason_code, "same_gap_recurred");
  assert.ok(after.required_actions.some((entry) => entry.kind === "retry_gap"), "same action remains visible");
});

test("partial recovery clears recovered stream action refs and keeps unrecovered stream action", () => {
  const baseSnapshot = snapshot({
    axes: { coverage: "retryable_gap", freshness: "stale" },
    forward_disposition: "resumable",
    state: "degraded",
  });
  const before = synthesizeRenderedVerdict(
    baseSnapshot,
    [
      stream({ coverage: "retryable_gap", gap_retryable: true, stream_id: "transactions" }),
      stream({ coverage: "retryable_gap", gap_retryable: true, stream_id: "accounts" }),
    ],
    MANUAL_REFRESH,
    true
  );
  const beforeRetry = before.required_actions.find((entry) => entry.kind === "retry_gap");
  assert.deepEqual(beforeRetry?.affects, ["transactions", "accounts"]);

  const after = synthesizeRenderedVerdict(
    baseSnapshot,
    [
      stream({ coverage: "retryable_gap", gap_retryable: true, stream_id: "transactions" }),
      stream({ coverage: "complete", gap_retryable: false, stream_id: "accounts" }),
    ],
    MANUAL_REFRESH,
    true
  );

  const afterRetry = after.required_actions.find((entry) => entry.kind === "retry_gap");
  assert.deepEqual(afterRetry?.affects, ["transactions"]);
  assert.notEqual(after.streams.find((row) => row.stream_id === "transactions")?.action_ref, null);
  assert.equal(after.streams.find((row) => row.stream_id === "accounts")?.action_ref, null);
});
