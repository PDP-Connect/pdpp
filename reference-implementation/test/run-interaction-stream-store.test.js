// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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

import { createStreamingSessionStore } from '../server/streaming/sessions.ts';

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

test('attach marks attached_at on first attach and is idempotent on re-attach', () => {
  const clock = freshClock();
  const store = createStreamingSessionStore({ now: clock.now, ttlMs: 60_000 });
  const { token } = store.mint({
    run_id: 'run_a',
    interaction_id: 'int_a',
    browser_session_id: 'bs_1',
  });

  const first = store.attach({ token, run_id: 'run_a', interaction_id: 'int_a' });
  assert.ok(first.attached_at);

  // Re-attach within the session lifetime succeeds (no throw). The viewer's
  // SSE socket can drop transiently — mobile network blips, tab visibility,
  // dev-mode HMR — and the operator must be able to resume frame delivery
  // on the same token without losing the session. `attached_at` records the
  // FIRST attach and is preserved across re-attach.
  clock.advance(1000);
  const second = store.attach({ token, run_id: 'run_a', interaction_id: 'int_a' });
  assert.equal(second.attached_at, first.attached_at, 'attached_at preserved across re-attach');
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

// ─── Idempotency cache (defense-in-depth for duplicated mint requests) ──────
//
// Even with React's StrictMode-safe event-handler mint (fix 3a), retries can
// still produce duplicate mints (network blip, operator double-tap on a flaky
// connection). The idempotency cache scopes each logical mint attempt to a
// client-generated key; a replay within the TTL window returns the SAME
// session record so the operator's input handlers don't end up referencing a
// superseded token.

test('mint with the same idempotency_key replays the original session', () => {
  const clock = freshClock();
  const store = createStreamingSessionStore({
    now: clock.now,
    ttlMs: 60_000,
    mintIdempotencyTtlMs: 60_000,
  });
  const first = store.mint({
    run_id: 'run_a',
    interaction_id: 'int_a',
    browser_session_id: 'bs_1',
    idempotency_key: 'k-shared',
  });
  // A 50ms-later replay (the StrictMode double-invoke timing) returns the
  // same token + the same browser_session_id so the viewer doesn't end up
  // talking to a dead companion.
  clock.advance(50);
  const second = store.mint({
    run_id: 'run_a',
    interaction_id: 'int_a',
    browser_session_id: 'bs_2_unused',
    idempotency_key: 'k-shared',
  });
  assert.equal(second.token, first.token);
  assert.equal(second.idempotency_replayed, true);
  assert.equal(first.idempotency_replayed, false);
  assert.equal(second.session.browser_session_id, 'bs_1');
  // The replay must NOT have superseded the original; the original token
  // still attaches successfully.
  const attached = store.attach({ token: first.token, run_id: 'run_a', interaction_id: 'int_a' });
  assert.equal(attached.browser_session_id, 'bs_1');
});

test('mint with a different idempotency_key supersedes the prior token', () => {
  const clock = freshClock();
  const store = createStreamingSessionStore({
    now: clock.now,
    ttlMs: 60_000,
    mintIdempotencyTtlMs: 60_000,
  });
  const first = store.mint({
    run_id: 'run_a',
    interaction_id: 'int_a',
    browser_session_id: 'bs_1',
    idempotency_key: 'k-1',
  });
  const second = store.mint({
    run_id: 'run_a',
    interaction_id: 'int_a',
    browser_session_id: 'bs_2',
    idempotency_key: 'k-2',
  });
  assert.notEqual(second.token, first.token);
  assert.equal(second.idempotency_replayed, false);
  // Second mint supersedes (legitimate "operator opened a new browser") —
  // the first token is invalidated.
  assert.throws(
    () => store.attach({ token: first.token, run_id: 'run_a', interaction_id: 'int_a' }),
    (err) => err.code === 'invalid_token' || err.code === 'session_invalidated',
  );
  const attached = store.attach({ token: second.token, run_id: 'run_a', interaction_id: 'int_a' });
  assert.equal(attached.browser_session_id, 'bs_2');
});

test('mint after idempotency cache TTL expires returns a fresh session', () => {
  const clock = freshClock();
  const store = createStreamingSessionStore({
    now: clock.now,
    ttlMs: 5 * 60_000, // session TTL longer than idempotency TTL
    mintIdempotencyTtlMs: 60_000,
  });
  const first = store.mint({
    run_id: 'run_a',
    interaction_id: 'int_a',
    browser_session_id: 'bs_1',
    idempotency_key: 'k-shared',
  });
  // Past the idempotency window: the same key now mints a fresh, superseding
  // session rather than replaying the long-dead one.
  clock.advance(60_001);
  const second = store.mint({
    run_id: 'run_a',
    interaction_id: 'int_a',
    browser_session_id: 'bs_2',
    idempotency_key: 'k-shared',
  });
  assert.notEqual(second.token, first.token);
  assert.equal(second.idempotency_replayed, false);
  assert.throws(
    () => store.attach({ token: first.token, run_id: 'run_a', interaction_id: 'int_a' }),
    (err) => err.code === 'invalid_token' || err.code === 'session_invalidated',
  );
});

test('mint without an idempotency_key supersedes as before', () => {
  const clock = freshClock();
  const store = createStreamingSessionStore({ now: clock.now, ttlMs: 60_000 });
  const first = store.mint({
    run_id: 'run_a',
    interaction_id: 'int_a',
    browser_session_id: 'bs_1',
    // No idempotency_key → behaves exactly as before this fix landed.
  });
  const second = store.mint({
    run_id: 'run_a',
    interaction_id: 'int_a',
    browser_session_id: 'bs_2',
  });
  assert.notEqual(second.token, first.token);
  assert.equal(second.idempotency_replayed, false);
  assert.throws(
    () => store.attach({ token: first.token, run_id: 'run_a', interaction_id: 'int_a' }),
    (err) => err.code === 'invalid_token' || err.code === 'session_invalidated',
  );
});

test('mint replay cannot resurrect a session that another mint superseded', () => {
  const clock = freshClock();
  const store = createStreamingSessionStore({
    now: clock.now,
    ttlMs: 60_000,
    mintIdempotencyTtlMs: 60_000,
  });
  const first = store.mint({
    run_id: 'run_a',
    interaction_id: 'int_a',
    browser_session_id: 'bs_1',
    idempotency_key: 'k-1',
  });
  // A second mint with a different key supersedes first.
  const second = store.mint({
    run_id: 'run_a',
    interaction_id: 'int_a',
    browser_session_id: 'bs_2',
    idempotency_key: 'k-2',
  });
  // Now a "replay" of k-1 must NOT return first's dead token. It must mint
  // afresh (supersedes second).
  const replay = store.mint({
    run_id: 'run_a',
    interaction_id: 'int_a',
    browser_session_id: 'bs_3',
    idempotency_key: 'k-1',
  });
  assert.notEqual(replay.token, first.token);
  assert.notEqual(replay.token, second.token);
  assert.equal(replay.idempotency_replayed, false);
  // Replay won; second is now invalidated.
  const attached = store.attach({ token: replay.token, run_id: 'run_a', interaction_id: 'int_a' });
  assert.equal(attached.browser_session_id, 'bs_3');
});

test('mint replay returns the same token even after the session is attached', () => {
  // Re-attach is now permitted, so a duplicate mint within the idempotency
  // window can honestly replay the original token — the operator gets the
  // live session they originally minted instead of a new one that would
  // supersede it. Stale-link replay protection comes from short TTL +
  // owner auth at mint time, not from refusing replays after attach.
  const clock = freshClock();
  const store = createStreamingSessionStore({
    now: clock.now,
    ttlMs: 60_000,
    mintIdempotencyTtlMs: 60_000,
  });
  const first = store.mint({
    run_id: 'run_a',
    interaction_id: 'int_a',
    browser_session_id: 'bs_1',
    idempotency_key: 'k-shared',
  });
  store.attach({ token: first.token, run_id: 'run_a', interaction_id: 'int_a' });
  const replay = store.mint({
    run_id: 'run_a',
    interaction_id: 'int_a',
    browser_session_id: 'bs_2',
    idempotency_key: 'k-shared',
  });
  assert.equal(replay.token, first.token);
  assert.equal(replay.idempotency_replayed, true);
});

test('mint ignores empty / non-string idempotency_key (legacy callers behave as today)', () => {
  const clock = freshClock();
  const store = createStreamingSessionStore({ now: clock.now, ttlMs: 60_000 });
  const first = store.mint({
    run_id: 'run_a',
    interaction_id: 'int_a',
    browser_session_id: 'bs_1',
    idempotency_key: '',
  });
  const second = store.mint({
    run_id: 'run_a',
    interaction_id: 'int_a',
    browser_session_id: 'bs_2',
    idempotency_key: null,
  });
  assert.notEqual(second.token, first.token);
});
