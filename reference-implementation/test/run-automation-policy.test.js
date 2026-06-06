import assert from 'node:assert/strict';
import test from 'node:test';

import {
  automaticIneligibilityReason,
  automationModeCopy,
  projectRunAutomationPolicy,
} from '../runtime/run-automation-policy.ts';

test('run automation policy projects every trigger kind without changing the trigger identity', () => {
  for (const triggerKind of ['manual', 'scheduled', 'retry', 'webhook']) {
    const projected = projectRunAutomationPolicy({ triggerKind });
    assert.equal(projected.trigger_kind, triggerKind);
    assert.equal(projected.allowed_to_start, true);
    assert.equal(projected.automation_mode, 'unattended');
  }
});

test('run automation policy distinguishes unattended, assisted, ask-before-run, and manual-only modes', () => {
  assert.equal(projectRunAutomationPolicy({ triggerKind: 'scheduled' }).automation_mode, 'unattended');

  const assisted = projectRunAutomationPolicy({
    triggerKind: 'scheduled',
    refreshPolicy: { background_safe: true, interaction_posture: 'otp_likely' },
  });
  assert.equal(assisted.allowed_to_start, true);
  assert.equal(assisted.automation_mode, 'assisted');
  assert.equal(assisted.notification_posture, 'action_required');

  const askBefore = projectRunAutomationPolicy({
    triggerKind: 'scheduled',
    humanAttentionNeeded: true,
  });
  assert.equal(askBefore.allowed_to_start, false);
  assert.equal(askBefore.automation_mode, 'ask_before_run');
  assert.equal(askBefore.requires_owner_approval, true);

  const manualOnly = projectRunAutomationPolicy({
    triggerKind: 'scheduled',
    refreshPolicy: { background_safe: false },
  });
  assert.equal(manualOnly.allowed_to_start, false);
  assert.equal(manualOnly.automation_mode, 'manual_only');
  assert.equal(manualOnly.requires_owner_approval, true);

  const manualGesture = projectRunAutomationPolicy({
    triggerKind: 'manual',
    refreshPolicy: { background_safe: false },
  });
  assert.equal(manualGesture.allowed_to_start, true);
  assert.equal(manualGesture.automation_mode, 'manual_only');
});

test('run automation policy preserves existing unsafe automatic-schedule reasons', () => {
  assert.match(
    automaticIneligibilityReason({ recommended_mode: 'manual' }),
    /manual runs/,
  );
  assert.match(
    automaticIneligibilityReason({ recommended_mode: 'paused' }),
    /paused refresh/,
  );
  assert.match(
    automaticIneligibilityReason({ background_safe: false }),
    /not background-safe/,
  );
  assert.equal(automaticIneligibilityReason(null), null);
});

test('assisted-after-owner-auth policy can schedule but remains assisted when manual action may be needed', () => {
  const policy = {
    assisted_after_owner_auth: true,
    background_safe: true,
    interaction_posture: 'manual_action_likely',
    recommended_mode: 'automatic',
  };

  assert.equal(automaticIneligibilityReason(policy), null);
  const projected = projectRunAutomationPolicy({
    refreshPolicy: policy,
    triggerKind: 'scheduled',
  });
  assert.equal(projected.allowed_to_start, true);
  assert.equal(projected.automation_mode, 'assisted');
  assert.equal(projected.notification_posture, 'action_required');
  assert.equal(projected.requires_owner_approval, false);
});

test('automation mode copy is owner-facing and non-empty', () => {
  for (const mode of ['unattended', 'assisted', 'ask_before_run', 'manual_only']) {
    assert.match(automationModeCopy(mode), /\S/);
  }
});
