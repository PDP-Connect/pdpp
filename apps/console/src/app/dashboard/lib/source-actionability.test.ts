import assert from "node:assert/strict";
import test from "node:test";
import type {
  RefConnectionHealthSnapshot,
  RefConnectorSummary,
  RefRenderedVerdict,
  RefRequiredAction,
} from "./ref-client.ts";
import {
  hasPrimaryOwnerLocalDeviceRemediation,
  primaryOwnerActionRemediation,
  projectSourceActionability,
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
