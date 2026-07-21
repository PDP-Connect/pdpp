// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import type { BrowserContext, Locator, Page } from "playwright";
import type { InteractionRequest, InteractionResponse } from "../connector-runtime.ts";
import { ensureAmazonSession } from "./amazon.ts";

const ORDERS_URL = "https://www.amazon.com/your-orders/orders";
const SIGNIN_URL = "https://www.amazon.com/ap/signin";

const STREAMING_ENV_KEYS = [
  "PDPP_RUN_ID",
  "PDPP_REFERENCE_BASE_URL",
  "PDPP_STREAMING_REGISTRATION_TOKEN",
  "PDPP_LOCAL_DEVICE_TOKEN",
] as const;

interface InteractionHarness {
  requests: InteractionRequest[];
  sendInteraction: (req: InteractionRequest) => Promise<InteractionResponse>;
}

function makeContext(): BrowserContext {
  // ensureAmazonSession ignores the context (named `_context`); the deep probe
  // works entirely off page.url()/locators, so a bare stub is sufficient.
  return {} as BrowserContext;
}

function makeInteractionHarness(status: InteractionResponse["status"] = "success"): InteractionHarness {
  const requests: InteractionRequest[] = [];
  return {
    requests,
    sendInteraction(req: InteractionRequest): Promise<InteractionResponse> {
      requests.push(req);
      return Promise.resolve({
        request_id: req.request_id ?? "test_interaction",
        status,
        type: "INTERACTION_RESPONSE",
      });
    },
  };
}

/**
 * Fake page that:
 *   - never renders the email field (`#ap_email*` count stays 0) — simulating
 *     a Cloudflare/CAPTCHA challenge in place of the sign-in form;
 *   - parks on a sign-in URL until `becomeLoggedInAfterGoto` goto calls have
 *     happened, after which goto() lands on the orders URL and the sign-in
 *     form disappears (operator completed login in the visible browser).
 *
 * `becomeLoggedInAfterGoto = Infinity` models "operator never logged in".
 */
function makeChallengePage({ becomeLoggedInAfterGoto }: { becomeLoggedInAfterGoto: number }): {
  gotoCalls: string[];
  page: Page;
} {
  const gotoCalls: string[] = [];
  let currentUrl = SIGNIN_URL;

  const emptyLocator: Pick<Locator, "count" | "first" | "isVisible" | "inputValue" | "nth" | "fill"> = {
    count: (): Promise<number> => Promise.resolve(0),
    first(): Locator {
      return emptyLocator as Locator;
    },
    isVisible: (): Promise<boolean> => Promise.resolve(false),
    inputValue: (): Promise<string> => Promise.resolve(""),
    nth(): Locator {
      return emptyLocator as Locator;
    },
    fill: (): Promise<void> => Promise.resolve(),
  };

  const loggedIn = (): boolean => gotoCalls.length >= becomeLoggedInAfterGoto;

  const page: Pick<Page, "goto" | "locator" | "url" | "waitForTimeout"> = {
    goto(url: string): ReturnType<Page["goto"]> {
      gotoCalls.push(url);
      // The orders-page deep probe is the only navigation that flips us to a
      // logged-in URL once the operator has completed login.
      if (url === ORDERS_URL && loggedIn()) {
        currentUrl = ORDERS_URL;
      }
      return Promise.resolve(null);
    },
    locator(_selector: string): Locator {
      // signIn form is "visible" only while still parked on the sign-in URL.
      if (_selector.includes("signIn")) {
        const formVisible = !loggedIn();
        return {
          ...emptyLocator,
          first(): Locator {
            return this as Locator;
          },
          isVisible: (): Promise<boolean> => Promise.resolve(formVisible),
        } as Locator;
      }
      return emptyLocator as Locator;
    },
    url(): string {
      return currentUrl;
    },
    waitForTimeout(): Promise<void> {
      return Promise.resolve();
    },
  };
  return { gotoCalls, page: page as Page };
}

function makeVisibleFieldFillFailurePage(): {
  page: Page;
} {
  const visibleLoginForm: Pick<Locator, "count" | "first" | "isVisible" | "inputValue" | "nth" | "fill"> = {
    count: (): Promise<number> => Promise.resolve(1),
    first(): Locator {
      return visibleLoginForm as Locator;
    },
    isVisible: (): Promise<boolean> => Promise.resolve(true),
    inputValue: (): Promise<string> => Promise.resolve(""),
    nth(): Locator {
      return visibleLoginForm as Locator;
    },
    fill: (): Promise<void> => Promise.reject(new Error("amazon_input_fill_failed")),
  };
  const emptyLocator: Pick<Locator, "count" | "first" | "isVisible" | "inputValue" | "nth" | "fill"> = {
    count: (): Promise<number> => Promise.resolve(0),
    first(): Locator {
      return emptyLocator as Locator;
    },
    isVisible: (): Promise<boolean> => Promise.resolve(false),
    inputValue: (): Promise<string> => Promise.resolve(""),
    nth(): Locator {
      return emptyLocator as Locator;
    },
    fill: (): Promise<void> => Promise.resolve(),
  };
  const page: Pick<Page, "goto" | "locator" | "url" | "waitForTimeout"> = {
    goto(): ReturnType<Page["goto"]> {
      return Promise.resolve(null);
    },
    locator(selector: string): Locator {
      if (selector.includes("signIn") || selector.includes("ap_email")) {
        return visibleLoginForm as Locator;
      }
      return emptyLocator as Locator;
    },
    url(): string {
      return SIGNIN_URL;
    },
    waitForTimeout(): Promise<void> {
      return Promise.resolve();
    },
  };
  return { page: page as Page };
}

async function withAmazonCredentials(run: () => Promise<void>): Promise<void> {
  const priorUsername = process.env.AMAZON_USERNAME;
  const priorPassword = process.env.AMAZON_PASSWORD;
  const priorStreamingEnv = new Map<(typeof STREAMING_ENV_KEYS)[number], string | undefined>();
  for (const key of STREAMING_ENV_KEYS) {
    priorStreamingEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.AMAZON_USERNAME = "test-user@example.com";
  process.env.AMAZON_PASSWORD = "test-password";
  try {
    await run();
  } finally {
    if (priorUsername === undefined) {
      delete process.env.AMAZON_USERNAME;
    } else {
      process.env.AMAZON_USERNAME = priorUsername;
    }
    if (priorPassword === undefined) {
      delete process.env.AMAZON_PASSWORD;
    } else {
      process.env.AMAZON_PASSWORD = priorPassword;
    }
    for (const key of STREAMING_ENV_KEYS) {
      const value = priorStreamingEnv.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("ensureAmazonSession emits manual_action when the sign-in form is replaced by a challenge", async () => {
  await withAmazonCredentials(async () => {
    // Initial deep probe (goto #1) sees the sign-in URL. The email field never
    // renders, so the challenge fallback fires. The operator completes login,
    // so the re-probe (goto after manual action) lands on orders and returns.
    const { gotoCalls, page } = makeChallengePage({ becomeLoggedInAfterGoto: 3 });
    const interactions = makeInteractionHarness();

    const ok = await ensureAmazonSession({
      context: makeContext(),
      fieldTimeoutMs: 1,
      page,
      sendInteraction: interactions.sendInteraction,
    });

    assert.equal(ok, true);
    assert.equal(interactions.requests.length, 1);
    assert.equal(interactions.requests[0]?.kind, "manual_action");
    assert.ok(interactions.requests[0]?.request_id?.startsWith("int_"));
    assert.match(interactions.requests[0]?.message ?? "", /CAPTCHA\/puzzle|approve-on-device/u);
    assert.match(interactions.requests[0]?.message ?? "", /PDPP_AMAZON_HEADLESS=0/u);
    // The handoff message must never leak the stored credentials.
    assert.doesNotMatch(interactions.requests[0]?.message ?? "", /test-user|test-password|example\.com/u);
    // Re-probe navigated to the orders page after the manual action.
    assert.ok(gotoCalls.includes(ORDERS_URL));
  });
});

test("ensureAmazonSession throws amazon_login_unexpected_ui when the manual action leaves no session", async () => {
  await withAmazonCredentials(async () => {
    const { page } = makeChallengePage({ becomeLoggedInAfterGoto: Number.POSITIVE_INFINITY });
    const interactions = makeInteractionHarness();

    await assert.rejects(
      ensureAmazonSession({
        context: makeContext(),
        fieldTimeoutMs: 1,
        page,
        sendInteraction: interactions.sendInteraction,
      }),
      /amazon_login_unexpected_ui/u
    );
    // Exactly one manual_action handoff at the email-form stage; we do not
    // hammer the operator with repeated prompts for the same challenge.
    assert.equal(interactions.requests.length, 1);
    assert.equal(interactions.requests[0]?.kind, "manual_action");
  });
});

test("ensureAmazonSession does not mask visible field-fill failures as manual challenges", async () => {
  await withAmazonCredentials(async () => {
    const { page } = makeVisibleFieldFillFailurePage();
    const interactions = makeInteractionHarness();

    await assert.rejects(
      ensureAmazonSession({
        context: makeContext(),
        page,
        sendInteraction: interactions.sendInteraction,
      }),
      /amazon_input_fill_failed/u
    );
    assert.equal(interactions.requests.length, 0);
  });
});

test("ensureAmazonSession returns true without any interaction when already logged in", async () => {
  await withAmazonCredentials(async () => {
    // becomeLoggedInAfterGoto=1 → the very first deep-probe goto lands on orders.
    const { page } = makeChallengePage({ becomeLoggedInAfterGoto: 1 });
    const interactions = makeInteractionHarness();

    const ok = await ensureAmazonSession({
      context: makeContext(),
      page,
      sendInteraction: interactions.sendInteraction,
    });

    assert.equal(ok, true);
    assert.equal(interactions.requests.length, 0);
  });
});
