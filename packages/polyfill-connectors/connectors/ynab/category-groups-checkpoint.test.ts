// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import type { EmittedMessage } from "../../src/connector-runtime.ts";
import { type EmittedRecord, makeRecordingEmit } from "../../src/test-harness.ts";
import { type BudgetCtx, collectCategoriesAndGroups } from "./index.ts";
import { validateRecord } from "./schemas.ts";

// Regression proof for the stream-coverage evidence omission: a succeeded YNAB
// run emitted `category_groups` records but never staged a checkpoint for the
// stream, so `buildCollectionFacts` reported `checkpoint:not_staged` and the
// `full_inventory` coverage strategy could not prove coverage — the stream
// projected `unmeasured` despite retained records (live run_1783393253269).
//
// `category_groups` is co-fetched from `/categories` and advances on the same
// `server_knowledge` delta cursor as `categories`. The fix stages its own STATE
// checkpoint (gated on request scope) so a succeeded run commits the stream.
//
// The projection consequence — `checkpoint:committed` + `full_inventory` ->
// coverage `complete` instead of the pre-fix `unknown`/`unmeasured` — is proven
// against the real projection in
// reference-implementation/test/collection-report-projection.test.js.

// YNAB record schemas require UUID-v4 ids, so the fixture uses real UUIDs.
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
      {
        id: "33333333-3333-4333-8333-333333333333",
        name: "True Expenses",
        hidden: false,
        deleted: false,
        categories: [],
      },
    ],
  },
};

const BUDGET_ID = "44444444-4444-4444-8444-444444444444";

/** Mock `globalThis.fetch` for one `ynab()` GET returning the categories body. */
function stubFetch(body: unknown): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function makeCtx(requestedStreams: readonly string[]): {
  ctx: BudgetCtx;
  emitted: EmittedRecord[];
  messages: EmittedMessage[];
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
  return { ctx, emitted: harness.emitted, messages: harness.protocolMessages };
}

function stateMessagesFor(messages: EmittedMessage[], stream: string): Extract<EmittedMessage, { type: "STATE" }>[] {
  return messages.filter(
    (m): m is Extract<EmittedMessage, { type: "STATE" }> => m.type === "STATE" && m.stream === stream
  );
}

test("collectCategoriesAndGroups: succeeded run stages a category_groups checkpoint sharing the categories cursor", async () => {
  const restore = stubFetch(CATEGORIES_RESPONSE);
  try {
    const { ctx, emitted, messages } = makeCtx(["categories", "category_groups"]);
    await collectCategoriesAndGroups(ctx);

    // Records were emitted for both streams (fixture passes the zod shape-check).
    assert.ok(
      emitted.some((r) => r.stream === "category_groups"),
      "expected category_groups records to be emitted"
    );

    // The checkpoint is now staged — without it the runtime reports
    // `checkpoint:not_staged` and the stream projects unmeasured.
    const groupState = stateMessagesFor(messages, "category_groups");
    assert.equal(groupState.length, 1, "expected exactly one category_groups STATE checkpoint");
    assert.deepEqual(ctx.newState.category_groups, {
      [BUDGET_ID]: { server_knowledge: 4242 },
    });
    assert.deepEqual(groupState[0]?.cursor, ctx.newState.category_groups);

    // It shares the identical server_knowledge cursor as categories: both
    // streams come from the same `/categories` response, so the checkpoint is
    // the same delta boundary.
    const catState = stateMessagesFor(messages, "categories");
    assert.equal(catState.length, 1, "categories checkpoint still staged");
    assert.deepEqual((ctx.newState.categories as Record<string, { server_knowledge: number }>)[BUDGET_ID], {
      server_knowledge: 4242,
    });

    // The new emit is gated on request scope: `category_groups` is a manifest
    // stream, so when requested it is in the runtime START scope and the STATE
    // is valid. (An out-of-scope STATE would throw `STATE for undeclared
    // stream` in the runtime — see validateStateMessage.)
    assert.ok(ctx.requested.has("category_groups"));
  } finally {
    restore();
  }
});
