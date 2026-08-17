// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import type { EmittedMessage } from "../../src/connector-runtime.ts";
import { type EmittedRecord, makeRecordingEmit } from "../../src/test-harness.ts";
import { type BudgetCtx, collectMonthCategories, monthCategoryRecord, rewindOneMonth } from "./index.ts";

type MonthCategoryInput = Parameters<typeof monthCategoryRecord>[0];

function monthCategoryFixture(overrides: Partial<MonthCategoryInput> = {}): MonthCategoryInput {
  return {
    activity: -42_000,
    balance: 18_000,
    budgeted: 60_000,
    category_group_id: "group-giving",
    category_group_name: "Giving",
    deleted: false,
    goal_percentage_complete: 60,
    goal_target: 100_000,
    goal_type: "TB",
    hidden: false,
    id: "cat-gifts",
    name: "Gifts",
    note: "annual giving target",
    ...overrides,
  };
}

function makeCtx(overrides: Partial<BudgetCtx> = {}): {
  ctx: BudgetCtx;
  emitted: EmittedRecord[];
  messages: EmittedMessage[];
} {
  const harness = makeRecordingEmit();
  const ctx: BudgetCtx = {
    budgetId: "budget-main",
    emit: harness.emit as BudgetCtx["emit"],
    newState: {},
    progress: (): Promise<void> => Promise.resolve(),
    request: () => Promise.reject(new Error("not used")),
    requested: new Map([["month_categories", {}]]),
    state: {},
    token: "test-token",
    trackAndEmit: harness.emitRecord,
    ...overrides,
  };
  return { ctx, emitted: harness.emitted, messages: harness.protocolMessages };
}

test("monthCategoryRecord: uses stable budget/month/category primary key", () => {
  const record = monthCategoryRecord(monthCategoryFixture(), "2026-03-01", "budget-main");
  assert.equal(record.id, "budget-main:2026-03-01:cat-gifts");
  assert.equal(record.budget_id, "budget-main");
  assert.equal(record.month, "2026-03-01");
  assert.equal(record.category_id, "cat-gifts");
  assert.equal(record.category_name, "Gifts");
  assert.equal(record.goal_percentage_complete, 60);
});

test("rewindOneMonth: stores cutoff one month behind the highest fetched month", () => {
  assert.equal(rewindOneMonth("2026-03-01"), "2026-02-01");
  assert.equal(rewindOneMonth("2026-01-01"), "2025-12-01");
});

test("collectMonthCategories: applies range/cutoff gates, emits records, and stores rewound cursor", async () => {
  const { ctx, emitted, messages } = makeCtx({
    state: {
      month_categories: {
        "budget-main": { last_fetched_month: "2026-02-01" },
      },
    },
  });

  const fetchedMonths: string[] = [];
  await collectMonthCategories(
    ctx,
    [
      { activity: 0, budgeted: 0, deleted: false, income: 0, month: "2026-01-01", to_be_budgeted: 0 },
      { activity: 0, budgeted: 0, deleted: false, income: 0, month: "2026-02-01", to_be_budgeted: 0 },
      { activity: 0, budgeted: 0, deleted: true, income: 0, month: "2026-03-01", to_be_budgeted: 0 },
      { activity: 0, budgeted: 0, deleted: false, income: 0, month: "2026-04-01", to_be_budgeted: 0 },
    ],
    { time_range: { since: "2026-02-01", until: "2026-05-01" } },
    (_budgetId, month) => {
      fetchedMonths.push(month);
      return Promise.resolve({
        activity: 0,
        budgeted: 0,
        categories: [monthCategoryFixture({ id: `cat-${month}`, name: `Category ${month}` })],
        deleted: false,
        income: 0,
        month,
        to_be_budgeted: 0,
      });
    }
  );

  assert.deepEqual(fetchedMonths, ["2026-02-01", "2026-04-01"]);
  assert.deepEqual(
    emitted.map((record) => record.data.id),
    ["budget-main:2026-02-01:cat-2026-02-01", "budget-main:2026-04-01:cat-2026-04-01"]
  );
  assert.deepEqual(ctx.newState.month_categories, {
    "budget-main": { last_fetched_month: "2026-03-01" },
  });

  const stateMessage = messages.find(
    (message): message is Extract<EmittedMessage, { type: "STATE" }> =>
      message.type === "STATE" && message.stream === "month_categories"
  );
  assert.ok(stateMessage, "month_categories state cursor should be emitted");
  assert.deepEqual(stateMessage.cursor, ctx.newState.month_categories);
});

test("collectMonthCategories: empty-delta reconciliation keeps a 24-month detail walk bounded by lastFetchedMonth", async () => {
  const { ctx } = makeCtx({
    state: {
      month_categories: {
        "budget-main": { last_fetched_month: "2026-12-01" },
      },
    },
  });
  const months = Array.from({ length: 24 }, (_, index) => {
    const month = String(index + 1).padStart(2, "0");
    return { activity: 0, budgeted: 0, deleted: false, income: 0, month: `2026-${month}-01`, to_be_budgeted: 0 };
  });
  let reconciledDetailCalls = 0;
  const reconciliationFact = await collectMonthCategories(
    ctx,
    months,
    {},
    () => {
      reconciledDetailCalls += 1;
      return Promise.resolve({
        activity: 0,
        budgeted: 0,
        categories: [],
        deleted: false,
        income: 0,
        month: "2026-12-01",
        to_be_budgeted: 0,
      });
    },
    false
  );

  assert.equal(reconciledDetailCalls, 13, "reconciliation walks only December and the rewound current window");
  assert.deepEqual(reconciliationFact, { considered: 0, covered: 0, enumeratedFresh: false });
});

test("collectMonthCategories: a true first full run still walks all 24 historical months", async () => {
  const { ctx } = makeCtx();
  const months = Array.from({ length: 24 }, (_, index) => {
    const month = String(index + 1).padStart(2, "0");
    return { activity: 0, budgeted: 0, deleted: false, income: 0, month: `2026-${month}-01`, to_be_budgeted: 0 };
  });
  let firstRunDetailCalls = 0;
  await collectMonthCategories(
    ctx,
    months,
    {},
    () => {
      firstRunDetailCalls += 1;
      return Promise.resolve({
        activity: 0,
        budgeted: 0,
        categories: [],
        deleted: false,
        income: 0,
        month: "2026-01-01",
        to_be_budgeted: 0,
      });
    },
    true
  );
  assert.equal(firstRunDetailCalls, 24);
});

test("collectMonthCategories: omitted nested categories fail before advancing the month checkpoint", async () => {
  const { ctx, messages } = makeCtx();
  const malformedMonth: Parameters<typeof collectMonthCategories>[1][number] = {
    activity: 0,
    budgeted: 0,
    deleted: false,
    income: 0,
    month: "2026-04-01",
    to_be_budgeted: 0,
  };

  await assert.rejects(
    () => collectMonthCategories(ctx, [malformedMonth], {}, () => Promise.resolve(malformedMonth)),
    /ynab_response_malformed/
  );
  assert.equal(
    messages.some((message) => message.type === "STATE" && message.stream === "month_categories"),
    false,
    "a malformed month envelope must not advance last_fetched_month"
  );
  assert.equal(
    messages.some((message) => message.type === "DETAIL_COVERAGE" && message.stream === "month_categories"),
    false,
    "a malformed month envelope must not prove a zero category boundary"
  );
});

test("collectMonthCategories: progress omits budget ids and month values", async () => {
  const progressEvents: Array<{ message: string; extra?: Record<string, unknown> }> = [];
  const { ctx } = makeCtx({
    budgetId: "budget-main",
    budgetOrdinal: 7,
    progress: (message, extra) => {
      progressEvents.push(extra === undefined ? { message } : { message, extra });
      return Promise.resolve();
    },
  });

  await collectMonthCategories(
    ctx,
    [{ activity: 0, budgeted: 0, deleted: false, income: 0, month: "2026-04-01", to_be_budgeted: 0 }],
    {},
    (_budgetId, month) =>
      Promise.resolve({
        activity: 0,
        budgeted: 0,
        categories: [monthCategoryFixture({ id: `cat-${month}`, name: `Category ${month}` })],
        deleted: false,
        income: 0,
        month,
        to_be_budgeted: 0,
      })
  );

  const serialized = JSON.stringify(progressEvents);
  assert.equal(serialized.includes("budget-main"), false, "budget id must not appear in progress");
  assert.equal(serialized.includes("2026-04-01"), false, "month value must not appear in progress");
  assert.equal(
    progressEvents.some((event) => event.extra?.offset_ordinal === 7),
    true
  );
  assert.equal(
    progressEvents.some((event) => event.extra?.cursor_present === true),
    true
  );
});
