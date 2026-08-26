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
      collection_rate: null,
      conditions: [],
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
