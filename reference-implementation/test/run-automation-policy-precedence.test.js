import test from 'node:test';
import assert from 'node:assert/strict';

import { projectRunAutomationPolicy } from '../runtime/run-automation-policy.ts';

// Mutation-killing complement for the run-automation policy PROJECTION. The
// existing suite pins the four automation modes and the assisted-after-auth
// case, but leaves two things unguarded: the DEPLOYMENT-READINESS tier (never
// exercised) and the four-tier PRECEDENCE order. This projection gates whether a
// run may auto-start, so the tier that wins when several conditions hold at once
// is load-bearing. Pure — no DB.
//
// Precedence (top wins): policy-blocks-automatic → not-ready → attention-needed
// → notify-during-run.

// --------------------------------------------------------------------------
// Deployment-readiness tier (previously untested)
// --------------------------------------------------------------------------

test('not-ready + scheduled trigger → ask_before_run, informational, owner approval required', () => {
  const r = projectRunAutomationPolicy({
    triggerKind: 'scheduled',
    deploymentReadiness: { ready: false, reason: 'n.eko surface pool exhausted' },
  });
  assert.equal(r.allowed_to_start, false);
  assert.equal(r.automation_mode, 'ask_before_run');
  assert.equal(r.notification_posture, 'informational');
  assert.equal(r.requires_owner_approval, true);
  assert.equal(r.reason, 'n.eko surface pool exhausted', 'surfaces the supplied readiness reason');
});

test('not-ready + manual trigger → assisted, allowed to start, no owner approval', () => {
  const r = projectRunAutomationPolicy({
    triggerKind: 'manual',
    deploymentReadiness: { ready: false, reason: 'prereqs missing' },
  });
  assert.equal(r.allowed_to_start, true, 'a manual gesture may still start while not-ready');
  assert.equal(r.automation_mode, 'assisted');
  assert.equal(r.notification_posture, 'none');
  assert.equal(r.requires_owner_approval, false);
});

test('not-ready with no reason falls back to the default prerequisites message', () => {
  const r = projectRunAutomationPolicy({
    triggerKind: 'scheduled',
    deploymentReadiness: { ready: false },
  });
  assert.equal(r.reason, 'Runtime prerequisites are not currently satisfied.');
});

test('deployment_readiness echoes the input; absent readiness defaults to ready', () => {
  const supplied = { ready: false, reason: 'x' };
  const r = projectRunAutomationPolicy({ triggerKind: 'scheduled', deploymentReadiness: supplied });
  assert.deepEqual(r.deployment_readiness, supplied);

  const defaulted = projectRunAutomationPolicy({ triggerKind: 'scheduled' });
  assert.deepEqual(defaulted.deployment_readiness, { ready: true }, 'omitted readiness defaults to ready:true');
});

// --------------------------------------------------------------------------
// Precedence: a blocking refresh policy dominates readiness AND attention
// --------------------------------------------------------------------------

test('a blocking policy wins over not-ready (returns the policy reason, manual_only)', () => {
  const r = projectRunAutomationPolicy({
    triggerKind: 'scheduled',
    refreshPolicy: { recommended_mode: 'paused' },
    deploymentReadiness: { ready: false, reason: 'unrelated readiness reason' },
    humanAttentionNeeded: true,
  });
  assert.equal(r.automation_mode, 'manual_only', 'the policy tier is checked first');
  assert.match(r.reason, /paused refresh/, 'the policy reason wins, not the readiness reason');
  assert.equal(r.allowed_to_start, false, 'scheduled under a blocking policy cannot start');
});

test('a blocking policy on a MANUAL trigger allows the run and stays manual_only', () => {
  const r = projectRunAutomationPolicy({
    triggerKind: 'manual',
    refreshPolicy: { background_safe: false },
    deploymentReadiness: { ready: false },
  });
  assert.equal(r.automation_mode, 'manual_only');
  assert.equal(r.allowed_to_start, true);
  assert.equal(r.notification_posture, 'none');
});

// --------------------------------------------------------------------------
// Precedence: not-ready dominates attention-needed
// --------------------------------------------------------------------------

test('not-ready wins over human-attention-needed (readiness branch, not the attention branch)', () => {
  const r = projectRunAutomationPolicy({
    triggerKind: 'scheduled',
    deploymentReadiness: { ready: false, reason: 'surface pool exhausted' },
    humanAttentionNeeded: true,
  });
  // If the attention tier had won, mode would be ask_before_run WITH the
  // attention reason and notification action_required. The readiness tier wins:
  // same mode name but the READINESS reason and only informational posture.
  assert.equal(r.reason, 'surface pool exhausted', 'the readiness reason wins over the attention reason');
  assert.equal(r.notification_posture, 'informational', 'not action_required — readiness tier, not attention tier');
});

test('attention-needed fires only when ready AND non-manual; a manual trigger bypasses it to assisted/unattended', () => {
  // Ready + attention + scheduled → the attention tier (action_required).
  const scheduled = projectRunAutomationPolicy({
    triggerKind: 'scheduled',
    humanAttentionNeeded: true,
  });
  assert.equal(scheduled.notification_posture, 'action_required');
  assert.equal(scheduled.allowed_to_start, false);

  // Ready + attention + MANUAL → bypasses the attention tier entirely.
  const manual = projectRunAutomationPolicy({
    triggerKind: 'manual',
    humanAttentionNeeded: true,
  });
  assert.notEqual(manual.automation_mode, 'ask_before_run', 'manual is never gated by human-attention-needed');
  assert.equal(manual.allowed_to_start, true);
});
