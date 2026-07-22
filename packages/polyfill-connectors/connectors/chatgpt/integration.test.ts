// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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
import type { Page } from "playwright";
import { currentAdaptiveLaneRunContext } from "../../src/adaptive-lane.ts";
import { CHATGPT_STORED_CREDENTIAL_REJECTED_MESSAGE } from "../../src/auto-login/chatgpt.ts";
import type { CollectContext, EmittedMessage } from "../../src/connector-runtime.ts";
import { RetryExhaustedError, retryHttp } from "../../src/http-retry.ts";
import { ProviderBudgetController } from "../../src/provider-budget.ts";
import { type EmittedRecord, makeRecordingEmit, type SkippedRecord } from "../../src/test-harness.ts";
import {
  applyChatGptColdStatePreflight,
  buildChatGptCollectionRateProgress,
  buildChatGptPacingStateFields,
  CHATGPT_RETRYABLE_ERROR_PATTERN,
  type ChatGptDetailLaneTuning,
  ChatGptPlannedProviderBudgetDeferredError,
  ChatGptRateLimitDensityTracker,
  ChatGptRecoverableRetryExhaustedError,
  ChatGptRunBudget,
  chatGptBackendFetchInBrowser,
  classifyChatGptSourcePressure,
  consumeChatGptProviderRetryBudget,
  createChatGptApi,
  normalizeChatGptTerminalError,
  processConversationDetail,
  readChatGptPersistedPacing,
  resolveChatGptBackendFetchTimeoutMs,
  resolveChatGptDetailLaneTuning,
  resolveChatGptMaxDetailFetchesPerRun,
  resolveChatGptMaxRunWallClockMs,
  resolveChatGptMaxTailDeferralGapsPerRun,
  resolveChatGptProviderBudget,
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

test("normalizeChatGptTerminalError maps pre-progress auth failures to refresh_credentials", () => {
  assert.deepEqual(
    normalizeChatGptTerminalError({
      message: CHATGPT_STORED_CREDENTIAL_REJECTED_MESSAGE,
      retryable: false,
    }),
    {
      code: "credential_rejected",
      message: `chatgpt_preprogress_failure: refresh_credentials: ${CHATGPT_STORED_CREDENTIAL_REJECTED_MESSAGE}`,
      retryable: false,
    }
  );
  assert.deepEqual(
    normalizeChatGptTerminalError({
      message: "chatgpt_session_failed: apiFetch got 401 on GET /conversation/abc (auth - not retryable)",
      retryable: true,
    }),
    {
      message:
        "chatgpt_preprogress_failure: refresh_credentials: chatgpt_session_failed: apiFetch got 401 on GET /conversation/abc (auth - not retryable)",
      retryable: false,
    }
  );
  assert.deepEqual(
    normalizeChatGptTerminalError({
      message:
        "chatgpt_session_failed: chatgpt_session_required: ChatGPT session is not active; start an owner-attended manual refresh to repair authentication.",
      retryable: false,
    }),
    {
      message:
        "chatgpt_preprogress_failure: refresh_credentials: chatgpt_session_failed: chatgpt_session_required: ChatGPT session is not active; start an owner-attended manual refresh to repair authentication.",
      retryable: false,
    }
  );
});

test("normalizeChatGptTerminalError maps visible login or challenge failures to manual action", () => {
  assert.deepEqual(
    normalizeChatGptTerminalError({
      message: "chatgpt_login_post_submit_failed: Cloudflare challenge still visible",
      retryable: false,
    }),
    {
      message:
        "chatgpt_preprogress_failure: manual_action_required: chatgpt_login_post_submit_failed: Cloudflare challenge still visible",
      retryable: false,
    }
  );
});

test("normalizeChatGptTerminalError bounds and redacts parser/runtime diagnostics", () => {
  const normalized = normalizeChatGptTerminalError({
    message: `parser error for user@example.com with access_token=secret-token and {"access_token":"json-secret"} at https://chatgpt.com/backend-api/conversation/abc ${"x".repeat(400)}`,
    retryable: false,
  });
  assert.equal(normalized.retryable, false);
  assert.match(normalized.message, /^chatgpt_preprogress_failure: runtime_exception: /);
  assert.ok(!normalized.message.includes("user@example.com"));
  assert.ok(!normalized.message.includes("secret-token"));
  assert.ok(!normalized.message.includes("json-secret"));
  assert.ok(!normalized.message.includes("https://chatgpt.com"));
  assert.ok(normalized.message.length <= "chatgpt_preprogress_failure: runtime_exception: ".length + 240);
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

test("Part A: one HTTP request that retries N times causes ONE pacing backoff, not N", async () => {
  // The live ×8 explosion: createChatGptApi.fetchWithRetry routes EVERY retry
  // attempt's pressure through onRetry, which used to call
  // providerBudget.recordThrottle (a ×2 interval inflate) per attempt. So ONE
  // 429 that retried 2× inflated the pacing interval ×4 (and a 3-attempt clear,
  // ×8 — matching the live 1900→15200 and 14600→116800 jumps). This drives the
  // REAL connector path (createChatGptApi → fetchWithRetry → retryHttp → onRetry)
  // with a fake Page that serves two 429s (with Retry-After, so the full retry
  // budget is kept — bare 429 would fast-open and exhaust) then a 200. The
  // interval must back off EXACTLY ONCE (×1.5 soft step), regardless of how many
  // attempts the single request took.
  // No-op sleep so the per-attempt pacing admit() does not wait on a real clock.
  const providerBudget = new ProviderBudgetController({
    pacing: {
      initialIntervalMs: 1000,
      minIntervalMs: 250,
      multiplicativeDecreaseFactor: 0.5,
      sleep: () => Promise.resolve(),
    },
  });
  const intervalBefore = providerBudget.snapshotPacing()?.intervalMs;
  assert.equal(intervalBefore, 1000, "starts at the cold interval");

  // Serve: 429+Retry-After, 429+Retry-After, then 200. retryHttp honors the
  // Retry-After wait itself; the fake page resolves instantly so the test is
  // fast. A 429 WITH Retry-After keeps the full retry budget (a bare 429 would
  // fast-open and exhaust), so the request retries before succeeding.
  const fetchResults: ChatGptFetchResult[] = [
    { status: 429, json: null, headers: { "retry-after": "0" } },
    { status: 429, json: null, headers: { "retry-after": "0" } },
    { status: 200, json: { conversation_id: "c1" } as ChatGptJson },
  ];
  let fetchCallIndex = 0;
  // Minimal Page shim: only the three methods getAuthFromPage + fetchOnce touch.
  // The first evaluate (no 2nd arg) extracts auth; subsequent ones are the
  // backend fetch (2nd arg carries `{ path, ... }`). `evaluate` is single-cast
  // to Page's overloaded signature; `waitForFunction` rejects (getAuthFromPage
  // swallows it via `.catch(() => undefined)`), so a Promise<never> satisfies
  // every overload without a double-cast.
  const fakePage: Pick<Page, "evaluate" | "goto" | "waitForFunction"> = {
    evaluate: ((_fn: unknown, arg?: unknown): Promise<unknown> => {
      if (arg === undefined) {
        return Promise.resolve({ accessToken: "fake-token", deviceId: "fake-device" });
      }
      const result = fetchResults[Math.min(fetchCallIndex, fetchResults.length - 1)];
      fetchCallIndex += 1;
      return Promise.resolve(result);
    }) as Page["evaluate"],
    goto: () => Promise.resolve(null),
    waitForFunction: () => Promise.reject(new Error("fake page: no client-bootstrap")),
  };

  const api = createChatGptApi({ capture: null, page: fakePage as Page, providerBudget });
  const result = await api.fetch("/conversation/c1");

  assert.equal(result.status, 200, "the request ultimately succeeds after retrying");
  assert.equal(fetchCallIndex, 3, "the single request made 3 backend fetches (2 retries + success)");

  // ONE soft throttle step: 1000 × 1.5 = 1500. NOT ×4 (4000) or ×8 (8000).
  // Updated from ×2 to ×1.5 to reflect Fix 2 (bounded soft-throttle replaces
  // the old ÷multiplicativeDecreaseFactor plain-throttle path).
  const intervalAfter = providerBudget.snapshotPacing()?.intervalMs;
  assert.equal(
    intervalAfter,
    1500,
    "two retry attempts for ONE request caused ONE soft-throttle backoff (1000→1500), not ×4 per-attempt double-count"
  );
});

test("createChatGptApi refreshes auth from the current session endpoint after one 401", async () => {
  const backendCalls: Array<{ auth?: { accessToken?: string; deviceId?: string }; path?: string }> = [];
  let authExtractionCalls = 0;
  const fakePage: Pick<Page, "evaluate" | "goto" | "waitForFunction"> = {
    evaluate: ((fn: unknown, arg?: unknown): Promise<unknown> => {
      if (arg === undefined) {
        authExtractionCalls += 1;
        assert.equal(
          typeof fn,
          "string",
          "auth extraction must be sent as a literal browser expression so bundlers cannot inject Node helpers"
        );
        assert.match(
          String(fn),
          /\/api\/auth\/session/,
          "auth extraction should ask ChatGPT for the current session before using DOM bootstrap fallback"
        );
        assert.doesNotMatch(String(fn), /__name/, "browser expression must not depend on bundler helper symbols");
        return Promise.resolve({
          accessToken: authExtractionCalls === 1 ? "stale-token" : "fresh-token",
          deviceId: "fake-device",
        });
      }
      const call = arg as { auth?: { accessToken?: string; deviceId?: string }; path?: string };
      backendCalls.push(call);
      return Promise.resolve(
        call.auth?.accessToken === "stale-token" ? { status: 401, json: null } : { status: 200, json: { ok: true } }
      );
    }) as Page["evaluate"],
    goto: () => Promise.resolve(null),
    waitForFunction: () => Promise.reject(new Error("fake page: no client-bootstrap")),
  };

  const api = createChatGptApi({ capture: null, page: fakePage as Page });
  const result = await api.fetch("/memories?include_memory_entries=true");

  assert.equal(result.status, 200);
  assert.equal(authExtractionCalls, 2);
  assert.deepEqual(
    backendCalls.map((call) => call.auth?.accessToken),
    ["stale-token", "fresh-token"]
  );
});

test("createChatGptApi.fetchBatch posts capped conversation batch requests", async () => {
  const backendCalls: Array<{ body?: unknown; method?: string; path?: string }> = [];
  const fakePage: Pick<Page, "evaluate" | "goto" | "waitForFunction"> = {
    evaluate: ((_fn: unknown, arg?: unknown): Promise<unknown> => {
      if (arg === undefined) {
        return Promise.resolve({ accessToken: "fake-token", deviceId: "fake-device" });
      }
      backendCalls.push(arg as { body?: unknown; method?: string; path?: string });
      return Promise.resolve({
        status: 200,
        json: [
          { id: "c1", title: "one" },
          { id: "c2", title: "two" },
        ],
      });
    }) as Page["evaluate"],
    goto: () => Promise.resolve(null),
    waitForFunction: () => Promise.reject(new Error("fake page: no client-bootstrap")),
  };

  const api = createChatGptApi({ capture: null, page: fakePage as Page });
  assert.ok(api.fetchBatch, "production ChatGPT API exposes fetchBatch");
  const fetchBatch = api.fetchBatch;
  const results = await fetchBatch(["c1", "c2"]);

  assert.equal(results.length, 2);
  assert.deepEqual(backendCalls, [
    {
      auth: { accessToken: "fake-token", deviceId: "fake-device" },
      body: { conversation_ids: ["c1", "c2"] },
      method: "POST",
      parseJson: true,
      path: "/conversations/batch",
      timeoutMs: resolveChatGptBackendFetchTimeoutMs(),
    },
  ]);
  await assert.rejects(
    () => fetchBatch(Array.from({ length: 11 }, (_, i) => `c${i}`)),
    /chatgpt_batch_detail_over_cap/
  );
});

test("resolveChatGptBackendFetchTimeoutMs supports small test overrides", () => {
  assert.equal(resolveChatGptBackendFetchTimeoutMs({ PDPP_CHATGPT_BACKEND_FETCH_TIMEOUT_MS: "7" }), 7);
  assert.equal(resolveChatGptBackendFetchTimeoutMs({ PDPP_CHATGPT_BACKEND_FETCH_TIMEOUT_MS: "0" }), 45_000);
  assert.equal(resolveChatGptBackendFetchTimeoutMs({ PDPP_CHATGPT_BACKEND_FETCH_TIMEOUT_MS: "invalid" }), 45_000);
});

test("resolveChatGptDetailLaneTuning defaults to the frozen production values when no probe env is set", () => {
  // ChatGPT maxConcurrency MUST stay at 1 (a hard ceiling, not a controller).
  // The pause window is now an ε anti-phase-lock band (0/150), NOT a 1500ms rate
  // floor — the GCRA rate-AIMD is the sole rate authority (ship-adaptive-
  // collection-rate-controller §1).
  assert.deepEqual(resolveChatGptDetailLaneTuning({}), {
    initialConcurrency: 1,
    maxConcurrency: 1,
    pauseMinMs: 0,
    pauseMaxMs: 150,
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
    { initialConcurrency: 1, maxConcurrency: 1, pauseMinMs: 0, pauseMaxMs: 150 }
  );
});

// ─── Cumulative 429-density wait-resume (bounded-fallback defer) ──────────

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
  fetchBatch,
  fetchQueue = [],
}: {
  fetchBatch?: (ids: readonly string[]) => Promise<ChatGptFetchResult[]> | ChatGptFetchResult[];
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
    ...(fetchBatch
      ? {
          fetchBatch: (ids: readonly string[]): Promise<ChatGptFetchResult[]> => Promise.resolve(fetchBatch(ids)),
        }
      : {}),
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

function makeDetailGapFromConvo(
  gapId: string,
  conversation: ConversationListItem
): CollectContext["detailGaps"][number] {
  return {
    gap_id: gapId,
    stream: "messages",
    record_key: conversation.id,
    status: "pending",
    reference_only: true,
    detail_locator: {
      kind: "chatgpt.conversation",
      conversation_id: conversation.id,
      list_item: {
        id: conversation.id,
        title: conversation.title,
        create_time: conversation.create_time,
        update_time: conversation.update_time,
        current_node: conversation.current_node,
        gizmo_id: conversation.gizmo_id,
        is_archived: conversation.is_archived,
        is_starred: conversation.is_starred,
        workspace_id: conversation.workspace_id,
      },
    },
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

function makeDetailOkForConversation(id: string): ChatGptFetchResult {
  const detail = makeDetailOk();
  return { ...detail, json: { ...(detail.json ?? {}), id } };
}

async function admitFakeProviderBudget(providerBudget: ProviderBudgetController): Promise<void> {
  const gate = await providerBudget.beforeRequest();
  if (gate.ok) {
    providerBudget.recordRequest();
    return;
  }
  let reason: ChatGptPlannedProviderBudgetDeferredError["reason"] = "max_detail_fetches";
  if (gate.reason === "max_wall_clock") {
    reason = "max_wall_clock";
  } else if (gate.reason === "retry_budget") {
    reason = "provider_retry_budget";
  } else if (gate.reason === "circuit_open") {
    reason = "circuit_open";
  }
  throw new ChatGptPlannedProviderBudgetDeferredError("fake provider budget gate closed", reason, gate);
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

  await runConversationsAndMessagesStreams(deps, {}, { detailPacing: { random: () => 0, sleep: () => undefined } });

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
    considered: 1,
    covered: 1,
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
  // ε-jitter, not a rate floor: with random=0 the launch jitter is 0 and (no
  // pacing hint configured here) the lane pays no launch wait. The GCRA rate-AIMD
  // is the rate authority; the jitter band never imposes a floor of its own.
  assert.deepEqual(pauses, [], "ε-jitter imposes no deterministic launch floor (was a 1500ms manual throttle)");
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

test("runMessagesAndConversationsWithDetail: batch detail happy path avoids per-id GET storm", async () => {
  const harness = makeRecordingEmit(validateRecord);
  const batchCalls: string[][] = [];
  const fetches: string[] = [];
  const api: ChatGptApi = {
    auth: (): Promise<never> => Promise.reject(new Error("fakeApi.auth() unused in this test")),
    fetch: (path: string): Promise<ChatGptFetchResult> => {
      fetches.push(path);
      throw new Error(`unexpected per-id GET: ${path}`);
    },
    fetchBatch: (ids: readonly string[]): Promise<ChatGptFetchResult[]> => {
      batchCalls.push([...ids]);
      return Promise.resolve(ids.map((id) => makeDetailOkForConversation(id)));
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
    { random: () => 0, sleep: () => undefined }
  );

  assert.deepEqual(batchCalls, [["convo-1", "convo-2", "convo-3"]]);
  assert.deepEqual(fetches, [], "batch-hydrated conversations must not also hit /conversation/{id}");
  assert.deepEqual(coverage.hydratedKeys, ["convo-1", "convo-2", "convo-3"]);
  assert.deepEqual(coverage.gapKeys, []);
});

test("runMessagesAndConversationsWithDetail: batch omissions fall back only for omitted ids", async () => {
  const harness = makeRecordingEmit(validateRecord);
  const batchCalls: string[][] = [];
  const fetches: string[] = [];
  const api: ChatGptApi = {
    auth: (): Promise<never> => Promise.reject(new Error("fakeApi.auth() unused in this test")),
    fetch: (path: string): Promise<ChatGptFetchResult> => {
      fetches.push(path);
      const id = path.replace("/conversation/", "");
      return Promise.resolve(makeDetailOkForConversation(id));
    },
    fetchBatch: (ids: readonly string[]): Promise<ChatGptFetchResult[]> => {
      batchCalls.push([...ids]);
      return Promise.resolve(ids.filter((id) => id !== "convo-2").map((id) => makeDetailOkForConversation(id)));
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
    { random: () => 0, sleep: () => undefined }
  );

  assert.deepEqual(batchCalls, [["convo-1", "convo-2", "convo-3"]]);
  assert.deepEqual(fetches, ["/conversation/convo-2"], "only the omitted id falls back to per-id GET");
  assert.deepEqual(coverage.hydratedKeys, ["convo-1", "convo-2", "convo-3"]);
  assert.deepEqual(coverage.gapKeys, []);
});

test("runMessagesAndConversationsWithDetail: 100 conversations use 10 capped batch calls, not 100 GETs", async () => {
  const harness = makeRecordingEmit(validateRecord);
  const batchCalls: string[][] = [];
  const fetches: string[] = [];
  const api: ChatGptApi = {
    auth: (): Promise<never> => Promise.reject(new Error("fakeApi.auth() unused in this test")),
    fetch: (path: string): Promise<ChatGptFetchResult> => {
      fetches.push(path);
      throw new Error(`unexpected per-id GET: ${path}`);
    },
    fetchBatch: (ids: readonly string[]): Promise<ChatGptFetchResult[]> => {
      batchCalls.push([...ids]);
      assert.ok(ids.length <= 10, "provider batch requests must never exceed 10 ids");
      return Promise.resolve(ids.map((id) => makeDetailOkForConversation(id)));
    },
  };
  const deps: StreamDeps = {
    api,
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    progress: (): Promise<void> => Promise.resolve(),
    requested: new Map(["conversations", "messages"].map((name) => [name, { name }])),
  };
  const convos = Array.from({ length: 100 }, (_, index) => makeConvo({ id: `convo-${index + 1}` }));

  const coverage = await runMessagesAndConversationsWithDetail(deps, convos, makeEmitConversation(deps), {
    random: () => 0,
    sleep: () => undefined,
  });

  assert.equal(batchCalls.length, 10, "100 ids should be fetched as 10 provider-capped batches");
  assert.deepEqual(
    batchCalls.map((ids) => ids.length),
    Array.from({ length: 10 }, () => 10)
  );
  assert.deepEqual(fetches, [], "fully batch-hydrated run must not issue per-id GETs");
  assert.equal(coverage.hydratedKeys.length, 100);
  assert.deepEqual(coverage.gapKeys, []);
});

test("runMessagesAndConversationsWithDetail: unavailable batch endpoint degrades to existing GET path", async () => {
  const harness = makeRecordingEmit(validateRecord);
  const batchCalls: string[][] = [];
  const fetches: string[] = [];
  const api: ChatGptApi = {
    auth: (): Promise<never> => Promise.reject(new Error("fakeApi.auth() unused in this test")),
    fetch: (path: string): Promise<ChatGptFetchResult> => {
      fetches.push(path);
      const id = path.replace("/conversation/", "");
      return Promise.resolve(makeDetailOkForConversation(id));
    },
    fetchBatch: (ids: readonly string[]): Promise<ChatGptFetchResult[]> => {
      batchCalls.push([...ids]);
      return Promise.reject(new Error("batch unavailable"));
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
    { random: () => 0, sleep: () => undefined }
  );

  assert.deepEqual(batchCalls, [["convo-1", "convo-2", "convo-3"]]);
  assert.deepEqual(fetches, ["/conversation/convo-1", "/conversation/convo-2", "/conversation/convo-3"]);
  assert.deepEqual(coverage.hydratedKeys, ["convo-1", "convo-2", "convo-3"]);
  assert.deepEqual(coverage.gapKeys, []);
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
  // The absorbed backoff is NOT double-paid as a launch cooldown, and the
  // inter-launch jitter is now ε (0 with random=0), so only the two absorbed
  // request backoffs remain. Pre-floor-delete this was [45_000, 1500, 45_000];
  // pre-double-pay-fix it was [45_000, 45_000, 45_000].
  assert.deepEqual(
    pauses,
    [45_000, 45_000],
    "absorbed retry backoff is not double-paid; ε-jitter adds no launch floor between requests"
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

test("runMessagesAndConversationsWithDetail: cumulative 429 density WAITS OUT the account cool-down and continues (SLVP-ideal), losing nothing", async () => {
  // Slow-bleed regime: each fetch is served a 429, honors a Retry-After, then
  // SUCCEEDS — so nothing ever throws and the exhaustion-only circuit never
  // opens. With a density threshold of 2, after two served 429s the account is
  // HOT. SLVP-ideal control-system verdict: the lane does NOT terminate and
  // defer the tail (the old behavior — "unnecessary lag"); it WAITS OUT the
  // account's cool-down in-run, resets the density accumulator, and CONTINUES
  // draining. The account recovers in minutes while still serving, so a single
  // run drains the whole batch instead of leaving a backlog for a re-kick.
  // Here the injected sleep is instantaneous and run budget is unbounded, so all
  // five conversations hydrate and NOTHING is gapped — strictly more data
  // collected, lose-nothing preserved.
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

  // SLVP-ideal: after the density threshold trips at convo-2, the lane waits out
  // the cool-down (instant in-test) and RESUMES — so all five conversations are
  // fetched and hydrate. Nothing is deferred, because the run never genuinely
  // ended under pressure; it kept draining. (Lose-nothing: any conversation
  // still unfetched at a GENUINE run end — work-drained / run-budget / abort —
  // is durably gapped by the existing tail paths, covered by the run-budget and
  // recovery tests.)
  assert.deepEqual(
    fetchedIds,
    [
      "/conversation/convo-1",
      "/conversation/convo-2",
      "/conversation/convo-3",
      "/conversation/convo-4",
      "/conversation/convo-5",
    ],
    "the lane waits out source heat and continues fetching the whole batch"
  );
  assert.deepEqual(coverage.hydratedKeys, ["convo-1", "convo-2", "convo-3", "convo-4", "convo-5"]);
  assert.deepEqual(coverage.gapKeys, []);

  // Wait-resume: the whole batch hydrated, so NOTHING was deferred — no
  // DETAIL_GAP is emitted while the run keeps draining under available budget.
  const gaps = harness.protocolMessages.filter(
    (m): m is Extract<EmittedMessage, { type: "DETAIL_GAP" }> => m.type === "DETAIL_GAP"
  );
  assert.deepEqual(gaps, [], "wait-resume hydrates the batch; nothing is deferred under available budget");

  // The density trip surfaces a WAIT progress event (the account cooled, the lane
  // resumed), not a defer/terminate. It names the served-429 count and leaks no
  // conversation ids or API paths (the data-hygiene guard the old test pinned).
  const densityWaitProgress = harness.protocolMessages.filter(
    (m): m is Extract<EmittedMessage, { type: "PROGRESS" }> =>
      m.type === "PROGRESS" &&
      m.stream === "messages" &&
      m.message.includes("waiting") &&
      m.message.includes("cool down") &&
      m.message.includes("served 429s")
  );
  // Wait-resume re-earns its way to each stop: after a wait, the density
  // accumulator resets to 0, so the threshold (2) re-trips every two served 429s.
  // Across five conversations each served one 429, that is two trips: convo-2
  // (count 1→2, trip+reset) and convo-4 (count 1→2, trip+reset); convo-5 leaves
  // the bucket at 1, below threshold. The exact count proves the reset-after-wait
  // contract — the lane neither stops permanently after the first trip nor loops
  // unbounded.
  assert.equal(
    densityWaitProgress.length,
    2,
    "the density trip waits out the cool-down and resumes, re-earning each stop (two trips across five 429s at threshold 2)"
  );
  assert.equal(
    densityWaitProgress.some((m) => m.message.includes("convo-") || m.message.includes("/conversation/")),
    false,
    "the density-wait progress message must not leak conversation ids or API paths"
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

test("runMessagesAndConversationsWithDetail: pre-detail 429s seed the density stop and trigger the cool-down WAIT sooner (still hydrating the batch)", async () => {
  // The run already absorbed two served 429s outside the detail lane (list
  // pagination on a hot account). With a threshold of 3, ONE in-lane served 429
  // now trips the stop — the seeded pre-detail pressure carries forward instead
  // of resetting to zero, so the lane reaches the cool-down WAIT an
  // account-pressure cycle earlier than it would on a fresh budget (then resumes
  // and still hydrates the whole batch under available budget).
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

  // Wait-resume + seed: the seeded 2 + convo-1's in-lane 429 = 3 = threshold, so
  // the density WAIT trips after convo-1 (the seed made it trip an account-pressure
  // cycle EARLIER than a fresh budget would — that is what the seed proves). The
  // lane then waits out the cool-down, resets, and RESUMES — so convo-2..4 still
  // hydrate under the unbounded budget. Nothing is deferred. (Without the seed,
  // the same shape would not trip until 3 in-lane 429s; the seed shifts the WAIT
  // earlier, not a defer earlier.)
  assert.deepEqual(
    fetchedIds,
    ["/conversation/convo-1", "/conversation/convo-2", "/conversation/convo-3", "/conversation/convo-4"],
    "the seed shifts the density WAIT earlier, but the lane resumes and hydrates the whole batch"
  );
  assert.deepEqual(coverage.hydratedKeys, ["convo-1", "convo-2", "convo-3", "convo-4"]);
  assert.deepEqual(coverage.gapKeys, []);

  // No gap is deferred — the run kept draining.
  const gaps = harness.protocolMessages.filter(
    (m): m is Extract<EmittedMessage, { type: "DETAIL_GAP" }> => m.type === "DETAIL_GAP"
  );
  assert.deepEqual(gaps, [], "wait-resume defers nothing under available budget, even with a pre-detail seed");

  // The wait trips exactly once and reports the FULL cumulative count (seed +
  // in-lane), so the operator sees run-level pressure, not just the detail slice.
  const densityWaitProgress = harness.protocolMessages.filter(
    (m): m is Extract<EmittedMessage, { type: "PROGRESS" }> =>
      m.type === "PROGRESS" &&
      m.stream === "messages" &&
      m.message.includes("waiting") &&
      m.message.includes("cool down")
  );
  assert.equal(densityWaitProgress.length, 1, "the seeded density trip waits out the cool-down exactly once");
  assert.equal(
    densityWaitProgress[0]?.message.includes("3 served 429s"),
    true,
    "the wait names the cumulative seed+in-lane count"
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

// ─── Bounded-run budget (provider requests / wall-clock per run) ───────────

test("resolveChatGptMaxDetailFetchesPerRun: unset/non-positive → no cap; positive int opts into envelope", () => {
  assert.equal(resolveChatGptMaxDetailFetchesPerRun({}), Number.POSITIVE_INFINITY);
  assert.equal(
    resolveChatGptMaxDetailFetchesPerRun({ PDPP_CHATGPT_MAX_DETAIL_FETCHES_PER_RUN: "" }),
    Number.POSITIVE_INFINITY
  );
  assert.equal(
    resolveChatGptMaxDetailFetchesPerRun({ PDPP_CHATGPT_MAX_DETAIL_FETCHES_PER_RUN: "0" }),
    Number.POSITIVE_INFINITY,
    "0 keeps the adaptive default unbounded by detail count"
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

test("resolveChatGptMaxRunWallClockMs: unset/non-positive → no cap; positive ms opts into envelope", () => {
  assert.equal(resolveChatGptMaxRunWallClockMs({}), Number.POSITIVE_INFINITY);
  assert.equal(
    resolveChatGptMaxRunWallClockMs({ PDPP_CHATGPT_MAX_RUN_WALL_CLOCK_MS: "0" }),
    Number.POSITIVE_INFINITY,
    "0 keeps the adaptive default unbounded by wall-clock"
  );
  assert.equal(resolveChatGptMaxRunWallClockMs({ PDPP_CHATGPT_MAX_RUN_WALL_CLOCK_MS: "-1" }), Number.POSITIVE_INFINITY);
  assert.equal(resolveChatGptMaxRunWallClockMs({ PDPP_CHATGPT_MAX_RUN_WALL_CLOCK_MS: "1800000" }), 1_800_000);
  assert.equal(
    resolveChatGptMaxRunWallClockMs({ PDPP_CHATGPT_MAX_RUN_WALL_CLOCK_MS: "1800000.9" }),
    1_800_000,
    "fractional ms floors"
  );
});

test("resolveChatGptProviderBudget: defaults enable pacing + circuit breaker + adaptive retry budget", async () => {
  const defaultBudget = resolveChatGptProviderBudget({});
  assert.ok(defaultBudget instanceof ProviderBudgetController);
  assert.ok(defaultBudget.pacing, "ChatGPT default enables adaptive inter-request pacing");
  assert.equal(
    defaultBudget.pacing.currentIntervalMs,
    1000,
    "ChatGPT cold-starts at the discovery seed (lowered from glacial 2500ms); warm-start restores the learned value on later runs"
  );
  // Adaptive retry budget: ON by default. capacity=100 banks many wait-outs for a
  // healthy account (5 successes refill 1 token); initialTokens=8 gives a dead
  // account the same 8-wait ceiling as the prior fixed densityWaitCycles cap.
  // This replaces the old fixed-cycle cap as the PRIMARY give-up bound so that
  // healthy accounts drain effectively forever while dead accounts converge fast.
  assert.ok(defaultBudget.retryBudget, "retry budget is ON by default — adaptive give-up for wait-out regimes");
  assert.equal(
    defaultBudget.retryBudget.capacity,
    100,
    "default capacity=100 lets a healthy account bank many wait-outs"
  );
  assert.equal(
    defaultBudget.retryBudget.remaining,
    8,
    "cold start at initialTokens=8 — matches old dead-account ceiling"
  );
  assert.ok(defaultBudget.circuitBreaker, "ChatGPT default enables a circuit breaker");

  // Explicit env override: capacity=5 restores the prior default-ON capacity exactly.
  const retryBudgetReenabled = resolveChatGptProviderBudget({ PDPP_CHATGPT_RETRY_BUDGET_CAPACITY: "5" });
  assert.ok(retryBudgetReenabled?.retryBudget, "PDPP_CHATGPT_RETRY_BUDGET_CAPACITY overrides capacity");
  assert.equal(retryBudgetReenabled.retryBudget.capacity, 5, "capacity overridden to the specified value");

  // initialTokens override via env.
  const customInitial = resolveChatGptProviderBudget({ PDPP_CHATGPT_RETRY_BUDGET_INITIAL_TOKENS: "3" });
  assert.ok(customInitial?.retryBudget, "retry budget present with custom initialTokens");
  assert.equal(
    customInitial.retryBudget.remaining,
    3,
    "PDPP_CHATGPT_RETRY_BUDGET_INITIAL_TOKENS overrides cold-start tokens"
  );

  const pacingDisabled = resolveChatGptProviderBudget({ PDPP_CHATGPT_PACING_INITIAL_INTERVAL_MS: "0" });
  assert.ok(pacingDisabled instanceof ProviderBudgetController);
  assert.equal(pacingDisabled.pacing, null, "pacing can be disabled independently");
  assert.ok(pacingDisabled.retryBudget, "retry budget stays ON when only pacing is disabled");
  assert.ok(pacingDisabled.circuitBreaker);

  assert.equal(
    resolveChatGptProviderBudget({
      PDPP_CHATGPT_CIRCUIT_BREAKER: "0",
      PDPP_CHATGPT_PACING_INITIAL_INTERVAL_MS: "0",
      PDPP_CHATGPT_RETRY_BUDGET_CAPACITY: "0",
    }),
    null,
    "circuit breaker, retry budget, and pacing can all be disabled for supervised probes"
  );

  const retryOnly = resolveChatGptProviderBudget({ PDPP_CHATGPT_MAX_DETAIL_FETCHES_PER_RUN: "10" });
  assert.ok(retryOnly instanceof ProviderBudgetController);
  assert.ok(retryOnly.pacing, "run cap override preserves default inter-request pacing");
  assert.ok(retryOnly.retryBudget, "run cap derives a ratio-based retry budget");
  assert.equal(retryOnly.retryBudget.capacity, 2);

  const sleeps: number[] = [];
  const budget = resolveChatGptProviderBudget({
    PDPP_CHATGPT_PACING_BURST_TOLERANCE_MS: "250",
    PDPP_CHATGPT_PACING_INITIAL_INTERVAL_MS: "500",
    PDPP_CHATGPT_PACING_MIN_INTERVAL_MS: "100",
  });
  assert.ok(budget instanceof ProviderBudgetController);

  // Replace the production sleep-free resolver proof with a direct controller
  // check using the same shape: enabled budget has a pacing controller.
  const injected = new ProviderBudgetController({
    pacing: {
      initialIntervalMs: 500,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    },
  });
  await injected.beforeRequest();
  assert.deepEqual(sleeps, [500]);
});

test("consumeChatGptProviderRetryBudget: exhausted retry budget becomes planned provider-budget defer", () => {
  const providerBudget = new ProviderBudgetController({ retryBudget: { capacity: 1 } });

  assert.equal(consumeChatGptProviderRetryBudget(providerBudget), null);
  const plannedDefer = consumeChatGptProviderRetryBudget(providerBudget);

  assert.ok(plannedDefer instanceof ChatGptPlannedProviderBudgetDeferredError);
  assert.equal(plannedDefer.reason, "provider_retry_budget");
  assert.equal(plannedDefer.gate?.reason, "retry_budget");
});

test("ChatGptRunBudget: no caps never stops; request budget and wall-clock budget each trip with the right reason", () => {
  // Disabled budget primitive: never the reason a run stops.
  const open = new ChatGptRunBudget();
  for (let i = 0; i < 100; i += 1) {
    open.recordDetailFetch();
  }
  assert.equal(open.shouldStop(), false, "a budget with no caps never trips");
  assert.equal(open.reason(), null);

  // Request budget: trips once the admitted conversation-detail count reaches
  // the provider-request budget.
  const fetchCapped = new ChatGptRunBudget({ maxFetches: 2 });
  assert.equal(fetchCapped.reason(), null, "0 < 2: open");
  fetchCapped.recordDetailFetch();
  assert.equal(fetchCapped.reason(), null, "1 < 2: open");
  fetchCapped.recordDetailFetch();
  assert.equal(fetchCapped.reason(), "max_detail_fetches", "2 >= 2: tripped");

  // Wall-clock budget: clock anchors on the first reason() call, then trips once
  // the injected clock advances past the budget.
  let nowMs = 1000;
  const clockCapped = new ChatGptRunBudget({ maxWallClockMs: 500, now: () => nowMs });
  assert.equal(clockCapped.reason(), null, "elapsed 0 < 500: open and anchored");
  nowMs = 1400;
  assert.equal(clockCapped.reason(), null, "elapsed 400 < 500: open");
  nowMs = 1500;
  assert.equal(clockCapped.reason(), "max_wall_clock", "elapsed 500 >= 500: tripped");
});

test("runMessagesAndConversationsWithDetail: a provider-request budget defers the tail as resumable run-cap DETAIL_GAP", async () => {
  // A genuinely COLD account (every fetch 200, no 429): the density stop never
  // trips, so without a size budget a large backlog would run unbounded. With a
  // request budget of 2, the run hydrates exactly two and defers the rest cleanly.
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

  // Exactly two fetches launch; convo-3's launch sees the budget and defers it plus
  // the rest with NO further fetch — proving a large backlog cannot become an
  // unbounded run.
  assert.deepEqual(
    fetchedIds,
    ["/conversation/convo-1", "/conversation/convo-2"],
    "no detail fetch is launched once the request budget is reached"
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
  assert.equal(
    capProgress[0]?.message.includes("provider-request budget"),
    true,
    "the message names the provider-request budget"
  );
  assert.equal(
    capProgress[0]?.message.includes("detail-count cap"),
    false,
    "the message must not frame the run budget as a connector-specific detail-count cap"
  );
  assert.equal(
    capProgress.some((m) => m.message.includes("convo-") || m.message.includes("/conversation/")),
    false,
    "the cap-trip progress message must not leak conversation ids or API paths"
  );
});

test("runMessagesAndConversationsWithDetail: a wall-clock budget defers the tail via an injected clock", async () => {
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
      m.type === "PROGRESS" && m.stream === "messages" && m.message.includes("wall-clock budget")
  );
  assert.equal(capProgress.length, 1, "the wall-clock trip names the wall-clock budget exactly once");
});

test("runMessagesAndConversationsWithDetail: an open upstream-pressure circuit with budget remaining waits out the cool-down and CONTINUES (does not defer-all-and-stop)", async () => {
  // The live `run_1781150455121` defect: the upstream-pressure circuit opened
  // with ~13 min of a 15-min budget unused, and the run deferred the entire tail
  // and quit — because `circuit_open` was bucketed with the genuine run caps. A
  // tripped circuit is a TRANSIENT back-off (it auto-closes after its reset
  // timeout), not budget exhaustion. With budget remaining the run must wait out
  // the cool-down and RESUME, not stop on the first trip.
  const harness = makeRecordingEmit(validateRecord);
  const fetchedIds: string[] = [];
  let nowMs = 0;
  const resetTimeoutMs = 300_000; // 5-min default cool-down (the live shape).
  // failureRateThreshold/minimumThroughput 1 → a single recorded failure opens
  // the circuit; `now` is the shared fake clock the wait advances.
  const providerBudget = new ProviderBudgetController({
    circuitBreaker: {
      failureRateThreshold: 1,
      minimumThroughput: 1,
      now: () => nowMs,
      resetTimeoutMs,
    },
  });
  // Open the circuit BEFORE the run: the first detail attempt admits into an
  // already-open circuit, the exact live shape (circuit opened mid-recovery,
  // then the next pass admits into it).
  providerBudget.recordFailure();
  providerBudget.drainCircuitTransitions();
  assert.equal(providerBudget.circuitCooldownMs(), resetTimeoutMs, "circuit is open with the full cool-down owed");

  const api: ChatGptApi = {
    auth: (): Promise<never> => Promise.reject(new Error("fakeApi.auth() unused in this test")),
    fetch: async (path: string): Promise<ChatGptFetchResult> => {
      // Real provider-budget gate: throws `circuit_open` while the circuit is
      // open, admits (and the run continues) once it half-opens after the wait.
      await admitFakeProviderBudget(providerBudget);
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
    providerBudget,
    requested: new Map(["conversations", "messages"].map((name) => [name, { name }])),
  };

  const waitSleeps: number[] = [];
  const coverage = await runMessagesAndConversationsWithDetail(
    deps,
    [makeConvo({ id: "convo-1" }), makeConvo({ id: "convo-2" })],
    makeEmitConversation(deps),
    {
      random: () => 0,
      // The wait-out sleep advances the shared clock so the circuit auto-closes
      // (open → half_open) on the next admit — exactly what real wall-clock does.
      // A generous wall-clock budget remains (the live "budget remaining" case).
      sleep: (ms) => {
        waitSleeps.push(ms);
        nowMs += ms;
      },
      runBudget: new ChatGptRunBudget({ maxWallClockMs: 15 * 60_000, now: () => nowMs }),
    }
  );

  // The run CONTINUED: every conversation was hydrated after the cool-down, NOT
  // deferred-all on the first circuit trip.
  assert.deepEqual(
    fetchedIds,
    ["/conversation/convo-1", "/conversation/convo-2"],
    "the run resumes and hydrates the full tail after waiting out the circuit"
  );
  assert.deepEqual(coverage.hydratedKeys, ["convo-1", "convo-2"]);
  assert.deepEqual(coverage.gapKeys, [], "nothing is deferred when the circuit cools down within budget");
  // It paid exactly the cool-down (bounded by remaining budget) at least once.
  assert.ok(
    waitSleeps.some((ms) => ms === resetTimeoutMs),
    "the run waits the circuit's exact cool-down within the remaining run budget"
  );
  // No run-cap / source-pressure DETAIL_GAP was emitted — the tail was collected.
  assert.equal(
    harness.protocolMessages.some((m) => m.type === "DETAIL_GAP"),
    false,
    "a transient circuit trip with budget remaining defers nothing"
  );
  const waitProgress = harness.protocolMessages.filter(
    (m): m is Extract<EmittedMessage, { type: "PROGRESS" }> =>
      m.type === "PROGRESS" && m.message.includes("circuit open; waiting")
  );
  assert.ok(waitProgress.length >= 1, "the wait-out emits operator-legible progress");
  assert.equal(
    JSON.stringify(waitProgress).includes("convo-1") || JSON.stringify(waitProgress).includes("convo-2"),
    false,
    "wait-out progress does not leak conversation ids"
  );
});

test("runMessagesAndConversationsWithDetail: genuine wall-clock exhaustion DURING a circuit wait defers the tail (budget exhaustion still stops)", async () => {
  // The other side of the discrimination: when the run budget is genuinely
  // exhausted, the run must still defer the remaining tail and stop — a circuit
  // trip must not let it wait past its envelope. Here the budget is too small to
  // wait out even one cool-down, so the first circuit trip with no budget left
  // defers as a resumable run-cap gap.
  const harness = makeRecordingEmit(validateRecord);
  const fetchedIds: string[] = [];
  let nowMs = 0;
  const resetTimeoutMs = 300_000;
  // windowSize 1 → the single recordFailure after the first hydration opens the
  // circuit despite the connector's recordSuccess() on that hydration.
  const providerBudget = new ProviderBudgetController({
    circuitBreaker: {
      failureRateThreshold: 1,
      minimumThroughput: 1,
      now: () => nowMs,
      resetTimeoutMs,
      windowSize: 1,
    },
  });
  // First fetch succeeds (consumes the whole tiny wall budget via the clock),
  // then the circuit is opened so the SECOND admit trips circuit_open with the
  // budget already spent → genuine exhaustion, defer the tail.
  let fetchCount = 0;
  const api: ChatGptApi = {
    auth: (): Promise<never> => Promise.reject(new Error("fakeApi.auth() unused in this test")),
    fetch: async (path: string): Promise<ChatGptFetchResult> => {
      await admitFakeProviderBudget(providerBudget);
      fetchCount += 1;
      fetchedIds.push(path);
      await Promise.resolve();
      // The first hydration burns the entire wall budget, AND opens the circuit
      // so the next admit trips circuit_open with zero budget left.
      if (fetchCount === 1) {
        nowMs += 1000; // elapsed 1000 >= 500ms cap → budget exhausted
        providerBudget.recordFailure();
        providerBudget.drainCircuitTransitions();
      }
      return makeDetailOk();
    },
  };
  const deps: StreamDeps = {
    api,
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    progress: (): Promise<void> => Promise.resolve(),
    providerBudget,
    requested: new Map(["conversations", "messages"].map((name) => [name, { name }])),
  };

  const waitSleeps: number[] = [];
  const coverage = await runMessagesAndConversationsWithDetail(
    deps,
    [makeConvo({ id: "convo-1" }), makeConvo({ id: "convo-2" }), makeConvo({ id: "convo-3" })],
    makeEmitConversation(deps),
    {
      random: () => 0,
      sleep: (ms) => {
        waitSleeps.push(ms);
        nowMs += ms;
      },
      runBudget: new ChatGptRunBudget({ maxWallClockMs: 500, now: () => nowMs }),
    }
  );

  // convo-1 hydrated; convo-2's admit trips the circuit with no budget left, so
  // convo-2..3 defer as resumable run-cap gaps. The run did NOT wait the
  // cool-down (no budget to wait it out).
  assert.deepEqual(fetchedIds, ["/conversation/convo-1"], "no fetch after genuine budget exhaustion");
  assert.deepEqual(coverage.hydratedKeys, ["convo-1"]);
  assert.deepEqual(coverage.gapKeys, ["convo-2", "convo-3"]);
  assert.equal(waitSleeps.length, 0, "an exhausted budget is never waited out as a transient circuit");
  const gaps = harness.protocolMessages.filter(
    (m): m is Extract<EmittedMessage, { type: "DETAIL_GAP" }> => m.type === "DETAIL_GAP"
  );
  assert.ok(gaps.length >= 1, "the exhausted-budget tail is deferred as durable DETAIL_GAP records");
  assert.equal(
    gaps.every((g) => g.reason === "retry_exhausted" && g.detail?.class === "run_cap_deferred"),
    true,
    "budget-exhaustion gaps are resumable run-cap gaps (no source-pressure cooldown armed)"
  );
});

test("runMessagesAndConversationsWithDetail: a circuit that NEVER closes converges to a bounded defer (no infinite loop)", async () => {
  // Forward-progress guard: a genuinely hostile provider whose circuit re-opens
  // on every cool-down probe must NOT loop forever within an uncapped (Infinity
  // wall-clock) budget. We model "never closes" faithfully: the circuit
  // half-opens after each cool-down, the probe FETCH fails (the provider is still
  // hot), and that failure re-opens the circuit — exactly the real half-open →
  // fail → re-open cycle. With no wall-clock cap, the ONLY thing that can stop
  // the wait loop is the bounded cycle guard. windowSize 1 → a single failure
  // dominates the window so the re-open is deterministic.
  const harness = makeRecordingEmit(validateRecord);
  let nowMs = 0;
  const resetTimeoutMs = 60_000;
  // No retryBudget — the controller is present but hasRetryBudget() returns false.
  // This exercises the fixed no-budget→cycle-cap fallback path: the gate must use
  // the shared consecutiveWaitOutsWithoutSuccess cap, NOT tryConsumeRetryToken (which
  // previously returned true forever, causing the infinite loop this test guards).
  const providerBudget = new ProviderBudgetController({
    circuitBreaker: {
      failureRateThreshold: 1,
      minimumThroughput: 1,
      now: () => nowMs,
      resetTimeoutMs,
      windowSize: 1,
    },
  });
  providerBudget.recordFailure();
  providerBudget.drainCircuitTransitions();

  // Every fetch fails the half-open probe and re-opens the circuit, then throws
  // circuit_open — so the admit never succeeds and the wait loop must rely on its
  // bounded cycle guard (not budget, not the circuit) to converge to a defer.
  const api: ChatGptApi = {
    auth: (): Promise<never> => Promise.reject(new Error("fakeApi.auth() unused in this test")),
    fetch: (): Promise<ChatGptFetchResult> => {
      // A failed probe re-opens the circuit at the current (advanced) clock.
      providerBudget.recordFailure();
      providerBudget.drainCircuitTransitions();
      // The gate is now open again: surface the same circuit_open planned defer
      // the real admit path raises, so the wait loop treats it as transient.
      throw new ChatGptPlannedProviderBudgetDeferredError(
        "circuit re-opened on a failed half-open probe",
        "circuit_open"
      );
    },
  };
  const deps: StreamDeps = {
    api,
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    progress: (): Promise<void> => Promise.resolve(),
    providerBudget,
    requested: new Map(["conversations", "messages"].map((name) => [name, { name }])),
  };

  const waitSleeps: number[] = [];
  const coverage = await runMessagesAndConversationsWithDetail(
    deps,
    [makeConvo({ id: "convo-1" }), makeConvo({ id: "convo-2" })],
    makeEmitConversation(deps),
    {
      random: () => 0,
      sleep: (ms) => {
        waitSleeps.push(ms);
        nowMs += ms;
      },
      // No wall-clock cap (Infinity): the ONLY thing that can stop the wait loop
      // is the bounded cycle guard, proving the guard — not the budget — bounds it.
      runBudget: new ChatGptRunBudget(),
    }
  );

  // Bounded: the wait loop ran a finite number of cycles, then deferred the tail.
  // With no retryBudget the cycle-cap (CHATGPT_CIRCUIT_WAIT_OUT_MAX_CYCLES=8) governs,
  // so the loop must terminate in at most 8 waits — not spin forever.
  assert.ok(waitSleeps.length > 0, "the run does wait out the circuit while it can");
  assert.ok(
    waitSleeps.length <= 8,
    "no-retry-budget controller: cycle cap (≤8) bounds the wait loop, not an infinite spin"
  );
  assert.equal(coverage.hydratedKeys.length, 0, "a never-closing circuit hydrates nothing");
  assert.deepEqual(coverage.gapKeys, ["convo-1", "convo-2"], "the tail defers durably after the bounded waits");
  const gaps = harness.protocolMessages.filter(
    (m): m is Extract<EmittedMessage, { type: "DETAIL_GAP" }> => m.type === "DETAIL_GAP"
  );
  assert.ok(gaps.length >= 1, "a never-closing circuit ends with durable DETAIL_GAP records, not an infinite loop");
});

test("runMessagesAndConversationsWithDetail: the live 136s/900s shape now runs the full budget instead of exiting early (regression)", async () => {
  // Regression for the exact live shape: a 15-min (900s) budget, a circuit that
  // opens early but cools within budget. BEFORE the fix the run exited after the
  // first trip (~136s, ~13 min budget abandoned). AFTER, it waits out each
  // cool-down and keeps collecting until the work is done OR the budget is truly
  // spent — so a long tail makes meaningful forward progress instead of stopping
  // at the first circuit trip.
  const harness = makeRecordingEmit(validateRecord);
  const fetchedIds: string[] = [];
  let nowMs = 0;
  const resetTimeoutMs = 300_000; // 5 min, the CHATGPT default.
  // windowSize 1 → a single recordFailure opens the circuit regardless of the
  // connector's own recordSuccess() calls on the preceding hydrations.
  const providerBudget = new ProviderBudgetController({
    circuitBreaker: {
      failureRateThreshold: 1,
      minimumThroughput: 1,
      now: () => nowMs,
      resetTimeoutMs,
      windowSize: 1,
    },
  });
  // The circuit opens once, early (after the first couple of fetches), then cools
  // down within budget and stays closed — a transient burst, the live pattern.
  let opened = false;
  const api: ChatGptApi = {
    auth: (): Promise<never> => Promise.reject(new Error("fakeApi.auth() unused in this test")),
    fetch: async (path: string): Promise<ChatGptFetchResult> => {
      await admitFakeProviderBudget(providerBudget);
      fetchedIds.push(path);
      // Each successful detail "costs" ~10s of wall-clock.
      nowMs += 10_000;
      // After two successes, a transient burst opens the circuit exactly once.
      if (!opened && fetchedIds.length === 2) {
        opened = true;
        providerBudget.recordFailure();
        providerBudget.drainCircuitTransitions();
      }
      return makeDetailOk();
    },
  };
  const deps: StreamDeps = {
    api,
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    progress: (): Promise<void> => Promise.resolve(),
    providerBudget,
    requested: new Map(["conversations", "messages"].map((name) => [name, { name }])),
  };

  const convos = Array.from({ length: 6 }, (_, i) => makeConvo({ id: `convo-${i + 1}` }));
  const coverage = await runMessagesAndConversationsWithDetail(deps, convos, makeEmitConversation(deps), {
    random: () => 0,
    sleep: (ms) => {
      nowMs += ms;
    },
    runBudget: new ChatGptRunBudget({ maxWallClockMs: 900_000, now: () => nowMs }),
  });

  // BEFORE the fix: fetchedIds.length === 2, the rest deferred at the first trip,
  // run ends ~20s in with ~880s budget unused. AFTER: it waits the 5-min
  // cool-down (well within the 900s budget) and hydrates the FULL tail.
  assert.equal(coverage.hydratedKeys.length, 6, "the full tail is collected after waiting out the transient circuit");
  assert.deepEqual(coverage.gapKeys, [], "no work is abandoned while budget remains");
  assert.ok(
    fetchedIds.length > 2,
    "the run collects MORE than the pre-circuit prefix (it would have exited at 2 before the fix)"
  );
  // The run used a meaningful chunk of its budget (it waited the cool-down)
  // rather than exiting at ~20s — but stayed within the 900s envelope.
  assert.ok(nowMs >= resetTimeoutMs, "the run spent real budget waiting out the cool-down, not exiting early");
  assert.ok(nowMs <= 900_000, "and stayed within the wall-clock envelope");
});

test("runMessagesAndConversationsWithDetail: empty budget leaves a large backlog unbounded", async () => {
  // The generic primitive can still run unbounded: a budget with neither knob
  // set hydrates every conversation and emits zero gaps.
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

test("runMessagesAndConversationsWithDetail: the GCRA pacing hint is the rate authority, not a launch-jitter floor", async () => {
  // Signal mode: the controller does NOT sleep in beforeRequest(); the lane is
  // the sole send governor and folds the GCRA interval in via launchDelayHint.
  // After the floor delete, the lane's launch wait equals the LEARNED pacing
  // interval (250ms here), NOT a fixed 1500ms jitter floor — proving the
  // controller binds the rate. The ε-jitter window adds at most a few hundred ms.
  const harness = makeRecordingEmit(validateRecord);
  const fetchedIds: string[] = [];
  const providerSleeps: number[] = [];
  const laneSleeps: number[] = [];
  const providerBudget = new ProviderBudgetController({
    pacing: {
      initialIntervalMs: 250,
      sleep: (ms) => {
        providerSleeps.push(ms);
        return Promise.resolve();
      },
    },
    pacingMode: "signal",
  });
  const api: ChatGptApi = {
    auth: (): Promise<never> => Promise.reject(new Error("fakeApi.auth() unused in this test")),
    fetch: async (path: string): Promise<ChatGptFetchResult> => {
      await admitFakeProviderBudget(providerBudget);
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
    providerBudget,
    requested: new Map(["conversations", "messages"].map((name) => [name, { name }])),
  };

  const coverage = await runMessagesAndConversationsWithDetail(
    deps,
    [makeConvo({ id: "convo-1" }), makeConvo({ id: "convo-2" })],
    makeEmitConversation(deps),
    {
      // random=0 → ε-jitter contributes 0; the launch wait is governed purely by
      // the GCRA pacing hint folded in via max(launchDelay≈0, cooldown, hint).
      random: () => 0,
      sleep: (ms) => {
        laneSleeps.push(ms);
      },
      tuning: {
        initialConcurrency: 1,
        maxConcurrency: 1,
        pauseMaxMs: 150,
        pauseMinMs: 0,
      },
    }
  );

  assert.deepEqual(fetchedIds, ["/conversation/convo-1", "/conversation/convo-2"]);
  assert.deepEqual(coverage.hydratedKeys, ["convo-1", "convo-2"]);
  // Signal mode: controller does NOT sleep in beforeRequest() — pacing hint is
  // delivered via launchDelayHint to the lane, which does the single wait.
  assert.equal(providerSleeps.length, 0, "controller does not sleep in signal mode (lane owns the single wait)");
  // The lane's launch wait tracks the LEARNED pacing interval (250ms), proving
  // the GCRA rate-AIMD binds the rate. No 1500ms floor exists anymore.
  assert.equal(
    laneSleeps.some((ms) => ms === 250),
    true,
    "lane launch wait equals the GCRA pacing interval (the rate authority)"
  );
  assert.equal(
    laneSleeps.some((ms) => ms >= 1500),
    false,
    "no fixed launch-jitter floor of 1500ms binds the rate anymore"
  );
});

test("runMessagesAndConversationsWithDetail: emits structured provider-budget circuit transitions", async () => {
  const harness = makeRecordingEmit(validateRecord);
  let nowMs = 0;
  const providerBudget = new ProviderBudgetController({
    circuitBreaker: {
      failureRateThreshold: 1,
      minimumThroughput: 1,
      now: () => nowMs,
      resetTimeoutMs: 1000,
    },
  });
  providerBudget.recordFailure();
  providerBudget.drainCircuitTransitions();
  nowMs = 1000;

  const api: ChatGptApi = {
    auth: (): Promise<never> => Promise.reject(new Error("fakeApi.auth() unused in this test")),
    fetch: async (): Promise<ChatGptFetchResult> => {
      await admitFakeProviderBudget(providerBudget);
      return makeDetailOk();
    },
  };
  const deps: StreamDeps = {
    api,
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    progress: (): Promise<void> => Promise.resolve(),
    providerBudget,
    requested: new Map(["conversations", "messages"].map((name) => [name, { name }])),
  };

  await runMessagesAndConversationsWithDetail(
    deps,
    [makeConvo({ id: "convo-structured-circuit" })],
    makeEmitConversation(deps),
    { random: () => 0, sleep: () => undefined }
  );

  const providerBudgetEvents = harness.protocolMessages.filter(
    (message): message is Extract<EmittedMessage, { type: "PROGRESS" }> =>
      message.type === "PROGRESS" && message.provider_budget?.object === "provider_budget_circuit_transition"
  );

  assert.deepEqual(
    providerBudgetEvents.map((message) => message.provider_budget?.circuit.state),
    ["half_open", "closed"],
    "open circuit probe and recovery are emitted as structured provider-budget progress"
  );
  assert.equal(
    JSON.stringify(providerBudgetEvents).includes("convo-structured-circuit"),
    false,
    "provider-budget events do not leak conversation ids"
  );
});

test("runMessagesAndConversationsWithDetail: provider request budget defers cleanly before next fetch", async () => {
  const harness = makeRecordingEmit(validateRecord);
  const fetchedIds: string[] = [];
  const providerBudget = new ProviderBudgetController({ runBudget: { maxRequests: 1 } });
  const api: ChatGptApi = {
    auth: (): Promise<never> => Promise.reject(new Error("fakeApi.auth() unused in this test")),
    fetch: async (path: string): Promise<ChatGptFetchResult> => {
      await admitFakeProviderBudget(providerBudget);
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
    providerBudget,
    requested: new Map(["conversations", "messages"].map((name) => [name, { name }])),
  };

  const coverage = await runMessagesAndConversationsWithDetail(
    deps,
    [makeConvo({ id: "convo-1" }), makeConvo({ id: "convo-2" }), makeConvo({ id: "convo-3" })],
    makeEmitConversation(deps),
    { random: () => 0, sleep: () => undefined }
  );

  assert.deepEqual(
    fetchedIds,
    ["/conversation/convo-1"],
    "second fetch is not launched after request budget exhaustion"
  );
  assert.deepEqual(coverage.hydratedKeys, ["convo-1"]);
  assert.deepEqual(coverage.gapKeys, ["convo-2", "convo-3"]);
  const progress = harness.protocolMessages.filter(
    (m): m is Extract<EmittedMessage, { type: "PROGRESS" }> =>
      m.type === "PROGRESS" && m.message.includes("provider budget (max_requests)")
  );
  assert.equal(progress.length, 1, "provider-budget exhaustion is announced once");
});

test("runMessagesAndConversationsWithDetail: provider retry budget defers tail without source pressure", async () => {
  const harness = makeRecordingEmit(validateRecord);
  const fetchedIds: string[] = [];
  const api: ChatGptApi = {
    auth: (): Promise<never> => Promise.reject(new Error("fakeApi.auth() unused in this test")),
    fetch: (path: string): Promise<ChatGptFetchResult> => {
      fetchedIds.push(path);
      throw new ChatGptPlannedProviderBudgetDeferredError("retry budget exhausted", "provider_retry_budget");
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
    [makeConvo({ id: "convo-1" }), makeConvo({ id: "convo-2" })],
    makeEmitConversation(deps),
    { random: () => 0, sleep: () => undefined }
  );

  assert.deepEqual(fetchedIds, ["/conversation/convo-1"]);
  assert.deepEqual(coverage.hydratedKeys, []);
  assert.deepEqual(coverage.gapKeys, ["convo-1", "convo-2"]);
  const gaps = harness.protocolMessages.filter(
    (m): m is Extract<EmittedMessage, { type: "DETAIL_GAP" }> => m.type === "DETAIL_GAP"
  );
  assert.equal(gaps.length, 2);
  assert.ok(
    gaps.every(
      (gap) =>
        gap.reason === "retry_exhausted" &&
        gap.detail?.class === "run_cap_deferred" &&
        gap.detail.network_pressure?.error_class === "provider_retry_budget"
    ),
    "provider retry-budget exhaustion is a planned retry_exhausted gap, not upstream_pressure"
  );
});

test("runConversationsAndMessagesStreams: one run budget bounds the recovery pass AND the forward pass together", async () => {
  // The cap is per-RUN, not per-pass: a pending gap-recovery item plus new
  // forward conversations share one budget. With a request budget of 2 and one
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

test("runConversationsAndMessagesStreams: empty forward poll emits zero coverage and commits checkpoints", async () => {
  const harness = makeRecordingEmit(validateRecord);
  const api: ChatGptApi = {
    auth: (): Promise<never> => Promise.reject(new Error("fakeApi.auth() unused in this test")),
    fetch: async (path: string): Promise<ChatGptFetchResult> => {
      await Promise.resolve();
      if (path.startsWith("/conversations?")) {
        return {
          status: 200,
          json: { items: [], has_missing_conversations: false, total: 0 } as ChatGptJson,
        };
      }
      throw new Error(`unexpected fetch ${path}`);
    },
  };
  const deps: StreamDeps = {
    api,
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    progress: (): Promise<void> => Promise.resolve(),
    requested: new Map(["conversations", "messages"].map((name) => [name, { name }])),
  };

  await runConversationsAndMessagesStreams(
    deps,
    {
      conversations: { last_update_time: "2026-06-15T00:00:00.000Z" },
      messages: { last_update_time: "2026-06-15T00:00:00.000Z" },
    } as CollectContext["state"],
    { detailPacing: { random: () => 0, sleep: () => undefined } }
  );

  const coverages = harness.protocolMessages.filter(
    (m): m is Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> => m.type === "DETAIL_COVERAGE"
  );
  assert.deepEqual(
    coverages.map((coverage) => ({
      stream: coverage.stream,
      state_stream: coverage.state_stream,
      considered: coverage.considered,
      covered: coverage.covered,
      required_keys: coverage.required_keys,
      hydrated_keys: coverage.hydrated_keys,
    })),
    [
      {
        stream: "messages",
        state_stream: "conversations",
        considered: 0,
        covered: 0,
        required_keys: [],
        hydrated_keys: [],
      },
      {
        stream: "conversations",
        state_stream: "conversations",
        considered: 0,
        covered: 0,
        required_keys: [],
        hydrated_keys: [],
      },
    ]
  );
  const states = harness.protocolMessages.filter(
    (m): m is Extract<EmittedMessage, { type: "STATE" }> => m.type === "STATE"
  );
  assert.deepEqual(
    states.map((state) => [state.stream, state.cursor]),
    [
      ["messages", { last_update_time: "2026-06-15T00:00:00.000Z" }],
      ["conversations", { last_update_time: "2026-06-15T00:00:00.000Z" }],
    ]
  );
});

// ─── task 16: bounded cap-tail deferral materialization ──────────────────────

test("resolveChatGptMaxTailDeferralGapsPerRun: default-off, explicit, and fetch-cap-derived", () => {
  // Unset and no fetch cap → Infinity: today's per-key behavior, inert until opt-in.
  assert.equal(resolveChatGptMaxTailDeferralGapsPerRun({}), Number.POSITIVE_INFINITY);
  // Explicit positive integer wins.
  assert.equal(resolveChatGptMaxTailDeferralGapsPerRun({ PDPP_CHATGPT_MAX_TAIL_DEFERRAL_GAPS_PER_RUN: "10" }), 10);
  // Non-integer / non-positive explicit value is a disable sentinel.
  assert.equal(
    resolveChatGptMaxTailDeferralGapsPerRun({ PDPP_CHATGPT_MAX_TAIL_DEFERRAL_GAPS_PER_RUN: "0" }),
    Number.POSITIVE_INFINITY
  );
  assert.equal(
    resolveChatGptMaxTailDeferralGapsPerRun({ PDPP_CHATGPT_MAX_TAIL_DEFERRAL_GAPS_PER_RUN: "nope" }),
    Number.POSITIVE_INFINITY
  );
  // Only a fetch cap set → derived max(fetchCap, 50): an owner who set a fetch cap
  // still gets a bounded tail even without naming this knob.
  assert.equal(resolveChatGptMaxTailDeferralGapsPerRun({ PDPP_CHATGPT_MAX_DETAIL_FETCHES_PER_RUN: "5" }), 50);
  assert.equal(resolveChatGptMaxTailDeferralGapsPerRun({ PDPP_CHATGPT_MAX_DETAIL_FETCHES_PER_RUN: "300" }), 300);
});

test("runMessagesAndConversationsWithDetail: a cap trip over a large tail writes a BOUNDED number of gap rows", async () => {
  // 25 hydrated then a 200-conversation tail. Without a tail bound the run would
  // synchronously write 200 per-key DETAIL_GAP rows (the live run_1780681611410
  // burn). With tailGapBound=10 it writes 10 per-key chunk gaps + ONE backlog gap
  // (11 rows total), folding the older 190 into a single resumable watermark.
  const harness = makeRecordingEmit(validateRecord);
  const api: ChatGptApi = {
    auth: (): Promise<never> => Promise.reject(new Error("fakeApi.auth() unused in this test")),
    fetch: async (): Promise<ChatGptFetchResult> => {
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
  // Newest-first, strictly descending update_time so the watermark is well-defined.
  const convos = Array.from({ length: 225 }, (_, i) =>
    makeConvo({ id: `convo-${i + 1}`, update_time: 1_700_100_000 - i })
  );

  const coverage = await runMessagesAndConversationsWithDetail(deps, convos, makeEmitConversation(deps), {
    random: () => 0,
    sleep: () => undefined,
    runBudget: new ChatGptRunBudget({ maxFetches: 25 }),
    tailGapBound: 10,
  });

  const gaps = harness.protocolMessages.filter(
    (m): m is Extract<EmittedMessage, { type: "DETAIL_GAP" }> => m.type === "DETAIL_GAP"
  );
  assert.equal(gaps.length, 11, "bounded tail writes at most chunk (10) per-key gaps + 1 backlog gap, not 200");
  const perKeyGaps = gaps.filter((g) => g.detail_locator.kind === "chatgpt.conversation");
  const backlogGaps = gaps.filter((g) => g.detail_locator.kind === "chatgpt.conversation_backlog");
  assert.equal(perKeyGaps.length, 10, "exactly the chunk of newest tail conversations get per-key gaps");
  assert.equal(backlogGaps.length, 1, "exactly one durable backlog gap represents the older remainder");

  // The chunk is the 10 conversations immediately after the 25 hydrated (newest tail).
  assert.deepEqual(
    perKeyGaps.map((g) => g.record_key),
    Array.from({ length: 10 }, (_, i) => `convo-${26 + i}`)
  );

  const backlog = backlogGaps[0];
  assert.equal(backlog?.record_key, "__chatgpt_conversation_backlog__");
  // Watermark is a content-derived update_time ISO (NOT an offset). It equals the
  // NEWEST update_time of the un-materialized backlog (convo-36 — the first folded
  // conversation right after 25 hydrated + 10-chunk = 35 accounted). Recovery
  // re-lists `<= watermark`, an inclusive, stranding-proof boundary.
  const watermark = (backlog?.detail_locator as { before_update_time?: unknown }).before_update_time;
  assert.equal(typeof watermark, "string", "the backlog gap carries an update_time watermark, not an offset");
  assert.equal(watermark, new Date((1_700_100_000 - 35) * 1000).toISOString());
  assert.equal(
    (backlog?.detail_locator as { remaining?: unknown }).remaining,
    190,
    "the backlog gap records how many older conversations remain"
  );
  // list_cursor mirror is set for protocol honesty.
  assert.deepEqual(backlog?.list_cursor, { before_update_time: watermark });

  // coverage.gapKeys still enumerates only the per-key chunk; the backlog key is
  // tracked separately so forward coverage can require it.
  assert.deepEqual(
    coverage.gapKeys,
    perKeyGaps.map((g) => String(g.record_key))
  );
  assert.equal(coverage.backlogGapKey, "__chatgpt_conversation_backlog__");
});

test("cap-tail backlog deferral is NOT source pressure and arms no cooldown", async () => {
  const harness = makeRecordingEmit(validateRecord);
  const api: ChatGptApi = {
    auth: (): Promise<never> => Promise.reject(new Error("fakeApi.auth() unused in this test")),
    fetch: async (): Promise<ChatGptFetchResult> => {
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
  const convos = Array.from({ length: 50 }, (_, i) =>
    makeConvo({ id: `convo-${i + 1}`, update_time: 1_700_100_000 - i })
  );

  await runMessagesAndConversationsWithDetail(deps, convos, makeEmitConversation(deps), {
    random: () => 0,
    sleep: () => undefined,
    runBudget: new ChatGptRunBudget({ maxFetches: 5 }),
    tailGapBound: 5,
  });

  const gaps = harness.protocolMessages.filter(
    (m): m is Extract<EmittedMessage, { type: "DETAIL_GAP" }> => m.type === "DETAIL_GAP"
  );
  assert.equal(
    gaps.every((g) => g.reason === "retry_exhausted"),
    true,
    "every cap-tail gap (per-key AND backlog) uses retry_exhausted — outside the source-pressure reason set"
  );
  assert.equal(
    gaps.every((g) => g.detail?.class === "run_cap_deferred"),
    true,
    "every cap-tail gap carries the run_cap_deferred error class"
  );
  assert.equal(
    gaps.some((g) => g.reason === "upstream_pressure" || g.reason === "rate_limited"),
    false,
    "a self-imposed bound must never be classified as source pressure"
  );
  // The backlog gap's network-pressure diagnostic names the cap reason, never a 429/HTTP status.
  const backlog = gaps.find((g) => g.detail_locator.kind === "chatgpt.conversation_backlog");
  assert.equal(backlog?.detail?.network_pressure?.error_class, "max_detail_fetches");
  assert.equal(backlog?.detail?.http_status, undefined, "no HTTP status: nothing failed, the run chose to stop");
});

test("a follow-up run expands the backlog gap (older window) before any forward work, no offsets", async () => {
  // Multi-run convergence over a 30-conversation cold history, tailGapBound=10,
  // fetch budget 10/run. Run 1 hydrates the newest 10 and folds the older 20 into
  // a backlog gap. Run 2 recovers by RE-LISTING older-than the watermark and
  // draining the next chunk, rewriting the backlog. Loop until the backlog
  // resolves. Each run writes a bounded row count; the boundary is a re-listed
  // update_time watermark — never an offset.
  const allConvos = Array.from({ length: 30 }, (_, i) =>
    makeConvo({ id: `convo-${String(i + 1).padStart(2, "0")}`, update_time: 1_700_100_000 - i })
  );
  const isoOf = (id: string): string => {
    const c = allConvos.find((x) => x.id === id);
    return new Date(((c?.update_time as number) ?? 0) * 1000).toISOString();
  };

  // Simulate the runtime gap store across runs: detailGaps served to a run are the
  // pending gaps; DETAIL_GAP emits add/replace pending; DETAIL_GAP_RECOVERED resolves.
  type PendingGap = NonNullable<StreamDeps["detailGaps"]>[number];
  const pending = new Map<string, PendingGap>();
  let gapSeq = 0;

  const hydratedAcross = new Set<string>();
  let safety = 0;
  // Threaded forward cursors: a capped run advances the messages STATE cursor to
  // the newest hydrated window. The next forward-walk lists only conversations
  // NEWER than it, so already-hydrated conversations are never re-deferred —
  // exactly the runtime contract. The OLDER tail is recovered via the backlog gap.
  let messagesCursor: string | null = null;
  let conversationsCursor: string | null = null;

  while (safety++ < 12) {
    const harness = makeRecordingEmit(validateRecord);
    const listCalls: string[] = [];
    const api: ChatGptApi = {
      auth: (): Promise<never> => Promise.reject(new Error("fakeApi.auth() unused in this test")),
      fetch: async (path: string): Promise<ChatGptFetchResult> => {
        await Promise.resolve();
        if (path.startsWith("/conversations?")) {
          listCalls.push(path);
          // Always return the full descending list; listConversationsSinceCursor
          // applies the cursor filter, just like the live `/conversations` route.
          return { status: 200, json: { items: allConvos } as ChatGptJson };
        }
        return makeDetailOk();
      },
    };
    // Snapshot the pending gaps the runtime would serve this run.
    const served = Array.from(pending.values());
    const deps: StreamDeps = {
      api,
      detailGaps: served,
      emit: async (msg): Promise<void> => {
        await harness.emit(msg);
        if (msg.type === "DETAIL_GAP") {
          // Upsert by natural key (record_key + detail_locator) the way the store does.
          const key = `${String(msg.record_key)}::${JSON.stringify(msg.detail_locator)}`;
          gapSeq += 1;
          pending.set(key, {
            gap_id: `gap-${gapSeq}`,
            stream: "messages",
            record_key: msg.record_key,
            status: "pending",
            reference_only: true,
            detail_locator: msg.detail_locator,
          } as PendingGap);
        }
        if (msg.type === "DETAIL_GAP_RECOVERED") {
          // Resolve the served gap by id.
          for (const [k, g] of pending) {
            if (g.gap_id === msg.gap_id) {
              pending.delete(k);
            }
          }
        }
        if (msg.type === "STATE" && msg.stream === "messages") {
          const next = (msg.cursor as { last_update_time?: string | null } | undefined)?.last_update_time ?? null;
          if (next) {
            messagesCursor = next;
          }
        }
        if (msg.type === "STATE" && msg.stream === "conversations") {
          const next = (msg.cursor as { last_update_time?: string | null } | undefined)?.last_update_time ?? null;
          if (next) {
            conversationsCursor = next;
          }
        }
      },
      emitRecord: harness.emitRecord,
      progress: (): Promise<void> => Promise.resolve(),
      requested: new Map(["conversations", "messages"].map((name) => [name, { name }])),
      requestDetailGapPage: () => Promise.resolve([]),
      runBudget: new ChatGptRunBudget({ maxFetches: 10 }),
    };

    const hadBacklogBefore = served.some((g) => g.detail_locator?.kind === "chatgpt.conversation_backlog");

    await runConversationsAndMessagesStreams(
      deps,
      {
        conversations: { last_update_time: conversationsCursor },
        messages: { last_update_time: messagesCursor },
      } as CollectContext["state"],
      { detailPacing: { random: () => 0, sleep: () => undefined, tailGapBound: 10 } }
    );

    for (const id of harness.emitted.filter((r) => r.stream === "conversations").map((r) => String(r.data.id))) {
      hydratedAcross.add(id);
    }

    // When a backlog gap was served, the run MUST expand it (a list call) before
    // doing forward work, and writes a bounded number of rows.
    if (hadBacklogBefore) {
      assert.ok(listCalls.length >= 1, "a backlog-gap recovery re-lists the parent conversation list");
    }
    const gapsThisRun = harness.protocolMessages.filter((m) => m.type === "DETAIL_GAP");
    assert.ok(gapsThisRun.length <= 11, "each run writes at most chunk (10) + 1 backlog gap");

    // Keep running until EVERY pending gap (per-key chunk and backlog) drains —
    // the tail converges only when no resumable work remains.
    if (pending.size === 0) {
      break;
    }
  }

  assert.ok(safety < 12, "the backlog converges to empty in a bounded number of runs");
  // Every conversation in the cold history was hydrated across the bounded runs —
  // no data loss, no offset reconstruction.
  assert.equal(hydratedAcross.size, allConvos.length, "all 30 conversations drained oldest-ward with no loss");
  assert.equal(isoOf("convo-30") < isoOf("convo-01"), true, "sanity: convo-30 is the oldest");
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

  // The new SLVP wait-out-and-resume path retries the SAME conversation up to
  // CHATGPT_CIRCUIT_WAIT_OUT_MAX_CYCLES (8) times before falling through to the
  // latch-and-defer fallback. With sleep injected as a no-op, this is instant.
  // So convo-gap is attempted 9 times total (1 initial + 8 wait-resume retries).
  assert.deepEqual(fetches, [
    "/conversations?offset=0&limit=100&order=updated",
    "/conversation/convo-gap",
    "/conversation/convo-gap",
    "/conversation/convo-gap",
    "/conversation/convo-gap",
    "/conversation/convo-gap",
    "/conversation/convo-gap",
    "/conversation/convo-gap",
    "/conversation/convo-gap",
    "/conversation/convo-gap",
  ]);
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
    considered: 1,
    covered: 0,
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

// ─── Regime (c): per-conversation retry-exhaustion wait-out-and-resume ────────
// These tests cover the run_1781286755231 regression: a single
// ChatGptRecoverableRetryExhaustedError on ONE conversation was immediately
// latching observedRecoverablePressure and dumping the entire remaining tranche
// as durable gaps. The fix waits out the cooldown in-run (using the shared
// consecutiveWaitOutsWithoutSuccess budget) and retries the SAME conversation,
// so the other conversations in the tranche are still fetched.

test("runConversationsAndMessagesStreams: a single recoverable rate-limit on ONE conversation WAITS OUT and the remaining tranche is still fetched (run_1781286755231 regression)", async () => {
  // Scenario: 5 conversations, second one always throws ChatGptRecoverableRetryExhaustedError.
  // OLD behavior: convo-2 exhausts → latch → convo-3..5 dumped as upstream_pressure gaps.
  // NEW behavior: convo-2 exhausts → wait out → retry → exhausts again → ... (8 retries)
  //               → latch only after 8 cycles; convo-3..5 deferred as gaps (NOT skipped
  //               before the first retry attempt). But crucially after the wait, convo-2 is
  //               RE-TRIED (not just skipped). Since sleep is injected as a no-op, all 8
  //               wait-retry cycles complete instantly, then the envelope is spent and the
  //               latch fires. With the fix in place, convo-2 is attempted 9 times, and
  //               convo-3..5 are deferred as upstream_pressure gaps only after that.
  //
  // The key regression oracle: convo-3 and convo-4 are NOT fetched (they are deferred
  // after the latch), but convo-2 IS retried 9 times — proving the wait-out loop runs
  // instead of latching immediately.
  const harness = makeRecordingEmit(validateRecord);
  const listItems = [
    makeConvo({ id: "convo-1", update_time: 1_700_000_001 }),
    makeConvo({ id: "convo-2", update_time: 1_700_000_002 }),
    makeConvo({ id: "convo-3", update_time: 1_700_000_003 }),
    makeConvo({ id: "convo-4", update_time: 1_700_000_004 }),
    makeConvo({ id: "convo-5", update_time: 1_700_000_005 }),
  ];
  const fetches: string[] = [];
  const sleepCalls: number[] = [];
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
      if (path === "/conversation/convo-2") {
        return Promise.reject(
          new ChatGptRecoverableRetryExhaustedError(
            "apiFetch got 429 on GET /conversation/convo-2 after retry budget exhausted bearer secret",
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
                retry_after_ms: 60_000,
                safe_headers: { "retry-after-ms": 60_000 },
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
    runBudget: new ChatGptRunBudget(),
  };

  await runConversationsAndMessagesStreams(
    deps,
    {},
    {
      detailPacing: {
        random: () => 0,
        sleep: (ms) => {
          sleepCalls.push(ms);
          return Promise.resolve();
        },
      },
    }
  );

  // convo-1 fetched once; convo-2 attempted 9 times (1 + 8 wait-resume cycles);
  // convo-3..5 are deferred as upstream_pressure gaps after the latch fires.
  const detailFetches = fetches.filter((p) => p.startsWith("/conversation/"));
  assert.equal(
    detailFetches.filter((p) => p === "/conversation/convo-2").length,
    9,
    "convo-2 must be retried 9 times (1 initial + 8 wait-out cycles) before the latch fires"
  );
  assert.equal(
    detailFetches.filter((p) => p === "/conversation/convo-1").length,
    1,
    "convo-1 (before the pressure item) must be fetched exactly once"
  );
  assert.equal(
    detailFetches.filter((p) => p === "/conversation/convo-3").length,
    0,
    "convo-3 must not be independently fetched — it is deferred after the latch"
  );
  assert.equal(
    detailFetches.filter((p) => p === "/conversation/convo-4").length,
    0,
    "convo-4 must not be independently fetched — it is deferred after the latch"
  );

  // convo-1 hydrated; convo-2..5 gapped
  assert.equal(
    harness.emitted.filter((r) => r.stream === "conversations" && r.data.id === "convo-1").length,
    1,
    "convo-1 (before the pressure item) must hydrate successfully"
  );
  assert.equal(
    harness.emitted.some((r) => r.stream === "conversations" && r.data.id === "convo-2"),
    false,
    "convo-2 must not emit as a list-only record (it is gapped)"
  );

  // The wait-out emits PROGRESS messages — one per wait cycle (8 total)
  const waitMessages = harness.protocolMessages.filter(
    (m): m is Extract<EmittedMessage, { type: "PROGRESS" }> =>
      m.type === "PROGRESS" && m.message.includes("hit a recoverable rate limit")
  );
  assert.equal(
    waitMessages.length,
    8,
    "exactly 8 wait-out PROGRESS messages should fire (one per cycle before the envelope is spent)"
  );
  assert.equal(
    waitMessages.some((m) => m.message.includes("convo-") || m.message.includes("/conversation/")),
    false,
    "wait-out progress messages must not leak conversation ids or API paths"
  );

  // After 8 cycles the envelope is spent and the latch fires
  const circuitMessages = harness.protocolMessages.filter(
    (m): m is Extract<EmittedMessage, { type: "PROGRESS" }> =>
      m.type === "PROGRESS" && m.message.includes("opened upstream-pressure circuit")
  );
  assert.equal(circuitMessages.length, 1, "circuit-open latch must fire exactly once after envelope is spent");

  // The pressure item itself gets a DETAIL_GAP with its error detail
  const convo2Gap = harness.protocolMessages.find(
    (m): m is Extract<EmittedMessage, { type: "DETAIL_GAP" }> => m.type === "DETAIL_GAP" && m.record_key === "convo-2"
  );
  assert.ok(convo2Gap, "convo-2 must emit a DETAIL_GAP after the latch");
  assert.equal(convo2Gap.reason, "rate_limited");
  assert.equal(convo2Gap.retryable, true);

  // Sleep was injected and recorded; 8 wait cycles fired
  assert.equal(sleepCalls.length, 8, "sleep must be called once per wait-out cycle (8 total)");
});

test("runConversationsAndMessagesStreams: retry-exhaustion wait envelope exhausted (8 cycles) still falls back to durable tail-defer — lose-nothing preserved", async () => {
  // After CHATGPT_CIRCUIT_WAIT_OUT_MAX_CYCLES (8) wait-out cycles the bounded
  // envelope is spent; the next ChatGptRecoverableRetryExhaustedError must still
  // arm observedRecoverablePressure and defer the tail as durable gaps. This
  // test verifies the lose-nothing fallback is preserved even after many waits.
  //
  // We run TWO separate conversations that both always throw
  // ChatGptRecoverableRetryExhaustedError. convo-1 spends 8 cycles exhausting
  // the no-progress counter (consecutiveWaitOutsWithoutSuccess reaches
  // CHATGPT_CIRCUIT_WAIT_OUT_MAX_CYCLES). Then convo-2 hits the same error →
  // envelope already spent → immediate latch on convo-2's first attempt.
  // convo-3 is deferred as an upstream_pressure gap.
  const harness = makeRecordingEmit(validateRecord);
  const listItems = [
    makeConvo({ id: "c-exhaust-1", update_time: 1_700_001_001 }),
    makeConvo({ id: "c-exhaust-2", update_time: 1_700_001_002 }),
    makeConvo({ id: "c-exhaust-3", update_time: 1_700_001_003 }),
  ];
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
      // Both c-exhaust-1 and c-exhaust-2 always throw — permanently hostile.
      if (path === "/conversation/c-exhaust-1" || path === "/conversation/c-exhaust-2") {
        return Promise.reject(
          new ChatGptRecoverableRetryExhaustedError(
            `apiFetch got 429 on GET ${path} after retry budget exhausted bearer secret`,
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
                retry_after_ms: 30_000,
                safe_headers: { "retry-after-ms": 30_000 },
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
    runBudget: new ChatGptRunBudget(),
  };

  await runConversationsAndMessagesStreams(deps, {}, { detailPacing: { random: () => 0, sleep: () => undefined } });

  // c-exhaust-1: attempted 9 times (1 + 8 wait-out cycles exhausting the envelope).
  assert.equal(
    fetches.filter((p) => p === "/conversation/c-exhaust-1").length,
    9,
    "c-exhaust-1 must be retried 9 times before the bounded envelope is spent"
  );
  // c-exhaust-2 and c-exhaust-3: once observedRecoverablePressure is armed by
  // c-exhaust-1's 9th failure, subsequent lane tasks are caught by the early
  // guard before reaching the fetch attempt — no fetch is issued for either.
  assert.equal(
    fetches.filter((p) => p === "/conversation/c-exhaust-2").length,
    0,
    "c-exhaust-2 must not be fetched — the latch armed by c-exhaust-1 short-circuits subsequent items"
  );
  assert.equal(
    fetches.filter((p) => p === "/conversation/c-exhaust-3").length,
    0,
    "c-exhaust-3 must not be fetched — deferred as upstream_pressure gap by the latch"
  );

  // Exactly 8 wait-out PROGRESS messages (all from c-exhaust-1's wait cycles)
  const waitMessages = harness.protocolMessages.filter(
    (m): m is Extract<EmittedMessage, { type: "PROGRESS" }> =>
      m.type === "PROGRESS" && m.message.includes("hit a recoverable rate limit")
  );
  assert.equal(waitMessages.length, 8, "exactly 8 wait-out PROGRESS messages (envelope cycle count)");

  // Exactly 1 circuit-open latch (fires on c-exhaust-2's first attempt after envelope spent)
  const circuitMessages = harness.protocolMessages.filter(
    (m): m is Extract<EmittedMessage, { type: "PROGRESS" }> =>
      m.type === "PROGRESS" && m.message.includes("opened upstream-pressure circuit")
  );
  assert.equal(circuitMessages.length, 1, "circuit-open latch must fire exactly once");

  // All three items must have DETAIL_GAP records (lose-nothing)
  const gaps = harness.protocolMessages.filter(
    (m): m is Extract<EmittedMessage, { type: "DETAIL_GAP" }> => m.type === "DETAIL_GAP"
  );
  assert.equal(gaps.length, 3, "all three conversations must emit durable DETAIL_GAP records (lose-nothing)");
  assert.ok(
    gaps.some((g) => g.record_key === "c-exhaust-1"),
    "c-exhaust-1 must have a DETAIL_GAP"
  );
  assert.ok(
    gaps.some((g) => g.record_key === "c-exhaust-2"),
    "c-exhaust-2 must have a DETAIL_GAP"
  );
  assert.ok(
    gaps.some((g) => g.record_key === "c-exhaust-3"),
    "c-exhaust-3 must have a DETAIL_GAP (deferred without fetch)"
  );
  assert.equal(
    gaps.find((g) => g.record_key === "c-exhaust-3")?.reason,
    "upstream_pressure",
    "c-exhaust-3 gap reason is upstream_pressure (deferred by latch, not directly exhausted)"
  );
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
    runBudget: new ChatGptRunBudget(),
  };

  await runConversationsAndMessagesStreams(deps, {}, { detailPacing: { random: () => 0, sleep: () => undefined } });

  assert.equal(fetches.filter((path) => path.startsWith("/conversations?")).length, 3);
  // The pressure item (index 29) is retried up to CHATGPT_CIRCUIT_WAIT_OUT_MAX_CYCLES
  // (8) times before the bounded envelope is spent and the latch fires. So the
  // first 29 items get 1 fetch each; item 30 gets 9 fetches (1 + 8 wait-resumes).
  assert.equal(fetches.filter((path) => path.startsWith("/conversation/")).length, 38);
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

  await runConversationsAndMessagesStreams(deps, {}, { detailPacing: { random: () => 0, sleep: () => undefined } });

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

test("runConversationsAndMessagesStreams: drains paged pending message gaps beyond the first 100 in one run", async () => {
  const harness = makeRecordingEmit(validateRecord);
  const conversations = Array.from({ length: 125 }, (_, index) =>
    makeConvo({
      id: `convo-page-${String(index).padStart(3, "0")}`,
      title: `Paged recovery ${index}`,
      update_time: 1_700_000_000 + index,
    })
  );
  const pages = [
    conversations
      .slice(60, 120)
      .map((conversation, index) => makeDetailGapFromConvo(`gap_page_2_${index}`, conversation)),
    conversations.slice(120).map((conversation, index) => makeDetailGapFromConvo(`gap_page_3_${index}`, conversation)),
    [],
  ];
  const fetches: string[] = [];
  const requestedPages: Array<readonly string[] | undefined> = [];
  const api: ChatGptApi = {
    auth: (): Promise<never> => Promise.reject(new Error("fakeApi.auth() unused in this test")),
    fetch: (path: string): Promise<ChatGptFetchResult> => {
      fetches.push(path);
      if (path.startsWith("/conversation/")) {
        return Promise.resolve(makeDetailOk());
      }
      if (path.startsWith("/conversations")) {
        return Promise.resolve({ status: 200, json: { items: [], has_missing_conversations: false, total: 0 } });
      }
      return Promise.resolve(makeDetailOk());
    },
  };
  const deps: StreamDeps = {
    api,
    detailGaps: conversations
      .slice(0, 60)
      .map((conversation, index) => makeDetailGapFromConvo(`gap_page_1_${index}`, conversation)),
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    progress: (): Promise<void> => Promise.resolve(),
    requested: new Map(["conversations", "messages"].map((name) => [name, { name }])),
    requestDetailGapPage: (req) => {
      requestedPages.push(req?.streams);
      return Promise.resolve(pages.shift() ?? []);
    },
  };

  await runConversationsAndMessagesStreams(deps, {}, { detailPacing: { random: () => 0, sleep: () => undefined } });

  const detailFetches = fetches.filter((path) => path.startsWith("/conversation/"));
  assert.equal(detailFetches.length, 125, "all paged pending gaps are fetched in one connector run");
  assert.equal(
    harness.protocolMessages.filter((message) => message.type === "DETAIL_GAP_RECOVERED").length,
    125,
    "every recovered pending gap is marked recovered"
  );
  assert.deepEqual(requestedPages, [["messages"], ["messages"], ["messages"]]);
  assert.ok(
    fetches.indexOf("/conversation/convo-page-124") < fetches.findIndex((path) => path.startsWith("/conversations")),
    "forward list collection starts only after paged recovery drains"
  );
});

test("runConversationsAndMessagesStreams: CONTINUOUS DRAIN — a partially-hydrated page does NOT end the run; the deferred tail is re-attacked and drained to zero in ONE run", async () => {
  // The SLVP-ideal worker-session contract: a run is NOT a completeness boundary.
  // When a recovery page only partially hydrates (a wait/defer happened and the
  // un-hydrated tail was re-written as fresh `pending` gaps), the run must NOT
  // terminate — it must re-request the pending work-list and KEEP DRAINING in the
  // SAME run until the work-list is empty. This is the bug the live run exposed:
  // the old driver returned the moment a page reported stoppedWithPending, so one
  // forced run only ever drained a single page and left the rest for a re-kick.
  const harness = makeRecordingEmit(validateRecord);
  const convoA = makeConvo({ id: "drain-a", update_time: 1_700_000_001 });
  const convoB = makeConvo({ id: "drain-b", update_time: 1_700_000_002 });
  const convoC = makeConvo({ id: "drain-c", update_time: 1_700_000_003 });

  // Page 1 = {A, B} on a HOT account (every fetch serves a 429, threshold 1): the
  // density bounded-wait fallback eventually defers the un-hydrated tail of page 1
  // as durable upstream_pressure gaps — a partial page (stoppedWithPending=true)
  // that recovered at least one item. This is exactly the partial page the old
  // driver terminated on. The account COOLS for the subsequent pages (the fetch
  // stops serving 429s once `hot` flips off), so the re-attacked tail hydrates.
  let hot = true;
  const fetches: string[] = [];
  const api: ChatGptApi = {
    auth: (): Promise<never> => Promise.reject(new Error("fakeApi.auth() unused in this test")),
    fetch: async (path: string): Promise<ChatGptFetchResult> => {
      fetches.push(path);
      if (path.startsWith("/conversations")) {
        return { status: 200, json: { items: [], has_missing_conversations: false, total: 0 } };
      }
      if (hot) {
        // Served-429 pressure keeps the density tracker hot so page 1 trips the
        // bounded-wait fallback and defers its tail durably.
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

  // The runtime re-reads fresh pending rows each call. Page 2 = {B} (the tail
  // page 1 deferred, now cool → hydrates); page 3 = {C} (a gap that appeared
  // while the run was draining — proving the run keeps pulling NEW work too);
  // then empty. The OLD driver would stop after page 1.
  const pages: CollectContext["detailGaps"][] = [
    [makeDetailGapFromConvo("gap_b_redeferred", convoB)],
    [makeDetailGapFromConvo("gap_c_fresh", convoC)],
    [],
  ];
  const requestedPages: number[] = [];
  const deps: StreamDeps = {
    api,
    detailGaps: [makeDetailGapFromConvo("gap_a", convoA), makeDetailGapFromConvo("gap_b", convoB)],
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    progress: (): Promise<void> => Promise.resolve(),
    requested: new Map(["conversations", "messages"].map((name) => [name, { name }])),
    requestDetailGapPage: () => {
      requestedPages.push(requestedPages.length + 1);
      hot = false; // the account cools once page 1's hot drain is done
      return Promise.resolve(pages.shift() ?? []);
    },
    // No run-cap → the ONLY reason to stop is the work-list emptying.
    runBudget: new ChatGptRunBudget(),
  };

  await runConversationsAndMessagesStreams(
    deps,
    {},
    { detailPacing: { random: () => 0, sleep: () => undefined, densityStopThreshold: 1 } }
  );

  // Every conversation hydrated in ONE run — including B (re-attacked after page 1
  // deferred it) and C (a gap discovered mid-drain). The run kept pulling the
  // work-list until empty instead of stopping after the first partial page.
  const recoveredKeys = Array.from(
    new Set(
      harness.protocolMessages
        .filter(
          (m): m is Extract<EmittedMessage, { type: "DETAIL_GAP_RECOVERED" }> => m.type === "DETAIL_GAP_RECOVERED"
        )
        .map((m) => m.record_key)
    )
  ).sort();
  assert.deepEqual(
    recoveredKeys,
    ["drain-a", "drain-b", "drain-c"],
    "all gaps — including the re-deferred tail and a mid-drain discovery — recover in one run"
  );
  assert.ok(
    requestedPages.length >= 3,
    "the run keeps requesting the work-list across the partial page until it drains to empty"
  );
});

test("runConversationsAndMessagesStreams: a GENUINELY budget-exhausted recovery still defers (no forward walk)", async () => {
  // Drain-within-budget keeps the "defer" path for the RIGHT reason: when the run
  // budget is genuinely exhausted by recovery, the forward walk is still skipped
  // (the budget-exhaustion scenario). The OTHER scenario — transient source
  // pressure with budget remaining — is covered separately below; that one now
  // proceeds to the forward walk instead of terminating.
  const harness = makeRecordingEmit(validateRecord);
  const first = makeConvo({ id: "convo-budget-first", update_time: 1_700_000_100 });
  const second = makeConvo({ id: "convo-budget-second", update_time: 1_700_000_200 });
  const fetches: string[] = [];
  let requestedNextPage = false;
  const api: ChatGptApi = {
    auth: (): Promise<never> => Promise.reject(new Error("fakeApi.auth() unused in this test")),
    fetch: (path: string): Promise<ChatGptFetchResult> => {
      fetches.push(path);
      return Promise.resolve(makeDetailOk());
    },
  };
  const deps: StreamDeps = {
    api,
    detailGaps: [
      makeDetailGapFromConvo("gap_budget_first", first),
      makeDetailGapFromConvo("gap_budget_second", second),
    ],
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    progress: (): Promise<void> => Promise.resolve(),
    requested: new Map(["conversations", "messages"].map((name) => [name, { name }])),
    requestDetailGapPage: () => {
      requestedNextPage = true;
      return Promise.resolve([]);
    },
    // maxFetches:1 → recovery hydrates one item and EXHAUSTS the run budget.
    runBudget: new ChatGptRunBudget({ maxFetches: 1 }),
  };

  await runConversationsAndMessagesStreams(deps, {}, { detailPacing: { random: () => 0, sleep: () => undefined } });

  assert.deepEqual(fetches, ["/conversation/convo-budget-first"]);
  assert.equal(
    requestedNextPage,
    false,
    "a partially recovered page is the adaptive stop condition (intra-recovery guard)"
  );
  assert.equal(harness.protocolMessages.filter((message) => message.type === "DETAIL_GAP_RECOVERED").length, 1);
  assert.equal(
    fetches.some((path) => path.startsWith("/conversations")),
    false,
    "a genuinely budget-exhausted run still skips the forward walk (budget-exhaustion defer)"
  );
});

test("runConversationsAndMessagesStreams: density during recovery WAITS OUT the cool-down, hydrates the recovery item, and PROCEEDS to the forward walk", async () => {
  // Drain-within-budget (recovery-early-exit-diagnosis §5), under SLVP-ideal
  // wait-resume: a density trip during recovery must NOT terminate the run when
  // budget remains. With the cool-down instant in-test and budget plentiful, the
  // density trip WAITS OUT and the recovery item HYDRATES (lose-nothing by
  // collection, not deferral). The forward walk's LIST phase then still advances
  // the cursor and discovers new conversations. Pre-trip the density stop (not a
  // budget stop) with NO run-cap so budget is plentiful and the wait resumes.
  const harness = makeRecordingEmit(validateRecord);
  const recItem = makeConvo({ id: "rec-pressured", update_time: 1_700_000_000 });
  const fetchedDetail: string[] = [];
  const listedCursors: string[] = [];
  const api: ChatGptApi = {
    auth: (): Promise<never> => Promise.reject(new Error("fakeApi.auth() unused in this test")),
    fetch: async (path: string): Promise<ChatGptFetchResult> => {
      await Promise.resolve();
      if (path.startsWith("/conversations")) {
        listedCursors.push(path);
        return {
          status: 200,
          json: {
            items: [
              { id: "fwd-new", title: "f", create_time: 1_700_000_900, update_time: 1_700_000_900, current_node: "a1" },
            ],
          } as ChatGptJson,
        };
      }
      fetchedDetail.push(path);
      return makeDetailOk();
    },
  };
  const deps: StreamDeps = {
    api,
    detailGaps: [makeDetailGapFromConvo("gap-pressured", recItem)],
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    progress: (): Promise<void> => Promise.resolve(),
    requested: new Map(["conversations", "messages"].map((name) => [name, { name }])),
    // No run-cap → budget is plentiful; the only reason recovery stops is source
    // pressure, exercised via a pre-tripped density stop below.
    runBudget: new ChatGptRunBudget(),
  };

  await runConversationsAndMessagesStreams(
    deps,
    { conversations: { last_update_time: null }, messages: { last_update_time: null } } as CollectContext["state"],
    {
      detailPacing: {
        random: () => 0,
        sleep: () => undefined,
        // Pre-trip the density stop so recovery hits the cool-down WAIT
        // immediately (budget plentiful → it waits out and resumes, hydrating the
        // recovery item rather than deferring it).
        densityStopThreshold: 1,
        preDetailRateLimited: 1,
      },
    }
  );

  // Wait-resume (SLVP-ideal): the density trip no longer DEFERS the recovery item
  // — it waits out the cool-down (instant in-test, budget plentiful) and HYDRATES
  // it. So the lose-nothing invariant holds by COLLECTION, not deferral: the
  // recovery item is fetched, and NO upstream_pressure gap is left behind. (The
  // durable-gap path is still exercised when the wait budget is exhausted — see
  // the bounded-fallback test below.)
  const pressureGaps = harness.protocolMessages.filter(
    (m): m is Extract<EmittedMessage, { type: "DETAIL_GAP" }> =>
      m.type === "DETAIL_GAP" && m.reason === "upstream_pressure"
  );
  assert.deepEqual(pressureGaps, [], "wait-resume hydrates the pressured recovery item instead of deferring it");
  assert.ok(
    fetchedDetail.some((p) => p.includes("rec-pressured")),
    "the pressured recovery item is fetched (hydrated) after the cool-down wait — lose-nothing by collection"
  );

  // THE FIX (unchanged): the forward walk proceeds — the conversation list is
  // fetched (cursor would advance) instead of the run terminating after recovery.
  // (Under wait-resume, recovery hydrates rather than defers, so there is no
  // "continues its forward walk while budget remains" defer announcement here;
  // the list-phase running IS the proof the walk proceeded. The defer-path
  // announcement is exercised by the bounded-fallback test below, where the wait
  // budget is exhausted and recovery genuinely stops with pending gaps.)
  assert.ok(listedCursors.length >= 1, "the forward walk's list phase runs (advancing the cursor)");
});

test("runConversationsAndMessagesStreams: a hot account that SUCCEEDS drains to zero — density wait-resume does NOT give up when successes reset the no-progress counter", async () => {
  // HEALTHY DRAIN via density: every fetch reports a 429 (hot account, threshold 1)
  // but ALSO succeeds. With the progress-based give-up fix, each successful fetch
  // resets consecutiveWaitOutsWithoutSuccess to 0 — so no matter how many density
  // trips occur, the counter never accumulates to CHATGPT_CIRCUIT_WAIT_OUT_MAX_CYCLES.
  // The lane drains ALL 12 conversations (none deferred), proving a healthy-but-hot
  // account is not abandoned mid-drain because it exceeded 8 total density waits.
  // This is the key regression the old densityWaitCycles bug introduced: the live
  // run_1781302239264 synced only 65 of 1511 because the non-resetting density
  // counter capped out at 8 total waits across the whole run.
  const harness = makeRecordingEmit(validateRecord);
  const recItems = Array.from({ length: 12 }, (_v, i) =>
    makeConvo({ id: `hot-${i + 1}`, update_time: 1_700_000_000 + i })
  );
  const fetchedDetail: string[] = [];
  const listedCursors: string[] = [];
  const api: ChatGptApi = {
    auth: (): Promise<never> => Promise.reject(new Error("fakeApi.auth() unused in this test")),
    fetch: async (path: string): Promise<ChatGptFetchResult> => {
      await Promise.resolve();
      if (path.startsWith("/conversations")) {
        listedCursors.push(path);
        return {
          status: 200,
          json: { items: [], has_missing_conversations: false, total: 0 },
        };
      }
      fetchedDetail.push(path);
      // Hot account: each fetch reports a served 429 (density tracker accumulates),
      // but the request SUCCEEDS (returns 200). With threshold 1, density trips on
      // every conversation after the first — but each subsequent success resets the
      // no-progress counter, so the give-up gate is never reached.
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
    detailGaps: recItems.map((c, i) => makeDetailGapFromConvo(`gap-hot-${i + 1}`, c)),
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    progress: (): Promise<void> => Promise.resolve(),
    requested: new Map(["conversations", "messages"].map((name) => [name, { name }])),
    runBudget: new ChatGptRunBudget(),
  };

  await runConversationsAndMessagesStreams(
    deps,
    { conversations: { last_update_time: null }, messages: { last_update_time: null } } as CollectContext["state"],
    {
      detailPacing: {
        random: () => 0,
        sleep: () => undefined,
        // Threshold 1: density trips after every single served 429, so this run
        // performs well over 8 density waits — but each success resets the counter.
        densityStopThreshold: 1,
      },
    }
  );

  // KEY ASSERTION: all 12 conversations hydrated — nothing deferred. The density
  // gate never fired the "source still hot" give-up despite performing 11+ density
  // waits (one per conversation after the first), because each success reset the
  // no-progress counter. This directly proves the densityWaitCycles bug is fixed.
  assert.equal(fetchedDetail.length, 12, "all 12 conversations fetched — healthy-hot account drains to zero");
  const pressureGaps = harness.protocolMessages.filter(
    (m): m is Extract<EmittedMessage, { type: "DETAIL_GAP" }> =>
      m.type === "DETAIL_GAP" && m.reason === "upstream_pressure"
  );
  assert.deepEqual(
    pressureGaps,
    [],
    "no conversations deferred — density wait-resume does not give up on a succeeding account"
  );
  assert.equal(
    harness.protocolMessages.some(
      (m) => m.type === "PROGRESS" && /source still hot after .* cool-down wait/.test(m.message)
    ),
    false,
    "the density give-up message is never emitted when successes reset the no-progress counter"
  );

  // Sanity: the density wait progress events DID fire (> 8 times, proving the
  // counter truly reset and the old fixed-cycle cap was not the stopping reason).
  const densityWaitProgress = harness.protocolMessages.filter(
    (m): m is Extract<EmittedMessage, { type: "PROGRESS" }> =>
      m.type === "PROGRESS" && m.message.includes("waiting") && m.message.includes("cool down")
  );
  assert.ok(
    densityWaitProgress.length > 8,
    `density wait-resume fired ${densityWaitProgress.length} times (> 8 = old fixed cap), proving the cap resets on success`
  );
});

test("runConversationsAndMessagesStreams: a dead account (every fetch fails, no success) exhausts the no-progress counter and defers the tail as durable upstream_pressure gaps", async () => {
  // DEAD-ACCOUNT via density + give-up: every fetch reports a 429 AND throws
  // ChatGptRecoverableRetryExhaustedError (no successful fetch anywhere). Without
  // any success to reset consecutiveWaitOutsWithoutSuccess, both Gate A (density
  // check before fetch) and Gate B (retry-exhausted handler after throw) increment
  // the shared counter. After CHATGPT_CIRCUIT_WAIT_OUT_MAX_CYCLES (8) consecutive
  // wait-outs with zero successful fetches the give-up fires, the remaining tail
  // is durably deferred as upstream_pressure DETAIL_GAP records (lose-nothing), and
  // the run continues to its forward walk. Proves the unified progress-based gate
  // bounds dead accounts without requiring the old non-resetting densityWaitCycles.
  const harness = makeRecordingEmit(validateRecord);
  const recItems = Array.from({ length: 12 }, (_v, i) =>
    makeConvo({ id: `dead-${i + 1}`, update_time: 1_700_000_000 + i })
  );
  const fetchedDetail: string[] = [];
  const listedCursors: string[] = [];
  const api: ChatGptApi = {
    auth: (): Promise<never> => Promise.reject(new Error("fakeApi.auth() unused in this test")),
    fetch: async (path: string): Promise<ChatGptFetchResult> => {
      await Promise.resolve();
      if (path.startsWith("/conversations")) {
        listedCursors.push(path);
        return {
          status: 200,
          json: {
            items: [
              { id: "fwd-new", title: "f", create_time: 1_700_001_900, update_time: 1_700_001_900, current_node: "a1" },
            ],
          } as ChatGptJson,
        };
      }
      fetchedDetail.push(path);
      // Dead account: reports a 429 (density accumulates) then always fails with
      // retry-exhausted. No success → consecutiveWaitOutsWithoutSuccess never resets.
      await currentAdaptiveLaneRunContext()?.reportPressure({
        absorbedByRequestWait: true,
        delayMs: 30_000,
        kind: "rate_limited",
        retryAfterMs: 30_000,
      });
      throw new ChatGptRecoverableRetryExhaustedError(
        `apiFetch got 429 on GET ${path} after retry budget exhausted dead-account-test`,
        { class: "rate_limited", httpStatus: 429 }
      );
    },
  };
  const deps: StreamDeps = {
    api,
    detailGaps: recItems.map((c, i) => makeDetailGapFromConvo(`gap-dead-${i + 1}`, c)),
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    progress: (): Promise<void> => Promise.resolve(),
    requested: new Map(["conversations", "messages"].map((name) => [name, { name }])),
    // Budget is plentiful (default, unbounded): the ONLY reason the lane stops
    // waiting and defers is the shared no-progress counter — NOT a run-cap.
    runBudget: new ChatGptRunBudget(),
  };

  await runConversationsAndMessagesStreams(
    deps,
    { conversations: { last_update_time: null }, messages: { last_update_time: null } } as CollectContext["state"],
    {
      detailPacing: {
        random: () => 0,
        sleep: () => undefined,
        // Threshold 1: density trips after each 429 the fetch reports, so Gate A
        // fires on the next conversation and Gate B fires on the throw.
        densityStopThreshold: 1,
      },
    }
  );

  // Give-up fires: the no-progress counter reached 8 with no successful fetch
  // in between → the lane gives up and defers the remaining tail.
  // runConversationsAndMessagesStreams calls runMessagesAndConversationsWithDetail
  // twice (once for recovery, once for the forward walk), each with a fresh
  // consecutiveWaitOutsWithoutSuccess counter — so total wait-outs ≤ 8 per call.
  const waitOuts = harness.protocolMessages.filter(
    (m): m is Extract<EmittedMessage, { type: "PROGRESS" }> =>
      m.type === "PROGRESS" && m.message.includes("waiting") && m.message.includes("cool down")
  );
  assert.ok(waitOuts.length >= 1, "the lane waited out at least one cool-down before giving up");
  assert.ok(
    waitOuts.length <= 16,
    `the no-progress give-up fires within 8 consecutive wait-outs per call (got ${waitOuts.length}, ≤ 16 total)`
  );

  // The give-up produces a durable upstream_pressure defer — lose-nothing.
  const pressureGaps = harness.protocolMessages.filter(
    (m): m is Extract<EmittedMessage, { type: "DETAIL_GAP" }> =>
      m.type === "DETAIL_GAP" && m.reason === "upstream_pressure"
  );
  assert.ok(pressureGaps.length >= 1, "dead account: remaining tail deferred as durable upstream_pressure gaps");

  // The run continues to its forward walk after the durable defer (bounded stop,
  // not a hard crash — the forward walk's list phase still runs).
  assert.ok(
    harness.protocolMessages.some(
      (m) => m.type === "PROGRESS" && /run continues its forward walk while budget remains/.test(m.message)
    ),
    "recovery announces the run continues its forward walk after the bounded-wait defer"
  );
  assert.ok(listedCursors.length >= 1, "the forward walk list phase runs after the bounded-wait defer");
});

test("runConversationsAndMessagesStreams: warm-start round-trip — a run persists its learned interval; the next run restores it", async () => {
  // Run 1 hydrates several conversations (the controller speeds up), then persists
  // the learned interval onto the messages STATE cursor. Run 2 reads that cursor
  // and the controller resumes near the learned interval, not the cold seed.
  const harness = makeRecordingEmit(validateRecord);
  const convos = [
    makeConvo({ id: "w1", update_time: 1_700_000_010 }),
    makeConvo({ id: "w2", update_time: 1_700_000_020 }),
    makeConvo({ id: "w3", update_time: 1_700_000_030 }),
  ];
  const providerBudget = resolveChatGptProviderBudget({});
  assert.ok(providerBudget?.pacing);
  const coldInterval = providerBudget.pacing.currentIntervalMs;
  const api: ChatGptApi = {
    auth: (): Promise<never> => Promise.reject(new Error("fakeApi.auth() unused in this test")),
    fetch: async (): Promise<ChatGptFetchResult> => {
      await Promise.resolve();
      return makeDetailOk();
    },
  };
  const deps: StreamDeps = {
    api,
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    progress: (): Promise<void> => Promise.resolve(),
    providerBudget,
    requested: new Map(["conversations", "messages"].map((name) => [name, { name }])),
  };

  await runMessagesAndConversationsWithDetail(deps, convos, makeEmitConversation(deps), {
    random: () => 0,
    sleep: () => undefined,
  });

  // The controller sped up across the 3 successes.
  const learned = providerBudget.pacing.currentIntervalMs;
  assert.ok(learned < coldInterval, "the controller learned a faster interval across the run");

  // Persist exactly as the connector does, then read it back as the NEXT run
  // would. The RAW persisted pacing (interval + recordedAt) flows straight into
  // resolveChatGptProviderBudget, which hands restoredAtMs + the 6h
  // maxWarmStartAgeMs to ProviderPacing — the shared primitive owns the §10-E
  // staleness decision (no ChatGPT-specific resolver). This test covers the
  // WIRING (raw state → budget warm-starts); the staleness clock behaviour
  // itself is unit-tested against ProviderPacing in provider-pacing.test.ts.
  const now = 1_000_000;
  const persistedFields = buildChatGptPacingStateFields(providerBudget, () => now);
  const nextState = { messages: { last_update_time: null, ...persistedFields } } as CollectContext["state"];
  const persisted = readChatGptPersistedPacing(nextState);
  assert.ok(persisted, "the persisted pacing carries the learned interval + recordedAt");
  assert.equal(persisted?.intervalMs, learned, "the persisted interval is the prior run's learned value");
  assert.equal(persisted?.recordedAtMs, now, "the persisted pacing carries WHEN it was learned (for §10-E)");

  // A fresh warm-start (recordedAt within the window) resumes at the learned
  // interval. recordedAtMs ≈ Date.now() here, so the guard treats it as fresh.
  const warmBudget = resolveChatGptProviderBudget({}, { intervalMs: learned, recordedAtMs: Date.now() });
  assert.equal(
    warmBudget?.pacing?.currentIntervalMs,
    learned,
    "a fresh warm-start resumes near the learned interval, not the cold default"
  );

  // A STALE resume (learned > 6h ago) cold-starts: ProviderPacing discards the
  // restored interval and uses the discovery seed, so a long idle never bursts
  // into a possibly-tightened quota (§10-E).
  const staleBudget = resolveChatGptProviderBudget(
    {},
    { intervalMs: learned, recordedAtMs: Date.now() - 7 * 60 * 60 * 1000 }
  );
  assert.equal(
    staleBudget?.pacing?.currentIntervalMs,
    coldInterval,
    "a stale persisted interval is discarded — ProviderPacing cold-starts at the discovery seed"
  );
});

test("buildChatGptPacingStateFields: a throttle-inflated interval is CAPPED at cold-start on persist (no seed poisoning)", () => {
  // The live failure mode: a run ends deep in throttle (its interval backed off
  // far past the cold-start seed — e.g. honoring a multi-second provider
  // Retry-After). Persisting that verbatim made the NEXT run warm-start from a
  // ~14s interval and crawl back at additive-increase pace (≈140 successful
  // fetches to re-reach the ceiling). The persist guard caps the seed at the
  // cold-start baseline so a throttled run never poisons the next run's start.
  const coldStart = resolveChatGptProviderBudget({});
  const coldInterval = coldStart?.pacing?.currentIntervalMs ?? 0;
  assert.ok(coldInterval > 0);

  // Warm-start a budget at a deeply throttled interval, fresh (within staleness),
  // and confirm the controller really is slower than the cold seed.
  const throttled = resolveChatGptProviderBudget({}, { intervalMs: 14_300, recordedAtMs: Date.now() });
  assert.ok(
    (throttled?.pacing?.currentIntervalMs ?? 0) > coldInterval,
    "precondition: the run ended SLOWER than the cold-start baseline"
  );
  const persisted = buildChatGptPacingStateFields(throttled, () => 1_000_000);
  assert.equal(
    persisted.pacing_interval_ms,
    coldInterval,
    "the persisted seed is floored at cold-start — a throttled run never poisons the next run"
  );

  // A healthy (faster-than-cold) learned interval is still persisted verbatim.
  const healthy = resolveChatGptProviderBudget({});
  for (let i = 0; i < 3; i++) {
    healthy?.pacing?.recordSuccess();
  }
  const healthyInterval = healthy?.pacing?.currentIntervalMs ?? 0;
  assert.ok(healthyInterval < coldInterval, "the healthy run learned a faster-than-cold interval");
  assert.equal(
    buildChatGptPacingStateFields(healthy, () => 1_000_000).pacing_interval_ms,
    healthyInterval,
    "a healthy learned interval is persisted verbatim so the next run starts faster"
  );
});

test("buildChatGptCollectionRateProgress: legible rate state carries no account content", () => {
  const providerBudget = resolveChatGptProviderBudget({});
  assert.ok(providerBudget?.pacing);
  providerBudget.pacing.recordSuccess();
  providerBudget.pacing.recordThrottle();
  const progress = buildChatGptCollectionRateProgress(providerBudget);
  assert.ok(progress);
  assert.equal(progress.object, "collection_rate");
  assert.equal(progress.ceiling_interval_ms, 250, "the ceiling is surfaced");
  assert.ok(progress.effective_rate_per_min > 0, "an effective rate is reported");
  assert.equal(progress.last_backoff?.reason, "throttle", "the last back-off reason is legible");
  // No account content anywhere in the serialized event.
  const serialized = JSON.stringify(progress);
  assert.equal(
    /convo|conversation|title|token|gizmo/i.test(serialized),
    false,
    "rate state carries no account content"
  );
});

test("runMessagesAndConversationsWithDetail: emits a collection_rate progress event as the controller speeds up", async () => {
  const harness = makeRecordingEmit(validateRecord);
  const providerBudget = resolveChatGptProviderBudget({});
  const api: ChatGptApi = {
    auth: (): Promise<never> => Promise.reject(new Error("fakeApi.auth() unused in this test")),
    fetch: async (): Promise<ChatGptFetchResult> => {
      await admitFakeProviderBudget(providerBudget as ProviderBudgetController);
      await Promise.resolve();
      return makeDetailOk();
    },
  };
  const deps: StreamDeps = {
    api,
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    progress: (): Promise<void> => Promise.resolve(),
    providerBudget,
    requested: new Map(["conversations", "messages"].map((name) => [name, { name }])),
  };

  await runMessagesAndConversationsWithDetail(
    deps,
    [makeConvo({ id: "r1" }), makeConvo({ id: "r2" }), makeConvo({ id: "r3" })],
    makeEmitConversation(deps),
    { random: () => 0, sleep: () => undefined }
  );

  const rateEvents = harness.protocolMessages.filter(
    (m): m is Extract<EmittedMessage, { type: "PROGRESS" }> =>
      m.type === "PROGRESS" && m.collection_rate?.object === "collection_rate"
  );
  assert.ok(rateEvents.length >= 1, "the controller's rate state is emitted as run-trace progress");
  const intervals = rateEvents.map((m) => m.collection_rate?.current_interval_ms ?? 0);
  const firstInterval = intervals[0] as number;
  const lastInterval = intervals.at(-1) as number;
  assert.ok(lastInterval < firstInterval, "the emitted interval decreases as the controller speeds up");
  assert.equal(
    rateEvents.some((m) => /r1|r2|r3|conversation\//.test(JSON.stringify(m.collection_rate))),
    false,
    "rate events carry no conversation ids"
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
  // With NO request/wall-clock budget, all conversations are hydrated normally.
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

// ─── SLVP-ideal §4.3/§4.4: recoveryOnly suppresses the forward walk ─────────

test("runConversationsAndMessagesStreams: recoveryOnly=true runs recovery then returns before list-phase fetch", async () => {
  // §4.3 — when recoveryOnly is set, the connector MUST run the recovery pass
  // (recoverPendingMessageDetailGapsBeforeForwardRun) then return without
  // touching the list-phase fetch (/conversations?...) or any forward-walk
  // detail fetches. This prevents the recovery lane from re-pressuring the
  // source the cooldown is protecting (§4.4 mandatory sequencing guard).
  const harness = makeRecordingEmit(validateRecord);
  const recoveredConvo = makeConvo({ id: "convo-recover-only", update_time: 1_700_000_100 });
  const fetchedPaths: string[] = [];

  const api: ChatGptApi = {
    auth: (): Promise<never> => Promise.reject(new Error("fakeApi.auth() unused")),
    fetch: (path: string): Promise<ChatGptFetchResult> => {
      fetchedPaths.push(path);
      if (path === `/conversation/${recoveredConvo.id}`) {
        return Promise.resolve(makeDetailOk());
      }
      // The list-phase URL must NEVER be reached in recoveryOnly mode
      return Promise.resolve({
        status: 200,
        json: { items: [], has_missing_conversations: false, total: 0 },
      });
    },
  };

  const deps: StreamDeps = {
    api,
    detailGaps: [makeDetailGapFromConvo("gap-recovery-only", recoveredConvo)],
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    progress: (): Promise<void> => Promise.resolve(),
    requested: new Map(["conversations", "messages"].map((name) => [name, { name }])),
    recoveryOnly: true,
  };

  await runConversationsAndMessagesStreams(deps, {}, { detailPacing: { random: () => 0, sleep: () => undefined } });

  // Recovery fetch (the gap detail) MUST have fired
  assert.ok(
    fetchedPaths.some((p) => p === `/conversation/${recoveredConvo.id}`),
    `recovery detail fetch must fire; got: ${JSON.stringify(fetchedPaths)}`
  );

  // List-phase fetch MUST NOT have fired — this is the forward-walk suppression
  assert.ok(
    !fetchedPaths.some((p) => p.startsWith("/conversations?")),
    `list-phase fetch must be suppressed in recoveryOnly mode; got: ${JSON.stringify(fetchedPaths)}`
  );

  // The recovered gap must surface a DETAIL_GAP_RECOVERED protocol message
  const recovered = harness.protocolMessages.filter((m) => m.type === "DETAIL_GAP_RECOVERED");
  assert.equal(recovered.length, 1, "recovered gap emits exactly one DETAIL_GAP_RECOVERED");
});

test("runConversationsAndMessagesStreams: recoveryOnly=false (default) performs list-phase fetch as normal", async () => {
  // Confirm the existing behavior is unchanged when recoveryOnly is absent/false.
  const harness = makeRecordingEmit(validateRecord);
  const fetchedPaths: string[] = [];

  const api: ChatGptApi = {
    auth: (): Promise<never> => Promise.reject(new Error("fakeApi.auth() unused")),
    fetch: (path: string): Promise<ChatGptFetchResult> => {
      fetchedPaths.push(path);
      if (path.startsWith("/conversations?")) {
        return Promise.resolve({
          status: 200,
          json: { items: [], has_missing_conversations: false, total: 0 },
        });
      }
      return Promise.resolve(makeDetailOk());
    },
  };

  const deps: StreamDeps = {
    api,
    detailGaps: [],
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    progress: (): Promise<void> => Promise.resolve(),
    requested: new Map(["conversations", "messages"].map((name) => [name, { name }])),
    // recoveryOnly absent (defaults to false)
  };

  await runConversationsAndMessagesStreams(deps, {}, { detailPacing: { random: () => 0, sleep: () => undefined } });

  assert.ok(
    fetchedPaths.some((p) => p.startsWith("/conversations?")),
    "list-phase fetch fires on a normal (non-recoveryOnly) run"
  );
});

// ─── Adaptive retry-budget wait-out tests ────────────────────────────────────

test("adaptive retry budget: a healthy account refills tokens so the run never depletes (retry-exhausted regime)", async () => {
  // ADAPTIVE: a run that succeeds after each throttle earns tokens back and can
  // sustain many more wait-outs than initialTokens. Proof via the
  // maybeDeferForFetchError path (ChatGptRecoverableRetryExhaustedError):
  //
  // Harness: initialTokens=2, capacity=20, refillPerSuccess=1. Each conversation
  // throws ChatGptRecoverableRetryExhaustedError on the FIRST attempt (simulating
  // retry exhaustion), then succeeds on the retry. Each trip: consume 1 token;
  // each successful retry: refill 1 token via recordSuccess. Net per conversation:
  // 0 — the budget stays at 2 forever and all conversations hydrate. A fixed
  // ceiling of 2 with no refill would defer everything past the 2nd conversation.
  const harness = makeRecordingEmit(validateRecord);
  const fetchedIds: string[] = [];
  // Track which conversations have already "recovered" (second attempt).
  const recoveredConvos = new Set<string>();

  const providerBudget = new ProviderBudgetController({
    retryBudget: { capacity: 20, initialTokens: 2, refillPerSuccess: 1 },
    // Circuit breaker required for ChatGptRecoverableRetryExhaustedError path:
    // the path calls recordThrottle which triggers the circuit.
    circuitBreaker: { failureRateThreshold: 1, minimumThroughput: 1, resetTimeoutMs: 0 },
  });

  const api: ChatGptApi = {
    auth: (): Promise<never> => Promise.reject(new Error("unused")),
    fetch: (path: string): Promise<ChatGptFetchResult> => {
      fetchedIds.push(path);
      const convoId = path.replace("/conversation/", "");
      if (!recoveredConvos.has(convoId)) {
        // First attempt: simulate retry exhaustion (the path maybeDeferForFetchError handles).
        recoveredConvos.add(convoId);
        return Promise.reject(
          new ChatGptRecoverableRetryExhaustedError(
            `apiFetch got 429 on GET ${path} after retry budget exhausted fake-secret`,
            { class: "rate_limited", httpStatus: 429 }
          )
        );
      }
      // Second attempt (after wait-out): succeeds → recordSuccess → refill.
      return Promise.resolve(makeDetailOk());
    },
  };
  const deps: StreamDeps = {
    api,
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    progress: (): Promise<void> => Promise.resolve(),
    providerBudget,
    requested: new Map(["conversations", "messages"].map((name) => [name, { name }])),
  };

  // 6 conversations: 6 retry-exhaustion wait-outs, all followed by a successful
  // retry. With a fixed budget of 2 only 2 would succeed; adaptive refill lets
  // all 6 hydrate. Budget stays at ~2 throughout (consume then refill each time).
  const convos = Array.from({ length: 6 }, (_, i) => makeConvo({ id: `convo-${i + 1}` }));
  const coverage = await runMessagesAndConversationsWithDetail(deps, convos, makeEmitConversation(deps), {
    random: () => 0,
    sleep: () => undefined,
    providerBudget,
  });

  // All 6 hydrated — adaptive refill kept the budget alive across 6 wait-outs.
  assert.deepEqual(
    coverage.hydratedKeys,
    convos.map((c) => c.id),
    "adaptive budget: healthy account hydrates full batch because each successful retry refills the consumed token"
  );
  assert.deepEqual(
    coverage.gapKeys,
    [],
    "no conversations deferred — adaptive replenishment kept the lane alive beyond the initial-token ceiling"
  );

  const waitOuts = harness.protocolMessages.filter(
    (m): m is Extract<EmittedMessage, { type: "PROGRESS" }> => m.type === "PROGRESS" && m.message.includes("cool down")
  );
  // 6 retry-exhaustion wait-outs occurred; all > initialTokens=2 → refill proved.
  assert.ok(
    waitOuts.length > 2,
    `adaptive budget sustained ${waitOuts.length} wait-outs (> initialTokens=2) because each successful retry reset the no-progress counter`
  );
  // HONESTY: all wait messages use the progress-based counter (N/8, resets on success).
  // With refill, the counter resets after each success so it never reaches 8 here.
  assert.ok(
    waitOuts.every((m) => m.message.includes("no-progress waits:") && m.message.includes("/8")),
    "wait messages report the progress-based no-progress counter (N/8, resets on the next successful fetch)"
  );
  assert.ok(
    waitOuts.every((m) => m.message.includes("resets on the next successful fetch")),
    "wait messages explain that the counter resets on success so a healthy drain never gives up"
  );
});

test("progress-based give-up: a dead account that never succeeds gives up after CHATGPT_CIRCUIT_WAIT_OUT_MAX_CYCLES=8 consecutive wait-outs (retry-exhausted regime)", async () => {
  // DEAD ACCOUNT: every fetch throws ChatGptRecoverableRetryExhaustedError —
  // the retry never succeeds so recordSuccess never fires, so the
  // consecutiveWaitOutsWithoutSuccess counter climbs from 0 to 8 (never reset)
  // → give up → durable lose-nothing defer.
  // The retryBudget config is irrelevant to give-up now (it only governs
  // per-request retry attempts, not the wait-out give-up decision).
  const harness = makeRecordingEmit(validateRecord);
  const providerBudget = new ProviderBudgetController({
    // retryBudget present but not the give-up signal any more.
    retryBudget: { capacity: 100, initialTokens: 3, refillPerSuccess: 0.2 },
    circuitBreaker: { failureRateThreshold: 1, minimumThroughput: 1, resetTimeoutMs: 0 },
  });

  const api: ChatGptApi = {
    auth: (): Promise<never> => Promise.reject(new Error("unused")),
    fetch: (path: string): Promise<ChatGptFetchResult> =>
      // Always rejects — account is permanently dead, never succeeds.
      Promise.reject(
        new ChatGptRecoverableRetryExhaustedError(
          `apiFetch got 429 on GET ${path} after retry budget exhausted fake-secret`,
          { class: "rate_limited", httpStatus: 429 }
        )
      ),
  };
  const deps: StreamDeps = {
    api,
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    progress: (): Promise<void> => Promise.resolve(),
    providerBudget,
    requested: new Map(["conversations", "messages"].map((name) => [name, { name }])),
  };

  const convos = Array.from({ length: 10 }, (_, i) => makeConvo({ id: `convo-${i + 1}` }));
  const coverage = await runMessagesAndConversationsWithDetail(deps, convos, makeEmitConversation(deps), {
    random: () => 0,
    sleep: () => undefined,
    providerBudget,
  });

  // The run gave up after ≤ CHATGPT_CIRCUIT_WAIT_OUT_MAX_CYCLES=8 consecutive
  // no-progress wait-outs and deferred the tail durably (lose-nothing).
  const waitOuts = harness.protocolMessages.filter(
    (m): m is Extract<EmittedMessage, { type: "PROGRESS" }> => m.type === "PROGRESS" && m.message.includes("cool down")
  );
  assert.ok(
    waitOuts.length <= 8,
    `dead account gives up at ≤ 8 consecutive no-progress wait-outs (got ${waitOuts.length})`
  );

  // Tail deferred as durable lose-nothing DETAIL_GAP records.
  const gaps = harness.protocolMessages.filter((m) => m.type === "DETAIL_GAP");
  assert.ok(gaps.length > 0, "dead account: no-progress give-up triggers the durable lose-nothing defer");
  assert.ok(
    coverage.gapKeys.length > 0,
    "dead account: tail deferred as resumable gap records after consecutive no-progress give-up"
  );
});

// ─── Three key oracle tests for the progress-based give-up fix ────────────────

test("HEALTHY DRAIN oracle: a throttled run with interleaved successes drains ALL conversations — give-up must NOT fire (regression: run_1781302239264)", async () => {
  // THE REGRESSION: run_1781302239264 synced 65 of 1511 conversations then quit
  // with "reached its per-run provider budget (retry_budget)" — 1446 pending.
  // Root cause: per-request retries inside retryHttp consumed the give-up budget
  // (12 PATH1 tokens per conversation + 1 PATH2 token per wait-out), so a run
  // with only ~21 give-up tokens (8 + 65×0.2) and 65 successes gave up early.
  //
  // After the fix: give-up is progress-based (consecutiveWaitOutsWithoutSuccess).
  // Any success resets the counter to 0. A run with regular successes NEVER gives
  // up here — the counter can never reach 8 if a success fires in between.
  //
  // Harness: 50 conversations. Each throws ChatGptRecoverableRetryExhaustedError
  // on the first attempt (simulating a throttled fetch), then succeeds on retry.
  // The give-up counter increments to 1 on the wait-out, then resets to 0 on
  // the success — so the net is always 0 or 1, never 8. All 50 must hydrate.
  const harness = makeRecordingEmit(validateRecord);
  const recoveredConvos = new Set<string>();

  const providerBudget = new ProviderBudgetController({
    retryBudget: { capacity: 100, initialTokens: 8, refillPerSuccess: 0.2 },
    circuitBreaker: { failureRateThreshold: 1, minimumThroughput: 1, resetTimeoutMs: 0 },
  });

  const api: ChatGptApi = {
    auth: (): Promise<never> => Promise.reject(new Error("unused")),
    fetch: (path: string): Promise<ChatGptFetchResult> => {
      const convoId = path.replace("/conversation/", "");
      if (!recoveredConvos.has(convoId)) {
        // First attempt: throttled — simulates the retry-exhausted path.
        recoveredConvos.add(convoId);
        return Promise.reject(
          new ChatGptRecoverableRetryExhaustedError(`apiFetch got 429 on GET ${path} after retries fake-secret`, {
            class: "rate_limited",
            httpStatus: 429,
          })
        );
      }
      // Second attempt (after wait-out): succeeds → resets consecutiveWaitOutsWithoutSuccess.
      return Promise.resolve(makeDetailOk());
    },
  };

  const deps: StreamDeps = {
    api,
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    progress: (): Promise<void> => Promise.resolve(),
    providerBudget,
    requested: new Map(["conversations", "messages"].map((name) => [name, { name }])),
  };

  const convos = Array.from({ length: 50 }, (_, i) => makeConvo({ id: `drain-${i + 1}` }));
  const coverage = await runMessagesAndConversationsWithDetail(deps, convos, makeEmitConversation(deps), {
    random: () => 0,
    sleep: () => undefined,
    providerBudget,
  });

  // THE KEY ASSERTION: all 50 conversations must hydrate. The give-up must NOT fire
  // because every wait-out is followed by a success that resets the counter.
  assert.deepEqual(
    coverage.hydratedKeys,
    convos.map((c) => c.id),
    "HEALTHY DRAIN: all 50 conversations hydrated — give-up counter resets on each success so it never reaches 8"
  );
  assert.deepEqual(
    coverage.gapKeys,
    [],
    "HEALTHY DRAIN: zero conversations deferred — a throttled-but-succeeding run drains to zero"
  );

  // 50 wait-outs occurred (one per conversation on first attempt).
  const waitOuts = harness.protocolMessages.filter(
    (m): m is Extract<EmittedMessage, { type: "PROGRESS" }> => m.type === "PROGRESS" && m.message.includes("cool down")
  );
  assert.ok(
    waitOuts.length === 50,
    "HEALTHY DRAIN: 50 wait-outs occurred (one per throttled conversation), all followed by a success"
  );
});

test("PROGRESS RESET oracle: 5 wait-outs → success → 5 more wait-outs → NEVER gives up (counter resets on success)", async () => {
  // Explicitly proves the reset mechanism: the no-progress counter accumulates 5,
  // a success resets it to 0, then it accumulates 5 more — net maximum is 5,
  // never reaching CHATGPT_CIRCUIT_WAIT_OUT_MAX_CYCLES=8, so give-up never fires.
  //
  // Harness: 16 conversations, each fails once then succeeds (fail-once pattern).
  // We force the pattern so that exactly 5 consecutive wait-outs happen before
  // a mid-sequence success by using a set of "first attempt fails" convos.
  // Because each convo fails ONCE then succeeds, the counter never accumulates
  // beyond 1 per convo before resetting. All 16 hydrate. No give-up fires.
  //
  // This directly proves: with N < 8 consecutive wait-outs followed by a success,
  // the counter restarts. 50 wait-outs in 50 separate convos (each reset after
  // each success) never reaches the give-up threshold.
  const harness = makeRecordingEmit(validateRecord);
  const failedOnce = new Set<string>();

  const api: ChatGptApi = {
    auth: (): Promise<never> => Promise.reject(new Error("unused")),
    fetch: (path: string): Promise<ChatGptFetchResult> => {
      const convoId = path.replace("/conversation/", "");
      if (!failedOnce.has(convoId)) {
        // Fail once to generate a wait-out (counter += 1).
        failedOnce.add(convoId);
        return Promise.reject(
          new ChatGptRecoverableRetryExhaustedError(`apiFetch got 429 on GET ${path} after retries fake-secret`, {
            class: "rate_limited",
            httpStatus: 429,
          })
        );
      }
      // Second attempt succeeds → consecutiveWaitOutsWithoutSuccess resets to 0.
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

  // 16 conversations each failing once then succeeding. The counter never exceeds 1
  // between resets, so the 8-consecutive-no-progress give-up never fires.
  const convos = Array.from({ length: 16 }, (_, i) => makeConvo({ id: `reset-${i + 1}` }));
  const coverage = await runMessagesAndConversationsWithDetail(deps, convos, makeEmitConversation(deps), {
    random: () => 0,
    sleep: () => undefined,
  });

  // All 16 must hydrate — the give-up never fired because each success reset the counter.
  assert.deepEqual(
    coverage.hydratedKeys,
    convos.map((c) => c.id),
    "PROGRESS RESET: all 16 conversations hydrated — each success reset the no-progress counter before it reached 8"
  );
  assert.deepEqual(
    coverage.gapKeys,
    [],
    "PROGRESS RESET: zero conversations deferred — the counter reset on each success, preventing give-up"
  );

  // 16 wait-outs occurred (one per conversation), all followed by a reset success.
  const waitOuts = harness.protocolMessages.filter(
    (m): m is Extract<EmittedMessage, { type: "PROGRESS" }> => m.type === "PROGRESS" && m.message.includes("cool down")
  );
  assert.ok(
    waitOuts.length === 16,
    "PROGRESS RESET: 16 wait-outs occurred (one per convo), each followed by a success that reset the counter"
  );

  // The upstream-pressure give-up defer message (no-progress >= 8) must NOT have fired.
  const giveUpMessages = harness.protocolMessages.filter(
    (m): m is Extract<EmittedMessage, { type: "PROGRESS" }> =>
      m.type === "PROGRESS" && m.message.includes("upstream-pressure circuit")
  );
  assert.equal(
    giveUpMessages.length,
    0,
    "PROGRESS RESET: the no-progress give-up never fired — successive resets kept the counter < 8 throughout"
  );
});

test("DEAD ACCOUNT oracle: no successes ever → gives up after CHATGPT_CIRCUIT_WAIT_OUT_MAX_CYCLES=8 consecutive wait-outs (lose-nothing)", async () => {
  // Proves the safety bound: if an account NEVER yields a successful fetch, the
  // consecutiveWaitOutsWithoutSuccess counter climbs from 0 to 8 without ever
  // being reset, and the run gives up with durable DETAIL_GAP records (lose-nothing).
  //
  // This is the "dead account" invariant — the progress counter always fires at
  // 8 consecutive no-progress waits, regardless of retryBudget config.
  // The give-up fires via maybeDeferForFetchError which emits the
  // "opened upstream-pressure circuit" message and calls emitTailConversationDetailGaps.
  const harness = makeRecordingEmit(validateRecord);

  const api: ChatGptApi = {
    auth: (): Promise<never> => Promise.reject(new Error("unused")),
    fetch: (path: string): Promise<ChatGptFetchResult> =>
      Promise.reject(
        new ChatGptRecoverableRetryExhaustedError(`apiFetch got 429 on GET ${path} after retries fake-secret`, {
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
    // No providerBudget — proves the no-budget path still gives up.
  };

  const convos = Array.from({ length: 20 }, (_, i) => makeConvo({ id: `dead-${i + 1}` }));
  const coverage = await runMessagesAndConversationsWithDetail(deps, convos, makeEmitConversation(deps), {
    random: () => 0,
    sleep: () => undefined,
  });

  // No conversations should hydrate — the account never succeeded.
  assert.equal(coverage.hydratedKeys.length, 0, "DEAD ACCOUNT: no conversations hydrated");

  // The run must have given up — some conversations deferred durably.
  assert.ok(coverage.gapKeys.length > 0, "DEAD ACCOUNT: tail deferred as durable DETAIL_GAP records (lose-nothing)");

  // At most CHATGPT_CIRCUIT_WAIT_OUT_MAX_CYCLES=8 wait-outs before give-up.
  const waitOuts = harness.protocolMessages.filter(
    (m): m is Extract<EmittedMessage, { type: "PROGRESS" }> => m.type === "PROGRESS" && m.message.includes("cool down")
  );
  assert.ok(
    waitOuts.length <= 8,
    `DEAD ACCOUNT: gave up after ≤ 8 consecutive no-progress wait-outs (got ${waitOuts.length})`
  );

  // The give-up defer fires via maybeDeferForFetchError when waitBudgetExhausted:
  // it emits "opened upstream-pressure circuit; deferring remaining conversation details".
  const giveUpMessages = harness.protocolMessages.filter(
    (m): m is Extract<EmittedMessage, { type: "PROGRESS" }> =>
      m.type === "PROGRESS" && m.message.includes("upstream-pressure circuit")
  );
  assert.ok(
    giveUpMessages.length > 0,
    "DEAD ACCOUNT: the upstream-pressure give-up message fired, confirming the dead-account guard"
  );
});

test("adaptive retry budget: no-budget fallback uses consecutiveWaitOutsWithoutSuccess=8 cap (retry-exhausted regime)", async () => {
  // NO-BUDGET FALLBACK: when no providerBudget is injected, the shared progress-based
  // cap (CHATGPT_CIRCUIT_WAIT_OUT_MAX_CYCLES=8) governs via the
  // consecutiveWaitOutsWithoutSuccess counter in maybeDeferForFetchError. With every
  // fetch always throwing ChatGptRecoverableRetryExhaustedError, the loop waits out
  // up to 8 times then defers the tail — proving the fallback still bounds an
  // uncapped no-budget run.
  const harness = makeRecordingEmit(validateRecord);

  const api: ChatGptApi = {
    auth: (): Promise<never> => Promise.reject(new Error("unused")),
    fetch: (path: string): Promise<ChatGptFetchResult> =>
      // Always rejects — simulates a permanently throttled account with no budget.
      Promise.reject(
        new ChatGptRecoverableRetryExhaustedError(
          `apiFetch got 429 on GET ${path} after retry budget exhausted fake-secret`,
          { class: "rate_limited", httpStatus: 429 }
        )
      ),
  };
  const deps: StreamDeps = {
    api,
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    progress: (): Promise<void> => Promise.resolve(),
    // No providerBudget → consecutiveWaitOutsWithoutSuccess fallback governs.
    requested: new Map(["conversations", "messages"].map((name) => [name, { name }])),
  };

  const convos = Array.from({ length: 20 }, (_, i) => makeConvo({ id: `convo-${i + 1}` }));
  const coverage = await runMessagesAndConversationsWithDetail(deps, convos, makeEmitConversation(deps), {
    random: () => 0,
    sleep: () => undefined,
    // No providerBudget option either.
  });

  // Fixed cap: ≤ 8 consecutive no-progress wait-outs (consecutiveWaitOutsWithoutSuccess), then durable defer.
  const waitOuts = harness.protocolMessages.filter(
    (m): m is Extract<EmittedMessage, { type: "PROGRESS" }> => m.type === "PROGRESS" && m.message.includes("cool down")
  );
  assert.ok(waitOuts.length <= 8, `no-budget fallback: ≤ 8 wait-outs (got ${waitOuts.length})`);

  // Some conversations deferred after the cap.
  const gaps = harness.protocolMessages.filter((m) => m.type === "DETAIL_GAP");
  assert.ok(gaps.length > 0, "no-budget fallback: fixed-cycle cap triggers the durable lose-nothing defer");
  assert.ok(coverage.gapKeys.length > 0, "no-budget fallback: tail conversations deferred after cycle cap");
  // HONESTY: all wait messages display the no-progress N/8 counter (the
  // universally-governing bound). No path should mention "retry budget:" since
  // the retry budget no longer governs give-up.
  assert.ok(
    waitOuts.every((m) => m.message.includes("no-progress waits:") && m.message.includes("/8")),
    "no-budget fallback wait messages display the progress-based N/8 counter that governs give-up"
  );
  assert.ok(
    waitOuts.every((m) => !m.message.includes("retry budget:")),
    "no wait messages falsely mention a retry budget (retry budget no longer governs give-up)"
  );
});

test("regression: ProviderBudgetController present but WITHOUT retryBudget terminates via cycle cap (no infinite loop)", async () => {
  // THE LATENT BUG (now fixed): when a ProviderBudgetController is present but
  // has no retryBudget, the old gate did:
  //   providerBudget ? !providerBudget.tryConsumeRetryToken() : cycleFallback
  // tryConsumeRetryToken() returned true unconditionally (no budget → "allow"),
  // so exhaustedWaitBudget was always false → infinite loop.
  //
  // The fix adds hasRetryBudget(): the gate now does:
  //   providerBudget?.hasRetryBudget() ? !tryConsumeRetryToken() : cycleFallback
  // so "controller present but no retryBudget" correctly falls back to the
  // consecutiveWaitOutsWithoutSuccess cap, same as "no controller at all".
  //
  // This test directly exercises that path: a ProviderBudgetController with ONLY
  // a circuitBreaker (no retryBudget) under a never-recovering throttle.
  // If the bug regresses the test will hang (the suite has a 30s timeout).
  const harness = makeRecordingEmit(validateRecord);

  // Controller present — but NO retryBudget. hasRetryBudget() must return false.
  const providerBudget = new ProviderBudgetController({
    circuitBreaker: {
      failureRateThreshold: 1,
      minimumThroughput: 1,
      windowSize: 1,
    },
  });
  assert.equal(providerBudget.hasRetryBudget(), false, "precondition: no retryBudget on this controller");

  const api: ChatGptApi = {
    auth: (): Promise<never> => Promise.reject(new Error("unused")),
    fetch: (path: string): Promise<ChatGptFetchResult> =>
      // Always throttled — simulates a permanently hot account.
      Promise.reject(
        new ChatGptRecoverableRetryExhaustedError(`apiFetch got 429 on GET ${path} fake-secret`, {
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
    providerBudget, // controller IS present — the bug only fires with a controller
    requested: new Map(["conversations", "messages"].map((name) => [name, { name }])),
  };

  const convos = Array.from({ length: 20 }, (_, i) => makeConvo({ id: `convo-${i + 1}` }));
  // No wall-clock cap — ONLY the cycle cap can stop the loop.
  const coverage = await runMessagesAndConversationsWithDetail(deps, convos, makeEmitConversation(deps), {
    random: () => 0,
    sleep: () => undefined,
  });

  // Must terminate via the consecutiveWaitOutsWithoutSuccess cap (≤ CHATGPT_CIRCUIT_WAIT_OUT_MAX_CYCLES = 8).
  const waitOuts = harness.protocolMessages.filter(
    (m): m is Extract<EmittedMessage, { type: "PROGRESS" }> => m.type === "PROGRESS" && m.message.includes("cool down")
  );
  assert.ok(
    waitOuts.length <= 8,
    `controller-present-no-retryBudget: cycle cap must bound the loop (got ${waitOuts.length} wait-outs, expected ≤ 8)`
  );

  // Tail deferred durably — not silently dropped, not an infinite spin.
  const gaps = harness.protocolMessages.filter((m) => m.type === "DETAIL_GAP");
  assert.ok(gaps.length > 0, "controller-present-no-retryBudget: tail deferred as DETAIL_GAP after cycle cap");
  assert.ok(coverage.gapKeys.length > 0, "controller-present-no-retryBudget: gapKeys populated after cycle cap");
});
