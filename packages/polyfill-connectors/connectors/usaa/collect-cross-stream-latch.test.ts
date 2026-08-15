// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `collect()`-level proof that a session death detected mid-run in ONE
 * stream actually suppresses every LATER stream in the same run — not just
 * the per-stream unit behavior already covered in
 * `late-auth-self-heal.test.ts` (which proves `runStatementsStream`/
 * `runInboxStream` individually RETURN `sessionAlive: false`, but never
 * proves `collect()`'s orchestration actually acts on that return value).
 *
 * This is the collect()-level test the independent review
 * (/tmp/review-browser-session-repair-0810.md, Finding U3) required to kill
 * mutant M6: neutering `latchSessionDead` to `if (false)` — so
 * `sessionDeadMidRun` can never be set from statements/inbox — left all 217
 * pre-revision USAA tests passing. Without a `collect()`-level assertion
 * that a later stream never ran, that mutant is invisible.
 *
 * Drives the real `collectUsaa` (exported from index.ts, the same function
 * wired as `runConnector`'s `collect`) against a fully mocked
 * Page/BrowserContext — no live browser.
 */

import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { BrowserContext, Page } from "playwright";
import type { BrowserCollectContext, EmittedMessage } from "../../src/connector-runtime.ts";
import { makeRecordingEmit } from "../../src/test-harness.ts";
import { collectUsaa } from "./index.ts";
import { validateRecord } from "./schemas.ts";

const DASHBOARD_URL = "https://www.usaa.com/my/usaa";
const DOCUMENTS_URL = "https://www.usaa.com/my/documents";
const INBOX_URL = "https://www.usaa.com/my/inbox";
const LOGON_URL = "https://www.usaa.com/my/logon";

async function withFastTimers<T>(fn: () => Promise<T>): Promise<T> {
  mock.timers.enable({ apis: ["setTimeout"] });
  const ticker = setInterval(() => {
    mock.timers.tick(10_000);
  }, 0);
  try {
    return await fn();
  } finally {
    clearInterval(ticker);
    mock.timers.reset();
  }
}

/** A page that tracks every `.goto()` target and reports the last one from
 *  `.url()` — except `DOCUMENTS_URL`, which always bounces to the logon
 *  page (models the session dying right as the statements stream starts,
 *  after accounts already succeeded). `.evaluate()`/`.waitForSelector()`
 *  resolve to harmless empty results regardless of the caller's script, so
 *  every stream's scrape step is a no-op — only navigation targets and call
 *  counts are under test here. */
function makeCrossStreamPage(): { gotoCalls: string[]; page: Page } {
  const gotoCalls: string[] = [];
  let current = DASHBOARD_URL;
  const page = Object.assign({} as Page, {
    goto: (url: string) => {
      gotoCalls.push(url);
      current = url === DOCUMENTS_URL ? LOGON_URL : url;
      return Promise.resolve(null);
    },
    url: () => current,
    evaluate: () => Promise.resolve([]),
    waitForSelector: () => Promise.resolve(null),
  });
  return { gotoCalls, page };
}

/**
 * `collectUsaa` always constructs its own `EmitDeps` internally (with no
 * `reauthenticate` override), so a repair attempt against this fake
 * context/page always falls through to the real `ensureUsaaSession`, which
 * throws immediately. That is exactly what this test needs: the repair must
 * FAIL so the cross-stream latch actually fires and is observable.
 */
function makeCollectHarness(): {
  ctx: BrowserCollectContext;
  gotoCalls: string[];
  messages: EmittedMessage[];
  page: Page;
} {
  const harness = makeRecordingEmit(validateRecord);
  const { gotoCalls, page } = makeCrossStreamPage();
  const requested = new Map(
    ["accounts", "statements", "inbox_messages", "credit_card_billing", "credit_card_billing_stats"].map((name) => [
      name,
      { name },
    ])
  );
  const ctx: BrowserCollectContext = {
    // biome-ignore lint/suspicious/useAwait: mock matches assist's Promise-returning signature
    assist: async (): Promise<never> => {
      throw new Error("assist must not be called");
    },
    capture: null,
    completeAssistance: async () => undefined,
    context: {} as BrowserContext,
    credentials: {},
    detailGaps: [],
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    emittedAt: "2026-08-10T12:00:00.000Z",
    page,
    progress: async () => undefined,
    requestDetailGapPage: async (): Promise<readonly never[]> => [],
    requested,
    scope: { streams: [] },
    // biome-ignore lint/suspicious/useAwait: mock matches sendInteraction's Promise-returning signature
    sendInteraction: async (): Promise<never> => {
      throw new Error("sendInteraction must not be called — the fallback ensureUsaaSession throws before reaching it");
    },
    state: {},
  };
  return { ctx, gotoCalls, messages: harness.protocolMessages, page };
}

test("collectUsaa: a session death detected in statements suppresses inbox_messages and credit_card_billing — kills the latchSessionDead-neutered mutant (M6)", async () => {
  await withFastTimers(async () => {
    const { ctx, gotoCalls, messages } = makeCollectHarness();

    await assert.rejects(collectUsaa(ctx), /usaa session expired mid-run/);

    assert.ok(gotoCalls.includes(DASHBOARD_URL), "accounts stage ran");
    assert.ok(gotoCalls.includes(DOCUMENTS_URL), "statements stage ran and hit the session-dead bounce");
    assert.ok(
      !gotoCalls.includes(INBOX_URL),
      "MUTATION-KILLING ASSERTION: inbox_messages must never navigate once statements has latched sessionDeadMidRun — with latchSessionDead neutered (M6), this would fail because runInboxStream would still be reached and would still attempt its own navigation"
    );
    assert.ok(
      !gotoCalls.some((u) => u.includes("credit-card")),
      "credit_card_billing must never navigate once an earlier stream latched sessionDeadMidRun"
    );

    const inboxSkips = messages.filter((m) => m.type === "SKIP_RESULT" && m.stream === "inbox_messages");
    assert.equal(
      inboxSkips.length,
      0,
      "inbox_messages is suppressed entirely (never attempted), not attempted-and-skipped — it must not even emit its own SKIP_RESULT"
    );
    const statementsSkips = messages.filter((m) => m.type === "SKIP_RESULT" && m.stream === "statements");
    assert.equal(statementsSkips.length, 1, "statements itself reports exactly one session-dead SKIP_RESULT");
    assert.equal((statementsSkips[0] as { reason?: string }).reason, "session_dead_reauth_failed");
  });
});

test("collectUsaa: a clean run with no session death reaches every requested stream, including inbox_messages and credit_card_billing", async () => {
  await withFastTimers(async () => {
    const harness = makeRecordingEmit(validateRecord);
    const gotoCalls: string[] = [];
    let current = DASHBOARD_URL;
    const page = Object.assign({} as Page, {
      goto: (url: string) => {
        gotoCalls.push(url);
        current = url; // no logon bounce anywhere this run
        return Promise.resolve(null);
      },
      url: () => current,
      evaluate: () => Promise.resolve([]),
      waitForSelector: () => Promise.resolve(null),
    });
    const requested = new Map(
      ["accounts", "statements", "inbox_messages", "credit_card_billing", "credit_card_billing_stats"].map((name) => [
        name,
        { name },
      ])
    );
    const ctx: BrowserCollectContext = {
      // biome-ignore lint/suspicious/useAwait: mock matches assist's Promise-returning signature
      assist: async (): Promise<never> => {
        throw new Error("assist must not be called");
      },
      capture: null,
      completeAssistance: async () => undefined,
      context: {} as BrowserContext,
      credentials: {},
      detailGaps: [],
      emit: harness.emit,
      emitRecord: harness.emitRecord,
      emittedAt: "2026-08-10T12:00:00.000Z",
      page,
      progress: async () => undefined,
      requestDetailGapPage: async (): Promise<readonly never[]> => [],
      requested,
      scope: { streams: [] },
      // biome-ignore lint/suspicious/useAwait: mock matches sendInteraction's Promise-returning signature
      sendInteraction: async (): Promise<never> => {
        throw new Error("sendInteraction must not be called on a clean run");
      },
      state: {},
    };

    await collectUsaa(ctx);

    assert.ok(gotoCalls.includes(DASHBOARD_URL));
    assert.ok(gotoCalls.includes(DOCUMENTS_URL));
    assert.ok(gotoCalls.includes(INBOX_URL), "a clean run must still reach inbox_messages");
    const skips = harness.protocolMessages.filter(
      (m) => m.type === "SKIP_RESULT" && m.reason === "session_dead_reauth_failed"
    );
    assert.equal(skips.length, 0, "a clean run never reports a session-dead SKIP_RESULT anywhere");
  });
});
