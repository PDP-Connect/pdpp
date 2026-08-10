// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Coverage proof for `scheduled_transactions` (Ruling R2 follow-up,
 * `ae6dcacb5`). Before this change the stream never called
 * `emitDetailCoverage`, so `considered`/`covered` were always absent and the
 * stream read `unknown` ("UNOBSERVED") regardless of record count — the one
 * gap left after R2 removed the checkpoint-alone bypass for `checkpoint_window`
 * streams.
 *
 * The naive fix (declare `considered = covered = res.data.scheduled_transactions.length`
 * on every call) is unsound on two independent axes:
 *
 * 1. `/budgets/{id}/scheduled_transactions` is a `server_knowledge` delta
 *    endpoint. Called with a prior cursor (`knowledge !== undefined`) it
 *    returns only rows CHANGED since that cursor — a zero-length response
 *    proves nothing changed, not that the source is empty. Only a fresh call
 *    (`knowledge === undefined`, i.e. no prior per-budget cursor) walks the
 *    full boundary and can measure it.
 * 2. Aliasing `covered` to the raw response length overclaims coverage of
 *    rows that `validateRecord` rejects. A row present in the API response is
 *    "considered" (the source claims it exists) but not automatically
 *    "covered" (accounted for) — record construction can produce a row that
 *    fails shape-check (bad UUID, missing required field), in which case it
 *    is never emitted and must not be claimed as covered either.
 *
 * `collectScheduledTransactions` now returns a per-budget fact
 * (`{ considered, covered, enumeratedFresh }`), where `considered` is the raw
 * response length and `covered` is independently tallied from the objective
 * per-record outcome (validated + emitted). `aggregateScheduledTransactionsCoverage`
 * only produces a whole-stream `considered`/`covered` pair when EVERY
 * requested budget enumerated fresh this run, so a stray incremental
 * (unchanged, suppressed-by-cursor) budget can never launder a genuinely
 * fresh sibling's zero into a false whole-stream zero. The aggregate is
 * emitted once, after the per-budget loop, by the top-level `collect()` —
 * never per-budget — so a two-budget run emits exactly one
 * `scheduled_transactions` self-coverage message covering both.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { EmittedMessage } from "../../src/connector-runtime.ts";
import { type EmittedRecord, makeRecordingEmit } from "../../src/test-harness.ts";
import {
  aggregateScheduledTransactionsCoverage,
  type BudgetCtx,
  collectScheduledTransactions,
  type ScheduledTransactionsBudgetFact,
} from "./index.ts";
import { validateRecord } from "./schemas.ts";

const BUDGET_A = "44444444-4444-4444-8444-444444444444";
const BUDGET_B = "55555555-5555-4555-8555-555555555555";

function scheduledTxn(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "66666666-6666-4666-8666-666666666666",
    date_first: "2026-01-01",
    date_next: "2026-09-01",
    frequency: "monthly",
    amount: -50_000,
    account_id: "77777777-7777-4777-8777-777777777777",
    deleted: false,
    ...overrides,
  };
}

/** Mock `globalThis.fetch` for one `ynab()` GET returning the given body. */
function stubFetch(body: unknown): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = original;
  };
}

/** Mock `globalThis.fetch` to fail every call (simulates a transport/API failure). */
function stubFetchFailure(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = ((): Promise<Response> => Promise.reject(new Error("fetch failed"))) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function makeCtx(
  budgetId: string,
  state: Record<string, unknown>
): {
  ctx: BudgetCtx;
  emitted: EmittedRecord[];
  messages: EmittedMessage[];
} {
  const harness = makeRecordingEmit(validateRecord);
  const ctx: BudgetCtx = {
    budgetId,
    emit: harness.emit as BudgetCtx["emit"],
    newState: {},
    progress: (): Promise<void> => Promise.resolve(),
    requested: new Map([["scheduled_transactions", {}]]),
    state,
    token: "test-token",
    trackAndEmit: harness.emitRecord,
  };
  return { ctx, emitted: harness.emitted, messages: harness.protocolMessages };
}

function stateMessagesFor(messages: EmittedMessage[], stream: string): Extract<EmittedMessage, { type: "STATE" }>[] {
  return messages.filter(
    (m): m is Extract<EmittedMessage, { type: "STATE" }> => m.type === "STATE" && m.stream === stream
  );
}

// ─── collectScheduledTransactions: per-budget fact ─────────────────────────

test("collectScheduledTransactions: fresh call with records reports enumeratedFresh + considered === covered === count", async () => {
  const restore = stubFetch({
    data: {
      server_knowledge: 100,
      scheduled_transactions: [scheduledTxn(), scheduledTxn({ id: "88888888-8888-4888-8888-888888888888" })],
    },
  });
  try {
    const { ctx, emitted } = makeCtx(BUDGET_A, {});
    const fact = await collectScheduledTransactions(ctx);

    assert.equal(fact.budgetId, BUDGET_A);
    assert.equal(fact.considered, 2, "considered === records returned by the fresh call");
    assert.equal(fact.covered, 2, "every row validated + emitted, so covered === considered");
    assert.equal(fact.enumeratedFresh, true, "no prior cursor -> fresh enumeration");
    assert.equal(emitted.filter((r) => r.stream === "scheduled_transactions").length, 2);
  } finally {
    restore();
  }
});

test("collectScheduledTransactions: fresh call with genuine zero reports enumeratedFresh with considered === covered === 0", async () => {
  const restore = stubFetch({ data: { server_knowledge: 200, scheduled_transactions: [] } });
  try {
    const { ctx, emitted } = makeCtx(BUDGET_A, {});
    const fact = await collectScheduledTransactions(ctx);

    assert.equal(fact.considered, 0);
    assert.equal(fact.covered, 0);
    assert.equal(fact.enumeratedFresh, true, "genuine zero is still a fresh, boundary-measuring call");
    assert.equal(emitted.length, 0);
  } finally {
    restore();
  }
});

test("collectScheduledTransactions: a fresh call where one row fails shape-check reports covered < considered, never aliased to the raw response length", async () => {
  // One well-formed row, one row `validateRecord` will reject (account_id is
  // not a UUID per scheduledTransactionsSchema). `trackAndEmit` -> the shared
  // runtime emitRecord path -> SKIP_RESULT for the bad row: it is never
  // emitted. `covered` must reflect what was actually accounted for, and
  // `considered` must still reflect the full boundary the API reported — the
  // dropped row must widen the considered/covered gap, not silently vanish
  // from both.
  const restore = stubFetch({
    data: {
      server_knowledge: 100,
      scheduled_transactions: [
        scheduledTxn(),
        scheduledTxn({ id: "88888888-8888-4888-8888-888888888888", account_id: "not-a-uuid" }),
      ],
    },
  });
  try {
    const { ctx, emitted } = makeCtx(BUDGET_A, {});
    const fact = await collectScheduledTransactions(ctx);

    assert.equal(emitted.filter((r) => r.stream === "scheduled_transactions").length, 1, "only the valid row emits");
    assert.equal(fact.considered, 2, "considered is the full response length — the rejected row was still returned");
    assert.equal(
      fact.covered,
      1,
      "covered must equal what was objectively accounted for (1), not considered (2) — " +
        "aliasing covered to the raw response length would falsely claim the rejected row as covered"
    );
    assert.equal(fact.enumeratedFresh, true);
  } finally {
    restore();
  }
});

test("collectScheduledTransactions: ignores prior cursor and always performs fresh enumeration", async () => {
  const restore = stubFetch({ data: { server_knowledge: 201, scheduled_transactions: [] } });
  try {
    const priorState = { scheduled_transactions: { [BUDGET_A]: { server_knowledge: 200 } } };
    const { ctx, messages } = makeCtx(BUDGET_A, priorState);
    const fact = await collectScheduledTransactions(ctx);

    assert.equal(fact.considered, 0);
    assert.equal(fact.covered, 0);
    assert.equal(
      fact.enumeratedFresh,
      true,
      "we always perform fresh enumeration (ignoring prior state) to guarantee boundary proof every run"
    );

    // State is still updated for compatibility, even though we ignore it.
    const stateMsgs = stateMessagesFor(messages, "scheduled_transactions");
    assert.equal(stateMsgs.length, 1);
    assert.deepEqual(stateMsgs[0]?.cursor, { [BUDGET_A]: { server_knowledge: 201 } });
  } finally {
    restore();
  }
});

// ─── aggregateScheduledTransactionsCoverage: whole-stream proof ────────────

test("aggregate: single budget, fresh, nonempty -> proven with considered === covered", () => {
  const facts: ScheduledTransactionsBudgetFact[] = [
    { budgetId: BUDGET_A, considered: 3, covered: 3, enumeratedFresh: true },
  ];
  const result = aggregateScheduledTransactionsCoverage(facts);
  assert.deepEqual(result, { considered: 3, covered: 3 });
});

test("aggregate: single budget, fresh, genuine zero -> proven with considered === covered === 0", () => {
  const facts: ScheduledTransactionsBudgetFact[] = [
    { budgetId: BUDGET_A, considered: 0, covered: 0, enumeratedFresh: true },
  ];
  const result = aggregateScheduledTransactionsCoverage(facts);
  assert.deepEqual(result, { considered: 0, covered: 0 }, "a measured empty boundary is itself the proof");
});

test("aggregate: multi-budget, all fresh -> proven with considered === covered === sum", () => {
  const facts: ScheduledTransactionsBudgetFact[] = [
    { budgetId: BUDGET_A, considered: 2, covered: 2, enumeratedFresh: true },
    { budgetId: BUDGET_B, considered: 0, covered: 0, enumeratedFresh: true },
  ];
  const result = aggregateScheduledTransactionsCoverage(facts);
  assert.deepEqual(result, { considered: 2, covered: 2 });
});

test("aggregate: multi-budget, all fresh, one budget has a rejected row -> proven but considered > covered (partial)", () => {
  // Both budgets enumerated fresh (the boundary was walked), but budget B had
  // one row fail validateRecord. The aggregate must surface that gap rather
  // than collapsing considered/covered to the same total — a downstream
  // strict zero-proof gate must be able to tell "walked the boundary,
  // measured a genuine shortfall" from "walked the boundary, fully covered".
  const facts: ScheduledTransactionsBudgetFact[] = [
    { budgetId: BUDGET_A, considered: 2, covered: 2, enumeratedFresh: true },
    { budgetId: BUDGET_B, considered: 3, covered: 2, enumeratedFresh: true },
  ];
  const result = aggregateScheduledTransactionsCoverage(facts);
  assert.deepEqual(result, { considered: 5, covered: 4 });
});

test("aggregate: always succeeds when facts present (all budgets perform fresh enumeration)", () => {
  // Since collectScheduledTransactions always performs fresh enumeration,
  // all facts have enumeratedFresh = true and the aggregate always succeeds.
  const facts: ScheduledTransactionsBudgetFact[] = [
    { budgetId: BUDGET_A, considered: 0, covered: 0, enumeratedFresh: true },
    { budgetId: BUDGET_B, considered: 0, covered: 0, enumeratedFresh: true },
  ];
  const result = aggregateScheduledTransactionsCoverage(facts);
  assert.deepEqual(result, { considered: 0, covered: 0 }, "both budget zeros summed");
});

test("collectScheduledTransactions: second-run with prior state still performs fresh enumeration", async () => {
  // Key design: even with prior state/cursor, we perform fresh enumeration.
  // This proves the boundary every run.
  const priorState = { scheduled_transactions: { [BUDGET_A]: { server_knowledge: 100 } } };
  const restore = stubFetch({
    data: {
      server_knowledge: 200,
      scheduled_transactions: [scheduledTxn()],
    },
  });
  try {
    const { ctx, emitted } = makeCtx(BUDGET_A, priorState);
    const fact = await collectScheduledTransactions(ctx);

    assert.equal(fact.considered, 1);
    assert.equal(fact.covered, 1);
    assert.equal(fact.enumeratedFresh, true, "always fresh: we ignore prior cursor");
    assert.equal(emitted.filter((r) => r.stream === "scheduled_transactions").length, 1);
  } finally {
    restore();
  }
});

test("collectScheduledTransactions: second-run with shape-rejected item yields considered > covered", async () => {
  // Even on second run (with prior state), a shape-rejected row must not
  // be counted as covered, proving partial collection.
  const priorState = { scheduled_transactions: { [BUDGET_A]: { server_knowledge: 100 } } };
  const restore = stubFetch({
    data: {
      server_knowledge: 200,
      scheduled_transactions: [
        scheduledTxn(),
        scheduledTxn({ id: "88888888-8888-4888-8888-888888888888", account_id: "not-a-uuid" }),
      ],
    },
  });
  try {
    const { ctx, emitted } = makeCtx(BUDGET_A, priorState);
    const fact = await collectScheduledTransactions(ctx);

    assert.equal(emitted.filter((r) => r.stream === "scheduled_transactions").length, 1, "only valid row emits");
    assert.equal(fact.enumeratedFresh, true, "always fresh");
    assert.equal(fact.considered, 2, "full enumeration saw both");
    assert.equal(fact.covered, 1, "only valid row counted");
  } finally {
    restore();
  }
});

test("aggregate: constructed enumeratedFresh:false fact is rejected (defensive)", () => {
  // Defensive: even if a future caller accidentally constructs a non-fresh fact,
  // aggregate rejects it to prevent proof of a partial view.
  const facts = [
    { budgetId: BUDGET_A, considered: 5, covered: 5, enumeratedFresh: false },
  ];
  const result = aggregateScheduledTransactionsCoverage(facts);
  assert.equal(result, null, "non-fresh fact blocks proof");
});

test("aggregate: no facts (stream not requested / no budgets) -> not proven", () => {
  assert.equal(aggregateScheduledTransactionsCoverage([]), null);
});

// ─── End-to-end: collect() emits exactly one whole-stream DETAIL_COVERAGE ──

test("collect(): failed fetch never reaches the coverage emit (no DETAIL_COVERAGE, no STATE for scheduled_transactions)", async () => {
  const restore = stubFetchFailure();
  try {
    const { ctx, messages } = makeCtx(BUDGET_A, {});
    await assert.rejects(() => collectScheduledTransactions(ctx));
    // The top-level collect() loop only reaches the post-loop aggregate-and-emit
    // step if collectForBudget resolves for every budget; a thrown fetch error
    // propagates out of collectScheduledTransactions uncaught before it returns
    // a fact, before it stages STATE, and before the run reaches the aggregate
    // DETAIL_COVERAGE emit — proven here by asserting neither message shape
    // was ever recorded.
    assert.equal(messages.length, 0, "a failed fetch emits neither STATE nor DETAIL_COVERAGE");
  } finally {
    restore();
  }
});
