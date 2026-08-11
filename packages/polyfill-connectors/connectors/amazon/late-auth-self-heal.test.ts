// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Discriminating sequence tests for Amazon's mid-run stale-session self-heal
 * (`attemptAutomatedSessionRepair` / `resolveOrderDetail`) — the fix for the
 * defect class where a run signs in fine, hydrates order details
 * successfully, then a LATER detail fetch bounces to Amazon's sign-in/
 * challenge/MFA flow because the session went stale mid-run. Mirrors
 * Jellyfin's `late-auth-self-heal.test.ts` naming and shape.
 *
 * Before this fix, a sign-in bounce ALWAYS latched `sessionRepairRequired`
 * permanently on the first hit — see the pre-existing (still-passing, still
 * correct for the no-credentials/no-injection case) tests
 * "a detail redirect to sign-in latches owner-repair..." and "once the
 * session is dead, later orders defer..." in integration.test.ts. This file
 * covers the NEW branch: when `AMAZON_USERNAME`/`AMAZON_PASSWORD` are
 * configured (or a `reauthenticate` override is injected for testing),
 * exactly one repair-and-retry is attempted before falling back to that
 * same terminal owner-repair behavior.
 *
 * `reauthenticate` is injected via `EmitDeps`/`AmazonDetailRecoveryDeps` so
 * these tests never drive the real interactive `ensureAmazonSession` login
 * flow against a stub Page.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { BrowserContext, Page } from "playwright";
import type { BrowserCollectContext } from "../../src/connector-runtime.ts";
import { makeRecordingEmit } from "../../src/test-harness.ts";
import {
  type AmazonReauthFn,
  type EmitDeps,
  processListOrder,
  type RunFlags,
  recoverPendingOrderItemDetailGaps,
} from "./index.ts";
import { validateRecord } from "./schemas.ts";
import type { ListPageOrder } from "./types.ts";

const SIGNIN_URL = "https://www.amazon.com/ap/signin?openid.return_to=order-details";
const DEFAULT_ORDER_ID = "111-1234567-8901234";
const DETAIL_URL = `https://www.amazon.com/gp/your-account/order-details?orderID=${DEFAULT_ORDER_ID}`;
const FAKE_CONTEXT = {} as BrowserContext;

const AMAZON_ENV_KEYS = ["AMAZON_USERNAME", "AMAZON_PASSWORD"] as const;

function withAmazonCredentials<T>(fn: () => Promise<T>): Promise<T> {
  const prior = AMAZON_ENV_KEYS.map((k) => process.env[k]);
  process.env.AMAZON_USERNAME = "owner@example.com";
  process.env.AMAZON_PASSWORD = "hunter2";
  return fn().finally(() => {
    AMAZON_ENV_KEYS.forEach((k, i) => {
      const v = prior[i];
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    });
  });
}

function withoutAmazonCredentials<T>(fn: () => Promise<T>): Promise<T> {
  const prior = AMAZON_ENV_KEYS.map((k) => process.env[k]);
  for (const k of AMAZON_ENV_KEYS) {
    delete process.env[k];
  }
  return fn().finally(() => {
    AMAZON_ENV_KEYS.forEach((k, i) => {
      const v = prior[i];
      if (v !== undefined) {
        process.env[k] = v;
      }
    });
  });
}

// biome-ignore lint/suspicious/useAwait: mock throws to prove a repaired/injected session never reaches sendInteraction
const NEVER_CALLED_SEND_INTERACTION: BrowserCollectContext["sendInteraction"] = async () => {
  throw new Error("sendInteraction must not be called — repair is injected via deps.reauthenticate");
};

/** A page whose `.url()` reports whichever URL was scripted for the Nth
 *  `.goto()` call — models Amazon's real behavior where a repaired session
 *  navigates the SAME URL to a different (real detail) destination. */
function makeSequencedDetailPage(
  landedUrls: string[],
  html = "<html><body>no order details</body></html>"
): {
  gotoCalls: string[];
  page: Page;
} {
  const gotoCalls: string[] = [];
  let current = landedUrls[0] ?? DETAIL_URL;
  const page = new Proxy(
    {},
    {
      get(_target, prop): unknown {
        if (prop === "goto") {
          return (url: string) => {
            gotoCalls.push(url);
            current = landedUrls[gotoCalls.length - 1] ?? landedUrls.at(-1) ?? url;
            return Promise.resolve(null);
          };
        }
        if (prop === "waitForSelector") {
          return (): Promise<null> => Promise.resolve(null);
        }
        if (prop === "content") {
          return (): Promise<string> => Promise.resolve(html);
        }
        if (prop === "url") {
          return (): string => current;
        }
        throw new Error(`unexpected page.${String(prop)} in sequenced detail stub`);
      },
    }
  ) as Page;
  return { gotoCalls, page };
}

function makeRunFlags(): RunFlags {
  return {
    detailAttempts: 0,
    detailCaptured: false,
    failedDetailCaptured: false,
    repairAttempted: false,
    sessionRepairRequired: false,
    temporaryDetailFailures: 0,
  };
}

function makeListOrder(overrides: Partial<ListPageOrder> = {}): ListPageOrder {
  return {
    orderId: DEFAULT_ORDER_ID,
    orderDateRaw: "January 5, 2026",
    orderTotal: "$42.99",
    deliveryStatus: "Delivered",
    items: [{ asin: "B01ABCDEFG", name: "Widget", url: "https://amazon.com/dp/B01ABCDEFG" }],
    ...overrides,
  };
}

function makeDeps(overrides: Partial<EmitDeps> = {}): { deps: EmitDeps } {
  const harness = makeRecordingEmit(validateRecord);
  const deps: EmitDeps = {
    capture: null,
    context: FAKE_CONTEXT,
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    emittedAt: "2026-04-22T12:00:00.000Z",
    progress: (): Promise<void> => Promise.resolve(),
    sendInteraction: NEVER_CALLED_SEND_INTERACTION,
    skipDetail: false,
    wantsItems: true,
    wantsOrders: true,
    ...overrides,
  };
  return { deps };
}

const DETAIL_HTML_WITH_ORDER = `<!doctype html><html><body><div id="orderDetails">
  <div data-component="chargeSummary">Grand Total: $42.99</div>
  <div data-component="purchasedItemsRightGrid">
    <div data-component="itemTitle"><a href="/dp/B01ABCDEFG">Widget</a></div>
    <div data-component="unitPrice">$39.99 $39.99</div>
  </div>
</div></body></html>`;

// ─── processListOrder: forward-walk detail fetch self-heal ─────────────

test("processListOrder: sign-in bounce, repair succeeds, retried detail fetch hydrates — session NOT latched dead", async () => {
  await withAmazonCredentials(async () => {
    let reauthCalls = 0;
    // biome-ignore lint/suspicious/useAwait: mock matches AmazonReauthFn's Promise-returning signature
    const reauthenticate: AmazonReauthFn = async () => {
      reauthCalls += 1;
      return true;
    };
    const { deps } = makeDeps({ reauthenticate });
    const flags = makeRunFlags();
    const { gotoCalls, page } = makeSequencedDetailPage([SIGNIN_URL, DETAIL_URL], DETAIL_HTML_WITH_ORDER);

    await processListOrder(page, deps, flags, makeListOrder());

    assert.equal(reauthCalls, 1, "repair attempted exactly once");
    assert.deepEqual(gotoCalls, [DETAIL_URL, DETAIL_URL], "the retry navigates to the EXACT SAME detail url");
    assert.equal(flags.sessionRepairRequired, false, "a successful repair must not latch the session as dead");
    assert.equal(flags.repairAttempted, true);
  });
});

test("processListOrder: sign-in bounce persists after repair → terminal owner-repair, exactly one retry", async () => {
  await withAmazonCredentials(async () => {
    let reauthCalls = 0;
    // biome-ignore lint/suspicious/useAwait: mock matches AmazonReauthFn's Promise-returning signature
    const reauthenticate: AmazonReauthFn = async () => {
      reauthCalls += 1;
      return true;
    };
    const { deps } = makeDeps({ reauthenticate });
    const flags = makeRunFlags();
    // Both the original attempt and the post-repair retry land on sign-in.
    const { gotoCalls, page } = makeSequencedDetailPage([SIGNIN_URL, SIGNIN_URL]);

    await processListOrder(page, deps, flags, makeListOrder());

    assert.equal(reauthCalls, 1, "repair is not retried in a loop after a second sign-in bounce");
    assert.equal(gotoCalls.length, 2, "exactly one retry navigation, then give up");
    assert.equal(
      flags.sessionRepairRequired,
      true,
      "a persistent bounce still latches the terminal owner-repair state"
    );
  });
});

test("processListOrder: reauthenticate returns false (repair itself failed) → terminal owner-repair, no retry navigation", async () => {
  await withAmazonCredentials(async () => {
    let reauthCalls = 0;
    // biome-ignore lint/suspicious/useAwait: mock matches AmazonReauthFn's Promise-returning signature
    const reauthenticate: AmazonReauthFn = async () => {
      reauthCalls += 1;
      return false;
    };
    const { deps } = makeDeps({ reauthenticate });
    const flags = makeRunFlags();
    const { gotoCalls, page } = makeSequencedDetailPage([SIGNIN_URL]);

    await processListOrder(page, deps, flags, makeListOrder());

    assert.equal(reauthCalls, 1, "repair is attempted once even though it fails");
    assert.equal(gotoCalls.length, 1, "a failed repair must not spend a retry navigation");
    assert.equal(flags.sessionRepairRequired, true);
  });
});

test("processListOrder: no AMAZON_USERNAME/PASSWORD configured → repair never attempted, pre-fix terminal behavior unchanged", async () => {
  await withoutAmazonCredentials(async () => {
    let reauthCalls = 0;
    // biome-ignore lint/suspicious/useAwait: mock matches AmazonReauthFn's Promise-returning signature
    const reauthenticate: AmazonReauthFn = async () => {
      reauthCalls += 1;
      return true;
    };
    const { deps } = makeDeps({ reauthenticate });
    const flags = makeRunFlags();
    const { gotoCalls, page } = makeSequencedDetailPage([SIGNIN_URL]);

    await processListOrder(page, deps, flags, makeListOrder());

    assert.equal(reauthCalls, 0, "no credentials means no automated repair path is eligible");
    assert.equal(gotoCalls.length, 1, "no retry navigation without credentials");
    assert.equal(flags.sessionRepairRequired, true, "falls through to the pre-existing terminal behavior");
  });
});

test("processListOrder: the one-shot repair budget is spent across the WHOLE run, not once per order", async () => {
  await withAmazonCredentials(async () => {
    let reauthCalls = 0;
    // biome-ignore lint/suspicious/useAwait: mock matches AmazonReauthFn's Promise-returning signature
    const reauthenticate: AmazonReauthFn = async () => {
      reauthCalls += 1;
      return true;
    };
    const { deps } = makeDeps({ reauthenticate });
    const flags = makeRunFlags();
    // First order: bounce, repair succeeds, retry succeeds (session alive).
    const { page: page1 } = makeSequencedDetailPage([SIGNIN_URL, DETAIL_URL], DETAIL_HTML_WITH_ORDER);
    await processListOrder(page1, deps, flags, makeListOrder({ orderId: "order-1" }));
    assert.equal(reauthCalls, 1);
    assert.equal(flags.sessionRepairRequired, false);

    // Second order in the SAME run bounces again — the one-shot budget is
    // already spent, so this must NOT attempt a second repair even though
    // sessionRepairRequired is still false (repair succeeded for order 1).
    const { page: page2 } = makeSequencedDetailPage([SIGNIN_URL]);
    await processListOrder(page2, deps, flags, makeListOrder({ orderId: "order-2" }));

    assert.equal(reauthCalls, 1, "the repair budget does not replenish mid-run");
    assert.equal(flags.sessionRepairRequired, true, "second bounce with no budget left latches terminal owner-repair");
  });
});

test("processListOrder: no reauthenticate injected and no credentials → falls straight to terminal owner-repair (integration default)", async () => {
  await withoutAmazonCredentials(async () => {
    const { deps } = makeDeps();
    const flags = makeRunFlags();
    const { page } = makeSequencedDetailPage([SIGNIN_URL]);

    await processListOrder(page, deps, flags, makeListOrder());

    assert.equal(flags.sessionRepairRequired, true);
    assert.equal(
      flags.repairAttempted,
      true,
      "the one-shot budget is still marked spent even though repair was ineligible"
    );
  });
});

// ─── recoverPendingOrderItemDetailGaps: recovery-loop self-heal ────────

test("recoverPendingOrderItemDetailGaps: sign-in bounce during recovery, repair succeeds, recovery continues past it", async () => {
  await withAmazonCredentials(async () => {
    let reauthCalls = 0;
    // biome-ignore lint/suspicious/useAwait: mock matches AmazonReauthFn's Promise-returning signature
    const reauthenticate: AmazonReauthFn = async () => {
      reauthCalls += 1;
      return true;
    };
    const harness = makeRecordingEmit(validateRecord);
    const flags = makeRunFlags();
    const { page } = makeSequencedDetailPage([SIGNIN_URL, DETAIL_URL], DETAIL_HTML_WITH_ORDER);

    const result = await recoverPendingOrderItemDetailGaps(
      page,
      {
        capture: null,
        context: FAKE_CONTEXT,
        detailGaps: [
          {
            detail_locator: { kind: "amazon.order_detail", order_date: "2026-01-05", order_id: "111-1234567-8901234" },
            gap_id: "gap_1",
            record_key: "111-1234567-8901234",
            reference_only: true,
            status: "pending",
            stream: "order_items",
          },
        ],
        emit: harness.emit,
        emitRecord: harness.emitRecord,
        reauthenticate,
        sendInteraction: NEVER_CALLED_SEND_INTERACTION,
      },
      flags
    );

    assert.equal(reauthCalls, 1, "repair attempted exactly once during recovery");
    assert.equal(result.recovered, 1, "the repaired retry recovers the gap instead of re-deferring it");
    assert.equal(flags.sessionRepairRequired, false);
  });
});
