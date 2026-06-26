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
} from "./chatgpt.ts";

function response(extra: Partial<InteractionResponse>): InteractionResponse {
  return {
    request_id: "test_interaction",
    status: "success",
    type: "INTERACTION_RESPONSE",
    ...extra,
  };
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
  assert.deepEqual(chatGptPushApprovalAssistance(), {
    message: CHATGPT_PUSH_APPROVAL_ASSISTANCE_MESSAGE,
    progress_posture: "running",
    owner_action: "act_elsewhere",
    response_contract: "none",
    sensitivity: "non_secret",
    timeout_seconds: 180,
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
