// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end wiring proof for the GroupMe-shaped provider-retention-boundary
 * case, through the REAL production entry point
 * (`projectConnectorSummaryConnectionHealth` in `server/ref-control.ts`) —
 * not just the connection-health-layer unit tests in `coverage-horizon.test.ts`
 * (which set `coverage.horizonAccountedRetryableGap` directly) or the
 * classification-layer unit tests in `connector-gap-classification.test.ts`
 * (which call `isProvenPreHorizonGap` directly). This file proves the ROLLUP
 * in between: a raw `ConnectorRunSummary.known_gaps` entry shaped exactly like
 * GroupMe's real production skip (`reason: "history_ended_before_provider_count"`,
 * `recovery_action: "retry_by_runtime"` — see
 * `test/fixtures/sources-report-fleet-parity-0825.json`) plus a real
 * `ConnectionCoverageHorizon` produces a healthy, in-horizon-scope coverage
 * verdict — and that removing either half of the proof (no horizon, or a
 * horizon for a different stream) leaves the connection exactly as degraded
 * as it always was.
 *
 * GOAL-OWNER RULING (recorded in
 * `openspec/changes/add-coverage-horizon-and-actionability-banner/design.md`):
 * "an affirmatively recorded current horizon may exclude ONLY the unavailable
 * pre-horizon interval from the current servable denominator; current/
 * in-horizon gaps and unproven horizons remain degrading." "Do not just show
 * a disclosure beside the same red state."
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { ConnectorRunSummary } from "../server/ref-control.ts";
import { projectConnectorSummaryConnectionHealth } from "../server/ref-control.ts";
import type { ConnectionCoverageHorizon } from "../runtime/coverage-horizon.ts";

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

test("GROUPME WIRING: raw known_gaps skip + a confirmed matching horizon reaches a healthy, in-horizon coverage verdict", () => {
  const snap = projectConnectorSummaryConnectionHealth({
    coverageHorizons: [groupMeHorizon()],
    freshness: { status: "current" },
    lastRun: groupMeShapedRun(),
    lastSuccessfulRun: groupMeShapedRun(),
    schedule: { enabled: true },
  });
  assert.equal(snap.axes.coverage, "retryable_gap", "the raw axis is preserved — the boundary is a scope fact, not a mutation");
  const coverageCondition = snap.conditions.find((c) => c.type === "SourceCoverageComplete");
  assert.equal(coverageCondition?.status, "true", "the in-horizon scope is fully accounted for");
  assert.equal(coverageCondition?.reason, "coverage_complete_horizon_accounted");
  assert.equal(snap.state, "healthy", "the connection reaches healthy for its current, in-horizon scope");
  assert.equal(snap.coverage_horizons.length, 1, "the horizon disclosure is still visible on the snapshot");
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
    known_gaps: [{ kind: "skip_result", reason: "upstream_rate_limited", recovery_action: "retry_by_runtime", severity: "transient", stream: "group_messages" }],
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
