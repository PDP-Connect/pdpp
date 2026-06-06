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
import type { CollectContext, EmittedMessage } from "../../src/connector-runtime.ts";
import { RetryExhaustedError, retryHttp } from "../../src/http-retry.ts";
import { type EmittedRecord, makeRecordingEmit, type SkippedRecord } from "../../src/test-harness.ts";
import {
  applyChatGptColdStatePreflight,
  CHATGPT_RETRYABLE_ERROR_PATTERN,
  type ChatGptDetailLaneTuning,
  ChatGptRateLimitDensityTracker,
  ChatGptRecoverableRetryExhaustedError,
  ChatGptRunBudget,
  chatGptBackendFetchInBrowser,
  classifyChatGptSourcePressure,
  processConversationDetail,
  resolveChatGptBackendFetchTimeoutMs,
  resolveChatGptDetailLaneTuning,
  resolveChatGptMaxDetailFetchesPerRun,
  resolveChatGptMaxRunWallClockMs,
  resolveChatGptRateLimitDensityStop,
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

// ─── Cumulative 429-density early-stop ───────────────────────────────────

test("resolveChatGptRateLimitDensityStop defaults to the conservative threshold when unset", () => {
  assert.equal(resolveChatGptRateLimitDensityStop({}), 8);
});

test("resolveChatGptRateLimitDensityStop honors an explicit positive override", () => {
  assert.equal(resolveChatGptRateLimitDensityStop({ PDPP_CHATGPT_DETAIL_RATE_LIMIT_STOP_AFTER: "3" }), 3);
});

test("resolveChatGptRateLimitDensityStop disables the stop on a non-positive value (escape hatch)", () => {
  assert.equal(
    resolveChatGptRateLimitDensityStop({ PDPP_CHATGPT_DETAIL_RATE_LIMIT_STOP_AFTER: "0" }),
    Number.POSITIVE_INFINITY
  );
  assert.equal(
    resolveChatGptRateLimitDensityStop({ PDPP_CHATGPT_DETAIL_RATE_LIMIT_STOP_AFTER: "-1" }),
    Number.POSITIVE_INFINITY
  );
});

test("resolveChatGptRateLimitDensityStop falls back to the default on invalid (non-integer) input", () => {
  assert.equal(resolveChatGptRateLimitDensityStop({ PDPP_CHATGPT_DETAIL_RATE_LIMIT_STOP_AFTER: "abc" }), 8);
  assert.equal(resolveChatGptRateLimitDensityStop({ PDPP_CHATGPT_DETAIL_RATE_LIMIT_STOP_AFTER: "2.5" }), 8);
  assert.equal(resolveChatGptRateLimitDensityStop({ PDPP_CHATGPT_DETAIL_RATE_LIMIT_STOP_AFTER: "  " }), 8);
});

test("ChatGptRateLimitDensityTracker trips only once cumulative 429s reach the threshold", () => {
  const tracker = new ChatGptRateLimitDensityTracker(3);
  assert.equal(tracker.shouldStop(), false);
  tracker.recordRateLimited();
  tracker.recordRateLimited();
  assert.equal(tracker.count, 2);
  assert.equal(tracker.shouldStop(), false, "below threshold must not trip");
  tracker.recordRateLimited();
  assert.equal(tracker.count, 3);
  assert.equal(tracker.shouldStop(), true, "at threshold must trip");
});

test("ChatGptRateLimitDensityTracker with an Infinity threshold never trips (disabled)", () => {
  const tracker = new ChatGptRateLimitDensityTracker(Number.POSITIVE_INFINITY);
  for (let i = 0; i < 1000; i++) {
    tracker.recordRateLimited();
  }
  assert.equal(tracker.shouldStop(), false);
});

test("ChatGptRateLimitDensityTracker seeds with pre-detail served 429s and trips sooner", () => {
  // Two served 429s already absorbed before the detail lane (list pagination):
  // the tracker starts at 2 of 3 and trips on a single in-lane 429.
  const tracker = new ChatGptRateLimitDensityTracker(3, 2);
  assert.equal(tracker.count, 2, "seed carries the pre-detail count forward");
  assert.equal(tracker.shouldStop(), false, "still one short of the threshold");
  tracker.recordRateLimited();
  assert.equal(tracker.count, 3);
  assert.equal(tracker.shouldStop(), true, "one in-lane 429 trips after the seed");
});

test("ChatGptRateLimitDensityTracker seed at/over threshold trips before any in-lane 429", () => {
  // Pre-detail pressure already at the threshold: the detail phase must defer
  // its whole tail immediately rather than launch even one fetch.
  const tracker = new ChatGptRateLimitDensityTracker(3, 3);
  assert.equal(tracker.shouldStop(), true, "seed at threshold trips with zero in-lane 429s");
});

test("ChatGptRateLimitDensityTracker seed is sanitized (negatives floored, floats truncated)", () => {
  // The seed comes from a run-scoped counter; defend the invariant that it is a
  // non-negative integer so a stray value can never make the stop go backwards.
  assert.equal(new ChatGptRateLimitDensityTracker(5, -4).count, 0, "negative seed floors to 0");
  assert.equal(new ChatGptRateLimitDensityTracker(5, 2.9).count, 2, "fractional seed truncates");
  assert.equal(new ChatGptRateLimitDensityTracker(5).count, 0, "default seed is 0 (unchanged behavior)");
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

test("chatGptBackendFetchInBrowser status-only mode does not parse response JSON", async () => {
  const originalFetch = globalThis.fetch;
  let parsedJson = false;
  globalThis.fetch = (): Promise<Response> => {
    const response = new Response(null, { status: 200, headers: { "retry-after": "7" } });
    Object.defineProperty(response, "json", {
      value: (): Promise<never> => {
        parsedJson = true;
        return Promise.reject(new Error("json should not be parsed in status-only mode"));
      },
    });
    return Promise.resolve(response);
  };

  try {
    const result = await chatGptBackendFetchInBrowser({
      auth: { accessToken: "redacted-test-token", deviceId: "test-device" },
      method: "GET",
      parseJson: false,
      path: "/conversation/test-conversation",
      timeoutMs: 1000,
    });
    assert.deepEqual(result, { status: 200, json: null, headers: { "retry-after": "7" } });
    assert.equal(parsedJson, false, "status-only preflight must not parse the body");
  } finally {
    globalThis.fetch = originalFetch;
  }
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

test("processConversationDetail: detail=200 with mapping but zero message-bearing nodes — emits empty_detail SKIP", async () => {
  // Completeness guard for the silent-empty class (dataconnect audit rec #5):
  // a 200-with-mapping whose graph has only synthetic/role-less nodes lands a
  // bare conversation row with no messages. Without the guard there is no
  // signal at all and it is indistinguishable from data loss downstream.
  const { deps, emitted, messages } = makeHarness();
  const emptyGraph: ChatGptFetchResult = {
    status: 200,
    json: {
      title: "Voice-only conversation",
      create_time: 1_700_000_000,
      update_time: 1_700_000_100,
      current_node: "root",
      // Only a synthetic root (no `message`) and a child that is also
      // message-less — extractMessage returns null for both, so the loop
      // emits zero message records.
      mapping: {
        root: { parent: null, children: ["n1"] },
        n1: { parent: "root", children: [] },
      },
    },
  };
  await processConversationDetail(deps, makeConvo(), emptyGraph, makeEmitConversation(deps));

  // The conversation record STILL emits (we reached it; it is covered/hydrated).
  assert.equal(
    emitted.filter((r) => r.stream === "conversations").length,
    1,
    "empty-but-200 conversation still lands as a row"
  );
  // No message records — the graph had nothing message-bearing.
  assert.equal(emitted.filter((r) => r.stream === "messages").length, 0);
  // ...but the emptiness is now OBSERVABLE via a diagnostic.
  const skip = messages.find((m): m is Extract<EmittedMessage, { type: "SKIP_RESULT" }> => m.type === "SKIP_RESULT");
  assert.ok(skip, "200-with-mapping but zero messages must emit an empty_detail SKIP");
  assert.equal(skip.stream, "messages", "the empty-detail signal is charged to the messages stream");
  assert.equal(skip.reason, "empty_detail");
  assert.match(skip.message, /convo-abc/, "message carries the conversation id");
  assert.match(skip.message, /no message-bearing nodes/, "message names the empty-graph cause");
  assert.deepEqual(
    skip.diagnostics,
    { http_status: 200, conversation_id: "convo-abc", node_count: 2 },
    "node_count distinguishes a genuinely empty graph from one with only role-less nodes"
  );
});

test("processConversationDetail: detail=200 with at least one message — no empty_detail SKIP fires", async () => {
  // The guard must NOT fire on a normal conversation. Pins that the common
  // path stays diagnostic-free so empty_detail SKIPs are a real signal, not
  // noise on every conversation.
  const { deps, emitted, messages } = makeHarness();
  await processConversationDetail(deps, makeConvo(), makeDetailOk(), makeEmitConversation(deps));
  assert.ok(emitted.filter((r) => r.stream === "messages").length > 0, "messages emit on the normal path");
  const emptySkip = messages.find(
    (m): m is Extract<EmittedMessage, { type: "SKIP_RESULT" }> =>
      m.type === "SKIP_RESULT" && m.reason === "empty_detail"
  );
  assert.equal(emptySkip, undefined, "a conversation with messages must not emit an empty_detail SKIP");
});

test("runConversationsAndMessagesStreams: unsafe message content is sanitized to null, message still emits (no shape-skip)", async () => {
  // SLVP-ideal behavior: a message whose text contains U+0000 or other forbidden
  // control characters must NOT be dropped or made non-backfillable.
  // extractContent sanitizes at extraction time: content becomes null and the
  // record passes the schema. Both messages emit; no SKIP_RESULT is generated.
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
  // No SKIP_RESULT: unsafe content is sanitized to null at extraction time.
  assert.equal(harness.skipped.length, 0, "unsafe text is sanitized to null, not shape-skipped");
  // Both messages emit: unsafe one with content=null, safe one with text intact.
  const messageRecords = harness.emitted.filter((r) => r.stream === "messages");
  assert.equal(messageRecords.length, 2, "both messages emit (unsafe with null content, safe with text)");
  const unsafeRecord = messageRecords.find((r) => r.data.id === unsafeNodeId);
  assert.ok(unsafeRecord, "unsafe message record must be present");
  assert.equal(unsafeRecord?.data.content, null, "unsafe content is null after sanitization");
  const safeRecord = messageRecords.find((r) => r.data.id === safeNodeId);
  assert.equal(safeRecord?.data.content, "safe reply", "safe sibling content is preserved");
  assert.equal(harness.emitted.filter((r) => r.stream === "conversations").length, 1);

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
  const lastRecordIdx = harness.events.findLastIndex((e) => e.kind === "record");
  assert.ok(coverageIdx > lastRecordIdx, "DETAIL_COVERAGE must emit after detail lane records settle");
  assert.ok(stateIdx > coverageIdx, "STATE must emit after DETAIL_COVERAGE");
  assert.ok(stateIdx > lastRecordIdx, "STATE must remain after all record attempts");
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

test("runMessagesAndConversationsWithDetail: cumulative 429 density defers the remaining tail as upstream_pressure DETAIL_GAP", async () => {
  // Slow-bleed regime: each fetch is served a 429, honors a Retry-After, then
  // SUCCEEDS — so nothing ever throws and the exhaustion-only circuit never
  // opens. With a density threshold of 2, after two served 429s the lane must
  // stop launching new detail fetches and defer the rest as resumable gaps.
  const harness = makeRecordingEmit(validateRecord);
  const fetchedIds: string[] = [];
  const api: ChatGptApi = {
    auth: (): Promise<never> => Promise.reject(new Error("fakeApi.auth() unused in this test")),
    fetch: async (path: string): Promise<ChatGptFetchResult> => {
      fetchedIds.push(path);
      // Model production: a served 429 reports rate_limited pressure (the lane
      // surfaces this as a cooldown event the density tracker counts), sleeps
      // its own backoff, then the conversation succeeds.
      await currentAdaptiveLaneRunContext()?.reportPressure({
        absorbedByRequestWait: true,
        delayMs: 30_000,
        kind: "rate_limited",
        retryAfterMs: 30_000,
      });
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

  const coverage = await runMessagesAndConversationsWithDetail(
    deps,
    [
      makeConvo({ id: "convo-1" }),
      makeConvo({ id: "convo-2" }),
      makeConvo({ id: "convo-3" }),
      makeConvo({ id: "convo-4" }),
      makeConvo({ id: "convo-5" }),
    ],
    makeEmitConversation(deps),
    { random: () => 0, sleep: () => undefined, densityStopThreshold: 2 }
  );

  // Two conversations hydrate (each pays its own served 429); the 3rd launch
  // sees the tracker at threshold and opens the circuit, so convo-3..5 defer
  // without a fetch.
  assert.deepEqual(
    fetchedIds,
    ["/conversation/convo-1", "/conversation/convo-2"],
    "no detail fetch is launched once the density stop trips"
  );
  assert.deepEqual(coverage.hydratedKeys, ["convo-1", "convo-2"]);
  assert.deepEqual(coverage.gapKeys, ["convo-3", "convo-4", "convo-5"]);

  const gaps = harness.protocolMessages.filter(
    (m): m is Extract<EmittedMessage, { type: "DETAIL_GAP" }> => m.type === "DETAIL_GAP"
  );
  assert.deepEqual(
    gaps.map((g) => g.record_key),
    ["convo-3", "convo-4", "convo-5"],
    "every deferred conversation gets a resumable DETAIL_GAP"
  );
  assert.equal(
    gaps.every((g) => g.reason === "upstream_pressure" && g.retryable === true && g.status === "pending"),
    true,
    "density-deferred gaps reuse the upstream_pressure, retryable, pending contract"
  );

  const densityProgress = harness.protocolMessages.filter(
    (m): m is Extract<EmittedMessage, { type: "PROGRESS" }> =>
      m.type === "PROGRESS" &&
      m.stream === "messages" &&
      m.message.includes("opened upstream-pressure circuit after") &&
      m.message.includes("served 429s")
  );
  assert.equal(
    densityProgress.length,
    1,
    "the density trip names upstream pressure and the served-429 count exactly once"
  );
  assert.equal(
    densityProgress.some((m) => m.message.includes("convo-") || m.message.includes("/conversation/")),
    false,
    "the density-trip progress message must not leak conversation ids or API paths"
  );
});

test("runMessagesAndConversationsWithDetail: served 429s below the density threshold do not defer (no over-trigger)", async () => {
  // Same slow-bleed shape but only one served 429 below a threshold of 5: the
  // run must hydrate every conversation, proving the stop is not hair-trigger.
  const harness = makeRecordingEmit(validateRecord);
  const fetchedIds: string[] = [];
  let firstFetch = true;
  const api: ChatGptApi = {
    auth: (): Promise<never> => Promise.reject(new Error("fakeApi.auth() unused in this test")),
    fetch: async (path: string): Promise<ChatGptFetchResult> => {
      fetchedIds.push(path);
      if (firstFetch) {
        firstFetch = false;
        await currentAdaptiveLaneRunContext()?.reportPressure({
          absorbedByRequestWait: true,
          delayMs: 30_000,
          kind: "rate_limited",
          retryAfterMs: 30_000,
        });
      }
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

  const coverage = await runMessagesAndConversationsWithDetail(
    deps,
    [makeConvo({ id: "convo-1" }), makeConvo({ id: "convo-2" }), makeConvo({ id: "convo-3" })],
    makeEmitConversation(deps),
    { random: () => 0, sleep: () => undefined, densityStopThreshold: 5 }
  );

  assert.deepEqual(fetchedIds, ["/conversation/convo-1", "/conversation/convo-2", "/conversation/convo-3"]);
  assert.deepEqual(coverage.hydratedKeys, ["convo-1", "convo-2", "convo-3"]);
  assert.deepEqual(coverage.gapKeys, []);
  assert.equal(
    harness.protocolMessages.some((m) => m.type === "DETAIL_GAP"),
    false,
    "no gap should be emitted while served 429s stay below the density threshold"
  );
});

test("runMessagesAndConversationsWithDetail: pre-detail 429s seed the density stop and defer the tail sooner", async () => {
  // The run already absorbed two served 429s outside the detail lane (list
  // pagination on a hot account). With a threshold of 3, ONE in-lane served 429
  // now trips the stop — the seeded pre-detail pressure carries forward instead
  // of resetting to zero, so the lane defers the tail an account-pressure cycle
  // earlier than it would on a fresh budget.
  const harness = makeRecordingEmit(validateRecord);
  const fetchedIds: string[] = [];
  const api: ChatGptApi = {
    auth: (): Promise<never> => Promise.reject(new Error("fakeApi.auth() unused in this test")),
    fetch: async (path: string): Promise<ChatGptFetchResult> => {
      fetchedIds.push(path);
      await currentAdaptiveLaneRunContext()?.reportPressure({
        absorbedByRequestWait: true,
        delayMs: 30_000,
        kind: "rate_limited",
        retryAfterMs: 30_000,
      });
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

  const coverage = await runMessagesAndConversationsWithDetail(
    deps,
    [
      makeConvo({ id: "convo-1" }),
      makeConvo({ id: "convo-2" }),
      makeConvo({ id: "convo-3" }),
      makeConvo({ id: "convo-4" }),
    ],
    makeEmitConversation(deps),
    { random: () => 0, sleep: () => undefined, densityStopThreshold: 3, preDetailRateLimited: 2 }
  );

  // Only convo-1 fetches (its served 429 brings the seeded 2 to 3 = threshold);
  // convo-2..4 see the tracker tripped and defer without a fetch. Without the
  // seed this same shape would have hydrated three before tripping.
  assert.deepEqual(
    fetchedIds,
    ["/conversation/convo-1"],
    "the pre-detail seed makes a single in-lane 429 trip the stop"
  );
  assert.deepEqual(coverage.hydratedKeys, ["convo-1"]);
  assert.deepEqual(coverage.gapKeys, ["convo-2", "convo-3", "convo-4"]);

  const gaps = harness.protocolMessages.filter(
    (m): m is Extract<EmittedMessage, { type: "DETAIL_GAP" }> => m.type === "DETAIL_GAP"
  );
  assert.equal(
    gaps.every((g) => g.reason === "upstream_pressure" && g.retryable === true && g.status === "pending"),
    true,
    "seeded-defer gaps reuse the same resumable upstream_pressure contract"
  );

  // The trip message reports the FULL count (seed + in-lane), so the operator
  // sees the run-level pressure, not just the detail-phase slice.
  const densityProgress = harness.protocolMessages.filter(
    (m): m is Extract<EmittedMessage, { type: "PROGRESS" }> =>
      m.type === "PROGRESS" && m.stream === "messages" && m.message.includes("opened upstream-pressure circuit after")
  );
  assert.equal(densityProgress.length, 1);
  assert.equal(
    densityProgress[0]?.message.includes("after 3 served 429s"),
    true,
    "the trip names the cumulative seed+in-lane count"
  );
});

test("runMessagesAndConversationsWithDetail: a zero pre-detail seed preserves the unseeded behavior", async () => {
  // Regression guard: preDetailRateLimited:0 must behave EXACTLY like no seed —
  // the seed is purely additive and the default (no pre-detail pressure) is the
  // frozen, byte-for-byte path.
  const harness = makeRecordingEmit(validateRecord);
  const fetchedIds: string[] = [];
  const api: ChatGptApi = {
    auth: (): Promise<never> => Promise.reject(new Error("fakeApi.auth() unused in this test")),
    fetch: async (path: string): Promise<ChatGptFetchResult> => {
      fetchedIds.push(path);
      await currentAdaptiveLaneRunContext()?.reportPressure({
        absorbedByRequestWait: true,
        delayMs: 30_000,
        kind: "rate_limited",
        retryAfterMs: 30_000,
      });
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

  const coverage = await runMessagesAndConversationsWithDetail(
    deps,
    [makeConvo({ id: "convo-1" }), makeConvo({ id: "convo-2" }), makeConvo({ id: "convo-3" })],
    makeEmitConversation(deps),
    { random: () => 0, sleep: () => undefined, densityStopThreshold: 3, preDetailRateLimited: 0 }
  );

  // Threshold 3, no seed: convo-1 and convo-2 each pay a served 429 (count 1, 2),
  // convo-3's launch sees count 2 < 3 so it fetches too and brings count to 3.
  // All three hydrate; the stop only trips for a hypothetical convo-4. Identical
  // to the unseeded "below threshold" path.
  assert.deepEqual(fetchedIds, ["/conversation/convo-1", "/conversation/convo-2", "/conversation/convo-3"]);
  assert.deepEqual(coverage.hydratedKeys, ["convo-1", "convo-2", "convo-3"]);
  assert.deepEqual(coverage.gapKeys, []);
});

// ─── Bounded-run cap (max detail fetches / max wall-clock per run) ─────────

test("resolveChatGptMaxDetailFetchesPerRun: unset/invalid → no cap; positive int caps", () => {
  // Default OFF: an unconfigured or invalid value must NOT cap the run.
  assert.equal(resolveChatGptMaxDetailFetchesPerRun({}), Number.POSITIVE_INFINITY);
  assert.equal(
    resolveChatGptMaxDetailFetchesPerRun({ PDPP_CHATGPT_MAX_DETAIL_FETCHES_PER_RUN: "" }),
    Number.POSITIVE_INFINITY
  );
  assert.equal(
    resolveChatGptMaxDetailFetchesPerRun({ PDPP_CHATGPT_MAX_DETAIL_FETCHES_PER_RUN: "0" }),
    Number.POSITIVE_INFINITY,
    "0 is the documented disable escape hatch"
  );
  assert.equal(
    resolveChatGptMaxDetailFetchesPerRun({ PDPP_CHATGPT_MAX_DETAIL_FETCHES_PER_RUN: "-5" }),
    Number.POSITIVE_INFINITY
  );
  assert.equal(
    resolveChatGptMaxDetailFetchesPerRun({ PDPP_CHATGPT_MAX_DETAIL_FETCHES_PER_RUN: "1.5" }),
    Number.POSITIVE_INFINITY,
    "non-integer falls back to no cap"
  );
  assert.equal(resolveChatGptMaxDetailFetchesPerRun({ PDPP_CHATGPT_MAX_DETAIL_FETCHES_PER_RUN: "250" }), 250);
});

test("resolveChatGptMaxRunWallClockMs: unset/invalid → no cap; positive ms caps", () => {
  assert.equal(resolveChatGptMaxRunWallClockMs({}), Number.POSITIVE_INFINITY);
  assert.equal(
    resolveChatGptMaxRunWallClockMs({ PDPP_CHATGPT_MAX_RUN_WALL_CLOCK_MS: "0" }),
    Number.POSITIVE_INFINITY,
    "0 disables the wall-clock cap"
  );
  assert.equal(resolveChatGptMaxRunWallClockMs({ PDPP_CHATGPT_MAX_RUN_WALL_CLOCK_MS: "-1" }), Number.POSITIVE_INFINITY);
  assert.equal(resolveChatGptMaxRunWallClockMs({ PDPP_CHATGPT_MAX_RUN_WALL_CLOCK_MS: "1800000" }), 1_800_000);
  assert.equal(
    resolveChatGptMaxRunWallClockMs({ PDPP_CHATGPT_MAX_RUN_WALL_CLOCK_MS: "1800000.9" }),
    1_800_000,
    "fractional ms floors"
  );
});

test("ChatGptRunBudget: no caps never stops; fetch cap and wall-clock cap each trip with the right reason", () => {
  // Disabled budget (the production default): never the reason a run stops.
  const open = new ChatGptRunBudget();
  for (let i = 0; i < 100; i += 1) {
    open.recordDetailFetch();
  }
  assert.equal(open.shouldStop(), false, "a budget with no caps never trips");
  assert.equal(open.reason(), null);

  // Fetch cap: trips once the hydrated count reaches the cap.
  const fetchCapped = new ChatGptRunBudget({ maxFetches: 2 });
  assert.equal(fetchCapped.reason(), null, "0 < 2: open");
  fetchCapped.recordDetailFetch();
  assert.equal(fetchCapped.reason(), null, "1 < 2: open");
  fetchCapped.recordDetailFetch();
  assert.equal(fetchCapped.reason(), "max_detail_fetches", "2 >= 2: tripped");

  // Wall-clock cap: clock anchors on the first reason() call, then trips once
  // the injected clock advances past the budget.
  let nowMs = 1000;
  const clockCapped = new ChatGptRunBudget({ maxWallClockMs: 500, now: () => nowMs });
  assert.equal(clockCapped.reason(), null, "elapsed 0 < 500: open and anchored");
  nowMs = 1400;
  assert.equal(clockCapped.reason(), null, "elapsed 400 < 500: open");
  nowMs = 1500;
  assert.equal(clockCapped.reason(), "max_wall_clock", "elapsed 500 >= 500: tripped");
});

test("runMessagesAndConversationsWithDetail: a max-detail-fetches cap defers the tail as resumable run-cap DETAIL_GAP", async () => {
  // A genuinely COLD account (every fetch 200, no 429): the density stop never
  // trips, so without a size cap a large backlog would run unbounded. With a
  // fetch cap of 2, the run hydrates exactly two and defers the rest cleanly.
  const harness = makeRecordingEmit(validateRecord);
  const fetchedIds: string[] = [];
  const api: ChatGptApi = {
    auth: (): Promise<never> => Promise.reject(new Error("fakeApi.auth() unused in this test")),
    fetch: async (path: string): Promise<ChatGptFetchResult> => {
      fetchedIds.push(path);
      await Promise.resolve();
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

  const coverage = await runMessagesAndConversationsWithDetail(
    deps,
    [
      makeConvo({ id: "convo-1" }),
      makeConvo({ id: "convo-2" }),
      makeConvo({ id: "convo-3" }),
      makeConvo({ id: "convo-4" }),
      makeConvo({ id: "convo-5" }),
    ],
    makeEmitConversation(deps),
    { random: () => 0, sleep: () => undefined, runBudget: new ChatGptRunBudget({ maxFetches: 2 }) }
  );

  // Exactly two fetches launch; convo-3's launch sees the cap and defers it plus
  // the rest with NO further fetch — proving a large backlog cannot become an
  // unbounded run.
  assert.deepEqual(
    fetchedIds,
    ["/conversation/convo-1", "/conversation/convo-2"],
    "no detail fetch is launched once the fetch cap is reached"
  );
  assert.deepEqual(coverage.hydratedKeys, ["convo-1", "convo-2"]);
  assert.deepEqual(coverage.gapKeys, ["convo-3", "convo-4", "convo-5"]);

  // The deferred conversations are resumable gaps, NOT a source-pressure defer:
  // reason retry_exhausted (no cooldown armed), class run_cap_deferred.
  const gaps = harness.protocolMessages.filter(
    (m): m is Extract<EmittedMessage, { type: "DETAIL_GAP" }> => m.type === "DETAIL_GAP"
  );
  assert.deepEqual(
    gaps.map((g) => g.record_key),
    ["convo-3", "convo-4", "convo-5"],
    "every conversation past the cap gets a resumable DETAIL_GAP"
  );
  assert.equal(
    gaps.every((g) => g.reason === "retry_exhausted" && g.retryable === true && g.status === "pending"),
    true,
    "run-cap gaps are resumable retry_exhausted (NOT upstream_pressure / rate_limited — no source-pressure cooldown is armed)"
  );
  assert.equal(
    gaps.every((g) => g.detail?.class === "run_cap_deferred"),
    true,
    "the run-cap error class distinguishes a self-imposed bound from a busy-service defer"
  );
  assert.equal(
    gaps.some((g) => g.reason === "upstream_pressure" || g.reason === "rate_limited"),
    false,
    "a size cap must never be classified as source pressure / a source failure"
  );

  // Already-collected records remain valid: the two hydrated conversations
  // produced records that passed the production zod shape-check (the recording
  // harness routes failures to .skipped).
  assert.equal(harness.skipped.length, 0, "no hydrated record was dropped by the shape-check");
  const conversationRecords = harness.emitted.filter((r) => r.stream === "conversations");
  assert.equal(
    conversationRecords.length >= 2,
    true,
    "the conversations hydrated before the cap are emitted as valid records"
  );

  // The trip is reported once, in operator voice, without leaking ids or paths.
  const capProgress = harness.protocolMessages.filter(
    (m): m is Extract<EmittedMessage, { type: "PROGRESS" }> =>
      m.type === "PROGRESS" && m.stream === "messages" && m.message.includes("reached its per-run")
  );
  assert.equal(capProgress.length, 1, "the cap trip is announced exactly once");
  assert.equal(capProgress[0]?.message.includes("detail-count cap"), true, "the message names the fetch-count cap");
  assert.equal(
    capProgress.some((m) => m.message.includes("convo-") || m.message.includes("/conversation/")),
    false,
    "the cap-trip progress message must not leak conversation ids or API paths"
  );
});

test("runMessagesAndConversationsWithDetail: a wall-clock cap defers the tail via an injected clock", async () => {
  // Each conversation 'takes' 400ms of wall-clock (advanced by the fake clock
  // inside the fetch). With a 500ms budget the run hydrates the conversations it
  // can finish inside the budget, then defers the remainder as resumable gaps —
  // bounding a slow-but-cold run by TIME, not size.
  const harness = makeRecordingEmit(validateRecord);
  const fetchedIds: string[] = [];
  let nowMs = 10_000;
  const api: ChatGptApi = {
    auth: (): Promise<never> => Promise.reject(new Error("fakeApi.auth() unused in this test")),
    fetch: async (path: string): Promise<ChatGptFetchResult> => {
      fetchedIds.push(path);
      await Promise.resolve();
      // Model time spent serving + processing this conversation.
      nowMs += 400;
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

  const coverage = await runMessagesAndConversationsWithDetail(
    deps,
    [
      makeConvo({ id: "convo-1" }),
      makeConvo({ id: "convo-2" }),
      makeConvo({ id: "convo-3" }),
      makeConvo({ id: "convo-4" }),
    ],
    makeEmitConversation(deps),
    {
      random: () => 0,
      sleep: () => undefined,
      runBudget: new ChatGptRunBudget({ maxWallClockMs: 500, now: () => nowMs }),
    }
  );

  // convo-1 launches at elapsed 0 (anchor), hydrates (+400 → elapsed 400).
  // convo-2 launches at elapsed 400 < 500, hydrates (+400 → elapsed 800).
  // convo-3's launch sees elapsed 800 >= 500 → defer convo-3..4, no fetch.
  assert.deepEqual(
    fetchedIds,
    ["/conversation/convo-1", "/conversation/convo-2"],
    "fetches stop once the wall-clock budget is spent"
  );
  assert.deepEqual(coverage.hydratedKeys, ["convo-1", "convo-2"]);
  assert.deepEqual(coverage.gapKeys, ["convo-3", "convo-4"]);

  const gaps = harness.protocolMessages.filter(
    (m): m is Extract<EmittedMessage, { type: "DETAIL_GAP" }> => m.type === "DETAIL_GAP"
  );
  assert.equal(
    gaps.every((g) => g.reason === "retry_exhausted" && g.detail?.class === "run_cap_deferred"),
    true,
    "wall-clock-deferred gaps reuse the same resumable run-cap contract"
  );
  const capProgress = harness.protocolMessages.filter(
    (m): m is Extract<EmittedMessage, { type: "PROGRESS" }> =>
      m.type === "PROGRESS" && m.stream === "messages" && m.message.includes("wall-clock cap")
  );
  assert.equal(capProgress.length, 1, "the wall-clock trip names the wall-clock cap exactly once");
});

test("runMessagesAndConversationsWithDetail: no cap configured leaves a large backlog unbounded (default-off)", async () => {
  // The cap MUST default OFF: a budget with neither knob set hydrates every
  // conversation and emits zero gaps, proving current behavior is preserved.
  const harness = makeRecordingEmit(validateRecord);
  const fetchedIds: string[] = [];
  const api: ChatGptApi = {
    auth: (): Promise<never> => Promise.reject(new Error("fakeApi.auth() unused in this test")),
    fetch: async (path: string): Promise<ChatGptFetchResult> => {
      fetchedIds.push(path);
      await Promise.resolve();
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

  const convos = Array.from({ length: 8 }, (_, i) => makeConvo({ id: `convo-${i + 1}` }));
  const coverage = await runMessagesAndConversationsWithDetail(deps, convos, makeEmitConversation(deps), {
    random: () => 0,
    sleep: () => undefined,
    runBudget: new ChatGptRunBudget(),
  });

  assert.equal(fetchedIds.length, 8, "every conversation is fetched when no cap is configured");
  assert.equal(coverage.hydratedKeys.length, 8);
  assert.deepEqual(coverage.gapKeys, []);
  assert.equal(
    harness.protocolMessages.some((m) => m.type === "DETAIL_GAP"),
    false,
    "no gap is emitted when the bounded-run cap is disabled"
  );
});

test("runConversationsAndMessagesStreams: one run budget bounds the recovery pass AND the forward pass together", async () => {
  // The cap is per-RUN, not per-pass: a pending gap-recovery item plus new
  // forward conversations share one budget. With a fetch cap of 2 and one
  // recovery item, the recovery pass hydrates it (count 1), then the forward
  // pass hydrates one more (count 2) and defers the rest — the budget is not
  // reset between passes.
  const harness = makeRecordingEmit(validateRecord);
  const fetchedIds: string[] = [];
  const api: ChatGptApi = {
    auth: (): Promise<never> => Promise.reject(new Error("fakeApi.auth() unused in this test")),
    fetch: async (path: string): Promise<ChatGptFetchResult> => {
      await Promise.resolve();
      if (path.startsWith("/conversations?")) {
        // List walk: two new forward conversations, newest first.
        return {
          status: 200,
          json: {
            items: [
              { id: "fwd-1", title: "f1", create_time: 1_700_000_300, update_time: 1_700_000_300, current_node: "a1" },
              { id: "fwd-2", title: "f2", create_time: 1_700_000_200, update_time: 1_700_000_200, current_node: "a1" },
            ],
          } as ChatGptJson,
        };
      }
      fetchedIds.push(path);
      return makeDetailOk();
    },
  };
  const deps: StreamDeps = {
    api,
    detailGaps: [
      {
        gap_id: "gap-rec-1",
        stream: "messages",
        record_key: "rec-1",
        status: "pending" as const,
        detail_locator: {
          kind: "chatgpt.conversation",
          conversation_id: "rec-1",
          list_item: { id: "rec-1", title: "r1", create_time: 1_700_000_000, update_time: 1_700_000_000 },
        },
      },
    ] as NonNullable<StreamDeps["detailGaps"]>,
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    progress: (): Promise<void> => Promise.resolve(),
    requested: new Map(["conversations", "messages"].map((name) => [name, { name }])),
    // One shared budget for the whole run.
    runBudget: new ChatGptRunBudget({ maxFetches: 2 }),
  };

  await runConversationsAndMessagesStreams(
    deps,
    { conversations: { last_update_time: null }, messages: { last_update_time: null } } as CollectContext["state"],
    {
      detailPacing: { random: () => 0, sleep: () => undefined },
    }
  );

  // recovery hydrates rec-1 (count 1); forward hydrates one of fwd-1/fwd-2
  // (count 2) then the cap defers the remainder. Exactly two detail fetches.
  assert.equal(fetchedIds.length, 2, "the shared budget caps recovery + forward fetches together at 2");
  assert.equal(
    fetchedIds.includes("/conversation/rec-1"),
    true,
    "the recovery pass spends budget before the forward pass"
  );

  const gaps = harness.protocolMessages.filter(
    (m): m is Extract<EmittedMessage, { type: "DETAIL_GAP" }> => m.type === "DETAIL_GAP"
  );
  assert.equal(gaps.length >= 1, true, "the conversation past the shared budget is deferred as a resumable gap");
  assert.equal(
    gaps.every((g) => g.reason === "retry_exhausted" && g.detail?.class === "run_cap_deferred"),
    true,
    "the forward-pass overflow defers under the same run-cap contract"
  );
});

test("runConversationsAndMessagesStreams: capped forward run covers full listed tail before messages STATE", async () => {
  const harness = makeRecordingEmit(validateRecord);
  const listItems = Array.from({ length: 8 }, (_, index) =>
    makeConvo({
      id: `convo-${index + 1}`,
      title: `Conversation ${index + 1}`,
      update_time: 1_700_000_800 - index,
    })
  );
  const fetchedIds: string[] = [];
  const api: ChatGptApi = {
    auth: (): Promise<never> => Promise.reject(new Error("fakeApi.auth() unused in this test")),
    fetch: async (path: string): Promise<ChatGptFetchResult> => {
      await Promise.resolve();
      if (path.startsWith("/conversations?")) {
        return {
          status: 200,
          json: { items: listItems, has_missing_conversations: false, total: listItems.length } as ChatGptJson,
        };
      }
      fetchedIds.push(path);
      return makeDetailOk();
    },
  };
  const deps: StreamDeps = {
    api,
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    progress: (): Promise<void> => Promise.resolve(),
    requested: new Map(["conversations", "messages"].map((name) => [name, { name }])),
    runBudget: new ChatGptRunBudget({ maxFetches: 2 }),
  };

  await runConversationsAndMessagesStreams(
    deps,
    { conversations: { last_update_time: null }, messages: { last_update_time: null } } as CollectContext["state"],
    { detailPacing: { random: () => 0, sleep: () => undefined } }
  );

  assert.deepEqual(fetchedIds, ["/conversation/convo-1", "/conversation/convo-2"]);
  const coverage = harness.protocolMessages.find(
    (m): m is Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> => m.type === "DETAIL_COVERAGE"
  );
  assert.deepEqual(
    coverage?.required_keys,
    listItems.map((item) => item.id)
  );
  assert.deepEqual(coverage?.hydrated_keys, ["convo-1", "convo-2"]);
  assert.deepEqual(coverage?.gap_keys, ["convo-3", "convo-4", "convo-5", "convo-6", "convo-7", "convo-8"]);

  const coverageIdx = harness.events.findIndex((e) => e.kind === "message" && e.message.type === "DETAIL_COVERAGE");
  const stateIdx = harness.events.findIndex(
    (e) => e.kind === "message" && e.message.type === "STATE" && e.message.stream === "messages"
  );
  assert.ok(coverageIdx !== -1, "detail coverage must emit before state");
  assert.ok(stateIdx > coverageIdx, "messages STATE must only emit after full detail coverage");
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
        status: 429,
        retry_after_ms: 120_000,
        safe_headers: { "retry-after-ms": 120_000 },
      },
    },
  });
  const serializedGap = JSON.stringify(gap);
  assert.equal(serializedGap.includes("/conversation/convo-gap"), false, "gap must not expose raw API paths");
  assert.equal(gap.detail?.network_pressure?.attempt, undefined, "gap must not persist attempt counters");
  assert.equal(gap.detail?.network_pressure?.max_attempts, undefined, "gap must not persist max-attempt counters");
  assert.equal(gap.last_error?.network_pressure?.attempt, undefined, "last_error must not persist attempt counters");
  assert.equal(
    gap.last_error?.network_pressure?.max_attempts,
    undefined,
    "last_error must not persist max-attempt counters"
  );
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
  assert.equal(gap.detail?.network_pressure?.attempt, undefined, "gap must not persist attempt counters");
  assert.equal(gap.detail?.network_pressure?.max_attempts, undefined, "gap must not persist max-attempt counters");
  assert.equal(gap.last_error?.network_pressure?.attempt, undefined, "last_error must not persist attempt counters");
  assert.equal(
    gap.last_error?.network_pressure?.max_attempts,
    undefined,
    "last_error must not persist max-attempt counters"
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

// ─── Invariant 7: fingerprint no-op suppression (version-churn fix) ──────
// `custom_instructions` and `shared_conversations` re-derive the full record
// every run from a source that does not change between most runs. Before the
// fingerprint gate, every run re-emitted byte-identical records and the
// dashboard's version-churn surface showed them as high/watch streams whose
// history was 100% no-op re-emit. These tests pin the gate: a record only
// re-emits when its body actually moves, and a true no-op refresh emits zero
// records while STILL advancing STATE so the cursor never stalls.

/** Pull the STATE cursor a stream runner wrote, so a second run can be seeded
 *  with the same prior state the runtime would persist between runs. */
function lastStateCursor(messages: readonly EmittedMessage[], stream: string): Record<string, unknown> {
  const states = messages.filter(
    (m): m is Extract<EmittedMessage, { type: "STATE" }> => m.type === "STATE" && m.stream === stream
  );
  const cursor = states.at(-1)?.cursor;
  return (cursor as Record<string, unknown> | undefined) ?? {};
}

test("runCustomInstructionsStream: unchanged body on a second run emits zero records but still writes STATE", async () => {
  const body = { about_user_message: "I'm a tester", about_model_message: "Be concise", enabled: true };

  const first = makeHarness({ fetchQueue: [{ status: 200, json: body }], requested: ["custom_instructions"] });
  await runCustomInstructionsStream(first.deps, {});
  assert.equal(
    first.emitted.filter((r) => r.stream === "custom_instructions").length,
    1,
    "cold state → the record emits once"
  );
  const priorCursor = lastStateCursor(first.messages, "custom_instructions");
  assert.ok(
    priorCursor.fingerprints && typeof priorCursor.fingerprints === "object",
    "STATE carries a fingerprints map so the next run can detect a no-op"
  );

  const second = makeHarness({ fetchQueue: [{ status: 200, json: body }], requested: ["custom_instructions"] });
  await runCustomInstructionsStream(second.deps, { custom_instructions: priorCursor });
  assert.equal(
    second.emitted.filter((r) => r.stream === "custom_instructions").length,
    0,
    "byte-identical refresh → no re-emit (no version churn)"
  );
  assert.equal(
    second.messages.filter((m) => m.type === "STATE" && m.stream === "custom_instructions").length,
    1,
    "STATE still fires on a no-op run so the cursor advances"
  );
});

test("runCustomInstructionsStream: a real edit on the second run re-emits the record", async () => {
  const v1 = { about_user_message: "I'm a tester", enabled: true };
  const v2 = { about_user_message: "I'm a tester now with a different bio", enabled: true };

  const first = makeHarness({ fetchQueue: [{ status: 200, json: v1 }], requested: ["custom_instructions"] });
  await runCustomInstructionsStream(first.deps, {});
  const priorCursor = lastStateCursor(first.messages, "custom_instructions");

  const second = makeHarness({ fetchQueue: [{ status: 200, json: v2 }], requested: ["custom_instructions"] });
  await runCustomInstructionsStream(second.deps, { custom_instructions: priorCursor });
  const shares = second.emitted.filter((r) => r.stream === "custom_instructions");
  assert.equal(shares.length, 1, "an edited body is a fingerprint boundary → it re-emits");
  assert.equal(shares[0]?.data.about_user, "I'm a tester now with a different bio");
});

test("runSharedConversationsStream: unchanged shares on a second run emit zero records but still write STATE", async () => {
  const items = Array.from({ length: 3 }, (_, idx) => ({
    share_id: `s-${idx}`,
    conversation_id: `c-${idx}`,
    title: `Share ${idx}`,
    create_time: 1_700_000_000 + idx,
  }));

  const first = makeHarness({ fetchQueue: [{ status: 200, json: { items } }], requested: ["shared_conversations"] });
  await runSharedConversationsStream(first.deps, {});
  assert.equal(
    first.emitted.filter((r) => r.stream === "shared_conversations").length,
    3,
    "cold state → all shares emit once"
  );
  const priorCursor = lastStateCursor(first.messages, "shared_conversations");

  const second = makeHarness({ fetchQueue: [{ status: 200, json: { items } }], requested: ["shared_conversations"] });
  await runSharedConversationsStream(second.deps, { shared_conversations: priorCursor });
  assert.equal(
    second.emitted.filter((r) => r.stream === "shared_conversations").length,
    0,
    "byte-identical re-list → no re-emit (no version churn)"
  );
  assert.equal(
    second.messages.filter((m) => m.type === "STATE" && m.stream === "shared_conversations").length,
    1,
    "STATE still fires on a no-op run so the cursor advances"
  );
});

test("runSharedConversationsStream: a newly-shared conversation on the second run emits only that one", async () => {
  const run1Items = [
    { share_id: "s-0", conversation_id: "c-0", title: "Share 0", create_time: 1_700_000_000 },
    { share_id: "s-1", conversation_id: "c-1", title: "Share 1", create_time: 1_700_000_001 },
  ];
  const run2Items = [
    ...run1Items,
    { share_id: "s-2", conversation_id: "c-2", title: "Brand new share", create_time: 1_700_000_002 },
  ];

  const first = makeHarness({
    fetchQueue: [{ status: 200, json: { items: run1Items } }],
    requested: ["shared_conversations"],
  });
  await runSharedConversationsStream(first.deps, {});
  const priorCursor = lastStateCursor(first.messages, "shared_conversations");

  const second = makeHarness({
    fetchQueue: [{ status: 200, json: { items: run2Items } }],
    requested: ["shared_conversations"],
  });
  await runSharedConversationsStream(second.deps, { shared_conversations: priorCursor });
  const shares = second.emitted.filter((r) => r.stream === "shared_conversations");
  assert.equal(shares.length, 1, "only the new share is a fingerprint boundary → only it re-emits");
  assert.equal(shares[0]?.data.id, "s-2");
});

test("runSharedConversationsStream: a deleted share is pruned so it does not block a future re-share", async () => {
  // Full-scan prune: once a share disappears from the source, dropping it from
  // the carry-forward map means if the same id is shared again later it is
  // (correctly) treated as new and re-emits, rather than being gated forever
  // against a fingerprint the source no longer returns.
  const run1Items = [
    { share_id: "s-0", conversation_id: "c-0", title: "Share 0", create_time: 1_700_000_000 },
    { share_id: "s-1", conversation_id: "c-1", title: "Share 1", create_time: 1_700_000_001 },
  ];
  const first = makeHarness({
    fetchQueue: [{ status: 200, json: { items: run1Items } }],
    requested: ["shared_conversations"],
  });
  await runSharedConversationsStream(first.deps, {});
  const cursor1 = lastStateCursor(first.messages, "shared_conversations");

  // Run 2: s-1 is gone from the source. Prune drops it from the map.
  const second = makeHarness({
    fetchQueue: [{ status: 200, json: { items: [run1Items[0]] } }],
    requested: ["shared_conversations"],
  });
  await runSharedConversationsStream(second.deps, { shared_conversations: cursor1 });
  const cursor2 = lastStateCursor(second.messages, "shared_conversations");
  const fingerprints2 = cursor2.fingerprints as Record<string, unknown>;
  assert.ok(!("s-1" in fingerprints2), "the vanished share is pruned from the carry-forward map");

  // Run 3: s-1 is re-shared. Because it was pruned, it is treated as new.
  const reshared = { share_id: "s-1", conversation_id: "c-1", title: "Share 1", create_time: 1_700_000_001 };
  const third = makeHarness({
    fetchQueue: [{ status: 200, json: { items: [run1Items[0], reshared] } }],
    requested: ["shared_conversations"],
  });
  await runSharedConversationsStream(third.deps, { shared_conversations: cursor2 });
  const shares = third.emitted.filter((r) => r.stream === "shared_conversations");
  assert.equal(shares.length, 1, "the re-shared conversation re-emits after having been pruned");
  assert.equal(shares[0]?.data.id, "s-1");
});

// ─── Cold-state preflight source-pressure classifier ─────────────────────
// The preflight is an owner-only A/B safety rail: it only fires when the owner
// has raised detail concurrency above the frozen serial default (a probe env
// var), and it can only ever make a run MORE conservative. These tests pin:
//   - production (serial tuning) fires NO probe and is byte-for-byte unchanged,
//   - a cold account that also passes a burst canary lets the requested faster posture through,
//   - a pressured account forces the run back to serial concurrency=1,
//   - burst-sensitive pressure forces the run back to serial even after serial probes pass,
//   - the classifier stops at the first 429 (no extra load on a hot bucket),
//   - the preflight emits no records and no sensitive strings.

const FAST_TUNING: ChatGptDetailLaneTuning = {
  initialConcurrency: 3,
  maxConcurrency: 3,
  pauseMinMs: 200,
  pauseMaxMs: 200,
};
const SERIAL_TUNING: ChatGptDetailLaneTuning = {
  initialConcurrency: 1,
  maxConcurrency: 1,
  pauseMinMs: 1500,
  pauseMaxMs: 3000,
};

function makeStatusApi(statuses: readonly number[]): { api: ChatGptApi; paths: string[] } {
  const paths: string[] = [];
  let cursor = 0;
  const api: ChatGptApi = {
    auth: (): Promise<never> => Promise.reject(new Error("fakeApi.auth() unused in this test")),
    fetch: (): Promise<never> => Promise.reject(new Error("api.fetch() should not run for status-only preflight")),
    fetchStatus: (path: string): Promise<Pick<ChatGptFetchResult, "headers" | "status">> => {
      paths.push(path);
      const status = statuses[cursor] ?? 200;
      cursor += 1;
      return Promise.resolve({ status });
    },
  };
  return { api, paths };
}

test("classifyChatGptSourcePressure: all-200 sweep classifies cold", async () => {
  const { api, paths } = makeStatusApi([200, 200, 200]);
  const result = await classifyChatGptSourcePressure({ api }, ["a", "b", "c"], 3);
  assert.deepEqual(result, { attempted: 3, classification: "cold", rateLimited: 0 });
  assert.deepEqual(paths, ["/conversation/a", "/conversation/b", "/conversation/c"]);
});

test("classifyChatGptSourcePressure: first 429 classifies pressured and stops probing", async () => {
  const { api, paths } = makeStatusApi([200, 429, 200]);
  const result = await classifyChatGptSourcePressure({ api }, ["a", "b", "c"], 3);
  assert.deepEqual(result, { attempted: 2, classification: "pressured", rateLimited: 1 });
  // Stopped at the 429 — never probed "c", so no extra load on a hot bucket.
  assert.deepEqual(paths, ["/conversation/a", "/conversation/b"]);
});

test("classifyChatGptSourcePressure: a retry-exhausted bare-429 circuit is pressured", async () => {
  const api: ChatGptApi = {
    auth: (): Promise<never> => Promise.reject(new Error("unused")),
    fetch: (): Promise<never> => Promise.reject(new Error("api.fetch() should not run for status-only preflight")),
    fetchStatus: (): Promise<Pick<ChatGptFetchResult, "headers" | "status">> =>
      Promise.reject(
        new ChatGptRecoverableRetryExhaustedError("apiFetch got 429 after retry budget exhausted", {
          class: "rate_limited",
          httpStatus: 429,
        })
      ),
  };
  const result = await classifyChatGptSourcePressure({ api }, ["a", "b", "c"], 3);
  assert.equal(result.classification, "pressured");
  assert.equal(result.rateLimited, 1);
  assert.equal(result.attempted, 1);
});

test("applyChatGptColdStatePreflight: serial production tuning fires NO probe (byte-for-byte unchanged)", async () => {
  const { api, paths } = makeStatusApi([429, 429, 429]);
  const harness = makeRecordingEmit(validateRecord);
  const deps: StreamDeps = {
    api,
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    progress: (): Promise<void> => Promise.resolve(),
    requested: new Map(["messages"].map((name) => [name, { name }])),
  };
  const effective = await applyChatGptColdStatePreflight(deps, [makeConvo({ id: "convo-1" })], SERIAL_TUNING);
  assert.deepEqual(effective, SERIAL_TUNING, "serial tuning returned unchanged");
  assert.deepEqual(paths, [], "no preflight probe was fired in production posture");
  assert.deepEqual(
    harness.protocolMessages.filter((m) => m.type === "PROGRESS"),
    [],
    "no preflight progress emitted in production posture"
  );
});

test("applyChatGptColdStatePreflight: cold account lets the requested faster posture through", async () => {
  const { api, paths } = makeStatusApi([200, 200, 200, 200, 200, 200]);
  const harness = makeRecordingEmit(validateRecord);
  const deps: StreamDeps = {
    api,
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    progress: (): Promise<void> => Promise.resolve(),
    requested: new Map(["messages"].map((name) => [name, { name }])),
  };
  const convos = [
    makeConvo({ id: "c-1" }),
    makeConvo({ id: "c-2" }),
    makeConvo({ id: "c-3" }),
    makeConvo({ id: "c-4" }),
  ];
  const effective = await applyChatGptColdStatePreflight(deps, convos, FAST_TUNING);
  assert.deepEqual(effective, FAST_TUNING, "cold preflight keeps the requested faster tuning");
  assert.deepEqual(
    paths,
    [
      "/conversation/c-1",
      "/conversation/c-2",
      "/conversation/c-3",
      "/conversation/c-1",
      "/conversation/c-2",
      "/conversation/c-3",
    ],
    "probed first 3 serially, then replayed them as a burst canary"
  );
});

test("applyChatGptColdStatePreflight: burst-sensitive pressure forces serial despite clean serial probes", async () => {
  const { api, paths } = makeStatusApi([200, 200, 200, 200, 429, 200]);
  const harness = makeRecordingEmit(validateRecord);
  const deps: StreamDeps = {
    api,
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    progress: (): Promise<void> => Promise.resolve(),
    requested: new Map(["messages"].map((name) => [name, { name }])),
  };
  const convos = [
    makeConvo({ id: "c-1" }),
    makeConvo({ id: "c-2" }),
    makeConvo({ id: "c-3" }),
    makeConvo({ id: "c-4" }),
  ];
  const effective = await applyChatGptColdStatePreflight(deps, convos, FAST_TUNING);
  assert.equal(effective.maxConcurrency, 1, "burst pressure forces serial maxConcurrency");
  assert.equal(effective.initialConcurrency, 1);
  assert.deepEqual(
    paths,
    [
      "/conversation/c-1",
      "/conversation/c-2",
      "/conversation/c-3",
      "/conversation/c-1",
      "/conversation/c-2",
      "/conversation/c-3",
    ],
    "serial probes passed before the burst canary detected pressure"
  );
});

test("applyChatGptColdStatePreflight: pressured account forces the run back to serial concurrency=1", async () => {
  const { api } = makeStatusApi([429]);
  const harness = makeRecordingEmit(validateRecord);
  const deps: StreamDeps = {
    api,
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    progress: (): Promise<void> => Promise.resolve(),
    requested: new Map(["messages"].map((name) => [name, { name }])),
  };
  const effective = await applyChatGptColdStatePreflight(deps, [makeConvo({ id: "c-1" })], FAST_TUNING);
  assert.equal(effective.maxConcurrency, 1, "pressured preflight forces serial maxConcurrency");
  assert.equal(effective.initialConcurrency, 1);
  const progress = harness.protocolMessages.filter(
    (m): m is Extract<EmittedMessage, { type: "PROGRESS" }> => m.type === "PROGRESS"
  );
  assert.ok(
    progress.some((m) => m.message.includes("source is pressured") && m.message.includes("serial concurrency=1")),
    "emitted a pressured/serial preflight note"
  );
});

test("runMessagesAndConversationsWithDetail: hot account at probe-concurrency falls back to serial (no overlap)", async () => {
  const harness = makeRecordingEmit(validateRecord);
  let activeFetches = 0;
  let maxActiveFetches = 0;
  // First call (the preflight probe) 429s → pressured. Subsequent real-lane
  // fetches succeed. The lane must run serially (maxActive===1) despite the
  // requested maxConcurrency=3, because the preflight forced it back to serial.
  const api: ChatGptApi = {
    auth: (): Promise<never> => Promise.reject(new Error("fakeApi.auth() unused in this test")),
    fetchStatus: (): Promise<Pick<ChatGptFetchResult, "headers" | "status">> => Promise.resolve({ status: 429 }),
    fetch: async (): Promise<ChatGptFetchResult> => {
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
    [makeConvo({ id: "c-1" }), makeConvo({ id: "c-2" }), makeConvo({ id: "c-3" })],
    makeEmitConversation(deps),
    {
      random: () => 0,
      sleep: () => undefined,
      tuning: { initialConcurrency: 3, maxConcurrency: 3, pauseMinMs: 200, pauseMaxMs: 200 },
    }
  );

  assert.equal(maxActiveFetches, 1, "pressured preflight forced the detail lane to run serially");
});

test("runMessagesAndConversationsWithDetail: pressure-deferred gaps do not train the lane upward", async () => {
  const harness = makeRecordingEmit(validateRecord);
  const api: ChatGptApi = {
    auth: (): Promise<never> => Promise.reject(new Error("fakeApi.auth() unused in this test")),
    fetchStatus: (): Promise<Pick<ChatGptFetchResult, "headers" | "status">> => Promise.resolve({ status: 200 }),
    fetch: (): Promise<ChatGptFetchResult> =>
      Promise.reject(
        new ChatGptRecoverableRetryExhaustedError("apiFetch got 429 after retry budget exhausted", {
          class: "rate_limited",
          httpStatus: 429,
        })
      ),
  };
  const deps: StreamDeps = {
    api,
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    progress: (): Promise<void> => Promise.resolve(),
    requested: new Map(["conversations", "messages"].map((name) => [name, { name }])),
  };

  const coverage = await runMessagesAndConversationsWithDetail(
    deps,
    [makeConvo({ id: "c-1" }), makeConvo({ id: "c-2" }), makeConvo({ id: "c-3" }), makeConvo({ id: "c-4" })],
    makeEmitConversation(deps),
    {
      random: () => 0,
      sleep: () => undefined,
      tuning: { initialConcurrency: 3, maxConcurrency: 3, pauseMinMs: 200, pauseMaxMs: 200 },
    }
  );

  assert.equal(coverage.hydratedKeys.length, 0);
  assert.equal(coverage.gapKeys.length, 4);
  const progress = harness.protocolMessages.filter(
    (m): m is Extract<EmittedMessage, { type: "PROGRESS" }> => m.type === "PROGRESS"
  );
  assert.ok(
    progress.some((m) => m.message.includes("opened upstream-pressure circuit")),
    "upstream-pressure circuit opened"
  );
  assert.equal(
    progress.filter((m) => m.message.includes("concurrency_increased")).length,
    0,
    "deferred gap bookkeeping must not count as clean success"
  );
});

test("runMessagesAndConversationsWithDetail: serial tuning fires no preflight and behaves exactly as before", async () => {
  const harness = makeRecordingEmit(validateRecord);
  const fetches: string[] = [];
  const api: ChatGptApi = {
    auth: (): Promise<never> => Promise.reject(new Error("fakeApi.auth() unused in this test")),
    fetch: (path: string): Promise<ChatGptFetchResult> => {
      fetches.push(path);
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

  await runMessagesAndConversationsWithDetail(
    deps,
    [makeConvo({ id: "convo-1" }), makeConvo({ id: "convo-2" })],
    makeEmitConversation(deps),
    { random: () => 0, sleep: () => undefined, tuning: SERIAL_TUNING }
  );

  // Exactly two fetches — one per conversation, no preflight probe in front.
  assert.deepEqual(fetches, ["/conversation/convo-1", "/conversation/convo-2"]);
  const preflightNotes = harness.protocolMessages.filter(
    (m) => m.type === "PROGRESS" && (m as { message?: string }).message?.includes("cold-state preflight")
  );
  assert.deepEqual(preflightNotes, [], "no preflight progress in serial posture");
});

// ─── Run-cap tail materialization tests ─────────────────────────────────────

test("runMessagesAndConversationsWithDetail: post-cap emits full tail gaps and stops idle lane launches", async () => {
  // Regression for the 2026-06-05 live hang (run_1780693320152): stopping
  // provider FETCHES is not enough if the paced lane still walks every tail item
  // just to write local gaps. The correct split is: cap network detail fetches,
  // then materialize the remaining listed tail as durable DETAIL_GAP rows
  // immediately and abort queued lane work.
  const harness = makeRecordingEmit(validateRecord);
  const fetchedIds: string[] = [];
  const api: ChatGptApi = {
    auth: (): Promise<never> => Promise.reject(new Error("fakeApi.auth() unused in this test")),
    fetch: async (path: string): Promise<ChatGptFetchResult> => {
      fetchedIds.push(path);
      await Promise.resolve();
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

  // A launch-delay spy standing in for production's 1.5–3s serial launch gate.
  // Each call is one idle wait the lane would pay before a task body runs.
  let launchDelays = 0;
  const sleepSpy = (): void => {
    launchDelays += 1;
  };

  const coverage = await runMessagesAndConversationsWithDetail(
    deps,
    [
      makeConvo({ id: "convo-1" }),
      makeConvo({ id: "convo-2" }),
      makeConvo({ id: "convo-3" }),
      makeConvo({ id: "convo-4" }),
      makeConvo({ id: "convo-5" }),
      makeConvo({ id: "convo-6" }),
      makeConvo({ id: "convo-7" }),
      makeConvo({ id: "convo-8" }),
    ],
    makeEmitConversation(deps),
    {
      random: () => 0,
      sleep: sleepSpy,
      runBudget: new ChatGptRunBudget({ maxFetches: 2 }),
    }
  );

  assert.deepEqual(fetchedIds, ["/conversation/convo-1", "/conversation/convo-2"]);
  assert.deepEqual(coverage.hydratedKeys, ["convo-1", "convo-2"]);
  assert.deepEqual(coverage.gapKeys, ["convo-3", "convo-4", "convo-5", "convo-6", "convo-7", "convo-8"]);
  const gaps = harness.protocolMessages.filter((m) => m.type === "DETAIL_GAP");
  assert.equal(gaps.length, 6, "every unhydrated listed conversation gets a durable run-cap gap");

  assert.ok(
    launchDelays <= 2,
    `lane must not pace-launch the local-only gap tail (saw ${launchDelays} launch delays; pre-fix drains all 8 conversations -> 7)`
  );
});

test("runMessagesAndConversationsWithDetail: no-cap run is byte-for-byte unchanged", async () => {
  // With NO fetch/wall-clock cap, all conversations are hydrated normally.
  const harness = makeRecordingEmit(validateRecord);
  const fetchedIds: string[] = [];
  const api: ChatGptApi = {
    auth: (): Promise<never> => Promise.reject(new Error("fakeApi.auth() unused in this test")),
    fetch: async (path: string): Promise<ChatGptFetchResult> => {
      fetchedIds.push(path);
      await Promise.resolve();
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

  const coverage = await runMessagesAndConversationsWithDetail(
    deps,
    [makeConvo({ id: "convo-1" }), makeConvo({ id: "convo-2" }), makeConvo({ id: "convo-3" })],
    makeEmitConversation(deps),
    {
      random: () => 0,
      sleep: () => undefined,
    }
  );

  assert.deepEqual(
    fetchedIds,
    ["/conversation/convo-1", "/conversation/convo-2", "/conversation/convo-3"],
    "all conversations hydrated when no cap is configured"
  );
  assert.deepEqual(coverage.hydratedKeys, ["convo-1", "convo-2", "convo-3"]);
  assert.deepEqual(coverage.gapKeys, [], "no gaps materialized on an uncapped run");

  const gaps = harness.protocolMessages.filter((m) => m.type === "DETAIL_GAP");
  assert.equal(gaps.length, 0, "no gaps materialized on an uncapped run");
});
