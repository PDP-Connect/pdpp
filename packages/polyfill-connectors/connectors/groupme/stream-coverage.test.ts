// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Coverage proof for all four cursor-backed GroupMe streams: `groups`,
 * `group_messages`, `direct_messages`, `direct_chat_messages`.
 *
 * Before this change none of the four streams ever called
 * `buildFullScanCoverageMessage` (or any DETAIL_COVERAGE builder) —
 * grepping the connector for "Coverage"/"considered"/"covered" returned zero
 * matches — so a run could collect real data yet never prove it walked the
 * boundary, and every stream read `unknown` regardless of record count.
 * Worse, every collector (`collectGroups`, `collectGroupMessages`,
 * `collectDirectChats`, `collectDirectChatMessages`) swallowed every
 * non-auth fetch/parse failure and returned normally, so the top-level
 * `collect()` unconditionally emitted that stream's own STATE checkpoint
 * even after a failed pass — a failure could commit a checkpoint as if it
 * had succeeded.
 *
 * All four streams are re-listed/re-walked in full every run (no
 * incremental "since" cursor — see the file header comment in index.ts),
 * gated only by a per-record fingerprint for re-emit suppression, so they
 * match `buildFullScanCoverageMessage`'s precondition exactly (same shape
 * as chatgpt's `shared_conversations`, which is also manifest-labeled
 * `checkpoint_window` but is a full re-scan internally — `groups` itself is
 * manifest-labeled `full_inventory`, the unambiguous case).
 *
 * Every collector now returns a `CollectionOutcome { considered, failed }`
 * via the shared `runCollectionPass` wrapper in index.ts: `considered` is
 * the raw enumerated item count (summed across groups/chats and their
 * pages), measured independently of `emitRecord` — a record the fingerprint
 * cursor suppressed as unchanged, or one the schema validator rejected, was
 * still genuinely observed. `failed` is true whenever the walk was cut short
 * by a non-auth fetch/parse error. `collect()` only emits a stream's own
 * STATE checkpoint and DETAIL_COVERAGE proof when that stream's outcome has
 * `failed: false`.
 *
 * Test structure mirrors across all four streams: for each, a clean-pass
 * discriminator, a genuine-zero proof, a fingerprint-suppression
 * counterweight, an http-error counterweight, a malformed-body
 * counterweight (including mid-walk for the two-level group/chat + pages
 * streams), a retained-drop counterweight, and an auth-propagation check.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { EmittedMessage, RecordData } from "../../src/connector-runtime.ts";
import { openFingerprintCursor } from "../../src/fingerprint-cursor.ts";
import { type EmittedRecord, makeRecordingEmit } from "../../src/test-harness.ts";
import { collectDirectChatMessages, collectDirectChats, collectGroupMessages, collectGroups } from "./index.ts";
import { validateRecord } from "./schemas.ts";

const TOKEN = "test-access-token";

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
    const { emit, emitRecord, emitted } = makeHarness();
    const outcome = await collectGroups(TOKEN, cursor, noopProgress, emit, emitRecord);

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
    const { emit, emitRecord, emitted } = makeHarness();
    const outcome = await collectGroups(TOKEN, cursor, noopProgress, emit, emitRecord);

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
    const { emit: seedEmitMessage, emitRecord: seedEmit } = makeHarness();
    await collectGroups(TOKEN, priorCursor, noopProgress, seedEmitMessage, seedEmit);
    const priorState = priorCursor.toState();

    const cursor = openFingerprintCursor({ fingerprints: priorState });
    const { emit, emitRecord, emitted } = makeHarness();
    const outcome = await collectGroups(TOKEN, cursor, noopProgress, emit, emitRecord);

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
    const { emit, emitRecord, emitted } = makeHarness();
    const outcome = await collectGroups(TOKEN, cursor, noopProgress, emit, emitRecord);

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
    const { emit, emitRecord, emitted } = makeHarness();
    const outcome = await collectGroups(TOKEN, cursor, noopProgress, emit, emitRecord);

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
    const { emit, emitRecord, emitted } = makeHarness();
    const outcome = await collectGroups(TOKEN, cursor, noopProgress, emit, emitRecord);

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
    const { emit, emitRecord } = makeHarness();
    await assert.rejects(
      () => collectGroups(TOKEN, cursor, noopProgress, emit, emitRecord),
      (err: unknown) => err instanceof Error && err.message === "groupme_auth_failed"
    );
  } finally {
    restore();
  }
});

// ─── collectGroupMessages: considered/failed contract ──────────────────────

test("collectGroupMessages: clean pass across multiple groups sums considered from every group's pages", async () => {
  const restore = stubFetchSequence([
    { body: { response: [group({ id: "group-1" }), group({ id: "group-2" })] } }, // /groups
    { body: { response: { count: 2, messages: [groupMessage({ id: "m1" }), groupMessage({ id: "m2" })] } } }, // group-1 page
    { body: { response: { count: 1, messages: [groupMessage({ id: "m3" })] } } }, // group-2 page
  ]);
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emit, emitRecord, emitted } = makeHarness();
    const outcome = await collectGroupMessages(TOKEN, cursor, undefined, undefined, noopProgress, emit, emitRecord);

    assert.deepEqual(outcome, { considered: 3, failed: false });
    assert.equal(emitted.filter((r) => r.stream === "group_messages").length, 3);
  } finally {
    restore();
  }
});

test("collectGroupMessages: a declared since bound stops the documented-descending walk cleanly, without fetching further pages", async () => {
  // Page is genuinely created_at-descending (m1=300 > m2=50 > m3=0), the
  // ordering GroupMe's official docs guarantee for this endpoint — licensing
  // the fast-path early stop. A second page is queued so a bug that ignores
  // `since` (fetches to the natural PAGE_SIZE end / page cap) would consume
  // it and inflate `considered` — the assertion on fetchCount below is what
  // catches that.
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
    const { emit, emitRecord, emitted } = makeHarness();
    // since = 1_700_000_100 excludes m2 (1_700_000_050) and m3 (1_700_000_000), includes m1 (1_700_000_300).
    const outcome = await collectGroupMessages(
      TOKEN,
      cursor,
      undefined,
      undefined,
      noopProgress,
      emit,
      emitRecord,
      undefined,
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
    assert.equal(
      fetchCount,
      2,
      "the groups list plus exactly one message page — the since bound stops before a 2nd page"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("collectGroupMessages: a non-monotonic page falls back to the conservative path — every message is checked, not just up to the first out-of-scope row", async () => {
  // Deliberately violates the documented descending order: m-late (in scope,
  // created_at=200) sits AFTER m-old (out of scope, created_at=0) despite
  // being newer. isDescendingByCreatedAt must catch this and refuse the
  // fast-path early stop — proving the connector VALIDATES the ordering
  // contract per page rather than trusting it blindly. This page is also
  // short (< PAGE_SIZE), so the walk ends here via the ordinary natural-end
  // condition either way; the assertions below are on considered/emitted
  // correctness, not on which page count it stopped at.
  const restore = stubFetchSequence([
    { body: { response: [group({ id: "group-1" })] } }, // /groups
    {
      body: {
        response: {
          count: 3,
          messages: [
            groupMessage({ id: "m-new", created_at: 1_700_000_300 }),
            groupMessage({ id: "m-old", created_at: 1_700_000_000 }), // out of scope, mid-page
            groupMessage({ id: "m-late", created_at: 1_700_000_200 }), // in scope, AFTER m-old — breaks descending order
          ],
        },
      },
    },
  ]);
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emit, emitRecord, emitted } = makeHarness();
    // since = 1_700_000_100 excludes m-old, includes m-new and m-late.
    const outcome = await collectGroupMessages(
      TOKEN,
      cursor,
      undefined,
      undefined,
      noopProgress,
      emit,
      emitRecord,
      undefined,
      1_700_000_100
    );

    assert.deepEqual(
      new Set(emitted.filter((r) => r.stream === "group_messages").map((r) => (r.data as { id: string }).id)),
      new Set(["m-new", "m-late"]),
      "both in-scope rows emit, including the out-of-order straggler after the out-of-scope row"
    );
    assert.equal(outcome.considered, 2, "considered counts only the 2 in-scope rows — m-old is excluded");
    assert.equal(outcome.failed, false);
  } finally {
    restore();
  }
});

test("collectGroupMessages: a verified-descending page with an out-of-scope row stops the walk without needing a second fully-out-of-scope page", async () => {
  // Page IS genuinely descending (unlike the non-monotonic test above), and
  // is a FULL PAGE_SIZE page so the natural-end (`length < PAGE_SIZE`) path
  // cannot be what stops the walk — only the documented-ordering fast path
  // can. Page 2 is queued in-scope; if fetched, it would prove the fast path
  // did NOT fire.
  const descendingPage = [
    groupMessage({ id: "m-new", created_at: 1_700_000_300 }),
    ...Array.from({ length: 98 }, (_, i) => groupMessage({ id: `m-mid-${String(i)}`, created_at: 1_700_000_250 - i })),
    groupMessage({ id: "m-old", created_at: 1_699_999_000 }), // out of scope, last (oldest) on the page
  ];
  let fetchCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((): Promise<Response> => {
    fetchCount += 1;
    if (fetchCount === 1) {
      return Promise.resolve(new Response(JSON.stringify({ response: [group({ id: "group-1" })] }), { status: 200 }));
    }
    if (fetchCount === 2) {
      return Promise.resolve(
        new Response(JSON.stringify({ response: { count: 100, messages: descendingPage } }), { status: 200 })
      );
    }
    // Only reached if the fast path failed to stop after page 1.
    return Promise.resolve(
      new Response(
        JSON.stringify({
          response: { count: 1, messages: [groupMessage({ id: "m-unreachable", created_at: 1_700_000_290 })] },
        }),
        { status: 200 }
      )
    );
  }) as typeof globalThis.fetch;
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
      1_700_000_100
    );

    assert.equal(
      emitted.filter((r) => r.stream === "group_messages" && (r.data as { id: string }).id === "m-unreachable").length,
      0,
      "the fast path must stop after page 1 — page 2 must never be fetched or emitted"
    );
    assert.equal(fetchCount, 2, "exactly the group list plus one message page");
    assert.equal(outcome.considered, 99, "considered counts the 99 in-scope rows on the verified-descending page");
    assert.equal(outcome.failed, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("collectGroupMessages: genuine zero groups reports failed: false, considered: 0", async () => {
  const restore = stubFetch({ response: [] });
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emit, emitRecord, emitted } = makeHarness();
    const outcome = await collectGroupMessages(TOKEN, cursor, undefined, undefined, noopProgress, emit, emitRecord);

    assert.deepEqual(outcome, { considered: 0, failed: false }, "no groups means no messages — a proven-empty walk");
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
    const { emit, emitRecord, emitted } = makeHarness();
    const outcome = await collectGroupMessages(TOKEN, cursor, undefined, undefined, noopProgress, emit, emitRecord);

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
    const { emit, emitRecord, emitted } = makeHarness();
    const outcome = await collectGroupMessages(TOKEN, cursor, undefined, undefined, noopProgress, emit, emitRecord);

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
    const { emit, emitRecord, emitted } = makeHarness();
    const outcome = await collectGroupMessages(TOKEN, cursor, undefined, undefined, noopProgress, emit, emitRecord);

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
    const { emit, emitRecord } = makeHarness();
    await assert.rejects(
      () => collectGroupMessages(TOKEN, cursor, undefined, undefined, noopProgress, emit, emitRecord),
      (err: unknown) => err instanceof Error && err.message === "groupme_auth_failed"
    );
  } finally {
    restore();
  }
});

// ─── collectDirectChats: considered/failed contract ────────────────────────

test("collectDirectChats: clean pass reports failed: false and considered === listed chats", async () => {
  const restore = stubFetch({ response: [directChat(), directChat({ id: "chat-2" })] });
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emit, emitRecord, emitted } = makeHarness();
    const outcome = await collectDirectChats(TOKEN, cursor, noopProgress, emit, emitRecord);

    assert.deepEqual(outcome, { considered: 2, failed: false });
    assert.equal(emitted.filter((r) => r.stream === "direct_messages").length, 2);
  } finally {
    restore();
  }
});

test("collectDirectChats: genuine zero chats reports failed: false, considered: 0", async () => {
  const restore = stubFetch({ response: [] });
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emit, emitRecord, emitted } = makeHarness();
    const outcome = await collectDirectChats(TOKEN, cursor, noopProgress, emit, emitRecord);

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
    const { emit: seedEmitMessage, emitRecord: seedEmit } = makeHarness();
    // Seed: run once so the fingerprint is recorded.
    await collectDirectChats(TOKEN, priorCursor, noopProgress, seedEmitMessage, seedEmit);
    const priorState = priorCursor.toState();

    // `toState()` returns the flat fingerprints map; the real STATE wire
    // shape wraps it `{ fingerprints: {...} }` (see the collect() STATE
    // emits in index.ts) — `openFingerprintCursor` only decodes that wrapper.
    const cursor = openFingerprintCursor({ fingerprints: priorState });
    const { emit, emitRecord, emitted } = makeHarness();
    const outcome = await collectDirectChats(TOKEN, cursor, noopProgress, emit, emitRecord);

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
    const { emit, emitRecord, emitted } = makeHarness();
    const outcome = await collectDirectChats(TOKEN, cursor, noopProgress, emit, emitRecord);

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
    const { emit, emitRecord, emitted } = makeHarness();
    const outcome = await collectDirectChats(TOKEN, cursor, noopProgress, emit, emitRecord);

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
    const { emit, emitRecord } = makeHarness();
    await assert.rejects(
      () => collectDirectChats(TOKEN, cursor, noopProgress, emit, emitRecord),
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
    const { emit, emitRecord, emitted } = makeHarness();
    const outcome = await collectDirectChatMessages(
      TOKEN,
      cursor,
      undefined,
      undefined,
      noopProgress,
      emit,
      emitRecord
    );

    assert.deepEqual(outcome, { considered: 3, failed: false });
    assert.equal(emitted.filter((r) => r.stream === "direct_chat_messages").length, 3);
  } finally {
    restore();
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
    const { emit, emitRecord, emitted } = makeHarness();
    const outcome = await collectDirectChatMessages(
      TOKEN,
      cursor,
      undefined,
      undefined,
      noopProgress,
      emit,
      emitRecord,
      undefined,
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
  // Unlike collectGroupMessagesForGroup (GroupMe's official docs guarantee
  // GET /groups/:id/messages is created_at-descending with before_id
  // returning the immediately-preceding page), GET /chats/:id/messages
  // carries no equivalent documented guarantee. Page 1 is a FULL PAGE_SIZE
  // page, entirely out of scope — a bug that reintroduces the
  // pageFullyOutOfScope early-stop from the prior revision would return here
  // without ever fetching page 2, silently dropping d-late.
  const fullOldPage = Array.from({ length: 100 }, (_, i) =>
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
    const { emit, emitRecord, emitted } = makeHarness();
    const outcome = await collectDirectChatMessages(
      TOKEN,
      cursor,
      undefined,
      undefined,
      noopProgress,
      emit,
      emitRecord,
      undefined,
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
    const { emit, emitRecord, emitted } = makeHarness();
    const outcome = await collectDirectChatMessages(
      TOKEN,
      cursor,
      undefined,
      undefined,
      noopProgress,
      emit,
      emitRecord
    );

    assert.deepEqual(outcome, { considered: 0, failed: false }, "no chats means no messages — a proven-empty walk");
    assert.equal(emitted.length, 0);
  } finally {
    restore();
  }
});

test("collectDirectChatMessages: a rejected/dropped record still counts as considered, not just emitted", async () => {
  // The second raw message has a non-string `id` (a live-API shape drift),
  // which fails DirectChatMessageSchema's `id: z.string()` and is recorded as
  // `skipped` by the validating test harness rather than `emitted`. Proves
  // `considered` tracks the raw listed count, not the validator-accepted count.
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
    const { emit, emitRecord, emitted } = makeHarness();
    const outcome = await collectDirectChatMessages(
      TOKEN,
      cursor,
      undefined,
      undefined,
      noopProgress,
      emit,
      emitRecord
    );

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
    const { emit, emitRecord, emitted } = makeHarness();
    const outcome = await collectDirectChatMessages(
      TOKEN,
      cursor,
      undefined,
      undefined,
      noopProgress,
      emit,
      emitRecord
    );

    assert.equal(outcome.failed, true, "a mid-walk http failure must not report a clean pass");
    assert.equal(emitted.length, 0);
  } finally {
    restore();
  }
});

test("collectDirectChatMessages: malformed body on the chat-list fetch reports failed: true, not a proven-empty walk", async () => {
  const restore = stubFetchMalformedBody();
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emit, emitRecord, emitted } = makeHarness();
    const outcome = await collectDirectChatMessages(
      TOKEN,
      cursor,
      undefined,
      undefined,
      noopProgress,
      emit,
      emitRecord
    );

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
    const { emit, emitRecord } = makeHarness();
    await assert.rejects(
      () => collectDirectChatMessages(TOKEN, cursor, undefined, undefined, noopProgress, emit, emitRecord),
      (err: unknown) => err instanceof Error && err.message === "groupme_auth_failed"
    );
  } finally {
    restore();
  }
});

// ─── collect()-level gating: shared across all four streams ────────────────

/**
 * Mirrors how `collect()` in index.ts consumes `CollectionOutcome` for
 * every stream: this reproduces that gating logic directly against the
 * exported `collectGroups`. `collect()` itself is also exported and driven
 * end-to-end (real two-run STATE-projection round-trip, not this hand-built
 * shortcut) in carry-forward-projection.test.ts — see that file for the
 * discriminating regression proof this predicate ultimately backs.
 */
test("collect()-level gating: failed outcome must suppress both STATE and DETAIL_COVERAGE for that stream", async () => {
  const restore = stubFetch({ error: "server error" }, 500);
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emit, emitRecord } = makeHarness();
    const outcome = await collectGroups(TOKEN, cursor, noopProgress, emit, emitRecord);

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
    const { emit, emitRecord } = makeHarness();
    const outcome = await collectGroups(TOKEN, cursor, noopProgress, emit, emitRecord);

    assert.equal(outcome.failed, false);
    assert.equal(outcome.considered, 2);
    // buildFullScanCoverageMessage(stream, considered) sets covered === considered
    // for a full-scan stream with no detail-hydration phase.
  } finally {
    restore();
  }
});

// ─── /groups and /chats full pagination (P3) ───────────────────────────────
//
// GroupMe's /groups and /chats are genuinely paginated (documented `page`/
// `per_page` params, empty array past the last page). A single unpaged
// page-1 fetch would silently miss every group/chat beyond PAGE_SIZE for an
// account with more — and group_messages/direct_chat_messages, which iterate
// the fetched list, would never even attempt the missing parents.
//
// collectGroupMessages/collectDirectChatMessages call the identical shared
// fetchPaginatedList helper (index.ts) for their own parent-list fetch, so
// proving it here covers all four collectors without re-running a redundant,
// 100-real-group version of this proof through the far more expensive
// per-group message-fetch path.

test("collectGroups: pages past PAGE_SIZE-sized page 1 to collect every group", async () => {
  const page1 = Array.from({ length: 100 }, (_, i) => group({ id: `group-${String(i)}` }));
  const page2 = [group({ id: "group-100" }), group({ id: "group-101" })];
  const restore = stubFetchSequence([{ body: { response: page1 } }, { body: { response: page2 } }]);
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emit, emitRecord, emitted } = makeHarness();
    const outcome = await collectGroups(TOKEN, cursor, noopProgress, emit, emitRecord);

    assert.deepEqual(outcome, { considered: 102, failed: false }, "both pages contribute to considered");
    assert.equal(
      emitted.filter((r) => r.stream === "groups").length,
      102,
      "groups from page 2 are not silently missed"
    );
  } finally {
    restore();
  }
});

test("collectDirectChats: pages past PAGE_SIZE-sized page 1 to collect every chat", async () => {
  const page1 = Array.from({ length: 100 }, (_, i) => directChat({ id: `chat-${String(i)}` }));
  const page2 = [directChat({ id: "chat-100" })];
  const restore = stubFetchSequence([{ body: { response: page1 } }, { body: { response: page2 } }]);
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emit, emitRecord, emitted } = makeHarness();
    const outcome = await collectDirectChats(TOKEN, cursor, noopProgress, emit, emitRecord);

    assert.deepEqual(outcome, { considered: 101, failed: false });
    assert.equal(
      emitted.filter((r) => r.stream === "direct_messages").length,
      101,
      "chat from page 2 is not silently missed"
    );
  } finally {
    restore();
  }
});

// ─── Page-cap truncation is honest, not silent (P2) ────────────────────────
//
// A page-cap-truncated walk did not prove it saw every message/group/chat —
// reporting `considered` as if it were the true boundary would make
// buildFullScanCoverageMessage's covered===considered claim false. Every
// collect* function accepts an optional `maxPages` (default
// MAX_PAGES_PER_STREAM=200) so these tests can force the cap-exit branch in
// milliseconds instead of paying for hundreds of real 10s-paced requests.

test("collectGroups: hitting the list page cap reports failed: true and a bounded SKIP_RESULT diagnostic", async () => {
  const fullPage = Array.from({ length: 100 }, (_, i) => group({ id: `group-${String(i)}` }));
  // Two full pages in a row with maxPages=2: the loop never sees a
  // shorter-than-PAGE_SIZE page, so it exits via the cap, not the natural end.
  const restore = stubFetchSequence([{ body: { response: fullPage } }, { body: { response: fullPage } }]);
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emit, emitRecord, emitted, protocolMessages } = makeHarness();
    const outcome = await collectGroups(TOKEN, cursor, noopProgress, emit, emitRecord, 2);

    assert.equal(outcome.failed, true, "a cap-truncated walk must not report a clean pass");
    assert.equal(outcome.considered, 0, "the partial count is withheld, not laundered as the true boundary");

    const skip = protocolMessages.find((m) => m.type === "SKIP_RESULT" && m.stream === "groups");
    assert.ok(skip && skip.type === "SKIP_RESULT", "a bounded diagnostic is emitted for the truncation");
    assert.equal(skip.reason, "page_cap_truncated");
    assert.deepEqual(
      skip.diagnostics,
      { considered: 200, page_cap: 2 },
      "diagnostic carries counts only, no identifiers"
    );
    // Groups from both pages still emit — records are not dropped, only the
    // stream-level completeness claim is withheld.
    assert.equal(emitted.filter((r) => r.stream === "groups").length, 200);
  } finally {
    restore();
  }
});

test("collectGroupMessages: hitting a single group's message-page cap withholds that stream's coverage claim", async () => {
  const fullPage = Array.from({ length: 100 }, (_, i) => groupMessage({ id: `m-${String(i)}` }));
  const restore = stubFetchSequence([
    { body: { response: [group({ id: "group-1" })] } }, // /groups
    { body: { response: { count: 100, messages: fullPage } } }, // page 1 (full)
    { body: { response: { count: 100, messages: fullPage } } }, // page 2 (full — hits maxPages=2)
  ]);
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emit, emitRecord, protocolMessages } = makeHarness();
    const outcome = await collectGroupMessages(TOKEN, cursor, undefined, undefined, noopProgress, emit, emitRecord, 2);

    assert.equal(outcome.failed, true, "a group's page-cap truncation fails the whole stream's pass");
    const skip = protocolMessages.find((m) => m.type === "SKIP_RESULT" && m.stream === "group_messages");
    assert.ok(skip, "a bounded diagnostic is emitted for the truncated group's walk");
  } finally {
    restore();
  }
});

test("collect()-level gating: a truncated outcome must suppress both STATE and DETAIL_COVERAGE, same as any failure", async () => {
  const fullPage = Array.from({ length: 100 }, (_, i) => group({ id: `group-${String(i)}` }));
  const restore = stubFetchSequence([{ body: { response: fullPage } }, { body: { response: fullPage } }]);
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emit, emitRecord } = makeHarness();
    const outcome = await collectGroups(TOKEN, cursor, noopProgress, emit, emitRecord, 2);

    const stateMessages: unknown[] = [];
    if (!outcome.failed) {
      stateMessages.push({ type: "STATE", stream: "groups", cursor: { fingerprints: cursor.toState() } });
    }

    assert.equal(outcome.failed, true);
    assert.equal(stateMessages.length, 0, "truncation withholds STATE exactly like any other failed pass");
  } finally {
    restore();
  }
});
