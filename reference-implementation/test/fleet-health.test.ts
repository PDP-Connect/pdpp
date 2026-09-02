// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import type { FleetConfiguredConnection, FleetSummary } from "../server/fleet-health.ts";
import { composeFleetHealthVerdict } from "../server/fleet-health.ts";

/**
 * WHY THESE HELPERS ARE TYPED AGAINST THE PRODUCER.
 *
 * `compose()` used to launder its whole argument through
 * `as unknown as Parameters<typeof composeFleetHealthVerdict>[0]`, and both
 * builders returned inferred anonymous objects with
 * `overrides: Record<string, unknown>`. Between them that switched the
 * compiler off completely at this seam: the fixture was a second, unversioned
 * copy of `FleetSummary`/`FleetConfiguredConnection`, free to omit a field
 * `composeFleetHealthVerdict` reads or to invent one it does not.
 *
 * It had already drifted. The summary fixture carried a `refresh_policy` key
 * that `FleetSummary` does not pick — dead weight copied from an older
 * snapshot, exactly the tell that a fixture is being maintained by hand
 * against nothing.
 *
 * Note this cast was INVISIBLE to `health-verdict-fixture-no-shape-cast.test.ts`,
 * which bans the double-cast form by PRODUCER NAME. Reaching the same producer
 * type indirectly (`Parameters<typeof fn>[0]`, then `FleetSummary`'s `Pick` of
 * `ConnectorSummary.connection_health`) walks straight past that regex. Typing
 * the builders is what actually closes the hole here, rather than widening a
 * name-matching ban.
 *
 * `Partial<...>` overrides (not `Record<string, unknown>`) keep every call
 * site's customisation expressive while still checking each key against the
 * real type. `connection_health` is spread from the base so a test can
 * override one axis without restating the snapshot.
 *
 * WHAT THE COMPILER FOUND once the cast came off — none of which any test
 * had been able to see:
 *   - `refresh_policy`, `collection_report`, `record_snapshot`, `status`,
 *     `stream_records` and `streams` were set on fixtures but are not in
 *     `FleetSummary` at all, and `composeFleetHealthVerdict` never reads
 *     them. Dead weight, removed.
 *   - `owner_state` literals supplied only `resolver`, omitting the required
 *     `evidence_as_of`/`owner_of_state`/`posture`.
 *   - `badges` omitted the required `stale`.
 *   - `required_actions` literals omitted five of `RequiredAction`'s fields.
 *   - the baseline `posture` was `"live"`, which is not a member of
 *     `OwnerStatePosture` ("frozen-since-last-run" | "observed") — a value
 *     the producer cannot emit.
 *
 * All 17 tests passed before and after, which is the point: every one of
 * these was invisible drift, not a behaviour change.
 */
function inventory(id: string, overrides: Partial<FleetConfiguredConnection> = {}): FleetConfiguredConnection {
  return {
    connectorId: id.split("-")[0] ?? id,
    connectorInstanceId: id,
    displayName: id,
    revokedAt: null,
    status: "active",
    ...overrides,
  };
}

/**
 * The healthy baseline snapshot.
 *
 * REMAINING CAST, STATED HONESTLY. `ConnectionHealthSnapshot` has 17 required
 * fields; `composeFleetHealthVerdict` reads six of them
 * (`axes`/`badges`/`conditions`/`forward_disposition`/`state`/`unknown_reasons`)
 * and this fixture supplies exactly those six. Fabricating the other eleven —
 * `collection_rate`, `detail_gap_backlog`, `next_action`, `remote_surface`,
 * and so on — would be inventing evidence no assertion here reads, which is
 * its own kind of dishonesty.
 *
 * The RIGHT long-term fix is to build this by CALLING `computeConnectionHealth`,
 * so the baseline is whatever the producer really emits for a healthy
 * connection. That is a larger change than this one: it means constructing a
 * full `ComputeConnectionHealthInput` evidence graph, and doing it here risks
 * quietly moving what these 17 tests assert. Left deliberately undone and
 * recorded rather than papered over.
 *
 * What the cast can still hide: a SEVENTH field becoming load-bearing in
 * `composeFleetHealthVerdict` without appearing here. What it no longer hides
 * is everything else in this file — `FleetSummary`, `OwnerState`,
 * `RequiredAction` and `FleetConfiguredConnection` are all compiler-checked
 * now, which is where the actual drift had already accumulated.
 *
 * AND ONE HONEST CAVEAT ABOUT THE GUARD. `health-verdict-fixture-no-shape-cast.test.ts`
 * matches the PRODUCER'S OWN type name, so a double cast spelled with that
 * name is banned, while the line below — which targets the local alias
 * `ConnectionHealth` (= `FleetSummary["connection_health"]`, the same type
 * under a different name) — is outside its reach. The alias is used here
 * because it is how this file already refers to the type, not to evade the
 * ban; but a reader should know the ban is name-based and an alias sits
 * outside it. The two casts left in this file are deliberate and documented,
 * and neither is load-bearing for anything the producer reads today.
 */
function summary(id: string, overrides: Partial<FleetSummary> = {}): FleetSummary {
  const base = {
    axes: { attention: "none", coverage: "complete", freshness: "fresh", outbox: "idle", remote_surface: "none" },
    badges: { stale: false, syncing: false },
    conditions: [],
    forward_disposition: "complete",
    state: "healthy",
    unknown_reasons: [],
  } as unknown as ConnectionHealth;

  return {
    connection_health: base,
    connection_id: id,
    connector_id: id.split("-")[0] ?? id,
    connector_instance_id: id,
    display_name: id,
    owner_state: ownerState("healthy"),
    rendered_verdict: renderedVerdict("calm", []),
    schedule: { enabled: true },
    ...overrides,
  };
}

function compose(
  inventoryRows: readonly FleetConfiguredConnection[],
  summaries: readonly FleetSummary[],
  overrides: Partial<Parameters<typeof composeFleetHealthVerdict>[0]> = {}
) {
  return composeFleetHealthVerdict({
    inventory: inventoryRows,
    runtime: { ok: true },
    streamHealth: { status: "pass" },
    summaries,
    ...overrides,
  });
}

type RenderedVerdict = FleetSummary["rendered_verdict"];
type RequiredAction = RenderedVerdict["required_actions"][number];
type OwnerState = FleetSummary["owner_state"];
type ConnectionHealth = FleetSummary["connection_health"];
type ConnectionHealthCondition = ConnectionHealth["conditions"][number];

function maintainerCodeFix(): RequiredAction {
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

function ownerAction(
  kind: RequiredAction["kind"],
  satisfiedWhen: RequiredAction["satisfied_when"]["kind"],
  overrides: Partial<RequiredAction> = {}
): RequiredAction {
  return {
    affects: [],
    audience: "owner",
    cta: "Take action",
    kind,
    satisfied_when: { kind: satisfiedWhen } as RequiredAction["satisfied_when"],
    terminal: false,
    urgency: "soon",
    ...overrides,
  };
}

/**
 * The fields `composeFleetHealthVerdict` never reads, supplied once so every
 * `ownerState(...)`/`attentionAction(...)` call site can stay about the ONE
 * field it is varying. Typing these against the producer is the point of the
 * exercise: a new required field on `OwnerState` or `RequiredAction` now lands
 * as a compile error HERE, in one place, instead of being silently absent from
 * a dozen inline literals.
 */
function ownerState(resolver: OwnerState["resolver"], overrides: Partial<OwnerState> = {}): OwnerState {
  return {
    evidence_as_of: null,
    owner_of_state: "system",
    posture: "observed",
    resolver,
    ...overrides,
  };
}

/** The bare owner action these tests attach when they only care that one exists. */
function attentionAction(): RequiredAction {
  return ownerAction("reauth", "attention_resolved");
}

/**
 * A current `RuntimeAvailable: false` condition — the one condition these
 * tests assert on, via `hasCurrentCondition`. `ConnectionHealthCondition`
 * carries ten fields; only `current`/`status`/`type` are read here, so the
 * rest are filled once rather than at the call site.
 */
function runtimeUnavailableCondition(): ConnectionHealthCondition {
  return {
    current: true,
    status: "false",
    type: "RuntimeAvailable",
  } as unknown as ConnectionHealthCondition;
}

/**
 * `RenderedVerdict` carries nine required fields; `composeFleetHealthVerdict`
 * reads only `channel` and `required_actions`. The other seven are supplied
 * here once, so a call site can keep saying just "attention channel, one owner
 * action" while the whole object still satisfies the producer's type.
 */
function renderedVerdict(
  channel: RenderedVerdict["channel"],
  requiredActions: readonly RequiredAction[] = []
): RenderedVerdict {
  return {
    annotations: [],
    channel,
    detail: {
      acknowledged_loss: null,
      collection_rate: null,
      conditions: [],
      coverage_horizons: [],
      detail_gap_backlog: null,
      dominant_condition_id: null,
      forward_disposition: "complete",
      next_attempt_at: null,
      reason_code: null,
      state: "healthy",
      suppressed: [],
    },
    forward_statement: "",
    pill: { label: "Healthy", tone: "green" },
    progress: {
      gaps_drained_last_run: null,
      headline: "",
      last_refreshed_at: null,
      mode: "scheduled",
      records_committed_last_run: null,
      retained_records: null,
    },
    required_actions: requiredActions,
    streams: [],
    trace: {
      channel_cause: "",
      detail_destinations: [],
      primary_action_kind: null,
      runtime_capped: false,
      satisfied_when: null,
      suppressed_evidence: [],
      tone_cause: "green",
      tone_inputs: [],
    },
  };
}

test("ChatGPT owner action, USAA recovery gap, Chase code fix, and Slack policy stay distinct from coverage pass", () => {
  const chatgptA = summary("chatgpt-a", {
    rendered_verdict: renderedVerdict("attention", [attentionAction()]),
  });
  const chatgptB = summary("chatgpt-b", {
    rendered_verdict: renderedVerdict("attention", [attentionAction()]),
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
    owner_state: ownerState("blocked_maintainer"),
    rendered_verdict: renderedVerdict("advisory", [maintainerCodeFix()]),
  });
  const slack = summary("slack-a", {
    owner_state: ownerState("owner_paused"),
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
    rendered_verdict: renderedVerdict("attention", [attentionAction()]),
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
      conditions: [runtimeUnavailableCondition()],
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
    connection_health: { ...summary("x").connection_health, badges: { stale: false, syncing: true } },
    owner_state: ownerState("collecting"),
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
    owner_state: ownerState("owner_paused"),
    rendered_verdict: renderedVerdict("advisory", [
      ownerAction("reattach_schedule", "schedule_attached_and_enabled", {
        cta: "Resume schedule",
        surface: { kind: "schedule" },
      }),
    ]),
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
    owner_state: ownerState("owner_paused"),
    rendered_verdict: renderedVerdict("advisory", [
      ownerAction("reattach_schedule", "schedule_attached_and_enabled", {
        cta: "Resume schedule",
        surface: { kind: "schedule" },
      }),
    ]),
    schedule: { enabled: false },
  });
  const staleManual = summary("manual-stale-a", {
    connection_health: {
      ...summary("x").connection_health,
      axes: { attention: "none", coverage: "complete", freshness: "stale", outbox: "idle", remote_surface: "none" },
      forward_disposition: "owner_refresh_due",
      state: "idle",
    },
    rendered_verdict: renderedVerdict("advisory", [
      ownerAction("refresh_now", "confirming_run_succeeded", {
        cta: "Refresh now",
        surface: { kind: "runtime_retry" },
      }),
    ]),
    schedule: null,
  });
  const stalePaused = summary("paused-stale-a", {
    connection_health: {
      ...summary("x").connection_health,
      axes: { attention: "none", coverage: "complete", freshness: "stale", outbox: "idle", remote_surface: "none" },
      forward_disposition: "owner_refresh_due",
      state: "idle",
    },
    owner_state: ownerState("owner_paused"),
    rendered_verdict: renderedVerdict("advisory", [
      ownerAction("reattach_schedule", "schedule_attached_and_enabled", {
        cta: "Resume schedule",
        surface: { kind: "schedule" },
      }),
    ]),
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
    rendered_verdict: renderedVerdict("attention", [
      ownerAction("reauth", "credential_present_and_unrejected", {
        cta: "Reconnect this account",
        surface: { kind: "stored_credential" },
        urgency: "now",
      }),
    ]),
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
    rendered_verdict: renderedVerdict("advisory", [maintainerCodeFix()]),
  });
  const blockedMaintainer = summary("blocked-maintainer-a", {
    owner_state: ownerState("blocked_maintainer"),
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
    const item = summary(`headline-${state}`, {
      connection_health: { ...summary("x").connection_health, state } as ConnectionHealth,
    });
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
    const item = summary(`resolver-${resolver}`, { owner_state: { resolver } as OwnerState });
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
  const owner = summary("owner-unmeasured", { owner_state: ownerState("not_measured") });
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

// ─── `banner_warranted`: the plan's actionability-only gate ───────────────
//
// `state` stays a rich diagnostic signal (`indeterminate`/
// `healthy_with_advisories` remain real, useful classifications), but the
// owner-facing GLOBAL BANNER must fire only for a proven `needs_owner` or a
// materially `blocked` connection — never for ordinary lateness, background
// retry, in-progress work, or unassessed/unknown scope. These are the plan's
// "Required negative tests."

test("banner_warranted: an ordinary late (stale-advisory) source cannot fire the global banner", () => {
  const stale = summary("slack-a", {
    connection_health: {
      ...summary("x").connection_health,
      axes: { attention: "none", coverage: "complete", freshness: "stale", outbox: "idle", remote_surface: "none" },
      forward_disposition: "owner_refresh_due",
      state: "idle",
    },
    schedule: { enabled: false },
  });
  const result = compose([inventory("slack-a")], [stale]);
  assert.equal(result.state, "healthy_with_advisories");
  assert.equal(result.banner_warranted, false);
});

test("banner_warranted: a schedulable (automatic) connector past its cadence-relative staleness window cannot fire the global banner", () => {
  // `classifyManualStaleAdvisory`/`classifyAssistedStaleAdvisory`
  // (`connection-health.ts`) only soften stale freshness to `idle` for
  // manual/assisted-refresh connectors. A plain `background_safe`/
  // `automatic` connector past its (already cadence-relative, manifest-
  // declared `maximum_staleness_seconds`) staleness window reaches
  // `state: "degraded"` instead — that headline state is honest (the system
  // was supposed to refresh it and did not), but it is still ORDINARY
  // lateness, not a material block: `rendered-verdict.ts`'s own pill already
  // reads this exact evidence shape as "Needs refresh"
  // (`staleFreshnessIsSoleDegradation`), never "Missing data". The fleet
  // banner must not disagree with the per-connection verdict it summarizes.
  const lateAutomatic = summary("jellyfin-a", {
    connection_health: {
      ...summary("x").connection_health,
      axes: { attention: "none", coverage: "complete", freshness: "stale", outbox: "idle", remote_surface: "none" },
      conditions: [{ current: true, status: "false", type: "Fresh" } as unknown as ConnectionHealthCondition],
      forward_disposition: "complete",
      // Lateness is now an explicit FACT, not inferred from an amber tone. A
      // fixture that omits it is a source PDPP cannot judge for lateness, and
      // correctly gets no softening.
      lateness: { state: "late" },
      state: "degraded",
    },
  });
  const result = compose([inventory("jellyfin-a")], [lateAutomatic]);
  // Cadence-only lateness is now excluded from `degradedOrBroken` itself, not
  // only from `materiallyBlocked`. Excluding it downstream alone left the
  // Sources grouping quiet while the fleet STATE and dimensions still called
  // the same row unhealthy — two surfaces disagreeing about one source. A
  // merely-late row belongs in `freshness_advisories`.
  assert.equal(result.state, "healthy_with_advisories", "a merely-late source is an advisory, not a fault");
  assert.deepEqual(
    result.dimensions.system.degraded_or_broken.map((item) => item.connection_id),
    [],
    "cadence-only lateness is not degradation"
  );
  assert.ok(
    result.dimensions.freshness_advisories.some((ref) => ref.connection_id === "jellyfin-a"),
    "it is still DISCLOSED — quieting the fault classification must not hide the fact"
  );
  assert.equal(
    result.banner_warranted,
    false,
    "ordinary cadence-relative lateness on an automatic connector must not fire the banner"
  );
});

test("banner_warranted: a successful current collection cannot be overridden by an older, unrelated false condition", () => {
  // A connection that just collected successfully (`state: healthy`, fresh)
  // must never have the global banner overridden by a STALE non-current
  // condition left over from a prior run — `staleFreshnessIsSoleDegradation`
  // and every `materiallyBlocked` check here read ONLY `condition.current`
  // evidence, exactly like the rest of the health model. A `Fresh: false`
  // row that is not `current` is history, not a live fact.
  const recoveredThenSucceeded = summary("notion-a", {
    connection_health: {
      ...summary("x").connection_health,
      axes: { attention: "none", coverage: "complete", freshness: "fresh", outbox: "idle", remote_surface: "none" },
      conditions: [{ current: false, status: "false", type: "Fresh" } as unknown as ConnectionHealthCondition],
      forward_disposition: "complete",
      state: "healthy",
    },
  });
  const result = compose([inventory("notion-a")], [recoveredThenSucceeded]);
  assert.equal(result.state, "healthy");
  assert.equal(
    result.banner_warranted,
    false,
    "a proven current success is never overridden by stale proof-age evidence"
  );
});

test("banner_warranted: a retryable (background-retry) coverage gap cannot fire the global banner", () => {
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
  const result = compose([inventory("retry-a")], [retryable]);
  assert.equal(result.state, "unhealthy", "state remains a rich diagnostic signal");
  assert.equal(result.banner_warranted, false, "background retry is not owner-actionable now");
});

test("banner_warranted: in-progress work and unassessed/unknown scope (indeterminate) cannot fire the global banner", () => {
  const activeWork = summary("active-a", {
    connection_health: { ...summary("x").connection_health, badges: { stale: false, syncing: true } },
  });
  const activeResult = compose([inventory("active-a")], [activeWork]);
  assert.equal(activeResult.state, "indeterminate");
  assert.equal(activeResult.banner_warranted, false);

  const unassessedResult = compose([inventory("configured-only")], []);
  assert.equal(unassessedResult.state, "indeterminate");
  assert.equal(unassessedResult.banner_warranted, false);
});

test("banner_warranted: an actual credential/attention failure still fires needs_owner and the banner", () => {
  const chatgpt = summary("chatgpt-a", {
    rendered_verdict: renderedVerdict("attention", [attentionAction()]),
  });
  const result = compose([inventory("chatgpt-a")], [chatgpt]);
  assert.equal(result.state, "unhealthy");
  assert.deepEqual(
    result.dimensions.attention.needs_owner.map((item) => item.connection_id),
    ["chatgpt-a"]
  );
  assert.equal(result.banner_warranted, true, "a proven owner action must still fire the banner");
});

test("banner_warranted: a non-retryable terminal coverage gap still fires the banner as materially blocked", () => {
  const usaa = summary("usaa-a", {
    connection_health: {
      ...summary("x").connection_health,
      axes: { attention: "none", coverage: "terminal_gap", freshness: "fresh", outbox: "idle", remote_surface: "none" },
      forward_disposition: "terminal",
      state: "degraded",
    },
  });
  const result = compose([inventory("usaa-a")], [usaa]);
  assert.equal(result.state, "unhealthy");
  assert.equal(
    result.banner_warranted,
    true,
    "a materially blocked (terminal, non-retryable) gap must fire the banner"
  );
});

test("banner_warranted: a real runtime outage or stream-health failure still fires the banner", () => {
  const one = summary("one-a");
  assert.equal(compose([inventory("one-a")], [one], { runtime: { ok: false } }).banner_warranted, true);
  assert.equal(compose([inventory("one-a")], [one], { streamHealth: { status: "fail" } }).banner_warranted, true);
});

test("banner_warranted: a maintainer code-fix (blocked_maintainer) still fires the banner", () => {
  const chase = summary("chase-a", {
    owner_state: ownerState("blocked_maintainer"),
    rendered_verdict: renderedVerdict("advisory", [maintainerCodeFix()]),
  });
  const result = compose([inventory("chase-a")], [chase]);
  assert.equal(result.state, "unhealthy");
  assert.equal(result.banner_warranted, true);
});

// ─── DISCRIMINATING CONTROL ───────────────────────────────────────────────────
//
// The banner's whole value is that it DISCRIMINATES. A predicate that fires on
// everything and one that fires on nothing are equally useless, and both pass a
// suite that only ever checks one direction.
//
// These four cases hold the fleet shape constant and vary ONLY the cause, so
// the assertions are about the predicate's discrimination rather than about
// fixture plumbing. Two must stay silent, two must fire.

test("DISCRIMINATION: ordinary lateness and a provider limit stay silent; a credential failure and a runtime block fire", () => {
  // (1) SILENT — ordinary cadence-relative lateness. The source is simply due;
  // nothing is broken and no owner action exists.
  const merelyLate = summary("late-a", {
    connection_health: {
      ...summary("x").connection_health,
      axes: { attention: "none", coverage: "complete", freshness: "stale", outbox: "idle", remote_surface: "none" },
      forward_disposition: "owner_refresh_due",
      state: "idle",
    },
    schedule: { enabled: false },
  });

  // (2) SILENT — a provider retention boundary. Permanently unavailable history
  // is SCOPE, not health: the current connection is working perfectly.
  const providerLimited = summary("horizon-a", {
    connection_health: {
      ...summary("x").connection_health,
      axes: { attention: "none", coverage: "complete", freshness: "fresh", outbox: "idle", remote_surface: "none" },
      forward_disposition: "complete",
      state: "healthy",
    },
  });

  // (3) FIRES — a real credential failure. Owner-actionable, names a concrete
  // action, and is exactly Plaid's ITEM_LOGIN_REQUIRED case.
  const credentialFailure = summary("creds-a", {
    connection_health: {
      ...summary("x").connection_health,
      axes: { attention: "open", coverage: "complete", freshness: "stale", outbox: "idle", remote_surface: "none" },
      forward_disposition: "awaiting_owner",
      state: "needs_attention",
    },
  });

  // (4) FIRES — a real runtime/connector block. Not owner-actionable, but
  // materially broken: the system cannot collect and will not fix itself, so
  // it needs a maintainer. Expressed the way the system really expresses it —
  // an owner_state resolver plus a terminal maintainer action — not raw axes.
  const runtimeBlocked = summary("runtime-a", {
    owner_state: ownerState("blocked_maintainer"),
    rendered_verdict: renderedVerdict("advisory", [maintainerCodeFix()]),
  });

  // A SCHEDULED source past its window: the shape that actually exercises the
  // `staleFreshnessIsSoleDegradation` exclusion. The paused variant above
  // takes a different path, so without this case a mutant that re-admits
  // ordinary lateness to the materially-blocked gate survives here.
  const scheduledLate = summary("sched-late-a", {
    connection_health: {
      ...summary("x").connection_health,
      axes: { attention: "none", coverage: "complete", freshness: "stale", outbox: "idle", remote_surface: "none" },
      // The explicit lateness FACT: the shared predicate keys on evidence, not
      // on tone, so a fixture that omits it is a source PDPP cannot judge.
      lateness: { state: "late" },
      // The Fresh:false CONDITION, not just the stale axis:
      // `staleFreshnessIsSoleDegradation` reads current conditions to decide
      // whether staleness ALONE explains the degradation. Without it the
      // degraded headline is unattributed and correctly escalates — which is
      // the mechanism working, not a bug.
      conditions: [{ current: true, status: "false", type: "Fresh" } as unknown as ConnectionHealthCondition],
      // `complete`, NOT `owner_refresh_due`: this source is merely late, with
      // no pending owner action. `owner_refresh_due` means the system is
      // waiting on the owner, which is a legitimately different — and
      // banner-worthy — state, so using it here would have tested the wrong
      // thing while looking like a lateness case.
      forward_disposition: "complete",
      state: "degraded",
    },
    schedule: { enabled: true },
  });

  const silentCases: Array<[string, ReturnType<typeof summary>]> = [
    ["ordinary lateness (paused)", merelyLate],
    ["ordinary lateness (scheduled, past its window)", scheduledLate],
    ["provider retention limit", providerLimited],
  ];
  for (const [label, row] of silentCases) {
    const result = compose([inventory(row.connection_id)], [row]);
    assert.equal(
      result.banner_warranted,
      false,
      `${label} must NOT fire the global banner — the row still discloses it, the banner does not`
    );
  }

  const firingCases: Array<[string, ReturnType<typeof summary>]> = [
    ["credential failure", credentialFailure],
    ["runtime block", runtimeBlocked],
  ];
  for (const [label, row] of firingCases) {
    const result = compose([inventory(row.connection_id)], [row]);
    assert.equal(
      result.banner_warranted,
      true,
      `${label} MUST fire — suppressing a genuinely broken source is the failure that matters most`
    );
  }
});

test("DISCRIMINATION: a real failure beside quiet rows still fires — it is not diluted by healthy neighbours", () => {
  // The roll-up must be existential, not proportional. One broken source in a
  // large healthy fleet is still one broken source.
  const quiet = [
    summary("ok-a"),
    summary("ok-b"),
    summary("late-b", {
      connection_health: {
        ...summary("x").connection_health,
        axes: { attention: "none", coverage: "complete", freshness: "stale", outbox: "idle", remote_surface: "none" },
        forward_disposition: "owner_refresh_due",
        state: "idle",
      },
      schedule: { enabled: false },
    }),
  ];
  const broken = summary("creds-b", {
    connection_health: {
      ...summary("x").connection_health,
      axes: { attention: "open", coverage: "complete", freshness: "stale", outbox: "idle", remote_surface: "none" },
      forward_disposition: "awaiting_owner",
      state: "needs_attention",
    },
  });

  const withoutBroken = compose(quiet.map((s) => inventory(s.connection_id)), quiet);
  assert.equal(withoutBroken.banner_warranted, false, "three quiet rows, including a late one, stay quiet");

  const all = [...quiet, broken];
  const withBroken = compose(all.map((s) => inventory(s.connection_id)), all);
  assert.equal(withBroken.banner_warranted, true, "adding ONE genuinely blocked source must flip the banner");
});

test("a paused connection is an intentional archive, not part of the active-health denominator", () => {
  // BANNER-ZERO-PLAN: "archived and revoked setup history remains visible
  // where useful but never enters the active-health denominator", and "the
  // three archived rows remain visible and neutral". A paused connection is
  // not scheduled, so it cannot collect, so its evidence can only go stale —
  // grading it against the active fleet reports a degradation no owner action
  // can clear.
  const archived = summary("chatgpt-a", {
    connection_health: {
      ...summary("x").connection_health,
      axes: { attention: "none", coverage: "unknown", freshness: "stale", outbox: "idle", remote_surface: "none" },
      state: "degraded",
    },
  });
  const result = compose([inventory("chatgpt-a", { status: "paused" })], [archived]);

  assert.deepEqual(
    result.scope.intentional_exclusions.map((item) => item.connection_id),
    ["chatgpt-a"],
    "a paused archive stays VISIBLE, as an intentional exclusion"
  );
  assert.deepEqual(
    result.scope.assessed.map((item) => item.connection_id),
    [],
    "and is NOT assessed — it must not enter the active denominator"
  );
  assert.equal(
    result.banner_warranted,
    false,
    "a degraded PAUSED archive alone must not warrant the system banner; nothing an owner does could clear it"
  );
});

test("an active connection is still assessed — the paused exclusion must not swallow the fleet", () => {
  // Negative control for the test above: if `inventoryScope` were changed to
  // exclude everything, the assertion above would still pass. This pins that
  // only `paused` moved.
  const result = compose([inventory("slack-a")], [summary("slack-a")]);
  assert.deepEqual(
    result.scope.assessed.map((item) => item.connection_id),
    ["slack-a"],
    "an ACTIVE connection must remain in the assessed denominator"
  );
  assert.deepEqual(result.scope.intentional_exclusions, []);
});

test("an audit fail caused ONLY by owner-action rows does not fire the system banner", () => {
  // The audit is RIGHT to fail: an active connection whose owner owes an OTP
  // genuinely is not collecting. Softening the audit would be weakening audit
  // truth. What is wrong is routing that into the SYSTEM banner — the row
  // already surfaces through attention.needs_owner, and no engineering work
  // can clear it, so it makes the banner permanently unclearable.
  const result = compose([inventory("usaa-a")], [summary("usaa-a")], {
    streamHealth: {
      classCounts: { owner_interaction: 3, provider_config_blocked: 2 } as never,
      status: "fail",
    },
  });
  assert.equal(result.dimensions.coverage_audit, "fail", "the audit verdict itself is preserved verbatim");
  assert.equal(result.banner_warranted, false, "owner-owed rows alone must not fire the SYSTEM banner");
});

test("an audit fail with ANY system-caused class still fires the banner", () => {
  // The discriminating case: a mixed result must NOT be excused. This is what
  // separates "route owner rows correctly" from "ignore audit failures".
  const mixed = compose([inventory("usaa-a")], [summary("usaa-a")], {
    streamHealth: { classCounts: { failed: 1, owner_interaction: 3 } as never, status: "fail" },
  });
  assert.equal(mixed.banner_warranted, true, "one genuinely failed stream alongside owner rows still fires");

  const systemOnly = compose([inventory("usaa-a")], [summary("usaa-a")], {
    streamHealth: { classCounts: { stale: 1 } as never, status: "fail" },
  });
  assert.equal(systemOnly.banner_warranted, true, "a stale stream is a system signal");

  const noBreakdown = compose([inventory("usaa-a")], [summary("usaa-a")], {
    streamHealth: { status: "fail" },
  });
  assert.equal(noBreakdown.banner_warranted, true, "with no class breakdown, fail CLOSED and keep the banner");
});

test("benign classes in classCounts cannot be mistaken for system failures", () => {
  // `classCounts` also carries `green`, `optional_unsupported`, `revoked`.
  // A predicate testing "any non-owner class with a non-zero count" would see
  // `green` on any healthy fleet and fire every time, making the fix a no-op.
  const result = compose([inventory("usaa-a")], [summary("usaa-a")], {
    streamHealth: {
      classCounts: { green: 40, optional_unsupported: 5, owner_interaction: 1, revoked: 2 } as never,
      status: "fail",
    },
  });
  assert.equal(
    result.banner_warranted,
    false,
    "green/optional_unsupported/revoked are not fail-producing classes and must not fire the banner"
  );
});

test("an audit fail the breakdown does not EXPLAIN must fire the banner, not go quiet", () => {
  // Found by probing my own predicate before review. The first version asked
  // only "is there a non-owner fail-producing class?", so a `fail` naming NO
  // fail-producing class at all answered `false` and SUPPRESSED the banner.
  // That is strictly worse than the over-firing this change exists to fix: it
  // hides a defect the composer cannot see, instead of nagging about an
  // owner-owed one. Suppression now requires the breakdown to positively
  // explain the fail as owner-owed.
  const unexplained: ReadonlyArray<readonly [string, Record<string, number>]> = [
    ["empty classCounts", {}],
    ["all-zero counts", { failed: 0, owner_interaction: 0 }],
    ["only benign classes", { green: 9, optional_unsupported: 3, revoked: 2 }],
  ];
  for (const [label, classCounts] of unexplained) {
    const result = compose([inventory("usaa-a")], [summary("usaa-a")], {
      streamHealth: { classCounts: classCounts as never, status: "fail" },
    });
    assert.equal(
      result.banner_warranted,
      true,
      `${label}: a fail with no fail-producing class named is UNEXPLAINED and must fail closed`
    );
  }

  // Control: a breakdown that DOES explain the fail as owner-owed still suppresses.
  const explained = compose([inventory("usaa-a")], [summary("usaa-a")], {
    streamHealth: { classCounts: { owner_interaction: 3 } as never, status: "fail" },
  });
  assert.equal(explained.banner_warranted, false, "an explained owner-only fail must still suppress the banner");
});

test("intentional_policy.paused reports BOTH paused lifecycles, deduped", () => {
  // Independent review P2: scoping `paused` to `excluded` made this dimension
  // structurally dead for the exact rows it is named after. A paused row never
  // reaches `collectSummaryEvidence`, so the `owner_paused` RESOLVER — its only
  // previous producer — can no longer see it. The dimension is published in the
  // reference contract, so an empty list is a broken API contract, not dead
  // internal state.
  const lifecyclePaused = summary("archived-a");
  const resolverPaused = summary("sched-off-a", {
    owner_state: { ...summary("x").owner_state, resolver: "owner_paused" },
  });
  const result = compose(
    [inventory("archived-a", { status: "paused" }), inventory("sched-off-a")],
    [lifecyclePaused, resolverPaused]
  );

  assert.deepEqual(
    [...result.dimensions.intentional_policy.paused.map((item) => item.connection_id)].sort(),
    ["archived-a", "sched-off-a"],
    "a paused LIFECYCLE and an owner_paused RESOLVER are different facts; both belong in this dimension"
  );
  assert.deepEqual(
    result.scope.intentional_exclusions.map((item) => item.connection_id),
    ["archived-a"],
    "only the paused lifecycle leaves the denominator; a schedule-disabled ACTIVE row stays assessed"
  );
  assert.deepEqual(result.scope.assessed.map((item) => item.connection_id), ["sched-off-a"]);
});
