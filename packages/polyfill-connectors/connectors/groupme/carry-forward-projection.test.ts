// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Proves fingerprint carry-forward across two real runs of `collect()`,
 * routed through the runtime's actual per-stream last-wins STATE projection
 * — not through hand-threaded cursor state (see production-dedup.test.ts and
 * whatsapp/fingerprint.test.ts for that bypass pattern elsewhere in this
 * codebase; it cannot catch the defect this test targets).
 *
 * The bug this guards against: `collect()` used to emit one unified STATE
 * message under `stream: "groups"` carrying all five streams' cursors as a
 * nested payload, alongside each stream's OWN per-stream STATE emit also
 * under its own `stream` name. The runtime commits STATE per-stream,
 * last-wins (`bufferedState[message.stream] = message.cursor` in
 * collector-runner.ts) — so on any run where `groups` succeeded, its
 * later, flat per-stream emit silently overwrote the earlier unified
 * emit's `groups` key, and the other four streams' cursors were written
 * under keys (`state.group_messages`, `state.direct_messages`, etc.) that
 * `collect()`'s read side never looked at. Every record on every stream
 * therefore looked "new" on every run, defeating fingerprint dedup for all
 * five streams — exactly the failure this fingerprint-cursor primitive
 * exists to prevent (see the module header in fingerprint-cursor.ts).
 *
 * This test drives two full runs of the real, exported `collect()` against
 * a URL-routed fetch stub, applies the runtime's own last-wins STATE
 * projection between them (not a hand-built shortcut), and asserts that a
 * second run against unchanged source data emits zero records for every
 * cursor-backed stream — the only way this genuinely proves carry-forward.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { CollectContext, EmittedMessage, StreamScope } from "../../src/connector-runtime.ts";
import { type EmittedRecord, makeRecordingEmit, type SkippedRecord } from "../../src/test-harness.ts";
import { collect } from "./index.ts";
import { validateRecord } from "./schemas.ts";

const TOKEN = "test-access-token";

const GROUP = {
  id: "group-1",
  name: "Test Group",
  description: null,
  avatar_url: null,
  created_at: 1_700_000_000,
  updated_at: 1_700_000_050,
  members_count: 3,
  messages_count: 1,
};

const GROUP_MESSAGE = {
  id: "gmsg-1",
  text: "hi",
  created_at: 1_700_000_100,
  user_id: "user-2",
  name: "Bob",
  avatar_url: null,
  attachments: [],
  favorited_by: [],
  system: false,
};

const CHAT = {
  id: "chat-1",
  last_message: "hey",
  last_message_at: 1_700_000_000,
  other_user: { id: "user-2", name: "Bob", avatar_url: null },
  avatar_url: null,
};

const DIRECT_MESSAGE = {
  id: "dmsg-1",
  text: "hi",
  created_at: 1_700_000_100,
  user_id: "user-2",
  name: "Bob",
  avatar_url: null,
  attachments: [],
};

/**
 * Route `globalThis.fetch` by request path (ignoring query params), so a
 * single stub can answer `collect()`'s real fan-out across `/groups`,
 * `/chats`, `/groups/{id}/messages`, and `/chats/{id}/messages` — the
 * per-call-order stub used elsewhere in this suite can't express this
 * because `collect()` does not call these endpoints in a single fixed
 * sequence. A route value of `{ status, body }` answers with that HTTP
 * status; any other value answers 200 with `{ response: value }`.
 */
function stubFetchByPath(routes: Record<string, unknown | { status: number; body: unknown }>): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const route = routes[url.pathname];
    if (route === undefined) {
      throw new Error(`unstubbed path in carry-forward projection test: ${url.pathname}`);
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

const STREAMS: StreamScope[] = [
  { name: "groups" },
  { name: "group_messages" },
  { name: "direct_messages" },
  { name: "direct_chat_messages" },
];

function makeCtx(state: Record<string, unknown>): {
  ctx: CollectContext;
  emitted: EmittedRecord[];
  messages: EmittedMessage[];
  skipped: SkippedRecord[];
} {
  const harness = makeRecordingEmit(validateRecord);
  const ctx: CollectContext = {
    assist: () => Promise.resolve("asst_test"),
    capture: null,
    completeAssistance: () => Promise.resolve(),
    credentials: { GROUPME_ACCESS_TOKEN: TOKEN },
    detailGaps: [],
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    emittedAt: "2026-08-09T00:00:00.000Z",
    progress: () => Promise.resolve(),
    requestDetailGapPage: () => Promise.resolve([]),
    requested: new Map(STREAMS.map((s) => [s.name, s])),
    scope: { streams: STREAMS },
    sendInteraction: () =>
      Promise.resolve({ request_id: "int_test", status: "cancelled" as const, type: "INTERACTION_RESPONSE" as const }),
    state,
  };
  return { ctx, emitted: harness.emitted, messages: harness.protocolMessages, skipped: harness.skipped };
}

/**
 * The runtime's real per-stream STATE projection: `bufferedState[message.stream]
 * = message.cursor`, last-wins, applied to every STATE message a run emitted
 * (collector-runner.ts:1447). This is the exact mechanism whose interaction
 * with GroupMe's old unified-plus-per-stream double emit caused the P0 bug —
 * reproducing it here (rather than hand-building the next run's `state`) is
 * what makes this a genuine regression proof instead of another bypass.
 */
function projectState(messages: readonly EmittedMessage[]): Record<string, unknown> {
  const bufferedState: Record<string, unknown> = {};
  for (const msg of messages) {
    if (msg.type === "STATE") {
      bufferedState[msg.stream] = msg.cursor;
    }
  }
  return bufferedState;
}

test("collect(): two real runs through the runtime's STATE projection suppress all four cursor-backed streams on run 2", async () => {
  const restore = stubFetchByPath({
    "/v3/groups": [GROUP],
    "/v3/chats": [CHAT],
    "/v3/groups/group-1/messages": { count: 1, messages: [GROUP_MESSAGE] },
    "/v3/chats/chat-1/messages": { count: 1, direct_messages: [DIRECT_MESSAGE] },
  });
  try {
    // Run 1: fresh state, everything is new.
    const run1 = makeCtx({});
    await collect(run1.ctx);

    assert.deepEqual(run1.skipped, [], "no record should fail schema validation in run 1");
    assert.equal(run1.emitted.filter((r) => r.stream === "groups").length, 1, "run 1 emits the group");
    assert.equal(run1.emitted.filter((r) => r.stream === "group_messages").length, 1, "run 1 emits the group message");
    assert.equal(run1.emitted.filter((r) => r.stream === "direct_messages").length, 1, "run 1 emits the direct chat");
    assert.equal(
      run1.emitted.filter((r) => r.stream === "direct_chat_messages").length,
      1,
      "run 1 emits the direct message"
    );

    // Every cursor-backed stream must have committed its OWN top-level STATE
    // key this run — the P0 defect made group_messages/direct_messages/
    // direct_chat_messages's cursors invisible to the read side even though
    // they were technically written under a different (unified) key.
    const stateStreams = new Set(run1.messages.filter((m) => m.type === "STATE").map((m) => m.stream));
    assert.deepEqual(
      [...stateStreams].sort(),
      ["direct_chat_messages", "direct_messages", "group_messages", "groups"],
      "run 1 commits an independent top-level STATE for every requested cursor-backed stream"
    );

    // Apply the runtime's real last-wins-per-stream projection — not a
    // hand-built shortcut — to get the state run 2 actually receives.
    const projectedState = projectState(run1.messages);

    // Run 2: identical source data, seeded from the real projected state.
    const run2 = makeCtx(projectedState);
    await collect(run2.ctx);

    assert.equal(run2.emitted.filter((r) => r.stream === "groups").length, 0, "unchanged group suppressed on run 2");
    assert.equal(
      run2.emitted.filter((r) => r.stream === "group_messages").length,
      0,
      "unchanged group message suppressed on run 2 — this is the exact defect: it used to always re-emit"
    );
    assert.equal(
      run2.emitted.filter((r) => r.stream === "direct_messages").length,
      0,
      "unchanged direct chat suppressed on run 2"
    );
    assert.equal(
      run2.emitted.filter((r) => r.stream === "direct_chat_messages").length,
      0,
      "unchanged direct message suppressed on run 2"
    );
  } finally {
    restore();
  }
});

test("collect(): a failed stream's prior cursor survives untouched into the next run (no unified blob required)", async () => {
  // Run 1: everything succeeds and seeds real fingerprints.
  const seedRestore = stubFetchByPath({
    "/v3/groups": [GROUP],
    "/v3/chats": [CHAT],
    "/v3/groups/group-1/messages": { count: 1, messages: [GROUP_MESSAGE] },
    "/v3/chats/chat-1/messages": { count: 1, direct_messages: [DIRECT_MESSAGE] },
  });
  const run1 = makeCtx({});
  try {
    await collect(run1.ctx);
  } finally {
    seedRestore();
  }
  const projectedState = projectState(run1.messages);
  assert.ok(projectedState.direct_messages, "run 1 persisted a direct_messages cursor to carry forward");

  // Run 2: direct_messages' own fetch fails; groups/group_messages still
  // succeed on unchanged data (direct_chat_messages is not requested this
  // run, to prove the withholding is per-stream, not all-or-nothing).
  const failRestore = stubFetchByPath({
    "/v3/groups": [GROUP],
    "/v3/chats": { status: 500, body: { error: "server error" } },
    "/v3/groups/group-1/messages": { count: 1, messages: [GROUP_MESSAGE] },
  });
  const run2 = makeCtx(projectedState);
  run2.ctx.requested = new Map(
    [{ name: "groups" }, { name: "group_messages" }, { name: "direct_messages" }].map((s) => [s.name, s])
  );
  run2.ctx.scope = { streams: [...run2.ctx.requested.values()] };
  try {
    await collect(run2.ctx);
  } finally {
    failRestore();
  }

  const run2StateStreams = new Set(run2.messages.filter((m) => m.type === "STATE").map((m) => m.stream));
  assert.ok(!run2StateStreams.has("direct_messages"), "failed stream must not emit a replacement STATE this run");
  assert.ok(!run2StateStreams.has("direct_chat_messages"), "direct_chat_messages was not requested this run's scope");

  // The failed stream's prior top-level state key is simply untouched by
  // run 2 (withheld, not overwritten with an empty replacement) — so a
  // hypothetical run 3 seeded from run1's + run2's combined projection would
  // still see it. Prove this directly: project run 2's messages alone and
  // confirm direct_messages is absent (not present-but-empty), so a real
  // runtime merge (which only overlays what changed) leaves run 1's key intact.
  const run2Projection = projectState(run2.messages);
  assert.ok(
    !("direct_messages" in run2Projection),
    "a failed stream commits no STATE key at all this run, preserving the prior run's persisted cursor"
  );
});
