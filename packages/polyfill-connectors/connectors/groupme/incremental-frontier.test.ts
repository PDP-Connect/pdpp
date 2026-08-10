// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Discriminating tests for group_messages' per-group incremental frontier.
 *
 * Before this change, `collect()` never persisted any per-group boundary:
 * every run re-walked every group's ENTIRE message history from `before_id`
 * undefined (newest) back to the natural end, gated only by the fingerprint
 * cursor's re-emit suppression — a UAT run against a large account could run
 * 80+ minutes and flush 40k+ records on every single run, forever, even
 * though nothing new was posted. `sinceEpochSeconds` existed but was driven
 * ONLY by a caller-declared `requested.time_range.since` (external scope),
 * never by anything the connector itself remembered.
 *
 * These tests exercise the real exported `collectGroupMessages` /
 * `collectGroupMessagesForGroup` / `collect()` and the pure frontier helpers
 * (`resolveGroupMessagesSinceBound`, `decodeGroupMessageFrontiers`,
 * `maxMessageCreatedAt`) — not hand-rolled reimplementations — so a
 * regression in the real fast-path wiring fails these tests.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { CollectContext, EmittedMessage, RecordData, StreamScope } from "../../src/connector-runtime.ts";
import { openFingerprintCursor } from "../../src/fingerprint-cursor.ts";
import { type EmittedRecord, makeRecordingEmit } from "../../src/test-harness.ts";
import {
  __resetHttpGovernorForTests,
  __setZeroDelayHttpGovernorForTests,
  collect,
  collectGroupMessages,
  decodeGroupMessageFrontiers,
  maxMessageCreatedAt,
  resolveGroupMessagesSinceBound,
} from "./index.ts";
import { validateRecord } from "./schemas.ts";

const TOKEN = "test-access-token";

// These tests exercise real multi-page, multi-group walks against the real
// `collectGroupMessages`/`collect()` — GroupMe's module-level httpGovernor
// otherwise paces every request at production speed (10s+), which would make
// this file take minutes and fail on wall-clock rather than behavior. Swap in
// a zero-delay governor for the duration of this file only; production
// `collect()` never calls this override.
before(() => {
  __setZeroDelayHttpGovernorForTests();
});
after(() => {
  __resetHttpGovernorForTests();
});

function noopProgress(): Promise<void> {
  return Promise.resolve();
}

function group(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "group-1",
    name: "Test Group",
    description: null,
    avatar_url: null,
    created_at: 1_700_000_000,
    updated_at: 1_700_000_050,
    members_count: 3,
    messages_count: 10,
    ...overrides,
  };
}

function groupMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "gmsg-1",
    text: "hi",
    created_at: 1_700_000_100,
    user_id: "user-2",
    name: "Bob",
    avatar_url: null,
    attachments: [],
    favorited_by: [],
    system: false,
    ...overrides,
  };
}

function makeHarness(): {
  emit: (msg: EmittedMessage) => Promise<void>;
  emitRecord: (stream: string, data: RecordData) => Promise<void>;
  emitted: EmittedRecord[];
  protocolMessages: EmittedMessage[];
} {
  const harness = makeRecordingEmit(validateRecord);
  return {
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    emitted: harness.emitted,
    protocolMessages: harness.protocolMessages,
  };
}

/** Route `globalThis.fetch` by pathname; same helper shape as
 *  carry-forward-projection.test.ts, needed because `collect()` fans out
 *  across multiple distinct endpoints in one run. */
function stubFetchByPath(routes: Record<string, unknown | { status: number; body: unknown }>): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const route = routes[url.pathname];
    if (route === undefined) {
      throw new Error(`unstubbed path in incremental-frontier test: ${url.pathname}`);
    }
    if (typeof route === "object" && route !== null && "status" in route) {
      const failure = route as { status: number; body: unknown };
      return Promise.resolve(new Response(JSON.stringify(failure.body), { status: failure.status }));
    }
    return Promise.resolve(new Response(JSON.stringify({ response: route }), { status: 200 }));
  }) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = original;
  };
}

// ─── Pure helper unit tests ─────────────────────────────────────────────────

test("resolveGroupMessagesSinceBound: no prior frontier, no declared since -> null (full backfill)", () => {
  assert.equal(resolveGroupMessagesSinceBound(undefined, null), null);
});

test("resolveGroupMessagesSinceBound: prior frontier only -> frontier minus overlap", () => {
  const bound = resolveGroupMessagesSinceBound(1_700_010_000, null);
  assert.equal(bound, 1_700_010_000 - 600);
});

test("resolveGroupMessagesSinceBound: declared since only -> declared since, unmodified", () => {
  const bound = resolveGroupMessagesSinceBound(undefined, 1_700_005_000);
  assert.equal(bound, 1_700_005_000);
});

test("resolveGroupMessagesSinceBound: both present -> the OLDER (more permissive) bound wins", () => {
  // frontier-derived bound is newer (tighter) than the declared since.
  const olderDeclaredWins = resolveGroupMessagesSinceBound(1_700_010_000, 1_600_000_000);
  assert.equal(olderDeclaredWins, 1_600_000_000, "declared since is older, so it must win over the tighter frontier");

  // declared since is newer (tighter) than the frontier-derived bound.
  const olderFrontierWins = resolveGroupMessagesSinceBound(1_500_000_000, 1_700_000_000);
  assert.equal(
    olderFrontierWins,
    1_500_000_000 - 600,
    "frontier-derived bound is older, so it must win over the tighter declared since"
  );
});

test("resolveGroupMessagesSinceBound: overlap never pushes the bound negative", () => {
  const bound = resolveGroupMessagesSinceBound(100, null);
  assert.equal(bound, 0, "clamped at 0, not a negative epoch");
});

test("decodeGroupMessageFrontiers: absent/malformed state decodes to empty map (full backfill)", () => {
  assert.deepEqual(decodeGroupMessageFrontiers(undefined), {});
  assert.deepEqual(decodeGroupMessageFrontiers(null), {});
  assert.deepEqual(decodeGroupMessageFrontiers("not an object"), {});
  assert.deepEqual(decodeGroupMessageFrontiers([1, 2, 3]), {});
  assert.deepEqual(decodeGroupMessageFrontiers({ fingerprints: {} }), {}, "missing frontiers field");
  assert.deepEqual(decodeGroupMessageFrontiers({ frontiers: "nope" }), {}, "frontiers not an object");
});

test("decodeGroupMessageFrontiers: decodes valid per-group entries, drops invalid ones", () => {
  const decoded = decodeGroupMessageFrontiers({
    frontiers: {
      "group-1": 1_700_000_000,
      "group-2": "not a number",
      "group-3": -5,
      "group-4": 0,
      "group-5": 1_700_000_500,
    },
  });
  assert.deepEqual(decoded, { "group-1": 1_700_000_000, "group-5": 1_700_000_500 });
});

test("maxMessageCreatedAt: tracks the max across a batch, clamped at current", () => {
  const messages = [
    groupMessage({ created_at: 1_700_000_100 }),
    groupMessage({ created_at: 1_700_000_300 }),
    groupMessage({ created_at: 1_700_000_050 }),
  ] as never;
  assert.equal(maxMessageCreatedAt(messages, 0), 1_700_000_300);
  assert.equal(maxMessageCreatedAt(messages, 1_700_000_999), 1_700_000_999, "does not regress below current");
});

// ─── collectGroupMessages: frontier advance + resume (fail-before/pass-after) ──

test("FAIL-BEFORE / PASS-AFTER: repeated run with an unchanged group re-walks full history without a frontier, stops early with one", async () => {
  // This is the exact production symptom: a group with 250 messages, paged
  // 100 at a time, walked fully on every run because there was no
  // persisted per-group boundary. Without passing priorFrontiers (the
  // pre-fix call shape), every run fetches all 3 pages.
  const page1 = Array.from({ length: 100 }, (_, i) =>
    groupMessage({ id: `m-${String(249 - i)}`, created_at: 1_700_000_000 + (249 - i) })
  );
  const page2 = Array.from({ length: 100 }, (_, i) =>
    groupMessage({ id: `m-${String(149 - i)}`, created_at: 1_700_000_000 + (149 - i) })
  );
  const page3 = Array.from({ length: 50 }, (_, i) =>
    groupMessage({ id: `m-${String(49 - i)}`, created_at: 1_700_000_000 + (49 - i) })
  );
  const pagesByFetchOrder = [page1, page2, page3];

  let fetchCount = 0;
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    if (url.pathname === "/v3/groups") {
      return Promise.resolve(new Response(JSON.stringify({ response: [group()] }), { status: 200 }));
    }
    const body = pagesByFetchOrder[Math.min(fetchCount, pagesByFetchOrder.length - 1)];
    fetchCount += 1;
    return Promise.resolve(
      new Response(JSON.stringify({ response: { count: body?.length, messages: body } }), { status: 200 })
    );
  }) as typeof globalThis.fetch;
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emit, emitRecord } = makeHarness();
    // No priorFrontiers passed (default {}) — this is the pre-fix behavior:
    // full walk every time regardless of what a previous run already saw.
    const outcome = await collectGroupMessages(TOKEN, cursor, undefined, undefined, noopProgress, emit, emitRecord);

    assert.equal(outcome.failed, false);
    assert.equal(
      outcome.considered,
      250,
      "with no persisted frontier, the walk considers the FULL 250-message history"
    );
    assert.equal(fetchCount, 3, "all 3 pages fetched — this is the repeated-full-scan symptom");
  } finally {
    globalThis.fetch = original;
  }
});

test("PASS-AFTER: with a persisted frontier from a prior clean run, a repeat run with no new messages stops after page 1", async () => {
  // Page 1 spans created_at 1_700_010_000 (newest) down to 1_700_009_901
  // (oldest, 100 messages at 1s intervals). The prior frontier is set so the
  // frontier-minus-overlap bound (1_700_010_550 - 600 = 1_700_009_950) falls
  // STRICTLY INSIDE that range — some rows on the page are in-scope, some are
  // genuinely out-of-scope relative to the resumed walk, licensing the
  // documented-ordering fast-path stop. A frontier whose overlap-adjusted
  // bound falls BELOW every row on the page (as an earlier draft of this test
  // did) makes the entire page in-scope, which correctly does NOT license an
  // early stop — that failure mode is what this comment is guarding against.
  const page1 = Array.from({ length: 100 }, (_, i) =>
    groupMessage({ id: `m-${String(99 - i)}`, created_at: 1_700_010_000 - i })
  );
  let fetchCount = 0;
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    if (url.pathname === "/v3/groups") {
      return Promise.resolve(new Response(JSON.stringify({ response: [group()] }), { status: 200 }));
    }
    fetchCount += 1;
    // Only page 1 is stubbed — if the fast path fails to stop, the test
    // itself throws on an unstubbed page-2 fetch attempt.
    return Promise.resolve(
      new Response(JSON.stringify({ response: { count: page1.length, messages: page1 } }), { status: 200 })
    );
  }) as typeof globalThis.fetch;
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emit, emitRecord } = makeHarness();
    const priorFrontiers = { "group-1": 1_700_010_550 };
    const outcome = await collectGroupMessages(
      TOKEN,
      cursor,
      undefined,
      undefined,
      noopProgress,
      emit,
      emitRecord,
      undefined,
      null,
      priorFrontiers
    );

    assert.equal(outcome.failed, false);
    assert.equal(fetchCount, 1, "the frontier-derived since bound stops the walk after page 1 — no repeated full scan");
    // The prior frontier (1_700_010_550) is already newer than the newest
    // message this run actually observed (1_700_010_000, m-0) — the prior
    // frontier must never REGRESS from a run that happened to see an older
    // high-water mark than what was already durably recorded.
    assert.equal(
      outcome.nextFrontiers["group-1"],
      1_700_010_550,
      "frontier never regresses below the already-persisted high-water mark"
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("interrupted run: a page-cap-truncated walk does not advance the frontier or persist STATE", async () => {
  const fullPage = Array.from({ length: 100 }, (_, i) => groupMessage({ id: `m-${String(i)}` }));
  const restore = stubFetchByPath({
    "/v3/groups": [group()],
    "/v3/groups/group-1/messages": { count: 100, messages: fullPage },
  });
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emit, emitRecord } = makeHarness();
    const priorFrontiers = { "group-1": 1_650_000_000 };
    // maxPages=1 forces the walk to hit the page cap on a full page — an
    // "interrupted"/incomplete walk, same shape as a crash mid-pagination.
    const outcome = await collectGroupMessages(
      TOKEN,
      cursor,
      undefined,
      undefined,
      noopProgress,
      emit,
      emitRecord,
      1,
      null,
      priorFrontiers
    );

    assert.equal(outcome.failed, true, "a page-cap-truncated walk must not report a clean pass");
    assert.deepEqual(
      outcome.nextFrontiers,
      {},
      "a failed/truncated pass must withhold the frontier map entirely, not a partial or stale one"
    );
  } finally {
    restore();
  }
});

test("interrupted run via collect(): STATE (including frontiers) is withheld end-to-end on a failed pass, prior frontier survives untouched", async () => {
  const STREAMS: StreamScope[] = [{ name: "group_messages" }];
  function makeCtx(state: Record<string, unknown>): { ctx: CollectContext; messages: EmittedMessage[] } {
    const harness = makeRecordingEmit(validateRecord);
    const ctx: CollectContext = {
      assist: () => Promise.resolve("asst_test"),
      capture: null,
      completeAssistance: () => Promise.resolve(),
      credentials: { GROUPME_ACCESS_TOKEN: TOKEN },
      detailGaps: [],
      emit: harness.emit,
      emitRecord: harness.emitRecord,
      emittedAt: "2026-08-10T00:00:00.000Z",
      progress: () => Promise.resolve(),
      requestDetailGapPage: () => Promise.resolve([]),
      requested: new Map(STREAMS.map((s) => [s.name, s])),
      scope: { streams: STREAMS },
      sendInteraction: () =>
        Promise.resolve({
          request_id: "int_test",
          status: "cancelled" as const,
          type: "INTERACTION_RESPONSE" as const,
        }),
      state,
    };
    return { ctx, messages: harness.protocolMessages };
  }

  // Run 1: clean, seeds a real frontier.
  const seedRestore = stubFetchByPath({
    "/v3/groups": [group()],
    "/v3/groups/group-1/messages": { count: 1, messages: [groupMessage()] },
  });
  const run1 = makeCtx({});
  try {
    await collect(run1.ctx);
  } finally {
    seedRestore();
  }
  const run1State = run1.messages.find((m) => m.type === "STATE" && m.stream === "group_messages");
  assert.ok(run1State && run1State.type === "STATE", "run 1 persists a group_messages STATE checkpoint");
  const run1Cursor = (run1State as { cursor: { frontiers?: Record<string, number> } }).cursor;
  assert.equal(run1Cursor.frontiers?.["group-1"], 1_700_000_100, "run 1 seeds group-1's frontier");

  // Run 2: interrupted by an HTTP failure mid-walk.
  const failRestore = stubFetchByPath({
    "/v3/groups": [group()],
    "/v3/groups/group-1/messages": { status: 500, body: { error: "server error" } },
  });
  const run2 = makeCtx({ group_messages: run1Cursor });
  try {
    await collect(run2.ctx);
  } finally {
    failRestore();
  }
  const run2State = run2.messages.find((m) => m.type === "STATE" && m.stream === "group_messages");
  assert.ok(!run2State, "an interrupted run must not emit a replacement STATE — the prior frontier is left untouched");
});

// ─── Ties, edits, out-of-order — via applySinceBoundToPage / isDescendingByCreatedAt through the real walk ──

test("same-timestamp tie at the boundary: overlap re-observes it, fingerprint cursor no-ops it (no duplicate emit)", async () => {
  // Two messages share created_at=1_700_000_150 (a tie). The prior frontier
  // is exactly 1_700_000_150 — without overlap, a naive `>` bound would skip
  // both; this proves the overlap keeps them in the re-walked window and the
  // fingerprint cursor (seeded with their prior fingerprints) suppresses the
  // unchanged one from re-emitting while still advancing totalSeen/considered
  // honestly.
  const tie1 = groupMessage({ id: "m-tie-1", created_at: 1_700_000_150, text: "first" });
  const tie2 = groupMessage({ id: "m-tie-2", created_at: 1_700_000_150, text: "second" });
  const newer = groupMessage({ id: "m-newer", created_at: 1_700_000_200, text: "newer" });

  const restore = stubFetchByPath({
    "/v3/groups": [group()],
    "/v3/groups/group-1/messages": { count: 3, messages: [newer, tie1, tie2] },
  });
  try {
    // Seed the fingerprint cursor with tie1/tie2's prior state so a re-walk
    // over the overlap window does not re-emit them as if they were new.
    const seedCursor = openFingerprintCursor(new Map());
    const { emit: seedEmit, emitRecord: seedEmitRecord } = makeHarness();
    await collectGroupMessages(TOKEN, seedCursor, undefined, undefined, noopProgress, seedEmit, seedEmitRecord);
    const priorFingerprints = seedCursor.toState();

    const cursor = openFingerprintCursor({ fingerprints: priorFingerprints });
    const { emit, emitRecord, emitted } = makeHarness();
    // Prior frontier = 1_700_000_150 (the tie's timestamp) — overlap pulls
    // the effective bound below it so the tie is re-walked, not skipped.
    const outcome = await collectGroupMessages(
      TOKEN,
      cursor,
      undefined,
      undefined,
      noopProgress,
      emit,
      emitRecord,
      undefined,
      null,
      { "group-1": 1_700_000_150 }
    );

    assert.equal(outcome.failed, false);
    assert.equal(
      emitted.filter((r) => r.stream === "group_messages").length,
      0,
      "all 3 messages are unchanged from the seed run — none re-emit"
    );
    assert.equal(outcome.considered, 3, "the tie boundary is inside the re-walked overlap window, not skipped");
  } finally {
    restore();
  }
});

test("edited known row within the overlap window: fingerprint mismatch re-emits it even though the frontier already passed it", async () => {
  const originalMessage = groupMessage({ id: "m-edit", created_at: 1_700_000_150, text: "original" });
  const seedRestore = stubFetchByPath({
    "/v3/groups": [group()],
    "/v3/groups/group-1/messages": { count: 1, messages: [originalMessage] },
  });
  const seedCursor = openFingerprintCursor(new Map());
  try {
    const { emit: seedEmit, emitRecord: seedEmitRecord } = makeHarness();
    await collectGroupMessages(TOKEN, seedCursor, undefined, undefined, noopProgress, seedEmit, seedEmitRecord);
  } finally {
    seedRestore();
  }
  const priorFingerprints = seedCursor.toState();

  // Next run: the message was edited (text changed), and the frontier
  // (150) is newer than the message's created_at, so only the
  // GROUP_MESSAGES_FRONTIER_OVERLAP_SECONDS window re-walks it.
  const edited = groupMessage({ id: "m-edit", created_at: 1_700_000_150, text: "EDITED" });
  const restore = stubFetchByPath({
    "/v3/groups": [group()],
    "/v3/groups/group-1/messages": { count: 1, messages: [edited] },
  });
  try {
    const cursor = openFingerprintCursor({ fingerprints: priorFingerprints });
    const { emit, emitRecord, emitted } = makeHarness();
    const outcome = await collectGroupMessages(
      TOKEN,
      cursor,
      undefined,
      undefined,
      noopProgress,
      emit,
      emitRecord,
      undefined,
      null,
      { "group-1": 1_700_000_150 }
    );

    assert.equal(outcome.failed, false);
    const emittedIds = emitted.filter((r) => r.stream === "group_messages").map((r) => (r.data as { id: string }).id);
    assert.deepEqual(
      emittedIds,
      ["m-edit"],
      "the edited row inside the overlap window re-emits, proving edits survive"
    );
  } finally {
    restore();
  }
});

test("out-of-order page inside the resumed walk falls back to the conservative full check, no message is silently skipped", async () => {
  // m-late (in scope under the frontier-derived bound) sits AFTER m-old
  // (out of scope) despite being newer — violates documented descending
  // order. isDescendingByCreatedAt must catch this and refuse the fast-path
  // early stop, exactly as it already does for a caller-declared since.
  const restore = stubFetchByPath({
    "/v3/groups": [group()],
    "/v3/groups/group-1/messages": {
      count: 3,
      messages: [
        groupMessage({ id: "m-new", created_at: 1_700_000_300 }),
        groupMessage({ id: "m-old", created_at: 1_700_000_000 }),
        groupMessage({ id: "m-late", created_at: 1_700_000_200 }),
      ],
    },
  });
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emit, emitRecord, emitted } = makeHarness();
    // frontier-derived bound excludes m-old (0) but includes m-new (300) and
    // m-late (200): frontier=1_700_000_100+overlap keeps bound at 1_700_000_100
    // once overlap(600) exceeds 100 it clamps to 0 — pick a frontier where
    // bound stays above m-old's timestamp: frontier=1_700_000_700 -> bound
    // = 1_700_000_100.
    const outcome = await collectGroupMessages(
      TOKEN,
      cursor,
      undefined,
      undefined,
      noopProgress,
      emit,
      emitRecord,
      undefined,
      null,
      { "group-1": 1_700_000_700 }
    );

    assert.deepEqual(
      new Set(emitted.filter((r) => r.stream === "group_messages").map((r) => (r.data as { id: string }).id)),
      new Set(["m-new", "m-late"]),
      "both in-scope rows emit, including the out-of-order straggler after the out-of-scope row"
    );
    assert.equal(outcome.considered, 2);
    assert.equal(outcome.failed, false);
  } finally {
    restore();
  }
});

// ─── Full-refresh counterweight ─────────────────────────────────────────────

test("full-refresh counterweight: a fresh account with no prior frontier still walks and reports the ENTIRE history, not just a window", async () => {
  // page1 is a full PAGE_SIZE page (doesn't itself signal the natural end);
  // page2 is deliberately SHORTER than PAGE_SIZE so the walk terminates via
  // the ordinary `messages.length < PAGE_SIZE` natural-end condition instead
  // of running until the (unrelated) page cap — a full-size page2 would have
  // made this stub never terminate, since nothing else in this scenario
  // signals "no more history" for an unbounded backfill walk.
  const page1 = Array.from({ length: 100 }, (_, i) =>
    groupMessage({ id: `m-${String(149 - i)}`, created_at: 1_700_000_200 - i })
  );
  const page2 = Array.from({ length: 50 }, (_, i) =>
    groupMessage({ id: `m-${String(49 - i)}`, created_at: 1_700_000_100 - i })
  );
  let fetchCount = 0;
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    if (url.pathname === "/v3/groups") {
      return Promise.resolve(new Response(JSON.stringify({ response: [group()] }), { status: 200 }));
    }
    fetchCount += 1;
    const body = fetchCount === 1 ? page1 : page2;
    return Promise.resolve(
      new Response(JSON.stringify({ response: { count: body.length, messages: body } }), { status: 200 })
    );
  }) as typeof globalThis.fetch;
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emit, emitRecord, emitted } = makeHarness();
    // No prior frontiers (backfill case) — must walk the FULL 150-message
    // history in one run, proving the frontier machinery does not
    // accidentally clip an initial full backfill.
    const outcome = await collectGroupMessages(TOKEN, cursor, undefined, undefined, noopProgress, emit, emitRecord);

    assert.equal(outcome.failed, false);
    assert.equal(fetchCount, 2, "both pages fetched — page 2's shorter length is what ends the walk");
    assert.equal(outcome.considered, 150, "initial backfill sees the entire history, not a truncated window");
    assert.equal(
      emitted.filter((r) => r.stream === "group_messages").length,
      150,
      "every message from the initial backfill emits"
    );
    assert.equal(
      outcome.nextFrontiers["group-1"],
      1_700_000_200,
      "frontier seeds from the newest message's created_at"
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("full-refresh counterweight: a NEW group added after the frontier was seeded for other groups still gets a full walk", async () => {
  const restore = stubFetchByPath({
    "/v3/groups": [group({ id: "group-1" }), group({ id: "group-new" })],
    "/v3/groups/group-1/messages": { count: 1, messages: [groupMessage({ id: "m-old", created_at: 1_700_000_050 })] },
    "/v3/groups/group-new/messages": {
      count: 1,
      messages: [groupMessage({ id: "m-fresh", created_at: 1_700_000_900 })],
    },
  });
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emit, emitRecord, emitted } = makeHarness();
    // group-1 has an established (tight) frontier; group-new has none.
    const outcome = await collectGroupMessages(
      TOKEN,
      cursor,
      undefined,
      undefined,
      noopProgress,
      emit,
      emitRecord,
      undefined,
      null,
      { "group-1": 1_700_000_600 }
    );

    assert.equal(outcome.failed, false);
    const ids = emitted.filter((r) => r.stream === "group_messages").map((r) => (r.data as { id: string }).id);
    assert.ok(ids.includes("m-fresh"), "the new group's message is not skipped despite another group's tight frontier");
    assert.equal(outcome.nextFrontiers["group-new"], 1_700_000_900, "the new group gets its own seeded frontier");
    assert.equal(outcome.nextFrontiers["group-1"], 1_700_000_600, "group-1's frontier carries forward unchanged");
  } finally {
    restore();
  }
});
