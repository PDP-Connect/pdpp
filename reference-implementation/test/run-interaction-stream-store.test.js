/**
 * Unit tests for the run-interaction streaming session store.
 *
 * The store is the security backbone of the streaming companion: token
 * scope, expiry, single-use semantics, and invalidation on interaction
 * resolution all live here. These tests pin the contract so route changes
 * cannot silently broaden a token's authority.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createStreamingSessionStore } from '../server/streaming/sessions.js';

function freshClock() {
  let t = 1_000_000_000;
  return {
    now: () => t,
    advance(ms) {
      t += ms;
    },
    set(ms) {
      t = ms;
    },
  };
}

test('mint binds the token to a single (run, interaction, browser session)', () => {
  const clock = freshClock();
  const store = createStreamingSessionStore({ now: clock.now, ttlMs: 60_000 });
  const { token, session } = store.mint({
    run_id: 'run_a',
    interaction_id: 'int_a',
    browser_session_id: 'bs_1',
    viewport: { width: 800, height: 600 },
  });

  assert.equal(typeof token, 'string');
  assert.ok(token.length >= 32);
  assert.equal(session.run_id, 'run_a');
  assert.equal(session.interaction_id, 'int_a');
  assert.equal(session.browser_session_id, 'bs_1');
  assert.equal(session.attached_at, null);
  assert.equal(session.invalidated, false);
});

test('attach marks the session attached and refuses a second attach', () => {
  const clock = freshClock();
  const store = createStreamingSessionStore({ now: clock.now, ttlMs: 60_000 });
  const { token } = store.mint({
    run_id: 'run_a',
    interaction_id: 'int_a',
    browser_session_id: 'bs_1',
  });

  const first = store.attach({ token, run_id: 'run_a', interaction_id: 'int_a' });
  assert.ok(first.attached_at);

  assert.throws(
    () => store.attach({ token, run_id: 'run_a', interaction_id: 'int_a' }),
    (err) => err.code === 'session_consumed',
  );
});

test('attach rejects a token bound to a different run or interaction', () => {
  const clock = freshClock();
  const store = createStreamingSessionStore({ now: clock.now, ttlMs: 60_000 });
  const { token } = store.mint({
    run_id: 'run_a',
    interaction_id: 'int_a',
    browser_session_id: 'bs_1',
  });

  assert.throws(
    () => store.attach({ token, run_id: 'run_b', interaction_id: 'int_a' }),
    (err) => err.code === 'wrong_run',
  );
  assert.throws(
    () => store.attach({ token, run_id: 'run_a', interaction_id: 'int_other' }),
    (err) => err.code === 'wrong_interaction',
  );
});

test('attach rejects an expired token', () => {
  const clock = freshClock();
  const store = createStreamingSessionStore({ now: clock.now, ttlMs: 1_000 });
  const { token } = store.mint({
    run_id: 'run_a',
    interaction_id: 'int_a',
    browser_session_id: 'bs_1',
  });
  clock.advance(2_000);
  assert.throws(
    () => store.attach({ token, run_id: 'run_a', interaction_id: 'int_a' }),
    (err) => err.code === 'session_expired' || err.code === 'invalid_token',
  );
});

test('attach rejects a token for a resolved interaction', () => {
  const clock = freshClock();
  const store = createStreamingSessionStore({ now: clock.now, ttlMs: 60_000 });
  const { token } = store.mint({
    run_id: 'run_a',
    interaction_id: 'int_a',
    browser_session_id: 'bs_1',
  });
  store.invalidate({ run_id: 'run_a', interaction_id: 'int_a', reason: 'interaction_success' });
  assert.throws(
    () => store.attach({ token, run_id: 'run_a', interaction_id: 'int_a' }),
    (err) => err.code === 'invalid_token' || err.code === 'session_invalidated',
  );
});

test('mint supersedes a prior unconsumed token for the same interaction', () => {
  const clock = freshClock();
  const store = createStreamingSessionStore({ now: clock.now, ttlMs: 60_000 });
  const { token: first } = store.mint({
    run_id: 'run_a',
    interaction_id: 'int_a',
    browser_session_id: 'bs_1',
  });
  const { token: second } = store.mint({
    run_id: 'run_a',
    interaction_id: 'int_a',
    browser_session_id: 'bs_2',
  });
  assert.notEqual(first, second);
  assert.throws(
    () => store.attach({ token: first, run_id: 'run_a', interaction_id: 'int_a' }),
    (err) => err.code === 'invalid_token' || err.code === 'session_invalidated',
  );
  const attached = store.attach({ token: second, run_id: 'run_a', interaction_id: 'int_a' });
  assert.equal(attached.browser_session_id, 'bs_2');
});

test('authorize requires an attached token and rejects unattached use', () => {
  const clock = freshClock();
  const store = createStreamingSessionStore({ now: clock.now, ttlMs: 60_000 });
  const { token } = store.mint({
    run_id: 'run_a',
    interaction_id: 'int_a',
    browser_session_id: 'bs_1',
  });
  assert.throws(
    () => store.authorize({ token }),
    (err) => err.code === 'session_not_attached',
  );
  store.attach({ token, run_id: 'run_a', interaction_id: 'int_a' });
  const session = store.authorize({ token });
  assert.equal(session.run_id, 'run_a');
});

test('authorize rejects unknown and empty tokens', () => {
  const store = createStreamingSessionStore();
  assert.throws(() => store.authorize({ token: '' }), (err) => err.code === 'invalid_token');
  assert.throws(
    () => store.authorize({ token: 'not-a-real-token' }),
    (err) => err.code === 'session_inactive' || err.code === 'invalid_token',
  );
});
