// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  type AutomationRefreshPolicy,
  automaticIneligibilityReason,
  automationModeCopy,
  projectRunAutomationPolicy,
  type RunAutomationMode,
  type RunTriggerKind,
} from "../runtime/run-automation-policy.ts";

const REGEXP_1 = /background_safe=true/;
const REGEXP_2 = /paused refresh/;
const REGEXP_3 = /not background-safe/;
const REGEXP_4 = /\S/;

test("run automation policy projects every trigger kind without changing the trigger identity", () => {
  const triggerKinds: RunTriggerKind[] = ["manual", "scheduled", "retry", "webhook"];
  for (const triggerKind of triggerKinds) {
    const projected = projectRunAutomationPolicy({ triggerKind });
    assert.equal(projected.trigger_kind, triggerKind);
    assert.equal(projected.allowed_to_start, true);
    assert.equal(projected.automation_mode, "unattended");
  }
});

test("run automation policy distinguishes unattended, assisted, ask-before-run, and manual-only modes", () => {
  assert.equal(projectRunAutomationPolicy({ triggerKind: "scheduled" }).automation_mode, "unattended");

  const assisted = projectRunAutomationPolicy({
    refreshPolicy: { background_safe: true, interaction_posture: "otp_likely" },
    triggerKind: "scheduled",
  });
  assert.equal(assisted.allowed_to_start, true);
  assert.equal(assisted.automation_mode, "assisted");
  assert.equal(assisted.notification_posture, "action_required");

  const askBefore = projectRunAutomationPolicy({
    humanAttentionNeeded: true,
    triggerKind: "scheduled",
  });
  assert.equal(askBefore.allowed_to_start, false);
  assert.equal(askBefore.automation_mode, "ask_before_run");
  assert.equal(askBefore.requires_owner_approval, true);

  const manualOnly = projectRunAutomationPolicy({
    refreshPolicy: { background_safe: false },
    triggerKind: "scheduled",
  });
  assert.equal(manualOnly.allowed_to_start, false);
  assert.equal(manualOnly.automation_mode, "manual_only");
  assert.equal(manualOnly.requires_owner_approval, true);

  const manualByDefault = projectRunAutomationPolicy({
    refreshPolicy: { background_safe: true, recommended_mode: "manual" },
    triggerKind: "scheduled",
  });
  assert.equal(manualByDefault.allowed_to_start, true);
  assert.equal(manualByDefault.automation_mode, "unattended");

  const manualGesture = projectRunAutomationPolicy({
    refreshPolicy: { background_safe: false },
    triggerKind: "manual",
  });
  assert.equal(manualGesture.allowed_to_start, true);
  assert.equal(manualGesture.automation_mode, "manual_only");
});

test("run automation policy preserves existing unsafe automatic-schedule reasons", () => {
  const manualReason = automaticIneligibilityReason({ recommended_mode: "manual" });
  assert.ok(manualReason);
  assert.match(manualReason, REGEXP_1);

  assert.equal(automaticIneligibilityReason({ background_safe: true, recommended_mode: "manual" }), null);

  const pausedReason = automaticIneligibilityReason({ recommended_mode: "paused" });
  assert.ok(pausedReason);
  assert.match(pausedReason, REGEXP_2);

  const notBackgroundSafeReason = automaticIneligibilityReason({ background_safe: false });
  assert.ok(notBackgroundSafeReason);
  assert.match(notBackgroundSafeReason, REGEXP_3);

  assert.equal(automaticIneligibilityReason(null), null);
});

test("assisted-after-owner-auth policy schedules unattended and reserves auth repair for manual runs", () => {
  const policy: AutomationRefreshPolicy = {
    assisted_after_owner_auth: true,
    background_safe: true,
    interaction_posture: "manual_action_likely",
    recommended_mode: "automatic",
  };

  assert.equal(automaticIneligibilityReason(policy), null);
  const projected = projectRunAutomationPolicy({
    refreshPolicy: policy,
    triggerKind: "scheduled",
  });
  assert.equal(projected.allowed_to_start, true);
  assert.equal(projected.automation_mode, "unattended");
  assert.equal(projected.notification_posture, "none");
  assert.equal(projected.requires_owner_approval, false);

  const manual = projectRunAutomationPolicy({
    refreshPolicy: policy,
    triggerKind: "manual",
  });
  assert.equal(manual.allowed_to_start, true);
  assert.equal(manual.automation_mode, "assisted");
  assert.equal(manual.notification_posture, "action_required");
});

test("same assisted browser manifest handles valid, expired, and restored session evidence without manifest mutation", () => {
  const policy: AutomationRefreshPolicy = {
    assisted_after_owner_auth: true,
    background_safe: true,
    interaction_posture: "manual_action_likely",
    recommended_mode: "automatic",
  };

  const validSession = projectRunAutomationPolicy({
    humanAttentionNeeded: false,
    refreshPolicy: policy,
    triggerKind: "scheduled",
  });
  assert.equal(validSession.allowed_to_start, true);
  assert.equal(validSession.automation_mode, "unattended");

  const expiredSession = projectRunAutomationPolicy({
    humanAttentionNeeded: true,
    refreshPolicy: policy,
    triggerKind: "scheduled",
  });
  assert.equal(expiredSession.allowed_to_start, false);
  assert.equal(expiredSession.automation_mode, "ask_before_run");
  assert.equal(expiredSession.requires_owner_approval, true);

  const ownerRepair = projectRunAutomationPolicy({
    humanAttentionNeeded: true,
    refreshPolicy: policy,
    triggerKind: "manual",
  });
  assert.equal(ownerRepair.allowed_to_start, true);
  assert.equal(ownerRepair.automation_mode, "assisted");

  const restoredSession = projectRunAutomationPolicy({
    humanAttentionNeeded: false,
    refreshPolicy: policy,
    triggerKind: "scheduled",
  });
  assert.deepEqual(restoredSession, validSession);
});

test("automation mode copy is owner-facing and non-empty", () => {
  const modes: RunAutomationMode[] = ["unattended", "assisted", "ask_before_run", "manual_only"];
  for (const mode of modes) {
    assert.match(automationModeCopy(mode), REGEXP_4);
  }
});
