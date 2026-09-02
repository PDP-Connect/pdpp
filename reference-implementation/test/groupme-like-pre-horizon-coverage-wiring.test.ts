// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end wiring proof for the GroupMe-shaped provider-retention-boundary
 * case, through the REAL production entry point
 * (`projectConnectorSummaryConnectionHealth` in `server/ref-control.ts`).
 *
 * This file previously proved that a raw `ConnectorRunSummary.known_gaps`
 * entry shaped like GroupMe's real production skip, plus a matching
 * `ConnectionCoverageHorizon`, produced a HEALTHY in-horizon coverage verdict.
 * That rollup is REMOVED: claim-plus-any-horizon was never proof that a given
 * gap fell outside the interval the provider can still serve, so it could turn
 * genuinely owed data green.
 *
 * The negatives below are unchanged and still pass — they were always the
 * important half. The former positive is inverted: the same run and the same
 * confirmed horizon must now leave the connection exactly as degraded as the
 * no-horizon case, with the disclosure still attached.
 *
 * Its header previously cited a "GOAL-OWNER RULING (recorded in
 * .../design.md)" permitting exclusion of the pre-horizon interval from the
 * denominator. No such text exists in that design.md at this revision; the
 * change's normative spec delta requires the opposite ("SHALL participate in
 * NO classification step"). The citation is not repeated here.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { ConnectionCoverageHorizon } from "../runtime/coverage-horizon.ts";
import type { ConnectorRunSummary } from "../server/ref-control.ts";
import { projectConnectorSummaryConnectionHealth } from "../server/ref-control.ts";

const NOW = "2026-08-27T12:00:00.000Z";
const RUN_AT = "2026-08-27T11:59:00.000Z";

/** GroupMe's real production shape (fixture-verified): a group_messages stream skipped as a retryable, retry-forever gap. */
function groupMeShapedRun(overrides: Partial<ConnectorRunSummary> = {}): ConnectorRunSummary {
  return {
    collection_facts: null,
    event_count: 1,
    failure_reason: null,
    finished_at: NOW,
    first_at: RUN_AT,
    known_gaps: [
      {
        // The connector's typed claim, exactly as groupme/index.ts now emits
        // it. The RI reads THIS, never the reason prose.
        boundary_claim: "provider_history_boundary",
        kind: "skip_result",
        reason: "history_ended_before_provider_count",
        recovery_action: "retry_by_runtime",
        severity: "transient",
        stream: "group_messages",
      },
    ],
    last_at: NOW,
    recovery_only: false,
    run_id: "run_groupme",
    started_at: RUN_AT,
    status: "succeeded",
    terminal_reason: null,
    ...overrides,
  };
}

function groupMeHorizon(overrides: Partial<ConnectionCoverageHorizon> = {}): ConnectionCoverageHorizon {
  return {
    basis: "provider_stated",
    confirmedAt: "2026-08-20T00:00:00.000Z",
    confirmedBy: "owner:test-owner",
    connectorInstanceId: "cin_groupme_test",
    earliestAvailable: "2013-01-01T00:00:00.000Z",
    horizonId: "covhz_groupme_test",
    note: "GroupMe confirmed group_messages history does not extend before 2013",
    reason: "provider_retention_policy",
    stream: "group_messages",
    supersededAt: null,
    supersededByHorizonId: null,
    ...overrides,
  };
}

test("GROUPME WIRING: raw known_gaps skip + a confirmed matching horizon does NOT reach a healthy verdict", () => {
  // The owner's stated acceptance bar: GroupMe must not be green on
  // claim + any-horizon alone.
  const snap = projectConnectorSummaryConnectionHealth({
    coverageHorizons: [groupMeHorizon()],
    freshness: { status: "current" },
    lastRun: groupMeShapedRun(),
    lastSuccessfulRun: groupMeShapedRun(),
    schedule: { enabled: true },
  });
  assert.equal(snap.axes.coverage, "retryable_gap", "the raw axis is preserved — the gap is still a gap");
  const coverageCondition = snap.conditions.find((c) => c.type === "SourceCoverageComplete");
  assert.equal(coverageCondition?.status, "false", "a horizon cannot account this gap away");
  assert.equal(coverageCondition?.reason, "retryable_gap");
  assert.notEqual(snap.state, "healthy");
  assert.equal(snap.coverage_horizons.length, 1, "the horizon disclosure is still visible on the snapshot");
});

test("GROUPME WIRING: the confirmed-horizon run is byte-identical in classification to the no-horizon run", () => {
  // Disclosure attached, classification untouched — the whole Model A claim,
  // asserted at the production entry point.
  const common = {
    freshness: { status: "current" },
    lastRun: groupMeShapedRun(),
    lastSuccessfulRun: groupMeShapedRun(),
    nowIso: NOW,
    schedule: { enabled: true },
  } as const;
  const without = projectConnectorSummaryConnectionHealth({ ...common } as never);
  const with_ = projectConnectorSummaryConnectionHealth({ ...common, coverageHorizons: [groupMeHorizon()] } as never);
  assert.equal(with_.state, without.state);
  assert.deepEqual(with_.axes, without.axes);
  assert.deepEqual(with_.conditions, without.conditions);
  assert.equal(with_.forward_disposition, without.forward_disposition);
  assert.deepEqual(without.coverage_horizons, []);
  assert.equal(with_.coverage_horizons.length, 1);
});

test("NEGATIVE: the SAME raw skip with NO horizon confirmed stays exactly as retryable/degraded as it always was", () => {
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: { status: "current" },
    lastRun: groupMeShapedRun(),
    lastSuccessfulRun: groupMeShapedRun(),
    schedule: { enabled: true },
  });
  assert.equal(snap.axes.coverage, "retryable_gap");
  const coverageCondition = snap.conditions.find((c) => c.type === "SourceCoverageComplete");
  assert.equal(coverageCondition?.status, "false", "an unconfirmed boundary is never accepted as provider reality");
  assert.notEqual(snap.state, "healthy");
});

test("NEGATIVE: a confirmed horizon for a DIFFERENT stream does not launder this connection's group_messages gap", () => {
  const snap = projectConnectorSummaryConnectionHealth({
    coverageHorizons: [groupMeHorizon({ stream: "groups" })],
    freshness: { status: "current" },
    lastRun: groupMeShapedRun(),
    lastSuccessfulRun: groupMeShapedRun(),
    schedule: { enabled: true },
  });
  const coverageCondition = snap.conditions.find((c) => c.type === "SourceCoverageComplete");
  assert.equal(coverageCondition?.status, "false");
  assert.notEqual(snap.state, "healthy");
});

test("NEGATIVE: a real, CURRENT-scope gap (no boundary-shaped reason) stays unhealthy even with an unrelated horizon on record", () => {
  const liveGapRun = groupMeShapedRun({
    known_gaps: [
      {
        kind: "skip_result",
        reason: "upstream_rate_limited",
        recovery_action: "retry_by_runtime",
        severity: "transient",
        stream: "group_messages",
      },
    ],
  });
  const snap = projectConnectorSummaryConnectionHealth({
    coverageHorizons: [groupMeHorizon()],
    freshness: { status: "current" },
    lastRun: liveGapRun,
    lastSuccessfulRun: liveGapRun,
    schedule: { enabled: true },
  });
  const coverageCondition = snap.conditions.find((c) => c.type === "SourceCoverageComplete");
  assert.equal(coverageCondition?.status, "false", "a live rate-limit gap is not a provider-retention boundary claim");
  assert.notEqual(snap.state, "healthy");
});

test("retained records are never touched by this path — the health snapshot carries no record-mutation capability", () => {
  const snap = projectConnectorSummaryConnectionHealth({
    coverageHorizons: [groupMeHorizon()],
    freshness: { status: "current" },
    lastRun: groupMeShapedRun(),
    lastSuccessfulRun: groupMeShapedRun(),
    schedule: { enabled: true },
  });
  assert.doesNotMatch(JSON.stringify(snap), /delet|remov|purge/i);
});
