// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Discriminating tests for group_messages' per-group incremental ANCHOR.
 *
 * Before this change, `collect()` never persisted any per-group boundary:
 * every run re-walked every group's ENTIRE message history from `before_id`
 * undefined (newest) back to the natural end, gated only by the fingerprint
 * cursor's re-emit suppression — a UAT run against a large account could run
 * 80+ minutes and flush 40k+ records on every single run, forever, even
 * though nothing new was posted.
 *
 * A first revision of this fix used a locally-computed timestamp-plus-fixed-
 * overlap window. That was rejected in review: an arbitrary overlap constant
 * cannot be proven to cover every same-second tie or slow-to-propagate edit,
 * and a time window cannot by itself force re-observation of a specific
 * mutated row (e.g. a `like_count` change, which does not move `created_at`).
 * This revision anchors on the exact `id` of the newest message observed
 * last run — the same identifier GroupMe's own `before_id` pagination is
 * built around — and stops paging only once that id is re-observed on a
 * page independently verified to be `created_at`-descending (GroupMe's
 * documented ordering contract for this endpoint). The anchor row is always
 * re-emitted, so the fingerprint cursor can detect and re-emit a mutation on
 * it. An absent/deleted anchor, or any page that fails the descending check,
 * falls through to a full walk to the natural end.
 *
 * These tests exercise the real exported `collectGroupMessages` /
 * `collectGroupMessagesForGroup` / `collect()` and the pure anchor helper
 * (`decodeGroupMessageAnchors`) — not hand-rolled reimplementations — so a
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
  decodeGroupMessageAnchors,
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

/** Route `globalThis.fetch` by call order for the two-endpoint (list + per-group
 *  messages) shape most of these tests need, with a distinct handler for the
 *  message-page fetches so tests can drive multi-page sequences precisely. */
function stubGroupWalk(opts: { groupsListBody?: unknown; messagePages: Array<{ body: unknown; status?: number }> }): {
  fetchCount: () => number;
  restore: () => void;
} {
  const original = globalThis.fetch;
  let messageFetchCount = 0;
  globalThis.fetch = ((input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    if (url.pathname === "/v3/groups") {
      return Promise.resolve(
        new Response(JSON.stringify({ response: opts.groupsListBody ?? [group()] }), { status: 200 })
      );
    }
    const page = opts.messagePages[Math.min(messageFetchCount, opts.messagePages.length - 1)];
    messageFetchCount += 1;
    return Promise.resolve(new Response(JSON.stringify(page?.body), { status: page?.status ?? 200 }));
  }) as typeof globalThis.fetch;
  return {
    fetchCount: () => messageFetchCount,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

// ─── Pure helper unit tests ─────────────────────────────────────────────────

test("decodeGroupMessageAnchors: absent/malformed state decodes to empty map (full backfill)", () => {
  assert.deepEqual(decodeGroupMessageAnchors(undefined), {});
  assert.deepEqual(decodeGroupMessageAnchors(null), {});
  assert.deepEqual(decodeGroupMessageAnchors("not an object"), {});
  assert.deepEqual(decodeGroupMessageAnchors([1, 2, 3]), {});
  assert.deepEqual(decodeGroupMessageAnchors({ fingerprints: {} }), {}, "missing anchors field");
  assert.deepEqual(decodeGroupMessageAnchors({ anchors: "nope" }), {}, "anchors not an object");
});

test("decodeGroupMessageAnchors: decodes valid per-group entries, drops invalid ones", () => {
  const decoded = decodeGroupMessageAnchors({
    anchors: {
      "group-1": "m-100",
      "group-2": 12_345, // wrong type — GroupMe message ids are strings
      "group-3": "",
      "group-4": "m-500",
    },
  });
  assert.deepEqual(decoded, { "group-1": "m-100", "group-4": "m-500" });
});

// ─── Cold run (no anchor at all) ────────────────────────────────────────────

test("cold run: a fresh account with no prior anchor walks and reports the ENTIRE history, not a truncated window", () => {
  const page1 = Array.from({ length: 100 }, (_, i) =>
    groupMessage({ id: `m-${String(149 - i)}`, created_at: 1_700_000_200 - i })
  );
  const page2 = Array.from({ length: 50 }, (_, i) =>
    groupMessage({ id: `m-${String(49 - i)}`, created_at: 1_700_000_100 - i })
  );
  const walk = stubGroupWalk({
    messagePages: [
      { body: { response: { count: 100, messages: page1 } } },
      { body: { response: { count: 50, messages: page2 } } },
    ],
  });
  return (async () => {
    try {
      const cursor = openFingerprintCursor(new Map());
      const { emit, emitRecord, emitted } = makeHarness();
      const outcome = await collectGroupMessages(TOKEN, cursor, undefined, undefined, noopProgress, emit, emitRecord);

      assert.equal(outcome.failed, false);
      assert.equal(walk.fetchCount(), 2, "both pages fetched — page 2's shorter length ends the walk naturally");
      assert.equal(outcome.considered, 150, "cold run sees the entire history, not a truncated window");
      assert.equal(emitted.filter((r) => r.stream === "group_messages").length, 150);
      assert.equal(outcome.nextAnchors["group-1"], "m-149", "anchor seeds from the newest message's id");
    } finally {
      walk.restore();
    }
  })();
});

// ─── >PAGE_SIZE new messages since the anchor ───────────────────────────────

test(">PAGE_SIZE new messages since the anchor: walk pages past a full page-1 to find the anchor on page 2", () => {
  // 150 new messages have arrived since the anchor (m-0), so page 1 (100
  // messages, all newer than the anchor) is entirely new and does NOT
  // contain the anchor; the walk must fetch page 2 to find it.
  const page1 = Array.from({ length: 100 }, (_, i) =>
    groupMessage({ id: `m-${String(150 - i)}`, created_at: 1_700_000_300 - i })
  );
  const page2 = [
    groupMessage({ id: "m-50", created_at: 1_700_000_200 }),
    groupMessage({ id: "m-0", created_at: 1_700_000_150 }), // the anchor
    groupMessage({ id: "m-old-1", created_at: 1_700_000_100 }),
  ];
  const walk = stubGroupWalk({
    messagePages: [
      { body: { response: { count: 100, messages: page1 } } },
      { body: { response: { count: 3, messages: page2 } } },
    ],
  });
  return (async () => {
    try {
      const cursor = openFingerprintCursor(new Map());
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
        { "group-1": "m-0" }
      );

      assert.equal(outcome.failed, false);
      assert.equal(walk.fetchCount(), 2, "both pages fetched — page 1 alone doesn't contain the anchor");
      const emittedIds = emitted.filter((r) => r.stream === "group_messages").map((r) => (r.data as { id: string }).id);
      assert.ok(emittedIds.includes("m-0"), "the anchor message itself is re-emitted");
      // The stop happens AFTER the whole page containing the anchor is
      // processed (fetching stops before a further page, but nothing on the
      // already-fetched page is excluded) — m-old-1, strictly older than the
      // anchor but on the same page, is genuinely re-observed this run too.
      // This is harmless: the fingerprint cursor no-ops it if unchanged, and
      // excluding it would require re-introducing exactly the kind of
      // locally-computed boundary logic (a second, narrower in-page cutoff)
      // this design deliberately avoids.
      assert.ok(emittedIds.includes("m-old-1"), "the anchor's whole page is processed, not cut off mid-page");
      assert.equal(emittedIds.length, 103, "100 new messages on page 1 plus all 3 messages on the anchor's page");
      assert.equal(outcome.nextAnchors["group-1"], "m-150", "anchor advances to the newest message this run");
    } finally {
      walk.restore();
    }
  })();
});

// ─── Missing/deleted anchor fallback ────────────────────────────────────────

test("missing/deleted anchor: never observed on any page, walk falls through to the natural end (full walk, not a truncation)", () => {
  const page1 = Array.from({ length: 100 }, (_, i) => groupMessage({ id: `m-${String(199 - i)}` }));
  const page2 = Array.from({ length: 50 }, (_, i) => groupMessage({ id: `m-${String(99 - i)}` }));
  const walk = stubGroupWalk({
    messagePages: [
      { body: { response: { count: 100, messages: page1 } } },
      { body: { response: { count: 50, messages: page2 } } },
    ],
  });
  return (async () => {
    try {
      const cursor = openFingerprintCursor(new Map());
      const { emit, emitRecord, emitted } = makeHarness();
      // "m-deleted" never appears in any fetched page — simulates the
      // anchor message having been deleted from the group since last run.
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
        { "group-1": "m-deleted" }
      );

      assert.equal(outcome.failed, false, "an unresolvable anchor falls through to a clean natural-end walk");
      assert.equal(walk.fetchCount(), 2, "both pages fetched — the anchor never licenses an early stop");
      assert.equal(outcome.considered, 150, "the full history is walked and considered, none of it dropped");
      assert.equal(emitted.filter((r) => r.stream === "group_messages").length, 150);
      assert.equal(outcome.nextAnchors["group-1"], "m-199", "a fresh anchor is established from this full walk");
    } finally {
      walk.restore();
    }
  })();
});

// ─── Same-time IDs (ties) ───────────────────────────────────────────────────

test("same-time IDs: two messages share created_at; the anchor stop is keyed on id, not timestamp, so it identifies the exact row", () => {
  const tie1 = groupMessage({ id: "m-tie-1", created_at: 1_700_000_150, text: "first" });
  const tie2 = groupMessage({ id: "m-tie-2", created_at: 1_700_000_150, text: "second" });
  const newer = groupMessage({ id: "m-newer", created_at: 1_700_000_200 });
  const walk = stubGroupWalk({
    messagePages: [{ body: { response: { count: 3, messages: [newer, tie1, tie2] } } }],
  });
  return (async () => {
    try {
      const cursor = openFingerprintCursor(new Map());
      const { emit, emitRecord, emitted } = makeHarness();
      // Anchor is tie2 specifically (not tie1, despite the identical
      // timestamp) — an id-keyed stop must not confuse the two.
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
        { "group-1": "m-tie-2" }
      );

      assert.equal(outcome.failed, false);
      assert.equal(walk.fetchCount(), 1, "the anchor is found on page 1 alone");
      const emittedIds = emitted.filter((r) => r.stream === "group_messages").map((r) => (r.data as { id: string }).id);
      assert.deepEqual(
        new Set(emittedIds),
        new Set(["m-newer", "m-tie-1", "m-tie-2"]),
        "everything up to and including the exact anchor id emits, the timestamp tie does not cause a skip or an extra stop"
      );
      assert.equal(outcome.nextAnchors["group-1"], "m-newer");
    } finally {
      walk.restore();
    }
  })();
});

// ─── Prior anchor changed (edited) ──────────────────────────────────────────

test("prior anchor changed: the re-observed anchor row's mutated content (likes) re-emits via the fingerprint cursor", () => {
  const originalAnchor = groupMessage({ id: "m-anchor", created_at: 1_700_000_150, favorited_by: [] });
  const seedWalk = stubGroupWalk({
    messagePages: [{ body: { response: { count: 1, messages: [originalAnchor] } } }],
  });
  const seedCursor = openFingerprintCursor(new Map());
  return (async () => {
    try {
      const { emit: seedEmit, emitRecord: seedEmitRecord } = makeHarness();
      await collectGroupMessages(TOKEN, seedCursor, undefined, undefined, noopProgress, seedEmit, seedEmitRecord);
    } finally {
      seedWalk.restore();
    }
    const priorFingerprints = seedCursor.toState();

    // Next run: the anchor message gained a like (favorited_by grew) — its
    // content changed even though its id and created_at did not.
    const mutatedAnchor = groupMessage({
      id: "m-anchor",
      created_at: 1_700_000_150,
      favorited_by: ["user-9"],
    });
    const walk = stubGroupWalk({
      messagePages: [{ body: { response: { count: 1, messages: [mutatedAnchor] } } }],
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
        { "group-1": "m-anchor" }
      );

      assert.equal(outcome.failed, false);
      const emittedIds = emitted.filter((r) => r.stream === "group_messages").map((r) => (r.data as { id: string }).id);
      assert.deepEqual(
        emittedIds,
        ["m-anchor"],
        "the mutated anchor row re-emits despite sitting exactly at the anchor"
      );
    } finally {
      walk.restore();
    }
  })();
});

// ─── Out-of-order fallback ──────────────────────────────────────────────────

test("out-of-order fallback: a page violating documented descending order never licenses the anchor stop, even if the anchor id is present", () => {
  // m-late (newer, created_at=200) sits AFTER the anchor (created_at=150)
  // despite being newer — violates documented descending order. Even though
  // the anchor id IS present on this page, isDescendingByCreatedAt must
  // catch the violation and refuse the fast-path stop, falling through to
  // the ordinary natural-end conditions (this page is short, so the walk
  // ends here anyway — the assertion is that ALL rows on the page emit, not
  // just those "before" the anchor in array order).
  const restore = stubFetchByPath({
    "/v3/groups": [group()],
    "/v3/groups/group-1/messages": {
      count: 3,
      messages: [
        groupMessage({ id: "m-new", created_at: 1_700_000_300 }),
        groupMessage({ id: "m-anchor", created_at: 1_700_000_150 }),
        groupMessage({ id: "m-late", created_at: 1_700_000_200 }), // out-of-order straggler AFTER the anchor
      ],
    },
  });
  return (async () => {
    try {
      const cursor = openFingerprintCursor(new Map());
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
        { "group-1": "m-anchor" }
      );

      assert.equal(outcome.failed, false);
      const emittedIds = new Set(
        emitted.filter((r) => r.stream === "group_messages").map((r) => (r.data as { id: string }).id)
      );
      assert.deepEqual(
        emittedIds,
        new Set(["m-new", "m-anchor", "m-late"]),
        "every row on the non-descending page emits — the anchor's mere presence does not license a fast stop here"
      );
    } finally {
      restore();
    }
  })();
});

// ─── Interrupted run: no advance ────────────────────────────────────────────

test("interrupted run: a page-cap-truncated walk does not advance the anchor or persist STATE", async () => {
  const fullPage = Array.from({ length: 100 }, (_, i) => groupMessage({ id: `m-${String(i)}` }));
  const restore = stubFetchByPath({
    "/v3/groups": [group()],
    "/v3/groups/group-1/messages": { count: 100, messages: fullPage },
  });
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emit, emitRecord } = makeHarness();
    const priorAnchors = { "group-1": "m-nonexistent" };
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
      priorAnchors
    );

    assert.equal(outcome.failed, true, "a page-cap-truncated walk must not report a clean pass");
    assert.deepEqual(
      outcome.nextAnchors,
      {},
      "a failed/truncated pass must withhold the anchor map entirely, not a partial or stale one"
    );
  } finally {
    restore();
  }
});

test("interrupted run via collect(): STATE (including anchors) is withheld end-to-end on a failed pass, prior anchor survives untouched", async () => {
  const STREAMS: StreamScope[] = [{ name: "group_messages" }];
  function makeCtx(state: Record<string, unknown>): { ctx: CollectContext; messages: EmittedMessage[] } {
    const harness = makeRecordingEmit(validateRecord);
    const ctx: CollectContext = {
      assist: () => Promise.resolve("asst_test"),
      capture: null,
      collectionMode: "incremental",
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

  // Run 1: clean, seeds a real anchor.
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
  const run1Cursor = (run1State as { cursor: { anchors?: Record<string, string> } }).cursor;
  assert.equal(run1Cursor.anchors?.["group-1"], "gmsg-1", "run 1 seeds group-1's anchor");

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
  assert.ok(!run2State, "an interrupted run must not emit a replacement STATE — the prior anchor is left untouched");
});

// ─── Explicit full_refresh bypass ───────────────────────────────────────────

test("explicit full_refresh bypass: an established tight anchor is ignored, the group walks to its natural end", () => {
  const page1 = Array.from({ length: 100 }, (_, i) => groupMessage({ id: `m-${String(149 - i)}` }));
  const page2 = Array.from({ length: 50 }, (_, i) => groupMessage({ id: `m-${String(49 - i)}` }));
  const walk = stubGroupWalk({
    messagePages: [
      { body: { response: { count: 100, messages: page1 } } },
      { body: { response: { count: 50, messages: page2 } } },
    ],
  });
  return (async () => {
    try {
      const cursor = openFingerprintCursor(new Map());
      const { emit, emitRecord, emitted } = makeHarness();
      // The anchor is m-149 (the very newest message) — under ordinary
      // incremental mode this would stop the walk after page 1's first row.
      // With collectionMode: "full_refresh", it must be ignored entirely.
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
        { "group-1": "m-149" },
        "full_refresh"
      );

      assert.equal(outcome.failed, false);
      assert.equal(
        walk.fetchCount(),
        2,
        "full_refresh bypasses the anchor — both pages are fetched despite a tight anchor"
      );
      assert.equal(outcome.considered, 150, "the entire history is walked and considered under full_refresh");
      assert.equal(
        emitted.filter((r) => r.stream === "group_messages").length,
        150,
        "every message emits under full_refresh, providing the explicit repair path for stale mutable fields"
      );
      assert.equal(
        outcome.nextAnchors["group-1"],
        "m-149",
        "the anchor map is rebuilt from this full walk for the next ordinary run"
      );
    } finally {
      walk.restore();
    }
  })();
});

test("explicit full_refresh bypass via collect(): CollectContext.collectionMode reaches the connector and forces a full walk", async () => {
  const STREAMS: StreamScope[] = [{ name: "group_messages" }];
  const harness = makeRecordingEmit(validateRecord);
  const page1 = Array.from({ length: 100 }, (_, i) => groupMessage({ id: `m-${String(149 - i)}` }));
  const page2 = Array.from({ length: 50 }, (_, i) => groupMessage({ id: `m-${String(49 - i)}` }));
  const walk = stubGroupWalk({
    messagePages: [
      { body: { response: { count: 100, messages: page1 } } },
      { body: { response: { count: 50, messages: page2 } } },
    ],
  });
  try {
    const ctx: CollectContext = {
      assist: () => Promise.resolve("asst_test"),
      capture: null,
      collectionMode: "full_refresh",
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
      // A tight, pre-existing anchor that would otherwise stop the walk on page 1.
      state: { group_messages: { anchors: { "group-1": "m-149" } } },
    };
    await collect(ctx);

    assert.equal(
      walk.fetchCount(),
      2,
      "collection_mode full_refresh, surfaced via CollectContext, bypasses the anchor end-to-end"
    );
    assert.equal(
      harness.emitted.filter((r) => r.stream === "group_messages").length,
      150,
      "the full history emits, not just what's newer than the pre-existing anchor"
    );
  } finally {
    walk.restore();
  }
});
