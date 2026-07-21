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
  const emptyLocator: Pick<Locator, "count" | "first"> = {
    count: (): Promise<number> => Promise.resolve(0),
    first(): Locator {
      return emptyLocator as Locator;
    },
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
  const fake: Pick<Locator, "click" | "count" | "fill" | "first" | "isVisible"> = {
    click: (): Promise<void> => Promise.resolve(),
    count: (): Promise<number> => Promise.resolve(count),
    fill: (_value: string): Promise<void> => Promise.resolve(),
    first(): Locator {
      return fake as Locator;
    },
    isVisible(): Promise<boolean> {
      return Promise.resolve(visible);
    },
  };
  return fake as Locator;
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

async function withRedditCredentials(run: () => Promise<void>): Promise<void> {
  const priorUsername = process.env.REDDIT_USERNAME;
  const priorPassword = process.env.REDDIT_PASSWORD;
  const priorStreamingEnv = new Map<(typeof STREAMING_ENV_KEYS)[number], string | undefined>();
  for (const key of STREAMING_ENV_KEYS) {
    priorStreamingEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.REDDIT_USERNAME = "test-user";
  process.env.REDDIT_PASSWORD = "test-password";
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
