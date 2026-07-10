import assert from "node:assert/strict";
import { test } from "node:test";
import type { BrowserContext, Locator, Page } from "playwright";
import type { InteractionRequest, InteractionResponse } from "../connector-runtime.ts";
import { ensureChatGptSession } from "./chatgpt.ts";

/**
 * Regression coverage for the unexpected-login-UI (Cloudflare-challenge)
 * fallback. The operator is told to "complete login in the streaming
 * companion." Completing that manual step must let the connector continue when
 * the session is now active, and must only fail when login still has not
 * happened. Earlier the connector threw `chatgpt_login_unexpected_ui`
 * unconditionally after the operator's manual step, so "I completed login"
 * always ended the run even after a successful challenge.
 */

// Streaming registration env must be unset so the manual-action handoff fails
// closed (no CDP/network) and the test exercises only the login control flow.
const STREAMING_ENV_KEYS = [
  "PDPP_RUN_ID",
  "PDPP_REFERENCE_BASE_URL",
  "PDPP_STREAMING_REGISTRATION_TOKEN",
  "PDPP_LOCAL_DEVICE_TOKEN",
] as const;

function makeContext(): BrowserContext {
  return {} as BrowserContext;
}

const noopLocator: Pick<Locator, "click" | "count" | "fill" | "first" | "waitFor"> = {
  click: (): Promise<void> => Promise.resolve(),
  count: (): Promise<number> => Promise.resolve(0),
  fill: (_value: string): Promise<void> => Promise.resolve(),
  first(): Locator {
    return noopLocator as Locator;
  },
  // Never-visible: clickFirstVisible / hasVisibleText resolve to "not found".
  waitFor: (): Promise<void> => Promise.reject(new Error("not visible")),
};

/**
 * A page whose login inputs never appear (the Cloudflare-challenge shape) and
 * whose session probe (`page.evaluate`) reports active/inactive on demand.
 */
function makeChallengePage(sessionActive: () => boolean): Page {
  const fake: Pick<Page, "context" | "evaluate" | "getByRole" | "getByText" | "goto" | "locator" | "waitForTimeout"> = {
    context(): BrowserContext {
      return makeContext();
    },
    // checkSession() expects { user } when active; checkLoggedInViaDOM() expects
    // a boolean. Returning the active flag for both keeps the probe honest.
    evaluate(fn: unknown): Promise<unknown> {
      const active = sessionActive();
      // The DOM probe returns a boolean; the session probe returns an object.
      if (typeof fn === "function" && fn.toString().includes("querySelectorAll")) {
        return Promise.resolve(active);
      }
      return Promise.resolve(active ? { user: { id: "u" } } : null);
    },
    getByRole(): Locator {
      return noopLocator as Locator;
    },
    getByText(): Locator {
      return noopLocator as Locator;
    },
    goto(): ReturnType<Page["goto"]> {
      return Promise.resolve(null);
    },
    locator(): Locator {
      return noopLocator as Locator;
    },
    waitForTimeout(): Promise<void> {
      return Promise.resolve();
    },
  };
  return fake as Page;
}

async function withChatGptCredentials(run: () => Promise<void>): Promise<void> {
  const prior = new Map<string, string | undefined>();
  for (const key of [...STREAMING_ENV_KEYS, "CHATGPT_USERNAME", "CHATGPT_PASSWORD"]) {
    prior.set(key, process.env[key]);
  }
  for (const key of STREAMING_ENV_KEYS) {
    delete process.env[key];
  }
  process.env.CHATGPT_USERNAME = "test-user@example.com";
  process.env.CHATGPT_PASSWORD = "test-password";
  try {
    await run();
  } finally {
    for (const [key, value] of prior) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function manualActionResponder(requests: InteractionRequest[]) {
  return (req: InteractionRequest): Promise<InteractionResponse> => {
    requests.push(req);
    return Promise.resolve({
      request_id: req.request_id ?? "test_interaction",
      status: "success",
      type: "INTERACTION_RESPONSE",
    });
  };
}

test("ensureChatGptSession continues when the operator completes login during the unexpected-UI fallback", async () => {
  await withChatGptCredentials(async () => {
    const requests: InteractionRequest[] = [];
    // Session is inactive until the operator completes the manual step, then
    // active — modelling a Cloudflare challenge solved in the stream.
    let completedManualStep = false;

    const responder = (req: InteractionRequest): Promise<InteractionResponse> => {
      requests.push(req);
      completedManualStep = true;
      return Promise.resolve({
        request_id: req.request_id ?? "test_interaction",
        status: "success",
        type: "INTERACTION_RESPONSE",
      });
    };

    const result = await ensureChatGptSession({
      context: makeContext(),
      page: makeChallengePage(() => completedManualStep),
      sendInteraction: responder,
    });

    assert.equal(result, true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.kind, "manual_action");
    // Owner-facing copy is the standardized sign-in handoff message
    // (repair-owner-action-handoff); the Cloudflare specifics now travel as
    // maintainer diagnostics, not owner interaction copy.
    assert.match(requests[0]?.message ?? "", /could not finish sign-in automatically/u);
  });
});

test("ensureChatGptSession fails only when login still has not happened after the manual step", async () => {
  await withChatGptCredentials(async () => {
    const requests: InteractionRequest[] = [];

    await assert.rejects(
      ensureChatGptSession({
        context: makeContext(),
        // Session never becomes active — operator dismissed without logging in.
        page: makeChallengePage(() => false),
        sendInteraction: manualActionResponder(requests),
      }),
      /chatgpt_login_unexpected_ui/u
    );

    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.kind, "manual_action");
  });
});
