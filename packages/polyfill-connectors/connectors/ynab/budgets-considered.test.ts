/**
 * Steady-state `considered` + `covered` declaration on YNAB's fingerprint-
 * suppressed full-sync `budgets` stream (OpenSpec
 * `define-connector-progress-evidence-contract`, task 4.4).
 *
 * `/budgets` is a full-collection endpoint with no `server_knowledge` delta, so
 * the run re-enumerates the whole budget inventory every time and suppresses
 * unchanged budgets via the per-record fingerprint cursor. Before this change it
 * declared NO `considered` denominator, because the coverage gate compared
 * `considered` against the post-suppression emitted count (`collected`), so a
 * steady-state run (nothing changed → nothing emitted) would have read a FALSE
 * `partial`.
 *
 * The fix adds an objective `covered` count — the in-boundary budgets the run
 * accounted for: emitted PLUS suppressed-because-unchanged — measured at the
 * enumeration loop, never aliased to the emitted count. The gate compares
 * `considered` against `covered` when present, so a fresh / steady-state /
 * one-changed run all read complete-eligible (covered === considered).
 *
 * These tests drive the real `emitBudgetsStream` helper against the recording
 * emit harness and assert on the self-coverage DETAIL_COVERAGE it emits
 * (`stream === state_stream === "budgets"`). The projection half (covered-vs-
 * considered → complete/partial, and the dropped-row → partial guardrail) is
 * pinned in reference-implementation/test/collection-report-projection.test.js.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { CollectContext, EmittedMessage } from "../../src/connector-runtime.ts";
import { makeRecordingEmit } from "../../src/test-harness.ts";
import { type BudgetsStreamDeps, emitBudgetsStream } from "./index.ts";

type YnabBudget = BudgetsStreamDeps["budgets"][number];

function makeBudget(overrides: Partial<YnabBudget> = {}): YnabBudget {
  return {
    id: "budget-main",
    name: "My Budget",
    last_modified_on: "2026-06-01T00:00:00+00:00",
    first_month: "2024-01-01",
    last_month: "2026-06-01",
    date_format: { format: "MM/DD/YYYY" },
    currency_format: {
      iso_code: "USD",
      example_format: "123,456.78",
      decimal_digits: 2,
      decimal_separator: ".",
      symbol_first: true,
      group_separator: ",",
      currency_symbol: "$",
      display_symbol: true,
    },
    ...overrides,
  } as YnabBudget;
}

function makeHarness(): {
  emit: CollectContext["emit"];
  trackAndEmit: BudgetsStreamDeps["trackAndEmit"];
  emitted: Array<{ stream: string; data: unknown }>;
  messages: EmittedMessage[];
} {
  const harness = makeRecordingEmit();
  return {
    emit: harness.emit as CollectContext["emit"],
    trackAndEmit: harness.emitRecord,
    emitted: harness.emitted,
    messages: harness.protocolMessages,
  };
}

/** Re-shape the persisted budgets STATE into the `{ budgets: cursor }` shape the
 *  next run reads via `openBudgetCursor(state)`. */
function nextStateFrom(messages: EmittedMessage[]): Record<string, unknown> {
  const state = messages.filter((m) => m.type === "STATE" && m.stream === "budgets").at(-1);
  return { budgets: (state as { cursor?: unknown } | undefined)?.cursor ?? {} };
}

/** The single budgets self-coverage DETAIL_COVERAGE per run
 *  (stream === state_stream === "budgets"). Returns undefined when none. */
function budgetsSelfCoverage(messages: EmittedMessage[]): Record<string, unknown> | undefined {
  return messages.find((m) => m.type === "DETAIL_COVERAGE" && m.stream === "budgets" && m.state_stream === "budgets") as
    | Record<string, unknown>
    | undefined;
}

test("budgets considered: a fresh run declares considered === covered === enumerated, all emitted", async () => {
  const budgets = [makeBudget({ id: "B1" }), makeBudget({ id: "B2", name: "Side Budget" })];
  const h = makeHarness();
  await emitBudgetsStream({ budgets, state: {}, newState: {}, emit: h.emit, trackAndEmit: h.trackAndEmit });

  assert.equal(h.emitted.length, 2, "fresh run emits both budgets");
  const cov = budgetsSelfCoverage(h.messages);
  assert.ok(cov, "fresh run declares a budgets self-coverage message");
  assert.equal(cov?.considered, 2, "considered === enumerated boundary");
  assert.equal(cov?.covered, 2, "covered === considered (all emitted)");
  assert.deepEqual(cov?.required_keys, [], "list stream: no detail-hydration required keys");
  assert.deepEqual(cov?.hydrated_keys, [], "list stream: no detail-hydration hydrated keys");
});

test("budgets considered: a steady-state run declares covered === considered while collected is 0", async () => {
  const budgets = [makeBudget({ id: "B1" }), makeBudget({ id: "B2", name: "Side Budget" })];

  const run1 = makeHarness();
  const state1: Record<string, unknown> = {};
  await emitBudgetsStream({ budgets, state: {}, newState: state1, emit: run1.emit, trackAndEmit: run1.trackAndEmit });

  // Second run: same budgets, with the calendar/clock fields rolled forward
  // (both excluded from the fingerprint) → every budget suppressed, collected 0.
  // covered must still equal the enumerated boundary so the projection reads
  // complete, not a false partial.
  const priorState = nextStateFrom(run1.messages);
  const run2 = makeHarness();
  const rolled = budgets.map((b) =>
    makeBudget({ ...b, last_month: "2026-07-01", last_modified_on: "2026-07-01T00:00:00+00:00" })
  );
  await emitBudgetsStream({
    budgets: rolled,
    state: priorState,
    newState: {},
    emit: run2.emit,
    trackAndEmit: run2.trackAndEmit,
  });

  assert.equal(run2.emitted.length, 0, "steady-state run emits nothing (all suppressed)");
  const cov = budgetsSelfCoverage(run2.messages);
  assert.ok(cov, "steady-state run still declares budgets self-coverage");
  assert.equal(cov?.considered, 2, "considered === enumerated boundary");
  assert.equal(cov?.covered, 2, "covered counts suppressed-unchanged, NOT aliased to collected (0)");
});

test("budgets considered: a one-changed run keeps covered === considered", async () => {
  const run1 = makeHarness();
  await emitBudgetsStream({
    budgets: [makeBudget({ id: "B1", name: "Old Name" }), makeBudget({ id: "B2" })],
    state: {},
    newState: {},
    emit: run1.emit,
    trackAndEmit: run1.trackAndEmit,
  });

  // Second run: B1 renamed (a real summary-field change → re-emits), B2 unchanged
  // (suppressed). collected 1, but both covered → covered === considered === 2.
  const priorState = nextStateFrom(run1.messages);
  const run2 = makeHarness();
  await emitBudgetsStream({
    budgets: [makeBudget({ id: "B1", name: "Renamed Budget" }), makeBudget({ id: "B2" })],
    state: priorState,
    newState: {},
    emit: run2.emit,
    trackAndEmit: run2.trackAndEmit,
  });

  assert.equal(run2.emitted.length, 1, "only the renamed budget re-emits");
  const cov = budgetsSelfCoverage(run2.messages);
  assert.ok(cov, "one-changed run declares budgets self-coverage");
  assert.equal(cov?.considered, 2, "considered === enumerated boundary");
  assert.equal(cov?.covered, 2, "covered (1 emitted + 1 suppressed) === considered, not the collected count of 1");
});

test("budgets considered: covered tracks the enumerated boundary, not the emitted count", async () => {
  // A single-budget steady-state run: collected 0, but the run still considered
  // and covered the one budget it re-enumerated. Pins that covered is measured at
  // the loop, never aliased to the (zero) emit count.
  const budget = makeBudget({ id: "SOLO" });

  const run1 = makeHarness();
  await emitBudgetsStream({
    budgets: [budget],
    state: {},
    newState: {},
    emit: run1.emit,
    trackAndEmit: run1.trackAndEmit,
  });

  const priorState = nextStateFrom(run1.messages);
  const run2 = makeHarness();
  await emitBudgetsStream({
    budgets: [budget],
    state: priorState,
    newState: {},
    emit: run2.emit,
    trackAndEmit: run2.trackAndEmit,
  });

  assert.equal(run2.emitted.length, 0, "unchanged sole budget suppressed → collected 0");
  const cov = budgetsSelfCoverage(run2.messages);
  assert.equal(cov?.considered, 1, "considered === 1 (one budget enumerated)");
  assert.equal(cov?.covered, 1, "covered === 1 (suppressed-unchanged), not the collected count of 0");
});
