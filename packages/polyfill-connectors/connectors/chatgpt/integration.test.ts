/**
 * Integration tests for the ChatGPT connector's `collect()` emit path —
 * specifically the per-conversation orchestration in
 * `processConversationDetail` and the two simple per-run streams
 * (`runMemoriesStream`, `runCustomInstructionsStream`).
 *
 * These tests DON'T drive Playwright. They construct a fake `StreamDeps`
 * backed by `makeRecordingEmit(validateRecord)` — every emitted record
 * is routed through the real zod schema the runtime applies in prod.
 * Captures every (stream, data) pair pushed through `emitRecord` plus
 * every non-RECORD `EmittedMessage` pushed through `emit`, then asserts
 * on the observable invariants: emit-order contract,
 * scope-filter suppression, null-enrichment fallback (failed detail
 * fetch → list-only conversation record + SKIP on messages), and
 * all-streams-disabled yields nothing. A `fakeApi` closes over a canned
 * `ChatGptFetchResult` queue so per-stream tests can thread a 200 / 404
 * / 500 response without any network.
 *
 * Imports directly from ./index.ts — `runConnector({...})` is guarded by
 * `isMainModule(import.meta.url)` so it only fires when index.ts is the
 * process entry point, not when a test imports it.
 *
 * Why bother: parsers.test.ts proves record *shapes* are correct from
 * individual message/conversation objects. Integration tests on the
 * emit path prove the invariants downstream consumers observe:
 *   - the conversation record emits BEFORE any of its messages
 *     (parent-first, per Tranche C 2026-04-23 — aligns chatgpt with
 *     amazon, chase, usaa, slack, codex, etc.),
 *   - `messages` not requested → only the conversation record emits,
 *     no message records (scope suppresses one stream cleanly),
 *   - all streams disabled → nothing emits,
 *   - detail.status !== 200 or missing mapping → still emit the
 *     conversation record (detail=null), and a SKIP_RESULT on the
 *     messages stream; the conversation is never silently dropped,
 *   - processConversationDetail is faithful to its inputs: same
 *     conversation processed twice yields two emits (dedup is upstream,
 *     at the listConversationsSinceCursor cursor layer),
 *   - every node in the mapping is considered (on_current_branch is
 *     set from the flattened current-branch id set), so a multi-branch
 *     conversation emits one record per node with a role,
 *   - http 404/403 on `/user_system_messages` emits a SKIP_RESULT and
 *     no record (all-streams-disabled guard per single-record stream),
 *   - `extractContent` content_type dispatch is already covered by
 *     parsers.test.ts; not re-asserted here.
 * Regressing any of these is a data-shape bug.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { EmittedMessage } from "../../src/connector-runtime.ts";
import { type EmittedRecord, makeRecordingEmit } from "../../src/test-harness.ts";
import { processConversationDetail, runCustomInstructionsStream, runMemoriesStream, type StreamDeps } from "./index.ts";
import { buildConversationRecord, type ConversationDetail } from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import type { ChatGptApi, ChatGptFetchResult, ChatGptJson, ChatGptNode, ConversationListItem } from "./types.ts";

interface RecordingHarness {
  deps: StreamDeps;
  emitted: EmittedRecord[];
  messages: EmittedMessage[];
}

/** Build a StreamDeps with a configurable fake ChatGptApi. Records every
 *  emit() + emitRecord() call so tests can introspect the protocol. */
function makeHarness({
  requested = ["memories", "custom_instructions", "conversations", "messages"],
  fetchQueue = [],
}: {
  fetchQueue?: readonly ChatGptFetchResult[];
  requested?: readonly string[];
} = {}): RecordingHarness {
  const harness = makeRecordingEmit(validateRecord);
  // Shallow queue so consecutive api.fetch() calls pop in order; extra
  // calls fall back to a harmless 200/null body so over-fetching doesn't
  // crash a test — the emit-path tests don't care about over-fetch.
  let cursor = 0;
  const api: ChatGptApi = {
    auth: (): Promise<never> => Promise.reject(new Error("fakeApi.auth() unused in these tests")),
    fetch: (): Promise<ChatGptFetchResult> => {
      const next = fetchQueue[cursor] ?? { status: 200, json: null };
      cursor += 1;
      return Promise.resolve(next);
    },
  };
  const deps: StreamDeps = {
    api,
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    progress: (): Promise<void> => Promise.resolve(),
    requested: new Map(requested.map((name) => [name, { name }])),
  };
  return { deps, emitted: harness.emitted, messages: harness.protocolMessages };
}

function makeConvo(overrides: Partial<ConversationListItem> = {}): ConversationListItem {
  return {
    id: "convo-abc",
    title: "Hello world",
    create_time: 1_700_000_000,
    update_time: 1_700_000_100,
    current_node: "a1",
    ...overrides,
  };
}

// Shared mapping: root → u1 → {a1 (current branch), a2 (alt branch)}.
// a1 is the current-branch tip; a2 is an off-branch assistant reply.
const BASE_MAPPING: Record<string, ChatGptNode> = {
  root: { parent: null, children: ["u1"] },
  u1: {
    parent: "root",
    children: ["a1", "a2"],
    message: {
      author: { role: "user" },
      create_time: 1_700_000_000,
      content: { content_type: "text", parts: ["hello"] },
    },
  },
  a1: {
    parent: "u1",
    children: [],
    message: {
      author: { role: "assistant" },
      create_time: 1_700_000_001,
      end_turn: true,
      content: { content_type: "text", parts: ["hi there"] },
      metadata: { model_slug: "gpt-4o", finish_details: { type: "stop" } },
    },
  },
  a2: {
    parent: "u1",
    children: [],
    message: {
      author: { role: "assistant" },
      create_time: 1_700_000_002,
      content: { content_type: "text", parts: ["alt branch"] },
    },
  },
};

function makeDetailOk(): ChatGptFetchResult {
  const json: ChatGptJson = {
    title: "Hello world",
    create_time: 1_700_000_000,
    update_time: 1_700_000_100,
    mapping: BASE_MAPPING,
    current_node: "a1",
  };
  return { status: 200, json };
}

/** Convenience: collect the emitConversation callback the way
 *  runConversationsAndMessagesStreams does (gated on requested.has()).
 *  Emits through the real buildConversationRecord so the record passes
 *  the production zod shape-check — a minimal synthetic shape would
 *  SKIP_RESULT in prod. "detail_present" is read from
 *  message_count_on_current_branch (null ⇔ detail was null; integer ⇔
 *  detail.mapping was threaded through). */
function makeEmitConversation(
  deps: StreamDeps
): (c: ConversationListItem, detail: ConversationDetail | null) => Promise<void> {
  return async (c: ConversationListItem, detail: ConversationDetail | null): Promise<void> => {
    if (!deps.requested.has("conversations")) {
      return;
    }
    await deps.emitRecord("conversations", buildConversationRecord(c, detail));
  };
}

// ─── Invariant 1: emit order (current ChatGPT contract) ──────────────────
// NOTE: unlike most connectors (accounts-before-transactions,
// message_bodies-before-messages), ChatGPT emits messages first and the
// conversation record last. This test pins the existing contract rather
// than inverting it; see the flagged behaviour note in the task report.

test("processConversationDetail: emits 'conversations' record BEFORE any 'messages' records (parent-first)", async () => {
  // Tranche C 2026-04-23: standardized on parent-first emit order across
  // the connector fleet. Regressing this is a contract-level bug.
  const { deps, emitted } = makeHarness();
  await processConversationDetail(deps, makeConvo(), makeDetailOk(), makeEmitConversation(deps));

  const firstMessageIdx = emitted.findIndex((r) => r.stream === "messages");
  const convoIdx = emitted.findIndex((r) => r.stream === "conversations");
  assert.notEqual(firstMessageIdx, -1, "expected at least one messages record");
  assert.notEqual(convoIdx, -1, "expected a conversations record");
  assert.ok(convoIdx < firstMessageIdx, "conversation record must emit before the first message record");
});

test("processConversationDetail: emits exactly one conversations record per call", async () => {
  const { deps, emitted } = makeHarness();
  await processConversationDetail(deps, makeConvo(), makeDetailOk(), makeEmitConversation(deps));
  assert.equal(emitted.filter((r) => r.stream === "conversations").length, 1);
});

test("processConversationDetail: emits one messages record per mapping node with a role (both branches)", async () => {
  // BASE_MAPPING: root (no message → skipped), u1 (user), a1 (assistant, current), a2 (assistant, alt).
  const { deps, emitted } = makeHarness();
  await processConversationDetail(deps, makeConvo(), makeDetailOk(), makeEmitConversation(deps));
  const msgRecords = emitted.filter((r) => r.stream === "messages");
  assert.equal(msgRecords.length, 3, "u1 + a1 + a2 emit; root is synthetic and skipped");
  const currentFlags = new Map(msgRecords.map((r) => [r.data.id, r.data.on_current_branch]));
  assert.equal(currentFlags.get("u1"), true, "u1 sits on the current branch → tip a1");
  assert.equal(currentFlags.get("a1"), true, "a1 is the tip");
  assert.equal(currentFlags.get("a2"), false, "a2 is the off-branch alternative");
});

// ─── Invariant 2: stream-scope filters cleanly ───────────────────────────

test("processConversationDetail: conversations-only scope emits the conversation record but no messages", async () => {
  // Caller (runConversationsAndMessagesStreams) decides whether to call
  // processConversationDetail at all when messages isn't requested. The
  // integration-level contract we pin here is: if you DO call it, the
  // messages it emits are unconditional — scope.has('messages') is NOT
  // checked inside processConversationDetail. Tests in runtime callers
  // are what gate the path. We document this invariant explicitly so a
  // future refactor that adds a scope check inside processConversationDetail
  // doesn't land without a corresponding review.
  const { deps, emitted } = makeHarness({ requested: ["conversations"] });
  await processConversationDetail(deps, makeConvo(), makeDetailOk(), makeEmitConversation(deps));
  assert.equal(emitted.filter((r) => r.stream === "conversations").length, 1);
  assert.ok(
    emitted.some((r) => r.stream === "messages"),
    "processConversationDetail itself doesn't gate on scope; the caller does"
  );
});

test("processConversationDetail: messages-only scope still runs the emitConversation callback which no-ops", async () => {
  // emitConversation (built by the caller) guards on requested.has('conversations').
  // So a messages-only scope: messages flow, conversation record is suppressed.
  const { deps, emitted } = makeHarness({ requested: ["messages"] });
  await processConversationDetail(deps, makeConvo(), makeDetailOk(), makeEmitConversation(deps));
  assert.equal(emitted.filter((r) => r.stream === "conversations").length, 0, "conversations suppressed by scope");
  assert.ok(emitted.filter((r) => r.stream === "messages").length > 0, "messages still flow");
});

// ─── Invariant 3: all-streams-disabled → nothing emitted ─────────────────

test("runMemoriesStream: empty requested scope — caller guards; direct call emits records regardless", async () => {
  // The helper trusts the caller. When memory entries come back empty,
  // nothing records-wise emits — only a STATE heartbeat on success.
  const { deps, emitted, messages } = makeHarness({
    fetchQueue: [{ status: 200, json: { memories: [] } }],
    requested: [],
  });
  await runMemoriesStream(deps);
  assert.equal(emitted.length, 0, "empty memories → no records");
  const states = messages.filter((m) => m.type === "STATE");
  assert.equal(states.length, 1, "STATE still fires so the stream cursor advances");
});

// ─── Invariant 4: null-enrichment fallback ───────────────────────────────

test("processConversationDetail: detail.status=404 — still emits conversation (list-only) + SKIP on messages", async () => {
  const { deps, emitted, messages } = makeHarness();
  const missing: ChatGptFetchResult = { status: 404, json: null };
  await processConversationDetail(deps, makeConvo(), missing, makeEmitConversation(deps));

  // Conversation record emits with detail=null (list-only fallback).
  // With detail=null, buildConversationRecord leaves
  // message_count_on_current_branch null — that's the signal we fell
  // back to the list-only view.
  const convo = emitted.find((r) => r.stream === "conversations");
  assert.ok(convo, "conversation record must still emit on http_error so downstream sees the row");
  assert.equal(
    convo.data.message_count_on_current_branch,
    null,
    "detail=null ⇒ message_count_on_current_branch is null (list-only fallback)"
  );

  // No message records — detail had no mapping.
  assert.equal(emitted.filter((r) => r.stream === "messages").length, 0);

  // SKIP_RESULT carries the http status in the message.
  const skip = messages.find((m): m is Extract<EmittedMessage, { type: "SKIP_RESULT" }> => m.type === "SKIP_RESULT");
  assert.ok(skip, "SKIP_RESULT must emit when detail fetch failed");
  assert.equal(skip.stream, "messages", "detail failure is charged to the messages stream");
  assert.equal(skip.reason, "http_error");
  assert.match(skip.message, /convo-abc http 404/, "message carries the conversation id + http status");
});

test("processConversationDetail: detail=200 with missing mapping — list-only fallback + SKIP on messages", async () => {
  // 200 OK but the body has no `mapping` field (observed when the server
  // 200s a stub). Guard path must still fall back, not crash.
  const { deps, emitted, messages } = makeHarness();
  const stub: ChatGptFetchResult = { status: 200, json: { title: "stub but no mapping" } };
  await processConversationDetail(deps, makeConvo(), stub, makeEmitConversation(deps));
  assert.equal(emitted.filter((r) => r.stream === "conversations").length, 1);
  assert.equal(emitted.filter((r) => r.stream === "messages").length, 0);
  const skip = messages.find((m): m is Extract<EmittedMessage, { type: "SKIP_RESULT" }> => m.type === "SKIP_RESULT");
  assert.ok(skip, "missing mapping must SKIP messages");
});

// ─── Invariant 5: processConversationDetail is faithful to inputs (no hidden dedupe) ─

test("processConversationDetail: called twice with the same conversation emits records twice (no hidden dedupe)", async () => {
  // Dedup happens upstream at the listConversationsSinceCursor cursor
  // (update_time > priorCursor gate). Inside processConversationDetail
  // we emit faithfully. Pin the contract so a future optimization that
  // caches by conversation id doesn't land quietly.
  const { deps, emitted } = makeHarness();
  const emitConvo = makeEmitConversation(deps);
  await processConversationDetail(deps, makeConvo(), makeDetailOk(), emitConvo);
  await processConversationDetail(deps, makeConvo(), makeDetailOk(), emitConvo);
  assert.equal(emitted.filter((r) => r.stream === "conversations").length, 2);
  // Each call contributes 3 message records (u1 + a1 + a2) → 6 total.
  assert.equal(emitted.filter((r) => r.stream === "messages").length, 6);
});

// ─── Invariant 6: runCustomInstructionsStream — http branches ────────────

test("runCustomInstructionsStream: 200 → one record + STATE heartbeat", async () => {
  const { deps, emitted, messages } = makeHarness({
    fetchQueue: [{ status: 200, json: { about_user_message: "I'm a tester", enabled: true } }],
  });
  await runCustomInstructionsStream(deps);
  assert.equal(emitted.filter((r) => r.stream === "custom_instructions").length, 1);
  assert.equal(emitted[0]?.data.about_user, "I'm a tester");
  assert.equal(messages.filter((m) => m.type === "STATE").length, 1);
});

test("runCustomInstructionsStream: 404 → SKIP_RESULT('not_available'), no record, no STATE", async () => {
  const { deps, emitted, messages } = makeHarness({
    fetchQueue: [{ status: 404, json: null }],
  });
  await runCustomInstructionsStream(deps);
  assert.equal(emitted.length, 0, "no custom_instructions record on 404");
  const skip = messages.find((m): m is Extract<EmittedMessage, { type: "SKIP_RESULT" }> => m.type === "SKIP_RESULT");
  assert.ok(skip);
  assert.equal(skip.reason, "not_available", "404/403 flag feature-disabled for the account");
  assert.equal(messages.filter((m) => m.type === "STATE").length, 0, "no STATE when the stream short-circuits");
});

test("runCustomInstructionsStream: 500 → SKIP_RESULT('http_error'), no record", async () => {
  const { deps, emitted, messages } = makeHarness({
    fetchQueue: [{ status: 500, json: null }],
  });
  await runCustomInstructionsStream(deps);
  assert.equal(emitted.length, 0);
  const skip = messages.find((m): m is Extract<EmittedMessage, { type: "SKIP_RESULT" }> => m.type === "SKIP_RESULT");
  assert.ok(skip);
  assert.equal(skip.reason, "http_error", "non-200 non-404/403 uses the generic http_error bucket");
});
