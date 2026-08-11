// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { composeFleetHealthVerdict } from "../server/fleet-health.ts";

function inventory(id: string, overrides: Record<string, unknown> = {}) {
  return {
    connectorId: id.split("-")[0],
    connectorInstanceId: id,
    displayName: id,
    revokedAt: null,
    status: "active",
    ...overrides,
  };
}

function summary(id: string, overrides: Record<string, unknown> = {}) {
  return {
    connection_health: {
      axes: { attention: "none", coverage: "complete", freshness: "fresh", outbox: "idle", remote_surface: "none" },
      badges: { syncing: false },
      conditions: [],
      forward_disposition: "complete",
      state: "healthy",
      unknown_reasons: [],
    },
    connection_id: id,
    connector_id: id.split("-")[0],
    connector_instance_id: id,
    display_name: id,
    owner_state: { resolver: "healthy" },
    refresh_policy: { background_safe: true, recommended_mode: "automatic" },
    rendered_verdict: { channel: "calm", required_actions: [] },
    schedule: { enabled: true },
    ...overrides,
  };
}

function compose(
  inventoryRows: ReturnType<typeof inventory>[],
  summaries: ReturnType<typeof summary>[],
  overrides: Record<string, unknown> = {}
) {
  return composeFleetHealthVerdict({
    inventory: inventoryRows,
    runtime: { ok: true },
    streamHealth: { status: "pass" },
    summaries,
    ...overrides,
  } as unknown as Parameters<typeof composeFleetHealthVerdict>[0]);
}

function maintainerCodeFix() {
  return {
    affects: [],
    audience: "maintainer",
    cta: "Update the connector",
    kind: "code_fix",
    satisfied_when: { kind: "none" },
    terminal: true,
    urgency: "overdue",
  };
}

function ownerAction(kind: string, satisfiedWhen: string, overrides: Record<string, unknown> = {}) {
  return {
    affects: [],
    audience: "owner",
    cta: "Take action",
    kind,
    satisfied_when: { kind: satisfiedWhen },
    terminal: false,
    urgency: "soon",
    ...overrides,
  };
}

test("ChatGPT owner action, USAA recovery gap, Chase code fix, and Slack policy stay distinct from coverage pass", () => {
  const chatgptA = summary("chatgpt-a", {
    rendered_verdict: {
      channel: "attention",
      required_actions: [{ audience: "owner", satisfied_when: { kind: "attention_resolved" } }],
    },
  });
  const chatgptB = summary("chatgpt-b", {
    rendered_verdict: {
      channel: "attention",
      required_actions: [{ audience: "owner", satisfied_when: { kind: "attention_resolved" } }],
    },
  });
  const usaa = summary("usaa-a", {
    connection_health: {
      ...summary("x").connection_health,
      axes: { attention: "none", coverage: "terminal_gap", freshness: "fresh", outbox: "idle", remote_surface: "none" },
      forward_disposition: "terminal",
      state: "degraded",
    },
  });
  const chase = summary("chase-a", {
    owner_state: { resolver: "blocked_maintainer" },
    rendered_verdict: { channel: "advisory", required_actions: [maintainerCodeFix()] },
  });
  const slack = summary("slack-a", {
    owner_state: { resolver: "owner_paused" },
    refresh_policy: { background_safe: false, recommended_mode: "paused" },
    schedule: { enabled: false },
  });
  const result = compose(
    [chatgptA, chatgptB, usaa, chase, slack].map((item) => inventory(item.connection_id)),
    [chatgptA, chatgptB, usaa, chase, slack]
  );

  assert.equal(result.dimensions.coverage_audit, "pass");
  assert.equal(result.state, "unhealthy");
  assert.equal(result.fully_healthy, false);
  assert.deepEqual(
    result.dimensions.attention.needs_owner.map((item) => item.connection_id),
    ["chatgpt-a", "chatgpt-b"]
  );
  assert.deepEqual(
    result.dimensions.recovery.terminal.map((item) => item.connection_id),
    ["usaa-a"]
  );
  assert.deepEqual(
    result.dimensions.system.degraded_or_broken.map((item) => item.connection_id),
    ["usaa-a", "chase-a"]
  );
  assert.deepEqual(
    result.dimensions.intentional_policy.paused.map((item) => item.connection_id),
    ["slack-a"]
  );
});

test("stream-health authority can pass while an owner-action fleet is unhealthy", () => {
  const chatgpt = summary("chatgpt-a", {
    collection_report: [
      {
        coverage_condition: "complete",
        coverage_strategy: "checkpoint_window",
        forward_disposition: "complete",
        required: true,
        stream: "messages",
      },
    ],
    record_snapshot: { state: "current" },
    rendered_verdict: {
      channel: "attention",
      required_actions: [{ audience: "owner", satisfied_when: { kind: "attention_resolved" } }],
    },
    status: "active",
    stream_records: [{ last_updated: null, record_count: 1, stream: "messages" }],
    streams: ["messages"],
  });
  const streamHealth = { status: "pass" as const };
  const result = compose([inventory("chatgpt-a")], [chatgpt], { streamHealth });
  assert.equal(streamHealth.status, "pass");
  assert.equal(result.state, "unhealthy");
  assert.equal(result.dimensions.coverage_audit, "pass");
});

test("runtime outage and stream-health failure independently make a fleet unhealthy", () => {
  const one = summary("one-a");
  assert.equal(compose([inventory("one-a")], [one], { runtime: { ok: false } }).state, "unhealthy");
  assert.equal(compose([inventory("one-a")], [one], { streamHealth: { status: "fail" } }).state, "unhealthy");
  const unavailableBinding = summary("binding-a", {
    connection_health: {
      ...summary("x").connection_health,
      conditions: [{ current: true, status: "false", type: "RuntimeAvailable" }],
    },
  });
  assert.equal(compose([inventory("binding-a")], [unavailableBinding]).state, "unhealthy");
});

test("draft and revoked inventory remain explicit while an unassessed connection prevents a health claim", () => {
  const active = summary("active-a");
  const result = compose(
    [
      inventory("active-a"),
      inventory("draft-a", { status: "draft" }),
      inventory("revoked-a", { revokedAt: "2026-07-22T00:00:00.000Z", status: "revoked" }),
      inventory("missing-a"),
    ],
    [active]
  );
  assert.equal(result.state, "indeterminate");
  assert.deepEqual(
    result.scope.setup_pending.map((item) => item.connection_id),
    ["draft-a"]
  );
  assert.deepEqual(
    result.scope.intentional_exclusions.map((item) => item.connection_id),
    ["revoked-a"]
  );
  assert.deepEqual(
    result.scope.unassessed.map((item) => item.connection_id),
    ["missing-a"]
  );
});

test("setup pending alone prevents a strict fully-healthy claim", () => {
  const result = compose([inventory("draft-a", { status: "draft" })], []);
  assert.equal(result.state, "indeterminate");
  assert.equal(result.fully_healthy, false);
});

test("active and unknown work are indeterminate, while fresh manual and paused policy are healthy", () => {
  const active = summary("active-a", {
    connection_health: { ...summary("x").connection_health, badges: { syncing: true } },
    owner_state: { resolver: "collecting" },
  });
  const unknown = summary("unknown-a", {
    connection_health: {
      ...summary("x").connection_health,
      axes: {
        attention: "none",
        coverage: "unknown",
        freshness: "unknown",
        outbox: "unknown",
        remote_surface: "unknown",
      },
      state: "unknown",
      unknown_reasons: ["summary_missing"],
    },
  });
  const paused = summary("slack-a", {
    owner_state: { resolver: "owner_paused" },
    rendered_verdict: {
      channel: "advisory",
      required_actions: [
        ownerAction("reattach_schedule", "schedule_attached_and_enabled", {
          cta: "Resume schedule",
          surface: { kind: "schedule" },
        }),
      ],
    },
    schedule: { enabled: false },
  });
  const manual = summary("manual-a", { schedule: null });
  assert.equal(compose([inventory("active-a")], [active]).state, "indeterminate");
  assert.equal(compose([inventory("unknown-a")], [unknown]).state, "indeterminate");
  const healthyPaused = compose([inventory("slack-a")], [paused]);
  assert.equal(healthyPaused.state, "healthy");
  assert.equal(healthyPaused.fully_healthy, true);
  assert.equal(compose([inventory("manual-a")], [manual]).state, "healthy");
});

test("fresh paused schedule action is healthy, while stale manual and paused actions are advisory", () => {
  const freshPaused = summary("paused-fresh-a", {
    owner_state: { resolver: "owner_paused" },
    refresh_policy: { background_safe: false, recommended_mode: "paused" },
    rendered_verdict: {
      channel: "advisory",
      required_actions: [
        ownerAction("reattach_schedule", "schedule_attached_and_enabled", {
          cta: "Resume schedule",
          surface: { kind: "schedule" },
        }),
      ],
    },
    schedule: { enabled: false },
  });
  const staleManual = summary("manual-stale-a", {
    connection_health: {
      ...summary("x").connection_health,
      axes: { attention: "none", coverage: "complete", freshness: "stale", outbox: "idle", remote_surface: "none" },
      forward_disposition: "owner_refresh_due",
      state: "idle",
    },
    refresh_policy: { background_safe: false, recommended_mode: "manual" },
    rendered_verdict: {
      channel: "advisory",
      required_actions: [
        ownerAction("refresh_now", "confirming_run_succeeded", {
          cta: "Refresh now",
          surface: { kind: "runtime_retry" },
        }),
      ],
    },
    schedule: null,
  });
  const stalePaused = summary("paused-stale-a", {
    connection_health: {
      ...summary("x").connection_health,
      axes: { attention: "none", coverage: "complete", freshness: "stale", outbox: "idle", remote_surface: "none" },
      forward_disposition: "owner_refresh_due",
      state: "idle",
    },
    owner_state: { resolver: "owner_paused" },
    refresh_policy: { background_safe: false, recommended_mode: "paused" },
    rendered_verdict: {
      channel: "advisory",
      required_actions: [
        ownerAction("reattach_schedule", "schedule_attached_and_enabled", {
          cta: "Resume schedule",
          surface: { kind: "schedule" },
        }),
      ],
    },
    schedule: { enabled: false },
  });

  const freshResult = compose([inventory(freshPaused.connection_id)], [freshPaused]);
  assert.equal(freshResult.state, "healthy");
  assert.equal(freshResult.fully_healthy, true);
  assert.deepEqual(freshResult.dimensions.attention.needs_owner, []);

  const staleResult = compose(
    [staleManual, stalePaused].map((item) => inventory(item.connection_id)),
    [staleManual, stalePaused]
  );
  assert.equal(staleResult.state, "healthy_with_advisories");
  assert.equal(staleResult.fully_healthy, false);
  assert.deepEqual(staleResult.dimensions.attention.needs_owner, []);
  assert.deepEqual(
    staleResult.dimensions.freshness_advisories.map((item) => item.connection_id),
    ["manual-stale-a", "paused-stale-a"]
  );
  assert.deepEqual(
    staleResult.dimensions.intentional_policy.manual.map((item) => item.connection_id),
    ["manual-stale-a"]
  );
  assert.deepEqual(
    staleResult.dimensions.intentional_policy.paused.map((item) => item.connection_id),
    ["paused-stale-a"]
  );
});

test("real owner-required repair remains unhealthy even with the same typed satisfaction contract", () => {
  const repair = summary("reauth-a", {
    connection_health: {
      ...summary("x").connection_health,
      state: "blocked",
    },
    rendered_verdict: {
      channel: "attention",
      required_actions: [
        ownerAction("reauth", "credential_present_and_unrejected", {
          cta: "Reconnect this account",
          surface: { kind: "stored_credential" },
          urgency: "now",
        }),
      ],
    },
  });
  const result = compose([inventory(repair.connection_id)], [repair]);
  assert.equal(result.state, "unhealthy");
  assert.equal(result.fully_healthy, false);
  assert.deepEqual(
    result.dimensions.attention.needs_owner.map((item) => item.connection_id),
    ["reauth-a"]
  );
});

test("maintainer code-fix evidence and its owner-state resolver independently prevent a green fleet claim", () => {
  const codeFix = summary("code-fix-a", {
    rendered_verdict: { channel: "advisory", required_actions: [maintainerCodeFix()] },
  });
  const blockedMaintainer = summary("blocked-maintainer-a", {
    owner_state: { resolver: "blocked_maintainer" },
  });

  const codeFixResult = compose([inventory("code-fix-a")], [codeFix]);
  assert.equal(codeFixResult.state, "unhealthy");
  assert.deepEqual(
    codeFixResult.dimensions.system.degraded_or_broken.map((item) => item.connection_id),
    ["code-fix-a"]
  );

  const resolverResult = compose([inventory("blocked-maintainer-a")], [blockedMaintainer]);
  assert.equal(resolverResult.state, "unhealthy");
  assert.deepEqual(
    resolverResult.dimensions.system.degraded_or_broken.map((item) => item.connection_id),
    ["blocked-maintainer-a"]
  );
});

test("every closed headline state and owner resolver is classified without a healthy fallback", () => {
  const headlineExpectations = new Map([
    ["healthy", "healthy"],
    ["idle", "healthy"],
    ["blocked", "unhealthy"],
    ["cooling_off", "unhealthy"],
    ["degraded", "unhealthy"],
    ["needs_attention", "unhealthy"],
    ["unknown", "indeterminate"],
    ["catastrophic_new_state", "indeterminate"],
  ]);
  for (const [state, expected] of headlineExpectations) {
    const item = summary(`headline-${state}`, { connection_health: { ...summary("x").connection_health, state } });
    assert.equal(compose([inventory(item.connection_id)], [item]).state, expected, `headline ${state}`);
  }

  const resolverExpectations = new Map([
    ["healthy", "healthy"],
    ["owner_paused", "healthy"],
    ["refresh_due", "healthy_with_advisories"],
    ["blocked_maintainer", "unhealthy"],
    ["needs_owner", "unhealthy"],
    ["system_degraded", "unhealthy"],
    ["collecting", "indeterminate"],
    ["not_measured", "indeterminate"],
    ["setup_in_progress", "indeterminate"],
    ["retired", "indeterminate"],
    ["future_resolver", "indeterminate"],
  ]);
  for (const [resolver, expected] of resolverExpectations) {
    const item = summary(`resolver-${resolver}`, { owner_state: { resolver } });
    assert.equal(compose([inventory(item.connection_id)], [item]).state, expected, `resolver ${resolver}`);
  }
});

test("informational raw unknown axes do not override the canonical healthy headline", () => {
  for (const axis of ["coverage", "freshness", "outbox", "remote_surface"]) {
    const item = summary(`informational-${axis}`, {
      connection_health: {
        ...summary("x").connection_health,
        axes: { ...summary("x").connection_health.axes, [axis]: "unknown" },
      },
    });
    const result = compose([inventory(item.connection_id)], [item]);
    assert.equal(result.state, "healthy", `${axis} applicability belongs to connection health`);
    assert.deepEqual(result.dimensions.unknown_evidence, []);
  }
});

test("headline and reason unknowns remain fleet-unknown", () => {
  const headline = summary("headline-unknown", {
    connection_health: { ...summary("x").connection_health, state: "unknown" },
  });
  const reason = summary("reason-unknown", {
    connection_health: { ...summary("x").connection_health, unknown_reasons: ["repair_lock_unavailable"] },
  });
  for (const item of [headline, reason]) {
    const result = compose([inventory(item.connection_id)], [item]);
    assert.equal(result.state, "indeterminate");
    assert.deepEqual(
      result.dimensions.unknown_evidence.map((entry) => entry.connection_id),
      [item.connection_id]
    );
  }
});

test("unmeasured forward and owner dispositions remain independently load-bearing", () => {
  const forward = summary("forward-unmeasured", {
    connection_health: { ...summary("x").connection_health, forward_disposition: "unmeasured" },
  });
  const owner = summary("owner-unmeasured", { owner_state: { resolver: "not_measured" } });
  for (const item of [forward, owner]) {
    const result = compose([inventory(item.connection_id)], [item]);
    assert.equal(result.state, "indeterminate");
    assert.equal(result.fully_healthy, false);
    assert.deepEqual(
      result.dimensions.unknown_evidence.map((entry) => entry.connection_id),
      [item.connection_id]
    );
  }
});

test("every closed non-green health member fails the strict fully-healthy claim", () => {
  const baseHealth = summary("base").connection_health;
  const variants = [
    ...["blocked", "cooling_off", "degraded", "needs_attention", "unknown"].map((state) => [
      `headline:${state}`,
      { connection_health: { ...baseHealth, state } },
    ]),
    ...["open", "acknowledged", "in_progress"].map((attention) => [
      `attention:${attention}`,
      { connection_health: { ...baseHealth, axes: { ...baseHealth.axes, attention } } },
    ]),
    ...["gaps", "partial", "retryable_gap", "terminal_gap"].map((coverage) => [
      `coverage:${coverage}`,
      { connection_health: { ...baseHealth, axes: { ...baseHealth.axes, coverage } } },
    ]),
    ...["stale"].map((freshness) => [
      `freshness:${freshness}`,
      { connection_health: { ...baseHealth, axes: { ...baseHealth.axes, freshness } } },
    ]),
    ...["active", "stalled"].map((outbox) => [
      `outbox:${outbox}`,
      { connection_health: { ...baseHealth, axes: { ...baseHealth.axes, outbox } } },
    ]),
    ...["failed"].map((remote_surface) => [
      `remote_surface:${remote_surface}`,
      { connection_health: { ...baseHealth, axes: { ...baseHealth.axes, remote_surface } } },
    ]),
    ...["awaiting_owner", "checking", "owner_refresh_due", "resumable", "terminal", "unmeasured"].map(
      (forward_disposition) => [
        `forward_disposition:${forward_disposition}`,
        { connection_health: { ...baseHealth, forward_disposition } },
      ]
    ),
    ...[
      "blocked_maintainer",
      "collecting",
      "needs_owner",
      "not_measured",
      "refresh_due",
      "retired",
      "setup_in_progress",
      "system_degraded",
    ].map((resolver) => [`owner_resolver:${resolver}`, { owner_state: { resolver } }]),
  ] as [string, Record<string, unknown>][];

  for (const [name, overrides] of variants) {
    const item = summary(`closed-${name}`, overrides);
    const result = compose([inventory(item.connection_id)], [item]);
    assert.equal(result.fully_healthy, false, `${name} must not be fully healthy`);
  }
});

test("inventory-minus-summary and summary-minus-inventory disagreements are both unassessed", () => {
  const missingSummary = compose([inventory("missing-summary-a")], []);
  assert.equal(missingSummary.state, "indeterminate");
  assert.deepEqual(
    missingSummary.scope.unassessed.map((item) => item.connection_id),
    ["missing-summary-a"]
  );

  const extraSummary = compose([], [summary("extra-summary-a")]);
  assert.equal(extraSummary.state, "indeterminate");
  assert.deepEqual(
    extraSummary.scope.unassessed.map((item) => item.connection_id),
    ["extra-summary-a"]
  );
});

test("retryable recovery and stalled work each prevent fleet health", () => {
  const retryable = summary("retry-a", {
    connection_health: {
      ...summary("x").connection_health,
      axes: {
        attention: "none",
        coverage: "retryable_gap",
        freshness: "fresh",
        outbox: "idle",
        remote_surface: "none",
      },
      forward_disposition: "resumable",
      state: "degraded",
    },
  });
  const stalled = summary("stalled-a", {
    connection_health: {
      ...summary("x").connection_health,
      axes: { attention: "none", coverage: "complete", freshness: "fresh", outbox: "stalled", remote_surface: "none" },
      state: "degraded",
    },
  });
  const retried = compose([inventory("retry-a")], [retryable]);
  assert.equal(retried.state, "unhealthy");
  assert.deepEqual(
    retried.dimensions.recovery.retryable.map((item) => item.connection_id),
    ["retry-a"]
  );
  const stalledResult = compose([inventory("stalled-a")], [stalled]);
  assert.equal(stalledResult.state, "unhealthy");
  assert.deepEqual(
    stalledResult.dimensions.stalled_work.map((item) => item.connection_id),
    ["stalled-a"]
  );
});

test("stale manual or paused policy is advisory rather than a fleet failure", () => {
  const stale = summary("slack-a", {
    connection_health: {
      ...summary("x").connection_health,
      axes: { attention: "none", coverage: "complete", freshness: "stale", outbox: "idle", remote_surface: "none" },
      forward_disposition: "owner_refresh_due",
      state: "idle",
    },
    refresh_policy: { background_safe: false, recommended_mode: "manual" },
    schedule: { enabled: false },
  });
  const result = compose([inventory("slack-a")], [stale]);
  assert.equal(result.state, "healthy_with_advisories");
  assert.equal(result.fully_healthy, false);
  assert.deepEqual(
    result.dimensions.freshness_advisories.map((item) => item.connection_id),
    ["slack-a"]
  );
});
