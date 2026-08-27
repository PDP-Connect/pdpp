// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
  type ComputeConnectionHealthInput,
  type ConnectionHealthSnapshot,
  type ConnectionRefreshEvidence,
  computeConnectionHealth,
} from "../runtime/connection-health.ts";
import { deriveOwnerState, type OwnerState, sourceWorkGroupFromOwnerState } from "../runtime/owner-state.ts";
import {
  type RenderedVerdict,
  type ScheduleEvidence,
  type StreamRollup,
  synthesizeRenderedVerdict,
} from "../runtime/rendered-verdict.ts";
import { composeFleetHealthVerdict, type FleetSummary } from "../server/fleet-health.ts";
import {
  BASELINE_ACTIVE_SCHEDULE,
  BASELINE_AUTOMATIC_REFRESH,
  BASELINE_MANUAL_REFRESH,
  BASELINE_OBSERVED_AT,
  BASELINE_RETRY_AT,
  BASELINE_SUCCESS_AT,
  healthyConnectionInput,
} from "./fixtures/connection-health-baseline.ts";

const OBSERVED_AT = BASELINE_OBSERVED_AT;
const SUCCESS_AT = BASELINE_SUCCESS_AT;
const REFRESH_TO_UPDATE_RE = /refresh to update/i;

const AUTOMATIC_REFRESH = BASELINE_AUTOMATIC_REFRESH;
const MANUAL_REFRESH = BASELINE_MANUAL_REFRESH;
const ACTIVE_SCHEDULE = BASELINE_ACTIVE_SCHEDULE;

/** Delegates to the shared known-green baseline; semantics unchanged. */
function input(overrides: Partial<ComputeConnectionHealthInput> = {}): ComputeConnectionHealthInput {
  return healthyConnectionInput(overrides);
}

function stream(overrides: Partial<StreamRollup> = {}): StreamRollup {
  return {
    attention_open: false,
    collected: null,
    considered: null,
    coverage: "complete",
    gap_retryable: false,
    priority: "required",
    stream_id: "records",
    ...overrides,
  };
}

function project(
  connectionInput: ComputeConnectionHealthInput,
  streams: readonly StreamRollup[] = [],
  refresh: ConnectionRefreshEvidence = AUTOMATIC_REFRESH,
  scheduleEvidence: ScheduleEvidence | null = ACTIVE_SCHEDULE
) {
  const snapshot = computeConnectionHealth(connectionInput);
  const verdict = synthesizeRenderedVerdict(
    snapshot,
    streams,
    refresh,
    true,
    {
      last_refreshed_at: SUCCESS_AT,
      mode: refresh.recommendedMode === "manual" ? "manual" : "scheduled",
      observed_at: OBSERVED_AT,
      records_committed_last_run: 1,
      retained_records: 1,
    },
    scheduleEvidence,
    connectionInput.attention
  );
  const ownerState = deriveOwnerState(verdict, snapshot, {
    as_of: connectionInput.run?.latestStatus === "failed" ? OBSERVED_AT : SUCCESS_AT,
    lifecycle: { status: "active" },
    progress: { active: false },
    schedule_mode: ACTIVE_SCHEDULE.mode,
    source: connectionInput.run?.latestStatus === "failed" ? "latest_terminal_run" : "last_successful_freshness",
  });
  return { ownerState, snapshot, verdict };
}

function fleetSummary(
  id: string,
  snapshot: ConnectionHealthSnapshot,
  verdict: RenderedVerdict,
  ownerState: OwnerState
): FleetSummary {
  return {
    connection_health: snapshot,
    connection_id: id,
    connector_id: "test-connector",
    connector_instance_id: id,
    display_name: id,
    owner_state: ownerState,
    rendered_verdict: verdict,
    schedule: { enabled: true },
  };
}

function fleetFor(id: string, projected: ReturnType<typeof project>) {
  return composeFleetHealthVerdict({
    inventory: [
      {
        connectorId: "test-connector",
        connectorInstanceId: id,
        displayName: id,
        revokedAt: null,
        status: "active",
      },
    ],
    runtime: { ok: true },
    streamHealth: { status: "pass" },
    summaries: [fleetSummary(id, projected.snapshot, projected.verdict, projected.ownerState)],
  });
}

test("one health authority discriminates failure, passive cooling, owner action, terminal work, and wait", () => {
  const failed = project(
    input({
      coverage: { axis: "partial" },
      run: {
        hasDegradingGaps: true,
        lastSuccessAt: SUCCESS_AT,
        latestStatus: "failed",
        reasonCode: "network_timeout",
      },
    }),
    [stream({ coverage: "partial", gap_retryable: true })]
  );
  assert.equal(failed.snapshot.state, "degraded");
  assert.equal(failed.verdict.pill.label, "Missing data");
  assert.equal(failed.verdict.channel, "calm");
  assert.ok(failed.verdict.required_actions.some((action) => action.audience === "none" && action.kind === "wait"));
  assert.equal(failed.ownerState.resolver, "system_degraded");
  assert.equal(sourceWorkGroupFromOwnerState(failed.ownerState.resolver), "system_issue");
  const failedFleet = fleetFor("failed-backoff", failed);
  assert.equal(failedFleet.state, "unhealthy");
  assert.deepEqual(failedFleet.dimensions.attention.needs_owner, []);
  assert.deepEqual(
    failedFleet.dimensions.system.degraded_or_broken.map((ref) => ref.connection_id),
    ["failed-backoff"]
  );

  // Passive cooling is THIS case's subject, so it states the backoff facts
  // explicitly rather than inheriting them: the shared baseline is neutral
  // (no backoff) by design, because a baseline that silently carries an
  // active retry is not a healthy starting point for anyone else.
  const passive = project(
    input({
      backoff: {
        backoffApplied: true,
        consecutiveFailures: 1,
        nextRunAt: BASELINE_RETRY_AT,
        reasonClass: "failure:network_timeout",
      },
    })
  );
  assert.equal(passive.snapshot.state, "cooling_off");
  assert.equal(passive.verdict.pill.tone, "amber");
  assert.equal(passive.verdict.pill.label, "Needs refresh");
  assert.equal(passive.verdict.channel, "calm");
  assert.equal(passive.ownerState.resolver, "healthy");
  assert.equal(sourceWorkGroupFromOwnerState(passive.ownerState.resolver), "none");
  const passiveFleet = fleetFor("passive-cooling", passive);
  assert.equal(passiveFleet.state, "healthy_with_advisories");
  assert.ok(passiveFleet.dimensions.freshness_advisories.some((ref) => ref.connection_id === "passive-cooling"));
  assert.deepEqual(passiveFleet.dimensions.system.degraded_or_broken, []);

  const stale = project(
    input({
      coverage: { axis: "complete" },
      freshness: { axis: "stale" },
    })
  );
  assert.equal(stale.snapshot.state, "degraded");
  // "Needs refresh", not "Missing data": nothing is missing — coverage is
  // complete and the run succeeded; the data has simply aged. The previous
  // expectation was an artifact of the old fixture default, which layered an
  // active retry backoff onto every case and inflated the label.
  assert.equal(stale.verdict.pill.label, "Needs refresh");
  assert.equal(stale.ownerState.resolver, "system_degraded");
  assert.equal(sourceWorkGroupFromOwnerState(stale.ownerState.resolver), "system_issue");
  const staleFleet = fleetFor("stale-backoff", stale);
  assert.equal(staleFleet.state, "unhealthy");
  assert.ok(staleFleet.dimensions.freshness_advisories.some((ref) => ref.connection_id === "stale-backoff"));
  assert.ok(staleFleet.dimensions.system.degraded_or_broken.some((ref) => ref.connection_id === "stale-backoff"));

  const ownerAction = project(
    input({
      attention: {
        actionTarget: "records",
        expiresAt: null,
        id: "attention-1",
        lifecycle: "open",
        ownerAction: "provide_value",
        reasonCode: "owner_input",
        responseContract: "response_required",
        runId: null,
      },
    })
  );
  assert.equal(ownerAction.snapshot.state, "needs_attention");
  assert.equal(ownerAction.verdict.channel, "attention");
  assert.equal(ownerAction.ownerState.resolver, "needs_owner");
  assert.equal(sourceWorkGroupFromOwnerState(ownerAction.ownerState.resolver), "needs_owner");
  const ownerFleet = fleetFor("owner-action", ownerAction);
  assert.equal(ownerFleet.state, "unhealthy");
  assert.deepEqual(
    ownerFleet.dimensions.attention.needs_owner.map((ref) => ref.connection_id),
    ["owner-action"]
  );

  const terminal = project(input({ coverage: { axis: "terminal_gap" } }), [stream({ coverage: "terminal_gap" })]);
  assert.equal(terminal.snapshot.state, "degraded");
  assert.ok(
    terminal.verdict.required_actions.some((action) => action.audience === "maintainer" && action.kind === "code_fix")
  );
  assert.equal(terminal.ownerState.resolver, "blocked_maintainer");
  assert.equal(sourceWorkGroupFromOwnerState(terminal.ownerState.resolver), "system_issue");
  const terminalFleet = fleetFor("terminal-work", terminal);
  assert.equal(terminalFleet.state, "unhealthy");
  assert.deepEqual(
    terminalFleet.dimensions.system.degraded_or_broken.map((ref) => ref.connection_id),
    ["terminal-work"]
  );
});

test("fresh manual success stays green across health, rendered, owner, and fleet surfaces", () => {
  const projected = project(
    input({
      refresh: MANUAL_REFRESH,
      schedule: null,
    }),
    [stream()],
    MANUAL_REFRESH,
    null
  );

  assert.equal(projected.snapshot.state, "healthy");
  assert.equal(projected.snapshot.axes.freshness, "fresh");
  assert.equal(
    projected.snapshot.conditions.find((condition) => condition.type === "RetryPolicyClear")?.status,
    "not_applicable"
  );
  assert.equal(projected.snapshot.forward_disposition, "complete");
  assert.equal(projected.verdict.pill.tone, "green");
  assert.equal(projected.verdict.pill.label, "Healthy");
  assert.equal(projected.verdict.progress.mode, "manual");
  assert.match(projected.verdict.progress.headline, REFRESH_TO_UPDATE_RE);
  assert.equal(projected.ownerState.resolver, "healthy");
  assert.equal(sourceWorkGroupFromOwnerState(projected.ownerState.resolver), "none");

  const fleet = fleetFor("fresh-manual", projected);
  assert.equal(fleet.state, "healthy");
  assert.deepEqual(fleet.dimensions.system.degraded_or_broken, []);
  assert.deepEqual(fleet.dimensions.attention.needs_owner, []);
});

// EXPECTATION CHANGED — owner decision, 2026-08-23.
//
// This test previously asserted the pill read "Healthy"/green with an optional
// terminal stream present. That encoded the old policy, in which `required:
// false` alone was enough to keep a source green. The owner rejected it: a
// stream the connector INTENDS to collect (`coverage_policy: collect`, or no
// policy) that is now lost forever is a real loss, and a source sitting on one
// must not claim to be Healthy. Only an EXPLICIT accepted-absence policy earns
// green — see the `accepted_absence` sibling test below.
//
// What did NOT change, and is asserted here to keep the boundary honest:
// the CONNECTION-level coverage axis is still `complete` and the snapshot state
// is still `healthy`, because the connection's REQUIRED coverage genuinely is
// complete. The optional loss is carried by the verdict's per-stream rollup,
// not by promoting the connection axis. And `needs_owner` stays empty: the
// owner is informed, never interrupted, because there is no owner action that
// would bring a permanently-lost stream back.
test("optional terminal stream downgrades the pill to Missing optional data without demanding owner action", () => {
  const projected = project(
    input({ coverage: { axis: "complete" }, refresh: MANUAL_REFRESH, schedule: null }),
    [stream({ coverage: "terminal_gap", priority: "optional", stream_id: "optional_stream" })],
    MANUAL_REFRESH,
    null
  );

  assert.equal(projected.snapshot.state, "healthy");
  assert.equal(projected.snapshot.axes.coverage, "complete");
  assert.equal(projected.verdict.pill.label, "Missing optional data");
  assert.equal(projected.verdict.pill.tone, "amber");
  assert.equal(
    projected.verdict.streams.some((row) => row.stream_id === "optional_stream"),
    true
  );
  assert.equal(projected.ownerState.resolver, "system_degraded");

  const fleet = fleetFor("optional-stream", projected);
  assert.equal(fleet.state, "unhealthy");
  assert.deepEqual(
    fleet.dimensions.system.degraded_or_broken.map((entry) => entry.connection_id),
    ["optional-stream"],
    "the source is visibly degraded to a maintainer"
  );
  assert.deepEqual(
    fleet.dimensions.attention.needs_owner,
    [],
    "but the owner is never asked to fix a stream that cannot be recovered"
  );
});

// A required stream's terminal gap must dominate to red even when the
// connection-level coverage axis is otherwise `complete` and there was a
// same-day success — same-day success only softens a terminal disposition
// when the connection's OWN coverage axis independently shows the gap
// (`softensTerminalCoverageToDegraded`, rendered-verdict.ts); a per-stream
// rollup carrying an independent required-stream loss is not that.
test("required terminal stream stays Can't collect across every surface, even with a same-day success", () => {
  const projected = project(
    input({ coverage: { axis: "complete" }, refresh: MANUAL_REFRESH, schedule: null }),
    [stream({ coverage: "terminal_gap", priority: "required", stream_id: "required_stream" })],
    MANUAL_REFRESH,
    null
  );

  assert.equal(projected.snapshot.state, "healthy");
  assert.equal(projected.snapshot.axes.coverage, "complete");
  assert.equal(projected.verdict.pill.label, "Can't collect");
  assert.equal(projected.verdict.pill.tone, "red");
  assert.equal(projected.ownerState.resolver, "blocked_maintainer");

  const fleet = fleetFor("required-stream", projected);
  assert.equal(fleet.state, "unhealthy");
  assert.deepEqual(
    fleet.dimensions.system.degraded_or_broken.map((entry) => entry.connection_id),
    ["required-stream"]
  );
});

// The other half of the owner's decision: an EXPLICIT accepted-absence policy
// still earns green under exactly the same terminal gap. This is the test that
// proves the three-way distinction survived — `optional` and `accepted_absence`
// were collapsed before, and are not collapsed now.
test("accepted_absence terminal stream still reads Healthy across every surface", () => {
  const projected = project(
    input({ coverage: { axis: "complete" }, refresh: MANUAL_REFRESH, schedule: null }),
    [stream({ coverage: "terminal_gap", priority: "accepted_absence", stream_id: "accepted_stream" })],
    MANUAL_REFRESH,
    null
  );

  assert.equal(projected.verdict.pill.label, "Healthy");
  assert.equal(projected.verdict.pill.tone, "green");
  assert.equal(projected.ownerState.resolver, "healthy");

  const fleet = fleetFor("accepted-stream", projected);
  assert.equal(fleet.state, "healthy");
  assert.deepEqual(fleet.dimensions.system.degraded_or_broken, []);
  assert.deepEqual(fleet.dimensions.attention.needs_owner, []);
});
