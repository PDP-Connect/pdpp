// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Cross-surface agreement for cadence hysteresis.
 *
 * The frozen acceptance requires the summary, rendered verdict, Sources
 * grouping, fleet verdict and banner to AGREE. A test that stops at
 * `snapshot.conditions` proves only the first; a fleet test built from
 * hand-written summaries proves only the last; and a THIN input proves neither,
 * because a snapshot missing coverage/outbox/projection evidence can land in
 * `unknown` for reasons that have nothing to do with lateness.
 *
 * So this carries ONE snapshot, built from the same otherwise-healthy complete
 * input shape as `health-authority-cross-surface.test.ts`, through
 * `synthesizeRenderedVerdict` -> `deriveOwnerState` ->
 * `sourceWorkGroupFromOwnerState` -> `composeFleetHealthVerdict`. The ONLY
 * variable across cases is cadence lateness.
 *
 * Typed deliberately as `ComputeConnectionHealthInput` rather than `as never`.
 * Invalid fixtures have already masked real bugs here three times — an invented
 * `resolver`, an invented `schedule_mode`, and an invented `attention` axis —
 * and each looked like a product defect until the cast was removed.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  type ComputeConnectionHealthInput,
  computeConnectionHealth,
  type ConnectionHealthSnapshot,
} from "../runtime/connection-health.ts";
import { deriveOwnerState, sourceWorkGroupFromOwnerState } from "../runtime/owner-state.ts";
import { synthesizeRenderedVerdict } from "../runtime/rendered-verdict.ts";
import { composeFleetHealthVerdict, type FleetSummary } from "../server/fleet-health.ts";
import {
  BASELINE_ACTIVE_SCHEDULE,
  BASELINE_AUTOMATIC_REFRESH,
  BASELINE_SUCCESS_AT,
  healthyConnectionInput,
} from "./fixtures/connection-health-baseline.ts";

const SUCCESS_AT = BASELINE_SUCCESS_AT;
const AUTOMATIC_REFRESH = BASELINE_AUTOMATIC_REFRESH;
const ACTIVE_SCHEDULE = BASELINE_ACTIVE_SCHEDULE;

type Lateness = NonNullable<ComputeConnectionHealthInput["lateness"]>["state"];

/**
 * An OTHERWISE-HEALTHY connection: coverage complete, outbox idle, projection
 * reliable, no backoff, no attention, latest run succeeded. Only freshness and
 * lateness vary, so any difference in the verdict is attributable to cadence
 * and nothing else.
 */
/**
 * The shared known-green baseline with ONLY this oracle's subject overridden.
 * Hand-building an "otherwise-healthy" input is what produced four separate
 * fixture defects here; the baseline is green by construction instead.
 */
function input(lateness: Lateness, freshness: "fresh" | "stale" = "stale"): ComputeConnectionHealthInput {
  return healthyConnectionInput({ freshness: { axis: freshness }, lateness: { state: lateness } });
}

/** SURFACE 1 — the health snapshot. */
function snapshotFor(lateness: Lateness): ConnectionHealthSnapshot {
  return computeConnectionHealth(input(lateness));
}

/** SURFACE 2 — the rendered verdict the owner reads. */
function render(snapshot: ConnectionHealthSnapshot) {
  return synthesizeRenderedVerdict(snapshot, [], AUTOMATIC_REFRESH, true, null, ACTIVE_SCHEDULE);
}

/**
 * SURFACE 3 — owner state, DERIVED. A succeeded run's causal evidence is
 * `last_successful_freshness` (a positive current fact), not
 * `latest_terminal_run` (read as frozen and ageing), and a live connection's
 * lifecycle is `active` — matching `health-authority-cross-surface.test.ts`.
 * Getting this wrong makes the resolver report what the FIXTURE said.
 */
function ownerStateFor(snapshot: ConnectionHealthSnapshot) {
  return deriveOwnerState(render(snapshot), snapshot, {
    as_of: SUCCESS_AT,
    lifecycle: { status: "active" },
    progress: { active: false },
    schedule_mode: "scheduled-active",
    source: "last_successful_freshness",
  });
}

/** SURFACE 4 — the Sources grouping the owner's page buckets rows into. */
function workGroupFor(snapshot: ConnectionHealthSnapshot) {
  return sourceWorkGroupFromOwnerState(ownerStateFor(snapshot).resolver);
}

/** SURFACE 5/6 — fleet verdict and global banner, from that same snapshot. */
function fleetFor(snapshot: ConnectionHealthSnapshot, connectionId: string) {
  return composeFleetHealthVerdict({
    inventory: [
      {
        connectorId: "test-connector",
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
        connector_id: "test-connector",
        connector_instance_id: connectionId,
        display_name: connectionId,
        owner_state: ownerStateFor(snapshot),
        rendered_verdict: render(snapshot),
        schedule: { enabled: true },
      } satisfies FleetSummary,
    ],
  });
}

function freshOf(snapshot: ConnectionHealthSnapshot) {
  return snapshot.conditions.find((c) => c.type === "Fresh");
}

test("CONTROL: an on-time otherwise-healthy source is healthy and quiet everywhere", () => {
  const snapshot = computeConnectionHealth(input("on_time", "fresh"));
  assert.equal(snapshot.state, "healthy", "the baseline must be genuinely green, or every case below proves nothing");
  assert.equal(workGroupFor(snapshot), "none");
  assert.equal(fleetFor(snapshot, "ok-x").banner_warranted, false);
});

test("CROSS-SURFACE: neutral first-late is non-degrading at the summary", () => {
  const fresh = freshOf(snapshotFor("late"));
  assert.equal(fresh?.status, "false", "the age is always disclosed, never hidden");
  assert.equal(fresh?.severity, "info", "ordinary lateness sits below the degrading threshold");
});

test("CROSS-SURFACE: neutral first-late asks the owner for nothing", () => {
  const verdict = render(snapshotFor("late"));
  assert.equal(
    verdict.required_actions.filter((a) => a.audience === "owner").length,
    0,
    "a merely-late source needs nothing from the owner — a CTA here is the false-remedy defect"
  );
});

test("CROSS-SURFACE: neutral first-late is not a system fault and does not banner", () => {
  const snapshot = snapshotFor("late");
  const group = workGroupFor(snapshot);
  assert.notEqual(group, "needs_owner", "the owner is not blocking anything");
  assert.notEqual(group, "system_issue", "and nothing is broken — the next run simply has not happened yet");
  assert.equal(fleetFor(snapshot, "late-x").banner_warranted, false, "ordinary lateness must never fire the banner");
});

test("CROSS-SURFACE: mature overdue is degrading, yet STILL does not banner alone", () => {
  const snapshot = snapshotFor("overdue");
  assert.equal(freshOf(snapshot)?.severity, "warning", "mature lateness earns the degrading severity");
  assert.notEqual(workGroupFor(snapshot), "needs_owner", "maturity alone never becomes an owner request");
  assert.equal(
    fleetFor(snapshot, "overdue-x").banner_warranted,
    false,
    "maturity is a PRECONDITION: without an independently proven block the banner stays quiet"
  );
});

test("POSITIVE CONTROL: a real credential block still fires the banner", () => {
  // The discrimination that makes the silence meaningful. Same otherwise-healthy
  // connection; the ONLY change is a genuine owner-actionable credential failure.
  // A REAL credential failure: the latest run failed with a credential reason
  // code. (`authentication: { authenticates: false }` is a different fact —
  // "this connector does not authenticate at all", i.e. a file import — and
  // produces no failing condition, which is why it is not the control here.)
  const blocked = computeConnectionHealth(
    healthyConnectionInput({
      freshness: { axis: "stale" },
      lateness: { state: "late" },
      run: {
        hasDegradingGaps: true,
        lastSuccessAt: BASELINE_SUCCESS_AT,
        latestStatus: "failed",
        reasonCode: "credentials_rejected",
      },
    })
  );
  assert.equal(
    fleetFor(blocked, "creds-x").banner_warranted,
    true,
    "suppressing a genuinely blocked source is the failure that matters most"
  );
});

test("CROSS-SURFACE: neutral and mature differ only by elapsed time", () => {
  const neutral = freshOf(snapshotFor("late"));
  const mature = freshOf(snapshotFor("overdue"));
  assert.equal(neutral?.status, mature?.status, "both are honestly stale");
  assert.notEqual(neutral?.severity, mature?.severity, "but only one is degrading");
});

test("CROSS-SURFACE: exact neutral copy, pinned against regression into a false promise", () => {
  const fresh = freshOf(snapshotFor("late"));
  assert.equal(
    fresh?.message,
    "Retained data is stale; this source is late for its usual schedule and will keep retrying.",
    "names the schedule and the automatic retry, and asks for nothing"
  );
  assert.ok(
    fresh?.remediation === null || fresh?.remediation === undefined,
    "no remediation — the stale-but-retrying tier is explicitly 'no action needed from you right now'"
  );
});

test("NEGATIVE CONTROL: unrelated degradation is NOT softened just because the source is also late", () => {
  // The over-suppression risk. Each of these is a genuinely broken source that
  // ALSO happens to be late; the lateness must not launder any of them into a
  // non-system-issue reading. `cadenceLatenessIsSoleDegradation` requires every
  // current false condition to be `Fresh`, so one unrelated failure disqualifies
  // the whole softening.
  const unrelated: Array<[string, Partial<ComputeConnectionHealthInput>]> = [
    [
      "a failed run",
      {
        run: {
          hasDegradingGaps: true,
          lastSuccessAt: SUCCESS_AT,
          latestStatus: "failed",
          reasonCode: "network_timeout",
        },
      },
    ],
    ["a coverage gap", { coverage: { axis: "partial" } }],
    ["a stalled outbox", { outbox: { axis: "stalled" } }],
    ["an unreliable projection", { projection: { unreliableSources: ["records"] } }],
  ];

  for (const [label, override] of unrelated) {
    const snapshot = computeConnectionHealth(
      healthyConnectionInput({ freshness: { axis: "stale" }, lateness: { state: "late" }, ...override })
    );
    assert.notEqual(
      snapshot.state,
      "healthy",
      `${label}: the baseline sanity — this override must actually break something`
    );
    assert.equal(
      fleetFor(snapshot, `unrelated-${label.replace(/\W+/g, "-")}`).banner_warranted,
      true,
      `${label} must still fire the banner; being late as well cannot suppress a real fault`
    );
  }
});

test("NEGATIVE CONTROL: an UNKNOWN lateness fact softens nothing", () => {
  // No declared cadence, or never a successful run. A source PDPP cannot judge
  // for lateness keeps exactly the verdict it would have had.
  const unknownLate = computeConnectionHealth(
    healthyConnectionInput({ freshness: { axis: "stale" }, lateness: { state: "unknown" } })
  );
  const noLatenessAtAll = computeConnectionHealth(healthyConnectionInput({ freshness: { axis: "stale" } }));
  assert.equal(
    workGroupFor(unknownLate),
    workGroupFor(noLatenessAtAll),
    "an unknown lateness fact must be indistinguishable from no lateness fact"
  );
  assert.equal(
    fleetFor(unknownLate, "unknown-x").banner_warranted,
    fleetFor(noLatenessAtAll, "none-x").banner_warranted,
    "and must not change the banner either"
  );
});

test("NEGATIVE CONTROL: an ABSENT lateness fact softens nothing either", () => {
  // Closes the gap a surviving mutant exposed: relaxing the guard to accept
  // ANY lateness value — including `unknown` and absent — passed every other
  // test, because nothing compared a stale source that HAS no lateness fact
  // against one that does. Without this, the guard could silently degrade into
  // "stale is enough", which is the tone-as-evidence reading all over again.
  const withoutFact = computeConnectionHealth(healthyConnectionInput({ freshness: { axis: "stale" } }));
  const withLateFact = computeConnectionHealth(
    healthyConnectionInput({ freshness: { axis: "stale" }, lateness: { state: "late" } })
  );
  assert.equal(
    fleetFor(withoutFact, "absent-x").banner_warranted,
    true,
    "a stale source PDPP cannot judge for lateness keeps its pre-existing verdict"
  );
  assert.equal(
    fleetFor(withLateFact, "present-x").banner_warranted,
    false,
    "and the ONLY difference is the explicit fact — proving the guard reads evidence, not staleness"
  );
});
