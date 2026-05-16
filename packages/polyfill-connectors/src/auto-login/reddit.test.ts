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
