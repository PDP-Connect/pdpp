// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Cadence hysteresis through the PRODUCTION read path.
 *
 * `cadence-lateness.test.ts` proves the pure function. That is not an outcome:
 * a module with no production import changes no summary, no rendered verdict,
 * no Sources grouping, no fleet verdict, and no banner. These tests drive
 * `projectConnectorSummaryConnectionHealth` — the same call the live
 * `/_ref/connectors` projection makes — so they fail if the wiring is removed
 * even while the unit tests stay green.
 *
 * The frozen acceptance shape:
 *   1. crossing ONE expected interval is neutral        (not degrading)
 *   2. MATURE overdue is degrading but still NOT a banner without an
 *      independent block
 *   3. an independently proven block still fires
 *
 * (3) is asserted at the fleet level in `fleet-health.test.ts`'s discrimination
 * control; this file owns (1) and (2) and the per-connection severity that
 * feeds it.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { ConnectorRunSummary } from "../server/ref-control.ts";
import { projectConnectorSummaryConnectionHealth } from "../server/ref-control.ts";

const NOW = "2026-08-27T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const HOUR_MS = 60 * 60 * 1000;
const SIX_HOURS_S = 6 * 60 * 60;

function successAt(hoursAgo: number): ConnectorRunSummary {
  const iso = new Date(NOW_MS - hoursAgo * HOUR_MS).toISOString();
  return {
    collection_facts: null,
    event_count: 1,
    failure_reason: null,
    finished_at: iso,
    first_at: iso,
    known_gaps: [],
    last_at: iso,
    recovery_only: false,
    run_id: `run_${hoursAgo}h`,
    started_at: iso,
    status: "succeeded",
    terminal_reason: null,
  } as ConnectorRunSummary;
}

/**
 * The live projection, with a stale freshness verdict and a real cadence.
 *
 * `nowIso` is the clock field the projection reads (`input.nowIso ??
 * new Date()`). It must stay pinned: `as never` hides a wrong name, and an
 * unpinned clock ages these frozen fixtures until they fail. See CLOCK ORACLE.
 */
function project(hoursSinceSuccess: number, intervalSeconds: number | null) {
  const run = successAt(hoursSinceSuccess);
  return projectConnectorSummaryConnectionHealth({
    freshness: { status: "stale" },
    lastRun: run,
    lastSuccessfulRun: run,
    nowIso: NOW,
    schedule: { enabled: true, interval_seconds: intervalSeconds },
  } as never);
}

function freshCondition(snap: ReturnType<typeof project>) {
  return snap.conditions.find((c) => c.type === "Fresh");
}

/**
 * CLOCK ORACLE — fails iff the projection is reading a wall clock.
 *
 * A run dated AFTER the frozen NOW is `on_time` pinned and `late` unpinned.
 * Asserts `lateness.state`, not severity: `late` and `on_time` share severity
 * `info`, so a severity assertion here passes under the bug and proves nothing.
 */
test("CLOCK ORACLE: the projection honours the frozen clock, so these fixtures cannot decay", () => {
  const snap = project(-1 / 60, SIX_HOURS_S);
  assert.equal(
    (snap as unknown as { lateness?: { state?: string } }).lateness?.state,
    "on_time",
    "a run dated after NOW cannot be late — the projection is on a wall clock; check `project()` still passes `nowIso`"
  );
});

test("PRODUCT PATH: crossing one expected interval is NEUTRAL, not degrading", () => {
  // 7h on a 6h cadence — one missed beat. Late is an honest fact, not an alarm.
  const snap = project(7, SIX_HOURS_S);
  const fresh = freshCondition(snap);
  assert.equal(fresh?.status, "false", "the staleness fact is still reported, never hidden");
  assert.equal(
    fresh?.severity,
    "info",
    "ordinary lateness must sit BELOW the degrading threshold — this is the assertion the dead module could not make"
  );
});

test("PRODUCT PATH: MATURE overdue is degrading, but still only a precondition", () => {
  // 25h on a 6h cadence — past 3x, mature evidence.
  const snap = project(25, SIX_HOURS_S);
  const fresh = freshCondition(snap);
  assert.equal(fresh?.status, "false");
  assert.equal(fresh?.severity, "warning", "mature lateness earns the degrading severity");
  assert.notEqual(
    snap.state,
    "healthy",
    "a genuinely overdue source is not healthy — but fleet-health still requires an independent block to banner"
  );
});

test("PRODUCT PATH: the neutral and mature cases differ ONLY by elapsed time", () => {
  // Same connection, same cadence, same stale freshness. The single variable is
  // how long it has been — which is the whole claim of cadence hysteresis.
  const neutral = freshCondition(project(7, SIX_HOURS_S));
  const mature = freshCondition(project(25, SIX_HOURS_S));
  assert.equal(neutral?.status, mature?.status, "both are honestly stale");
  assert.notEqual(neutral?.severity, mature?.severity, "but only one is degrading");
});

test("PRODUCT PATH: thresholds are per-source, so the same age differs by cadence", () => {
  // 20h is on-time for a daily source and long overdue for an hourly one.
  const daily = freshCondition(project(20, 24 * 60 * 60));
  const hourly = freshCondition(project(20, 60 * 60));
  assert.equal(daily?.severity, "info", "20h is within a daily source's own rhythm");
  assert.equal(hourly?.severity, "warning", "20h is 20 missed beats for an hourly source");
});

test("PRODUCT PATH: a source with NO declared cadence keeps its prior behaviour", () => {
  // Absence of a cadence is not evidence of lateness, and this change must not
  // silently soften a source it cannot judge.
  const snap = project(500, null);
  assert.equal(
    freshCondition(snap)?.severity,
    "warning",
    "no interval means no lateness claim, so the pre-existing degrading warning stands"
  );
});
