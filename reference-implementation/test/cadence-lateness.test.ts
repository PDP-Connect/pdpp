// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Cadence-relative lateness with hysteresis, per
 * `health-banner-staleness-vs-freshness-design-prior-art.md` design proposal
 * (c)/(d): thresholds are a multiple of the SOURCE'S OWN interval, never a
 * fixed global constant, and a cheap reversible `late` is separated from
 * mature `overdue` evidence.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveCadenceLateness,
  latenessMayEscalate,
  LATE_MULTIPLIER,
  MIN_OVERDUE_GRACE_MS,
  OVERDUE_MULTIPLIER,
} from "../server/cadence-lateness.ts";

const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.parse("2026-08-27T12:00:00.000Z");

/** A 6-hour cadence: large enough that the multipliers, not MIN_GRACE_MS, decide. */
const SIX_HOURS_S = 6 * 60 * 60;

function at(hoursAgo: number): number {
  return NOW - hoursAgo * HOUR_MS;
}

test("a source collected within its own interval is on time", () => {
  const v = deriveCadenceLateness({ intervalSeconds: SIX_HOURS_S, lastSuccessAtMs: at(5), nowMs: NOW });
  assert.equal(v.state, "on_time");
  assert.equal(latenessMayEscalate(v), false);
});

test("crossing ONE expected interval is immediately neutral Late — the raw fact is not delayed", () => {
  // The plan is explicit: crossing one expected interval produces a neutral
  // Late state. Grace belongs between Late and escalation, never before Late —
  // hiding the honest "this was due and did not run" costs the owner a true
  // fact for no safety gain, because Late is not an alarm.
  const v = deriveCadenceLateness({ intervalSeconds: SIX_HOURS_S, lastSuccessAtMs: at(7), nowMs: NOW });
  assert.equal(v.state, "late");
  assert.equal(latenessMayEscalate(v), false, "late is a FACT, not a consequence");
});

test("still neutral late well past the first miss, short of maturity", () => {
  const v = deriveCadenceLateness({ intervalSeconds: SIX_HOURS_S, lastSuccessAtMs: at(13), nowMs: NOW });
  assert.equal(v.state, "late");
  assert.equal(
    latenessMayEscalate(v),
    false,
    "the first crossing is informational — the k8s readiness pattern, withheld not broken"
  );
});

test("only 3x the interval is MATURE evidence, and even then only a precondition", () => {
  const v = deriveCadenceLateness({ intervalSeconds: SIX_HOURS_S, lastSuccessAtMs: at(25), nowMs: NOW });
  assert.equal(v.state, "overdue");
  assert.equal(latenessMayEscalate(v), true, "mature lateness MAY contribute; it still never fires a banner alone");
});

test("thresholds are relative to each source's OWN cadence, not a global constant", () => {
  // The same absolute age is on-time for a daily source and overdue for a
  // frequent one. This is the single most corroborated finding in the survey.
  const ageHours = 20;
  const daily = deriveCadenceLateness({ intervalSeconds: 24 * 60 * 60, lastSuccessAtMs: at(ageHours), nowMs: NOW });
  const frequent = deriveCadenceLateness({ intervalSeconds: 60 * 60, lastSuccessAtMs: at(ageHours), nowMs: NOW });
  assert.equal(daily.state, "on_time", "20h is well within a daily source's own rhythm");
  assert.equal(frequent.state, "overdue", "20h is 20 missed beats for an hourly source");
});

test("the floor applies to ESCALATION only, never to the neutral late fact", () => {
  // A 60s source is honestly late 2 minutes after a success, and saying so is
  // free. But three missed 60s beats is jitter, not mature evidence, so the
  // floor holds `overdue` back without suppressing the fact.
  const lastSuccessAtMs = NOW - 2 * 60 * 1000;
  const v = deriveCadenceLateness({ intervalSeconds: 60, lastSuccessAtMs, nowMs: NOW });
  assert.equal(v.state, "late", "one interval late IS late, at any cadence");
  assert.equal(latenessMayEscalate(v), false, "but nowhere near mature");
  assert.equal(v.overdueAfterMs, lastSuccessAtMs + MIN_OVERDUE_GRACE_MS, "the floor decides maturity, not 3x60s");
});

test("SILENTLY STOPPED: a source that never fails still becomes overdue", () => {
  // The case a failure counter cannot see. `consecutiveFailures` never
  // increments for a collector that simply stopped being invoked, so
  // failure-count hysteresis is blind to exactly the shape that matters most
  // for a local collector that died.
  const v = deriveCadenceLateness({ intervalSeconds: SIX_HOURS_S, lastSuccessAtMs: at(240), nowMs: NOW });
  assert.equal(v.state, "overdue", "ten days of silence is mature evidence without a single failed run");
  assert.equal(latenessMayEscalate(v), true);
});

test("no declared interval is UNKNOWN, never late", () => {
  // Absence of a cadence is not evidence of lateness. Treating it as such is
  // how a manual import or a never-scheduled source gets reported as broken.
  for (const intervalSeconds of [null, undefined, 0, -1, Number.NaN]) {
    const v = deriveCadenceLateness({ intervalSeconds, lastSuccessAtMs: at(1000), nowMs: NOW });
    assert.equal(v.state, "unknown", `interval ${String(intervalSeconds)} must not produce a lateness claim`);
    assert.equal(latenessMayEscalate(v), false);
  }
});

test("a source that has never succeeded is UNKNOWN, not overdue", () => {
  const v = deriveCadenceLateness({ intervalSeconds: SIX_HOURS_S, lastSuccessAtMs: null, nowMs: NOW });
  assert.equal(v.state, "unknown", "never-run is a different fact from late, and must not be conflated");
  assert.equal(latenessMayEscalate(v), false);
});

test("the deadlines are exposed as plain facts even while on time", () => {
  // Freshness is displayed unconditionally; only escalation is conditional.
  const v = deriveCadenceLateness({ intervalSeconds: SIX_HOURS_S, lastSuccessAtMs: at(1), nowMs: NOW });
  assert.equal(v.state, "on_time");
  assert.ok(v.lateAfterMs !== null && v.overdueAfterMs !== null, "the owner can always see when this becomes late");
  assert.ok((v.overdueAfterMs as number) > (v.lateAfterMs as number), "overdue must be strictly later than late");
});

test("the two thresholds are nested, never inverted, across a wide cadence range", () => {
  for (const intervalSeconds of [30, 300, 3600, 86_400, 7 * 86_400]) {
    const v = deriveCadenceLateness({ intervalSeconds, lastSuccessAtMs: at(1), nowMs: NOW });
    assert.ok(
      (v.overdueAfterMs as number) > (v.lateAfterMs as number),
      `nesting must hold at interval ${intervalSeconds}s, or "mature" could precede "first late"`
    );
  }
  assert.ok(OVERDUE_MULTIPLIER > LATE_MULTIPLIER, "the multipliers themselves must stay ordered");
});
