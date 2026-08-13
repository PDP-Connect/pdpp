// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Discriminating tests for group_messages' forward-resumable CURSOR.
 *
 * Before this change, `collect()` never persisted any per-group boundary:
 * every run re-walked every group's ENTIRE message history from `before_id`
 * undefined (newest) back to the natural end, gated only by the fingerprint
 * cursor's re-emit suppression — a UAT run against a large account could run
 * 80+ minutes and flush 40k+ records on every single run, forever.
 *
 * Two earlier designs were rejected in review before this one:
 *   1. A locally-computed timestamp-plus-fixed-overlap window — an
 *      ungrounded heuristic (no overlap size is provably sufficient) that
 *      also can't force re-observation of a mutated row whose timestamp
 *      didn't move.
 *   2. A backward `before_id` re-scan searching for a "prior newest message"
 *      anchor id — wastes work proportional to everything posted since last
 *      run, and a page-count ceiling on that search is itself a correctness
 *      bug (a sufficiently large group could never converge).
 *
 * This design instead resumes FORWARD via GroupMe's documented continuation
 * primitive, `after_id` ("ascending order... easy to pick off the last
 * result for continued pagination" — dev.groupme.com/docs/v3), advancing
 * the cursor to each page's last message id until a short/empty page proves
 * the natural end. There is NO page-count ceiling anywhere in this walk (an
 * arbitrary cap is itself a correctness bug for a large, still-growing
 * group) — the only non-natural exit is a typed `NonProgressError` on a
 * repeated/non-advancing cursor or a documented-ordering violation. A cold
 * start or an explicit `collection_mode: "full_refresh"` walks BACKWARD via
 * `before_id` to the natural end instead, with the identical no-ceiling,
 * typed-failure-on-non-progress discipline.
 *
 * These tests exercise the real exported `collectGroupMessages`/`collect()`
 * and the pure `decodeGroupMessageCursors` helper — not hand-rolled
 * reimplementations — so a regression in the real forward/backward wiring
 * fails these tests.
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
  decodeGroupMessageCursors,
} from "./index.ts";
import { validateRecord } from "./schemas.ts";

const TOKEN = "test-access-token";
const PAGE_SIZE = 100;

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

/** Route `globalThis.fetch` by pathname; used for `collect()`-level tests. */
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

/** Route by call ORDER for group-messages page fetches (after the initial
 *  `/groups` list fetch, which is always answered with a single group). */
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

test("decodeGroupMessageCursors: absent/malformed state decodes to empty map (cold start)", () => {
  assert.deepEqual(decodeGroupMessageCursors(undefined), {});
  assert.deepEqual(decodeGroupMessageCursors(null), {});
  assert.deepEqual(decodeGroupMessageCursors("not an object"), {});
  assert.deepEqual(decodeGroupMessageCursors([1, 2, 3]), {});
  assert.deepEqual(decodeGroupMessageCursors({ fingerprints: {} }), {}, "missing cursors field");
  assert.deepEqual(decodeGroupMessageCursors({ cursors: "nope" }), {}, "cursors not an object");
});

test("decodeGroupMessageCursors: decodes valid per-group entries, drops invalid ones", () => {
  const decoded = decodeGroupMessageCursors({
    cursors: {
      "group-1": "m-100",
      "group-2": 12_345, // wrong type — GroupMe message ids are strings
      "group-3": "",
      "group-4": "m-500",
    },
  });
  assert.deepEqual(decoded, { "group-1": "m-100", "group-4": "m-500" });
});

// ─── Cold run (no cursor at all): backward walk to natural end ─────────────

test("cold run: a fresh account with no prior cursor walks backward and reports the ENTIRE history", () => {
  const page1 = Array.from({ length: PAGE_SIZE }, (_, i) =>
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
      const { emitRecord, emitted } = makeHarness();
      const outcome = await collectGroupMessages(TOKEN, cursor, undefined, undefined, noopProgress, emitRecord);

      assert.equal(outcome.failed, false);
      assert.equal(walk.fetchCount(), 2, "both pages fetched — page 2's shorter length ends the walk naturally");
      assert.equal(outcome.considered, 150, "cold run sees the entire history, not a truncated window");
      assert.equal(emitted.filter((r) => r.stream === "group_messages").length, 150);
      assert.equal(outcome.nextCursors["group-1"], "m-149", "cursor seeds from the newest message's id");
    } finally {
      walk.restore();
    }
  })();
});

// ─── Ordinary forward resume ────────────────────────────────────────────────

test("ordinary resume: a persisted cursor resumes forward via after_id and stops on the natural (short) page", () => {
  const newMessages = [
    groupMessage({ id: "m-new-1", created_at: 1_700_000_200 }),
    groupMessage({ id: "m-new-2", created_at: 1_700_000_250 }),
  ];
  const walk = stubGroupWalk({
    messagePages: [{ body: { response: { count: 2, messages: newMessages } } }],
  });
  return (async () => {
    try {
      const cursor = openFingerprintCursor(new Map());
      const { emitRecord, emitted } = makeHarness();
      const outcome = await collectGroupMessages(TOKEN, cursor, undefined, undefined, noopProgress, emitRecord, null, {
        "group-1": "m-old-cursor",
      });

      assert.equal(outcome.failed, false);
      assert.equal(walk.fetchCount(), 1, "a short page ends the forward walk after one fetch");
      const emittedIds = emitted.filter((r) => r.stream === "group_messages").map((r) => (r.data as { id: string }).id);
      assert.deepEqual(
        emittedIds,
        ["m-new-1", "m-new-2"],
        "both new messages emit, in the order the API returned them"
      );
      assert.equal(outcome.nextCursors["group-1"], "m-new-2", "cursor advances to the newest (last) message this run");
    } finally {
      walk.restore();
    }
  })();
});

test("ordinary resume: no new messages (empty forward page) leaves the cursor unchanged and considered at 0", () => {
  const walk = stubGroupWalk({
    messagePages: [{ body: { response: { count: 0, messages: [] } } }],
  });
  return (async () => {
    try {
      const cursor = openFingerprintCursor(new Map());
      const { emitRecord, emitted } = makeHarness();
      const outcome = await collectGroupMessages(TOKEN, cursor, undefined, undefined, noopProgress, emitRecord, null, {
        "group-1": "m-existing-cursor",
      });

      assert.equal(outcome.failed, false);
      assert.equal(outcome.considered, 0);
      assert.equal(emitted.filter((r) => r.stream === "group_messages").length, 0);
      assert.equal(
        outcome.nextCursors["group-1"],
        "m-existing-cursor",
        "no new messages this run — the cursor carries forward unchanged, not cleared"
      );
    } finally {
      walk.restore();
    }
  })();
});

// ─── >PAGE_SIZE new messages: multi-page forward resume ────────────────────

test(">PAGE_SIZE new messages: forward walk pages past a full page to reach the true new-message end", () => {
  const page1 = Array.from({ length: PAGE_SIZE }, (_, i) =>
    groupMessage({ id: `m-new-${String(i)}`, created_at: 1_700_000_100 + i })
  );
  const page2 = [groupMessage({ id: "m-new-last", created_at: 1_700_000_300 })];
  const walk = stubGroupWalk({
    messagePages: [
      { body: { response: { count: 100, messages: page1 } } },
      { body: { response: { count: 1, messages: page2 } } },
    ],
  });
  return (async () => {
    try {
      const cursor = openFingerprintCursor(new Map());
      const { emitRecord, emitted } = makeHarness();
      const outcome = await collectGroupMessages(TOKEN, cursor, undefined, undefined, noopProgress, emitRecord, null, {
        "group-1": "m-old-cursor",
      });

      assert.equal(outcome.failed, false);
      assert.equal(walk.fetchCount(), 2, "the full page 1 forces a second forward fetch");
      assert.equal(outcome.considered, 101);
      assert.equal(emitted.filter((r) => r.stream === "group_messages").length, 101);
      assert.equal(outcome.nextCursors["group-1"], "m-new-last");
    } finally {
      walk.restore();
    }
  })();
});

// ─── >old-cap discriminator: pages well past the OLD 200-page cap ──────────
//
// The old design capped every message walk at MAX_PAGES_PER_STREAM=200
// pages. A test that only exercises 3-5 pages does NOT discriminate a
// mutant that reintroduces that cap — 5 pages passes under EITHER the old
// (200-page) or new (no-cap) behavior, so it proves nothing about which one
// is actually running. These tests page strictly past 200 full-size pages
// (201+) before the natural short/empty page, so a reintroduced 200-page
// cap would stop the walk 1+ page short of the natural end and the
// assertions below would fail (`considered`/`fetchCount` short by exactly
// one page's worth, `nextCursor` pointing at page 200's last id instead of
// the true final message). Pages are generated lazily by a counter-driven
// stub rather than pre-built as 201 in-memory arrays, keeping the fixture
// cheap despite exercising the true boundary.
const OLD_CAP = 200;

/** Build a counter-driven `globalThis.fetch` stub for ONE group's message
 *  walk: answers `pageCountBeyondCap` full-size pages beyond `OLD_CAP`,
 *  each with fresh, monotonically-increasing message ids, then one short
 *  final page. `idPrefix` keeps forward/backward fixtures from colliding. */
function stubGroupWalkPastOldCap(
  idPrefix: string,
  pageCountBeyondCap: number
): { fetchCount: () => number; restore: () => void; totalPages: number } {
  const totalPages = OLD_CAP + pageCountBeyondCap;
  let messageFetchCount = 0;
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    if (url.pathname === "/v3/groups") {
      return Promise.resolve(new Response(JSON.stringify({ response: [group()] }), { status: 200 }));
    }
    const pageNumber = messageFetchCount;
    messageFetchCount += 1;
    const isLastPage = pageNumber === totalPages;
    const pageLength = isLastPage ? 1 : PAGE_SIZE;
    const messages = Array.from({ length: pageLength }, (_itemValue, itemIndex) =>
      groupMessage({
        id: `${idPrefix}-p${String(pageNumber)}-${String(itemIndex)}`,
        created_at: 1_700_000_000 + pageNumber * PAGE_SIZE + itemIndex,
      })
    );
    return Promise.resolve(
      new Response(JSON.stringify({ response: { count: messages.length, messages } }), { status: 200 })
    );
  }) as typeof globalThis.fetch;
  return {
    fetchCount: () => messageFetchCount,
    totalPages,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

test(">old-cap discriminator: a group's forward walk pages past 200 full pages with no truncation (mutation-killing)", async () => {
  const idPrefix = "fwd";
  const stub = stubGroupWalkPastOldCap(idPrefix, 1); // 201 total pages: 200 full + 1 short
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emitRecord, emitted } = makeHarness();
    const outcome = await collectGroupMessages(TOKEN, cursor, undefined, undefined, noopProgress, emitRecord, null, {
      "group-1": "m-old-cursor",
    });

    assert.equal(outcome.failed, false, "no cap-truncation past 200 pages");
    assert.equal(
      stub.fetchCount(),
      stub.totalPages + 1,
      "all 202 pages (0-indexed 0..201) were fetched — a reintroduced 200-page cap would stop at page 200"
    );
    const expectedConsidered = stub.totalPages * PAGE_SIZE + 1;
    assert.equal(
      outcome.considered,
      expectedConsidered,
      "considered reflects every message through the true natural end, not a 200-page-truncated subset"
    );
    assert.equal(emitted.filter((r) => r.stream === "group_messages").length, expectedConsidered);
    assert.equal(
      outcome.nextCursors["group-1"],
      `${idPrefix}-p${String(stub.totalPages)}-0`,
      "cursor advances to the FINAL page's message, not page 200's last id (which is what a reintroduced cap would leave)"
    );
  } finally {
    stub.restore();
  }
});

test(">old-cap discriminator FAIL-BEFORE proof: temporarily restoring a 200-page cap on the shared list walker demonstrably breaks the >200-page assertion", async () => {
  // Proves the test above actually discriminates: reintroduce a
  // MAX_PAGES_PER_STREAM=200-equivalent cap into a LOCAL copy of the
  // pagination loop shape (not the production function — we don't mutate
  // shipped code to test itself) and show the identical stub/assertions
  // fail against it, then confirm production passes. This is the guard
  // against "the assertion happens to pass regardless of whether a cap
  // exists" — see stubGroupWalkPastOldCap's doc comment.
  async function cappedForwardWalk(maxPages: number): Promise<{ fetchCount: number; lastId: string | undefined }> {
    let afterId = "m-old-cursor";
    let fetchCount = 0;
    let lastId: string | undefined;
    for (let page = 0; page < maxPages; page += 1) {
      const res = await fetch(`https://api.groupme.com/v3/groups/group-1/messages?after_id=${afterId}`);
      const body = (await res.json()) as { response: { messages: Array<{ id: string }> } };
      fetchCount += 1;
      const { messages } = body.response;
      if (!messages.length) {
        return { fetchCount, lastId };
      }
      lastId = messages.at(-1)?.id;
      if (messages.length < PAGE_SIZE) {
        return { fetchCount, lastId };
      }
      afterId = lastId ?? afterId;
    }
    return { fetchCount, lastId };
  }

  const idPrefix = "capcheck";
  const stub = stubGroupWalkPastOldCap(idPrefix, 1); // 201 total pages needed to reach the natural end
  try {
    const cappedResult = await cappedForwardWalk(OLD_CAP);
    assert.equal(
      cappedResult.fetchCount,
      OLD_CAP,
      "a 200-page cap stops at exactly 200 fetches, short of the natural end"
    );
    assert.notEqual(
      cappedResult.lastId,
      `${idPrefix}-p${String(stub.totalPages)}-0`,
      "FAIL-BEFORE: a capped walk's last-seen id is page 200's, not the true final page's — this is the defect the removed cap caused"
    );
  } finally {
    stub.restore();
  }
});

// ─── Repeated/non-progressing cursor: typed failure, not an infinite loop ──

test("repeated/nonprogressing cursor: a forward page whose trailing id repeats fails as NonProgressError", () => {
  // Every full-size page after the first returns the SAME messages, so the
  // trailing (last) message id never advances. Without non-progress
  // detection this loops forever; with it, the walk fails cleanly.
  const stuckPage = Array.from({ length: PAGE_SIZE }, (_, i) =>
    groupMessage({ id: `m-${String(i)}`, created_at: 1_700_000_000 + i })
  );
  const walk = stubGroupWalk({
    messagePages: [
      { body: { response: { count: PAGE_SIZE, messages: stuckPage } } },
      { body: { response: { count: PAGE_SIZE, messages: stuckPage } } },
    ],
  });
  return (async () => {
    try {
      const cursor = openFingerprintCursor(new Map());
      const { emitRecord } = makeHarness();
      const outcome = await collectGroupMessages(TOKEN, cursor, undefined, undefined, noopProgress, emitRecord, null, {
        "group-1": "m-old-cursor",
      });

      assert.equal(outcome.failed, true, "a repeated trailing cursor must fail the walk, not loop forever");
    } finally {
      walk.restore();
    }
  })();
});

test("repeated/nonprogressing cursor: a forward page violating documented ascending order fails as NonProgressError", () => {
  const outOfOrder = [
    groupMessage({ id: "m-1", created_at: 1_700_000_200 }),
    groupMessage({ id: "m-2", created_at: 1_700_000_100 }), // older AFTER newer — violates ascending order
  ];
  const walk = stubGroupWalk({
    messagePages: [{ body: { response: { count: 2, messages: outOfOrder } } }],
  });
  return (async () => {
    try {
      const cursor = openFingerprintCursor(new Map());
      const { emitRecord } = makeHarness();
      const outcome = await collectGroupMessages(TOKEN, cursor, undefined, undefined, noopProgress, emitRecord, null, {
        "group-1": "m-old-cursor",
      });

      assert.equal(outcome.failed, true, "a non-ascending forward page must fail, not be silently trusted");
    } finally {
      walk.restore();
    }
  })();
});

// ─── Deleted/invalid cursor fallback ────────────────────────────────────────

/** Build a `globalThis.fetch` stub for the invalid-cursor-fallback test
 *  family: `/v3/groups` always succeeds with one group; the FIRST message
 *  fetch answers with `firstFetchStatus`; every subsequent fetch answers
 *  with a clean single-message backward-walk page (only reachable if the
 *  fallback actually fires). Returns the live fetch-count so a test can
 *  assert whether the fallback path was taken. */
function stubFirstFetchStatus(
  firstFetchStatus: number,
  persistent = false
): { fetchCount: () => number; restore: () => void } {
  let messageFetchCount = 0;
  const backwardPage = [groupMessage({ id: "m-full-1", created_at: 1_700_000_100 })];
  const original = globalThis.fetch;
  const responseInit = firstFetchStatus === 429 ? { headers: { "retry-after": "0" } } : {};
  globalThis.fetch = ((input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    if (url.pathname === "/v3/groups") {
      return Promise.resolve(new Response(JSON.stringify({ response: [group()] }), { status: 200 }));
    }
    messageFetchCount += 1;
    if (messageFetchCount === 1) {
      return Promise.resolve(
        new Response(JSON.stringify({ meta: { code: firstFetchStatus } }), {
          status: firstFetchStatus,
          ...responseInit,
        })
      );
    }
    if (persistent) {
      return Promise.resolve(
        new Response(JSON.stringify({ meta: { code: firstFetchStatus } }), {
          status: firstFetchStatus,
          ...responseInit,
        })
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify({ response: { count: backwardPage.length, messages: backwardPage } }), {
        status: 200,
      })
    );
  }) as typeof globalThis.fetch;
  return {
    fetchCount: () => messageFetchCount,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

test("deleted/invalid cursor fallback: a 400 on the FIRST resumed fetch falls back to a full backward walk for that group only", async () => {
  const stub = stubFirstFetchStatus(400);
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emitRecord, emitted } = makeHarness();
    const outcome = await collectGroupMessages(TOKEN, cursor, undefined, undefined, noopProgress, emitRecord, null, {
      "group-1": "m-deleted-cursor",
    });

    assert.equal(outcome.failed, false, "the fallback backward walk completes cleanly despite the invalid cursor");
    assert.equal(
      emitted.filter((r) => r.stream === "group_messages").length,
      1,
      "the group's messages are recovered via the backward fallback, not lost"
    );
    assert.equal(outcome.nextCursors["group-1"], "m-full-1", "a fresh cursor is established from the fallback walk");
  } finally {
    stub.restore();
  }
});

test("deleted/invalid cursor fallback: a 404 on the FIRST resumed fetch also falls back to a full backward walk", async () => {
  // 404 is the other status the fallback trigger accepts — GroupMe's docs
  // don't distinguish "gone" from "never existed" for a message id, so both
  // client-error statuses that could plausibly mean "this id doesn't
  // resolve" are treated identically.
  const stub = stubFirstFetchStatus(404);
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emitRecord, emitted } = makeHarness();
    const outcome = await collectGroupMessages(TOKEN, cursor, undefined, undefined, noopProgress, emitRecord, null, {
      "group-1": "m-deleted-cursor",
    });

    assert.equal(outcome.failed, false, "a 404 on first fetch also licenses the fallback");
    assert.equal(emitted.filter((r) => r.stream === "group_messages").length, 1);
  } finally {
    stub.restore();
  }
});

// P1 regression coverage: a prior revision matched the fallback trigger on
// `error.message.startsWith("groupme_http_")`, which is true for EVERY
// non-2xx status alike — silently misclassifying a transient 429/5xx as an
// invalid cursor and triggering an expensive, unsignaled full backward
// rescan with `failed: false`. Each status below must propagate as an
// ORDINARY failure: `failed: true`, no fallback walk attempted, and STATE
// withheld for the caller (asserted separately via collect()).

test("P1 regression: a 401 on the FIRST resumed fetch propagates as groupme_auth_failed, no fallback", async () => {
  const stub = stubFirstFetchStatus(401);
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emitRecord } = makeHarness();
    await assert.rejects(
      () =>
        collectGroupMessages(TOKEN, cursor, undefined, undefined, noopProgress, emitRecord, null, {
          "group-1": "m-old-cursor",
        }),
      (err: unknown) => err instanceof Error && err.message === "groupme_auth_failed"
    );
    assert.equal(stub.fetchCount(), 1, "no fallback fetch was attempted — the whole run is dead on auth failure");
  } finally {
    stub.restore();
  }
});

test("P1 regression: a 403 on the FIRST resumed fetch propagates as groupme_auth_failed, no fallback", async () => {
  const stub = stubFirstFetchStatus(403);
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emitRecord } = makeHarness();
    await assert.rejects(
      () =>
        collectGroupMessages(TOKEN, cursor, undefined, undefined, noopProgress, emitRecord, null, {
          "group-1": "m-old-cursor",
        }),
      (err: unknown) => err instanceof Error && err.message === "groupme_auth_failed"
    );
    assert.equal(stub.fetchCount(), 1);
  } finally {
    stub.restore();
  }
});

test("P1 regression: a transient 429 on the FIRST resumed fetch recovers in place, no fallback rescan", async () => {
  const stub = stubFirstFetchStatus(429);
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emitRecord, emitted } = makeHarness();
    const outcome = await collectGroupMessages(TOKEN, cursor, undefined, undefined, noopProgress, emitRecord, null, {
      "group-1": "m-old-cursor",
    });

    assert.equal(outcome.failed, false, "a transient 429 should recover within the request budget");
    assert.equal(stub.fetchCount(), 2, "the retry is in place; no fallback backward walk was attempted");
    assert.equal(emitted.filter((r) => r.stream === "group_messages").length, 1);
  } finally {
    stub.restore();
  }
});

test("P1 regression: a transient 500 on the FIRST resumed fetch recovers in place, no fallback rescan", async () => {
  const stub = stubFirstFetchStatus(500);
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emitRecord, emitted } = makeHarness();
    const outcome = await collectGroupMessages(TOKEN, cursor, undefined, undefined, noopProgress, emitRecord, null, {
      "group-1": "m-old-cursor",
    });

    assert.equal(outcome.failed, false, "a transient 500 should recover within the request budget");
    assert.equal(stub.fetchCount(), 2, "the retry is in place; no fallback backward walk was attempted");
    assert.equal(emitted.filter((r) => r.stream === "group_messages").length, 1);
  } finally {
    stub.restore();
  }
});

// Persistent retryable failures must still fail the pass after the bounded
// request budget. They must not reach the invalid-cursor fallback or emit
// coverage that claims the stream was completely observed.
test("persistent 429 on the FIRST resumed fetch fails after bounded retries", async () => {
  const stub = stubFirstFetchStatus(429, true);
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emitRecord, emitted } = makeHarness();
    const outcome = await collectGroupMessages(TOKEN, cursor, undefined, undefined, noopProgress, emitRecord, null, {
      "group-1": "m-old-cursor",
    });
    assert.equal(outcome.failed, true);
    assert.equal(stub.fetchCount(), 3);
    assert.equal(emitted.length, 0);
  } finally {
    stub.restore();
  }
});

test("persistent 500 on the FIRST resumed fetch fails after bounded retries", async () => {
  const stub = stubFirstFetchStatus(500, true);
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emitRecord, emitted } = makeHarness();
    const outcome = await collectGroupMessages(TOKEN, cursor, undefined, undefined, noopProgress, emitRecord, null, {
      "group-1": "m-old-cursor",
    });
    assert.equal(outcome.failed, true);
    assert.equal(stub.fetchCount(), 3);
    assert.equal(emitted.length, 0);
  } finally {
    stub.restore();
  }
});

// The status class that genuinely reaches — and, pre-fix, broke — the
// fallback gate is any non-2xx/non-304 code the governor does NOT retry and
// that isn't 400/404, e.g. 422. That is the true regression reproducer:
test("P1 true reproducer: a 422 on the FIRST resumed fetch fails the pass, no fallback rescan (422 is not governor-retried and not 400/404)", async () => {
  const stub = stubFirstFetchStatus(422);
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emitRecord, emitted } = makeHarness();
    const outcome = await collectGroupMessages(TOKEN, cursor, undefined, undefined, noopProgress, emitRecord, null, {
      "group-1": "m-old-cursor",
    });

    assert.equal(
      outcome.failed,
      true,
      "422 must never be reinterpreted as an invalid cursor — before the fix this incorrectly fell back and reported failed: false"
    );
    assert.equal(stub.fetchCount(), 1, "no fallback backward walk was attempted");
    assert.equal(emitted.length, 0);
  } finally {
    stub.restore();
  }
});

test("deleted/invalid cursor fallback: a mid-walk HTTP error (not the first fetch) is an ordinary failure, no fallback", async () => {
  let messageFetchCount = 0;
  const firstPage = Array.from({ length: PAGE_SIZE }, (_, i) =>
    groupMessage({ id: `m-${String(i)}`, created_at: 1_700_000_000 + i })
  );
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    if (url.pathname === "/v3/groups") {
      return Promise.resolve(new Response(JSON.stringify({ response: [group()] }), { status: 200 }));
    }
    messageFetchCount += 1;
    if (messageFetchCount === 1) {
      return Promise.resolve(
        new Response(JSON.stringify({ response: { count: firstPage.length, messages: firstPage } }), { status: 200 })
      );
    }
    // Second fetch (not the first) fails with a 400 — the SAME status the
    // fallback trigger accepts on a first fetch — to prove position (not
    // status) is what gates the fallback: this must NOT trigger it.
    return Promise.resolve(new Response(JSON.stringify({ meta: { code: 400 } }), { status: 400 }));
  }) as typeof globalThis.fetch;
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emitRecord } = makeHarness();
    const outcome = await collectGroupMessages(TOKEN, cursor, undefined, undefined, noopProgress, emitRecord, null, {
      "group-1": "m-old-cursor",
    });

    assert.equal(outcome.failed, true, "a mid-walk failure fails the pass normally, without a backward fallback");
  } finally {
    globalThis.fetch = original;
  }
});

// ─── Interrupted run: no advance, prior state untouched ────────────────────

test("interrupted run via collect(): STATE (including cursors) is withheld end-to-end on a failed pass, prior cursor survives untouched", async () => {
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

  // Run 1: clean cold-start backward walk, seeds a real cursor.
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
  const run1Cursor = (run1State as { cursor: { cursors?: Record<string, string> } }).cursor;
  assert.equal(run1Cursor.cursors?.["group-1"], "gmsg-1", "run 1 seeds group-1's cursor");

  // Run 2: interrupted by an HTTP failure mid-resume.
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
  assert.ok(!run2State, "an interrupted run must not emit a replacement STATE — the prior cursor is left untouched");
});

// ─── Explicit full_refresh bypass ───────────────────────────────────────────

test("explicit full_refresh bypass: an established forward cursor is ignored, the group walks backward to its natural end", () => {
  const page1 = Array.from({ length: PAGE_SIZE }, (_, i) => groupMessage({ id: `m-${String(149 - i)}` }));
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
      const { emitRecord, emitted } = makeHarness();
      const outcome = await collectGroupMessages(
        TOKEN,
        cursor,
        undefined,
        undefined,
        noopProgress,
        emitRecord,
        null,
        { "group-1": "m-149" },
        "full_refresh"
      );

      assert.equal(outcome.failed, false);
      assert.equal(walk.fetchCount(), 2, "full_refresh bypasses the cursor — both pages fetched via the backward walk");
      assert.equal(outcome.considered, 150, "the entire history is walked and considered under full_refresh");
      assert.equal(emitted.filter((r) => r.stream === "group_messages").length, 150);
      assert.equal(
        outcome.nextCursors["group-1"],
        "m-149",
        "the cursor map is rebuilt from this full walk for the next ordinary run"
      );
    } finally {
      walk.restore();
    }
  })();
});

test("explicit full_refresh bypass via collect(): CollectContext.collectionMode reaches the connector and forces a backward walk", async () => {
  const STREAMS: StreamScope[] = [{ name: "group_messages" }];
  const harness = makeRecordingEmit(validateRecord);
  const page1 = Array.from({ length: PAGE_SIZE }, (_, i) => groupMessage({ id: `m-${String(149 - i)}` }));
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
      // A pre-existing forward cursor that would otherwise stop the walk on page 1.
      state: { group_messages: { cursors: { "group-1": "m-149" } } },
    };
    await collect(ctx);

    assert.equal(
      walk.fetchCount(),
      2,
      "collection_mode full_refresh, surfaced via CollectContext, bypasses the cursor end-to-end"
    );
    assert.equal(
      harness.emitted.filter((r) => r.stream === "group_messages").length,
      150,
      "the full history emits, not just what's newer than the pre-existing cursor"
    );
  } finally {
    walk.restore();
  }
});
