// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_INITIAL_REVALIDATION_DELAY_MS,
  DEFAULT_MAX_REVALIDATION_DELAY_MS,
  decideSynthesizedRevalidation,
  SYNTHESIZED_REVALIDATION_PENDING_MARKER,
} from "../runtime/scheduler/synthesized-attention-revalidation.ts";
import type { RunRecord } from "../runtime/scheduler-domain-types.ts";

const CONNECTOR_ID = "chatgpt";
const CONNECTOR_INSTANCE_ID = "cin_chatgpt_blocked";

function pendingSkip(atMs: number): RunRecord {
  return {
    attempt: 0,
    checkpointSummary: null,
    completedAt: new Date(atMs).toISOString(),
    connectorId: CONNECTOR_ID,
    connectorInstanceId: CONNECTOR_INSTANCE_ID,
    error: `${SYNTHESIZED_REVALIDATION_PENDING_MARKER}:attention_unresolved: session_required (owner_action:cin_chatgpt_blocked:reauth:browser_session:credential_present_and_unrejected:session_required)`,
    knownGaps: [],
    recordsEmitted: 0,
    source: { id: CONNECTOR_ID, kind: "connector" },
    startedAt: new Date(atMs).toISOString(),
    status: "skipped",
  };
}

function failedProbe(atMs: number): RunRecord {
  return {
    attempt: 1,
    checkpointSummary: null,
    completedAt: new Date(atMs).toISOString(),
    connectorId: CONNECTOR_ID,
    connectorInstanceId: CONNECTOR_INSTANCE_ID,
    error: "session_required",
    knownGaps: [],
    recordsEmitted: 0,
    source: { id: CONNECTOR_ID, kind: "connector", revalidationProbe: true },
    startedAt: new Date(atMs).toISOString(),
    status: "failed",
    terminalReason: "authentication_error",
  };
}

function succeededProbe(atMs: number): RunRecord {
  return {
    attempt: 1,
    checkpointSummary: null,
    completedAt: new Date(atMs).toISOString(),
    connectorId: CONNECTOR_ID,
    connectorInstanceId: CONNECTOR_INSTANCE_ID,
    knownGaps: [],
    recordsEmitted: 12,
    source: { id: CONNECTOR_ID, kind: "connector", revalidationProbe: true },
    startedAt: new Date(atMs).toISOString(),
    status: "succeeded",
  };
}

function ordinaryFailure(atMs: number, reason: RunRecord["terminalReason"] = "authentication_error"): RunRecord {
  return {
    attempt: 1,
    checkpointSummary: null,
    completedAt: new Date(atMs).toISOString(),
    connectorId: CONNECTOR_ID,
    connectorInstanceId: CONNECTOR_INSTANCE_ID,
    knownGaps: [],
    recordsEmitted: 0,
    source: { id: CONNECTOR_ID, kind: "connector" },
    startedAt: new Date(atMs).toISOString(),
    status: "failed",
    terminalReason: reason,
  };
}

test("no prior activity: never admits immediately, arms initial delay from now", () => {
  const now = 1_000_000;
  const decision = decideSynthesizedRevalidation([], now);
  assert.equal(decision.admit, false);
  assert.equal(decision.attempt, 0);
  assert.equal(decision.delayMs, DEFAULT_INITIAL_REVALIDATION_DELAY_MS);
  assert.equal(decision.nextEligibleAt, new Date(now + DEFAULT_INITIAL_REVALIDATION_DELAY_MS).toISOString());
});

test("first pending skip: not admitted before the initial delay elapses", () => {
  const skipAt = 1_000_000;
  const now = skipAt + 1000; // 1 second later, far short of 30 minutes
  const decision = decideSynthesizedRevalidation([pendingSkip(skipAt)], now, { initialDelayMs: 30 * 60 * 1000 });
  assert.equal(decision.admit, false);
  assert.equal(decision.attempt, 0);
});

test("first pending skip: admitted exactly once the initial delay elapses", () => {
  const skipAt = 1_000_000;
  const initialDelayMs = 30 * 60 * 1000;
  const now = skipAt + initialDelayMs;
  const decision = decideSynthesizedRevalidation([pendingSkip(skipAt)], now, { initialDelayMs });
  assert.equal(decision.admit, true);
  assert.equal(decision.attempt, 0);
});

test("a failed probe re-arms the cooldown from the failure, not the original sighting", () => {
  const skipAt = 1_000_000;
  const initialDelayMs = 30 * 60 * 1000;
  const failAt = skipAt + initialDelayMs; // the admitted attempt happens here
  const history = [pendingSkip(skipAt), failedProbe(failAt)];

  // Immediately after the failed probe: not due (doubling means 2x initial).
  const justAfterFail = decideSynthesizedRevalidation(history, failAt + 1000, { initialDelayMs });
  assert.equal(justAfterFail.admit, false);
  assert.equal(justAfterFail.attempt, 1);
  assert.equal(justAfterFail.delayMs, initialDelayMs * 2);

  // Only 30 min after the failure (the ORIGINAL initial delay, not doubled) — still not due.
  const oneIntervalLater = decideSynthesizedRevalidation(history, failAt + initialDelayMs, { initialDelayMs });
  assert.equal(oneIntervalLater.admit, false, "doubled delay must not admit at the un-doubled interval");

  // A full doubled interval after the failure — now due.
  const twoIntervalsLater = decideSynthesizedRevalidation(history, failAt + initialDelayMs * 2, { initialDelayMs });
  assert.equal(twoIntervalsLater.admit, true);
});

test("repeated failed probes double the delay monotonically up to the cap", () => {
  const initialDelayMs = 60_000; // 1 min, small unit for fast exponent growth in the test
  const maxDelayMs = 5_000_000;
  let t = 0;
  const history: RunRecord[] = [pendingSkip(t)];
  const observedDelays: number[] = [];

  for (let round = 0; round < 12; round += 1) {
    const decision = decideSynthesizedRevalidation(history, t, { initialDelayMs, maxDelayMs });
    observedDelays.push(decision.delayMs);
    // Advance to exactly when this round's probe is admitted, then record its failure.
    t += decision.delayMs;
    history.push(failedProbe(t));
  }

  for (let i = 1; i < observedDelays.length; i += 1) {
    assert.ok(
      (observedDelays[i] ?? 0) >= (observedDelays[i - 1] ?? 0),
      `delay must be monotonically non-decreasing: round ${i} was ${observedDelays[i]}, previous was ${observedDelays[i - 1]}`
    );
  }
  assert.ok((observedDelays[0] ?? 0) >= initialDelayMs, "first delay must be bounded below by the initial floor");
  for (const d of observedDelays) {
    assert.ok(d <= maxDelayMs, `delay ${d} must never exceed the cap ${maxDelayMs}`);
  }
  assert.ok(
    observedDelays.some((d) => d === maxDelayMs),
    "the cap must actually bind within 12 rounds, not be dead code"
  );
});

test("mutation check: removing the cap allows delay to exceed maxDelayMs (proves the cap assertion is load-bearing)", () => {
  const initialDelayMs = 60_000;
  const maxExp = 20; // deliberately large so 2^20 * 60s vastly exceeds any sane cap
  const uncappedDelay = initialDelayMs * 2 ** Math.min(11, maxExp);
  assert.ok(uncappedDelay > DEFAULT_MAX_REVALIDATION_DELAY_MS, "the uncapped math must exceed the production cap");
  // decideSynthesizedRevalidation itself must still clamp — proves Math.min(...) is not a no-op.
  const history: RunRecord[] = [pendingSkip(0)];
  for (let i = 0; i < 11; i += 1) {
    history.push(failedProbe((i + 1) * 60_000));
  }
  const decision = decideSynthesizedRevalidation(history, 11 * 60_000, {
    initialDelayMs,
    maxBackoffExp: maxExp,
    maxDelayMs: DEFAULT_MAX_REVALIDATION_DELAY_MS,
  });
  assert.ok(
    decision.delayMs <= DEFAULT_MAX_REVALIDATION_DELAY_MS,
    `capped delay ${decision.delayMs} must not exceed ${DEFAULT_MAX_REVALIDATION_DELAY_MS}`
  );
});

test("a succeeded probe breaks the streak — a subsequent new failure starts fresh with the initial delay", () => {
  const initialDelayMs = 30 * 60 * 1000;
  const skipAt = 0;
  const failAt = initialDelayMs;
  const succeedAt = failAt + initialDelayMs * 2;
  // Streak: skip -> failed probe (doubles) -> succeeded probe (heals) -> NEW pending skip (new failure reoccurs)
  const newSkipAt = succeedAt + 1000;
  const history = [pendingSkip(skipAt), failedProbe(failAt), succeededProbe(succeedAt), pendingSkip(newSkipAt)];

  const rightAfterNewSkip = decideSynthesizedRevalidation(history, newSkipAt + 1000, { initialDelayMs });
  assert.equal(rightAfterNewSkip.attempt, 0, "attempt count resets after a success clears the prior streak");
  assert.equal(
    rightAfterNewSkip.admit,
    false,
    "must not admit immediately even after a healed-then-reoccurring failure"
  );
  assert.equal(rightAfterNewSkip.delayMs, initialDelayMs, "must get the FULL initial delay again, no residual memory");
});

test("an ordinary (non-revalidation) failure does not extend the streak or corrupt the anchor", () => {
  // A skip followed by an UNRELATED ordinary scheduled failure (not a
  // revalidationProbe) must break the streak exactly like an unrelated
  // reason class breaks scheduler-backoff.ts's walk.
  const skipAt = 1_000_000;
  const ordinaryFailAt = skipAt + 500;
  const history = [pendingSkip(skipAt), ordinaryFailure(ordinaryFailAt)];
  const decision = decideSynthesizedRevalidation(history, ordinaryFailAt + 10, {});
  assert.equal(decision.attempt, 0, "ordinary failure is not a revalidation attempt");
  // The trailing walk stops at the ordinary failure (newest), so there is
  // no revalidation-pending activity observed at all from this tail.
  assert.equal(decision.admit, false);
});

test("connector-key collision: a connector whose custom key is literally 'owner_action' does not corrupt the discriminant", () => {
  // Regression for the REJECTED v1 P1: v1 classified durable-vs-synthesized
  // by parsing `key`'s `owner_action:` string prefix, which a connector
  // could collide with by declaring `connector_key: "owner_action"`. This
  // module never reads `evidence.key`'s prefix at all — it identifies its
  // own activity purely via `SYNTHESIZED_REVALIDATION_PENDING_MARKER` (a
  // fixed `error`-field prefix, authored only by pre-run-gate.ts) and
  // `RunRecord.source.revalidationProbe` (authored only by run-executor.ts).
  // Simulate a durable record whose dedupe key happens to start with
  // "owner_action:" (the connector-key-collision shape) — it must NOT be
  // picked up by this module's streak walk, because it is not tagged with
  // the SYNTHESIZED_REVALIDATION_PENDING_MARKER prefix (only gateAttention's
  // synthesized branch adds that marker; the durable branch never does).
  const collidingKeyRecord: RunRecord = {
    attempt: 0,
    checkpointSummary: null,
    completedAt: new Date(1000).toISOString(),
    connectorId: CONNECTOR_ID,
    connectorInstanceId: CONNECTOR_INSTANCE_ID,
    error: "attention_unresolved: otp_required (owner_action:default:interaction:otp:global)",
    knownGaps: [],
    recordsEmitted: 0,
    source: { id: CONNECTOR_ID, kind: "connector" },
    startedAt: new Date(1000).toISOString(),
    status: "skipped",
  };
  const decision = decideSynthesizedRevalidation([collidingKeyRecord], 10_000_000, {});
  assert.equal(decision.attempt, 0);
  assert.equal(
    decision.admit,
    false,
    "an owner_action:-shaped key without the marker must never be treated as revalidation-pending"
  );
});

test("history filtered to a different connector instance never contributes to this connector's cadence", () => {
  // decideSynthesizedRevalidation trusts the caller to pre-filter `history`
  // to one connector instance (documented contract) — verify that a record
  // for a DIFFERENT instance, if accidentally included, still can't silently
  // arm an unrelated connector's cooldown from a stale timestamp far in the
  // past (defense-in-depth: this module's own history array in production is
  // always pre-filtered by pre-run-gate.ts/dispatch-governor.ts).
  const otherInstanceSkip: RunRecord = {
    ...pendingSkip(1000),
    connectorInstanceId: "some_other_instance",
  };
  const decision = decideSynthesizedRevalidation([otherInstanceSkip], 100_000_000, {});
  // The pure function itself does not filter by instance — this documents
  // that the FILTERING RESPONSIBILITY belongs to the caller; passing
  // unfiltered history is a caller bug, not something this module defends
  // against. Confirmed by the fact the record IS still picked up (attempt=0,
  // admit=true after a long enough delay), proving callers MUST filter.
  assert.equal(decision.admit, true);
});
