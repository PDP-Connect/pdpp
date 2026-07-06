/**
 * Mutation-killing coverage for the branches of
 * `runtime/run-automation-policy.ts` that the existing suite leaves open:
 *
 *   - the deployment-not-ready outcome (scheduled -> ask_before_run;
 *     manual -> assisted) including the reason fallback string.
 *   - the recommended_mode manual / paused policy-blocks projections
 *     end-to-end (the existing tests only reach these via
 *     automaticIneligibilityReason, not the full projection shape).
 *   - canNotifyDuringRun posture branches: credentials (assisted), none
 *     (unattended), and the assisted_after_owner_auth scheduled-trigger
 *     suppression that flips an otherwise-assisted posture to unattended.
 *   - deploymentReadiness default of { ready: true } for null / omitted.
 *   - automationModeCopy exact owner-facing strings (the existing test only
 *     asserts non-empty, so a mutant swapping two copy strings survives) and
 *     the default fall-through for an unknown mode.
 *
 * Pure projection; no grant/auth/token/consent logic — no source changed.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  automationModeCopy,
  projectRunAutomationPolicy,
} from '../runtime/run-automation-policy.ts';

// ─── deployment-not-ready outcome ────────────────────────────────────────

test('projectRunAutomationPolicy gates a scheduled run when deployment is not ready', () => {
  const p = projectRunAutomationPolicy({
    triggerKind: 'scheduled',
    deploymentReadiness: { ready: false, reason: 'no browser surface' },
  });
  assert.equal(p.allowed_to_start, false);
  assert.equal(p.automation_mode, 'ask_before_run');
  assert.equal(p.notification_posture, 'informational');
  assert.equal(p.requires_owner_approval, true);
  assert.equal(p.reason, 'no browser surface');
});

test('projectRunAutomationPolicy allows a manual run under an unready deployment as assisted', () => {
  const p = projectRunAutomationPolicy({
    triggerKind: 'manual',
    deploymentReadiness: { ready: false, reason: 'no browser surface' },
  });
  assert.equal(p.allowed_to_start, true);
  assert.equal(p.automation_mode, 'assisted');
  assert.equal(p.notification_posture, 'none');
  assert.equal(p.requires_owner_approval, false);
});

test('projectRunAutomationPolicy supplies a fallback reason when deployment readiness omits one', () => {
  const p = projectRunAutomationPolicy({
    triggerKind: 'scheduled',
    deploymentReadiness: { ready: false },
  });
  assert.equal(p.reason, 'Runtime prerequisites are not currently satisfied.');
});

test('projectRunAutomationPolicy defaults deployment readiness to ready when null or omitted', () => {
  assert.deepEqual(
    projectRunAutomationPolicy({ triggerKind: 'scheduled', deploymentReadiness: null }).deployment_readiness,
    { ready: true },
  );
  assert.deepEqual(
    projectRunAutomationPolicy({ triggerKind: 'scheduled' }).deployment_readiness,
    { ready: true },
  );
});

// ─── policy-blocks (recommended_mode / background_safe) projections ──────

test('projectRunAutomationPolicy projects recommended_mode=manual as manual_only for a scheduled run', () => {
  const p = projectRunAutomationPolicy({
    triggerKind: 'scheduled',
    refreshPolicy: { recommended_mode: 'manual' },
  });
  assert.equal(p.automation_mode, 'manual_only');
  assert.equal(p.allowed_to_start, false);
  assert.equal(p.requires_owner_approval, true);
  assert.equal(p.notification_posture, 'informational');
  assert.match(p.reason, /manual runs/);
});

test('projectRunAutomationPolicy lets a manual trigger start a manual_only (paused) policy', () => {
  const p = projectRunAutomationPolicy({
    triggerKind: 'manual',
    refreshPolicy: { recommended_mode: 'paused' },
  });
  assert.equal(p.automation_mode, 'manual_only');
  assert.equal(p.allowed_to_start, true);
  assert.equal(p.requires_owner_approval, false);
  assert.equal(p.notification_posture, 'none');
  assert.match(p.reason, /paused refresh/);
});

// ─── canNotifyDuringRun posture branches ─────────────────────────────────

test('projectRunAutomationPolicy makes a credentials-posture scheduled run assisted', () => {
  const p = projectRunAutomationPolicy({
    triggerKind: 'scheduled',
    refreshPolicy: { interaction_posture: 'credentials' },
  });
  assert.equal(p.automation_mode, 'assisted');
  assert.equal(p.notification_posture, 'action_required');
});

test('projectRunAutomationPolicy keeps a none-posture scheduled run unattended', () => {
  const p = projectRunAutomationPolicy({
    triggerKind: 'scheduled',
    refreshPolicy: { interaction_posture: 'none' },
  });
  assert.equal(p.automation_mode, 'unattended');
  assert.equal(p.notification_posture, 'none');
});

test('projectRunAutomationPolicy suppresses assisted posture under assisted_after_owner_auth on a scheduled run', () => {
  // assisted_after_owner_auth + non-manual trigger short-circuits
  // canNotifyDuringRun to false, so an otherwise-assisted posture runs
  // unattended.
  const p = projectRunAutomationPolicy({
    triggerKind: 'scheduled',
    refreshPolicy: { assisted_after_owner_auth: true, interaction_posture: 'credentials' },
  });
  assert.equal(p.automation_mode, 'unattended');
  assert.equal(p.notification_posture, 'none');
});

test('projectRunAutomationPolicy still assists a manual trigger despite assisted_after_owner_auth', () => {
  const p = projectRunAutomationPolicy({
    triggerKind: 'manual',
    refreshPolicy: { assisted_after_owner_auth: true, interaction_posture: 'credentials' },
  });
  assert.equal(p.automation_mode, 'assisted');
  assert.equal(p.notification_posture, 'action_required');
});

// ─── automationModeCopy exact strings ────────────────────────────────────

test('automationModeCopy returns the exact owner-facing copy per mode', () => {
  assert.equal(
    automationModeCopy('unattended'),
    'Can refresh in the background without expected owner action.',
  );
  assert.equal(
    automationModeCopy('assisted'),
    'Can start in the background and may ask for bounded owner assistance.',
  );
  assert.equal(
    automationModeCopy('ask_before_run'),
    'Will preserve automatic intent but asks before starting owner-present work.',
  );
  assert.equal(automationModeCopy('manual_only'), 'Starts only from an owner gesture.');
});

test('automationModeCopy falls back to the manual-gesture copy for an unknown mode', () => {
  assert.equal(automationModeCopy('bogus'), 'Starts only from an owner gesture.');
});
