// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import type { BrowserContext, Locator, Page } from "playwright";
import type { InteractionRequest, InteractionResponse } from "../connector-runtime.ts";
import { ensureRedditSession } from "./reddit.ts";

type BrowserCookie = Awaited<ReturnType<BrowserContext["cookies"]>>[number];
const STREAMING_ENV_KEYS = [
  "PDPP_RUN_ID",
  "PDPP_REFERENCE_BASE_URL",
  "PDPP_STREAMING_REGISTRATION_TOKEN",
  "PDPP_LOCAL_DEVICE_TOKEN",
] as const;

function makeContext(cookies: BrowserCookie[] = []): BrowserContext {
  const fake: Pick<BrowserContext, "cookies"> = {
    cookies(..._urls: Parameters<BrowserContext["cookies"]>): ReturnType<BrowserContext["cookies"]> {
      return Promise.resolve(cookies);
    },
  };
  return fake as BrowserContext;
}

function makePageWithoutLoginInputs(): Page {
  // Mirrors real Playwright: `waitFor` rejects on timeout when the element
  // never attaches (never resolves `undefined` the way a stubbed no-op would).
  const emptyLocator: Pick<Locator, "count" | "first" | "waitFor"> = {
    count: (): Promise<number> => Promise.resolve(0),
    first(): Locator {
      return emptyLocator as Locator;
    },
    waitFor: (): Promise<void> => Promise.reject(new Error("Timeout waiting for locator")),
  };
  const fake: Pick<Page, "goto" | "locator"> = {
    goto(_url: string, _options?: Parameters<Page["goto"]>[1]): ReturnType<Page["goto"]> {
      return Promise.resolve(null);
    },
    locator(_selector: string, _options?: Parameters<Page["locator"]>[1]): Locator {
      return emptyLocator as Locator;
    },
  };
  return fake as Page;
}

function makeLocator({ count = 1, visible = true }: { count?: number; visible?: boolean } = {}): Locator {
  const fake: Pick<Locator, "click" | "count" | "fill" | "first" | "isVisible" | "waitFor"> = {
    click: (): Promise<void> => Promise.resolve(),
    count: (): Promise<number> => Promise.resolve(count),
    fill: (_value: string): Promise<void> => Promise.resolve(),
    first(): Locator {
      return fake as Locator;
    },
    isVisible(): Promise<boolean> {
      return Promise.resolve(visible);
    },
    waitFor(): Promise<void> {
      return count > 0 ? Promise.resolve() : Promise.reject(new Error("Timeout waiting for locator"));
    },
  };
  return fake as Locator;
}

/** Models the login input attaching to the DOM after a render delay. */
function makeDelayedAttachLocator({ attachesAfterMs }: { attachesAfterMs: number }): {
  fillCalls: string[];
  locator: Locator;
} {
  const start = Date.now();
  const fillCalls: string[] = [];
  const attached = (): boolean => Date.now() - start >= attachesAfterMs;
  const fake: Pick<Locator, "click" | "count" | "fill" | "first" | "isVisible" | "waitFor"> = {
    click: (): Promise<void> => Promise.resolve(),
    count: (): Promise<number> => Promise.resolve(attached() ? 1 : 0),
    fill: (value: string): Promise<void> => {
      fillCalls.push(value);
      return Promise.resolve();
    },
    first(): Locator {
      return fake as Locator;
    },
    isVisible(): Promise<boolean> {
      return Promise.resolve(attached());
    },
    async waitFor(options?: Parameters<Locator["waitFor"]>[0]): Promise<void> {
      const timeout = options?.timeout ?? 30_000;
      const deadline = Date.now() + timeout;
      while (!attached()) {
        if (Date.now() >= deadline) {
          throw new Error("Timeout waiting for locator to be attached");
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
  };
  return { fillCalls, locator: fake as Locator };
}

function makePageWithHiddenOtp(): Page {
  const username = makeLocator();
  const password = makeLocator();
  const hiddenOtp = makeLocator({ visible: false });
  const empty = makeLocator({ count: 0, visible: false });
  const submit = makeLocator();
  const fake: Pick<Page, "getByRole" | "goto" | "locator" | "waitForLoadState" | "waitForTimeout"> = {
    getByRole(_role: Parameters<Page["getByRole"]>[0], _options?: Parameters<Page["getByRole"]>[1]): Locator {
      return submit;
    },
    goto(_url: string, _options?: Parameters<Page["goto"]>[1]): ReturnType<Page["goto"]> {
      return Promise.resolve(null);
    },
    locator(selector: string, _options?: Parameters<Page["locator"]>[1]): Locator {
      if (selector.includes("username")) {
        return username;
      }
      if (selector.includes("password")) {
        return password;
      }
      if (selector.includes("otp") || selector.includes("verification_code") || selector.includes("one-time-code")) {
        return hiddenOtp;
      }
      return empty;
    },
    waitForLoadState(): ReturnType<Page["waitForLoadState"]> {
      return Promise.resolve();
    },
    waitForTimeout(): ReturnType<Page["waitForTimeout"]> {
      return Promise.resolve();
    },
  };
  return fake as Page;
}

function makePageWithVisibleOtpAndLiveSessionAfterBrowserCompletion(): Page {
  const username = makeLocator();
  const password = makeLocator();
  const visibleOtp = makeLocator();
  const submit = makeLocator();
  const logout = makeLocator();
  const empty = makeLocator({ count: 0, visible: false });
  const fake: Pick<Page, "getByRole" | "goto" | "locator" | "waitForLoadState" | "waitForTimeout"> = {
    getByRole(_role: Parameters<Page["getByRole"]>[0], _options?: Parameters<Page["getByRole"]>[1]): Locator {
      return submit;
    },
    goto(_url: string, _options?: Parameters<Page["goto"]>[1]): ReturnType<Page["goto"]> {
      return Promise.resolve(null);
    },
    locator(selector: string, _options?: Parameters<Page["locator"]>[1]): Locator {
      if (selector.includes("/logout") || selector.includes("logout")) {
        return logout;
      }
      if (selector.includes("username")) {
        return username;
      }
      if (selector.includes("password")) {
        return password;
      }
      if (selector.includes("otp") || selector.includes("verification_code") || selector.includes("one-time-code")) {
        return visibleOtp;
      }
      return empty;
    },
    waitForLoadState(): ReturnType<Page["waitForLoadState"]> {
      return Promise.resolve();
    },
    waitForTimeout(): ReturnType<Page["waitForTimeout"]> {
      return Promise.resolve();
    },
  };
  return fake as Page;
}

async function withRedditCredentialValues(
  credentials: { password?: string; username?: string },
  run: () => Promise<void>
): Promise<void> {
  const priorUsername = process.env.REDDIT_USERNAME;
  const priorPassword = process.env.REDDIT_PASSWORD;
  const priorStreamingEnv = new Map<(typeof STREAMING_ENV_KEYS)[number], string | undefined>();
  for (const key of STREAMING_ENV_KEYS) {
    priorStreamingEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  if (credentials.username) {
    process.env.REDDIT_USERNAME = credentials.username;
  }
  if (credentials.password) {
    process.env.REDDIT_PASSWORD = credentials.password;
  }
  try {
    await run();
  } finally {
    if (priorUsername === undefined) {
      delete process.env.REDDIT_USERNAME;
    } else {
      process.env.REDDIT_USERNAME = priorUsername;
    }
    if (priorPassword === undefined) {
      delete process.env.REDDIT_PASSWORD;
    } else {
      process.env.REDDIT_PASSWORD = priorPassword;
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

async function withRedditCredentials(run: () => Promise<void>): Promise<void> {
  await withRedditCredentialValues({ password: "test-password", username: "test-user" }, run);
}

async function withoutRedditCredentials(run: () => Promise<void>): Promise<void> {
  await withRedditCredentialValues({}, run);
}

test("ensureRedditSession hands off when optional credentials are absent", async () => {
  await withoutRedditCredentials(async () => {
    const requests: InteractionRequest[] = [];

    await assert.rejects(
      ensureRedditSession({
        context: makeContext(),
        page: makePageWithoutLoginInputs(),
        sendInteraction(req: InteractionRequest): Promise<InteractionResponse> {
          requests.push(req);
          return Promise.resolve({
            request_id: req.request_id ?? "test_interaction",
            status: "success",
            type: "INTERACTION_RESPONSE",
          });
        },
      }),
      /reddit_login_manual_incomplete/u
    );

    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.kind, "manual_action");
    assert.match(requests[0]?.message ?? "", /No optional Reddit sign-in details/);
    assert.doesNotMatch(requests[0]?.message ?? "", /password|test-user/u);
  });
});

test("ensureRedditSession emits manual_action when login inputs are blocked", async () => {
  await withRedditCredentials(async () => {
    const requests: InteractionRequest[] = [];

    await assert.rejects(
      ensureRedditSession({
        context: makeContext(),
        page: makePageWithoutLoginInputs(),
        sendInteraction(req: InteractionRequest): Promise<InteractionResponse> {
          requests.push(req);
          return Promise.resolve({
            request_id: req.request_id ?? "test_interaction",
            status: "success",
            type: "INTERACTION_RESPONSE",
          });
        },
      }),
      /reddit_login_unexpected_ui/u
    );

    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.kind, "manual_action");
    assert.ok(requests[0]?.request_id?.startsWith("int_"));
    assert.match(requests[0]?.message ?? "", /Cloudflare challenge/u);
  });
});

test("ensureRedditSession waits past a slow client-side render instead of treating it as blocked", async () => {
  await withRedditCredentials(async () => {
    const requests: InteractionRequest[] = [];
    const { fillCalls, locator: username } = makeDelayedAttachLocator({ attachesAfterMs: 150 });
    const password = makeLocator();
    const submit = makeLocator();
    const empty = makeLocator({ count: 0, visible: false });
    const page: Pick<Page, "getByRole" | "goto" | "locator" | "waitForLoadState" | "waitForTimeout"> = {
      getByRole(_role: Parameters<Page["getByRole"]>[0], _options?: Parameters<Page["getByRole"]>[1]): Locator {
        return submit;
      },
      goto(_url: string, _options?: Parameters<Page["goto"]>[1]): ReturnType<Page["goto"]> {
        return Promise.resolve(null);
      },
      locator(selector: string, _options?: Parameters<Page["locator"]>[1]): Locator {
        if (selector.includes("username")) {
          return username;
        }
        if (selector.includes("password")) {
          return password;
        }
        return empty;
      },
      waitForLoadState(): ReturnType<Page["waitForLoadState"]> {
        return Promise.resolve();
      },
      waitForTimeout(): ReturnType<Page["waitForTimeout"]> {
        return Promise.resolve();
      },
    };

    // The run doesn't reach a live session in this fixture (no cookie
    // machinery wired up) — the assertion is about the fill, not the outcome.
    await assert.rejects(
      ensureRedditSession({
        context: makeContext(),
        page: page as Page,
        sendInteraction(req: InteractionRequest): Promise<InteractionResponse> {
          requests.push(req);
          return Promise.resolve({
            request_id: req.request_id ?? "test_interaction",
            status: "success",
            type: "INTERACTION_RESPONSE",
          });
        },
      })
    );

    // The pre-fix `count()` snapshot would have read 0 at t=0 and handed off
    // to the operator without ever calling fill(); the correct behavior is
    // to wait past the render delay and fill the real value.
    assert.deepEqual(fillCalls, ["test-user"]);
    assert.equal(requests.length, 0, "must not hand off to the operator for a field that arrives within budget");
  });
});

test("ensureRedditSession ignores hidden OTP fields instead of asking the owner too early", async () => {
  await withRedditCredentials(async () => {
    const requests: InteractionRequest[] = [];

    await assert.rejects(
      ensureRedditSession({
        context: makeContext(),
        page: makePageWithHiddenOtp(),
        sendInteraction(req: InteractionRequest): Promise<InteractionResponse> {
          requests.push(req);
          return Promise.resolve({
            request_id: req.request_id ?? "test_interaction",
            status: "success",
            type: "INTERACTION_RESPONSE",
          });
        },
      }),
      /reddit_login_post_submit_failed/u
    );

    assert.equal(requests.length, 0);
  });
});

test("ensureRedditSession accepts browser-completed OTP when the session is live", async () => {
  await withRedditCredentials(async () => {
    const requests: InteractionRequest[] = [];

    await ensureRedditSession({
      context: makeContext(),
      page: makePageWithVisibleOtpAndLiveSessionAfterBrowserCompletion(),
      sendInteraction(req: InteractionRequest): Promise<InteractionResponse> {
        requests.push(req);
        return Promise.resolve({
          request_id: req.request_id ?? "test_interaction",
          status: "success",
          type: "INTERACTION_RESPONSE",
        });
      },
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.kind, "otp");
  });
});
