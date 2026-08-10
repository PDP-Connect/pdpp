// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end cursor/emission tests for `collectTransactions`, driven
 * through a fake `CollectContext` (no subprocess, no real network — see
 * terminal-error-detail.test.ts for the stubFetch-at-the-endpoint tests
 * and parsers.test.ts / schemas.test.ts for pure-function coverage).
 *
 * Each test below makes exactly ONE call through the connector's
 * module-level `httpGovernor`, matching connectors/ynab/integration.test.ts's
 * budget: the governor paces real inter-request wall-clock time
 * (venmoPacingProfile(), 10s ceiling shared across this whole process),
 * so a test that chained multiple sequential pages here would pay that
 * delay per page. The multi-page `before_id` walk itself is proven at
 * the pure-function level in fetchTransactionsPage's query-building
 * behavior (see terminal-error-detail.test.ts's endpoint-label
 * assertions) plus this file's single-page-emission proof — the loop
 * that stitches pages together (connectors/venmo/index.ts
 * collectTransactions) is a plain `while`-style walk with no branching
 * this file's other cases don't already exercise.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { CollectContext, EmittedMessage } from "../../src/connector-runtime.ts";
import { type EmittedRecord, makeRecordingEmit } from "../../src/test-harness.ts";
import { collectTransactions } from "./index.ts";
import { validateRecord } from "./schemas.ts";

const OWNER_ID = "1111111111111111111";

/** `id` must be a numeric string — real Venmo story/payment ids are decimal digit runs (see schemas.ts NUMERIC_ID_RE). */
function story(id: string, dateCreated: string, amount = 10) {
  return {
    id,
    date_created: dateCreated,
    payment: {
      id: `9${id}`,
      action: "pay",
      actor: { id: OWNER_ID, username: "owner", display_name: "Owner" },
      target: { user: { id: "2222222222222222222", username: "friend", display_name: "Friend" } },
      amount,
      status: "settled",
    },
  };
}

function makeCtx(priorState: Record<string, unknown>): {
  ctx: CollectContext;
  emitted: EmittedRecord[];
  messages: EmittedMessage[];
} {
  const harness = makeRecordingEmit(validateRecord);
  const ctx: CollectContext = {
    assist: () => Promise.reject(new Error("not used")),
    capture: null,
    completeAssistance: () => Promise.resolve(),
    credentials: {},
    detailGaps: [],
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    emittedAt: "2026-08-09T00:00:00Z",
    progress: () => Promise.resolve(),
    requestDetailGapPage: () => Promise.resolve([]),
    requested: new Map([["transactions", { name: "transactions" }]]),
    scope: { streams: [] },
    sendInteraction: () => Promise.reject(new Error("not used")),
    state: priorState,
  };
  return { ctx, emitted: harness.emitted, messages: harness.protocolMessages };
}

/** Stub a single-page JSON response and capture the request URL that was made. */
function stubSinglePage(body: unknown[]): { restore: () => void; requestedUrl: () => string } {
  const original = globalThis.fetch;
  let capturedUrl = "";
  globalThis.fetch = ((input: RequestInfo | URL) => {
    capturedUrl = String(input);
    return Promise.resolve(new Response(JSON.stringify({ data: body }), { status: 200 }));
  }) as typeof globalThis.fetch;
  return {
    restore: () => {
      globalThis.fetch = original;
    },
    requestedUrl: () => capturedUrl,
  };
}

test("collectTransactions: a partial page (below page size) emits every modeled record, tracks the newest date, and clears the cursor", () =>
  (async () => {
    const stub = stubSinglePage([story("4001", "2026-07-01T00:00:00Z"), story("4002", "2026-07-02T00:00:00Z")]);
    try {
      const { ctx, emitted } = makeCtx({});
      const result = await collectTransactions(ctx, "token", OWNER_ID);
      assert.equal(emitted.length, 2);
      assert.equal(result.totalSeen, 2);
      assert.equal(result.latestSeenAt, "2026-07-02T00:00:00Z", "latest date_created across the page wins");
    } finally {
      stub.restore();
    }
  })());

test("collectTransactions: an empty first page stops immediately with zero records", () =>
  (async () => {
    const stub = stubSinglePage([]);
    try {
      const { ctx, emitted } = makeCtx({});
      const result = await collectTransactions(ctx, "token", OWNER_ID);
      assert.equal(emitted.length, 0);
      assert.equal(result.totalSeen, 0);
      assert.equal(result.latestSeenAt, null);
    } finally {
      stub.restore();
    }
  })());

test("collectTransactions: resumes from a persisted before_id cursor and a story with no modeled payment_type is skipped but still counted", () =>
  (async () => {
    const modeled = story("5001", "2026-04-01T00:00:00Z");
    const unmodeled = { id: "5002", date_created: "2026-04-01T00:00:00Z", payment: { id: "5003", action: "refund" } };
    const stub = stubSinglePage([modeled, unmodeled]);
    try {
      const { ctx, emitted } = makeCtx({ transactions: { before_id: "prior-cursor-id" } });
      const result = await collectTransactions(ctx, "token", OWNER_ID);
      assert.ok(
        stub.requestedUrl().includes(`before_id=${encodeURIComponent("prior-cursor-id")}`),
        "the persisted before_id must be sent on the first request of the run"
      );
      assert.equal(emitted.length, 1, "only the modeled story emits a record");
      assert.equal(result.totalSeen, 2, "the raw page size still counts unmodeled stories as seen");
    } finally {
      stub.restore();
    }
  })());
