/**
 * Mutation-killing coverage for the uncovered edge branches of
 * `server/notification-policy.ts`.
 *
 * The existing `notification-policy.test.js` proves the headline paths
 * (action-required classification, one wrap-around quiet-window point, the
 * delivery projection for informational vs action-required). It leaves the
 * branch matrix underneath unpinned:
 *
 *   - isWithinQuietWindow: disabled/null window, same-day (non-wrap) window,
 *     the before-dawn half of a wrap window, both inclusive-start /
 *     exclusive-end boundaries, start===end, invalid clock strings
 *     (parseClockMinutes rejection), and a non-UTC timeZone.
 *   - classifyAssistanceNotification: each individual falsifying condition.
 *   - classifyRunEventNotification: the interaction_required dispatch and the
 *     "no .data -> classify input itself" fallback.
 *   - shouldFanoutRenderedVerdict: non-object, non-array required_actions,
 *     missing satisfied_when.
 *   - projectNotificationDelivery: defaults, and action_required never sets
 *     quiet_hours_applied even inside the window.
 *
 * Pure module; no grant/auth/token logic — no source changed.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyAssistanceNotification,
  classifyRunEventNotification,
  isWithinQuietWindow,
  NOTIFICATION_TIERS,
  projectNotificationDelivery,
  shouldFanoutRenderedVerdict,
} from '../server/notification-policy.ts';

const WRAP = { enabled: true, start: '22:00', end: '07:00', timeZone: 'UTC' };
const DAY = { enabled: true, start: '09:00', end: '17:00', timeZone: 'UTC' };

function at(iso) {
  return new Date(iso);
}

// ─── isWithinQuietWindow — enabled gate ──────────────────────────────────

test('isWithinQuietWindow is false when the window is null or disabled', () => {
  assert.equal(isWithinQuietWindow({ now: at('2026-05-16T05:00:00Z'), quietWindow: null }), false);
  assert.equal(isWithinQuietWindow({ now: at('2026-05-16T05:00:00Z'), quietWindow: undefined }), false);
  assert.equal(
    isWithinQuietWindow({ now: at('2026-05-16T05:00:00Z'), quietWindow: { enabled: false, start: '22:00', end: '07:00' } }),
    false,
  );
});

test('isWithinQuietWindow with no args does not throw and returns false', () => {
  assert.equal(isWithinQuietWindow(), false);
});

// ─── isWithinQuietWindow — wrap-around window (start > end) ───────────────

test('isWithinQuietWindow wrap window includes the before-midnight and before-dawn halves', () => {
  assert.equal(isWithinQuietWindow({ now: at('2026-05-16T23:30:00Z'), quietWindow: WRAP }), true);
  assert.equal(isWithinQuietWindow({ now: at('2026-05-16T05:00:00Z'), quietWindow: WRAP }), true);
});

test('isWithinQuietWindow wrap window is inclusive at start and exclusive at end', () => {
  assert.equal(isWithinQuietWindow({ now: at('2026-05-16T22:00:00Z'), quietWindow: WRAP }), true);
  assert.equal(isWithinQuietWindow({ now: at('2026-05-16T07:00:00Z'), quietWindow: WRAP }), false);
});

test('isWithinQuietWindow wrap window excludes the midday gap', () => {
  assert.equal(isWithinQuietWindow({ now: at('2026-05-16T12:00:00Z'), quietWindow: WRAP }), false);
});

// ─── isWithinQuietWindow — same-day window (start < end) ──────────────────

test('isWithinQuietWindow same-day window includes an interior time', () => {
  assert.equal(isWithinQuietWindow({ now: at('2026-05-16T12:00:00Z'), quietWindow: DAY }), true);
});

test('isWithinQuietWindow same-day window is inclusive at start, exclusive at end', () => {
  assert.equal(isWithinQuietWindow({ now: at('2026-05-16T09:00:00Z'), quietWindow: DAY }), true);
  assert.equal(isWithinQuietWindow({ now: at('2026-05-16T17:00:00Z'), quietWindow: DAY }), false);
});

test('isWithinQuietWindow same-day window excludes a time before start', () => {
  assert.equal(isWithinQuietWindow({ now: at('2026-05-16T08:00:00Z'), quietWindow: DAY }), false);
});

// ─── isWithinQuietWindow — degenerate / invalid inputs ───────────────────

test('isWithinQuietWindow returns false when start === end (empty window)', () => {
  assert.equal(
    isWithinQuietWindow({ now: at('2026-05-16T08:00:00Z'), quietWindow: { enabled: true, start: '08:00', end: '08:00' } }),
    false,
  );
});

test('isWithinQuietWindow rejects malformed clock strings (parseClockMinutes)', () => {
  for (const bad of ['24:00', '12:60', '7:00', '0700', '', 'noon']) {
    assert.equal(
      isWithinQuietWindow({ now: at('2026-05-16T05:00:00Z'), quietWindow: { enabled: true, start: bad, end: '07:00' } }),
      false,
      `start=${JSON.stringify(bad)} should invalidate the window`,
    );
  }
});

test('isWithinQuietWindow evaluates the clock in the window timeZone', () => {
  // 23:30 UTC is 19:30 in America/New_York (EDT, UTC-4) in May, which is
  // outside a 22:00-07:00 wrap window even though it is inside it in UTC.
  assert.equal(
    isWithinQuietWindow({
      now: at('2026-05-16T23:30:00Z'),
      quietWindow: { enabled: true, start: '22:00', end: '07:00', timeZone: 'America/New_York' },
    }),
    false,
  );
});

// ─── classifyAssistanceNotification — falsifying conditions ──────────────

test('classifyAssistanceNotification is action_required only for the full owner-action shape', () => {
  const base = { owner_action: 'act_elsewhere', progress_posture: 'running', response_contract: 'none' };
  assert.equal(classifyAssistanceNotification(base), NOTIFICATION_TIERS.ACTION_REQUIRED);
});

test('classifyAssistanceNotification drops to informational for each missing condition', () => {
  // owner_action null or 'none'
  assert.equal(
    classifyAssistanceNotification({ owner_action: 'none', progress_posture: 'running', response_contract: 'none' }),
    NOTIFICATION_TIERS.INFORMATIONAL,
  );
  assert.equal(
    classifyAssistanceNotification({ progress_posture: 'running', response_contract: 'none' }),
    NOTIFICATION_TIERS.INFORMATIONAL,
  );
  // wrong posture
  assert.equal(
    classifyAssistanceNotification({ owner_action: 'act', progress_posture: 'completed', response_contract: 'none' }),
    NOTIFICATION_TIERS.INFORMATIONAL,
  );
  // response_contract not in the allowed set
  assert.equal(
    classifyAssistanceNotification({ owner_action: 'act', progress_posture: 'running', response_contract: 'acknowledged' }),
    NOTIFICATION_TIERS.INFORMATIONAL,
  );
});

test('classifyAssistanceNotification accepts running or blocked posture, and null contract', () => {
  assert.equal(
    classifyAssistanceNotification({ owner_action: 'act', progress_posture: 'blocked' }),
    NOTIFICATION_TIERS.ACTION_REQUIRED,
  );
  assert.equal(
    classifyAssistanceNotification({ owner_action: 'act', progress_posture: 'running', response_contract: 'response_required' }),
    NOTIFICATION_TIERS.ACTION_REQUIRED,
  );
});

// ─── classifyRunEventNotification — dispatch ─────────────────────────────

test('classifyRunEventNotification classifies both assistance event types', () => {
  const data = { owner_action: 'act', progress_posture: 'running', response_contract: 'none' };
  assert.equal(
    classifyRunEventNotification({ event_type: 'run.interaction_required', data }),
    NOTIFICATION_TIERS.ACTION_REQUIRED,
  );
  assert.equal(
    classifyRunEventNotification({ event_type: 'run.assistance_requested', data }),
    NOTIFICATION_TIERS.ACTION_REQUIRED,
  );
});

test('classifyRunEventNotification falls back to the input itself when there is no .data', () => {
  assert.equal(
    classifyRunEventNotification({
      event_type: 'run.interaction_required',
      owner_action: 'act',
      progress_posture: 'running',
      response_contract: 'none',
    }),
    NOTIFICATION_TIERS.ACTION_REQUIRED,
  );
});

test('classifyRunEventNotification is informational for non-assistance events', () => {
  assert.equal(
    classifyRunEventNotification({ event_type: 'run.completed' }),
    NOTIFICATION_TIERS.INFORMATIONAL,
  );
  assert.equal(classifyRunEventNotification({}), NOTIFICATION_TIERS.INFORMATIONAL);
});

// ─── shouldFanoutRenderedVerdict — non-happy inputs ──────────────────────

test('shouldFanoutRenderedVerdict rejects non-object and nullish verdicts', () => {
  assert.equal(shouldFanoutRenderedVerdict(null), false);
  assert.equal(shouldFanoutRenderedVerdict(undefined), false);
  assert.equal(shouldFanoutRenderedVerdict('attention'), false);
  assert.equal(shouldFanoutRenderedVerdict(42), false);
});

test('shouldFanoutRenderedVerdict rejects a non-array required_actions', () => {
  assert.equal(shouldFanoutRenderedVerdict({ channel: 'attention', required_actions: 'nope' }), false);
  assert.equal(shouldFanoutRenderedVerdict({ channel: 'attention' }), false);
});

test('shouldFanoutRenderedVerdict rejects a primary action missing satisfied_when', () => {
  assert.equal(
    shouldFanoutRenderedVerdict({ channel: 'attention', required_actions: [{ audience: 'owner' }] }),
    false,
  );
});

test('shouldFanoutRenderedVerdict interrupts only on attention + owner + satisfiable primary', () => {
  const action = { audience: 'owner', satisfied_when: { kind: 'credential_present' } };
  assert.equal(shouldFanoutRenderedVerdict({ channel: 'attention', required_actions: [action] }), true);
});

// ─── projectNotificationDelivery ─────────────────────────────────────────

test('projectNotificationDelivery defaults to a durable, non-interruptive informational projection', () => {
  assert.deepEqual(projectNotificationDelivery(), {
    dashboard_inbox: 'durable',
    interruptive_channel_opted_in: false,
    interruptive_eligible: false,
    quiet_hours_applied: false,
    tier: NOTIFICATION_TIERS.INFORMATIONAL,
  });
});

test('projectNotificationDelivery never applies quiet hours to an action_required tier', () => {
  const projection = projectNotificationDelivery({
    channelOptedIn: true,
    now: at('2026-05-16T23:30:00Z'),
    quietWindow: WRAP,
    tier: NOTIFICATION_TIERS.ACTION_REQUIRED,
  });
  assert.equal(projection.quiet_hours_applied, false);
  assert.equal(projection.interruptive_eligible, true);
});

test('projectNotificationDelivery keeps an informational push eligible when outside the quiet window', () => {
  const projection = projectNotificationDelivery({
    channelOptedIn: true,
    now: at('2026-05-16T12:00:00Z'), // outside the 22-07 window
    quietWindow: WRAP,
    tier: NOTIFICATION_TIERS.INFORMATIONAL,
  });
  assert.equal(projection.quiet_hours_applied, false);
  assert.equal(projection.interruptive_eligible, true);
});
