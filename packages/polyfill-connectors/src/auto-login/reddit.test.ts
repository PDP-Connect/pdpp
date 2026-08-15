// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import type { BrowserContext, Locator, Page } from "playwright";
import { REDDIT_RETRYABLE_PATTERN, redditEnsureSession } from "../../connectors/reddit/index.ts";
import type { InteractionRequest, InteractionResponse } from "../connector-runtime.ts";
import { establishSession, type SessionEstablishArgs } from "../session-establish.ts";
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

/** Login page whose submit control never appears — a genuinely pre-submit UI fault. */
function makePageWithMissingSubmit(): Page {
  const username = makeLocator();
  const password = makeLocator();
  const hiddenSubmit = makeLocator({ visible: false });
  const empty = makeLocator({ count: 0, visible: false });
  const fake: Pick<Page, "getByRole" | "goto" | "locator" | "waitForLoadState" | "waitForTimeout"> = {
    getByRole(_role: Parameters<Page["getByRole"]>[0], _options?: Parameters<Page["getByRole"]>[1]): Locator {
      return hiddenSubmit;
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
  return fake as Page;
}

/**
 * A context whose cookie read starts failing from `failFromCall` onward with a
 * fault message that DELIBERATELY matches `REDDIT_RETRYABLE_PATTERN`. With
 * `failFromCall: 2` the initial pre-login cookie check succeeds (empty jar),
 * the full login flow runs, and the fault propagates from the post-submit
 * cookie poll — modeling a Playwright/CDP transport loss after the password
 * went out. With `failFromCall: 1` the same fault fires before any credential
 * is touched.
 */
function makeContextWithCookieFault(failFromCall: number, faultMessage: string): BrowserContext {
  let calls = 0;
  const fake: Pick<BrowserContext, "cookies"> = {
    cookies(..._urls: Parameters<BrowserContext["cookies"]>): ReturnType<BrowserContext["cookies"]> {
      calls += 1;
      if (calls >= failFromCall) {
        return Promise.reject(new Error(faultMessage));
      }
      return Promise.resolve([]);
    },
  };
  return fake as BrowserContext;
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

// ─── Post-submit credential safety: the onCredentialSubmit marker ─────────
//
// The systemic invariant is the marker, not the vocabulary: once the password
// click fires `onCredentialSubmit`, the runtime forces every subsequent fault
// non-retryable regardless of what its message contains (proven below by
// driving the real `establishSession` through the real `redditEnsureSession`
// with a fault literal that DOES match `REDDIT_RETRYABLE_PATTERN`). The
// fixtures here pin the marker's boundary: exactly once at the submit click,
// never on session reuse, never on a pre-submit fault.

const POST_SUBMIT_TRANSPORT_FAULT = "ETIMEDOUT: browser transport lost";

function makeRedditEstablishArgs(context: BrowserContext, page: Page): SessionEstablishArgs {
  return {
    assist: () => Promise.resolve("asst_test"),
    capture: null,
    checkpoint: () => Promise.resolve(),
    completeAssistance: () => Promise.resolve(),
    context,
    name: "reddit",
    page,
    progress: () => Promise.resolve(),
    retryablePattern: REDDIT_RETRYABLE_PATTERN,
    sendInteraction: (req: InteractionRequest) =>
      Promise.resolve({
        request_id: req.request_id ?? "test_interaction",
        status: "success",
        type: "INTERACTION_RESPONSE",
      } as InteractionResponse),
  };
}

test("ensureRedditSession fires onCredentialSubmit exactly once, at the password submit click", async () => {
  await withRedditCredentials(async () => {
    let markerCalls = 0;

    await assert.rejects(
      ensureRedditSession({
        context: makeContext(),
        onCredentialSubmit: () => {
          markerCalls += 1;
        },
        page: makePageWithHiddenOtp(),
        sendInteraction: () => Promise.reject(new Error("sendInteraction must not be called")),
      }),
      /reddit_login_post_submit_failed/u
    );

    assert.equal(markerCalls, 1, "full login flow must mark the credential submit exactly once");
  });
});

test("ensureRedditSession fires onCredentialSubmit exactly once via the CSS-fallback submit path too", async () => {
  await withRedditCredentials(async () => {
    let markerCalls = 0;
    const username = makeLocator();
    const password = makeLocator();
    const submit = makeLocator();
    const empty = makeLocator({ count: 0, visible: false });
    // No getByRole on this page shape, so clickRedditLoginSubmit must take
    // its CSS-selector fallback branch — the second marker call site.
    const page: Pick<Page, "goto" | "locator" | "waitForLoadState" | "waitForTimeout"> = {
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
        if (selector.includes('button[type="submit"]')) {
          return submit;
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

    await assert.rejects(
      ensureRedditSession({
        context: makeContext(),
        onCredentialSubmit: () => {
          markerCalls += 1;
        },
        page: page as Page,
        sendInteraction: () => Promise.reject(new Error("sendInteraction must not be called")),
      }),
      /reddit_login_post_submit_failed/u
    );

    assert.equal(markerCalls, 1, "the fallback submit click must mark the credential submit exactly once");
  });
});

test("ensureRedditSession never fires onCredentialSubmit when the existing session is reused (COUNTERWEIGHT)", async () => {
  await withRedditCredentials(async () => {
    let markerCalls = 0;
    const liveCookie = { name: "reddit_session", value: "live-session" } as BrowserCookie;

    await ensureRedditSession({
      context: makeContext([liveCookie]),
      onCredentialSubmit: () => {
        markerCalls += 1;
      },
      // Fixture renders a logout link, so the reuse probe reports live.
      page: makePageWithVisibleOtpAndLiveSessionAfterBrowserCompletion(),
      sendInteraction: () => Promise.reject(new Error("sendInteraction must not be called")),
    });

    assert.equal(markerCalls, 0, "session reuse must not report a credential submit that never happened");
  });
});

test("ensureRedditSession does not fire onCredentialSubmit when the submit control is missing (pre-submit stays pre-submit)", async () => {
  await withRedditCredentials(async () => {
    let markerCalls = 0;

    await assert.rejects(
      ensureRedditSession({
        context: makeContext(),
        onCredentialSubmit: () => {
          markerCalls += 1;
        },
        page: makePageWithMissingSubmit(),
        sendInteraction: () => Promise.reject(new Error("sendInteraction must not be called")),
      }),
      /reddit_login_submit_missing/u
    );

    assert.equal(markerCalls, 0, "a login that never submitted must not claim the credential went out");
  });
});

test("establishSession via redditEnsureSession: a post-submit fault is non-retryable even when its literal matches REDDIT_RETRYABLE_PATTERN", async () => {
  await withRedditCredentials(async () => {
    // Oracle precondition: this fault WOULD be retryable by vocabulary alone.
    // If it stopped matching, this test would degrade into the literal-based
    // guarantee we are replacing, so pin the collision explicitly.
    assert.equal(REDDIT_RETRYABLE_PATTERN.test(POST_SUBMIT_TRANSPORT_FAULT), true);

    await assert.rejects(
      establishSession(
        { ensureSession: redditEnsureSession, probeSession: undefined },
        makeRedditEstablishArgs(makeContextWithCookieFault(2, POST_SUBMIT_TRANSPORT_FAULT), makePageWithHiddenOtp())
      ),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /reddit_session_failed: ETIMEDOUT: browser transport lost/u);
        assert.equal(
          (err as { retryable?: boolean }).retryable,
          false,
          "a fault after the password went out must never redispatch, whatever its message says"
        );
        return true;
      }
    );
  });
});

test("establishSession via redditEnsureSession: the same fault BEFORE the password goes out stays retryable (COUNTERWEIGHT)", async () => {
  await withRedditCredentials(async () => {
    await assert.rejects(
      establishSession(
        { ensureSession: redditEnsureSession, probeSession: undefined },
        makeRedditEstablishArgs(makeContextWithCookieFault(1, POST_SUBMIT_TRANSPORT_FAULT), makePageWithHiddenOtp())
      ),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /reddit_session_failed: ETIMEDOUT: browser transport lost/u);
        assert.equal(
          (err as { retryable?: boolean }).retryable,
          true,
          "pre-submit transport faults must keep their ordinary pattern classification"
        );
        return true;
      }
    );
  });
});

// ─── B5-shaped regression: Reddit's retryablePattern has no naming collision ─
//
// Defense-in-depth behind the marker above: even for the throw literals
// `reddit.ts` itself produces, the retry vocabulary must not collide. This
// feeds every post-submit throw string `reddit.ts` can actually produce, plus
// the runtime's own `${name}_session_failed:` wrapping (see
// `buildSessionEstablishTerminalError`), through the real exported
// `REDDIT_RETRYABLE_PATTERN` and asserts none match. A future edit that adds
// a bare transport term (as USAA's `source_unavailable` did) breaks this
// test immediately instead of silently reopening the mode-1 defect class.
const REDDIT_POST_SUBMIT_THROW_MESSAGES = [
  "reddit_login_submit_missing",
  "reddit_2fa_cancelled",
  "reddit_login_post_submit_failed",
] as const;

test("REDDIT_RETRYABLE_PATTERN does not match any post-submit throw message reddit.ts can produce", () => {
  for (const message of REDDIT_POST_SUBMIT_THROW_MESSAGES) {
    assert.equal(
      REDDIT_RETRYABLE_PATTERN.test(message),
      false,
      `${message} must not match REDDIT_RETRYABLE_PATTERN — a match here would let a post-submit fault redispatch and resubmit the saved password`
    );
  }
});

test("REDDIT_RETRYABLE_PATTERN does not match the runtime's session_failed-wrapped form of any post-submit throw", () => {
  for (const message of REDDIT_POST_SUBMIT_THROW_MESSAGES) {
    const wrapped = `reddit_session_failed: ${message}`;
    assert.equal(REDDIT_RETRYABLE_PATTERN.test(wrapped), false, `${wrapped} must not match REDDIT_RETRYABLE_PATTERN`);
  }
});

test("REDDIT_RETRYABLE_PATTERN still matches its intended legitimate pre-submit retry vocabulary (COUNTERWEIGHT)", () => {
  // Proves the non-collision tests above aren't vacuously true because the
  // pattern matches nothing at all.
  for (const message of ["ECONNRESET", "ETIMEDOUT", "fetch failed: network error", "reddit_rate_limited"]) {
    assert.equal(REDDIT_RETRYABLE_PATTERN.test(message), true, `${message} should still be retryable`);
  }
});
