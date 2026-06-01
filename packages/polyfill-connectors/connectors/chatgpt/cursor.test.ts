/**
 * Proof at the orchestration boundary that chatgpt's parent-first emit
 * reorder (Tranche C 2026-04-23) did NOT introduce a cursor/state race.
 *
 * The concern raised in the A++ critique: `processConversationDetail`
 * now emits the `conversations` record before messages. If the caller
 * (`runMessagesAndConversationsWithDetail` →
 * `runConversationsAndMessagesStreams`) emitted the `conversations`
 * STATE cursor too early — between a conversation's parent emit and
 * its last child emit — a downstream consumer reading records +
 * advancing cursor would strand messages behind the cursor and lose
 * them on a crash-then-resume.
 *
 * This test drives the real `runConversationsAndMessagesStreams` with
 * a fake `api` that serves a deterministic list + detail payloads,
 * and records the full emit sequence through `makeRecordingEmit`.
 * Asserts:
 *   1. For every conversation in the list, its `conversations` record
 *      emits before ALL of its `messages` records.
 *   2. The `conversations` STATE cursor is emitted exactly once, AFTER
 *      every per-conversation record (no per-conversation cursor
 *      advance, no pre-emit cursor advance).
 *   3. The STATE cursor value is the max `update_time` across the
 *      synced batch — matches pre-reorder semantics.
 *
 * This is the proof the instruction called for: at the orchestration
 * boundary, not just `processConversationDetail`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { CollectContext, EmittedMessage } from "../../src/connector-runtime.ts";
import { makeRecordingEmit } from "../../src/test-harness.ts";
import { runConversationsAndMessagesStreams, type StreamDeps } from "./index.ts";
import { validateRecord } from "./schemas.ts";
import type { ChatGptApi, ChatGptFetchResult, ChatGptNode, ConversationListItem } from "./types.ts";

// ─── Synthetic fixtures ────────────────────────────────────────────────────

/** Build a conversation-detail mapping with N messages on the current
 *  branch. Shape matches ChatGptFetchResult for /conversation/<id>. */
function makeDetail(convoId: string, messageCount: number): ChatGptFetchResult {
  const mapping: Record<string, ChatGptNode> = {};
  const rootId = `${convoId}-root`;
  const ids: string[] = [];
  for (let i = 0; i < messageCount; i++) {
    ids.push(`${convoId}-m${i}`);
  }

  // Root has no `message` (synthetic; extractMessage returns null → skipped).
  mapping[rootId] = {
    id: rootId,
    parent: null,
    children: ids.slice(0, 1),
  };
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (!id) {
      continue;
    }
    const next = ids[i + 1];
    mapping[id] = {
      id,
      parent: i === 0 ? rootId : (ids[i - 1] ?? rootId),
      children: next ? [next] : [],
      message: {
        id,
        author: { role: i % 2 === 0 ? "user" : "assistant" },
        content: { content_type: "text", parts: [`msg ${i}`] },
        create_time: 1_700_000_000 + i,
        metadata: {},
      },
    };
  }

  return {
    status: 200,
    json: {
      conversation_id: convoId,
      title: `Conversation ${convoId}`,
      current_node: ids.at(-1) ?? rootId,
      create_time: 1_700_000_000,
      update_time: 1_700_001_000,
      mapping,
    },
  };
}

function makeListItem(convoId: string, updateTimeIso: string): ConversationListItem {
  const updateTime = Date.parse(updateTimeIso) / 1000;
  return {
    id: convoId,
    title: `Conversation ${convoId}`,
    create_time: updateTime - 1000,
    update_time: updateTime,
    is_archived: false,
    is_starred: false,
    workspace_id: null,
    current_node: `${convoId}-m1`,
    gizmo_id: null,
  };
}

/** Build a fake `api` that serves a canned list + per-conversation
 *  details. `listConversationsSinceCursor` issues a GET on
 *  /conversations?offset=... ; we return all items on offset=0 then
 *  signal end via `has_missing_conversations: false`. */
function makeFakeApi(list: ConversationListItem[], details: Map<string, ChatGptFetchResult>): ChatGptApi {
  return {
    auth: (): Promise<never> => Promise.reject(new Error("auth not used in fake")),
    fetch: (path: string): Promise<ChatGptFetchResult> => {
      if (path.startsWith("/conversations")) {
        return Promise.resolve({
          status: 200,
          json: { items: list, has_missing_conversations: false, total: list.length },
        });
      }
      // /conversation/<id>
      const id = decodeURIComponent(path.replace(/^\/conversation\//, ""));
      const detail = details.get(id);
      if (!detail) {
        return Promise.resolve({ status: 404, json: null });
      }
      return Promise.resolve(detail);
    },
  };
}

function silentProgress(): CollectContext["progress"] {
  return (): Promise<void> => Promise.resolve();
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function makeDeps(
  api: ChatGptApi,
  requested: readonly string[]
): {
  deps: StreamDeps;
  emitted: ReturnType<typeof makeRecordingEmit>["emitted"];
  events: ReturnType<typeof makeRecordingEmit>["events"];
  protocolMessages: ReturnType<typeof makeRecordingEmit>["protocolMessages"];
} {
  const harness = makeRecordingEmit(validateRecord);
  const deps: StreamDeps = {
    api,
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    progress: silentProgress(),
    requested: new Map(requested.map((name) => [name, { name }])),
  };
  return {
    deps,
    emitted: harness.emitted,
    events: harness.events,
    protocolMessages: harness.protocolMessages,
  };
}

// ─── Orchestration invariants ──────────────────────────────────────────────

test("runConversationsAndMessagesStreams: every conversation record emits before ALL of its messages", async () => {
  const list = [
    makeListItem("conv-A", "2026-04-22T09:00:00Z"),
    makeListItem("conv-B", "2026-04-22T10:00:00Z"),
    makeListItem("conv-C", "2026-04-22T11:00:00Z"),
  ];
  const details = new Map<string, ChatGptFetchResult>([
    ["conv-A", makeDetail("conv-A", 2)],
    ["conv-B", makeDetail("conv-B", 3)],
    ["conv-C", makeDetail("conv-C", 1)],
  ]);
  const { deps, emitted } = makeDeps(makeFakeApi(list, details), ["conversations", "messages"]);

  await runConversationsAndMessagesStreams(deps, {});

  // For each convo, find the index of its conversation record and the
  // FIRST message record whose message-id starts with <conv>-m. Assert
  // ordering across every conversation in the batch.
  for (const convoId of ["conv-A", "conv-B", "conv-C"]) {
    const convoIdx = emitted.findIndex((r) => r.stream === "conversations" && r.data.id === convoId);
    const firstMsgIdx = emitted.findIndex(
      (r) => r.stream === "messages" && typeof r.data.id === "string" && r.data.id.startsWith(`${convoId}-m`)
    );
    assert.notEqual(convoIdx, -1, `expected a conversations record for ${convoId}`);
    assert.notEqual(firstMsgIdx, -1, `expected a messages record for ${convoId}`);
    assert.ok(convoIdx < firstMsgIdx, `${convoId}: conversations record must precede any of its messages`);
  }
});

test("runConversationsAndMessagesStreams: STATE cursor emits once, AFTER every record (unified event trace)", async () => {
  const list = [makeListItem("conv-A", "2026-04-22T09:00:00Z"), makeListItem("conv-B", "2026-04-22T10:00:00Z")];
  const details = new Map<string, ChatGptFetchResult>([
    ["conv-A", makeDetail("conv-A", 2)],
    ["conv-B", makeDetail("conv-B", 2)],
  ]);
  const { deps, emitted, events, protocolMessages } = makeDeps(makeFakeApi(list, details), [
    "conversations",
    "messages",
  ]);

  await runConversationsAndMessagesStreams(deps, {});

  // Exactly ONE STATE for the conversations stream.
  const states = protocolMessages.filter((m: EmittedMessage) => m.type === "STATE" && m.stream === "conversations");
  assert.equal(states.length, 1, "expected a single STATE cursor for conversations");

  // CROSS-KIND ORDERING PROOF via the unified events trace. The previous
  // version of this test used split arrays (.emitted vs .protocolMessages)
  // with no shared sequence — it could not actually prove STATE landed
  // after the last record. The `.events` trace solves that: emit() and
  // emitRecord() both push into it in call order.
  const lastRecordIdx = events.findLastIndex((e) => e.kind === "record");
  const conversationsStateIdx = events.findIndex(
    (e) => e.kind === "message" && e.message.type === "STATE" && e.message.stream === "conversations"
  );
  assert.notEqual(lastRecordIdx, -1, "expected at least one record event");
  assert.notEqual(conversationsStateIdx, -1, "expected a conversations STATE event");
  assert.ok(
    conversationsStateIdx > lastRecordIdx,
    `STATE must land strictly after the last record in the unified trace (lastRecord=${lastRecordIdx}, state=${conversationsStateIdx})`
  );

  // Belt-and-braces: no STATE for the conversations stream appears
  // BEFORE any record. Catches a hypothetical per-batch cursor advance
  // slipped into the middle of the loop.
  const firstConversationsStateIdx = events.findIndex(
    (e) => e.kind === "message" && e.message.type === "STATE" && e.message.stream === "conversations"
  );
  const firstRecordIdx = events.findIndex((e) => e.kind === "record");
  assert.ok(firstConversationsStateIdx > firstRecordIdx, "no STATE for conversations may precede the first record");

  // Sanity on counts.
  assert.equal(emitted.filter((r) => r.stream === "conversations").length, 2);
  assert.equal(emitted.filter((r) => r.stream === "messages").length, 4);
});

test("runConversationsAndMessagesStreams: STATE cursor reflects max update_time across the batch", async () => {
  const list = [
    makeListItem("conv-A", "2026-04-22T09:00:00Z"),
    makeListItem("conv-C", "2026-04-22T11:00:00Z"), // <-- max
    makeListItem("conv-B", "2026-04-22T10:00:00Z"),
  ];
  const details = new Map<string, ChatGptFetchResult>([
    ["conv-A", makeDetail("conv-A", 1)],
    ["conv-B", makeDetail("conv-B", 1)],
    ["conv-C", makeDetail("conv-C", 1)],
  ]);
  const { deps, protocolMessages } = makeDeps(makeFakeApi(list, details), ["conversations", "messages"]);

  await runConversationsAndMessagesStreams(deps, {});

  const state = protocolMessages.find((m: EmittedMessage) => m.type === "STATE" && m.stream === "conversations");
  assert.ok(state && state.type === "STATE");
  const cursor = state.cursor as { last_update_time: string | null };
  assert.equal(
    cursor.last_update_time,
    "2026-04-22T11:00:00.000Z",
    "cursor is the max update_time, not the first or last seen"
  );
});

test("runConversationsAndMessagesStreams: STATE waits for slow required detail lane work", async () => {
  const list = [makeListItem("conv-A", "2026-04-22T09:00:00Z"), makeListItem("conv-B", "2026-04-22T10:00:00Z")];
  const convBGate = deferred<ChatGptFetchResult>();
  const fetches: string[] = [];
  const api: ChatGptApi = {
    auth: (): Promise<never> => Promise.reject(new Error("auth not used in fake")),
    fetch: (path: string): Promise<ChatGptFetchResult> => {
      fetches.push(path);
      if (path.startsWith("/conversations")) {
        return Promise.resolve({
          status: 200,
          json: { items: list, has_missing_conversations: false, total: list.length },
        });
      }
      const id = decodeURIComponent(path.replace(/^\/conversation\//, ""));
      if (id === "conv-B") {
        return convBGate.promise;
      }
      return Promise.resolve(makeDetail("conv-A", 1));
    },
  };
  const { deps, events, protocolMessages } = makeDeps(api, ["conversations", "messages"]);

  const run = runConversationsAndMessagesStreams(
    deps,
    {},
    { detailPacing: { random: () => 0, sleep: () => undefined } }
  );
  await flush();
  assert.equal(
    protocolMessages.some((m: EmittedMessage) => m.type === "STATE" && m.stream === "conversations"),
    false,
    "STATE must not emit while required detail work is unsettled"
  );

  convBGate.resolve(makeDetail("conv-B", 1));
  await run;

  assert.deepEqual(fetches, [
    "/conversations?offset=0&limit=100&order=updated",
    "/conversation/conv-A",
    "/conversation/conv-B",
  ]);
  const lastRecordIdx = events.findLastIndex((e) => e.kind === "record");
  const stateIdx = events.findIndex(
    (e) => e.kind === "message" && e.message.type === "STATE" && e.message.stream === "conversations"
  );
  assert.ok(stateIdx > lastRecordIdx, "STATE must land after all detail lane records settle");
});

test("runConversationsAndMessagesStreams: conversations-only (no messages scope) — STILL parent-first, no detail fetches, STATE still lands", async () => {
  // This is the "scope suppresses messages" path. processConversationDetail
  // is never invoked; emitConversation is called with detail=null for each
  // item in the list. There are no messages, so the parent-first invariant
  // is vacuously preserved — but we still need the STATE cursor to fire.
  const list = [makeListItem("conv-A", "2026-04-22T09:00:00Z")];
  // Ensure the detail endpoint fails loudly if it's ever called — the
  // conversations-only path must NOT fetch details.
  const api: ChatGptApi = {
    auth: (): Promise<never> => Promise.reject(new Error("auth not used in fake")),
    fetch: (path: string): Promise<ChatGptFetchResult> => {
      if (path.startsWith("/conversations")) {
        return Promise.resolve({
          status: 200,
          json: { items: list, has_missing_conversations: false, total: list.length },
        });
      }
      throw new Error(`conversations-only path must not fetch detail; got ${path}`);
    },
  };
  const { deps, emitted, protocolMessages } = makeDeps(api, ["conversations"]);

  await runConversationsAndMessagesStreams(deps, {});

  assert.equal(emitted.filter((r) => r.stream === "messages").length, 0, "messages scope off → zero message records");
  assert.equal(emitted.filter((r) => r.stream === "conversations").length, 1, "one conversation record");
  const states = protocolMessages.filter((m: EmittedMessage) => m.type === "STATE" && m.stream === "conversations");
  assert.equal(states.length, 1, "STATE still fires on the conversations-only path");
});

test("runConversationsAndMessagesStreams: messages backfill is independent from conversations cursor", async () => {
  const list = [makeListItem("conv-new", "2026-04-22T10:00:00Z"), makeListItem("conv-old", "2026-04-22T09:00:00Z")];
  const details = new Map<string, ChatGptFetchResult>([
    ["conv-new", makeDetail("conv-new", 1)],
    ["conv-old", makeDetail("conv-old", 1)],
  ]);
  const fetches: string[] = [];
  const api = makeFakeApi(list, details);
  const recordingApi: ChatGptApi = {
    auth: api.auth,
    fetch: (path: string): Promise<ChatGptFetchResult> => {
      fetches.push(path);
      return api.fetch(path);
    },
  };
  const { deps, emitted, protocolMessages } = makeDeps(recordingApi, ["messages"]);

  await runConversationsAndMessagesStreams(deps, {
    conversations: { last_update_time: "2026-04-22T10:00:00.000Z" },
  });

  assert.deepEqual(fetches, [
    "/conversations?offset=0&limit=100&order=updated",
    "/conversation/conv-new",
    "/conversation/conv-old",
  ]);
  assert.equal(emitted.filter((r) => r.stream === "conversations").length, 0);
  assert.equal(emitted.filter((r) => r.stream === "messages").length, 2);
  assert.equal(
    protocolMessages.some((m) => m.type === "STATE" && m.stream === "conversations"),
    false,
    "messages-only backfill must not advance the parent conversations cursor"
  );
  const messagesState = protocolMessages.find((m) => m.type === "STATE" && m.stream === "messages");
  assert.ok(messagesState && messagesState.type === "STATE");
  assert.deepEqual(messagesState.cursor, { last_update_time: "2026-04-22T10:00:00.000Z" });
});
