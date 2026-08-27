// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Provider coverage-horizon/provenance disclosure (`runtime/coverage-horizon.ts`,
 * `server/stores/connector-coverage-horizon-store.ts`).
 *
 * A coverage horizon is a THIRD axis, orthogonal to both possession and
 * connection health: a structured, reversible disclosure of the BOUNDARY of
 * what a source can EVER provide (e.g. "GroupMe does not retain group
 * messages before 2013"). This file proves the properties that make it safe
 * to add at all:
 *
 *   1. `coverage_horizons` itself is a pure pass-through additive rollup
 *      through `computeConnectionHealth` ->
 *      `ConnectionHealthSnapshot.coverage_horizons` ->
 *      `synthesizeRenderedVerdict`'s `detail.coverage_horizons` — never the
 *      `pill`/`channel`/`annotations` directly. Modeled directly on
 *      `test/connection-health-source-pressure-backlog.test.ts`'s
 *      `detail_gap_backlog` integration tests, the closest existing precedent
 *      for an additive, nullable-empty rollup.
 *   2. The horizon record NEVER by itself moves a `terminal_gap` axis, and an
 *      UNPROVEN boundary (no confirmed horizon on record, or a superseded
 *      one) can never be accepted as provider reality — absence here means
 *      "not read," never "confirmed absent."
 *   3. `ConnectionCoverageEvidence.horizonAccountedRetryableGap` — the ONE
 *      place a horizon legitimately narrows the coverage DENOMINATOR — softens
 *      `retryable_gap` ONLY when the caller has independently verified BOTH a
 *      connector-reported boundary claim AND a current confirmed horizon
 *      (`isProvenPreHorizonGap`/`isStreamFullyHorizonAccounted`,
 *      `connector-gap-classification.test.ts`, covers the rollup itself); this
 *      file proves the connection-health-layer contract: the flag alone
 *      (never the horizon record's mere presence) is what moves
 *      `SourceCoverageComplete`, and even then only for `retryable_gap` —
 *      `terminal_gap` and every other axis are untouched regardless of the
 *      flag.
 *
 * Pure mapping/projection; no grant/auth/token/consent logic (no RED tokens
 * in the modules under test). No source is changed.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { ComputeConnectionHealthInput } from "../runtime/connection-health.ts";
import { computeConnectionHealth } from "../runtime/connection-health.ts";
import type { ConnectionCoverageHorizon } from "../runtime/coverage-horizon.ts";
import { coverageHorizonDisclosure } from "../runtime/coverage-horizon.ts";
import { synthesizeRenderedVerdict } from "../runtime/rendered-verdict.ts";

const NOW = "2026-08-27T12:00:00.000Z";
const ALARM_REGISTER_RE = /error|fail|broken/i;
const RECORDS_BEFORE_DATE_RE = /records before 2013-01-01/;
const RETENTION_POLICY_RE = /provider's own retention policy/;
const NOT_A_PROBLEM_RE = /not a problem with the connection/i;
const BEFORE_CONNECTION_EXISTED_RE = /before this connection existed/;
const RECORDS_BEFORE_NULL_RE = /records before null/;

/** Default healthy input: succeeded run, complete coverage, fresh. Mirrors the source-pressure-backlog test's `healthyInput`. */
function healthyInput(overrides: Partial<ComputeConnectionHealthInput> = {}): ComputeConnectionHealthInput {
  return {
    activity: null,
    attention: null,
    backoff: null,
    coverage: { axis: "complete" },
    freshness: { axis: "fresh" },
    observedAt: NOW,
    outbox: null,
    projection: null,
    run: {
      hasDegradingGaps: false,
      lastSuccessAt: "2026-08-27T00:00:00.000Z",
      latestStatus: "succeeded",
      reasonCode: null,
    },
    schedule: { enabled: true },
    ...overrides,
  };
}

function horizon(overrides: Partial<ConnectionCoverageHorizon> = {}): ConnectionCoverageHorizon {
  return {
    basis: "provider_stated",
    confirmedAt: "2026-08-01T00:00:00.000Z",
    confirmedBy: "owner:test-owner",
    connectorInstanceId: "cin_test",
    earliestAvailable: "2013-01-01T00:00:00.000Z",
    horizonId: "covhz_test",
    note: null,
    reason: "provider_retention_policy",
    stream: "*",
    supersededAt: null,
    supersededByHorizonId: null,
    ...overrides,
  };
}

// ─── coverageHorizonDisclosure: pure presentation over an already-recorded horizon ───

test("disclosure: names the boundary date and reason in neutral, non-alarm register", () => {
  const text = coverageHorizonDisclosure(horizon());
  assert.match(text, RECORDS_BEFORE_DATE_RE);
  assert.match(text, RETENTION_POLICY_RE);
  assert.match(text, NOT_A_PROBLEM_RE);
});

test("disclosure: an unknown exact edge reads as 'before this connection existed', never a fabricated date", () => {
  const text = coverageHorizonDisclosure(horizon({ earliestAvailable: null }));
  assert.match(text, BEFORE_CONNECTION_EXISTED_RE);
  assert.doesNotMatch(text, RECORDS_BEFORE_NULL_RE);
});

test("disclosure: every closed reason maps to distinct, non-alarm copy", () => {
  const reasons: ConnectionCoverageHorizon["reason"][] = [
    "consent_window",
    "provider_deleted_history",
    "provider_never_had_data",
    "provider_retention_policy",
  ];
  const texts = reasons.map((reason) => coverageHorizonDisclosure(horizon({ reason })));
  assert.equal(new Set(texts).size, texts.length, "each reason must produce distinct copy");
  for (const text of texts) {
    assert.doesNotMatch(text, ALARM_REGISTER_RE);
  }
});

// ─── computeConnectionHealth: pass-through integration ─────────────────────

test("snapshot: coverage_horizons is empty when no evidence is supplied (absence means 'not read')", () => {
  const snap = computeConnectionHealth(healthyInput());
  assert.deepEqual(snap.coverage_horizons, []);
});

test("snapshot: exposes coverage_horizons carried verbatim from the evidence", () => {
  const h = horizon();
  const snap = computeConnectionHealth(healthyInput({ coverageHorizons: [h] }));
  assert.deepEqual(snap.coverage_horizons, [h]);
});

test("snapshot: a coverage horizon does not move the headline projection", () => {
  const base = computeConnectionHealth(healthyInput());
  const withHorizon = computeConnectionHealth(healthyInput({ coverageHorizons: [horizon()] }));
  // Headline + every axis + forward disposition + conditions are
  // byte-identical: the horizon is pure annotation and changes only
  // `coverage_horizons`.
  assert.equal(withHorizon.state, base.state);
  assert.equal(withHorizon.state, "healthy");
  assert.equal(withHorizon.reason_code, base.reason_code);
  assert.equal(withHorizon.forward_disposition, base.forward_disposition);
  assert.deepEqual(withHorizon.axes, base.axes);
  assert.deepEqual(withHorizon.conditions, base.conditions);
  assert.equal(withHorizon.next_action, base.next_action);
  assert.equal(withHorizon.next_attempt_at, base.next_attempt_at);
  assert.deepEqual(base.coverage_horizons, []);
  assert.deepEqual(withHorizon.coverage_horizons, [horizon()]);
});

// ─── The two required negative tests ────────────────────────────────────────

test("NEGATIVE: a provider-retention boundary can never become a retryable failure", () => {
  // A stream with a genuine, terminal, permanent gap (the provider will
  // never serve pre-2013 history) MUST NOT be reclassified as
  // `retryable_gap`/`resumable` merely because a coverage horizon explains
  // WHY the gap exists. The BARE HORIZON RECORD (`coverageHorizons`, with no
  // `horizonAccountedRetryableGap` proof set) carries no `ConnectionHealthState`
  // and moves no axis — see the `horizonAccountedRetryableGap` section below
  // for the ONE narrow, explicitly-gated case where a caller's own proof CAN
  // soften `retryable_gap` specifically. Proving the bare-record case on a
  // `terminal_gap` coverage axis: attaching a horizon record must leave the
  // coverage axis, the forward disposition, and the headline state exactly
  // as red/terminal as they were without it.
  const terminalGapInput = healthyInput({
    coverage: { axis: "terminal_gap" },
    run: {
      hasDegradingGaps: true,
      lastSuccessAt: "2026-08-27T00:00:00.000Z",
      latestStatus: "succeeded",
      reasonCode: null,
    },
  });
  const withoutHorizon = computeConnectionHealth(terminalGapInput);
  const withHorizon = computeConnectionHealth({
    ...terminalGapInput,
    coverageHorizons: [
      horizon({
        note: "GroupMe confirmed it does not retain group messages before 2013",
        reason: "provider_deleted_history",
      }),
    ],
  });
  assert.equal(withoutHorizon.axes.coverage, "terminal_gap");
  assert.equal(withHorizon.axes.coverage, "terminal_gap", "a horizon must not soften terminal_gap to retryable_gap");
  assert.equal(withoutHorizon.forward_disposition, withHorizon.forward_disposition);
  assert.notEqual(withHorizon.forward_disposition, "resumable", "a horizon must not fabricate resumability");
  assert.equal(withoutHorizon.state, withHorizon.state);

  // The same must hold one layer up, at the rendered verdict: the verdict's
  // tone/channel/pill must be identical with or without the horizon, and the
  // horizon must appear ONLY in `detail`, never influence `pill`/`channel`.
  const verdictWithout = synthesizeRenderedVerdict(withoutHorizon, [], null, true);
  const verdictWith = synthesizeRenderedVerdict(withHorizon, [], null, true);
  assert.deepEqual(verdictWith.pill, verdictWithout.pill);
  assert.equal(verdictWith.channel, verdictWithout.channel);
  assert.deepEqual(verdictWith.annotations, verdictWithout.annotations);
  assert.deepEqual(verdictWith.required_actions, verdictWithout.required_actions);
  assert.deepEqual(verdictWithout.detail.coverage_horizons, []);
  assert.equal(verdictWith.detail.coverage_horizons.length, 1);
});

test("NEGATIVE: an unproven boundary cannot be accepted as provider reality", () => {
  // No `ConnectionCoverageHorizon` record for a connection means "nobody
  // has confirmed a boundary here" — it must NOT be read as "the provider
  // confirmed there is no more data." A stream that is missing data for an
  // UNKNOWN reason (no horizon on record) must keep its ordinary
  // gap/coverage classification exactly as if this module did not exist:
  // the absence of a horizon can never manufacture a "this is fine, it's a
  // known boundary" verdict.
  const gapInput = healthyInput({
    coverage: { axis: "gaps" },
    run: {
      hasDegradingGaps: true,
      lastSuccessAt: "2026-08-27T00:00:00.000Z",
      latestStatus: "succeeded",
      reasonCode: null,
    },
  });
  const snap = computeConnectionHealth(gapInput); // no coverageHorizons supplied at all
  assert.deepEqual(snap.coverage_horizons, [], "no confirmed horizon exists for this connection");
  assert.equal(snap.axes.coverage, "gaps", "an unproven boundary must not soften a real coverage gap");
  assert.notEqual(snap.state, "healthy");

  const verdict = synthesizeRenderedVerdict(snap, [], null, true);
  assert.deepEqual(verdict.detail.coverage_horizons, [], "detail must not invent a horizon that was never confirmed");
  assert.notEqual(verdict.pill.tone, "green", "an unconfirmed boundary must not read as a settled, healthy absence");

  // A `supersededAt`-set (no-longer-current) horizon record is likewise not
  // a CURRENT confirmed boundary. `ConnectorCoverageHorizonStore
  // .getCurrentCoverageHorizons` filters these out at the store layer (see
  // its `WHERE superseded_at IS NULL` query); this asserts the type-level
  // contract a caller must honor if it reads raw rows instead: a superseded
  // record is provenance history, never a live disclosure.
  const supersededOnly = computeConnectionHealth({
    ...gapInput,
    coverageHorizons: [horizon({ supersededAt: "2026-08-15T00:00:00.000Z", supersededByHorizonId: "covhz_newer" })],
  });
  // This module does not filter by supersession itself (that is the
  // store's job — see `runtime/coverage-horizon.ts`'s doc comment: "enforced
  // by callers... NOT by this module itself"); a caller that passes a
  // superseded row through unfiltered still leaves the coverage axis/state
  // untouched, proving the horizon carries no classification authority
  // regardless of its provenance state.
  assert.equal(supersededOnly.axes.coverage, "gaps");
  assert.equal(supersededOnly.state, snap.state);
});

// ─── horizonAccountedRetryableGap: the ONE case a horizon narrows coverage ──
//
// GOAL-OWNER RULING (recorded verbatim in
// `openspec/changes/add-coverage-horizon-and-actionability-banner/design.md`):
// "an affirmatively recorded current horizon may exclude ONLY the
// unavailable pre-horizon interval from the current servable denominator;
// current/in-horizon gaps and unproven horizons remain degrading." These
// tests exercise `sourceCoverageCondition`'s `SourceCoverageComplete`
// derivation directly via the `coverage.horizonAccountedRetryableGap` flag —
// the rollup that PRODUCES that flag from a connector's raw skip reason plus
// the confirmed horizon lives in `connector-gap-classification.ts` and is
// covered by its own test file; this file proves the connection-health-layer
// contract only: what the flag does and does not unlock.

test("GROUPME-LIKE: a pre-horizon retryable gap WITH a proven horizon reads coverage complete for the current, in-horizon scope — not the same as a healthy, unbounded green", () => {
  const input = healthyInput({
    coverage: { axis: "retryable_gap", horizonAccountedRetryableGap: true },
    coverageHorizons: [horizon({ note: "GroupMe confirmed no messages retained before 2013" })],
  });
  const snap = computeConnectionHealth(input);
  const coverageCondition = snap.conditions.find((c) => c.type === "SourceCoverageComplete");
  assert.equal(coverageCondition?.status, "true", "horizon-accounted coverage satisfies SourceCoverageComplete");
  assert.equal(coverageCondition?.reason, "coverage_complete_horizon_accounted");
  assert.match(coverageCondition?.message ?? "", /current, in-horizon scope/i);
  assert.doesNotMatch(coverageCondition?.message ?? "", /error|fail|broken/i, "still the neutral disclosure register");
  assert.equal(snap.axes.coverage, "retryable_gap", "the RAW axis is preserved — this softens the verdict, not the fact");

  // Retained records are never touched by this path — this module has no
  // record-mutation capability at all, but assert the shape it DOES touch
  // (conditions/state) never claims records changed.
  assert.doesNotMatch(JSON.stringify(snap), /delet|remov|purge/i);
});

test("NEGATIVE: the SAME retryable gap WITHOUT a confirmed horizon stays exactly as retryable/degrading as before", () => {
  // Byte-identical to the GroupMe-like case except `horizonAccountedRetryableGap`
  // is unset (the caller's rollup never computed it true — e.g. because no
  // horizon was ever confirmed for this stream). Coverage must NOT go green:
  // an unproven boundary is never accepted as provider reality.
  const input = healthyInput({ coverage: { axis: "retryable_gap" } });
  const snap = computeConnectionHealth(input);
  const coverageCondition = snap.conditions.find((c) => c.type === "SourceCoverageComplete");
  assert.equal(coverageCondition?.status, "false", "an unproven retryable gap still fails SourceCoverageComplete");
  assert.equal(coverageCondition?.reason, "retryable_gap");
  assert.notEqual(snap.state, "healthy");
});

test("NEGATIVE: an in-horizon (current-scope) gap stays unhealthy even with a confirmed horizon on record", () => {
  // A confirmed horizon existing SOMEWHERE on the connection must not launder
  // an unrelated, currently-in-scope gap: `horizonAccountedRetryableGap` is
  // the caller's affirmative claim that EVERY retryable gap matched its own
  // proven pre-horizon reason — a caller that (correctly) did NOT set it,
  // because the actual gap is a live/current-scope failure with no matching
  // boundary claim, must see coverage stay exactly as degrading as if no
  // horizon existed at all. The mere presence of `coverageHorizons` on the
  // snapshot must never be read as itself sufficient.
  const input = healthyInput({
    coverage: { axis: "retryable_gap" }, // horizonAccountedRetryableGap NOT set
    coverageHorizons: [horizon()], // a horizon exists, but the caller did not attribute this gap to it
  });
  const snap = computeConnectionHealth(input);
  const coverageCondition = snap.conditions.find((c) => c.type === "SourceCoverageComplete");
  assert.equal(coverageCondition?.status, "false", "a confirmed horizon elsewhere must not launder an in-scope gap");
  assert.notEqual(snap.state, "healthy");
  assert.equal(snap.coverage_horizons.length, 1, "the horizon still appears as disclosure — it just proves nothing here");
});

test("NEGATIVE: horizonAccountedRetryableGap never softens terminal_gap, only retryable_gap", () => {
  const input = healthyInput({
    coverage: { axis: "terminal_gap", horizonAccountedRetryableGap: true },
    run: { hasDegradingGaps: true, lastSuccessAt: "2026-08-27T00:00:00.000Z", latestStatus: "succeeded", reasonCode: null },
  });
  const snap = computeConnectionHealth(input);
  const coverageCondition = snap.conditions.find((c) => c.type === "SourceCoverageComplete");
  assert.notEqual(
    coverageCondition?.reason,
    "coverage_complete_horizon_accounted",
    "the horizon-accounted path is scoped to retryable_gap only"
  );
  assert.equal(coverageCondition?.status, "false");
});

test("NEGATIVE: requiredButAccepted still wins over horizon-accounted retryable coverage", () => {
  // Mirrors the existing `unfillableAccounted` + `requiredButAccepted`
  // precedence: a contradictory manifest (a REQUIRED stream declaring an
  // accepted-absent policy) refuses green regardless of any other proof.
  const input = healthyInput({
    coverage: { axis: "retryable_gap", horizonAccountedRetryableGap: true, requiredButAccepted: true },
    coverageHorizons: [horizon()],
  });
  const snap = computeConnectionHealth(input);
  const coverageCondition = snap.conditions.find((c) => c.type === "SourceCoverageComplete");
  assert.equal(coverageCondition?.status, "false", "a contradictory manifest still refuses green");
});
