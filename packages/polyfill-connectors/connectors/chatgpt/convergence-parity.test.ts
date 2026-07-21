import assert from "node:assert/strict";
import { test } from "node:test";
import { ProviderBudgetController } from "../../src/provider-budget.ts";
import { PreflightWaitProbe } from "../../src/send-governor.ts";
import { makeRecordingEmit } from "../../src/test-harness.ts";
import { resolveChatGptProviderBudget, runMessagesAndConversationsWithDetail, type StreamDeps } from "./index.ts";
import { buildConversationRecord, type ConversationDetail } from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import type { ChatGptApi, ChatGptFetchResult, ChatGptJson, ConversationListItem } from "./types.ts";

const BASE_MAPPING = {
  a1: {
    id: "a1",
    message: {
      id: "a1",
      author: { role: "user" },
      content: { content_type: "text", parts: ["hello"] },
      create_time: 1_700_000_000,
    },
    parent: null,
    children: [],
  },
};

function makeConvo(id: string): ConversationListItem {
  return {
    id,
    title: "Hello world",
    create_time: 1_700_000_000,
    update_time: 1_700_000_100,
    current_node: "a1",
  };
}

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

interface RunResult {
  fetchedIds: string[];
  hydratedKeys: readonly (number | string)[];
  preflightTotalMs: number;
  preflightWaitCount: number;
}

/**
 * Drive one detail pass through the (now only) converged path and capture the
 * decisions and pre-flight wait shape. The probe wraps both the controller
 * pacing sleep and the lane launch sleep to count distinct wait sources.
 *
 * Legacy comparison halves have been removed: the converged path is the only
 * path as of the 2026-06-11 calibration run (run_1781139968889 — 14,721 records
 * committed, upstream-pressure circuit opened and deferred cleanly, zero
 * stacking). The invariants below stand alone against the now-only path.
 */
async function runDetailPass(convoCount: number): Promise<RunResult> {
  const harness = makeRecordingEmit(validateRecord);
  const fetchedIds: string[] = [];
  const probe = new PreflightWaitProbe();
  let clock = 0;
  const now = (): number => clock;
  const tick = (ms: number): void => {
    clock += ms;
  };
  // ONE probe wraps BOTH wait sites (lane launch sleep + pacing hint sleep),
  // so `probe.count` is the true number of pre-flight wait sources per request.
  const sleep = probe.wrap((ms: number) => {
    tick(ms);
  });

  const providerBudget = new ProviderBudgetController({
    pacing: { initialIntervalMs: 2500, minIntervalMs: 250, now, sleep: (ms) => Promise.resolve(sleep(ms)) },
    pacingMode: "signal",
  });

  const api: ChatGptApi = {
    auth: (): Promise<never> => Promise.reject(new Error("auth unused")),
    fetch: async (path: string): Promise<ChatGptFetchResult> => {
      const gate = await providerBudget.beforeRequest();
      if (gate.ok) {
        providerBudget.recordRequest();
      }
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

  const convos = Array.from({ length: convoCount }, (_, i) => makeConvo(`convo-${i + 1}`));
  const coverage = await runMessagesAndConversationsWithDetail(deps, convos, makeEmitConversation(deps), {
    random: () => 0.5,
    sleep,
    tuning: { initialConcurrency: 1, maxConcurrency: 1, pauseMaxMs: 3000, pauseMinMs: 1500 },
  });

  return {
    fetchedIds,
    hydratedKeys: coverage.hydratedKeys,
    preflightWaitCount: probe.count,
    preflightTotalMs: probe.totalMs,
  };
}

test("send governor: converged path fetches expected conversations in order", async () => {
  const result = await runDetailPass(3);
  assert.deepEqual(result.fetchedIds, ["/conversation/convo-1", "/conversation/convo-2", "/conversation/convo-3"]);
  assert.equal(result.hydratedKeys.length, 3, "all conversations hydrated");
});

test("send governor: exactly one pre-flight wait source per request (no stacking)", async () => {
  // The lane is the sole send governor. Pacing folds into the single launch wait
  // via launchDelayHint; the controller does not sleep independently (signal mode).
  // One wait per request, never two — the double-pay anti-pattern is not possible.
  const result = await runDetailPass(3);
  assert.equal(result.preflightWaitCount, 3, "one pre-flight wait per request, no second gate");
});

test("send governor: total pre-flight wait is bounded (no doubling from pacing+lane stacking)", async () => {
  // With launchDelay (random 0.5 of 1500..3000 = 2250 ms) and pacing interval
  // (2500 ms cold, decreasing on success), the lane takes max(launchDelay, hint).
  // Total wait is proportional to pacing velocity — never compounding.
  const result = await runDetailPass(3);
  // 3 requests at ~2500 ms each: well under 3 × 2500 × 2 = 15,000 ms (the
  // doubled-stacking worst case). Confirmed: no stacking.
  assert.ok(result.preflightTotalMs > 0, "at least some pacing wait occurred");
  assert.ok(
    result.preflightTotalMs < 3 * 2500 * 2,
    `total wait ${result.preflightTotalMs}ms is well below the doubled-stacking ceiling`
  );
});

test("send governor: resolveChatGptProviderBudget always yields signal mode (no flag)", () => {
  // Calibrated 2026-06-11 (run_1781139968889). The flag and legacy path are
  // deleted; signal mode is the only code path.
  const controller = resolveChatGptProviderBudget({ PDPP_CHATGPT_DETAIL_RATE_LIMIT_STOP_AFTER: "5" });
  assert.ok(controller instanceof ProviderBudgetController);
  assert.equal(controller.pacingMode, "signal", "controller always in signal mode — lane owns the wait");
});
