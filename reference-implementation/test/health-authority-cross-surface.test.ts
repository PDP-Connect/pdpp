// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
  type ComputeConnectionHealthInput,
  type ConnectionHealthSnapshot,
  computeConnectionHealth,
} from "../runtime/connection-health.ts";
import { deriveOwnerState, type OwnerState, sourceWorkGroupFromOwnerState } from "../runtime/owner-state.ts";
import { type RenderedVerdict, type StreamRollup, synthesizeRenderedVerdict } from "../runtime/rendered-verdict.ts";
import { composeFleetHealthVerdict, type FleetSummary } from "../server/fleet-health.ts";

const OBSERVED_AT = "2026-08-12T12:00:00.000Z";
const SUCCESS_AT = "2026-08-12T11:55:00.000Z";
const RETRY_AT = "2026-08-12T12:30:00.000Z";

const AUTOMATIC_REFRESH = {
  backgroundSafe: true,
  interactionPosture: "none" as const,
  recommendedMode: "automatic" as const,
};

const ACTIVE_SCHEDULE = { hasPriorSuccess: true, mode: "scheduled-active" as const };

function input(overrides: Partial<ComputeConnectionHealthInput> = {}): ComputeConnectionHealthInput {
  return {
    activity: { active: false },
    attention: null,
    backoff: {
      backoffApplied: true,
      consecutiveFailures: 1,
      nextRunAt: RETRY_AT,
      reasonClass: "failure:network_timeout",
    },
    coverage: { axis: "complete" },
    freshness: { axis: "fresh" },
    outbox: { axis: "idle" },
    projection: { unreliableSources: [] },
    refresh: AUTOMATIC_REFRESH,
    run: {
      hasDegradingGaps: false,
      lastSuccessAt: SUCCESS_AT,
      latestStatus: "succeeded",
      reasonCode: null,
    },
    schedule: { enabled: true },
    ...overrides,
  };
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

function project(connectionInput: ComputeConnectionHealthInput, streams: readonly StreamRollup[] = []) {
  const snapshot = computeConnectionHealth(connectionInput);
  const verdict = synthesizeRenderedVerdict(
    snapshot,
    streams,
    AUTOMATIC_REFRESH,
    true,
    {
      last_refreshed_at: SUCCESS_AT,
      mode: "scheduled",
      observed_at: OBSERVED_AT,
      records_committed_last_run: 1,
      retained_records: 1,
    },
    ACTIVE_SCHEDULE,
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
  assert.equal(failed.verdict.pill.label, "Degraded");
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

  const passive = project(input());
  assert.equal(passive.snapshot.state, "cooling_off");
  assert.equal(passive.verdict.pill.tone, "amber");
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
  assert.equal(stale.verdict.pill.label, "Degraded");
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
