import assert from "node:assert/strict";
import test from "node:test";
import { formatNextAction, humanizeReasonCode } from "./next-action.ts";
import type { RefNextAction } from "./ref-client.ts";

const DETAILS_UNAVAILABLE = /Details unavailable/;
const NOTIFICATION_SENT_RE = /sent/i;
const NOTIFICATION_FAILED_RE = /failed/i;
const NOTIFICATION_PAUSED_OR_SUPPRESSED_RE = /paused|suppress/i;

function structuredAction(overrides: Partial<RefNextAction> = {}): RefNextAction {
  return {
    action_target: "dashboard",
    attention_id: "att_otp",
    expires_at: null,
    owner_action: "provide_value",
    reason_code: "otp_required",
    response_contract: "response_required",
    source: "structured",
    ...overrides,
  };
}

test("formatNextAction returns null when there is no action", () => {
  assert.equal(formatNextAction(null), null);
  assert.equal(formatNextAction(undefined), null);
});

test("formatNextAction returns null when source is 'none'", () => {
  assert.equal(
    formatNextAction({
      action_target: null,
      attention_id: null,
      expires_at: null,
      owner_action: null,
      reason_code: null,
      response_contract: "none",
      source: "none",
    }),
    null
  );
});

test("formatNextAction projects structured attention with owner verb + humanized reason", () => {
  const out = formatNextAction(structuredAction());
  if (!out) {
    assert.fail("expected formatted action");
  }
  assert.equal(out.variant, "structured");
  assert.equal(out.label, "Provide input: OTP required");
  assert.equal(out.caveat, null);
  assert.equal(out.actionTarget, "dashboard");
});

test("formatNextAction caveats schedule_fallback variants", () => {
  const out = formatNextAction({
    action_target: null,
    attention_id: null,
    expires_at: null,
    owner_action: null,
    reason_code: "browser_runtime_not_configured",
    response_contract: null,
    source: "schedule_fallback",
  });
  assert.ok(out);
  assert.equal(out.variant, "schedule_fallback");
  assert.equal(out.label, "Browser runtime not configured");
  assert.match(out.caveat ?? "", DETAILS_UNAVAILABLE);
  // schedule_fallback shouldn't render a link target either:
  assert.equal(out.actionTarget, null);
});

test("formatNextAction propagates null action_target without inventing one", () => {
  // Mirrors the secret-sensitive case where the spine suppresses
  // action_target — the UI must not synthesize a link.
  const out = formatNextAction(
    structuredAction({
      action_target: null,
      attention_id: "att_secret",
      reason_code: "otp_required",
    })
  );
  assert.ok(out);
  assert.equal(out.actionTarget, null);
  // Label is still informative.
  assert.equal(out.label, "Provide input: OTP required");
});

test("formatNextAction falls back gracefully when reason_code is absent", () => {
  const out = formatNextAction(
    structuredAction({
      owner_action: "act_elsewhere",
      reason_code: null,
    })
  );
  assert.ok(out);
  assert.equal(out.label, "Continue on the provider");
});

test("formatNextAction picks a safe label when both reason_code and owner_action are absent", () => {
  const out = formatNextAction(
    structuredAction({
      owner_action: null,
      reason_code: null,
    })
  );
  assert.ok(out);
  assert.equal(out.label, "Attention needed");
});

test("humanizeReasonCode normalizes snake_case and ignores empty input", () => {
  assert.equal(humanizeReasonCode(null), null);
  assert.equal(humanizeReasonCode(""), null);
  assert.equal(humanizeReasonCode("   "), null);
  assert.equal(humanizeReasonCode("otp_required"), "OTP required");
  assert.equal(humanizeReasonCode("manual-verification"), "Manual verification");
  assert.equal(humanizeReasonCode("browser_runtime_not_configured"), "Browser runtime not configured");
});

test("formatNextAction emits no notification hint for pending state (default chrome stays quiet)", () => {
  const out = formatNextAction(structuredAction({ notification_state: "pending" }));
  assert.ok(out);
  assert.equal(out.notificationHint, null);
});

test("formatNextAction emits a confidence-positive hint for sent state", () => {
  const out = formatNextAction(structuredAction({ notification_state: "sent" }));
  assert.ok(out);
  assert.match(out.notificationHint ?? "", NOTIFICATION_SENT_RE);
});

test("formatNextAction emits an action-required hint for failed delivery — must remain visible", () => {
  // The spec requires notification failure to be surfaced rather than
  // swallowed. The dashboard hint mirrors that contract.
  const out = formatNextAction(structuredAction({ notification_state: "failed" }));
  assert.ok(out);
  assert.match(out.notificationHint ?? "", NOTIFICATION_FAILED_RE);
});

test("formatNextAction emits a soft hint for suppressed state (quiet hours / no channel)", () => {
  const out = formatNextAction(structuredAction({ notification_state: "suppressed" }));
  assert.ok(out);
  assert.match(out.notificationHint ?? "", NOTIFICATION_PAUSED_OR_SUPPRESSED_RE);
});

test("formatNextAction stays quiet when notification state is absent (schedule_fallback or older snapshots)", () => {
  const out = formatNextAction({
    action_target: null,
    attention_id: null,
    expires_at: null,
    owner_action: null,
    reason_code: "browser_runtime_not_configured",
    response_contract: null,
    source: "schedule_fallback",
  });
  assert.ok(out);
  assert.equal(out.notificationHint, null);
});
