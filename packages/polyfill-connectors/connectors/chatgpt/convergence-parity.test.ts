import assert from "node:assert/strict";
import { test } from "node:test";
import { ProviderBudgetController } from "../../src/provider-budget.ts";
import { PreflightWaitProbe } from "../../src/send-governor.ts";
import { makeRecordingEmit } from "../../src/test-harness.ts";
import {
  resolveChatGptConvergedGovernance,
  resolveChatGptProviderBudget,
  runMessagesAndConversationsWithDetail,
  type StreamDeps,
} from "./index.ts";
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
 * Drive one detail pass with a given pacing mode and capture the decisions and
 * the pre-flight wait shape. Both modes use the same fixed clock and a probe
 * that counts every non-zero pre-flight wait (controller pacing AND lane launch)
 * on the request path, so we can compare decisions and wait sources directly.
 */
async function runDetailPass(pacingMode: "preflight" | "signal", convoCount: number): Promise<RunResult> {
  const harness = makeRecordingEmit(validateRecord);
  const fetchedIds: string[] = [];
  const probe = new PreflightWaitProbe();
  let clock = 0;
  const now = (): number => clock;
  const tick = (ms: number): void => {
    clock += ms;
  };
  // ONE probe wraps BOTH wait sites (controller pacing sleep + lane launch
  // sleep), so `probe.count` is the true number of pre-flight wait sources.
  const sleep = probe.wrap((ms: number) => {
    tick(ms);
  });

  const providerBudget = new ProviderBudgetController({
    pacing: { initialIntervalMs: 2500, minIntervalMs: 250, now, sleep: (ms) => Promise.resolve(sleep(ms)) },
    pacingMode,
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

test("convergence parity: converged path makes the SAME decisions (fetched IDs, coverage) as legacy", async () => {
  const legacy = await runDetailPass("preflight", 3);
  const converged = await runDetailPass("signal", 3);
  assert.deepEqual(converged.fetchedIds, legacy.fetchedIds, "same provider requests, same order");
  assert.deepEqual(converged.hydratedKeys, legacy.hydratedKeys, "same hydration coverage");
  assert.deepEqual(legacy.fetchedIds, ["/conversation/convo-1", "/conversation/convo-2", "/conversation/convo-3"]);
});

test("convergence parity: converged path has EXACTLY ONE pre-flight wait source per request (no stacking)", async () => {
  const converged = await runDetailPass("signal", 3);
  // 3 requests, one pre-flight wait each — never two. The legacy path also has
  // one (pacing owns it, lane delay zeroed); the convergence keeps it at one
  // while flipping the owner to the lane.
  assert.equal(converged.preflightWaitCount, 3, "one pre-flight wait per request, no second gate");
});

test("convergence parity: legacy path also has one wait source per request (lane delay neutralized today)", async () => {
  const legacy = await runDetailPass("preflight", 3);
  // Confirms the baseline this convergence preserves: today's ChatGPT already
  // avoids stacking by zeroing the lane launch delay when a pacing controller
  // is present. The convergence flips WHO owns the single wait, not how many.
  assert.equal(legacy.preflightWaitCount, 3, "legacy already one wait per request (the property we preserve)");
});

test("convergence parity: total pre-flight wait is equivalent between modes (same GCRA velocity)", async () => {
  const legacy = await runDetailPass("preflight", 3);
  const converged = await runDetailPass("signal", 3);
  // The GCRA interval governs both. In converged mode the lane takes
  // max(launchDelay, pacingHint); with launchDelay (random 0.5 of 1500..3000 =
  // 2250) < pacing interval (2500 cold, decreasing on success), the GCRA
  // interval dominates — so total velocity tracks the same pacing bucket. They
  // are within one launch-delay window of each other, never compounding.
  assert.ok(
    converged.preflightTotalMs >= legacy.preflightTotalMs,
    "converged wait is at least the legacy pacing wait (lane max folds pacing in, never less)"
  );
  // And the convergence never DOUBLES the wait (the anti-pattern): converged is
  // far below legacy + a second full pacing pass.
  assert.ok(
    converged.preflightTotalMs < legacy.preflightTotalMs * 2,
    "converged wait is nowhere near double — no stacking"
  );
});

test("convergence flag: default OFF; resolver yields preflight (byte-identical) unless explicitly enabled", () => {
  assert.equal(resolveChatGptConvergedGovernance({}), false, "default off");
  assert.equal(resolveChatGptConvergedGovernance({ PDPP_CHATGPT_CONVERGED_RATE_GOVERNANCE: "1" }), true);
  assert.equal(resolveChatGptConvergedGovernance({ PDPP_CHATGPT_CONVERGED_RATE_GOVERNANCE: "on" }), true);
  assert.equal(resolveChatGptConvergedGovernance({ PDPP_CHATGPT_CONVERGED_RATE_GOVERNANCE: "0" }), false);

  const legacy = resolveChatGptProviderBudget({});
  assert.ok(legacy instanceof ProviderBudgetController);
  assert.equal(legacy.pacingMode, "preflight", "default controller owns the pre-flight pacing wait (unchanged)");

  const converged = resolveChatGptProviderBudget({ PDPP_CHATGPT_CONVERGED_RATE_GOVERNANCE: "1" });
  assert.ok(converged instanceof ProviderBudgetController);
  assert.equal(converged.pacingMode, "signal", "flag flips the controller to signal mode (lane owns the wait)");
});
