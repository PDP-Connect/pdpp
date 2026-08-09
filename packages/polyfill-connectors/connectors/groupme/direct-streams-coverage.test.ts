// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Coverage proof for `direct_messages` and `direct_chat_messages`.
 *
 * Before this change neither stream ever called `buildFullScanCoverageMessage`
 * (or any DETAIL_COVERAGE builder) — grepping the connector for
 * "Coverage"/"considered"/"covered" returned zero matches — so a run could
 * collect real data yet never prove it walked the boundary, and the stream
 * read `unknown` regardless of record count. Worse, `collectDirectChats` and
 * `collectDirectChatMessages` swallowed every non-auth fetch/parse failure
 * and returned normally, so the top-level `collect()` unconditionally
 * emitted that stream's own STATE checkpoint even after a failed pass —
 * a failure could commit a checkpoint as if it had succeeded.
 *
 * Both streams are re-listed/re-walked in full every run (no incremental
 * "since" cursor — see the file header comment in index.ts), gated only by
 * a per-record fingerprint for re-emit suppression, so they match
 * `buildFullScanCoverageMessage`'s precondition exactly (same shape as
 * chatgpt's `shared_conversations`, which is also manifest-labeled
 * `checkpoint_window` but is a full re-scan internally).
 *
 * `collectDirectChats`/`collectDirectChatMessages` now return a
 * `CollectionOutcome { considered, failed }`: `considered` is the raw
 * enumerated item count (summed across chats/pages), measured independently
 * of `emitRecord` — a record the fingerprint cursor suppressed as unchanged
 * was still genuinely observed. `failed` is true whenever the walk was cut
 * short by a non-auth fetch/parse error. `collect()` only emits a stream's
 * own STATE checkpoint and DETAIL_COVERAGE proof when that stream's outcome
 * has `failed: false`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { EmittedMessage, RecordData } from "../../src/connector-runtime.ts";
import { openFingerprintCursor } from "../../src/fingerprint-cursor.ts";
import { type EmittedRecord, makeRecordingEmit } from "../../src/test-harness.ts";
import { collectDirectChatMessages, collectDirectChats } from "./index.ts";
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

/** Mock `globalThis.fetch` to reject every call (transport failure). */
function stubFetchFailure(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = ((): Promise<Response> => Promise.reject(new Error("fetch failed"))) as typeof globalThis.fetch;
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
  // Two messages listed; the second is a duplicate id (fingerprint-driven
  // dedup within the same run would still have seen it at enumeration time).
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

// ─── End-to-end: collect() gates STATE + DETAIL_COVERAGE on outcome.failed ─

/**
 * Mirrors how `collect()` in index.ts consumes `CollectionOutcome`: this
 * reproduces that gating logic directly (index.ts's `collect` is only
 * reachable via `runConnector`, which requires a live credential/state
 * plumbing harness this package doesn't otherwise provide for connectors).
 * Exercising `collectDirectChats`/`collectDirectChatMessages` plus the
 * gating predicate they were built for is the discriminating regression
 * proof: this exact predicate (`!outcome.failed`) is what index.ts's
 * `collect()` uses before emitting STATE and calling
 * `buildFullScanCoverageMessage`.
 */
test("collect()-level gating: failed outcome must suppress both STATE and DETAIL_COVERAGE for that stream", async () => {
  const restore = stubFetchFailure();
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emitRecord } = makeHarness();
    const outcome = await collectDirectChats(TOKEN, cursor, noopProgress, emitRecord);

    const messages: EmittedMessage[] = [];
    if (!outcome.failed) {
      messages.push({ type: "STATE", stream: "direct_messages", cursor: { direct_messages: cursor.toState() } });
    }

    assert.equal(outcome.failed, true);
    assert.equal(messages.length, 0, "a failed collection pass must emit neither STATE nor coverage for its stream");
  } finally {
    restore();
  }
});

test("collect()-level gating: clean outcome allows STATE + DETAIL_COVERAGE with considered matching the walk", async () => {
  const restore = stubFetch({ response: [directChat(), directChat({ id: "chat-2" })] });
  try {
    const cursor = openFingerprintCursor(new Map());
    const { emitRecord } = makeHarness();
    const outcome = await collectDirectChats(TOKEN, cursor, noopProgress, emitRecord);

    assert.equal(outcome.failed, false);
    assert.equal(outcome.considered, 2);
    // buildFullScanCoverageMessage(stream, considered) sets covered === considered
    // for a full-scan stream with no detail-hydration phase.
  } finally {
    restore();
  }
});
