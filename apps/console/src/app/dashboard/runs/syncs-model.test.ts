import assert from "node:assert/strict";
import test from "node:test";
import type {
  RefConnectionHealthSnapshot,
  RefConnectorSummary,
  RefRenderedVerdict,
  RefRequiredAction,
  RefSchedule,
  RunSummary,
} from "../lib/ref-client.ts";
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
const RESUME_FALSE_REASSURANCE_RE = /fills on the next successful run|resumes normally/i;
const RESUME_NORMALLY_RE = /resume normally/i;
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

function action(overrides: Partial<RefRequiredAction> = {}): RefRequiredAction {
  return {
    affects: [],
    audience: "owner",
    cta: "Retry now",
    kind: "retry_gap",
    satisfied_when: { kind: "gap_recovered" },
    terminal: false,
    urgency: "verifying",
    ...overrides,
  };
}

function renderedVerdict(overrides: Partial<RefRenderedVerdict> = {}): RefRenderedVerdict {
  return {
    annotations: [],
    channel: "calm",
    detail: {},
    forward_statement: "Current and collecting normally.",
    pill: { label: "Healthy", tone: "green" },
    progress: {
      gaps_drained_last_run: null,
      headline: "Current",
      last_refreshed_at: "2026-06-13T04:00:00Z",
      mode: "scheduled",
      records_committed_last_run: null,
      retained_records: 10,
    },
    required_actions: [],
    streams: [],
    trace: {},
    ...overrides,
  };
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

function connectorRun(overrides: Partial<NonNullable<RefConnectorSummary["last_run"]>> = {}) {
  return {
    event_count: 7,
    failure_reason: null,
    finished_at: "2026-06-13T04:00:06Z",
    first_at: "2026-06-13T04:00:00Z",
    last_at: "2026-06-13T04:00:06Z",
    run_id: "run_connector_summary",
    started_at: "2026-06-13T04:00:00Z",
    status: "succeeded",
    ...overrides,
  } satisfies NonNullable<RefConnectorSummary["last_run"]>;
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

test("connector-wide runs are not attributed to every same-type connection", () => {
  const model = buildSyncsViewModel({
    connectors: [
      connector({
        connection_id: "cin_amazon_a",
        connector_id: "amazon",
        display_name: "Amazon A",
        streams: ["orders"],
      }),
      connector({
        connection_id: "cin_amazon_b",
        connector_id: "amazon",
        display_name: "Amazon B",
        streams: ["orders"],
      }),
    ],
    runs: [
      run({
        connector_id: "amazon",
        event_count: 99,
        run_id: "run_connector_wide_only",
        status: "failed",
      }),
    ],
  });

  assert.deepEqual(
    model.groups.map((group) => group.streams[0]?.delta),
    ["no recent run", "no recent run"],
    "a connector-keyed run without exact connection identity must not paint either source"
  );
  assert.deepEqual(
    model.groups.map((group) => group.streams[0]?.failed),
    [false, false]
  );
});

test("browser surface profile keys attribute a run only to the matching connection", () => {
  const model = buildSyncsViewModel({
    connectors: [
      connector({
        connection_id: "cin_chase_a",
        connector_id: "chase",
        display_name: "Chase A",
        streams: ["transactions"],
      }),
      connector({
        connection_id: "cin_chase_b",
        connector_id: "chase",
        display_name: "Chase B",
        streams: ["transactions"],
      }),
    ],
    runs: [
      run({
        browser_surface_profile_key: "chase:cin_chase_b",
        connector_id: "chase",
        event_count: 3,
        run_id: "run_chase_b",
        status: "failed",
      }),
    ],
  });

  assert.equal(model.groups[0]?.streams[0]?.delta, "no recent run");
  assert.equal(model.groups[0]?.streams[0]?.failed, false);
  assert.equal(model.groups[1]?.streams[0]?.delta, "sync failed");
  assert.equal(model.groups[1]?.streams[0]?.failed, true);
});

test("connection summary last_run remains available without connector-wide run attribution", () => {
  const model = buildSyncsViewModel({
    connectors: [
      connector({
        connection_id: "cin_exact",
        connector_id: "gmail",
        last_run: connectorRun({ event_count: 42, run_id: "run_exact_summary" }),
        streams: ["messages"],
      }),
    ],
    runs: [],
  });

  assert.equal(model.groups[0]?.streams[0]?.delta, "+42 records");
  assert.deepEqual(model.groups[0]?.streams[0]?.rhythm, ["ok"]);
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

// ─── RenderedVerdict conformance matrix ──────────────────────────────────────

test("failure cards bind terminal gaps to rendered verdict copy, never retryable prose", () => {
  const terminalHealth = health({
    axes: { attention: "none", coverage: "terminal_gap", freshness: "stale", outbox: "idle" },
    reason_code: "terminal_gap",
    state: "degraded",
  });
  const model = buildSyncsViewModel({
    connectors: [
      connector({
        connection_health: terminalHealth,
        rendered_verdict: renderedVerdict({
          channel: "advisory",
          forward_statement: "This connector needs a code fix before it can collect again.",
          pill: { label: "Can't collect", tone: "red" },
          required_actions: [
            action({
              audience: "maintainer",
              cta: "Connector code needs a fix",
              kind: "code_fix",
              satisfied_when: { kind: "none" },
              terminal: true,
              urgency: "soon",
            }),
          ],
        }),
      }),
    ],
    runs: [],
  });

  const card = model.failureCards[0];
  assert.equal(card?.summary.prose, "This connector needs a code fix before it can collect again.");
  assert.equal(card?.summary.cta, "wait");
  assert.equal(card?.summary.actionLabel, "Connector code needs a fix");
  assert.equal(card?.summary.ownerActionRequired, false);
  assert.doesNotMatch(card?.summary.prose ?? "", RESUME_FALSE_REASSURANCE_RE);
  assert.equal(model.band.needYourHand, 0);
  assert.equal(model.groups[0]?.health, "failing");
});

test("failure cards bind retryable gaps to the rendered Retry now action", () => {
  const model = buildSyncsViewModel({
    connectors: [
      connector({
        connection_health: health({
          axes: { attention: "none", coverage: "retryable_gap", freshness: "stale", outbox: "idle" },
          reason_code: "retryable_gap",
          state: "degraded",
        }),
        rendered_verdict: renderedVerdict({
          channel: "advisory",
          forward_statement: "Retry now to give the recoverable gap another run.",
          pill: { label: "Degraded", tone: "amber" },
          required_actions: [action()],
        }),
      }),
    ],
    runs: [],
  });

  const card = model.failureCards[0];
  assert.equal(card?.summary.prose, "Retry now to give the recoverable gap another run.");
  assert.equal(card?.summary.cta, "connection_detail");
  assert.equal(card?.summary.actionLabel, "Retry now");
  assert.equal(card?.summary.ownerActionRequired, false, "retry is an advisory accelerant, not attention");
  assert.equal(model.band.needYourHand, 0);
  assert.equal(model.groups[0]?.health, "failing");
});

test("failure cards bind stale manual refresh to Refresh now without marking health as failing", () => {
  const model = buildSyncsViewModel({
    connectors: [
      connector({
        connection_health: health({
          axes: { attention: "none", coverage: "complete", freshness: "stale", outbox: "idle" },
          reason_code: "stale_manual_refresh",
          state: "healthy",
        }),
        rendered_verdict: renderedVerdict({
          annotations: [{ kind: "freshness", text: "Last refreshed yesterday" }],
          channel: "advisory",
          forward_statement: "Run a refresh to bring this up to date.",
          pill: { label: "Healthy", tone: "green" },
          required_actions: [
            action({
              cta: "Refresh now",
              kind: "refresh_now",
              satisfied_when: { kind: "confirming_run_succeeded" },
              urgency: "soon",
            }),
          ],
        }),
      }),
    ],
    runs: [],
  });

  const card = model.failureCards[0];
  assert.equal(card?.summary.prose, "Run a refresh to bring this up to date.");
  assert.equal(card?.summary.actionLabel, "Refresh now");
  assert.equal(card?.summary.ownerActionRequired, false);
  assert.equal(model.band.needYourHand, 0);
  assert.equal(model.groups[0]?.health, "ok");
});

test("failure cards bind dead-letter backlog to collector action, not resume-normally copy", () => {
  const model = buildSyncsViewModel({
    connectors: [
      connector({
        connection_health: health({
          axes: { attention: "none", coverage: "complete", freshness: "fresh", outbox: "stalled" },
          reason_code: "local_exporter_dead_letter_backlog",
          state: "degraded",
        }),
        rendered_verdict: renderedVerdict({
          channel: "attention",
          forward_statement: "Check the collector before this source can make progress.",
          pill: { label: "Degraded", tone: "amber" },
          required_actions: [
            action({
              cta: "Check the collector",
              kind: "add_info",
              satisfied_when: { kind: "attention_resolved" },
              urgency: "now",
            }),
          ],
        }),
      }),
    ],
    runs: [],
  });

  const card = model.failureCards[0];
  assert.equal(card?.summary.prose, "Check the collector before this source can make progress.");
  assert.equal(card?.summary.cta, "connection_detail");
  assert.equal(card?.summary.actionLabel, "Check the collector");
  assert.equal(card?.summary.ownerActionRequired, true);
  assert.doesNotMatch(card?.summary.prose ?? "", RESUME_NORMALLY_RE);
  assert.equal(model.band.needYourHand, 1);
});

test("healthy sources with only benign rendered verdict signals do not get a failure card", () => {
  const model = buildSyncsViewModel({
    connectors: [
      connector({
        connection_health: health({
          axes: { attention: "none", coverage: "complete", freshness: "fresh", outbox: "unknown" },
          reason_code: "outbox_unknown",
          state: "healthy",
        }),
        rendered_verdict: renderedVerdict({
          channel: "calm",
          forward_statement: "Current and collecting normally.",
          pill: { label: "Healthy", tone: "green" },
          required_actions: [],
        }),
      }),
    ],
    runs: [],
  });

  assert.equal(model.failureCards.length, 0);
  assert.equal(model.band.needYourHand, 0);
  assert.equal(model.groups[0]?.health, "ok");
});
