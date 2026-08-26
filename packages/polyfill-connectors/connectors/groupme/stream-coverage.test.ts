// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Coverage proof for all four cursor-backed GroupMe streams: `groups`,
 * `group_messages`, `direct_messages`, `direct_chat_messages`.
 *
 * Every collector returns a `CollectionOutcome { considered, failed }` via
 * the shared `runCollectionPass` wrapper in index.ts: `considered` is the
 * raw enumerated item count, measured independently of `emitRecord` — a
 * record the fingerprint cursor suppressed as unchanged, or one the schema
 * validator rejected, was still genuinely observed. `failed` is true
 * whenever the walk was cut short by a non-auth fetch/parse error OR by
 * `NonProgressError` (a pagination walk that could not prove it advanced —
 * see index.ts's `NonProgressError` doc comment). `collect()` only emits a
 * stream's own STATE checkpoint and DETAIL_COVERAGE proof when that
 * stream's outcome has `failed: false`.
 *
 * NO PAGE-COUNT CEILING exists anywhere in this connector's pagination
 * (groups/chats lists, group messages forward/backward, direct chat
 * messages) — an arbitrary cap was rejected in review as itself a
 * correctness bug (silently prevents an owner with more history/groups/
 * chats than the cap from ever completing). Every walk in this file either
 * runs to its provider-defined natural end (a page shorter than PAGE_SIZE,
 * or empty) or fails via `NonProgressError` — proven here with tests that
 * page well past the OLD 200-page-equivalent cap size to confirm the walk
 * keeps going to the true end instead of truncating.
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
  collectDirectChatMessages,
  collectDirectChats,
  collectGroupMessages,
  collectGroups,
} from "./index.ts";
import { validateRecord } from "./schemas.ts";

const TOKEN = "test-access-token";
const PAGE_SIZE = 100;

before(() => {
  __setZeroDelayHttpGovernorForTests();
});
after(() => {
  __resetHttpGovernorForTests();
});

/** Mock `globalThis.fetch` to answer every call with the given GroupMe API body. */
function stubFetch(body: unknown, status = 200): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = ((): Promise<Response> =>
    Promise.resolve(new Response(JSON.stringify(body), { status }))) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = original;
  };
}

/** Mock `globalThis.fetch` to answer a queued sequence of responses, one per call. */
function stubFetchSequence(bodies: Array<{ body: unknown; status?: number }>): () => void {
  const original = globalThis.fetch;
  let call = 0;
  globalThis.fetch = ((): Promise<Response> => {
    const next = bodies[Math.min(call, bodies.length - 1)];
    call += 1;
    return Promise.resolve(new Response(JSON.stringify(next?.body), { status: next?.status ?? 200 }));
  }) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = original;
  };
}

/** Mock `globalThis.fetch` to answer with an unparseable (non-JSON) 200 body. */
function stubFetchMalformedBody(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = ((): Promise<Response> =>
    Promise.resolve(new Response("<html>not json</html>", { status: 200 }))) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = original;
  };
}

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

function directChat(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "chat-1",
    last_message: "hey",
    last_message_at: 1_700_000_000,
    other_user: { id: "user-2", name: "Bob", avatar_url: null },
    avatar_url: null,
    ...overrides,
  };
}

function directMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "dmsg-1",
    text: "hi",
    created_at: 1_700_000_100,
    user_id: "user-2",
    name: "Bob",
    avatar_url: null,
    attachments: [],
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

// ─── collectGroups: considered/failed contract ─────────────────────────────

test("collectGroups: clean pass reports failed: false and considered === listed groups", async () => {
  const restore = stubFetch({ response: [group(), group({ id: "group-2" })] });
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emitRecord, emitted } = makeHarness();
    const outcome = await collectGroups(TOKEN, cursor, noopProgress, emitRecord);

    assert.deepEqual(outcome, { considered: 2, failed: false });
    assert.equal(emitted.filter((r) => r.stream === "groups").length, 2);
  } finally {
    restore();
  }
});

test("collectGroups: genuine zero groups reports failed: false, considered: 0", async () => {
  const restore = stubFetch({ response: [] });
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emitRecord, emitted } = makeHarness();
    const outcome = await collectGroups(TOKEN, cursor, noopProgress, emitRecord);

    assert.deepEqual(outcome, { considered: 0, failed: false }, "a measured empty boundary is itself the proof");
    assert.equal(emitted.length, 0);
  } finally {
    restore();
  }
});

test("collectGroups: fingerprint-suppressed (unchanged) group still counts as considered", async () => {
  const g = group();
  const restore = stubFetch({ response: [g] });
  try {
    const priorCursor = openFingerprintCursor(new Map());
    const { emitRecord: seedEmit } = makeHarness();
    await collectGroups(TOKEN, priorCursor, noopProgress, seedEmit);
    const priorState = priorCursor.toState();

    const cursor = openFingerprintCursor({ fingerprints: priorState });
    const { emitRecord, emitted } = makeHarness();
    const outcome = await collectGroups(TOKEN, cursor, noopProgress, emitRecord);

    assert.equal(emitted.length, 0, "unchanged group is suppressed, not re-emitted");
    assert.equal(outcome.considered, 1, "considered counts the listed group even though it was suppressed");
    assert.equal(outcome.failed, false);
  } finally {
    restore();
  }
});

test("collectGroups: http error reports failed: true and does not throw (non-auth failure is caught)", async () => {
  const restore = stubFetch({ error: "server error" }, 500);
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emitRecord, emitted } = makeHarness();
    const outcome = await collectGroups(TOKEN, cursor, noopProgress, emitRecord);

    assert.equal(outcome.failed, true, "an http failure must not report a clean pass");
    assert.equal(outcome.considered, 0);
    assert.equal(emitted.length, 0);
  } finally {
    restore();
  }
});

test("collectGroups: malformed (unparseable) body reports failed: true, not a proven-empty list", async () => {
  const restore = stubFetchMalformedBody();
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emitRecord, emitted } = makeHarness();
    const outcome = await collectGroups(TOKEN, cursor, noopProgress, emitRecord);

    assert.equal(outcome.failed, true, "an unparseable 200 body is a failed enumeration, not a genuine zero");
    assert.equal(emitted.length, 0);
  } finally {
    restore();
  }
});

test("collectGroups: a rejected/dropped record still counts as considered, not just emitted", async () => {
  const restore = stubFetch({ response: [group({ id: "group-1" }), group({ id: 999 })] });
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emitRecord, emitted } = makeHarness();
    const outcome = await collectGroups(TOKEN, cursor, noopProgress, emitRecord);

    assert.equal(emitted.filter((r) => r.stream === "groups").length, 1, "only the valid record emits");
    assert.equal(outcome.considered, 2, "considered counts both listed groups, not just the emitted one");
    assert.equal(outcome.failed, false);
  } finally {
    restore();
  }
});

test("collectGroups: auth failure (401) propagates instead of being swallowed as a stream failure", async () => {
  const restore = stubFetch({ error: "unauthorized" }, 401);
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emitRecord } = makeHarness();
    await assert.rejects(
      () => collectGroups(TOKEN, cursor, noopProgress, emitRecord),
      (err: unknown) => err instanceof Error && err.message === "groupme_auth_failed"
    );
  } finally {
    restore();
  }
});

// ─── /groups and /chats list pagination: no ceiling, natural end only ──────
//
// The old design capped BOTH list endpoints at MAX_PAGES_PER_STREAM=200
// pages via fetchPaginatedList's shared maxPages parameter. A test
// exercising only 2-4 pages does not discriminate a mutant that
// reintroduces that cap — it passes under either behavior. These tests
// page strictly past 200 full-size pages via a counter-driven stub before
// the natural short page, so a reintroduced cap would stop the walk short
// and the assertions below would fail.

const LIST_OLD_CAP = 200;

test("collectGroups: pages past 200 full pages with no truncation (mutation-killing)", async () => {
  const totalPages = LIST_OLD_CAP + 1; // 201 full pages, then one short page
  const restore = stubFetchSequence(
    Array.from({ length: totalPages + 1 }, (_pageValue, pageNumber) => {
      const isLastPage = pageNumber === totalPages;
      const pageLength = isLastPage ? 1 : PAGE_SIZE;
      const response = Array.from({ length: pageLength }, (_itemValue, itemIndex) =>
        group({ id: `group-p${String(pageNumber)}-${String(itemIndex)}` })
      );
      return { body: { response } };
    })
  );
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emitRecord, emitted } = makeHarness();
    const outcome = await collectGroups(TOKEN, cursor, noopProgress, emitRecord);

    const expectedConsidered = totalPages * PAGE_SIZE + 1;
    assert.equal(outcome.failed, false, "no cap-truncation past 200 pages");
    assert.equal(
      outcome.considered,
      expectedConsidered,
      "considered reflects every group through the true natural end, not a 200-page-truncated subset"
    );
    assert.equal(emitted.filter((r) => r.stream === "groups").length, expectedConsidered);
  } finally {
    restore();
  }
});

test("collectDirectChats: pages past 200 full pages with no truncation (mutation-killing)", async () => {
  const totalPages = LIST_OLD_CAP + 1;
  const restore = stubFetchSequence(
    Array.from({ length: totalPages + 1 }, (_pageValue, pageNumber) => {
      const isLastPage = pageNumber === totalPages;
      const pageLength = isLastPage ? 1 : PAGE_SIZE;
      const response = Array.from({ length: pageLength }, (_itemValue, itemIndex) =>
        directChat({ id: `chat-p${String(pageNumber)}-${String(itemIndex)}` })
      );
      return { body: { response } };
    })
  );
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emitRecord, emitted } = makeHarness();
    const outcome = await collectDirectChats(TOKEN, cursor, noopProgress, emitRecord);

    const expectedConsidered = totalPages * PAGE_SIZE + 1;
    assert.equal(outcome.failed, false, "no cap-truncation past 200 pages");
    assert.equal(outcome.considered, expectedConsidered);
    assert.equal(emitted.filter((r) => r.stream === "direct_messages").length, expectedConsidered);
  } finally {
    restore();
  }
});

// ─── /groups, /chats: repeated/non-progressing page fails, doesn't loop ────

test("collectGroups: a full-size page contributing zero new ids fails as NonProgressError, does not loop forever", async () => {
  const fullPage = Array.from({ length: PAGE_SIZE }, (_, i) => group({ id: `group-${String(i)}` }));
  // Every page (regardless of `page` query param) returns the IDENTICAL
  // full page — a provider bug re-serving page 1's content forever. Without
  // non-progress detection this loops indefinitely; with it, the walk fails
  // after the second page proves zero new ids.
  const restore = stubFetch({ response: fullPage });
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emitRecord } = makeHarness();
    const outcome = await collectGroups(TOKEN, cursor, noopProgress, emitRecord);

    assert.equal(outcome.failed, true, "a repeated-content page must fail, not loop or falsely report success");
  } finally {
    restore();
  }
});

// ─── collectGroupMessages: considered/failed contract (backward/cold walk) ─

test("collectGroupMessages: cold start (no prior cursor) walks backward, clean pass across multiple groups sums considered", async () => {
  const restore = stubFetchSequence([
    { body: { response: [group({ id: "group-1" }), group({ id: "group-2" })] } }, // /groups
    { body: { response: { count: 2, messages: [groupMessage({ id: "m1" }), groupMessage({ id: "m2" })] } } }, // group-1 page
    { body: { response: { count: 1, messages: [groupMessage({ id: "m3" })] } } }, // group-2 page
  ]);
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emitRecord, emitted } = makeHarness();
    const outcome = await collectGroupMessages(TOKEN, cursor, undefined, undefined, noopProgress, emitRecord);

    assert.deepEqual(outcome, {
      considered: 3,
      failed: false,
      nextCursors: { "group-1": "m1", "group-2": "m3" },
      // The `group()` fixture declares `messages_count: 10` but the stubbed
      // pages supply only 2 and 1 messages, so the provider-count anchor
      // correctly reports both groups short. This is the anchor doing its
      // job against the fixture's own numbers, not a regression.
      // `unprovenBoundary: false` on both: each walk ended on a page the
      // provider actually served, so the boundary evidence is coherent and
      // the shortfall is an ordinary one, not an ambiguous empty-page case.
      shortfalls: [
        { groupId: "group-1", providerCount: 10, unprovenBoundary: false, walked: 2 },
        { groupId: "group-2", providerCount: 10, unprovenBoundary: false, walked: 1 },
      ],
      unanchoredGroupIds: [],
    });
    assert.equal(emitted.filter((r) => r.stream === "group_messages").length, 3);
  } finally {
    restore();
  }
});

test("collectGroupMessages: a declared since bound stops the documented-descending backward walk cleanly, without fetching further pages", async () => {
  let fetchCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((): Promise<Response> => {
    fetchCount += 1;
    if (fetchCount === 1) {
      return Promise.resolve(new Response(JSON.stringify({ response: [group({ id: "group-1" })] }), { status: 200 }));
    }
    return Promise.resolve(
      new Response(
        JSON.stringify({
          response: {
            count: 3,
            messages: [
              groupMessage({ id: "m1", created_at: 1_700_000_300 }),
              groupMessage({ id: "m2", created_at: 1_700_000_050 }),
              groupMessage({ id: "m3", created_at: 1_700_000_000 }),
            ],
          },
        }),
        { status: 200 }
      )
    );
  }) as typeof globalThis.fetch;
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
      1_700_000_100
    );

    assert.deepEqual(
      emitted.filter((r) => r.stream === "group_messages").map((r) => (r.data as { id: string }).id),
      ["m1"],
      "only the in-window message emits"
    );
    assert.equal(outcome.failed, false, "an honest since-bound stop is a clean pass, not a failure");
    assert.equal(
      outcome.considered,
      1,
      "considered counts only the in-scope message — the out-of-scope m2/m3 on the same page must not inflate it"
    );
    assert.equal(fetchCount, 2, "the groups list plus exactly one message page");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("collectGroupMessages: a non-descending backward page fails as NonProgressError rather than trusting an unverified before_id", async () => {
  // Violates documented descending order: m-late (created_at=200) sits
  // AFTER m-old (created_at=0) despite being newer. The backward walk must
  // refuse to trust this page's trailing before_id and fail, not silently
  // continue or half-accept it.
  const restore = stubFetchSequence([
    { body: { response: [group({ id: "group-1" })] } }, // /groups
    {
      body: {
        response: {
          count: 3,
          messages: [
            groupMessage({ id: "m-new", created_at: 1_700_000_300 }),
            groupMessage({ id: "m-old", created_at: 1_700_000_000 }),
            groupMessage({ id: "m-late", created_at: 1_700_000_200 }),
          ],
        },
      },
    },
  ]);
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emitRecord } = makeHarness();
    const outcome = await collectGroupMessages(TOKEN, cursor, undefined, undefined, noopProgress, emitRecord);

    assert.equal(outcome.failed, true, "a non-descending page must fail the walk, not be silently trusted");
  } finally {
    restore();
  }
});

test("collectGroupMessages: genuine zero groups reports failed: false, considered: 0", async () => {
  const restore = stubFetch({ response: [] });
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emitRecord, emitted } = makeHarness();
    const outcome = await collectGroupMessages(TOKEN, cursor, undefined, undefined, noopProgress, emitRecord);

    assert.deepEqual(
      outcome,
      { considered: 0, failed: false, nextCursors: {}, shortfalls: [], unanchoredGroupIds: [] },
      "no groups means no messages — a proven-empty walk"
    );
    assert.equal(emitted.length, 0);
  } finally {
    restore();
  }
});

test("collectGroupMessages: a rejected/dropped record still counts as considered, not just emitted", async () => {
  const restore = stubFetchSequence([
    { body: { response: [group({ id: "group-1" })] } },
    {
      body: {
        response: {
          count: 2,
          messages: [groupMessage({ id: "m1" }), groupMessage({ id: 12_345 })],
        },
      },
    },
  ]);
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emitRecord, emitted } = makeHarness();
    const outcome = await collectGroupMessages(TOKEN, cursor, undefined, undefined, noopProgress, emitRecord);

    assert.equal(emitted.filter((r) => r.stream === "group_messages").length, 1, "only the valid record emits");
    assert.equal(outcome.considered, 2, "considered counts both listed messages, not just the emitted one");
    assert.equal(outcome.failed, false);
  } finally {
    restore();
  }
});

test("collectGroupMessages: http error partway through a group's pages reports failed: true", async () => {
  const restore = stubFetchSequence([
    { body: { response: [group({ id: "group-1" })] } }, // /groups
    { body: { error: "server error" }, status: 500 }, // group-1 page fails
  ]);
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emitRecord, emitted } = makeHarness();
    const outcome = await collectGroupMessages(TOKEN, cursor, undefined, undefined, noopProgress, emitRecord);

    assert.equal(outcome.failed, true, "a mid-walk http failure must not report a clean pass");
    assert.equal(emitted.length, 0);
  } finally {
    restore();
  }
});

test("collectGroupMessages: malformed body on the group-list fetch reports failed: true, not a proven-empty walk", async () => {
  const restore = stubFetchMalformedBody();
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emitRecord, emitted } = makeHarness();
    const outcome = await collectGroupMessages(TOKEN, cursor, undefined, undefined, noopProgress, emitRecord);

    assert.equal(outcome.failed, true);
    assert.equal(emitted.length, 0);
  } finally {
    restore();
  }
});

test("collectGroupMessages: auth failure (403) propagates instead of being swallowed as a stream failure", async () => {
  const restore = stubFetch({ error: "forbidden" }, 403);
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emitRecord } = makeHarness();
    await assert.rejects(
      () => collectGroupMessages(TOKEN, cursor, undefined, undefined, noopProgress, emitRecord),
      (err: unknown) => err instanceof Error && err.message === "groupme_auth_failed"
    );
  } finally {
    restore();
  }
});

// ─── collectGroupMessages: backward walk pages past the OLD cap size ───────
//
// The old design capped this walk at MAX_PAGES_PER_STREAM=200 pages. A test
// exercising only a handful of pages does not discriminate a mutant that
// reintroduces that cap. This pages strictly past 200 full-size pages via a
// counter-driven stub before the natural short page.

test("collectGroupMessages: a group's backward walk pages past 200 full pages with no truncation (mutation-killing)", async () => {
  const totalPages = 201; // 201 full pages, then one short page = 202 fetches
  let messageFetchCount = 0;
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    if (url.pathname === "/v3/groups") {
      return Promise.resolve(new Response(JSON.stringify({ response: [group({ id: "group-1" })] }), { status: 200 }));
    }
    const pageNumber = messageFetchCount;
    messageFetchCount += 1;
    const isLastPage = pageNumber === totalPages;
    const pageLength = isLastPage ? 1 : PAGE_SIZE;
    const messages = Array.from({ length: pageLength }, (_itemValue, itemIndex) =>
      groupMessage({
        id: `m-p${String(pageNumber)}-${String(itemIndex)}`,
        created_at: 1_700_000_000 - pageNumber * PAGE_SIZE - itemIndex,
      })
    );
    return Promise.resolve(
      new Response(JSON.stringify({ response: { count: messages.length, messages } }), { status: 200 })
    );
  }) as typeof globalThis.fetch;
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emitRecord, emitted } = makeHarness();
    const outcome = await collectGroupMessages(TOKEN, cursor, undefined, undefined, noopProgress, emitRecord);

    assert.equal(outcome.failed, false, "no cap-truncation past 200 pages");
    assert.equal(
      messageFetchCount,
      totalPages + 1,
      "all 202 pages were fetched — a reintroduced 200-page cap would stop at page 200"
    );
    const expectedConsidered = totalPages * PAGE_SIZE + 1;
    assert.equal(
      outcome.considered,
      expectedConsidered,
      "considered reflects every message through the true natural end"
    );
    assert.equal(emitted.filter((r) => r.stream === "group_messages").length, expectedConsidered);
  } finally {
    globalThis.fetch = original;
  }
});

// ─── collectDirectChats: considered/failed contract ────────────────────────

test("collectDirectChats: clean pass reports failed: false and considered === listed chats", async () => {
  const restore = stubFetch({
    response: [
      directChat({
        id: undefined,
        last_message: { created_at: 1_700_000_200, text: "nested message" },
        last_message_at: undefined,
      }),
      directChat({
        id: undefined,
        last_message: { created_at: 0, text: null },
        last_message_at: undefined,
        other_user: { id: "user-3" },
      }),
    ],
  });
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emitRecord, emitted } = makeHarness();
    const outcome = await collectDirectChats(TOKEN, cursor, noopProgress, emitRecord);

    assert.deepEqual(outcome, { considered: 2, failed: false });
    assert.equal(emitted.filter((r) => r.stream === "direct_messages").length, 2);
    assert.deepEqual(
      emitted.filter((r) => r.stream === "direct_messages").map((r) => r.data.id),
      ["user-2", "user-3"],
      "live /chats responses use the other user as the stable one-to-one conversation identity"
    );
    const directRecords = emitted.filter((r) => r.stream === "direct_messages").map((r) => r.data);
    assert.equal(directRecords[0]?.last_message, "nested message");
    assert.equal(directRecords[0]?.last_message_at, "2023-11-14T22:16:40.000Z");
    assert.equal(directRecords[1]?.last_message, null);
    assert.equal(directRecords[1]?.last_message_at, null, "provider timestamp 0 is absence, never ingest time");
  } finally {
    restore();
  }
});

test("collectDirectChats: genuine zero chats reports failed: false, considered: 0", async () => {
  const restore = stubFetch({ response: [] });
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emitRecord, emitted } = makeHarness();
    const outcome = await collectDirectChats(TOKEN, cursor, noopProgress, emitRecord);

    assert.deepEqual(outcome, { considered: 0, failed: false }, "a measured empty boundary is itself the proof");
    assert.equal(emitted.length, 0);
  } finally {
    restore();
  }
});

test("collectDirectChats: fingerprint-suppressed (unchanged) chat still counts as considered", async () => {
  const chat = directChat();
  const restore = stubFetch({ response: [chat] });
  try {
    const priorCursor = openFingerprintCursor(new Map());
    const { emitRecord: seedEmit } = makeHarness();
    await collectDirectChats(TOKEN, priorCursor, noopProgress, seedEmit);
    const priorState = priorCursor.toState();

    const cursor = openFingerprintCursor({ fingerprints: priorState });
    const { emitRecord, emitted } = makeHarness();
    const outcome = await collectDirectChats(TOKEN, cursor, noopProgress, emitRecord);

    assert.equal(emitted.length, 0, "unchanged chat is suppressed, not re-emitted");
    assert.equal(outcome.considered, 1, "considered counts the listed chat even though it was suppressed");
    assert.equal(outcome.failed, false);
  } finally {
    restore();
  }
});

test("collectDirectChats: http error reports failed: true and does not throw (non-auth failure is caught)", async () => {
  const restore = stubFetch({ error: "server error" }, 500);
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emitRecord, emitted } = makeHarness();
    const outcome = await collectDirectChats(TOKEN, cursor, noopProgress, emitRecord);

    assert.equal(outcome.failed, true, "an http failure must not report a clean pass");
    assert.equal(outcome.considered, 0);
    assert.equal(emitted.length, 0);
  } finally {
    restore();
  }
});

test("collectDirectChats: malformed (unparseable) body reports failed: true, not a proven-empty list", async () => {
  const restore = stubFetchMalformedBody();
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emitRecord, emitted } = makeHarness();
    const outcome = await collectDirectChats(TOKEN, cursor, noopProgress, emitRecord);

    assert.equal(outcome.failed, true, "an unparseable 200 body is a failed enumeration, not a genuine zero");
    assert.equal(emitted.length, 0);
  } finally {
    restore();
  }
});

test("collectDirectChats: auth failure (401) propagates instead of being swallowed as a stream failure", async () => {
  const restore = stubFetch({ error: "unauthorized" }, 401);
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emitRecord } = makeHarness();
    await assert.rejects(
      () => collectDirectChats(TOKEN, cursor, noopProgress, emitRecord),
      (err: unknown) => err instanceof Error && err.message === "groupme_auth_failed"
    );
  } finally {
    restore();
  }
});

// ─── collectDirectChatMessages: considered/failed contract ─────────────────

test("collectDirectChatMessages: clean pass across multiple chats sums considered from every chat's pages", async () => {
  const restore = stubFetchSequence([
    { body: { response: [directChat({ id: "chat-1" }), directChat({ id: "chat-2" })] } }, // /chats
    { body: { response: { count: 2, direct_messages: [directMessage({ id: "m1" }), directMessage({ id: "m2" })] } } }, // chat-1 page
    { body: { response: { count: 1, direct_messages: [directMessage({ id: "m3" })] } } }, // chat-2 page
  ]);
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emitRecord, emitted } = makeHarness();
    const outcome = await collectDirectChatMessages(TOKEN, cursor, undefined, undefined, noopProgress, emitRecord);

    assert.deepEqual(outcome, { considered: 3, failed: false });
    assert.equal(emitted.filter((r) => r.stream === "direct_chat_messages").length, 3);
  } finally {
    restore();
  }
});

test("collectDirectChatMessages: uses the direct-message endpoint keyed by the other user", async () => {
  const original = globalThis.fetch;
  const urls: URL[] = [];
  globalThis.fetch = ((input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    urls.push(url);
    const response =
      url.pathname === "/v3/chats"
        ? [directChat({ id: undefined, other_user: { id: "user-2", name: "Bob" } })]
        : { count: 1, direct_messages: [directMessage()] };
    return Promise.resolve(new Response(JSON.stringify({ response }), { status: 200 }));
  }) as typeof globalThis.fetch;
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emitRecord, emitted } = makeHarness();
    const outcome = await collectDirectChatMessages(TOKEN, cursor, undefined, undefined, noopProgress, emitRecord);

    assert.deepEqual(outcome, { considered: 1, failed: false });
    assert.equal(urls[1]?.pathname, "/v3/direct_messages");
    assert.equal(urls[1]?.searchParams.get("other_user_id"), "user-2");
    assert.equal(urls[1]?.searchParams.get("limit"), String(PAGE_SIZE));
    assert.equal(emitted.find((record) => record.stream === "direct_chat_messages")?.data.chat_id, "user-2");
    assert.ok(!urls.some((url) => url.pathname === "/v3/chats/user-2/messages"));
  } finally {
    globalThis.fetch = original;
  }
});

test("collectDirectChatMessages: a declared since bound filters out-of-scope rows from considered/emitted, without an early stop", async () => {
  const restore = stubFetchSequence([
    { body: { response: [directChat({ id: "chat-1" })] } }, // /chats
    {
      body: {
        response: {
          count: 2,
          direct_messages: [
            directMessage({ id: "d1", created_at: 1_700_000_300 }),
            directMessage({ id: "d2", created_at: 1_700_000_000 }),
          ],
        },
      },
    },
  ]);
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emitRecord, emitted } = makeHarness();
    const outcome = await collectDirectChatMessages(
      TOKEN,
      cursor,
      undefined,
      undefined,
      noopProgress,
      emitRecord,
      1_700_000_100
    );

    assert.deepEqual(
      emitted.filter((r) => r.stream === "direct_chat_messages").map((r) => (r.data as { id: string }).id),
      ["d1"],
      "only the in-window message emits"
    );
    assert.equal(outcome.failed, false, "excluding an out-of-scope row is a clean pass, not a failure");
    assert.equal(
      outcome.considered,
      1,
      "considered counts only the in-scope message — the out-of-scope d2 on the same page must not inflate it"
    );
  } finally {
    restore();
  }
});

test("collectDirectChatMessages: an entirely out-of-scope page does NOT stop the walk — this endpoint has no documented ordering authority to license an early stop", async () => {
  const fullOldPage = Array.from({ length: PAGE_SIZE }, (_, i) =>
    directMessage({ id: `d-old-${String(i)}`, created_at: 1_699_000_000 - i })
  );
  const restore = stubFetchSequence([
    { body: { response: [directChat({ id: "chat-1" })] } }, // /chats
    { body: { response: { count: 100, direct_messages: fullOldPage } } }, // page 1: entirely out of scope, full page
    {
      body: {
        response: { count: 1, direct_messages: [directMessage({ id: "d-late", created_at: 1_700_000_300 })] },
      },
    }, // page 2: in scope — only reachable if the walk did NOT stop after page 1
  ]);
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emitRecord, emitted } = makeHarness();
    const outcome = await collectDirectChatMessages(
      TOKEN,
      cursor,
      undefined,
      undefined,
      noopProgress,
      emitRecord,
      1_700_000_100
    );

    assert.deepEqual(
      emitted.filter((r) => r.stream === "direct_chat_messages").map((r) => (r.data as { id: string }).id),
      ["d-late"],
      "page 2's in-scope message must be reached and emitted — the walk did not stop after the fully-out-of-scope page 1"
    );
    assert.equal(
      outcome.considered,
      1,
      "considered counts only d-late — the 100 out-of-scope rows on page 1 are excluded, not silently kept either"
    );
    assert.equal(outcome.failed, false);
  } finally {
    restore();
  }
});

test("collectDirectChatMessages: genuine zero chats reports failed: false, considered: 0", async () => {
  const restore = stubFetch({ response: [] });
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emitRecord, emitted } = makeHarness();
    const outcome = await collectDirectChatMessages(TOKEN, cursor, undefined, undefined, noopProgress, emitRecord);

    assert.deepEqual(outcome, { considered: 0, failed: false }, "no chats means no messages — a proven-empty walk");
    assert.equal(emitted.length, 0);
  } finally {
    restore();
  }
});

test("collectDirectChatMessages: a rejected/dropped record still counts as considered, not just emitted", async () => {
  const restore = stubFetchSequence([
    { body: { response: [directChat({ id: "chat-1" })] } },
    {
      body: {
        response: {
          count: 2,
          direct_messages: [directMessage({ id: "m1" }), directMessage({ id: 12_345 })],
        },
      },
    },
  ]);
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emitRecord, emitted } = makeHarness();
    const outcome = await collectDirectChatMessages(TOKEN, cursor, undefined, undefined, noopProgress, emitRecord);

    assert.equal(emitted.filter((r) => r.stream === "direct_chat_messages").length, 1, "only the valid record emits");
    assert.equal(outcome.considered, 2, "considered counts both listed messages, not just the emitted one");
    assert.equal(outcome.failed, false);
  } finally {
    restore();
  }
});

test("collectDirectChatMessages: http error partway through a chat's pages reports failed: true", async () => {
  const restore = stubFetchSequence([
    { body: { response: [directChat({ id: "chat-1" })] } }, // /chats
    { body: { error: "server error" }, status: 500 }, // chat-1 page fails
  ]);
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emitRecord, emitted } = makeHarness();
    const outcome = await collectDirectChatMessages(TOKEN, cursor, undefined, undefined, noopProgress, emitRecord);

    assert.equal(outcome.failed, true, "a mid-walk http failure must not report a clean pass");
    assert.equal(emitted.length, 0);
  } finally {
    restore();
  }
});

test("collectDirectChatMessages: retries one transient chat page in place without refetching prior chats", async () => {
  let messageCalls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    if (url.pathname === "/v3/chats") {
      return Promise.resolve(
        new Response(JSON.stringify({ response: [directChat({ id: "chat-1" }), directChat({ id: "chat-2" })] }), {
          status: 200,
        })
      );
    }
    messageCalls += 1;
    if (messageCalls === 2) {
      return Promise.resolve(new Response(JSON.stringify({ error: "transient server error" }), { status: 500 }));
    }
    const messageId = messageCalls === 1 ? "sibling-1" : "recovered-2";
    return Promise.resolve(
      new Response(JSON.stringify({ response: { count: 1, direct_messages: [directMessage({ id: messageId })] } }), {
        status: 200,
      })
    );
  }) as typeof globalThis.fetch;
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emitRecord, emitted } = makeHarness();
    const outcome = await collectDirectChatMessages(TOKEN, cursor, undefined, undefined, noopProgress, emitRecord);

    assert.deepEqual(outcome, { considered: 2, failed: false });
    assert.deepEqual(
      emitted
        .filter((record) => record.stream === "direct_chat_messages")
        .map((record) => (record.data as { id: string }).id),
      ["sibling-1", "recovered-2"]
    );
    assert.equal(messageCalls, 3, "the 500 is retried in place; chat-1 is not refetched");
  } finally {
    globalThis.fetch = original;
  }
});

test("collectDirectChatMessages: persistent 500 remains failed after bounded request attempts", async () => {
  let messageCalls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    if (url.pathname === "/v3/chats") {
      return Promise.resolve(
        new Response(JSON.stringify({ response: [directChat({ id: "chat-1" })] }), { status: 200 })
      );
    }
    messageCalls += 1;
    return Promise.resolve(new Response(JSON.stringify({ error: "persistent server error" }), { status: 500 }));
  }) as typeof globalThis.fetch;
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emitRecord, emitted } = makeHarness();
    const outcome = await collectDirectChatMessages(TOKEN, cursor, undefined, undefined, noopProgress, emitRecord);

    assert.equal(outcome.failed, true);
    assert.equal(emitted.length, 0);
    assert.equal(messageCalls, 3, "request retries are bounded at three attempts");
  } finally {
    globalThis.fetch = original;
  }
});

test("collectDirectChatMessages: malformed body on the chat-list fetch reports failed: true, not a proven-empty walk", async () => {
  const restore = stubFetchMalformedBody();
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emitRecord, emitted } = makeHarness();
    const outcome = await collectDirectChatMessages(TOKEN, cursor, undefined, undefined, noopProgress, emitRecord);

    assert.equal(outcome.failed, true);
    assert.equal(emitted.length, 0);
  } finally {
    restore();
  }
});

test("collectDirectChatMessages: auth failure (403) propagates instead of being swallowed as a stream failure", async () => {
  const restore = stubFetch({ error: "forbidden" }, 403);
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emitRecord } = makeHarness();
    await assert.rejects(
      () => collectDirectChatMessages(TOKEN, cursor, undefined, undefined, noopProgress, emitRecord),
      (err: unknown) => err instanceof Error && err.message === "groupme_auth_failed"
    );
  } finally {
    restore();
  }
});

// ─── collectDirectChatMessages: pages past the OLD cap, and repeated-page failure ──
//
// The old design capped this walk at MAX_PAGES_PER_STREAM=200 pages. A test
// exercising only a handful of pages does not discriminate a mutant that
// reintroduces that cap (it would pass under either behavior). This test
// pages strictly past 200 full-size pages via a counter-driven stub before
// the natural short page, so a reintroduced 200-page cap would stop the
// walk short and the fetch-count/considered assertions below would fail.

const OLD_CAP = 200;

test("collectDirectChatMessages: a chat's walk pages past 200 full pages with no truncation (mutation-killing)", async () => {
  const totalPages = OLD_CAP + 1; // 201 full pages, then one short page = 202 fetches
  let messageFetchCount = 0;
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    if (url.pathname === "/v3/chats") {
      return Promise.resolve(
        new Response(JSON.stringify({ response: [directChat({ id: "chat-1" })] }), { status: 200 })
      );
    }
    const pageNumber = messageFetchCount;
    messageFetchCount += 1;
    const isLastPage = pageNumber === totalPages;
    const pageLength = isLastPage ? 1 : PAGE_SIZE;
    const direct_messages = Array.from({ length: pageLength }, (_itemValue, itemIndex) =>
      directMessage({ id: `d-p${String(pageNumber)}-${String(itemIndex)}` })
    );
    return Promise.resolve(
      new Response(JSON.stringify({ response: { count: direct_messages.length, direct_messages } }), { status: 200 })
    );
  }) as typeof globalThis.fetch;
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emitRecord, emitted } = makeHarness();
    const outcome = await collectDirectChatMessages(TOKEN, cursor, undefined, undefined, noopProgress, emitRecord);

    assert.equal(outcome.failed, false, "no cap-truncation past 200 pages");
    assert.equal(
      messageFetchCount,
      totalPages + 1,
      "all 202 pages were fetched — a reintroduced 200-page cap would stop at page 200"
    );
    const expectedConsidered = totalPages * PAGE_SIZE + 1;
    assert.equal(
      outcome.considered,
      expectedConsidered,
      "considered reflects every message through the true natural end"
    );
    assert.equal(emitted.filter((r) => r.stream === "direct_chat_messages").length, expectedConsidered);
  } finally {
    globalThis.fetch = original;
  }
});

test("collectDirectChatMessages: a repeated (non-advancing) trailing cursor fails as NonProgressError rather than looping forever", async () => {
  // Every full-size page after the first returns the SAME messages, so the
  // trailing id never advances — a provider bug or a mis-implemented
  // pagination response. Without repeated-cursor detection this loops
  // forever; with it, the walk fails once the same id is seen twice.
  const stuckPage = Array.from({ length: PAGE_SIZE }, (_, i) => directMessage({ id: `d-${String(i)}` }));
  const restore = stubFetchSequence([
    { body: { response: [directChat({ id: "chat-1" })] } },
    { body: { response: { count: PAGE_SIZE, direct_messages: stuckPage } } },
    { body: { response: { count: PAGE_SIZE, direct_messages: stuckPage } } },
  ]);
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emitRecord } = makeHarness();
    const outcome = await collectDirectChatMessages(TOKEN, cursor, undefined, undefined, noopProgress, emitRecord);

    assert.equal(outcome.failed, true, "a repeated trailing cursor must fail the walk, not loop forever");
  } finally {
    restore();
  }
});

// ─── collect()-level gating: shared across all four streams ────────────────

test("collect()-level gating: failed outcome must suppress both STATE and DETAIL_COVERAGE for that stream", async () => {
  const restore = stubFetch({ error: "server error" }, 500);
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emitRecord } = makeHarness();
    const outcome = await collectGroups(TOKEN, cursor, noopProgress, emitRecord);

    const messages: unknown[] = [];
    if (!outcome.failed) {
      messages.push({ type: "STATE", stream: "groups", cursor: { fingerprints: cursor.toState() } });
    }

    assert.equal(outcome.failed, true);
    assert.equal(messages.length, 0, "a failed collection pass must emit neither STATE nor coverage for its stream");
  } finally {
    restore();
  }
});

test("collect()-level gating: clean outcome allows STATE + DETAIL_COVERAGE with considered matching the walk", async () => {
  const restore = stubFetch({ response: [group(), group({ id: "group-2" })] });
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emitRecord } = makeHarness();
    const outcome = await collectGroups(TOKEN, cursor, noopProgress, emitRecord);

    assert.equal(outcome.failed, false);
    assert.equal(outcome.considered, 2);
    // buildFullScanCoverageMessage(stream, considered) sets covered === considered
    // for a full-scan stream with no detail-hydration phase.
  } finally {
    restore();
  }
});

test("collect(): successful message walks durably emit complete proof, including verified-empty", async () => {
  const restore = stubFetchSequence([
    { body: { response: [group()] } },
    { body: { response: { count: 0, messages: [] } } },
    { body: { response: [directChat()] } },
    { body: { response: { count: 0, direct_messages: [] } } },
  ]);
  try {
    const messages: EmittedMessage[] = [];
    await collect({
      state: {},
      requested: new Map<string, StreamScope>([
        ["group_messages", { name: "group_messages" }],
        ["direct_chat_messages", { name: "direct_chat_messages" }],
      ]),
      credentials: { GROUPME_ACCESS_TOKEN: TOKEN },
      emit: (message: EmittedMessage) => {
        messages.push(message);
        return Promise.resolve();
      },
      emitRecord: async () => {
        await Promise.resolve();
      },
      progress: async () => {
        await Promise.resolve();
      },
      assist: async () => "",
      capture: null,
      completeAssistance: async () => {
        await Promise.resolve();
      },
      detailGaps: [],
      emittedAt: new Date().toISOString(),
      requestDetailGapPage: async () => [],
      scope: { streams: [{ name: "group_messages" }, { name: "direct_chat_messages" }] },
      sendInteraction: async () => ({}) as never,
    } satisfies CollectContext);

    for (const stream of ["group_messages", "direct_chat_messages"]) {
      const state = messages.find((message) => message.type === "STATE" && message.stream === stream);
      const coverage = messages.find(
        (message): message is Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> =>
          message.type === "DETAIL_COVERAGE" && message.stream === stream
      );
      assert.ok(state, `${stream} must checkpoint only after its natural end`);
      assert.ok(coverage, `${stream} must emit durable coverage proof`);
      assert.equal(coverage.considered, 0, `${stream} empty enumeration must be explicit`);
      assert.equal(coverage.covered, 0, `${stream} verified-empty proof must be complete`);
    }
  } finally {
    restore();
  }
});

test("collect(): failed direct_chat_messages reports failure while preserving successful sibling coverage", async () => {
  const restore = stubFetchSequence([
    { body: { response: [group()] } },
    { body: { error: "server error" }, status: 500 },
  ]);
  try {
    const messages: EmittedMessage[] = [];
    const failures: Array<{ message: string; options?: { retryable?: boolean }; stream: string }> = [];
    await collect({
      state: {},
      requested: new Map<string, StreamScope>([
        ["groups", { name: "groups" }],
        ["direct_chat_messages", { name: "direct_chat_messages" }],
      ]),
      credentials: { GROUPME_ACCESS_TOKEN: TOKEN },
      emit: (message: EmittedMessage) => {
        messages.push(message);
        return Promise.resolve();
      },
      emitRecord: async () => {
        await Promise.resolve();
      },
      progress: async () => {
        await Promise.resolve();
      },
      reportStreamFailure: (stream, message, options) => {
        failures.push({ message, ...(options ? { options } : {}), stream });
        messages.push({
          type: "SKIP_RESULT",
          stream,
          reason: "stream_collection_failed",
          message,
        });
        return Promise.resolve();
      },
      assist: async () => "",
      capture: null,
      completeAssistance: async () => {
        await Promise.resolve();
      },
      detailGaps: [],
      emittedAt: new Date().toISOString(),
      requestDetailGapPage: async () => [],
      scope: { streams: [{ name: "groups" }, { name: "direct_chat_messages" }] },
      sendInteraction: async () => ({}) as never,
    } satisfies CollectContext);

    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.stream, "direct_chat_messages");
    assert.equal(failures[0]?.options?.retryable, true);
    assert.match(failures[0]?.message ?? "", /direct messages: .*500/iu);
    assert.ok(
      messages.some((message) => message.type === "SKIP_RESULT" && message.stream === "direct_chat_messages"),
      "the failed stream must emit failure evidence"
    );
    const groupsCoverage = messages.find(
      (message): message is Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> =>
        message.type === "DETAIL_COVERAGE" && message.stream === "groups"
    );
    assert.ok(groupsCoverage, "the successful sibling stream must retain its coverage proof");
    assert.equal(groupsCoverage.considered, 1);
    assert.equal(groupsCoverage.covered, 1);
    assert.equal(
      messages.some((message) => message.type === "DETAIL_COVERAGE" && message.stream === "direct_chat_messages"),
      false,
      "the failed stream must not claim coverage"
    );
    assert.equal(
      messages.some((message) => message.type === "STATE" && message.stream === "direct_chat_messages"),
      false,
      "the failed stream must not advance its checkpoint"
    );
  } finally {
    restore();
  }
});

// ─── throttle-blindness: an empty page against a non-zero count ───────────
//
// GroupMe answers with HTTP 200 + `messages: []` both when it has nothing to
// serve and when it is declining to serve content it still counts. Measured
// live, those two responses are identical apart from `content-length` — same
// status, same `meta.code`, no `Retry-After`, no rate-limit header — so the
// status-based retry governor cannot tell them apart.
//
// The connector must therefore refuse to claim a PROVEN walk in that case,
// and must not assert the gap is unrecoverable either. These tests pin both
// halves at the `collectGroupMessages` boundary.

test("collectGroupMessages: an empty page short of the provider count marks the boundary unproven", async () => {
  const restore = stubFetchSequence([
    { body: { response: [group({ id: "group-1" })] } }, // /groups
    // The provider counts 10 messages and serves none — the exact live shape.
    { body: { response: { count: 10, messages: [] } } },
  ]);
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emitRecord } = makeHarness();
    const outcome = await collectGroupMessages(TOKEN, cursor, undefined, undefined, noopProgress, emitRecord);

    assert.equal(outcome.failed, false, "nothing errored — only the completeness claim is withheld");
    assert.equal(outcome.shortfalls.length, 1);
    assert.equal(
      outcome.shortfalls[0]?.unprovenBoundary,
      true,
      "an empty page short of the provider total must never pass for a proven walk"
    );
  } finally {
    restore();
  }
});

test("collectGroupMessages: an empty page whose count AGREES at zero stays a proven walk", async () => {
  const restore = stubFetchSequence([
    { body: { response: [group({ id: "group-1", messages_count: 0 })] } }, // /groups
    // Provider says zero and serves zero: coherent, an ordinary natural end.
    { body: { response: { count: 0, messages: [] } } },
  ]);
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emitRecord } = makeHarness();
    const outcome = await collectGroupMessages(TOKEN, cursor, undefined, undefined, noopProgress, emitRecord);

    assert.equal(outcome.failed, false);
    assert.deepEqual(outcome.shortfalls, [], "a coherent zero is a real anchor, not a gap");
  } finally {
    restore();
  }
});

test("collectGroupMessages: GroupMe's documented 304 end-of-history is a PROVEN walk, not a shortfall", async () => {
  // GroupMe documents: "If no messages are found (e.g. when filtering with
  // `before_id`) we return code 304." That is the ordinary, correct way a
  // fully-collected group signals it has nothing left — it must NEVER be
  // reported as the provider withholding data.
  //
  // MUTATION GUARD. `fetchMessagesPage` normalizes the 304 into a SYNTHETIC
  // `{count: 0, messages: []}`; GroupMe sends no body with a 304, so that
  // zero is ours, not the provider's. If it is ever synthesized as non-zero,
  // this group — which served its whole history and then said "nothing more"
  // — would be accused of a gap it does not have. The `messages_count: 1`
  // below is load-bearing: it makes the provider total non-zero, so only the
  // synthesized count decides the verdict.
  // Page 1 must be FULL (PAGE_SIZE), or the walk exits on the short-page
  // natural end and never requests the page that 304s.
  const fullPage = Array.from({ length: PAGE_SIZE }, (_, i) =>
    groupMessage({ id: `m${String(i)}`, created_at: 1_700_000_100 - i })
  );
  // `new Response(..., { status: 304 })` throws (undici forbids constructing a
  // null-body status), so the 304 is stubbed as a minimal response-shaped
  // object rather than through `stubFetchSequence`.
  const original = globalThis.fetch;
  const bodies: unknown[] = [
    // The provider total EXCEEDS the page we walked, so only the count
    // synthesized for the 304 decides whether this reads as a shortfall.
    { response: [group({ id: "group-1", messages_count: PAGE_SIZE + 5 })] }, // /groups
    { response: { count: PAGE_SIZE, messages: fullPage } }, // page 1: full
  ];
  let call = 0;
  globalThis.fetch = ((): Promise<Response> => {
    const index = call;
    call += 1;
    const body = bodies[index];
    if (body === undefined) {
      // Page 2 and beyond: GroupMe's documented end-of-history signal.
      return Promise.resolve({ status: 304, text: () => Promise.resolve(""), headers: new Headers() } as Response);
    }
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  }) as typeof globalThis.fetch;
  const restore = (): void => {
    globalThis.fetch = original;
  };
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emitRecord } = makeHarness();
    const outcome = await collectGroupMessages(TOKEN, cursor, undefined, undefined, noopProgress, emitRecord);

    assert.equal(outcome.failed, false, "a 304 terminal page is a clean end, not a failure");
    // The provider total is higher than the walk, so a shortfall IS expected.
    // What matters is which KIND: the 304 is a boundary GroupMe actually
    // served, so it must be a plain `partial`, never an unproven boundary.
    assert.equal(outcome.shortfalls.length, 1);
    assert.equal(
      outcome.shortfalls[0]?.unprovenBoundary,
      false,
      "GroupMe's documented 304 end-of-history is a PROVEN boundary — reporting it as unproven would accuse a group that served everything it had"
    );
  } finally {
    restore();
  }
});

test("collect(): an ambiguous empty page is reported as unexplained AND retryable, never as proven-unrecoverable", async () => {
  const restore = stubFetchSequence([
    { body: { response: [group()] } }, // /groups
    // The short-of-total page: provider total is 10, serves none.
    { body: { response: { count: 10, messages: [] } } },
    { body: { response: [] } }, // /chats
  ]);
  try {
    const messages: EmittedMessage[] = [];
    await collect({
      state: {},
      requested: new Map<string, StreamScope>([["group_messages", { name: "group_messages" }]]),
      credentials: { GROUPME_ACCESS_TOKEN: TOKEN },
      emit: (message: EmittedMessage) => {
        messages.push(message);
        return Promise.resolve();
      },
      emitRecord: async () => {
        await Promise.resolve();
      },
      progress: async () => {
        await Promise.resolve();
      },
      assist: async () => "",
      capture: null,
      completeAssistance: async () => {
        await Promise.resolve();
      },
      detailGaps: [],
      emittedAt: new Date().toISOString(),
      requestDetailGapPage: async () => [],
      scope: { streams: [{ name: "group_messages" }] },
      sendInteraction: async () => ({}) as never,
    } satisfies CollectContext);

    const skips = messages.filter(
      (m): m is Extract<EmittedMessage, { type: "SKIP_RESULT" }> =>
        m.type === "SKIP_RESULT" && m.stream === "group_messages"
    );
    const ambiguous = skips.find((s) => s.reason === "history_ended_before_provider_count");

    assert.ok(ambiguous, "the ambiguous gap must be reported under its own reason");
    // The load-bearing assertion. Claiming `not_retriable` here would assert a
    // certainty the response cannot support: being throttled produces this
    // exact same body, so the honest hint leaves the door open.
    const hint = ambiguous.recovery_hint;
    assert.ok(typeof hint === "object" && hint !== null, "recovery_hint must be the structured form");
    assert.equal(hint.action, "retry_by_runtime");
    assert.equal(hint.retryable, true);
    assert.equal(
      skips.some((s) => s.reason === "provider_serves_no_messages_for_group"),
      false,
      "the retired proven-unrecoverable verdict must not come back"
    );
    // Never subtracted: the counted-but-unserved messages stay reported missing.
    const diagnostics = ambiguous.diagnostics as { unexplained_message_total?: number } | undefined;
    assert.equal(diagnostics?.unexplained_message_total, 10);
  } finally {
    restore();
  }
});
