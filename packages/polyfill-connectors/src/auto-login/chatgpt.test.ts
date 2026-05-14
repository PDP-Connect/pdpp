import assert from "node:assert/strict";
import { test } from "node:test";
import type { InteractionResponse } from "../connector-runtime.ts";
import { interactionResponseCode, isLikelyChatGptPushApprovalText } from "./chatgpt.ts";

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
