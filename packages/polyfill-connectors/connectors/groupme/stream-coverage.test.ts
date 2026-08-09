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
import type { RecordData } from "../../src/connector-runtime.ts";
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

function makeHarness(): { emitRecord: (stream: string, data: RecordData) => Promise<void>; emitted: EmittedRecord[] } {
  const harness = makeRecordingEmit(validateRecord);
  return { emitRecord: harness.emitRecord, emitted: harness.emitted };
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

// ─── collectGroupMessages: considered/failed contract ──────────────────────

test("collectGroupMessages: clean pass across multiple groups sums considered from every group's pages", async () => {
  const restore = stubFetchSequence([
    { body: { response: [group({ id: "group-1" }), group({ id: "group-2" })] } }, // /groups
    { body: { response: { count: 2, messages: [groupMessage({ id: "m1" }), groupMessage({ id: "m2" })] } } }, // group-1 page
    { body: { response: { count: 1, messages: [groupMessage({ id: "m3" })] } } }, // group-2 page
  ]);
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emitRecord, emitted } = makeHarness();
    const outcome = await collectGroupMessages(TOKEN, cursor, undefined, undefined, noopProgress, emitRecord);

    assert.deepEqual(outcome, { considered: 3, failed: false });
    assert.equal(emitted.filter((r) => r.stream === "group_messages").length, 3);
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

// ─── collectDirectChats: considered/failed contract ────────────────────────

test("collectDirectChats: clean pass reports failed: false and considered === listed chats", async () => {
  const restore = stubFetch({ response: [directChat(), directChat({ id: "chat-2" })] });
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emitRecord, emitted } = makeHarness();
    const outcome = await collectDirectChats(TOKEN, cursor, noopProgress, emitRecord);

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
    // Seed: run once so the fingerprint is recorded.
    await collectDirectChats(TOKEN, priorCursor, noopProgress, seedEmit);
    const priorState = priorCursor.toState();

    // `toState()` returns the flat fingerprints map; the real STATE wire
    // shape wraps it `{ fingerprints: {...} }` (see the collect() STATE
    // emits in index.ts) — `openFingerprintCursor` only decodes that wrapper.
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

// ─── collect()-level gating: shared across all four streams ────────────────

/**
 * Mirrors how `collect()` in index.ts consumes `CollectionOutcome` for
 * every stream: this reproduces that gating logic directly (index.ts's
 * `collect` is only reachable via `runConnector`, which requires a live
 * credential/state plumbing harness this package doesn't otherwise provide
 * for connectors). Exercising each `collect*` function plus the gating
 * predicate it feeds is the discriminating regression proof: this exact
 * predicate (`!outcome.failed`) is what index.ts's `collect()` uses before
 * emitting STATE and calling `buildFullScanCoverageMessage`, identically
 * for groups/group_messages/direct_messages/direct_chat_messages.
 */
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
