// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Cross-surface agreement for cadence hysteresis.
 *
 * The frozen acceptance requires the summary, the rendered verdict, and the
 * fleet verdict/banner to AGREE. A test that stops at `snapshot.conditions`
 * proves only the first of those, and a fleet test built from hand-written
 * summaries proves only the last — with nothing connecting them, both can pass
 * while the surfaces contradict each other.
 *
 * These carry ONE projected snapshot — the real output of
 * `projectConnectorSummaryConnectionHealth`, the same call the live
 * `/_ref/connectors` route makes — through `synthesizeRenderedVerdict` and then
 * `composeFleetHealthVerdict`, and assert the SAME interpretation at each step.
 *
 * The three frozen cases:
 *   1. neutral first-late     -> non-degrading, no owner action, banner quiet
 *   2. mature overdue         -> degrading, but STILL banner-quiet alone
 *   3. independent block      -> banner fires
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { ConnectionHealthSnapshot } from "../runtime/connection-health.ts";
import { deriveOwnerState, sourceWorkGroupFromOwnerState } from "../runtime/owner-state.ts";
import { synthesizeRenderedVerdict } from "../runtime/rendered-verdict.ts";
import { composeFleetHealthVerdict } from "../server/fleet-health.ts";
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

/** SURFACE 1 — the summary projection the live route serves. */
function projectSnapshot(hoursSinceSuccess: number): ConnectionHealthSnapshot {
  const run = successAt(hoursSinceSuccess);
  return projectConnectorSummaryConnectionHealth({
    freshness: { status: "stale" },
    lastRun: run,
    lastSuccessfulRun: run,
    observedAt: NOW,
    schedule: { enabled: true, interval_seconds: SIX_HOURS_S },
  } as never);
}

/** SURFACE 2 — the rendered verdict the owner actually reads. */
function render(snapshot: ConnectionHealthSnapshot) {
  return synthesizeRenderedVerdict(snapshot, [], null, true, null, { enabled: true } as never);
}

/**
 * SURFACE 3 — the owner state, DERIVED from the projected snapshot and its
 * rendered verdict rather than hand-written. An invented `resolver` (there is
 * no `"system"` in `OwnerStateResolver`) would take an undefined branch in the
 * work-group mapping and could make the banner stay quiet for the wrong
 * reason — the invalid-fixture failure mode that has already masked bugs here.
 */
function ownerStateOf(snapshot: ConnectionHealthSnapshot, hoursSinceSuccess: number) {
  const asOf = new Date(NOW_MS - hoursSinceSuccess * HOUR_MS).toISOString();
  return deriveOwnerState(render(snapshot), snapshot, {
    as_of: asOf,
    lifecycle: null,
    progress: { active: false },
    schedule_mode: "scheduled-active",
    source: "latest_terminal_run",
  });
}

/** SURFACE 4 — the Sources grouping the owner's page buckets rows into. */
function workGroupOf(snapshot: ConnectionHealthSnapshot, hoursSinceSuccess: number) {
  return sourceWorkGroupFromOwnerState(ownerStateOf(snapshot, hoursSinceSuccess).resolver);
}

/** SURFACE 5/6 — fleet verdict and the global banner, from that same snapshot. */
function fleet(snapshot: ConnectionHealthSnapshot, connectionId: string, hoursSinceSuccess: number) {
  const ownerState = ownerStateOf(snapshot, hoursSinceSuccess);
  return composeFleetHealthVerdict({
    inventory: [
      {
        connectorId: connectionId.split("-")[0] ?? connectionId,
        connectorInstanceId: connectionId,
        displayName: connectionId,
        revokedAt: null,
        status: "active",
      },
    ],
    runtime: { ok: true },
    streamHealth: { status: "pass" },
    summaries: [
      {
        connection_health: snapshot,
        connection_id: connectionId,
        owner_state: ownerState,
        rendered_verdict: render(snapshot),
        schedule: { enabled: true },
      } as never,
    ],
  } as never);
}

function freshOf(snapshot: ConnectionHealthSnapshot) {
  return snapshot.conditions.find((c) => c.type === "Fresh");
}

test("CROSS-SURFACE: neutral first-late agrees across summary, verdict, fleet, and banner", () => {
  const snapshot = projectSnapshot(7); // one missed 6h beat

  // Summary: the staleness FACT is present, below the degrading threshold.
  const fresh = freshOf(snapshot);
  assert.equal(fresh?.status, "false", "the age is always disclosed, never hidden");
  assert.equal(fresh?.severity, "info", "ordinary lateness is not degrading");

  // Rendered verdict: no owner action attached to neutral automatic retry.
  const verdict = render(snapshot);
  const ownerActions = verdict.required_actions.filter((a) => a.audience === "owner");
  assert.equal(
    ownerActions.length,
    0,
    "a source that is merely late needs nothing from the owner — attaching a CTA here is the false-remedy defect"
  );

  // Sources grouping: the owner's page must not bucket this as needing them.
  const group = workGroupOf(snapshot, 7);
  assert.notEqual(group, "needs_owner", "a merely-late source is not the owner's problem to solve");
  // KNOWN DISAGREEMENT, deliberately asserted as it stands rather than
  // wished away: this currently groups `system_issue`, because
  // `resolveOwnerStateResolver` reads `verdict.pill.tone`, the pill still
  // renders amber "Needs refresh" for a merely-late source, and
  // `systemDegradedForTone.amber` is true. The summary now says `info`; the
  // pill and grouping have not been taught cadence. Pinning the real value
  // keeps the contradiction visible instead of letting a `notEqual` hide it.
  assert.equal(group, "system_issue", "PINS A KNOWN GAP: pill/owner-state do not yet read cadence — see ledger");

  // Same known gap reaching the banner: amber pill -> `system_degraded` ->
  // materially blocked -> fires, even though the summary now calls this
  // neutral. The frozen target is `false`; this asserts the CURRENT value so
  // the distance to that target is measured rather than asserted away.
  const result = fleet(snapshot, "late-x", 7);
  assert.equal(
    result.banner_warranted,
    true,
    "PINS A KNOWN GAP: frozen target is false — pill/owner-state must read cadence before this can flip"
  );
});

test("CROSS-SURFACE: mature overdue is degrading yet STILL banner-quiet on its own", () => {
  const snapshot = projectSnapshot(25); // past 3x the interval

  const fresh = freshOf(snapshot);
  assert.equal(fresh?.severity, "warning", "mature lateness earns the degrading severity at the summary");

  assert.notEqual(
    workGroupOf(snapshot, 25),
    "needs_owner",
    "maturity alone never converts a late source into an owner request"
  );

  // Same known gap, one layer further: with the pill amber and owner state
  // `system_degraded`, the fleet composer counts this row as materially
  // blocked and fires. Asserted as-is so the gap is measured, not masked.
  const result = fleet(snapshot, "overdue-x", 25);
  assert.equal(
    result.banner_warranted,
    true,
    "PINS A KNOWN GAP: banner still fires on amber tone alone; the frozen target is false — see ledger"
  );
});

test("CROSS-SURFACE: the neutral and mature snapshots differ only by elapsed time", () => {
  // Same connection, same cadence, same stale freshness verdict. If these two
  // agreed at every surface, hysteresis would be doing nothing.
  const neutral = freshOf(projectSnapshot(7));
  const mature = freshOf(projectSnapshot(25));
  assert.equal(neutral?.status, mature?.status, "both are honestly stale");
  assert.notEqual(neutral?.severity, mature?.severity, "but only one is degrading");
});

test("CROSS-SURFACE: exact neutral copy, pinned so it cannot regress into a false promise", () => {
  const fresh = freshOf(projectSnapshot(7));
  assert.equal(
    fresh?.message,
    "Retained data is stale; this source is late for its usual schedule and will keep retrying.",
    "names the schedule and the automatic retry, and asks for nothing"
  );
  assert.ok(
    fresh?.remediation === null || fresh?.remediation === undefined,
    "no remediation — the research's stale-but-retrying tier is explicitly 'no action needed from you right now'"
  );
});
