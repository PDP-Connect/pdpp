import assert from "node:assert/strict";
import test from "node:test";
import type { RefConnectionHealthSnapshot, RefConnectorSummary, RefSchedule, RunSummary } from "../lib/ref-client.ts";
import {
  buildSyncsViewModel,
  deriveConnectionRhythm,
  describeCadence,
  describeDelta,
  describeDuration,
} from "./syncs-model.ts";

// The false-prompt the source-pressure guard must never emit on a throttled
// connection. Hoisted to module scope so the regex is compiled once.
const RECONNECT_PROMPT_RE = /reconnect|log in/i;
const THROTTLING_RE = /throttling/i;

// ─── Health fixtures ──────────────────────────────────────────────────────────

function health(overrides: Partial<RefConnectionHealthSnapshot> = {}): RefConnectionHealthSnapshot {
  return {
    axes: { attention: "none", coverage: "complete", freshness: "fresh", outbox: "idle" },
    badges: { stale: false, syncing: false },
    last_success_at: "2026-06-13T04:00:00Z",
    next_action: null,
    next_attempt_at: null,
    reason_code: null,
    state: "healthy",
    unknown_reasons: [],
    ...overrides,
  };
}

function connector(overrides: Partial<RefConnectorSummary> = {}): RefConnectorSummary {
  return {
    connection_health: health(),
    connection_id: "cin_test",
    connector_id: "test_connector",
    display_name: "Test Connection",
    freshness: {},
    last_run: null,
    last_successful_run: null,
    manifest_version: null,
    next_action: null,
    schedule: null,
    streams: ["alpha", "beta"],
    total_records: 0,
    ...overrides,
  } as RefConnectorSummary;
}

function run(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    connector_id: "test_connector",
    event_count: 0,
    failure_reason: null,
    first_at: "2026-06-13T04:00:00Z",
    grant_id: null,
    kinds: [],
    last_at: "2026-06-13T04:00:06Z",
    needs_input: false,
    object: "run_summary",
    run_id: "run_1",
    status: "succeeded",
    ...overrides,
  };
}

function schedule(overrides: Partial<RefSchedule> = {}): RefSchedule {
  return {
    active_run_id: null,
    automation_mode: "unattended",
    automation_summary: "",
    connector_id: "test_connector",
    created_at: "2026-06-01T00:00:00Z",
    effective_mode: "automatic",
    enabled: true,
    human_attention_needed: false,
    ineligibility_reason: null,
    interval_seconds: 900,
    jitter_seconds: 0,
    last_error_code: null,
    last_finished_at: null,
    last_started_at: null,
    last_successful_at: null,
    minimum_interval_warning: null,
    next_due_at: "2026-06-13T05:00:00Z",
    notification_posture: "none",
    object: "schedule",
    policy_warning: null,
    recommended_policy: null,
    scheduler_backoff: null,
    trigger_kind: "scheduled",
    updated_at: "2026-06-13T04:00:00Z",
    ...overrides,
  } as RefSchedule;
}

// ─── THE honesty test: source-pressure cooldown must never say "reconnect" ────

test("source-pressure cooldown produces a WAIT card, never a reconnect prompt", () => {
  const coolingHealth = health({
    state: "cooling_off",
    reason_code: "source_pressure",
    next_attempt_at: "2026-06-13T09:00:00Z",
    axes: { attention: "none", coverage: "partial", freshness: "fresh", outbox: "idle" },
  });
  const model = buildSyncsViewModel({
    connectors: [connector({ connection_health: coolingHealth, display_name: "ChatGPT — personal" })],
    runs: [run({ status: "succeeded", event_count: 34 })],
  });

  assert.equal(model.failureCards.length, 1, "a cooling connection still gets an honest card");
  const card = model.failureCards[0];
  if (!card) {
    throw new Error("expected a failure card");
  }
  assert.equal(card.summary.cta, "wait", "source-pressure cooldown CTA must be wait");
  assert.notEqual(card.summary.cta, "reconnect", "source-pressure must NEVER yield a reconnect CTA");
  assert.match(card.summary.prose, THROTTLING_RE, "copy must explain the source is throttling, not that auth broke");
  assert.doesNotMatch(card.summary.prose, RECONNECT_PROMPT_RE, "must not tell the owner to reconnect / log in");
  // The band must not count a self-handling cooldown under "need your hand".
  assert.equal(model.band.needYourHand, 0, "a throttled, self-resolving connection needs no hand");
});

test("a blocked connection with a source-pressure backlog still gets the WAIT card", () => {
  // A `blocked` raw state that carries a scheduled next attempt + pending backlog
  // is a deferral, not a terminal stop — the guard must suppress the reconnect.
  const blockedButThrottled = health({
    state: "blocked",
    reason_code: "blocked_threshold",
    next_attempt_at: "2026-06-13T09:00:00Z",
    detail_gap_backlog: {
      max_attempt_count: 5,
      next_attempt_at: "2026-06-13T09:00:00Z",
      pending: 900,
      pending_is_floor: true,
      recovered: 100,
    },
  });
  const model = buildSyncsViewModel({
    connectors: [connector({ connection_health: blockedButThrottled })],
    runs: [],
  });
  assert.equal(model.failureCards[0]?.summary.cta, "wait");
});

test("a genuine blocked connection (no backlog, no next attempt) DOES prompt reconnect", () => {
  const reallyBlocked = health({
    state: "blocked",
    reason_code: "credentials_expired",
    next_attempt_at: null,
  });
  const model = buildSyncsViewModel({
    connectors: [connector({ connection_health: reallyBlocked })],
    runs: [],
  });
  const card = model.failureCards[0];
  assert.equal(card?.summary.cta, "reconnect", "genuine credential failure keeps the reconnect CTA");
  assert.equal(model.band.needYourHand, 1, "a genuine block counts under need-your-hand");
});

// ─── Healthy connections, band counts, groups ─────────────────────────────────

test("healthy connections produce no card and count their streams on schedule", () => {
  const model = buildSyncsViewModel({
    connectors: [connector({ streams: ["alpha", "beta", "gamma"] })],
    runs: [run({ event_count: 12 })],
  });
  assert.equal(model.failureCards.length, 0);
  assert.equal(model.band.onSchedule, 3);
  assert.equal(model.band.allClear, true);
  assert.equal(model.groups[0]?.health, "ok");
  assert.equal(model.groups[0]?.streams.length, 3);
});

test("revoked connections are excluded from the live syncs surface", () => {
  const model = buildSyncsViewModel({
    connectors: [connector({ revoked_at: "2026-06-10T00:00:00Z" })],
    runs: [],
  });
  assert.equal(model.groups.length, 0);
  assert.equal(model.failureCards.length, 0);
});

// ─── Rhythm + helpers ─────────────────────────────────────────────────────────

test("deriveConnectionRhythm maps terminal runs oldest-first, skipping non-terminal", () => {
  const ticks = deriveConnectionRhythm([
    run({ run_id: "r3", status: "failed" }),
    run({ run_id: "r2", status: "started" }), // non-terminal, skipped
    run({ run_id: "r1", status: "succeeded" }),
  ]);
  // newest-first input → oldest-first output; started is dropped.
  assert.deepEqual(ticks, ["ok", "fail"]);
});

test("succeeded_with_gaps counts as an ok tick, not a failure", () => {
  assert.deepEqual(deriveConnectionRhythm([run({ status: "succeeded_with_gaps" })]), ["ok"]);
});

test("describeCadence humanizes the schedule interval", () => {
  assert.equal(describeCadence(schedule({ interval_seconds: 900 })), "every 15 min");
  assert.equal(describeCadence(schedule({ interval_seconds: 86_400 })), "daily");
  assert.equal(describeCadence(schedule({ effective_mode: "manual" })), "manual");
  assert.equal(describeCadence(schedule({ enabled: false, effective_mode: "paused" })), "paused");
  assert.equal(describeCadence(null), "on demand");
});

test("describeDelta reads records, no change, and failure honestly", () => {
  assert.equal(describeDelta({ failed: false, eventCount: 38 }), "+38 records");
  assert.equal(describeDelta({ failed: false, eventCount: 1 }), "+1 record");
  assert.equal(describeDelta({ failed: false, eventCount: 0 }), "no change");
  assert.equal(describeDelta({ failed: true, eventCount: 5 }), "sync failed");
});

test("describeDuration formats sub-minute and minute spans", () => {
  assert.equal(describeDuration("2026-06-13T04:00:00Z", "2026-06-13T04:00:06Z"), "6 s");
  assert.equal(describeDuration("2026-06-13T04:00:00Z", "2026-06-13T04:02:04Z"), "2 m 4 s");
  assert.equal(describeDuration(null, "2026-06-13T04:00:06Z"), null);
});

test("a failing connection holds its next and marks rows failed", () => {
  const failHealth = health({ state: "blocked", reason_code: "credentials_expired" });
  const model = buildSyncsViewModel({
    connectors: [connector({ connection_health: failHealth, schedule: schedule() })],
    runs: [run({ status: "failed" })],
  });
  const group = model.groups[0];
  assert.equal(group?.health, "failing");
  assert.equal(group?.streams[0]?.failed, true);
  assert.equal(group?.streams[0]?.next, "held");
  assert.equal(group?.streams[0]?.delta, "sync failed");
});
