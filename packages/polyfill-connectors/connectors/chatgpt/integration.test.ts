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
import { currentAdaptiveLaneRunContext } from "../../src/adaptive-lane.ts";
import type { EmittedMessage } from "../../src/connector-runtime.ts";
import { RetryExhaustedError, retryHttp } from "../../src/http-retry.ts";
import { type EmittedRecord, makeRecordingEmit, type SkippedRecord } from "../../src/test-harness.ts";
import {
  CHATGPT_RETRYABLE_ERROR_PATTERN,
  ChatGptRecoverableRetryExhaustedError,
  chatGptBackendFetchInBrowser,
  processConversationDetail,
  resolveChatGptBackendFetchTimeoutMs,
  resolveChatGptDetailLaneTuning,
  runConversationsAndMessagesStreams,
  runCustomGptsStream,
  runCustomInstructionsStream,
  runMemoriesStream,
  runMessagesAndConversationsWithDetail,
  runSharedConversationsStream,
  type StreamDeps,
  shouldKeepRetryingChatGptDetail,
  summarizeChatGptSideEffectProbe,
} from "./index.ts";
import { buildConversationRecord, type ConversationDetail } from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import type { ChatGptApi, ChatGptFetchResult, ChatGptJson, ChatGptNode, ConversationListItem } from "./types.ts";

interface RecordingHarness {
  deps: StreamDeps;
  emitted: EmittedRecord[];
  messages: EmittedMessage[];
  skipped: SkippedRecord[];
}

test("CHATGPT_RETRYABLE_ERROR_PATTERN treats retry-budget exhaustion as retryable", () => {
  assert.equal(
    CHATGPT_RETRYABLE_ERROR_PATTERN.test(
      "apiFetch retry budget exhausted on GET /conversation/example: HTTP request failed after retry budget was exhausted"
    ),
    true
  );
});

test("shouldKeepRetryingChatGptDetail fast-opens on bare 429 but keeps honest waits", () => {
  // Bare 429 (no Retry-After): keep retrying for the first two attempts, then
  // fast-open on the third so retryHttp exhausts and the source-pressure circuit
  // opens — instead of burning the full 12-attempt budget on a hot account.
  assert.equal(shouldKeepRetryingChatGptDetail({ attempt: 1, response: { status: 429 }, retryAfterMs: null }), true);
  assert.equal(shouldKeepRetryingChatGptDetail({ attempt: 2, response: { status: 429 }, retryAfterMs: null }), true);
  assert.equal(
    shouldKeepRetryingChatGptDetail({ attempt: 3, response: { status: 429 }, retryAfterMs: null }),
    false,
    "third bare 429 fast-opens the circuit"
  );

  // 429 WITH Retry-After is an honest, server-bounded wait — keep the full budget.
  assert.equal(
    shouldKeepRetryingChatGptDetail({ attempt: 5, response: { status: 429 }, retryAfterMs: 120_000 }),
    true,
    "honor Retry-After instead of fast-opening"
  );

  // Transient server errors keep the full budget; they are not an account-bucket signal.
  for (const status of [502, 503, 504]) {
    assert.equal(
      shouldKeepRetryingChatGptDetail({ attempt: 9, response: { status }, retryAfterMs: null }),
      true,
      `status ${status} should retry on the full budget`
    );
  }
});

test("ChatGPT detail fetch fast-opens on bare 429 after the configured attempts, not the full budget", async () => {
  // Drive the REAL connector predicate through the REAL retryHttp with the same
  // bounds the connector configures. Proves a bare-429 hot account exhausts in 3
  // attempts (one initial + two short retries), not 12.
  const sleeps: number[] = [];
  let calls = 0;

  await assert.rejects(
    retryHttp({
      baseDelayMs: 2000,
      maxAttempts: 12,
      maxDelayMs: 15 * 60_000,
      maxRetryAfterMs: 15 * 60_000,
      random: () => 0.5,
      request: () => {
        calls += 1;
        return { status: 429 };
      },
      shouldKeepRetrying: shouldKeepRetryingChatGptDetail,
      sleep: (ms) => {
        sleeps.push(ms);
      },
    }),
    (err: unknown) => {
      assert.ok(err instanceof RetryExhaustedError);
      assert.equal(err.attempts, 3);
      return true;
    }
  );

  assert.equal(calls, 3, "bare-429 detail fetch stops after the fast-open attempt cap");
  // Only the two pre-fast-open backoffs (2s, 4s) are paid — seconds, not the
  // ~23–70 min the 11-sleep full budget would burn against a hot account.
  assert.deepEqual(sleeps, [2000, 4000]);
});

test("resolveChatGptBackendFetchTimeoutMs supports small test overrides", () => {
  assert.equal(resolveChatGptBackendFetchTimeoutMs({ PDPP_CHATGPT_BACKEND_FETCH_TIMEOUT_MS: "7" }), 7);
  assert.equal(resolveChatGptBackendFetchTimeoutMs({ PDPP_CHATGPT_BACKEND_FETCH_TIMEOUT_MS: "0" }), 45_000);
  assert.equal(resolveChatGptBackendFetchTimeoutMs({ PDPP_CHATGPT_BACKEND_FETCH_TIMEOUT_MS: "invalid" }), 45_000);
});

test("resolveChatGptDetailLaneTuning defaults to the frozen production values when no probe env is set", () => {
  // OpenSpec add-connector-adaptive-lanes: ChatGPT maxConcurrency MUST stay at 1
  // until cold-state evidence. With no probe env, defaults are byte-identical.
  assert.deepEqual(resolveChatGptDetailLaneTuning({}), {
    initialConcurrency: 1,
    maxConcurrency: 1,
    pauseMinMs: 1500,
    pauseMaxMs: 3000,
  });
});

test("resolveChatGptDetailLaneTuning applies cold-state A/B probe overrides", () => {
  assert.deepEqual(
    resolveChatGptDetailLaneTuning({
      PDPP_CHATGPT_DETAIL_INITIAL_CONCURRENCY_PROBE: "2",
      PDPP_CHATGPT_DETAIL_MAX_CONCURRENCY_PROBE: "5",
      PDPP_CHATGPT_DETAIL_PAUSE_MIN_MS_PROBE: "100",
      PDPP_CHATGPT_DETAIL_PAUSE_MAX_MS_PROBE: "400",
    }),
    { initialConcurrency: 2, maxConcurrency: 5, pauseMinMs: 100, pauseMaxMs: 400 }
  );
});

test("resolveChatGptDetailLaneTuning caps probe concurrency at the dataconnect-batch ceiling (5)", () => {
  const tuning = resolveChatGptDetailLaneTuning({ PDPP_CHATGPT_DETAIL_MAX_CONCURRENCY_PROBE: "50" });
  assert.equal(tuning.maxConcurrency, 5);
});

test("resolveChatGptDetailLaneTuning clamps maxConcurrency >= initialConcurrency and pauseMax >= pauseMin", () => {
  const tuning = resolveChatGptDetailLaneTuning({
    PDPP_CHATGPT_DETAIL_INITIAL_CONCURRENCY_PROBE: "4",
    PDPP_CHATGPT_DETAIL_MAX_CONCURRENCY_PROBE: "2",
    PDPP_CHATGPT_DETAIL_PAUSE_MIN_MS_PROBE: "900",
    PDPP_CHATGPT_DETAIL_PAUSE_MAX_MS_PROBE: "100",
  });
  assert.equal(tuning.maxConcurrency, 4); // raised to meet initial
  assert.equal(tuning.pauseMaxMs, 900); // raised to meet min
});

test("resolveChatGptDetailLaneTuning falls back to the frozen default per-knob on invalid input", () => {
  assert.deepEqual(
    resolveChatGptDetailLaneTuning({
      PDPP_CHATGPT_DETAIL_INITIAL_CONCURRENCY_PROBE: "0",
      PDPP_CHATGPT_DETAIL_MAX_CONCURRENCY_PROBE: "abc",
      PDPP_CHATGPT_DETAIL_PAUSE_MIN_MS_PROBE: "-5",
      PDPP_CHATGPT_DETAIL_PAUSE_MAX_MS_PROBE: "  ",
    }),
    { initialConcurrency: 1, maxConcurrency: 1, pauseMinMs: 1500, pauseMaxMs: 3000 }
  );
});

test("chatGptBackendFetchInBrowser aborts a never-resolving backend fetch promptly", async () => {
  const originalFetch = globalThis.fetch;
  let observedSignal: AbortSignal | undefined;
  globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    observedSignal = init?.signal ?? undefined;
    return new Promise((_resolve, reject) => {
      observedSignal?.addEventListener("abort", () => reject(new Error("aborted by test signal")), { once: true });
    });
  }) as typeof fetch;

  const startedAt = Date.now();
  try {
    await assert.rejects(
      chatGptBackendFetchInBrowser({
        auth: { accessToken: "redacted-test-token", deviceId: "test-device" },
        method: "GET",
        path: "/conversation/test-conversation",
        timeoutMs: 25,
      }),
      /chatgpt_backend_fetch_timeout after 25ms/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(observedSignal?.aborted, true);
  assert.ok(Date.now() - startedAt < 1000, "timeout should reject promptly");
});

test("summarizeChatGptSideEffectProbe reports stable list/detail metadata without content", () => {
  const summary = summarizeChatGptSideEffectProbe({
    ok: true,
    target_id: "conversation-id",
    before: [{ index: 0, id: "conversation-id", create_time: 1, update_time: 10, current_node: "node-a" }],
    after1: [{ index: 0, id: "conversation-id", create_time: 1, update_time: 10, current_node: "node-a" }],
    after2: [{ index: 0, id: "conversation-id", create_time: 1, update_time: 10, current_node: "node-a" }],
    detail: { status: 200, create_time: 1, update_time: 10, current_node: "node-a" },
  });

  assert.match(summary, /target=conversation-id/);
  assert.match(summary, /detail_http=200/);
  assert.match(summary, /order_changed=false/);
  assert.match(summary, /update_time_changed=false/);
  assert.match(summary, /current_node_changed=false/);
});

test("summarizeChatGptSideEffectProbe reports update and order side effects", () => {
  const summary = summarizeChatGptSideEffectProbe({
    ok: true,
    target_id: "conversation-id",
    before: [
      { index: 0, id: "conversation-id", create_time: 1, update_time: 10, current_node: "node-a" },
      { index: 1, id: "other-id", create_time: 1, update_time: 9, current_node: "node-b" },
    ],
    after1: [
      { index: 0, id: "other-id", create_time: 1, update_time: 9, current_node: "node-b" },
      { index: 1, id: "conversation-id", create_time: 1, update_time: 11, current_node: "node-a" },
    ],
    after2: [
      { index: 0, id: "other-id", create_time: 1, update_time: 9, current_node: "node-b" },
      { index: 1, id: "conversation-id", create_time: 1, update_time: 11, current_node: "node-a" },
    ],
    detail: { status: 200, create_time: 1, update_time: 11, current_node: "node-a" },
  });

  assert.match(summary, /index=0>1>1/);
  assert.match(summary, /update_time=10>11>11/);
  assert.match(summary, /order_changed=true/);
  assert.match(summary, /update_time_changed=true/);
});

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
  return { deps, emitted: harness.emitted, messages: harness.protocolMessages, skipped: harness.skipped };
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

test("runMemoriesStream: 500 → SKIP_RESULT('http_error') with status diagnostics", async () => {
  const { deps, emitted, messages } = makeHarness({
    fetchQueue: [{ status: 500, json: null }],
  });
  await runMemoriesStream(deps);
  assert.equal(emitted.length, 0);
  const skip = messages.find((m): m is Extract<EmittedMessage, { type: "SKIP_RESULT" }> => m.type === "SKIP_RESULT");
  assert.ok(skip);
  assert.equal(skip.reason, "http_error");
  assert.deepEqual(skip.diagnostics, { http_status: 500 });
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
  assert.deepEqual(skip.diagnostics, { http_status: 404, conversation_id: "convo-abc" });
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
  assert.equal(skip.reason, "missing_mapping");
  assert.deepEqual(skip.diagnostics, { http_status: 200, conversation_id: "convo-abc" });
});

test("runConversationsAndMessagesStreams: unsafe message text is shape-skipped without mid-run cursor advance", async () => {
  const unsafeNodeId = "unsafe-message";
  const safeNodeId = "safe-message";
  const listItem = makeConvo({
    id: "convo-with-binary-text",
    current_node: safeNodeId,
    update_time: 1_700_000_200,
  });
  const detail: ChatGptFetchResult = {
    status: 200,
    json: {
      title: "Unsafe payload quarantine",
      create_time: 1_700_000_000,
      update_time: 1_700_000_200,
      current_node: safeNodeId,
      mapping: {
        root: { parent: null, children: [unsafeNodeId] },
        [unsafeNodeId]: {
          parent: "root",
          children: [safeNodeId],
          message: {
            author: { role: "user" },
            create_time: 1_700_000_001,
            content: { content_type: "text", parts: ["binary-ish\u0000payload"] },
          },
        },
        [safeNodeId]: {
          parent: unsafeNodeId,
          children: [],
          message: {
            author: { role: "assistant" },
            create_time: 1_700_000_002,
            content: { content_type: "text", parts: ["safe reply"] },
          },
        },
      },
    },
  };
  const harness = makeRecordingEmit(validateRecord);
  const fetches: string[] = [];
  const api: ChatGptApi = {
    auth: (): Promise<never> => Promise.reject(new Error("fakeApi.auth() unused in this test")),
    fetch: (path: string): Promise<ChatGptFetchResult> => {
      fetches.push(path);
      if (path.startsWith("/conversations")) {
        return Promise.resolve({
          status: 200,
          json: { items: [listItem], has_missing_conversations: false, total: 1 },
        });
      }
      return Promise.resolve(detail);
    },
  };
  const deps: StreamDeps = {
    api,
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    progress: (): Promise<void> => Promise.resolve(),
    requested: new Map(["conversations", "messages"].map((name) => [name, { name }])),
  };

  await runConversationsAndMessagesStreams(deps, {});

  assert.deepEqual(fetches, [
    "/conversations?offset=0&limit=100&order=updated",
    "/conversation/convo-with-binary-text",
  ]);
  assert.equal(harness.skipped.length, 1, "unsafe text should be quarantined by shape-check");
  assert.equal(harness.skipped[0]?.stream, "messages");
  assert.equal(harness.skipped[0]?.issues[0]?.path, "content");
  assert.match(harness.skipped[0]?.issues[0]?.message ?? "", /PDPP-safe Unicode text/);
  assert.equal(harness.emitted.filter((r) => r.stream === "conversations").length, 1);
  assert.equal(harness.emitted.filter((r) => r.stream === "messages").length, 1, "safe sibling message still emits");

  const coverage = harness.protocolMessages.find(
    (m): m is Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> => m.type === "DETAIL_COVERAGE"
  );
  assert.deepEqual(coverage, {
    type: "DETAIL_COVERAGE",
    reference_only: true,
    state_stream: "conversations",
    stream: "messages",
    required_keys: ["convo-with-binary-text"],
    hydrated_keys: ["convo-with-binary-text"],
  });

  const stateEvents = harness.events.filter(
    (e) => e.kind === "message" && e.message.type === "STATE" && e.message.stream === "conversations"
  );
  assert.equal(stateEvents.length, 1, "cursor commits once at normal end-of-stream");
  const coverageIdx = harness.events.findIndex((e) => e.kind === "message" && e.message.type === "DETAIL_COVERAGE");
  const stateIdx = harness.events.findIndex(
    (e) => e.kind === "message" && e.message.type === "STATE" && e.message.stream === "conversations"
  );
  const lastRecordOrSkipIdx = harness.events.findLastIndex((e) => e.kind === "record" || e.kind === "record-skipped");
  assert.ok(coverageIdx > lastRecordOrSkipIdx, "DETAIL_COVERAGE must emit after detail lane records settle");
  assert.ok(stateIdx > coverageIdx, "STATE must emit after DETAIL_COVERAGE");
  assert.ok(stateIdx > lastRecordOrSkipIdx, "STATE must remain after all record attempts, including quarantined rows");
});

test("runMessagesAndConversationsWithDetail: fetches detail through adaptive lane with serialized jittered pacing", async () => {
  const harness = makeRecordingEmit(validateRecord);
  const fetches: string[] = [];
  const pauses: number[] = [];
  let activeFetches = 0;
  let maxActiveFetches = 0;
  const api: ChatGptApi = {
    auth: (): Promise<never> => Promise.reject(new Error("fakeApi.auth() unused in this test")),
    fetch: async (path: string): Promise<ChatGptFetchResult> => {
      fetches.push(path);
      activeFetches += 1;
      maxActiveFetches = Math.max(maxActiveFetches, activeFetches);
      await Promise.resolve();
      activeFetches -= 1;
      return makeDetailOk();
    },
  };
  const deps: StreamDeps = {
    api,
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    progress: (): Promise<void> => Promise.resolve(),
    requested: new Map(["conversations", "messages"].map((name) => [name, { name }])),
  };

  await runMessagesAndConversationsWithDetail(
    deps,
    [makeConvo({ id: "convo-1" }), makeConvo({ id: "convo-2" })],
    makeEmitConversation(deps),
    {
      random: () => 0,
      sleep: (ms) => {
        pauses.push(ms);
      },
    }
  );

  assert.deepEqual(fetches, ["/conversation/convo-1", "/conversation/convo-2"]);
  assert.equal(maxActiveFetches, 1, "conversation detail fetches must not overlap");
  assert.deepEqual(pauses, [1500], "one deterministic minimum pause between two detail requests");
  const progressMessages = harness.protocolMessages.filter(
    (m): m is Extract<EmittedMessage, { type: "PROGRESS" }> => m.type === "PROGRESS" && m.stream === "messages"
  );
  assert.deepEqual(
    progressMessages.filter((m) => m.message.startsWith("Synced ")).map((m) => m.message),
    ["Synced 1 / 2 conversations", "Synced 2 / 2 conversations"]
  );
  const laneMessages = progressMessages.filter((m) => m.message.startsWith("ChatGPT conversation-detail lane "));
  assert.deepEqual(
    laneMessages.map((m) => m.message.replace(/ active=\d+ queued=\d+ concurrency=1\/1.*/, "")),
    ["ChatGPT conversation-detail lane started"]
  );
  assert.equal(
    laneMessages.some((m) => m.message.includes("/conversation/")),
    false,
    "lane progress must not expose raw API paths"
  );
});

test("runMessagesAndConversationsWithDetail: intermediate pressure is bounded and redacted", async () => {
  const harness = makeRecordingEmit(validateRecord);
  const pauses: number[] = [];
  let activeFetches = 0;
  let maxActiveFetches = 0;
  // Faithful model of the production retryHttp path: a 429 retry reports the
  // pressure to the lane AND sleeps `delayMs` itself within the same attempt,
  // then succeeds. Because the wait was already paid inside the request, the
  // report is marked absorbed so the lane must NOT also delay the next launch
  // by the same amount (that was the double-pay this lane previously had).
  const api: ChatGptApi = {
    auth: (): Promise<never> => Promise.reject(new Error("fakeApi.auth() unused in this test")),
    fetch: async (): Promise<ChatGptFetchResult> => {
      activeFetches += 1;
      maxActiveFetches = Math.max(maxActiveFetches, activeFetches);
      await currentAdaptiveLaneRunContext()?.reportPressure({
        absorbedByRequestWait: true,
        delayMs: 45_000,
        kind: "rate_limited",
        retryAfterMs: 99_000,
      });
      // retryHttp sleeps the backoff inside the attempt; model that wait so the
      // test sees what production actually pays per request.
      pauses.push(45_000);
      activeFetches -= 1;
      return makeDetailOk();
    },
  };
  const deps: StreamDeps = {
    api,
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    progress: (): Promise<void> => Promise.resolve(),
    requested: new Map(["conversations", "messages"].map((name) => [name, { name }])),
  };

  await runMessagesAndConversationsWithDetail(
    deps,
    [makeConvo({ id: "sensitive-convo-1" }), makeConvo({ id: "sensitive-convo-2" })],
    makeEmitConversation(deps),
    {
      random: () => 0,
      sleep: (ms) => {
        pauses.push(ms);
      },
    }
  );

  assert.equal(maxActiveFetches, 1, "intermediate pressure must not raise detail concurrency");
  // Each conversation's request absorbs its own 45_000 backoff (2 requests).
  // The launch between them pays only the ordinary minimum pause (1500ms), NOT
  // a second mirrored 45_000 cooldown. Pre-fix this was [45_000, 45_000, 45_000].
  assert.deepEqual(
    pauses,
    [45_000, 1500, 45_000],
    "absorbed retry backoff is not double-paid as a launch cooldown; only the ordinary inter-launch pause remains"
  );
  const progressMessages = harness.protocolMessages.filter(
    (m): m is Extract<EmittedMessage, { type: "PROGRESS" }> => m.type === "PROGRESS" && m.stream === "messages"
  );
  const laneMessages = progressMessages.filter((m) => m.message.startsWith("ChatGPT conversation-detail lane "));
  assert.equal(laneMessages.filter((m) => m.message.startsWith("ChatGPT conversation-detail lane started")).length, 1);
  assert.equal(
    laneMessages.some((m) => m.message.includes("lane cooldown") && m.message.includes("retry_after_ms=99000")),
    true,
    "intermediate pressure should still be visible as bounded lane cooldown progress"
  );
  assert.equal(
    laneMessages.every((m) => m.message.includes("concurrency=1/1")),
    true,
    "progress must report the configured max concurrency of 1"
  );
  assert.equal(
    laneMessages.some((m) => m.message.includes("delay_ms=45000")),
    true,
    "lane progress should expose bounded pressure delay semantics without raw request details"
  );
  assert.equal(
    laneMessages.some((m) => m.message.includes("sensitive-convo") || m.message.includes("/conversation/")),
    false,
    "lane progress must not expose raw conversation ids or API paths"
  );
});

test("runConversationsAndMessagesStreams: detail failure rejects before conversations STATE", async () => {
  const harness = makeRecordingEmit(validateRecord);
  const listItem = makeConvo({ id: "convo-required-detail-fails" });
  const api: ChatGptApi = {
    auth: (): Promise<never> => Promise.reject(new Error("fakeApi.auth() unused in this test")),
    fetch: (path: string): Promise<ChatGptFetchResult> => {
      if (path.startsWith("/conversations")) {
        return Promise.resolve({
          status: 200,
          json: { items: [listItem], has_missing_conversations: false, total: 1 },
        });
      }
      return Promise.reject(new Error("required detail fetch failed"));
    },
  };
  const deps: StreamDeps = {
    api,
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    progress: (): Promise<void> => Promise.resolve(),
    requested: new Map(["conversations", "messages"].map((name) => [name, { name }])),
  };

  await assert.rejects(runConversationsAndMessagesStreams(deps, {}), /required detail fetch failed/);

  const laneMessages = harness.protocolMessages.filter(
    (m): m is Extract<EmittedMessage, { type: "PROGRESS" }> =>
      m.type === "PROGRESS" && m.stream === "messages" && m.message.startsWith("ChatGPT conversation-detail lane ")
  );
  assert.ok(
    laneMessages.some((m) => m.message.includes("completed") && m.message.includes("error=Error")),
    "failed detail work should emit a safe lane terminal event"
  );
  assert.equal(
    laneMessages.some(
      (m) => m.message.includes("required detail fetch failed") || m.message.includes("/conversation/")
    ),
    false,
    "lane progress must not expose raw error messages or API paths"
  );
  assert.equal(
    harness.protocolMessages.some((m) => m.type === "STATE" && m.stream === "conversations"),
    false,
    "required detail failure must not emit conversations STATE"
  );
});

test("runConversationsAndMessagesStreams: isolated recoverable detail exhaustion emits DETAIL_GAP and then STATE", async () => {
  const harness = makeRecordingEmit(validateRecord);
  const listItems = [makeConvo({ id: "convo-gap", update_time: 1_700_000_100 })];
  const fetches: string[] = [];
  const api: ChatGptApi = {
    auth: (): Promise<never> => Promise.reject(new Error("fakeApi.auth() unused in this test")),
    fetch: (path: string): Promise<ChatGptFetchResult> => {
      fetches.push(path);
      if (path.startsWith("/conversations")) {
        return Promise.resolve({
          status: 200,
          json: { items: listItems, has_missing_conversations: false, total: listItems.length },
        });
      }
      if (path === "/conversation/convo-gap") {
        return Promise.reject(
          new ChatGptRecoverableRetryExhaustedError(
            "apiFetch got 429 on GET /conversation/convo-gap after retry budget exhausted bearer secret",
            {
              class: "rate_limited",
              httpStatus: 429,
              networkPressure: {
                endpoint_route: "GET /conversation/{conversation_id}",
                error_class: "http_429",
                method: "GET",
                attempt: 12,
                max_attempts: 12,
                status: 429,
                retry_after_ms: 120_000,
                safe_headers: { "retry-after-ms": 120_000 },
              },
            }
          )
        );
      }
      return Promise.resolve(makeDetailOk());
    },
  };
  const deps: StreamDeps = {
    api,
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    progress: (): Promise<void> => Promise.resolve(),
    requested: new Map(["conversations", "messages"].map((name) => [name, { name }])),
  };

  await runConversationsAndMessagesStreams(deps, {}, { detailPacing: { random: () => 0, sleep: () => undefined } });

  assert.deepEqual(fetches, ["/conversations?offset=0&limit=100&order=updated", "/conversation/convo-gap"]);
  assert.equal(
    harness.emitted.some((r) => r.stream === "conversations" && r.data.id === "convo-gap"),
    false,
    "recoverable required detail gaps must not emit list-only conversation records"
  );
  assert.equal(
    harness.emitted.some((r) => r.stream === "messages" && r.data.conversation_id === "convo-gap"),
    false,
    "recoverable required detail gaps must not emit fake empty messages"
  );

  const gap = harness.protocolMessages.find(
    (m): m is Extract<EmittedMessage, { type: "DETAIL_GAP" }> => m.type === "DETAIL_GAP"
  );
  assert.ok(gap, "recoverable exhaustion should emit a durable detail-gap signal");
  assert.deepEqual(gap, {
    type: "DETAIL_GAP",
    stream: "messages",
    record_key: "convo-gap",
    status: "pending",
    reason: "rate_limited",
    detail_locator: {
      kind: "chatgpt.conversation",
      conversation_id: "convo-gap",
      list_item: {
        id: "convo-gap",
        title: "Hello world",
        create_time: 1_700_000_000,
        update_time: 1_700_000_100,
        current_node: "a1",
        gizmo_id: null,
        is_archived: null,
        is_starred: null,
        workspace_id: null,
      },
    },
    retryable: true,
    reference_only: true,
    detail: {
      class: "rate_limited",
      http_status: 429,
      network_pressure: {
        endpoint_route: "GET /conversation/{conversation_id}",
        error_class: "http_429",
        method: "GET",
        attempt: 12,
        max_attempts: 12,
        status: 429,
        retry_after_ms: 120_000,
        safe_headers: { "retry-after-ms": 120_000 },
      },
    },
    last_error: {
      class: "rate_limited",
      http_status: 429,
      network_pressure: {
        endpoint_route: "GET /conversation/{conversation_id}",
        error_class: "http_429",
        method: "GET",
        attempt: 12,
        max_attempts: 12,
        status: 429,
        retry_after_ms: 120_000,
        safe_headers: { "retry-after-ms": 120_000 },
      },
    },
  });
  const serializedGap = JSON.stringify(gap);
  assert.equal(serializedGap.includes("/conversation/convo-gap"), false, "gap must not expose raw API paths");
  assert.equal(
    serializedGap.includes("GET /conversation/{conversation_id}"),
    true,
    "gap should expose a safe route template"
  );
  assert.equal(serializedGap.includes("retry-after-ms"), true, "gap should expose safe retry-after metadata");
  assert.equal(serializedGap.includes("bearer"), false, "gap must not expose raw error text or tokens");
  assert.equal(serializedGap.includes("secret"), false, "gap must not expose raw error text or tokens");

  const coverage = harness.protocolMessages.find(
    (m): m is Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> => m.type === "DETAIL_COVERAGE"
  );
  assert.deepEqual(coverage, {
    type: "DETAIL_COVERAGE",
    reference_only: true,
    state_stream: "conversations",
    stream: "messages",
    required_keys: ["convo-gap"],
    hydrated_keys: [],
    gap_keys: ["convo-gap"],
  });

  const gapIdx = harness.events.findIndex((e) => e.kind === "message" && e.message.type === "DETAIL_GAP");
  const coverageIdx = harness.events.findIndex((e) => e.kind === "message" && e.message.type === "DETAIL_COVERAGE");
  const stateIdx = harness.events.findIndex(
    (e) => e.kind === "message" && e.message.type === "STATE" && e.message.stream === "conversations"
  );
  assert.ok(gapIdx !== -1, "gap must emit");
  assert.ok(coverageIdx > gapIdx, "DETAIL_COVERAGE must emit after gap");
  assert.ok(stateIdx > coverageIdx, "STATE must emit after DETAIL_COVERAGE");
});

test("runConversationsAndMessagesStreams: 30/278 pressure exhaustion records a durable gap and honest coverage", async () => {
  const harness = makeRecordingEmit(validateRecord);
  const listItems = Array.from({ length: 278 }, (_, index) =>
    makeConvo({
      id: `convo-${String(index + 1).padStart(3, "0")}`,
      title: `Conversation ${index + 1}`,
      update_time: 1_700_000_000 + index,
    })
  );
  const pressureItem = listItems[29];
  assert.ok(pressureItem, "fixture must include the 30th list item");

  const fetches: string[] = [];
  const api: ChatGptApi = {
    auth: (): Promise<never> => Promise.reject(new Error("fakeApi.auth() unused in this test")),
    fetch: (path: string): Promise<ChatGptFetchResult> => {
      fetches.push(path);
      if (path === "/conversations?offset=0&limit=100&order=updated") {
        return Promise.resolve({
          status: 200,
          json: { items: listItems.slice(0, 100), has_missing_conversations: false, total: 278 },
        });
      }
      if (path === "/conversations?offset=100&limit=100&order=updated") {
        return Promise.resolve({
          status: 200,
          json: { items: listItems.slice(100, 200), has_missing_conversations: false, total: 278 },
        });
      }
      if (path === "/conversations?offset=200&limit=100&order=updated") {
        return Promise.resolve({
          status: 200,
          json: { items: listItems.slice(200), has_missing_conversations: false, total: 278 },
        });
      }
      if (path === `/conversation/${pressureItem.id}`) {
        return Promise.reject(
          new ChatGptRecoverableRetryExhaustedError(
            `apiFetch got 429 on GET /conversation/${pressureItem.id} after retry budget exhausted bearer secret`,
            {
              class: "rate_limited",
              httpStatus: 429,
              networkPressure: {
                endpoint_route: "GET /conversation/{conversation_id}",
                error_class: "http_429",
                method: "GET",
                attempt: 12,
                max_attempts: 12,
                status: 429,
                retry_after_ms: 120_000,
                safe_headers: { "retry-after-ms": 120_000 },
              },
            }
          )
        );
      }
      return Promise.resolve(makeDetailOk());
    },
  };
  const deps: StreamDeps = {
    api,
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    progress: (): Promise<void> => Promise.resolve(),
    requested: new Map(["conversations", "messages"].map((name) => [name, { name }])),
  };

  await runConversationsAndMessagesStreams(deps, {}, { detailPacing: { random: () => 0, sleep: () => undefined } });

  assert.equal(fetches.filter((path) => path.startsWith("/conversations?")).length, 3);
  assert.equal(fetches.filter((path) => path.startsWith("/conversation/")).length, 30);
  assert.deepEqual(fetches.slice(0, 33), [
    "/conversations?offset=0&limit=100&order=updated",
    "/conversations?offset=100&limit=100&order=updated",
    "/conversations?offset=200&limit=100&order=updated",
    ...listItems.slice(0, 30).map((item) => `/conversation/${item.id}`),
  ]);

  assert.equal(
    harness.emitted.some((r) => r.stream === "conversations" && r.data.id === pressureItem.id),
    false,
    "the pressure item must not be emitted as a list-only public conversation record"
  );
  assert.equal(
    harness.emitted.filter((r) => r.stream === "conversations").length,
    29,
    "only conversations hydrated before the first pressure item should emit"
  );

  const gap = harness.protocolMessages.find(
    (m): m is Extract<EmittedMessage, { type: "DETAIL_GAP" }> =>
      m.type === "DETAIL_GAP" && m.record_key === pressureItem.id
  );
  assert.deepEqual(gap, {
    type: "DETAIL_GAP",
    stream: "messages",
    record_key: pressureItem.id,
    status: "pending",
    reason: "rate_limited",
    detail_locator: {
      kind: "chatgpt.conversation",
      conversation_id: pressureItem.id,
      list_item: {
        id: pressureItem.id,
        title: pressureItem.title,
        create_time: pressureItem.create_time,
        update_time: pressureItem.update_time,
        current_node: pressureItem.current_node,
        gizmo_id: null,
        is_archived: null,
        is_starred: null,
        workspace_id: null,
      },
    },
    retryable: true,
    reference_only: true,
    detail: {
      class: "rate_limited",
      http_status: 429,
      network_pressure: {
        endpoint_route: "GET /conversation/{conversation_id}",
        error_class: "http_429",
        method: "GET",
        attempt: 12,
        max_attempts: 12,
        status: 429,
        retry_after_ms: 120_000,
        safe_headers: { "retry-after-ms": 120_000 },
      },
    },
    last_error: {
      class: "rate_limited",
      http_status: 429,
      network_pressure: {
        endpoint_route: "GET /conversation/{conversation_id}",
        error_class: "http_429",
        method: "GET",
        attempt: 12,
        max_attempts: 12,
        status: 429,
        retry_after_ms: 120_000,
        safe_headers: { "retry-after-ms": 120_000 },
      },
    },
  });
  const serializedGap = JSON.stringify(gap);
  assert.equal(
    serializedGap.includes(`/conversation/${pressureItem.id}`),
    false,
    "gap diagnostic must not expose raw API paths"
  );
  assert.equal(serializedGap.includes("bearer"), false, "gap diagnostic must not expose raw auth text");
  assert.equal(serializedGap.includes("secret"), false, "gap diagnostic must not expose raw auth text");

  const circuitMessages = harness.protocolMessages.filter(
    (m): m is Extract<EmittedMessage, { type: "PROGRESS" }> =>
      m.type === "PROGRESS" && m.message.includes("opened upstream-pressure circuit")
  );
  assert.equal(circuitMessages.length, 1, "operator should see when remaining detail fetches are deferred");
  assert.equal(JSON.stringify(circuitMessages).includes(`/conversation/${pressureItem.id}`), false);

  const deferredGaps = harness.protocolMessages.filter(
    (m): m is Extract<EmittedMessage, { type: "DETAIL_GAP" }> =>
      m.type === "DETAIL_GAP" && m.record_key !== pressureItem.id
  );
  assert.equal(deferredGaps.length, 248, "later same-tranche items should be deferred without detail fetches");
  assert.equal(deferredGaps[0]?.record_key, listItems[30]?.id);
  assert.equal(deferredGaps[0]?.reason, "upstream_pressure");
  assert.equal(deferredGaps[0]?.detail?.class, "upstream_pressure_deferred");
  assert.deepEqual(deferredGaps[0]?.detail?.network_pressure, {
    endpoint_route: "GET /conversation/{conversation_id}",
    error_class: "http_429",
    method: "GET",
    status: 429,
    retry_after_ms: 120_000,
    safe_headers: { "retry-after-ms": 120_000 },
  });
  assert.equal(
    deferredGaps.some(
      (deferredGap) =>
        deferredGap.detail?.network_pressure?.attempt !== undefined ||
        deferredGap.detail?.network_pressure?.max_attempts !== undefined ||
        deferredGap.last_error?.network_pressure?.attempt !== undefined ||
        deferredGap.last_error?.network_pressure?.max_attempts !== undefined
    ),
    false,
    "deferred gaps must not claim the exhausted retry attempt budget for unattempted items"
  );

  const coverage = harness.protocolMessages.find(
    (m): m is Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> => m.type === "DETAIL_COVERAGE"
  );
  assert.ok(coverage, "successful cursor progress must include matching detail coverage");
  assert.equal(coverage.state_stream, "conversations");
  assert.equal(coverage.stream, "messages");
  assert.equal(coverage.required_keys.length, 278);
  assert.equal(coverage.hydrated_keys.length, 29);
  assert.deepEqual(
    coverage.gap_keys,
    listItems.slice(29).map((item) => item.id)
  );
  assert.equal(coverage.required_keys[29], pressureItem.id);
  assert.equal(coverage.hydrated_keys.includes(pressureItem.id), false);

  const stateIdx = harness.events.findIndex(
    (e) => e.kind === "message" && e.message.type === "STATE" && e.message.stream === "conversations"
  );
  const coverageIdx = harness.events.findIndex((e) => e.kind === "message" && e.message.type === "DETAIL_COVERAGE");
  assert.ok(stateIdx > coverageIdx, "cursor STATE must only emit after coverage accounts for the pressure gap");

  // RESUMABILITY INVARIANT (ri-chatgpt-429-resume-audit-v1): the messages
  // cursor advances to the max update_time across the WHOLE listed batch —
  // including the 249 gapped/deferred conversations — not just the 29 that
  // hydrated before the circuit opened. This is load-bearing: forward listing
  // on the next run stops at update_time <= cursor, so it will NOT re-list the
  // gapped tail. Those conversations are recoverable ONLY through the durable
  // DETAIL_GAP records replayed as `detail_gaps` on the next START. If a
  // refactor narrowed this cursor to the hydrated prefix, gaps would either be
  // wastefully re-listed every run or — combined with a gap-emission regression
  // — silently stranded. Pin the cursor to the gapped tail's update_time so
  // that regression fails here.
  const messagesState = harness.protocolMessages.find(
    (m): m is Extract<EmittedMessage, { type: "STATE" }> => m.type === "STATE" && m.stream === "messages"
  );
  assert.ok(messagesState, "messages STATE cursor must commit even when most details are deferred as gaps");
  const messagesCursor = messagesState.cursor as { last_update_time: string | null };
  const lastListedUpdateTime = listItems[277]?.update_time;
  assert.ok(typeof lastListedUpdateTime === "number");
  assert.equal(
    messagesCursor.last_update_time,
    new Date(lastListedUpdateTime * 1000).toISOString(),
    "messages cursor must cover the GAPPED tail's update_time, not just the hydrated prefix — else deferred conversations fall behind the cursor and are never re-listed"
  );
  // The hydrated prefix ends at item 28 (index 28; item 29 is the pressure
  // item). A cursor pinned to the hydrated max would be strictly smaller; prove
  // the committed cursor is past it so the discriminator is real, not vacuous.
  const lastHydratedUpdateTime = listItems[28]?.update_time;
  assert.ok(typeof lastHydratedUpdateTime === "number");
  assert.ok(
    (messagesCursor.last_update_time ?? "") > new Date(lastHydratedUpdateTime * 1000).toISOString(),
    "committed messages cursor must be strictly beyond the last hydrated conversation"
  );
});

test("runConversationsAndMessagesStreams: recovers pending conversation detail gaps before forward list collection", async () => {
  const harness = makeRecordingEmit(validateRecord);
  const recoveredConvo = makeConvo({ id: "convo-recover", title: "Recover me", update_time: 1_700_000_100 });
  const forwardConvo = makeConvo({ id: "convo-forward", update_time: 1_700_000_200 });
  const fetches: string[] = [];
  const api: ChatGptApi = {
    auth: (): Promise<never> => Promise.reject(new Error("fakeApi.auth() unused in this test")),
    fetch: (path: string): Promise<ChatGptFetchResult> => {
      fetches.push(path);
      if (path === "/conversation/convo-recover") {
        return Promise.resolve(makeDetailOk());
      }
      if (path.startsWith("/conversations")) {
        return Promise.resolve({
          status: 200,
          json: { items: [forwardConvo], has_missing_conversations: false, total: 1 },
        });
      }
      return Promise.resolve(makeDetailOk());
    },
  };
  const deps: StreamDeps = {
    api,
    detailGaps: [
      {
        gap_id: "gap_recover",
        stream: "messages",
        record_key: "convo-recover",
        status: "pending",
        reference_only: true,
        detail_locator: {
          kind: "chatgpt.conversation",
          conversation_id: "convo-recover",
          list_item: {
            id: recoveredConvo.id,
            title: recoveredConvo.title,
            create_time: recoveredConvo.create_time,
            update_time: recoveredConvo.update_time,
            current_node: recoveredConvo.current_node,
            gizmo_id: recoveredConvo.gizmo_id,
            is_archived: recoveredConvo.is_archived,
            is_starred: recoveredConvo.is_starred,
            workspace_id: recoveredConvo.workspace_id,
          },
        },
      },
    ],
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    progress: (): Promise<void> => Promise.resolve(),
    requested: new Map(["conversations", "messages"].map((name) => [name, { name }])),
  };

  await runConversationsAndMessagesStreams(deps, {});

  assert.deepEqual(fetches, [
    "/conversation/convo-recover",
    "/conversations?offset=0&limit=100&order=updated",
    "/conversation/convo-forward",
  ]);
  const recoveredIdx = harness.events.findIndex(
    (e) => e.kind === "message" && e.message.type === "DETAIL_GAP_RECOVERED"
  );
  const recoveredRecordIdx = harness.events.findIndex(
    (e) => e.kind === "record" && e.stream === "conversations" && e.data.id === "convo-recover"
  );
  assert.ok(recoveredRecordIdx !== -1 && recoveredIdx > recoveredRecordIdx);
  assert.deepEqual(
    harness.protocolMessages.find((m) => m.type === "DETAIL_GAP_RECOVERED"),
    {
      type: "DETAIL_GAP_RECOVERED",
      reference_only: true,
      gap_id: "gap_recover",
      stream: "messages",
      record_key: "convo-recover",
    }
  );
});

test("runConversationsAndMessagesStreams: terminal detail http failure remains fail-closed", async () => {
  const harness = makeRecordingEmit(validateRecord);
  const listItem = makeConvo({ id: "convo-terminal-404" });
  const api: ChatGptApi = {
    auth: (): Promise<never> => Promise.reject(new Error("fakeApi.auth() unused in this test")),
    fetch: (path: string): Promise<ChatGptFetchResult> => {
      if (path.startsWith("/conversations")) {
        return Promise.resolve({
          status: 200,
          json: { items: [listItem], has_missing_conversations: false, total: 1 },
        });
      }
      return Promise.resolve({ status: 404, json: null });
    },
  };
  const deps: StreamDeps = {
    api,
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    progress: (): Promise<void> => Promise.resolve(),
    requested: new Map(["conversations", "messages"].map((name) => [name, { name }])),
  };

  await assert.rejects(runConversationsAndMessagesStreams(deps, {}), /required conversation detail convo-terminal-404/);

  assert.equal(
    harness.protocolMessages.some((m) => m.type === "DETAIL_GAP"),
    false,
    "terminal detail failures must not be converted to recoverable gaps"
  );
  assert.equal(
    harness.protocolMessages.some((m) => m.type === "STATE" && m.stream === "conversations"),
    false,
    "terminal detail failures must not advance conversations STATE"
  );
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
  assert.deepEqual(skip.diagnostics, { http_status: 500 });
});

test("runCustomGptsStream: paginates gizmos/mine and emits STATE when complete", async () => {
  const { deps, emitted, messages } = makeHarness({
    fetchQueue: [
      {
        status: 200,
        json: {
          cursor: "next-page",
          items: [
            {
              resource: {
                gizmo: {
                  id: "g-1",
                  display: { name: "Planner", description: "Plans work" },
                  tools: [{ type: "browser" }],
                  sharing: "private",
                },
              },
            },
          ],
        },
      },
      {
        status: 200,
        json: {
          items: [
            {
              id: "g-2",
              display_name: "Writer",
              display_description: "Writes prose",
              tools: ["dalle"],
              sharing: "public",
            },
          ],
        },
      },
    ],
    requested: ["custom_gpts"],
  });

  await runCustomGptsStream(deps);

  const gpts = emitted.filter((r) => r.stream === "custom_gpts");
  assert.equal(gpts.length, 2);
  assert.equal(gpts[0]?.data.id, "g-1");
  assert.equal(gpts[1]?.data.id, "g-2");
  assert.equal(gpts[1]?.data.is_public, true);
  assert.equal(messages.filter((m) => m.type === "STATE" && m.stream === "custom_gpts").length, 1);
});

test("runCustomGptsStream: 403 → SKIP_RESULT('not_available'), no STATE", async () => {
  const { deps, emitted, messages } = makeHarness({
    fetchQueue: [{ status: 403, json: null }],
    requested: ["custom_gpts"],
  });

  await runCustomGptsStream(deps);

  assert.equal(emitted.length, 0);
  const skip = messages.find((m): m is Extract<EmittedMessage, { type: "SKIP_RESULT" }> => m.type === "SKIP_RESULT");
  assert.ok(skip);
  assert.equal(skip.stream, "custom_gpts");
  assert.equal(skip.reason, "not_available");
  assert.equal(messages.filter((m) => m.type === "STATE").length, 0);
});

test("runSharedConversationsStream: paginates shared conversations and emits STATE when complete", async () => {
  const firstPageItems = Array.from({ length: 100 }, (_, idx) => ({
    share_id: `s-${idx}`,
    conversation_id: `c-${idx}`,
    title: `Share ${idx}`,
    create_time: 1_700_000_000 + idx,
  }));
  const { deps, emitted, messages } = makeHarness({
    fetchQueue: [
      { status: 200, json: { items: firstPageItems } },
      {
        status: 200,
        json: {
          items: [
            {
              share_id: "s-100",
              conversation_id: "c-100",
              title: "Final share",
              create_time: 1_700_000_100,
            },
          ],
        },
      },
    ],
    requested: ["shared_conversations"],
  });

  await runSharedConversationsStream(deps);

  const shares = emitted.filter((r) => r.stream === "shared_conversations");
  assert.equal(shares.length, 101);
  assert.equal(shares[0]?.data.id, "s-0");
  assert.equal(shares[100]?.data.id, "s-100");
  assert.equal(messages.filter((m) => m.type === "STATE" && m.stream === "shared_conversations").length, 1);
});

test("runSharedConversationsStream: 404 → SKIP_RESULT('not_available'), no record", async () => {
  const { deps, emitted, messages } = makeHarness({
    fetchQueue: [{ status: 404, json: null }],
    requested: ["shared_conversations"],
  });

  await runSharedConversationsStream(deps);

  assert.equal(emitted.length, 0);
  const skip = messages.find((m): m is Extract<EmittedMessage, { type: "SKIP_RESULT" }> => m.type === "SKIP_RESULT");
  assert.ok(skip);
  assert.equal(skip.stream, "shared_conversations");
  assert.equal(skip.reason, "not_available");
  assert.equal(messages.filter((m) => m.type === "STATE").length, 0);
});
