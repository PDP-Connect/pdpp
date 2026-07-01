/**
 * Behavior tests for the ChatGPT push-approval auto-resume fix.
 *
 * The push approval is approved by the owner out of band in the ChatGPT app.
 * The connector observes completion by polling `isChatGptSessionActive(page)` in
 * a non-blocking window (an `act_elsewhere` assistance, no owner response
 * required). This suite proves the three guarantees of the fix:
 *
 *   1. The non-blocking poll checkpoints each tick, so a poll that out-lasts the
 *      session-establishment watchdog's no-progress deadline does NOT trip it
 *      (the load-bearing bug: the 180s poll vs the 120s watchdog).
 *   2. When readiness is observed during the (now extended, owner-configurable)
 *      poll, the connector resolves the assistance and continues with NO
 *      `INTERACTION` emitted — no owner click required.
 *   3. Only after the observation budget is exhausted does the connector escalate
 *      the assistance `escalated` and emit the blocking `manual_action` fallback,
 *      in that order.
 *
 * The watchdog test reuses the deterministic logical-clock pattern from
 * connector-runtime-session-watchdog.test.ts so there are no real sleeps
 * proportional to the production budget.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { BrowserContext, Locator, Page } from "playwright";
import {
  type AssistanceRequest,
  type InteractionRequest,
  type InteractionResponse,
  makeSessionEstablishWatchdog,
} from "../connector-runtime.ts";
import { chatGptBrowserLoginAssistance, handleBrowserLoginAssistance, handlePushApproval } from "./chatgpt.ts";

// ─── fakes ──────────────────────────────────────────────────────────────────

function makeContext(): BrowserContext {
  return {} as BrowserContext;
}

// A locator whose `waitFor` always resolves visible — used for the push-approval
// text probes so `isLikelyChatGptPushApprovalPage` returns true.
const visibleLocator: Pick<Locator, "click" | "count" | "fill" | "first" | "waitFor"> = {
  click: (): Promise<void> => Promise.resolve(),
  count: (): Promise<number> => Promise.resolve(1),
  fill: (): Promise<void> => Promise.resolve(),
  first(): Locator {
    return visibleLocator as Locator;
  },
  waitFor: (): Promise<void> => Promise.resolve(),
};

interface PushApprovalPageOptions {
  /** Called on each `page.waitForTimeout` — lets a test advance a logical clock. */
  readonly onWaitTimeout?: (ms: number) => void | Promise<void>;
  /** Returns true once the session should be observed active. */
  readonly sessionActive: () => boolean;
}

/**
 * A page that always reads as the push-approval screen (its `getByText` probes
 * resolve visible) and whose session readiness is test-controlled.
 */
function makePushApprovalPage(opts: PushApprovalPageOptions): Page {
  const fake: Pick<Page, "context" | "evaluate" | "getByText" | "waitForTimeout"> = {
    context(): BrowserContext {
      return makeContext();
    },
    evaluate(fn: unknown): Promise<unknown> {
      const active = opts.sessionActive();
      // checkLoggedInViaDOM() (querySelectorAll source) expects a boolean;
      // checkSession() expects { user } when active.
      if (typeof fn === "function" && fn.toString().includes("querySelectorAll")) {
        return Promise.resolve(active);
      }
      return Promise.resolve(active ? { user: { id: "u" } } : null);
    },
    getByText(): Locator {
      return visibleLocator as Locator;
    },
    async waitForTimeout(ms: number): Promise<void> {
      await opts.onWaitTimeout?.(ms);
    },
  };
  return fake as Page;
}

// Logical clock: tests advance `value` so the watchdog's trip math (which reads
// `now`) is deterministic without real-time sleeps.
function makeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let value = start;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
}

function makeStubPageForWatchdog(): Page {
  const fake: Pick<Page, "isClosed"> = { isClosed: () => false };
  return fake as Page;
}

// A short real-time yield so the watchdog's real interval timer can tick and
// observe the advanced logical clock.
const realTick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

function recordingSendInteraction(requests: InteractionRequest[]) {
  return (req: InteractionRequest): Promise<InteractionResponse> => {
    requests.push(req);
    return Promise.resolve({
      request_id: req.request_id ?? "test_interaction",
      status: "success",
      type: "INTERACTION_RESPONSE",
    });
  };
}

function shortBudgetEnv(): void {
  // Keep the poll attempt count tiny so tests that exhaust the budget do not
  // loop 180 times. 15s / 5s interval = 3 attempts.
  process.env.PDPP_CHATGPT_PUSH_APPROVAL_TIMEOUT_MS = "15000";
}

function shortBrowserLoginBudgetEnv(): void {
  process.env.PDPP_CHATGPT_BROWSER_LOGIN_TIMEOUT_MS = "15000";
}

function clearBudgetEnv(prior: string | undefined): void {
  if (prior === undefined) {
    delete process.env.PDPP_CHATGPT_PUSH_APPROVAL_TIMEOUT_MS;
  } else {
    process.env.PDPP_CHATGPT_PUSH_APPROVAL_TIMEOUT_MS = prior;
  }
}

// ─── 1. watchdog is not tripped by the (checkpointing) poll ──────────────────

test("push-approval poll checkpoints each tick so a long wait does NOT trip the session watchdog", async () => {
  const prior = process.env.PDPP_CHATGPT_PUSH_APPROVAL_TIMEOUT_MS;
  // Budget far exceeds the watchdog deadline below: the poll runs many ticks,
  // each advancing the clock past where a non-checkpointing poll would trip.
  process.env.PDPP_CHATGPT_PUSH_APPROVAL_TIMEOUT_MS = "100000"; // 100s / 5s = 20 attempts
  try {
    const clock = makeClock();
    let tripped = false;
    const watchdog = makeSessionEstablishWatchdog({
      capture: null,
      name: "chatgpt",
      page: makeStubPageForWatchdog(),
      deadlineMs: 100,
      pollIntervalMs: 2,
      now: clock.now,
      onTrip: () => {
        tripped = true;
      },
    });

    // Session goes active on the 6th observed poll — well past the 100ms
    // deadline in logical time (6 * 80ms = 480ms), so without per-tick
    // checkpointing the watchdog would have tripped.
    let polls = 0;
    const page = makePushApprovalPage({
      sessionActive: () => polls >= 6,
      onWaitTimeout: async () => {
        polls++;
        clock.advance(80); // each gap < deadline only because checkpoint resets it
        await realTick();
      },
    });

    let result = false;
    await watchdog.run(async () => {
      result = await handlePushApproval({
        checkpoint: watchdog.checkpoint,
        page,
        sendInteraction: recordingSendInteraction([]),
      });
    });

    assert.equal(tripped, false, "checkpointing poll must not trip the session-establishment watchdog");
    assert.equal(result, true, "poll should observe readiness and resume");
  } finally {
    clearBudgetEnv(prior);
  }
});

test("control: an identical poll WITHOUT a checkpoint hook DOES trip the watchdog", async () => {
  // Proves the checkpoint is load-bearing: same shape, no `checkpoint` arg, the
  // watchdog trips because the poll advances the clock past the deadline with
  // no forward-progress signal and no open interaction.
  const prior = process.env.PDPP_CHATGPT_PUSH_APPROVAL_TIMEOUT_MS;
  process.env.PDPP_CHATGPT_PUSH_APPROVAL_TIMEOUT_MS = "100000";
  try {
    const clock = makeClock();
    const watchdog = makeSessionEstablishWatchdog({
      capture: null,
      name: "chatgpt",
      page: makeStubPageForWatchdog(),
      deadlineMs: 100,
      pollIntervalMs: 2,
      now: clock.now,
    });

    // Never goes active; each poll advances the clock. No checkpoint passed.
    const page = makePushApprovalPage({
      sessionActive: () => false,
      onWaitTimeout: async () => {
        clock.advance(80);
        await realTick();
      },
    });

    const rejection = assert.rejects(
      watchdog.run(async () => {
        await handlePushApproval({
          page,
          sendInteraction: recordingSendInteraction([]),
        });
      }),
      /chatgpt_session_establish_timeout/
    );
    await rejection;
  } finally {
    clearBudgetEnv(prior);
  }
});

// ─── 2. auto-resume happy path emits NO interaction ──────────────────────────

test("readiness during the non-blocking poll resolves the assistance and emits NO interaction", async () => {
  const prior = process.env.PDPP_CHATGPT_PUSH_APPROVAL_TIMEOUT_MS;
  shortBudgetEnv();
  try {
    const interactions: InteractionRequest[] = [];
    const completes: Array<{ id: string; status: string }> = [];
    let assistCalls = 0;

    // Active on the 2nd poll (within the 3-attempt budget).
    let polls = 0;
    const page = makePushApprovalPage({
      sessionActive: () => polls >= 2,
      onWaitTimeout: () => {
        polls++;
      },
    });

    const result = await handlePushApproval({
      assist: () => {
        assistCalls++;
        return Promise.resolve("asst_1");
      },
      checkpoint: () => Promise.resolve(),
      completeAssistance: (id, status) => {
        completes.push({ id, status });
        return Promise.resolve();
      },
      page,
      sendInteraction: recordingSendInteraction(interactions),
    });

    assert.equal(result, true, "readiness observed → resume");
    assert.equal(interactions.length, 0, "auto-resume MUST NOT emit an INTERACTION");
    assert.equal(assistCalls, 1, "the non-blocking act_elsewhere assistance was requested once");
    assert.deepEqual(completes, [{ id: "asst_1", status: "resolved" }], "assistance resolved, not escalated");
  } finally {
    clearBudgetEnv(prior);
  }
});

// ─── 3. exhaustion escalates BEFORE the blocking fallback ────────────────────

test("budget exhausted: assistance is escalated BEFORE the blocking manual_action is emitted", async () => {
  const prior = process.env.PDPP_CHATGPT_PUSH_APPROVAL_TIMEOUT_MS;
  shortBudgetEnv(); // 3 attempts
  try {
    const events: string[] = [];
    const interactions: InteractionRequest[] = [];

    // Never goes active during the budget; becomes active only after the
    // fallback manual_action resolves (the owner finishes in the browser).
    let manualActionDone = false;
    const page = makePushApprovalPage({
      sessionActive: () => manualActionDone,
    });

    const result = await handlePushApproval({
      assist: () => Promise.resolve("asst_1"),
      checkpoint: () => Promise.resolve(),
      completeAssistance: (_id, status) => {
        events.push(`complete:${status}`);
        return Promise.resolve();
      },
      page,
      sendInteraction: (req) => {
        events.push(`interaction:${req.kind}`);
        interactions.push(req);
        manualActionDone = true; // owner completed it in the browser
        return Promise.resolve({
          request_id: req.request_id ?? "x",
          status: "success",
          type: "INTERACTION_RESPONSE",
        });
      },
    });

    assert.equal(result, true, "post-fallback readiness re-check passes");
    assert.equal(interactions.length, 1, "exactly one fallback interaction after the budget");
    assert.equal(interactions[0]?.kind, "manual_action");
    // Ordering: escalate the assistance THEN emit the blocking interaction.
    assert.deepEqual(
      events,
      ["complete:escalated", "interaction:manual_action"],
      "assistance must be escalated before the blocking manual_action"
    );
  } finally {
    clearBudgetEnv(prior);
  }
});

test("budget exhausted with no readiness even after the fallback returns false", async () => {
  const prior = process.env.PDPP_CHATGPT_PUSH_APPROVAL_TIMEOUT_MS;
  shortBudgetEnv();
  try {
    const interactions: InteractionRequest[] = [];
    const page = makePushApprovalPage({ sessionActive: () => false });

    const result = await handlePushApproval({
      assist: () => Promise.resolve("asst_1"),
      checkpoint: () => Promise.resolve(),
      completeAssistance: () => Promise.resolve(),
      page,
      sendInteraction: recordingSendInteraction(interactions),
    });

    assert.equal(result, false, "no readiness anywhere → handler reports not-resumed");
    assert.equal(interactions.length, 1, "the blocking fallback was still attempted once");
  } finally {
    clearBudgetEnv(prior);
  }
});

// ─── 4. browser-login assistance auto-resumes without owner click ───────────

test("browser-login assistance resolves when readiness appears and emits NO interaction", async () => {
  const prior = process.env.PDPP_CHATGPT_BROWSER_LOGIN_TIMEOUT_MS;
  shortBrowserLoginBudgetEnv();
  try {
    const interactions: InteractionRequest[] = [];
    const assistanceRequests: AssistanceRequest[] = [];
    const completes: Array<{ id: string; status: string }> = [];

    let polls = 0;
    const page = makePushApprovalPage({
      sessionActive: () => polls >= 2,
      onWaitTimeout: () => {
        polls++;
      },
    });

    const result = await handleBrowserLoginAssistance({
      assist: (req) => {
        assistanceRequests.push(req);
        return Promise.resolve("asst_login");
      },
      checkpoint: () => Promise.resolve(),
      completeAssistance: (id, status) => {
        completes.push({ id, status });
        return Promise.resolve();
      },
      page,
      sendInteraction: recordingSendInteraction(interactions),
    });

    assert.equal(result, true, "readiness observed -> resume");
    assert.equal(interactions.length, 0, "auto-resume MUST NOT wait for an owner INTERACTION response");
    assert.equal(assistanceRequests.length, 1, "browser-login assistance was requested once");
    assert.equal(assistanceRequests[0]?.owner_action, "operate_attachment");
    assert.deepEqual(assistanceRequests[0]?.attachments, [{ kind: "browser_surface", role: "streaming_companion" }]);
    assert.deepEqual(completes, [{ id: "asst_login", status: "resolved" }]);
  } finally {
    clearBrowserLoginBudgetEnv(prior);
  }
});

test("browser-login budget exhaustion escalates before blocking manual_action fallback", async () => {
  const prior = process.env.PDPP_CHATGPT_BROWSER_LOGIN_TIMEOUT_MS;
  shortBrowserLoginBudgetEnv();
  try {
    const events: string[] = [];
    const interactions: InteractionRequest[] = [];

    let manualActionDone = false;
    const page = makePushApprovalPage({
      sessionActive: () => manualActionDone,
    });

    const result = await handleBrowserLoginAssistance({
      assist: () => Promise.resolve("asst_login"),
      checkpoint: () => Promise.resolve(),
      completeAssistance: (_id, status) => {
        events.push(`complete:${status}`);
        return Promise.resolve();
      },
      page,
      sendInteraction: (req) => {
        events.push(`interaction:${req.kind}`);
        interactions.push(req);
        manualActionDone = true;
        return Promise.resolve({
          request_id: req.request_id ?? "x",
          status: "success",
          type: "INTERACTION_RESPONSE",
        });
      },
    });

    assert.equal(result, true, "post-fallback readiness re-check passes");
    assert.equal(interactions.length, 1, "fallback interaction is emitted only after the assistance budget");
    assert.deepEqual(events, ["complete:escalated", "interaction:manual_action"]);
  } finally {
    clearBrowserLoginBudgetEnv(prior);
  }
});

test("chatGptBrowserLoginAssistance carries browser attachment and timeout", () => {
  const assistance = chatGptBrowserLoginAssistance({ PDPP_CHATGPT_BROWSER_LOGIN_TIMEOUT_MS: "120000" });

  assert.equal(assistance.owner_action, "operate_attachment");
  assert.equal(assistance.response_contract, "none");
  assert.equal(assistance.timeout_seconds, 120);
  assert.deepEqual(assistance.attachments, [{ kind: "browser_surface", role: "streaming_companion" }]);
});

function clearBrowserLoginBudgetEnv(prior: string | undefined): void {
  if (prior === undefined) {
    delete process.env.PDPP_CHATGPT_BROWSER_LOGIN_TIMEOUT_MS;
  } else {
    process.env.PDPP_CHATGPT_BROWSER_LOGIN_TIMEOUT_MS = prior;
  }
}
