import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type {
  RefCollectionReportEntry,
  RefConnectionHealthSnapshot,
  RefConnectorSummary,
  RefRenderedVerdict,
  RefRequiredAction,
  RefSchedule,
  RunSummary,
} from "../lib/ref-client.ts";
import { sourceAttentionHeadline, sourceWorkFromConnectors } from "../lib/source-actionability.ts";
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
const ACTIONABILITY_RENDERED_STATUS_RE = /actionability\.renderedStatus/;
const RAW_VERDICT_TONE_RE = /rendered_verdict\.pill\.tone|verdict\.pill\.tone/;
const SYNCS_PAGE_SOURCE = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const DEFERRED_RUN_NOT_LIVE_RE =
  /return !\["cancelled", "completed", "deferred", "failed", "rejected", "succeeded"\]\.includes\(run\.status\);/;

const SYNC_MODEL_SOURCE = readFileSync(new URL("./syncs-model.ts", import.meta.url), "utf8");

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

function collectionEntry(
  overrides: Partial<RefCollectionReportEntry> & Pick<RefCollectionReportEntry, "stream">
): RefCollectionReportEntry {
  return {
    checkpoint: "ok",
    collected: 0,
    considered: "unknown",
    coverage_condition: "complete",
    forward_disposition: "resumable",
    pending_detail_gaps: 0,
    skipped: null,
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
  assert.equal(model.band.needsReview, 1, "a visible wait card still counts as review, not all-clear");
  assert.equal(model.band.allClear, false, "visible cards must not render the all-clear note");
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
  assert.equal(model.band.needsReview, 0);
  assert.equal(model.band.allClear, true);
  assert.equal(model.groups[0]?.health, "ok");
  assert.equal(model.groups[0]?.streams.length, 3);
});

test("syncs group health uses the shared source status instead of raw verdict tone", () => {
  assert.match(SYNC_MODEL_SOURCE, ACTIONABILITY_RENDERED_STATUS_RE);
  assert.doesNotMatch(
    SYNC_MODEL_SOURCE,
    RAW_VERDICT_TONE_RE,
    "Runs must not remap raw rendered_verdict tone outside the shared source-actionability model"
  );
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
    model.groups.map((group) => group.lastRunDelta),
    [null, null],
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

  const byConnection = new Map(model.groups.map((group) => [group.connectionId, group]));
  assert.equal(byConnection.get("cin_chase_a")?.lastRunDelta, null);
  assert.equal(byConnection.get("cin_chase_a")?.streams[0]?.failed, false);
  assert.equal(byConnection.get("cin_chase_b")?.lastRunDelta, "sync failed");
  assert.equal(byConnection.get("cin_chase_b")?.streams[0]?.failed, true);
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

  assert.equal(model.groups[0]?.lastRunDelta, "+42 records");
  assert.deepEqual(model.groups[0]?.lastRunRhythm, ["ok"]);
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

test("browser-capacity deferrals are terminal but not sync failures", () => {
  assert.deepEqual(deriveConnectionRhythm([run({ status: "deferred" })]), ["ok"]);
});

test("syncs overview does not treat browser-capacity deferrals as live runs", () => {
  assert.match(SYNCS_PAGE_SOURCE, DEFERRED_RUN_NOT_LIVE_RE);
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
    runs: [run({ connection_id: "cin_test", status: "failed" })],
  });
  const group = model.groups[0];
  assert.equal(group?.health, "failing");
  assert.equal(group?.streams[0]?.failed, true);
  assert.equal(group?.streams[0]?.next, "held");
  assert.equal(group?.lastRunDelta, "sync failed");
});

test("a broken connector does not rewrite a successful last run into sync failed", () => {
  const model = buildSyncsViewModel({
    connectors: [
      connector({
        connection_health: health({
          axes: { attention: "none", coverage: "terminal_gap", freshness: "stale", outbox: "idle" },
          reason_code: "qfx_download_failed",
          state: "degraded",
        }),
        last_run: connectorRun({ event_count: 52, run_id: "run_chase_success", status: "succeeded" }),
        last_successful_run: connectorRun({ event_count: 52, run_id: "run_chase_success", status: "succeeded" }),
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

  const group = model.groups[0];
  assert.equal(group?.health, "failing", "the group still shows the current connector state");
  assert.equal(group?.lastRunDelta, "+52 records", "last result remains the successful run fact");
  assert.equal(
    group?.streams[0]?.failed,
    false,
    "row failure style follows the actual last run, not the current verdict"
  );
  assert.equal(group?.streams[0]?.next, "held", "the current verdict still blocks future collection");
  assert.deepEqual(group?.lastRunRhythm, ["ok"], "rhythm agrees with the successful last run");
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
  assert.equal(model.band.needsReview, 1);
  assert.equal(model.band.allClear, false);
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
  assert.equal(model.band.needsReview, 1);
  assert.equal(model.band.allClear, false);
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
  assert.equal(card?.work?.group, "review");
  assert.equal(model.band.needYourHand, 0);
  assert.equal(model.band.needsReview, 1);
  assert.equal(model.band.allClear, false);
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
  assert.equal(model.band.needsReview, 1);
  assert.equal(model.band.allClear, false);
});

test("device-local recovery counts as need-your-hand while navigating to recovery steps", () => {
  const model = buildSyncsViewModel({
    connectors: [
      connector({
        connection_health: health({
          axes: { attention: "open", coverage: "complete", freshness: "fresh", outbox: "stalled" },
          reason_code: "local_exporter_dead_letter_backlog",
          state: "degraded",
        }),
        rendered_verdict: renderedVerdict({
          channel: "attention",
          forward_statement: "The local collector has saved records on its host that did not upload to this server.",
          pill: { label: "Degraded", tone: "amber" },
          required_actions: [
            action({
              cta: "Run local recovery",
              kind: "add_info",
              remediation: {
                cause: "dead_letter_backlog",
                commands: [],
                kind: "local_collector_recovery",
                label: "Recover local collector uploads",
                summary: "Recover saved records on the host that owns them.",
                target: { identity_source: "source_instance_bindings", kind: "local_device" },
              },
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
  assert.equal(card?.summary.cta, "connection_detail");
  assert.equal(card?.summary.actionLabel, "See recovery steps");
  assert.equal(card?.summary.ownerActionRequired, true);
  assert.equal(card?.work?.group, "needsOwner");
  assert.equal(model.band.needYourHand, 1);
  assert.equal(model.band.needsReview, 1);
});

test("failure cards carry shared source-work groups for Runs presentation", () => {
  const model = buildSyncsViewModel({
    connectors: [
      connector({
        connection_id: "cin_owner",
        display_name: "Owner source",
        rendered_verdict: renderedVerdict({
          channel: "attention",
          forward_statement: "Reconnect this account and collection resumes.",
          pill: { label: "Can't collect", tone: "red" },
          required_actions: [
            action({
              cta: "Reconnect this account",
              kind: "reauth",
              satisfied_when: { kind: "credential_present_and_unrejected" },
              urgency: "now",
            }),
          ],
        }),
      }),
      connector({
        connection_id: "cin_review",
        display_name: "Review source",
        rendered_verdict: renderedVerdict({
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
      connector({
        connection_id: "cin_system",
        display_name: "System source",
        rendered_verdict: renderedVerdict({
          channel: "advisory",
          forward_statement: "Latest collection completed with known coverage gaps.",
          pill: { label: "Degraded", tone: "amber" },
          required_actions: [
            action({
              audience: "maintainer",
              cta: "Coverage gap needs review",
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

  assert.deepEqual(
    model.failureCards.map((card) => [card.connectionId, card.work?.group]),
    [
      ["cin_owner", "needsOwner"],
      ["cin_review", "review"],
      ["cin_system", "systemIssue"],
    ]
  );
});

test("syncs ranking only treats attention plus primary owner action as need-your-hand", () => {
  const maintainerFirst = connector({
    connection_id: "cin_maintainer",
    display_name: "A maintainer-only source",
    rendered_verdict: renderedVerdict({
      channel: "attention",
      forward_statement: "Connector code needs a fix before this can collect again.",
      pill: { label: "Can't collect", tone: "red" },
      required_actions: [
        action({
          audience: "maintainer",
          cta: "Connector code needs a fix",
          kind: "code_fix",
          satisfied_when: { kind: "none" },
          terminal: true,
          urgency: "now",
        }),
        action({
          cta: "Reconnect this account",
          kind: "reauth",
          satisfied_when: { kind: "credential_present_and_unrejected" },
          urgency: "soon",
        }),
      ],
    }),
  });
  const ownerFirst = connector({
    connection_id: "cin_owner",
    display_name: "Z owner-required source",
    rendered_verdict: renderedVerdict({
      channel: "attention",
      forward_statement: "Reconnect this account and collection resumes.",
      pill: { label: "Can't collect", tone: "red" },
      required_actions: [
        action({
          cta: "Reconnect this account",
          kind: "reauth",
          satisfied_when: { kind: "credential_present_and_unrejected" },
          urgency: "now",
        }),
      ],
    }),
  });

  const model = buildSyncsViewModel({ connectors: [maintainerFirst, ownerFirst], runs: [] });
  const sourceWork = sourceWorkFromConnectors([maintainerFirst, ownerFirst]);

  assert.equal(model.band.needYourHand, sourceAttentionHeadline(sourceWork).needsYou);
  assert.equal(model.groups[0]?.connectionId, "cin_owner");
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
  assert.equal(model.band.needsReview, 0);
  assert.equal(model.band.allClear, true);
  assert.equal(model.groups[0]?.health, "ok");
});

test("syncs overview collapses repeated unnamed fallback sources", () => {
  const amazonAdvisory = renderedVerdict({
    channel: "advisory",
    forward_statement: "Retry now to give the recoverable gap another run.",
    pill: { label: "Degraded", tone: "amber" },
    required_actions: [action()],
  });
  const model = buildSyncsViewModel({
    connectors: [
      connector({
        connection_id: "cin_named",
        connector_display_name: "Amazon",
        connector_id: "amazon",
        display_name: "Amazon - Personal",
        streams: ["orders", "order_items"],
      }),
      connector({
        connection_id: "cin_a",
        connector_display_name: "Amazon",
        connector_id: "amazon",
        display_name: "Amazon",
        rendered_verdict: amazonAdvisory,
        streams: ["orders", "order_items"],
      }),
      connector({
        connection_id: "cin_b",
        connector_display_name: "Amazon",
        connector_id: "amazon",
        display_name: "Amazon",
        rendered_verdict: amazonAdvisory,
        streams: ["orders", "order_items"],
      }),
      connector({
        connection_id: "cin_c",
        connector_display_name: "Amazon",
        connector_id: "amazon",
        display_name: "Amazon",
        rendered_verdict: amazonAdvisory,
        streams: ["orders", "order_items"],
      }),
    ],
    runs: [],
  });

  assert.equal(model.duplicateGroups.length, 1);
  assert.deepEqual(
    {
      advisoryCount: model.duplicateGroups[0]?.advisoryCount,
      connectorId: model.duplicateGroups[0]?.connectorId,
      firstConnectionId: model.duplicateGroups[0]?.firstConnectionId,
      kind: model.duplicateGroups[0]?.kind,
      ownerActionCount: model.duplicateGroups[0]?.ownerActionCount,
      streamCount: model.duplicateGroups[0]?.streamCount,
      total: model.duplicateGroups[0]?.total,
    },
    {
      advisoryCount: 3,
      connectorId: "amazon",
      firstConnectionId: "cin_a",
      kind: "Amazon",
      ownerActionCount: 0,
      streamCount: 6,
      total: 3,
    }
  );
  assert.deepEqual(
    model.groups.map((group) => group.connectionId),
    ["cin_named"],
    "only the named Amazon source remains expanded in the syncs overview"
  );
  assert.equal(model.failureCards.length, 0, "duplicate advisory cards collapse into the duplicate review note");
  assert.equal(model.totalGroupCount, 4);
  assert.equal(model.totalStreamCount, 8);
});

test("syncs overview keeps small duplicate fallback sets visible", () => {
  const model = buildSyncsViewModel({
    connectors: [
      connector({
        connection_id: "cin_a",
        connector_display_name: "Amazon",
        connector_id: "amazon",
        display_name: "Amazon",
        streams: ["orders"],
      }),
      connector({
        connection_id: "cin_b",
        connector_display_name: "Amazon",
        connector_id: "amazon",
        display_name: "Amazon",
        streams: ["orders"],
      }),
    ],
    runs: [],
  });

  assert.equal(model.duplicateGroups.length, 0);
  assert.deepEqual(
    model.groups.map((group) => group.connectionId),
    ["cin_a", "cin_b"]
  );
});

test("syncs overview shows ALL streams with no truncation", () => {
  const model = buildSyncsViewModel({
    connectors: [
      connector({
        connection_id: "cin_slack",
        connector_display_name: "Slack",
        connector_id: "slack",
        display_name: "Vana Slack",
        streams: ["a", "b", "c", "d", "e", "f", "g"],
      }),
    ],
    runs: [],
  });

  assert.equal(model.groups[0]?.streams.length, 7, "all 7 streams render — no cap");
  assert.equal(model.groups[0]?.totalStreamCount, 7);
  assert.equal(model.totalStreamCount, 7);
});

test("syncs overview shows ALL source groups with no cap", () => {
  const connectors = Array.from({ length: 18 }, (_, index) =>
    connector({
      connection_id: `cin_${String(index).padStart(2, "0")}`,
      connector_display_name: "Source",
      connector_id: `source_${index}`,
      display_name: `Source ${String(index).padStart(2, "0")}`,
      streams: ["records"],
    })
  );
  const model = buildSyncsViewModel({ connectors, runs: [] });

  assert.equal(model.groups.length, 18, "all 18 groups render — no cap");
  assert.equal(model.totalGroupCount, 18);
  assert.equal(model.totalStreamCount, 18);
});

test("syncs overview shows ALL review cards (no cap) and the band counts the full set", () => {
  const advisoryVerdict = renderedVerdict({
    channel: "advisory",
    forward_statement: "Run a refresh to bring this up to date.",
    pill: { label: "Degraded", tone: "amber" },
    required_actions: [action({ cta: "Refresh now", kind: "retry_gap" })],
  });
  const connectors = Array.from({ length: 8 }, (_, index) =>
    connector({
      connection_id: `cin_review_${index}`,
      connector_display_name: "Source",
      connector_id: `source_${index}`,
      display_name: `Review Source ${index}`,
      rendered_verdict: advisoryVerdict,
      streams: ["records"],
    })
  );
  const model = buildSyncsViewModel({ connectors, runs: [] });

  assert.equal(model.failureCards.length, 8, "all 8 failure cards visible — no cap");
  assert.equal(model.band.needsReview, 8);
  assert.equal(model.totalReviewCardCount, 8);
  assert.equal(model.band.allClear, false);
});

// ─── Cross-surface acceptance (recovery governor UI tranche, tasks 4.4/4.6) ───
//
// Syncs is one of the four owner surfaces the recovery-state spec binds. The
// rendered `band.needsReview` count SHALL equal the failure cards actually
// rendered, and an inactive queued recovery card SHALL read as passive progress
// ("PDPP is working"), never "Checking" and never a needs-you card.

const SYNCS_CHECKING_RE = /checking/i;

test("syncs cross-surface: rendered review-card count equals the failure cards below the band", () => {
  const attentionVerdict = renderedVerdict({
    channel: "attention",
    forward_statement: "Reconnect this account and collection resumes.",
    pill: { label: "Can't collect", tone: "red" },
    required_actions: [
      action({
        cta: "Reconnect this account",
        kind: "reauth",
        satisfied_when: { kind: "credential_present_and_unrejected" },
        urgency: "now",
      }),
    ],
  });
  const advisoryVerdict = renderedVerdict({
    channel: "advisory",
    forward_statement: "Run a refresh to bring this up to date.",
    pill: { label: "Degraded", tone: "amber" },
    required_actions: [action({ cta: "Refresh now", kind: "retry_gap" })],
  });
  const model = buildSyncsViewModel({
    connectors: [
      connector({
        connection_id: "cin_needs",
        connector_id: "chatgpt",
        display_name: "ChatGPT",
        rendered_verdict: attentionVerdict,
        streams: ["messages"],
      }),
      connector({
        connection_id: "cin_review",
        connector_id: "reddit",
        display_name: "Reddit",
        rendered_verdict: advisoryVerdict,
        streams: ["posts"],
      }),
    ],
    runs: [],
  });

  // Every rendered failure card is counted; the band never overstates rows.
  assert.equal(model.band.needsReview, model.failureCards.length);
  for (const card of model.failureCards) {
    assert.doesNotMatch(card.summary.prose, SYNCS_CHECKING_RE);
    assert.doesNotMatch(card.summary.triggerLabel, SYNCS_CHECKING_RE);
  }
});

test("syncs cross-surface: an inactive queued recovery card is passive progress, never a needs-you or Checking card", () => {
  const deferredRecoveryVerdict = renderedVerdict({
    channel: "calm",
    forward_statement: "The next run is expected to fill the remaining data.",
    pill: { label: "Degraded", tone: "amber" },
    progress: {
      gaps_drained_last_run: null,
      headline: "Collecting in the background.",
      last_refreshed_at: null,
      mode: "deferred",
      records_committed_last_run: null,
      retained_records: 100,
    },
    required_actions: [
      action({
        audience: "none",
        cta: "Collecting — no action needed",
        kind: "wait",
        satisfied_when: { kind: "none" },
        urgency: "verifying",
      }),
    ],
  });
  const model = buildSyncsViewModel({
    connectors: [
      connector({
        connection_id: "cin_amazon",
        connector_id: "amazon",
        display_name: "Amazon",
        connection_health: health({
          axes: { attention: "none", coverage: "deferred", freshness: "fresh", outbox: "idle" },
          badges: { stale: false, syncing: false },
          detail_gap_backlog: {
            max_attempt_count: 3,
            next_attempt_at: null,
            pending: 2093,
            pending_is_floor: true,
            pending_other: 0,
            pending_other_is_floor: false,
            recovered: 396,
            terminal: null,
          },
          state: "degraded",
        }),
        rendered_verdict: deferredRecoveryVerdict,
        streams: ["orders"],
      }),
    ],
    runs: [],
  });

  // The inactive backlog is passive progress: it does not raise the "needs you"
  // headline, and any rendered card routes to the working group, not needs-you.
  assert.equal(model.band.needYourHand, 0);
  for (const card of model.failureCards) {
    assert.notEqual(card.work?.group, "needsOwner");
    assert.doesNotMatch(card.summary.prose, SYNCS_CHECKING_RE);
    if (card.work) {
      assert.doesNotMatch(card.work.statusLabel, SYNCS_CHECKING_RE);
      assert.doesNotMatch(card.work.what, SYNCS_CHECKING_RE);
    }
  }
});

// ─── Fix A: no-truncation correctness ────────────────────────────────────────

test("all streams in a group are present with no truncation", () => {
  const model = buildSyncsViewModel({
    connectors: [
      connector({
        connection_id: "cin_many",
        connector_id: "slack",
        display_name: "Vana Slack",
        streams: ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta"],
      }),
    ],
    runs: [],
  });

  assert.equal(model.groups[0]?.streams.length, 7, "all 7 stream rows are present");
  assert.equal(model.groups[0]?.totalStreamCount, 7);
  assert.equal(model.totalStreamCount, 7);
  const streamNames = model.groups[0]?.streams.map((r) => r.stream);
  assert.deepEqual(streamNames, ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta"]);
});

test("all groups are present when there are more than the old cap of 6", () => {
  const connectors = Array.from({ length: 10 }, (_, i) =>
    connector({
      connection_id: `cin_${i}`,
      connector_id: `src_${i}`,
      display_name: `Source ${i}`,
      streams: ["records"],
    })
  );
  const model = buildSyncsViewModel({ connectors, runs: [] });

  assert.equal(model.groups.length, 10, "all 10 groups render — no group cap");
  assert.equal(model.totalGroupCount, 10);
  assert.equal(
    model.groups.map((g) => g.connectionId).join(","),
    connectors.map((c) => c.connection_id).join(","),
    "group order is deterministic"
  );
});

// ─── Fix B: per-stream collection_report wiring ───────────────────────────────

test("per-stream collectedThisRun is populated from collection_report when present", () => {
  const model = buildSyncsViewModel({
    connectors: [
      connector({
        connection_id: "cin_gh",
        connector_id: "github",
        display_name: "GitHub",
        streams: ["commits", "pull_requests"],
        collection_report: [
          collectionEntry({ stream: "commits", collected: 120, coverage_condition: "complete" }),
          collectionEntry({ stream: "pull_requests", collected: 8, coverage_condition: "partial" }),
        ],
      }),
    ],
    runs: [],
  });

  const group = model.groups[0];
  assert.ok(group, "group must exist");
  const byStream = new Map(group.streams.map((r) => [r.stream, r]));

  const commits = byStream.get("commits");
  assert.equal(commits?.collectedThisRun, 120, "commits stream carries its own collected count");
  assert.equal(commits?.coverageCondition, "complete");

  const prs = byStream.get("pull_requests");
  assert.equal(prs?.collectedThisRun, 8, "pull_requests stream carries its own collected count");
  assert.equal(prs?.coverageCondition, "partial");
});

test("two streams with different collection_report entries show DIFFERENT values — rows are not identical", () => {
  // This is the core bug the fix proves: rows must not all share the connection total.
  const model = buildSyncsViewModel({
    connectors: [
      connector({
        connection_id: "cin_multi",
        connector_id: "gmail",
        display_name: "Gmail",
        streams: ["messages", "attachments"],
        collection_report: [
          collectionEntry({ stream: "messages", collected: 42 }),
          collectionEntry({ stream: "attachments", collected: 0 }),
        ],
      }),
    ],
    runs: [run({ connection_id: "cin_multi", event_count: 42, status: "succeeded" })],
  });

  const group = model.groups[0];
  assert.ok(group, "group must exist");
  const byStream = new Map(group.streams.map((r) => [r.stream, r]));

  assert.equal(byStream.get("messages")?.collectedThisRun, 42);
  assert.equal(byStream.get("attachments")?.collectedThisRun, 0);

  assert.notEqual(
    byStream.get("messages")?.collectedThisRun,
    byStream.get("attachments")?.collectedThisRun,
    "stream rows must carry DIFFERENT per-stream values, not the same connection total"
  );
});

test("connection-level last-run facts live on the group, not on each stream row", () => {
  const model = buildSyncsViewModel({
    connectors: [
      connector({
        connection_id: "cin_chase",
        connector_id: "chase",
        display_name: "Chase",
        last_run: connectorRun({
          event_count: 99,
          status: "succeeded",
          first_at: "2026-06-13T04:00:00Z",
          last_at: "2026-06-13T04:00:06Z",
        }),
        streams: ["transactions", "balances"],
      }),
    ],
    runs: [],
  });

  const group = model.groups[0];
  assert.ok(group, "group must exist");

  // Connection-level facts on the group header.
  assert.equal(group.lastRunDelta, "+99 records", "delta is on the group");
  assert.equal(group.lastRunDuration, "6 s", "duration is on the group");
  assert.ok(group.lastRunAt, "lastRunAt is on the group");
  assert.ok(group.lastRunRhythm.length > 0, "rhythm ticks are on the group");

  // Stream rows do NOT carry these connection-level fields.
  for (const row of group.streams) {
    assert.equal(
      (row as unknown as { delta?: unknown }).delta,
      undefined,
      `row.delta must not exist on stream row '${row.stream}'`
    );
    assert.equal(
      (row as unknown as { rhythm?: unknown }).rhythm,
      undefined,
      `row.rhythm must not exist on stream row '${row.stream}'`
    );
    assert.equal(
      (row as unknown as { lastAt?: unknown }).lastAt,
      undefined,
      `row.lastAt must not exist on stream row '${row.stream}'`
    );
  }
});

test("honest empty state when collection_report is absent — no fabricated connection total on rows", () => {
  // Connector with NO collection_report (pre-Tranche-C reference).
  const model = buildSyncsViewModel({
    connectors: [
      connector({
        connection_id: "cin_old",
        connector_id: "old_source",
        display_name: "Old Source",
        streams: ["records"],
        // collection_report intentionally absent
      }),
    ],
    runs: [run({ connection_id: "cin_old", event_count: 55, status: "succeeded" })],
  });

  const row = model.groups[0]?.streams[0];
  assert.ok(row, "row must exist");
  assert.equal(row.collectedThisRun, null, "collectedThisRun is null when collection_report absent");
  assert.equal(row.coverageCondition, null, "coverageCondition is null when collection_report absent");
  assert.equal(row.streamSkipped, false, "streamSkipped is false when collection_report absent");

  // The connection-level event_count (55) must NOT appear on the stream row.
  assert.notEqual(
    (row as unknown as { delta?: string }).delta,
    "+55 records",
    "the connection total must not be fabricated on the stream row"
  );
});

test("streamSkipped is true only when collection_report entry has a skip", () => {
  const model = buildSyncsViewModel({
    connectors: [
      connector({
        connection_id: "cin_skip",
        connector_id: "plaid",
        display_name: "Plaid",
        streams: ["transactions", "balances"],
        collection_report: [
          collectionEntry({ stream: "transactions", collected: 0, skipped: { reason: "rate_limited" } }),
          collectionEntry({ stream: "balances", collected: 5 }),
        ],
      }),
    ],
    runs: [],
  });

  const group = model.groups[0];
  assert.ok(group);
  const byStream = new Map(group.streams.map((r) => [r.stream, r]));
  assert.equal(byStream.get("transactions")?.streamSkipped, true, "skipped stream is marked");
  assert.equal(byStream.get("balances")?.streamSkipped, false, "non-skipped stream is clean");
});

test("a stream with a real collected count keeps its per-stream truth when the connection-level run failed", () => {
  // Adversarial-audit regression: `failed` is a connection-level flag. A stream
  // that has its own collection_report entry must NOT be overridden by the
  // connection-level failure. Otherwise a stream that collected rows would
  // wrongly read as failed (the original per-row-untruth bug, reincarnated).
  const model = buildSyncsViewModel({
    connectors: [
      connector({
        connection_id: "cin_partial",
        connector_instance_id: "cin_partial",
        connector_id: "gmail",
        display_name: "Gmail",
        streams: ["messages", "labels"],
        collection_report: [
          collectionEntry({ stream: "messages", collected: 500 }),
          // labels has no report entry, so it falls back to connection failure.
        ],
      }),
    ],
    runs: [
      run({
        connection_id: "cin_partial",
        connector_instance_id: "cin_partial",
        connector_id: "gmail",
        event_count: 500,
        status: "failed",
      }),
    ],
  });

  const group = model.groups[0];
  const byStream = new Map((group?.streams ?? []).map((r) => [r.stream, r]));

  // The core assertion: a stream with its own collection_report entry shows
  // its per-stream truth and is NOT marked failed, even though the connection
  // run's status is "failed". Streams without a report entry carry no
  // per-stream collected value (null) and defer to the connection-level flag.
  assert.equal(
    byStream.get("messages")?.failed,
    false,
    "a stream with its own report is not marked failed by the connection"
  );
  assert.equal(byStream.get("messages")?.collectedThisRun, 500, "its real per-stream collected count is preserved");
  assert.equal(
    byStream.get("labels")?.failed,
    true,
    "a stream with no report falls back to the connection-level failure"
  );
  assert.equal(
    byStream.get("labels")?.collectedThisRun,
    null,
    "a stream with no report shows no fabricated per-stream count"
  );
});

test("the health band counts only the failure cards actually rendered, not advisories on collapsed duplicate groups", () => {
  // Adversarial-audit regression: the band's needs-review count must match the
  // rendered failureCards so it never says "review the cards below" with no
  // visible card.
  const model = buildSyncsViewModel({
    connectors: [
      connector({ connection_id: "cin_a", connector_id: "gmail", display_name: "Gmail", streams: ["messages"] }),
    ],
    runs: [run({ connection_id: "cin_a", event_count: 10, status: "succeeded" })],
  });
  assert.equal(
    model.band.needsReview,
    model.failureCards.length,
    "band needs-review count must equal the number of rendered failure cards"
  );
});
