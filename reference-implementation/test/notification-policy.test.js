import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyAssistanceNotification,
  classifyRunEventNotification,
  isWithinQuietWindow,
  projectNotificationDelivery,
} from '../server/notification-policy.js';

test('notification policy classifies owner assistance as action-required', () => {
  assert.equal(
    classifyAssistanceNotification({
      owner_action: 'act_elsewhere',
      progress_posture: 'running',
      response_contract: 'none',
    }),
    'action_required',
  );
  assert.equal(
    classifyRunEventNotification({
      event_type: 'run.assistance_requested',
      data: {
        owner_action: 'act_elsewhere',
        progress_posture: 'blocked',
        response_contract: 'response_required',
      },
    }),
    'action_required',
  );
});

test('notification policy keeps ordinary progress informational', () => {
  assert.equal(
    classifyAssistanceNotification({
      owner_action: 'none',
      progress_posture: 'running',
      response_contract: 'none',
    }),
    'informational',
  );
  assert.equal(classifyRunEventNotification({ event_type: 'run.completed' }), 'informational');
});

test('notification delivery keeps dashboard inbox durable while quieting informational push', () => {
  const quietWindow = { enabled: true, start: '22:00', end: '07:00', timeZone: 'UTC' };
  const now = new Date('2026-05-16T23:30:00.000Z');

  assert.equal(isWithinQuietWindow({ now, quietWindow }), true);
  assert.deepEqual(
    projectNotificationDelivery({
      channelOptedIn: true,
      now,
      quietWindow,
      tier: 'informational',
    }),
    {
      dashboard_inbox: 'durable',
      interruptive_channel_opted_in: true,
      interruptive_eligible: false,
      quiet_hours_applied: true,
      tier: 'informational',
    },
  );
});

test('action-required notification delivery may interrupt during quiet hours but still needs opt-in', () => {
  const quietWindow = { enabled: true, start: '22:00', end: '07:00', timeZone: 'UTC' };
  const now = new Date('2026-05-16T23:30:00.000Z');

  assert.equal(
    projectNotificationDelivery({
      channelOptedIn: true,
      now,
      quietWindow,
      tier: 'action_required',
    }).interruptive_eligible,
    true,
  );
  const noOptIn = projectNotificationDelivery({
    channelOptedIn: false,
    now,
    quietWindow,
    tier: 'action_required',
  });
  assert.equal(noOptIn.dashboard_inbox, 'durable');
  assert.equal(noOptIn.interruptive_eligible, false);
});
