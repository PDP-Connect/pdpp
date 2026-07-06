import assert from "node:assert/strict";
import test from "node:test";
import type {
  RefConnectionHealthSnapshot,
  RefConnectorSummary,
  RefDetailGapBacklog,
  RefRenderedVerdict,
  RefRequiredAction,
} from "./ref-client.ts";
import {
  hasPrimaryOwnerLocalDeviceRemediation,
  primaryOwnerActionRemediation,
  projectSourceActionability,
  SOURCE_WORK_GROUP_COPY,
  sourceAttentionHeadline,
  sourceWorkFromConnectors,
  verdictRequiresOwnerNow,
} from "./source-actionability.ts";

function health(overrides: Partial<RefConnectionHealthSnapshot> = {}): RefConnectionHealthSnapshot {
  return {
    axes: { attention: "none", coverage: "complete", freshness: "fresh", outbox: "idle" },
    badges: { stale: false, syncing: false },
    last_success_at: "2026-06-29T12:00:00Z",
    next_action: null,
    next_attempt_at: null,
    reason_code: null,
    state: "healthy",
    unknown_reasons: [],
    ...overrides,
  };
}

function action(overrides: Partial<RefRequiredAction> = {}): RefRequiredAction {
  return {
    affects: [],
    audience: "owner",
    cta: "Reconnect this account",
    kind: "reauth",
    satisfied_when: { kind: "credential_present_and_unrejected" },
    terminal: false,
    urgency: "now",
    ...overrides,
  };
}

function verdict(overrides: Partial<RefRenderedVerdict> = {}): RefRenderedVerdict {
  return {
    annotations: [],
    channel: "attention",
    detail: {},
    forward_statement: "Reconnect this account and collection resumes.",
    pill: { label: "Can't collect", tone: "red" },
    progress: {
      gaps_drained_last_run: null,
      headline: "Needs owner action.",
      last_refreshed_at: null,
      mode: "manual",
      records_committed_last_run: null,
      retained_records: null,
    },
    required_actions: [action()],
    streams: [],
    trace: {},
    ...overrides,
  };
}

function connector(overrides: Partial<RefConnectorSummary> = {}): RefConnectorSummary {
  return {
    collection_report: [],
    connection_health: health(),
    connection_id: "cin_test",
    connector_display_name: "Test Source",
    connector_id: "test",
    display_name: "Test Source",
    freshness: {},
    last_run: null,
    last_successful_run: null,
    manifest_version: null,
    next_action: null,
    rendered_verdict: verdict(),
    schedule: null,
    streams: ["messages"],
    total_records: 0,
    ...overrides,
  } as RefConnectorSummary;
}

test("source actionability treats device-local owner recovery as owner-required navigation work", () => {
  const summary = connector({
    connection_health: health({
      axes: { attention: "open", coverage: "complete", freshness: "fresh", outbox: "stalled" },
      reason_code: "local_exporter_dead_letter_backlog",
      state: "degraded",
    }),
    connector_id: "claude_code",
    rendered_verdict: verdict({
      forward_statement: "The local collector has saved records on its host that did not upload to this server.",
      required_actions: [
        action({
          cta: "See recovery steps",
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
        }),
      ],
    }),
  });

  const actionability = projectSourceActionability(summary);

  assert.equal(verdictRequiresOwnerNow(summary.rendered_verdict), true);
  assert.equal(actionability.work?.group, "needsOwner");
  assert.equal(actionability.work?.deviceLocal, true);
  assert.equal(actionability.primaryVerdictAction?.ownerRunnable, true);
  assert.equal(actionability.failureSummary?.ownerActionRequired, true);
  assert.equal(actionability.failureSummary?.actionLabel, "See recovery steps");
  assert.equal(actionability.failureSummary?.cta, "connection_detail");
  assert.equal(hasPrimaryOwnerLocalDeviceRemediation(summary.rendered_verdict), true);
  assert.equal(primaryOwnerActionRemediation(summary.rendered_verdict)?.target.kind, "local_device");
});

test("source actionability ignores secondary local-device remediation for owner-local diagnostics", () => {
  const summary = connector({
    rendered_verdict: verdict({
      required_actions: [
        action({ cta: "Reconnect this account", kind: "reauth" }),
        action({
          cta: "See recovery steps",
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
        }),
      ],
    }),
  });

  assert.equal(hasPrimaryOwnerLocalDeviceRemediation(summary.rendered_verdict), false);
  assert.equal(primaryOwnerActionRemediation(summary.rendered_verdict), null);
});

test("source actionability ignores non-owner local-device remediation for owner-local diagnostics", () => {
  const summary = connector({
    rendered_verdict: verdict({
      required_actions: [
        action({
          audience: "maintainer",
          cta: "Connector code needs a fix",
          kind: "code_fix",
          remediation: {
            cause: "stalled_unknown",
            commands: [],
            kind: "local_collector_recovery",
            label: "Fix connector code",
            summary: "Connector code needs a fix before owner recovery can proceed.",
            target: { identity_source: "source_instance_bindings", kind: "local_device" },
          },
          satisfied_when: { kind: "none" },
          terminal: true,
        }),
      ],
    }),
  });

  assert.equal(hasPrimaryOwnerLocalDeviceRemediation(summary.rendered_verdict), false);
  assert.equal(primaryOwnerActionRemediation(summary.rendered_verdict), null);
});

test("source actionability does not convert maintainer-primary work into owner work", () => {
  const actionability = projectSourceActionability(
    connector({
      connection_health: health({ state: "degraded" }),
      rendered_verdict: verdict({
        channel: "attention",
        forward_statement: "Connector code needs a fix before this can collect again.",
        required_actions: [
          action({
            audience: "maintainer",
            cta: "Connector code needs a fix",
            kind: "code_fix",
            satisfied_when: { kind: "none" },
            terminal: true,
          }),
          action({
            cta: "Reconnect this account",
            kind: "reauth",
            satisfied_when: { kind: "credential_present_and_unrejected" },
          }),
        ],
      }),
    })
  );

  assert.equal(actionability.work?.group, "systemIssue");
  assert.equal(actionability.primaryVerdictAction?.ownerRunnable, false);
  assert.equal(actionability.nextAction, null);
  assert.equal(actionability.failureSummary?.ownerActionRequired, false);
});

test("source actionability does not infer owner repair from reconnect copy without an owner-satisfiable action", () => {
  const actionability = projectSourceActionability(
    connector({
      rendered_verdict: verdict({
        channel: "attention",
        forward_statement: "Reconnect this account and collection resumes.",
        required_actions: [],
      }),
    })
  );

  assert.equal(actionability.work?.group, "systemIssue");
  assert.equal(actionability.nextAction, null);
  assert.equal(actionability.primaryVerdictAction, null);
  assert.equal(actionability.failureSummary?.ownerActionRequired, false);
});

test("source actionability treats provider-specific auth prose as inert without structured action evidence", () => {
  const actionability = projectSourceActionability(
    connector({
      connector_id: "chatgpt",
      display_name: "ChatGPT",
      rendered_verdict: verdict({
        channel: "calm",
        forward_statement: "Password reset, browser login, OTP, and push approval text here are diagnostics only.",
        pill: { label: "Healthy", tone: "green" },
        required_actions: [],
      }),
    })
  );

  assert.equal(actionability.work, null);
  assert.equal(actionability.nextAction, null);
  assert.equal(actionability.failureSummary, null);
});

test("source actionability resolves per-stream owner action availability from action_ref", () => {
  const actionability = projectSourceActionability(
    connector({
      rendered_verdict: verdict({
        required_actions: [
          action({ cta: "Retry now", kind: "retry_gap", satisfied_when: { kind: "gap_recovered" } }),
          action({
            audience: "maintainer",
            cta: "Connector code needs a fix",
            kind: "code_fix",
            satisfied_when: { kind: "none" },
            terminal: true,
          }),
        ],
        streams: [
          {
            action_ref: 0,
            collected: 0,
            considered: 10,
            coverage: "retryable_gap",
            disposition: "resumable",
            statement: "Retry can recover the gap.",
            stream_id: "messages",
          },
          {
            action_ref: 1,
            collected: 0,
            considered: 10,
            coverage: "terminal_gap",
            disposition: "terminal",
            statement: "A code fix is required.",
            stream_id: "threads",
          },
          {
            action_ref: null,
            collected: 10,
            considered: 10,
            coverage: "complete",
            disposition: "complete",
            statement: "Current.",
            stream_id: "profiles",
          },
        ],
      }),
    })
  );

  assert.equal(actionability.ownerActionByStream.messages, true);
  assert.equal(actionability.ownerActionByStream.threads, false);
  assert.equal(actionability.ownerActionByStream.profiles, false);
});

test("source actionability skips revoked connections by status or timestamp", () => {
  const groups = sourceWorkFromConnectors([
    connector({ connection_id: "cin_status", status: "revoked" }),
    connector({ connection_id: "cin_time", revoked_at: "2026-06-01T00:00:00Z" }),
    connector({ connection_id: "cin_live" }),
  ]);

  assert.deepEqual(
    groups.needsOwner.map((item) => item.routeId),
    ["cin_live"]
  );
});

test("source actionability headline counts only needs-owner work and exposes stable group copy", () => {
  const groups = sourceWorkFromConnectors([
    connector({ connection_id: "cin_owner_a", display_name: "Owner A" }),
    connector({ connection_id: "cin_owner_b", display_name: "Owner B" }),
    connector({
      connection_id: "cin_review",
      display_name: "Review source",
      rendered_verdict: verdict({
        channel: "advisory",
        pill: { label: "Healthy", tone: "green" },
        forward_statement: "Run a refresh to bring this up to date.",
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
      rendered_verdict: verdict({
        channel: "advisory",
        pill: { label: "Degraded", tone: "amber" },
        forward_statement: "Connector code needs a fix before this can collect again.",
        required_actions: [
          action({
            audience: "maintainer",
            cta: "Connector code needs a fix",
            kind: "code_fix",
            satisfied_when: { kind: "none" },
            terminal: true,
          }),
        ],
      }),
    }),
    connector({
      connection_id: "cin_not_measured",
      display_name: "Not measured source",
      rendered_verdict: verdict({
        channel: "calm",
        pill: { label: "Not measured", tone: "grey" },
        forward_statement: "Freshness has not been measured yet.",
        required_actions: [],
      }),
    }),
    connector({
      connection_id: "cin_working",
      display_name: "Working source",
      rendered_verdict: verdict({
        channel: "calm",
        pill: { label: "Checking", tone: "grey" },
        forward_statement: "Measuring coverage now.",
        required_actions: [],
      }),
    }),
  ]);

  assert.equal(groups.needsOwner.length, 2);
  assert.equal(groups.review.length, 1);
  assert.equal(groups.systemIssues.length, 1);
  assert.equal(groups.notMeasured.length, 1);
  assert.equal(groups.working.length, 1);
  assert.equal(sourceAttentionHeadline(groups).needsYou, 2);
  assert.deepEqual(SOURCE_WORK_GROUP_COPY, {
    needsOwner: {
      label: "Needs you",
      note: "Requires your input before collection can continue.",
    },
    review: {
      label: "Available actions",
      note: "Optional refreshes and retries you can start.",
    },
    systemIssue: {
      label: "System or connector issue",
      note: "PDPP needs to fix or retry this; no account action is needed from you.",
    },
    working: {
      label: "PDPP is working",
      note: "Collection, recovery, or a bounded check is active.",
    },
    notMeasured: {
      label: "Not measured",
      note: "Evidence is missing and no active check is running.",
    },
  });
});

// ─── Recovery-state grouping (connector-neutral recovery governor UI tranche) ──

const RECOVERY_CHECKING_RE = /checking/i;
const RECOVERY_SYNCING_RE = /syncing details/i;
const RECOVERY_CATCHING_UP_RE = /catching up/i;

function recoveryBacklog(overrides: Partial<RefDetailGapBacklog> = {}): RefDetailGapBacklog {
  return {
    max_attempt_count: 3,
    next_attempt_at: null,
    pending: 2093,
    pending_is_floor: true,
    pending_other: 0,
    pending_other_is_floor: false,
    recovered: 396,
    terminal: null,
    ...overrides,
  };
}

/** A calm/deferred verdict whose only action is a self-handled `wait`. */
function deferredRecoveryVerdict(overrides: Partial<RefRenderedVerdict> = {}): RefRenderedVerdict {
  return verdict({
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
    ...overrides,
  });
}

test("recovery grouping: an inactive queued recovery row is passive progress, never Checking", () => {
  const groups = sourceWorkFromConnectors([
    connector({
      connection_health: health({
        axes: { attention: "none", coverage: "deferred", freshness: "fresh", outbox: "idle" },
        badges: { stale: false, syncing: false },
        detail_gap_backlog: recoveryBacklog(),
        state: "degraded",
      }),
      rendered_verdict: deferredRecoveryVerdict(),
    }),
  ]);

  // Queued recovery is passive progress under "PDPP is working" — not the
  // "System or connector issue" amber fallthrough, and not "Checking".
  assert.equal(groups.working.length, 1);
  assert.equal(groups.systemIssues.length, 0);
  assert.equal(groups.notMeasured.length, 0);
  const row = groups.working[0];
  assert.ok(row);
  assert.doesNotMatch(row.statusLabel, RECOVERY_CHECKING_RE);
  assert.doesNotMatch(row.what, RECOVERY_CHECKING_RE);
});

test("recovery grouping: active recovery names the work like syncing order details, not Checking", () => {
  const groups = sourceWorkFromConnectors([
    connector({
      connection_health: health({
        axes: { attention: "none", coverage: "deferred", freshness: "fresh", outbox: "idle" },
        badges: { stale: false, syncing: true },
        detail_gap_backlog: recoveryBacklog(),
        state: "healthy",
      }),
      rendered_verdict: deferredRecoveryVerdict(),
    }),
  ]);

  assert.equal(groups.working.length, 1);
  const row = groups.working[0];
  assert.ok(row);
  // The row names the work ("is syncing details" / "Syncing details now."),
  // never a generic "Checking" bucket.
  assert.match(`${row.statusLabel} ${row.what}`, RECOVERY_SYNCING_RE);
  assert.doesNotMatch(`${row.statusLabel} ${row.what}`, RECOVERY_CHECKING_RE);
});

test("recovery grouping: an unsafe cooldown retry shows a wait row and no owner retry CTA", () => {
  const summary = connector({
    connection_health: health({
      axes: { attention: "none", coverage: "deferred", freshness: "fresh", outbox: "idle" },
      badges: { stale: false, syncing: false },
      detail_gap_backlog: recoveryBacklog({ next_attempt_at: "2026-07-06T15:40:00Z" }),
      next_attempt_at: "2026-07-06T15:40:00Z",
      state: "cooling_off",
    }),
    rendered_verdict: deferredRecoveryVerdict(),
  });
  const groups = sourceWorkFromConnectors([summary]);
  const actionability = projectSourceActionability(summary);

  // Cooling recovery is passive progress, not owner-runnable.
  assert.equal(groups.working.length, 1);
  assert.equal(groups.review.length, 0);
  assert.equal(groups.needsOwner.length, 0);
  // No owner-runnable CTA is offered for an unsafe (cooling) retry.
  assert.equal(actionability.ownerActionCue, null);
  assert.equal(actionability.work?.actionLabel, null);
});

test("recovery grouping: a connector-defect verdict with recoverable gaps stays a system issue", () => {
  const groups = sourceWorkFromConnectors([
    connector({
      connection_health: health({
        axes: { attention: "none", coverage: "terminal_gap", freshness: "fresh", outbox: "idle" },
        badges: { stale: false, syncing: false },
        detail_gap_backlog: recoveryBacklog(),
        state: "degraded",
      }),
      rendered_verdict: deferredRecoveryVerdict({
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
          }),
        ],
      }),
    }),
  ]);

  assert.equal(groups.systemIssues.length, 1);
  assert.equal(groups.working.length, 0);
});

test("recovery grouping: an inactive backlog routes to NAMED recovery before the Checking fallthrough (task 4.2)", () => {
  // Defense-in-depth for the "no indefinite Checking" contract: even if the
  // server-owned verdict pill were literally "Checking", an INACTIVE durable
  // backlog is passive recovery progress, so the shared projection routes it to
  // named recovery ("catching up") and never lets the generic pill-label
  // "Checking" branch claim it as an active bounded check.
  const summary = connector({
    connection_health: health({
      axes: { attention: "none", coverage: "deferred", freshness: "fresh", outbox: "idle" },
      badges: { stale: false, syncing: false },
      detail_gap_backlog: recoveryBacklog(),
      state: "degraded",
    }),
    rendered_verdict: deferredRecoveryVerdict({
      // An adversarial "Checking" pill on an inactive backlog must NOT win.
      pill: { label: "Checking", tone: "grey" },
    }),
  });
  const groups = sourceWorkFromConnectors([summary]);

  assert.equal(groups.working.length, 1);
  const row = groups.working[0];
  assert.ok(row);
  // Named recovery copy ("is catching up" / "Catching up …"), never "Checking".
  assert.doesNotMatch(row.statusLabel, RECOVERY_CHECKING_RE);
  assert.doesNotMatch(row.what, RECOVERY_CHECKING_RE);
  assert.match(`${row.statusLabel} ${row.what}`, RECOVERY_CATCHING_UP_RE);
});
