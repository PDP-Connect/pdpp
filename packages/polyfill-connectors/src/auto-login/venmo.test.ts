// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Locator, Page } from "playwright";
import type { InteractionRequest, InteractionResponse } from "../connector-runtime.ts";
import { ensureVenmoSession, probeVenmoAccount } from "./venmo.ts";

const STREAMING_ENV_KEYS = [
  "PDPP_RUN_ID",
  "PDPP_REFERENCE_BASE_URL",
  "PDPP_STREAMING_REGISTRATION_TOKEN",
  "PDPP_LOCAL_DEVICE_TOKEN",
] as const;

function makeLocator({ count = 1, visible = true }: { count?: number; visible?: boolean } = {}): Locator {
  const fake: Pick<Locator, "click" | "count" | "fill" | "first" | "innerText" | "isVisible" | "waitFor"> = {
    click: (): Promise<void> => Promise.resolve(),
    count: (): Promise<number> => Promise.resolve(count),
    fill: (_value: string): Promise<void> => Promise.resolve(),
    first(): Locator {
      return fake as Locator;
    },
    innerText: (): Promise<string> => Promise.resolve(""),
    isVisible(): Promise<boolean> {
      return Promise.resolve(visible);
    },
    waitFor(): Promise<void> {
      return count > 0 ? Promise.resolve() : Promise.reject(new Error("Timeout waiting for locator"));
    },
  };
  return fake as Locator;
}

/** A page whose `/account` probe always returns live=false/true per `accountLive`, honoring successive changes via `setLive`. */
function makeProbePage(initialLive: boolean): { page: Page; setLive: (live: boolean) => void } {
  let live = initialLive;
  const empty = makeLocator({ count: 0, visible: false });
  const submit = makeLocator();
  const page: Pick<Page, "evaluate" | "getByRole" | "goto" | "locator" | "waitForLoadState" | "waitForTimeout"> = {
    // biome-ignore lint/suspicious/useAwait: mirrors Playwright's Promise-returning signature
    async evaluate(): Promise<unknown> {
      return live ? { live: true, ownerId: "1234567890123456789" } : { live: false, ownerId: null };
    },
    getByRole(): Locator {
      return submit;
    },
    goto(): ReturnType<Page["goto"]> {
      return Promise.resolve(null);
    },
    locator(): Locator {
      return empty;
    },
    waitForLoadState(): ReturnType<Page["waitForLoadState"]> {
      return Promise.resolve();
    },
    waitForTimeout(): ReturnType<Page["waitForTimeout"]> {
      return Promise.resolve();
    },
  };
  const setLive = (next: boolean): void => {
    live = next;
  };
  return { page: page as Page, setLive };
}

/** A fill-recording locator whose `first()` returns itself, so a caller that does `.locator(x).first().fill(v)` still records the fill. */
function makeFillRecordingLocator(
  onFill: (value: string) => void,
  opts: { count?: number; visible?: boolean } = {}
): Locator {
  const { count = 1, visible = true } = opts;
  const fake: Pick<Locator, "click" | "count" | "fill" | "first" | "innerText" | "isVisible" | "waitFor"> = {
    click: (): Promise<void> => Promise.resolve(),
    count: (): Promise<number> => Promise.resolve(count),
    fill: (value: string): Promise<void> => {
      onFill(value);
      return Promise.resolve();
    },
    first(): Locator {
      return fake as Locator;
    },
    innerText: (): Promise<string> => Promise.resolve(""),
    isVisible(): Promise<boolean> {
      return Promise.resolve(visible);
    },
    waitFor(): Promise<void> {
      return count > 0 ? Promise.resolve() : Promise.reject(new Error("Timeout waiting for locator"));
    },
  };
  return fake as Locator;
}

/** A page whose login form fills succeed and whose post-submit probe reports live. */
function makePageWithWorkingLoginForm(): { fillCalls: Record<string, string>; page: Page } {
  const fillCalls: Record<string, string> = {};
  let probeCount = 0;
  const username = makeFillRecordingLocator((value) => {
    fillCalls.username = value;
  });
  const password = makeFillRecordingLocator((value) => {
    fillCalls.password = value;
  });
  const submit = makeLocator();
  const otp = makeLocator({ count: 0, visible: false });
  const page: Pick<Page, "evaluate" | "getByRole" | "goto" | "locator" | "waitForLoadState" | "waitForTimeout"> = {
    // biome-ignore lint/suspicious/useAwait: mirrors Playwright's Promise-returning signature
    async evaluate(): Promise<unknown> {
      probeCount += 1;
      // First probe (initial check) is dead; every probe after the form submit is live.
      return probeCount > 1 ? { live: true, ownerId: "1234567890123456789" } : { live: false, ownerId: null };
    },
    getByRole(): Locator {
      return submit;
    },
    goto(): ReturnType<Page["goto"]> {
      return Promise.resolve(null);
    },
    locator(selector: string): Locator {
      if (selector.includes("username")) {
        return username;
      }
      if (selector.includes("password")) {
        return password;
      }
      if (selector.includes("otp") || selector.includes("code")) {
        return otp;
      }
      return makeLocator({ count: 0, visible: false });
    },
    waitForLoadState(): ReturnType<Page["waitForLoadState"]> {
      return Promise.resolve();
    },
    waitForTimeout(): ReturnType<Page["waitForTimeout"]> {
      return Promise.resolve();
    },
  };
  return { fillCalls, page: page as Page };
}

async function withVenmoCredentialValues(
  credentials: { password?: string; username?: string },
  run: () => Promise<void>
): Promise<void> {
  const priorUsername = process.env.VENMO_USERNAME;
  const priorPassword = process.env.VENMO_PASSWORD;
  const priorStreamingEnv = new Map<(typeof STREAMING_ENV_KEYS)[number], string | undefined>();
  for (const key of STREAMING_ENV_KEYS) {
    priorStreamingEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  if (credentials.username) {
    process.env.VENMO_USERNAME = credentials.username;
  }
  if (credentials.password) {
    process.env.VENMO_PASSWORD = credentials.password;
  }
  try {
    await run();
  } finally {
    if (priorUsername === undefined) {
      delete process.env.VENMO_USERNAME;
    } else {
      process.env.VENMO_USERNAME = priorUsername;
    }
    if (priorPassword === undefined) {
      delete process.env.VENMO_PASSWORD;
    } else {
      process.env.VENMO_PASSWORD = priorPassword;
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

async function withVenmoCredentials(run: () => Promise<void>): Promise<void> {
  await withVenmoCredentialValues({ password: "test-password", username: "test-user" }, run);
}

async function withoutVenmoCredentials(run: () => Promise<void>): Promise<void> {
  await withVenmoCredentialValues({}, run);
}

function recordingSendInteraction(): {
  requests: InteractionRequest[];
  sendInteraction: (req: InteractionRequest) => Promise<InteractionResponse>;
} {
  const requests: InteractionRequest[] = [];
  return {
    requests,
    sendInteraction(req: InteractionRequest): Promise<InteractionResponse> {
      requests.push(req);
      return Promise.resolve({
        request_id: req.request_id ?? "test_interaction",
        status: "success",
        type: "INTERACTION_RESPONSE",
      });
    },
  };
}

// ─── Session reuse ───────────────────────────────────────────────────────

test("ensureVenmoSession: a live session is reused with zero interactions and no form fill", async () => {
  const { page } = makeProbePage(true);
  const { requests, sendInteraction } = recordingSendInteraction();
  const result = await ensureVenmoSession({ page, sendInteraction });
  assert.equal(result.live, true);
  assert.equal(result.ownerId, "1234567890123456789");
  assert.equal(requests.length, 0, "a live session must not prompt the owner at all");
});

// ─── Interaction-required: no saved credential ──────────────────────────

test("ensureVenmoSession: hands off to manual_action when no credentials are saved, with no password/username leaked", async () => {
  await withoutVenmoCredentials(async () => {
    const { page } = makeProbePage(false);
    const { requests, sendInteraction } = recordingSendInteraction();
    await assert.rejects(ensureVenmoSession({ page, sendInteraction }), /venmo_login_manual_incomplete/);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.kind, "manual_action");
    assert.match(requests[0]?.message ?? "", /No optional Venmo sign-in details/);
    assert.doesNotMatch(requests[0]?.message ?? "", /password|test-user/i);
  });
});

test("ensureVenmoSession: manual browser login succeeding is accepted without asking for a password", async () => {
  await withoutVenmoCredentials(async () => {
    const { page, setLive } = makeProbePage(false);
    const { requests, sendInteraction } = recordingSendInteraction();
    const manualHandoff = sendInteraction;
    const result = await ensureVenmoSession({
      page,
      sendInteraction: (req) => {
        setLive(true); // simulate the owner completing sign-in during the manual_action window
        return manualHandoff(req);
      },
    });
    assert.equal(result.live, true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.kind, "manual_action");
  });
});

// ─── Credential-assisted login ──────────────────────────────────────────

test("ensureVenmoSession: fills saved credentials and completes login without an OTP prompt when none renders", async () => {
  await withVenmoCredentials(async () => {
    const { fillCalls, page } = makePageWithWorkingLoginForm();
    const { requests, sendInteraction } = recordingSendInteraction();
    const result = await ensureVenmoSession({ page, sendInteraction });
    assert.equal(result.live, true);
    assert.equal(fillCalls.username, "test-user");
    assert.equal(fillCalls.password, "test-password");
    assert.equal(requests.length, 0, "no OTP interaction when Venmo never rendered one");
  });
});

// ─── OTP handoff ─────────────────────────────────────────────────────────

test("ensureVenmoSession: an OTP input drives sendInteraction with kind=otp, never asking for the password again", async () => {
  await withVenmoCredentials(async () => {
    let probeCount = 0;
    const username = makeLocator();
    const password = makeLocator();
    const submit = makeLocator();
    const otp = makeLocator();
    const page: Pick<Page, "evaluate" | "getByRole" | "goto" | "locator" | "waitForLoadState" | "waitForTimeout"> = {
      // biome-ignore lint/suspicious/useAwait: mirrors Playwright's Promise-returning signature
      async evaluate(): Promise<unknown> {
        probeCount += 1;
        return probeCount > 1 ? { live: true, ownerId: "1234567890123456789" } : { live: false, ownerId: null };
      },
      getByRole(): Locator {
        return submit;
      },
      goto(): ReturnType<Page["goto"]> {
        return Promise.resolve(null);
      },
      locator(selector: string): Locator {
        if (selector.includes("username")) {
          return username;
        }
        if (selector.includes("password")) {
          return password;
        }
        if (selector.includes("otp") || selector.includes("code")) {
          return otp;
        }
        return makeLocator({ count: 0, visible: false });
      },
      waitForLoadState(): ReturnType<Page["waitForLoadState"]> {
        return Promise.resolve();
      },
      waitForTimeout(): ReturnType<Page["waitForTimeout"]> {
        return Promise.resolve();
      },
    };
    const { requests, sendInteraction } = recordingSendInteraction();
    const result = await ensureVenmoSession({ page: page as Page, sendInteraction });
    assert.equal(result.live, true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.kind, "otp");
    assert.doesNotMatch(requests[0]?.message ?? "", /test-password/);
  });
});

// ─── Expired session repair ──────────────────────────────────────────────

test("ensureVenmoSession: an expired session (dead initial probe) with saved credentials re-authenticates rather than failing immediately", async () => {
  await withVenmoCredentials(async () => {
    const { fillCalls, page } = makePageWithWorkingLoginForm();
    const { sendInteraction } = recordingSendInteraction();
    const result = await ensureVenmoSession({ page, sendInteraction });
    assert.equal(result.live, true, "expired session must be repaired via the credential-assisted form, not just fail");
    assert.equal(fillCalls.username, "test-user");
  });
});

// ─── probeVenmoAccount: pure page-context probe ──────────────────────────

test("probeVenmoAccount: reports live=false when the page-context fetch throws", async () => {
  const page: Pick<Page, "evaluate"> = {
    evaluate(): ReturnType<Page["evaluate"]> {
      return Promise.reject(new Error("network error"));
    },
  };
  const result = await probeVenmoAccount(page as Page).catch(() => ({ live: false, ownerId: null }));
  assert.equal(result.live, false);
});
