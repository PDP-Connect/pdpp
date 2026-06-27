import assert from "node:assert/strict";
import { test } from "node:test";
import type { InteractionResponse } from "../connector-runtime.ts";
import {
  CHATGPT_PUSH_APPROVAL_ASSISTANCE_MESSAGE,
  CHATGPT_PUSH_APPROVAL_FALLBACK_MESSAGE,
  CHATGPT_PUSH_APPROVAL_PROGRESS_MESSAGE,
  chatGptPushApprovalAssistance,
  ensureChatGptSession,
  interactionResponseCode,
  isLikelyChatGptPushApprovalText,
  resolveChatGptPushApprovalTimeoutMs,
} from "./chatgpt.ts";

function response(extra: Partial<InteractionResponse>): InteractionResponse {
  return {
    request_id: "test_interaction",
    status: "success",
    type: "INTERACTION_RESPONSE",
    ...extra,
  };
}

function extractAuthProbeDiagnostic(message: string): Record<string, unknown> {
  const prefix = "ChatGPT auth probe diagnostic ";
  assert.equal(message.startsWith(prefix), true);
  return JSON.parse(message.slice(prefix.length)) as Record<string, unknown>;
}

function withEnvUnset(keys: readonly string[], run: () => Promise<void>): Promise<void> {
  const prior = new Map<string, string | undefined>();
  for (const key of keys) {
    prior.set(key, process.env[key]);
    delete process.env[key];
  }
  return run().finally(() => {
    for (const [key, value] of prior) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

test("interactionResponseCode reads orchestrator otp responses", () => {
  assert.equal(interactionResponseCode(response({ data: { code: "123456" } })), "123456");
});

test("interactionResponseCode preserves legacy value responses", () => {
  assert.equal(interactionResponseCode(response({ value: "654321" })), "654321");
});

test("isLikelyChatGptPushApprovalText detects ChatGPT app push approval copy", () => {
  assert.equal(
    isLikelyChatGptPushApprovalText(`
      Approve sign-in
      We've sent a notification to your devices. Open the ChatGPT app on any of them to continue.
      Resend prompt
      Try with email
    `),
    true
  );
});

test("isLikelyChatGptPushApprovalText ignores ordinary login copy", () => {
  assert.equal(isLikelyChatGptPushApprovalText("Log in to ChatGPT Continue with password"), false);
});

test("isLikelyChatGptPushApprovalText requires supporting push-approval copy", () => {
  assert.equal(isLikelyChatGptPushApprovalText("Approve sign-in"), false);
});

test("ChatGPT push approval copy separates external approval from browser control", () => {
  assert.match(CHATGPT_PUSH_APPROVAL_PROGRESS_MESSAGE, /continue automatically/i);
  assert.doesNotMatch(CHATGPT_PUSH_APPROVAL_PROGRESS_MESSAGE, /streaming companion|run interaction controls/i);
  assert.match(CHATGPT_PUSH_APPROVAL_FALLBACK_MESSAGE, /click Continue here/i);
});

test("chatGptPushApprovalAssistance emits nonblocking external approval shape", () => {
  // The observation budget is raised so realistic late approvals auto-resume via
  // the non-blocking poll; the assistance timeout is derived from that budget.
  assert.deepEqual(chatGptPushApprovalAssistance({}), {
    message: CHATGPT_PUSH_APPROVAL_ASSISTANCE_MESSAGE,
    progress_posture: "running",
    owner_action: "act_elsewhere",
    response_contract: "none",
    sensitivity: "non_secret",
    timeout_seconds: 900,
  });
});

test("ChatGPT push approval checkpoints while polling so the session watchdog sees progress", async () => {
  const originalUsername = process.env.CHATGPT_USERNAME;
  const originalPassword = process.env.CHATGPT_PASSWORD;
  process.env.CHATGPT_USERNAME = "owner@example.test";
  process.env.CHATGPT_PASSWORD = "correct horse battery staple";

  let sessionProbeCount = 0;
  let passwordSubmitted = false;
  const checkpoints: string[] = [];
  const assistanceMessages: string[] = [];

  function locator(options: { count?: number; visible?: boolean } = {}) {
    const count = options.count ?? 0;
    const visible = options.visible ?? count > 0;
    const self = {
      click: () => {
        passwordSubmitted = true;
        return Promise.resolve();
      },
      count: () => count,
      fill: () => Promise.resolve(),
      first: () => self,
      waitFor: () => {
        if (!visible) {
          return Promise.reject(new Error("not visible"));
        }
        return Promise.resolve();
      },
    };
    return self;
  }

  const page = {
    evaluate: (fn: (...args: never[]) => unknown) => {
      const source = String(fn);
      if (source.includes("/api/auth/session")) {
        sessionProbeCount += 1;
        return sessionProbeCount >= 18 ? { user: { id: "owner" } } : null;
      }
      return false;
    },
    getByRole: () => locator({ visible: false }),
    getByText: (text: RegExp) =>
      locator({
        visible:
          passwordSubmitted &&
          (text.test("Approve sign-in") ||
            text.test("sent a notification") ||
            text.test("ChatGPT app") ||
            text.test("your devices")),
      }),
    goto: async () => undefined,
    locator: (selector: string) => {
      if (selector.includes('input[type="email"]') || selector.includes('input[type="password"]')) {
        return locator({ count: 1 });
      }
      if (selector.includes('input[name="code"]') || selector.includes('input[type="tel"]')) {
        return locator({ count: 0 });
      }
      return locator({ count: 1 });
    },
    waitForTimeout: async () => undefined,
  };

  try {
    const ok = await ensureChatGptSession({
      assist: (req) => {
        assistanceMessages.push(req.message);
        return Promise.resolve("assist_1");
      },
      checkpoint: (label) => {
        checkpoints.push(label);
        return Promise.resolve();
      },
      completeAssistance: () => Promise.resolve(),
      context: {} as never,
      page: page as never,
      progress: () => Promise.resolve(),
      sendInteraction: (req) => Promise.resolve(response({ request_id: req.request_id ?? "interaction_1" })),
    });

    assert.equal(ok, true);
    assert.deepEqual(assistanceMessages, [CHATGPT_PUSH_APPROVAL_ASSISTANCE_MESSAGE]);
    assert.ok(
      checkpoints.includes("chatgpt-push-approval-requested"),
      "push approval should checkpoint immediately after assistance is emitted"
    );
    assert.ok(
      checkpoints.includes("chatgpt-push-approval-waiting-12"),
      "long app-approval polling should checkpoint before the 120s watchdog deadline"
    );
  } finally {
    if (originalUsername === undefined) {
      delete process.env.CHATGPT_USERNAME;
    } else {
      process.env.CHATGPT_USERNAME = originalUsername;
    }
    if (originalPassword === undefined) {
      delete process.env.CHATGPT_PASSWORD;
    } else {
      process.env.CHATGPT_PASSWORD = originalPassword;
    }
  }
});

test("ChatGPT initial auth probe emits bounded diagnostic before credential login", async () => {
  await withEnvUnset(["CHATGPT_USERNAME", "CHATGPT_PASSWORD"], async () => {
    const progressMessages: string[] = [];
    const privateRoute = "https://chatgpt.com/c/private-conversation-id";
    let currentUrl = privateRoute;
    const page = {
      evaluate: (fn: (...args: never[]) => unknown) => {
        const source = String(fn);
        if (source.includes("/api/auth/session")) {
          return Promise.resolve(null);
        }
        if (source.includes("querySelectorAll")) {
          return Promise.resolve({
            dom_logged_in: true,
            has_login_or_signup: false,
            has_sidebar: true,
            has_user_menu: false,
          });
        }
        return Promise.resolve(false);
      },
      goto: (url: string) => {
        currentUrl = url;
        return Promise.resolve(null);
      },
      url: () => currentUrl,
      waitForTimeout: async () => undefined,
    };

    await assert.rejects(
      ensureChatGptSession({
        context: {} as never,
        page: page as never,
        progress: (message) => {
          progressMessages.push(message);
          return Promise.resolve();
        },
        sendInteraction: (req) => Promise.resolve(response({ request_id: req.request_id ?? "interaction_1" })),
      }),
      /CHATGPT_USERNAME\/PASSWORD not set/u
    );

    assert.equal(progressMessages.length, 1);
    assert.doesNotMatch(progressMessages[0] ?? "", /private-conversation-id/u);
    const diagnostic = extractAuthProbeDiagnostic(progressMessages[0] ?? "");
    assert.deepEqual(diagnostic, {
      object: "chatgpt_auth_probe",
      stage: "initial",
      api_session_user: false,
      dom_logged_in: true,
      has_login_or_signup: false,
      has_sidebar: true,
      has_user_menu: false,
      route_class: "home",
      decision: "credential_login_required",
    });
  });
});

test("ChatGPT initial auth probe preserves existing API-session decision", async () => {
  const progressMessages: string[] = [];
  let loginOpened = false;
  const page = {
    evaluate: (fn: (...args: never[]) => unknown) => {
      const source = String(fn);
      if (source.includes("/api/auth/session")) {
        return Promise.resolve({ user: { id: "owner" } });
      }
      if (source.includes("querySelectorAll")) {
        return Promise.resolve({
          dom_logged_in: false,
          has_login_or_signup: true,
          has_sidebar: false,
          has_user_menu: false,
        });
      }
      return Promise.resolve(false);
    },
    getByRole: () => {
      loginOpened = true;
      throw new Error("login path should not be reached");
    },
    goto: (url: string) => {
      if (url.includes("/auth/login")) {
        loginOpened = true;
      }
      return Promise.resolve(null);
    },
    url: () => "https://chatgpt.com/",
    waitForTimeout: async () => undefined,
  };

  const ok = await ensureChatGptSession({
    context: {} as never,
    page: page as never,
    progress: (message) => {
      progressMessages.push(message);
      return Promise.resolve();
    },
    sendInteraction: (req) => Promise.resolve(response({ request_id: req.request_id ?? "interaction_1" })),
  });

  assert.equal(ok, true);
  assert.equal(loginOpened, false);
  assert.equal(progressMessages.length, 1);
  const diagnostic = extractAuthProbeDiagnostic(progressMessages[0] ?? "");
  assert.equal(diagnostic.api_session_user, true);
  assert.equal(diagnostic.decision, "accepted_by_api_session");
});

test("resolveChatGptPushApprovalTimeoutMs honors a positive env override and falls back otherwise", () => {
  assert.equal(resolveChatGptPushApprovalTimeoutMs({}), 900_000);
  assert.equal(resolveChatGptPushApprovalTimeoutMs({ PDPP_CHATGPT_PUSH_APPROVAL_TIMEOUT_MS: "60000" }), 60_000);
  // Non-positive / non-numeric values fall back to the default.
  assert.equal(resolveChatGptPushApprovalTimeoutMs({ PDPP_CHATGPT_PUSH_APPROVAL_TIMEOUT_MS: "0" }), 900_000);
  assert.equal(resolveChatGptPushApprovalTimeoutMs({ PDPP_CHATGPT_PUSH_APPROVAL_TIMEOUT_MS: "nope" }), 900_000);
});

test("chatGptPushApprovalAssistance derives timeout_seconds from the configured budget", () => {
  // 5-minute override -> 300s assistance timeout. NodeJS.ProcessEnv accepts the
  // partial env object in the test.
  const assistance = chatGptPushApprovalAssistance({ PDPP_CHATGPT_PUSH_APPROVAL_TIMEOUT_MS: "300000" });
  assert.equal(assistance.timeout_seconds, 300);
});
