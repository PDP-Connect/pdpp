// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { type EmittedRecord, makeRecordingEmit } from "../../src/test-harness.ts";
import { type BudgetCtx, collectCategoriesAndGroups } from "./index.ts";
import { validateRecord } from "./schemas.ts";

// Regression proof for live run_1786288330250, whose terminal row read
//   {"code":null,"message":"HTTP request failed after retry budget was exhausted",
//    "retryable":false}
// with no status, no endpoint, and no provider message. The run reached YNAB
// successfully for /budgets and /budgets/{id}/accounts (8 records ingested) and
// then failed on the very next call, /budgets/{id}/categories — but the terminal
// error named none of that, so the owner could not tell an expired token from a
// reset socket from a YNAB outage, and the container log carried nothing either.
//
// Two independent discards produced that string, and both are covered here:
//   1. `retryHttp` wrapped the thrown `TypeError: fetch failed` in a message
//      that dropped its `.cause` (the real ECONNRESET/ENOTFOUND/timeout). It
//      survived only on `RetryExhaustedError.originalCause`, which nothing
//      downstream reads. Fixed in src/http-retry.ts.
//   2. The `ynab()` helper never said WHICH endpoint failed. Fixed here.
//
// The retryable bit is the second-order consequence, not a cosmetic detail: the
// runtime classifies retryability by testing the connector's `retryablePattern`
// against the terminal MESSAGE. The pattern already listed `fetch failed` and
// `ECONN`, so dropping the cause made a transient blip unclassifiable and the
// run terminaled as permanently failed.

const BUDGET_ID = "44444444-4444-4444-8444-444444444444";

const CATEGORIES_RESPONSE = {
  data: {
    server_knowledge: 4242,
    category_groups: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        name: "Immediate Obligations",
        hidden: false,
        deleted: false,
        categories: [
          {
            id: "22222222-2222-4222-8222-222222222222",
            name: "Rent",
            hidden: false,
            budgeted: 100_000,
            activity: -100_000,
            balance: 0,
            deleted: false,
          },
        ],
      },
    ],
  },
};

/** Replace `globalThis.fetch` for the duration of one `ynab()` GET. */
function stubFetch(handler: () => Promise<Response>): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = handler as unknown as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function makeCtx(requestedStreams: readonly string[]): {
  ctx: BudgetCtx;
  emitted: EmittedRecord[];
} {
  const harness = makeRecordingEmit(validateRecord);
  const ctx: BudgetCtx = {
    budgetId: BUDGET_ID,
    emit: harness.emit as BudgetCtx["emit"],
    newState: {},
    progress: (): Promise<void> => Promise.resolve(),
    requested: new Map(requestedStreams.map((name) => [name, {}])),
    state: {},
    token: "test-token",
    trackAndEmit: harness.emitRecord,
  };
  return { ctx, emitted: harness.emitted };
}

/** The runtime's classifier: retryability is decided by testing this pattern
 *  against the terminal message (connector-runtime.ts `run().catch`). Kept
 *  byte-identical to the connector's declaration so the tests below assert the
 *  real classification, not a restatement of the fix. */
const YNAB_RETRYABLE_PATTERN = /rate_limited|ECONN|ETIMEDOUT|fetch failed|retryable status \d+/i;

// (a) A non-2xx upstream response produces a terminal error carrying its status
//     and the endpoint that returned it.
test("a non-2xx YNAB response terminals with its status and the failing endpoint", async () => {
  const restore = stubFetch(() =>
    Promise.resolve(
      new Response(JSON.stringify({ error: { id: "403.1", name: "subscription_lapsed", detail: "Trial expired" } }), {
        status: 403,
      })
    )
  );
  try {
    const { ctx } = makeCtx(["categories", "category_groups"]);
    await assert.rejects(collectCategoriesAndGroups(ctx), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /403/, "the HTTP status must reach the owner");
      assert.match(
        err.message,
        /\/budgets\/\{budget_id\}\/categories/,
        "the failing endpoint must reach the owner — which endpoint failed is the diagnostic"
      );
      assert.match(err.message, /subscription_lapsed/, "YNAB's own message must survive when it sends one");
      // The endpoint label is templated, never the live path: a terminal
      // `message` is operator-facing and must carry no account content.
      assert.doesNotMatch(err.message, new RegExp(BUDGET_ID), "the budget id must not leak into the message");
      assert.doesNotMatch(err.message, /test-token/, "the credential must never appear in a terminal error");
      return true;
    });
  } finally {
    restore();
  }
});

// (a′) The same requirement for a THROWN transport fault, which is what the live
//      run actually hit — there was no HTTP response at all to read a status off.
test("a thrown transport fault terminals with its cause and the failing endpoint", async () => {
  const boom = new TypeError("fetch failed");
  boom.cause = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
  const restore = stubFetch(() => Promise.reject(boom));
  try {
    const { ctx } = makeCtx(["categories", "category_groups"]);
    await assert.rejects(collectCategoriesAndGroups(ctx), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /ECONNRESET/, "the real transport fault must reach the owner");
      assert.match(err.message, /\/budgets\/\{budget_id\}\/categories/, "the failing endpoint must reach the owner");
      assert.doesNotMatch(err.message, new RegExp(BUDGET_ID));
      assert.doesNotMatch(err.message, /test-token/);
      // The live row's `retryable:false` was wrong: a reset socket is transient.
      assert.equal(
        YNAB_RETRYABLE_PATTERN.test(err.message),
        true,
        "a transport fault must classify retryable — this is what the live run got wrong"
      );
      return true;
    });
  } finally {
    restore();
  }
});

// (b) A 429 is classified retryable, not retryable:false.
test("a 429 classifies retryable and keeps YNAB's cross-run rate-limit contract", async () => {
  const restore = stubFetch(() =>
    Promise.resolve(new Response(JSON.stringify({ error: { id: "429" } }), { status: 429 }))
  );
  try {
    const { ctx } = makeCtx(["categories", "category_groups"]);
    await assert.rejects(collectCategoriesAndGroups(ctx), (err: unknown) => {
      assert.ok(err instanceof Error);
      // The governor raises the connector's own `ynab_rate_limited`, which the
      // runtime's cross-run source-pressure deferral keys on. That message is
      // the whole contract, so the endpoint suffix must NOT be appended to it —
      // this asserts the fix left that path byte-identical.
      assert.equal(err.message, "ynab_rate_limited", "the cross-run rate-limit contract message is unchanged");
      assert.equal(YNAB_RETRYABLE_PATTERN.test(err.message), true, "a 429 must classify retryable");
      return true;
    });
  } finally {
    restore();
  }
});

// (b′) An exhausted retryable 5xx must also classify retryable. Before the
//      pattern change this reported `retryable:false` — a YNAB outage would
//      terminal the connection as permanently failed and ask the owner to
//      reconnect a credential that was never the problem.
test("an exhausted retryable 5xx classifies retryable, not permanently failed", async () => {
  const restore = stubFetch(() => Promise.resolve(new Response("upstream boom", { status: 503 })));
  try {
    const { ctx } = makeCtx(["categories", "category_groups"]);
    await assert.rejects(collectCategoriesAndGroups(ctx), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /503/, "the status must reach the owner");
      assert.match(err.message, /\/budgets\/\{budget_id\}\/categories/);
      assert.equal(YNAB_RETRYABLE_PATTERN.test(err.message), true, "a 5xx outage must classify retryable");
      return true;
    });
  } finally {
    restore();
  }
});

// (c) COUNTERWEIGHT — a successful run still completes and emits its records
//     unchanged. The error-path work must not have altered the happy path.
test("COUNTERWEIGHT: a successful run still emits its records and advances its cursor unchanged", async () => {
  const restore = stubFetch(() => Promise.resolve(new Response(JSON.stringify(CATEGORIES_RESPONSE), { status: 200 })));
  try {
    const { ctx, emitted } = makeCtx(["categories", "category_groups"]);
    await collectCategoriesAndGroups(ctx);

    assert.deepEqual(
      emitted.filter((r) => r.stream === "category_groups").map((r) => r.data.id),
      ["11111111-1111-4111-8111-111111111111"],
      "category_groups records emit unchanged"
    );
    assert.deepEqual(
      emitted.filter((r) => r.stream === "categories").map((r) => r.data.id),
      ["22222222-2222-4222-8222-222222222222"],
      "categories records emit unchanged"
    );
    assert.deepEqual(ctx.newState.categories, { [BUDGET_ID]: { server_knowledge: 4242 } });
    assert.deepEqual(ctx.newState.category_groups, { [BUDGET_ID]: { server_knowledge: 4242 } });
  } finally {
    restore();
  }
});
