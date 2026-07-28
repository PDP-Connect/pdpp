// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
/**
 * Unit tests for the run-interaction streaming session store.
 *
 * The store is the security backbone of the streaming companion: token
 * scope, expiry, single-use semantics, and invalidation on interaction
 * resolution all live here. These tests pin the contract so route changes
 * cannot silently broaden a token's authority.
 */
import test from "node:test";

import { createStreamingSessionStore } from "../server/streaming/sessions.ts";

type CodedError = Error & { code?: string };

function isCodedError(err: unknown, code: string): boolean {
  // biome-ignore lint/suspicious/noUnnecessaryConditions: localized test assertion preserves its explicit contract.
  return (err as CodedError)?.code === code;
}

function freshClock() {
  let t = 1_000_000_000;
  return {
    advance(ms: number) {
      t += ms;
    },
    now: () => t,
    set(ms: number) {
      t = ms;
    },
  };
}

test("mint binds the token to a single (run, interaction, browser session)", () => {
  const clock = freshClock();
  const store = createStreamingSessionStore({ now: clock.now, ttlMs: 60_000 });
  const { token, session } = store.mint({
    browser_session_id: "bs_1",
    interaction_id: "int_a",
    run_id: "run_a",
    viewport: { height: 600, width: 800 },
  });

  assert.equal(typeof token, "string");
  assert.ok(token.length >= 32);
  assert.equal(session.run_id, "run_a");
  assert.equal(session.interaction_id, "int_a");
  assert.equal(session.browser_session_id, "bs_1");
  assert.equal(session.attached_at, null);
  assert.equal(session.invalidated, false);
});

test("attach marks attached_at on first attach and is idempotent on re-attach", () => {
  const clock = freshClock();
  const store = createStreamingSessionStore({ now: clock.now, ttlMs: 60_000 });
  const { token } = store.mint({
    browser_session_id: "bs_1",
    interaction_id: "int_a",
    run_id: "run_a",
  });

  const first = store.attach({ interaction_id: "int_a", run_id: "run_a", token });
  assert.ok(first.attached_at);

  // Re-attach within the session lifetime succeeds (no throw). The viewer's
  // SSE socket can drop transiently — mobile network blips, tab visibility,
  // dev-mode HMR — and the operator must be able to resume frame delivery
  // on the same token without losing the session. `attached_at` records the
  // FIRST attach and is preserved across re-attach.
  clock.advance(1000);
  const second = store.attach({ interaction_id: "int_a", run_id: "run_a", token });
  assert.equal(second.attached_at, first.attached_at, "attached_at preserved across re-attach");
});

test("attach rejects a token bound to a different run or interaction", () => {
  const clock = freshClock();
  const store = createStreamingSessionStore({ now: clock.now, ttlMs: 60_000 });
  const { token } = store.mint({
    browser_session_id: "bs_1",
    interaction_id: "int_a",
    run_id: "run_a",
  });

  assert.throws(
    () => store.attach({ interaction_id: "int_a", run_id: "run_b", token }),
    (err: unknown) => isCodedError(err, "wrong_run")
  );
  assert.throws(
    () => store.attach({ interaction_id: "int_other", run_id: "run_a", token }),
    (err: unknown) => isCodedError(err, "wrong_interaction")
  );
});

test("attach rejects an expired token", () => {
  const clock = freshClock();
  const store = createStreamingSessionStore({ now: clock.now, ttlMs: 1000 });
  const { token } = store.mint({
    browser_session_id: "bs_1",
    interaction_id: "int_a",
    run_id: "run_a",
  });
  clock.advance(2000);
  assert.throws(
    () => store.attach({ interaction_id: "int_a", run_id: "run_a", token }),
    (err: unknown) => isCodedError(err, "session_expired") || isCodedError(err, "invalid_token")
  );
});

test("attach rejects a token for a resolved interaction", () => {
  const clock = freshClock();
  const store = createStreamingSessionStore({ now: clock.now, ttlMs: 60_000 });
  const { token } = store.mint({
    browser_session_id: "bs_1",
    interaction_id: "int_a",
    run_id: "run_a",
  });
  store.invalidate({ interaction_id: "int_a", reason: "interaction_success", run_id: "run_a" });
  assert.throws(
    () => store.attach({ interaction_id: "int_a", run_id: "run_a", token }),
    (err: unknown) => isCodedError(err, "invalid_token") || isCodedError(err, "session_invalidated")
  );
});

test("mint supersedes a prior unconsumed token for the same interaction", () => {
  const clock = freshClock();
  const store = createStreamingSessionStore({ now: clock.now, ttlMs: 60_000 });
  const { token: first } = store.mint({
    browser_session_id: "bs_1",
    interaction_id: "int_a",
    run_id: "run_a",
  });
  const { token: second } = store.mint({
    browser_session_id: "bs_2",
    interaction_id: "int_a",
    run_id: "run_a",
  });
  assert.notEqual(first, second);
  assert.throws(
    () => store.attach({ interaction_id: "int_a", run_id: "run_a", token: first }),
    (err: unknown) => isCodedError(err, "invalid_token") || isCodedError(err, "session_invalidated")
  );
  const attached = store.attach({ interaction_id: "int_a", run_id: "run_a", token: second });
  assert.equal(attached.browser_session_id, "bs_2");
});

test("authorize requires an attached token and rejects unattached use", () => {
  const clock = freshClock();
  const store = createStreamingSessionStore({ now: clock.now, ttlMs: 60_000 });
  const { token } = store.mint({
    browser_session_id: "bs_1",
    interaction_id: "int_a",
    run_id: "run_a",
  });
  assert.throws(
    () => store.authorize({ token }),
    (err: unknown) => isCodedError(err, "session_not_attached")
  );
  store.attach({ interaction_id: "int_a", run_id: "run_a", token });
  const session = store.authorize({ token });
  assert.equal(session.run_id, "run_a");
});

test("authorize rejects unknown and empty tokens", () => {
  const store = createStreamingSessionStore();
  assert.throws(
    () => store.authorize({ token: "" }),
    (err: unknown) => isCodedError(err, "invalid_token")
  );
  assert.throws(
    () => store.authorize({ token: "not-a-real-token" }),
    (err: unknown) => isCodedError(err, "session_inactive") || isCodedError(err, "invalid_token")
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

test("mint with the same idempotency_key replays the original session", () => {
  const clock = freshClock();
  const store = createStreamingSessionStore({
    mintIdempotencyTtlMs: 60_000,
    now: clock.now,
    ttlMs: 60_000,
  });
  const first = store.mint({
    browser_session_id: "bs_1",
    idempotency_key: "k-shared",
    interaction_id: "int_a",
    run_id: "run_a",
  });
  // A 50ms-later replay (the StrictMode double-invoke timing) returns the
  // same token + the same browser_session_id so the viewer doesn't end up
  // talking to a dead companion.
  clock.advance(50);
  const second = store.mint({
    browser_session_id: "bs_2_unused",
    idempotency_key: "k-shared",
    interaction_id: "int_a",
    run_id: "run_a",
  });
  assert.equal(second.token, first.token);
  assert.equal(second.idempotency_replayed, true);
  assert.equal(first.idempotency_replayed, false);
  assert.equal(second.session.browser_session_id, "bs_1");
  // The replay must NOT have superseded the original; the original token
  // still attaches successfully.
  const attached = store.attach({ interaction_id: "int_a", run_id: "run_a", token: first.token });
  assert.equal(attached.browser_session_id, "bs_1");
});

test("mint with a different idempotency_key supersedes the prior token", () => {
  const clock = freshClock();
  const store = createStreamingSessionStore({
    mintIdempotencyTtlMs: 60_000,
    now: clock.now,
    ttlMs: 60_000,
  });
  const first = store.mint({
    browser_session_id: "bs_1",
    idempotency_key: "k-1",
    interaction_id: "int_a",
    run_id: "run_a",
  });
  const second = store.mint({
    browser_session_id: "bs_2",
    idempotency_key: "k-2",
    interaction_id: "int_a",
    run_id: "run_a",
  });
  assert.notEqual(second.token, first.token);
  assert.equal(second.idempotency_replayed, false);
  // Second mint supersedes (legitimate "operator opened a new browser") —
  // the first token is invalidated.
  assert.throws(
    () => store.attach({ interaction_id: "int_a", run_id: "run_a", token: first.token }),
    (err: unknown) => isCodedError(err, "invalid_token") || isCodedError(err, "session_invalidated")
  );
  const attached = store.attach({ interaction_id: "int_a", run_id: "run_a", token: second.token });
  assert.equal(attached.browser_session_id, "bs_2");
});

test("mint after idempotency cache TTL expires returns a fresh session", () => {
  const clock = freshClock();
  const store = createStreamingSessionStore({
    mintIdempotencyTtlMs: 60_000,
    now: clock.now,
    ttlMs: 5 * 60_000, // session TTL longer than idempotency TTL
  });
  const first = store.mint({
    browser_session_id: "bs_1",
    idempotency_key: "k-shared",
    interaction_id: "int_a",
    run_id: "run_a",
  });
  // Past the idempotency window: the same key now mints a fresh, superseding
  // session rather than replaying the long-dead one.
  clock.advance(60_001);
  const second = store.mint({
    browser_session_id: "bs_2",
    idempotency_key: "k-shared",
    interaction_id: "int_a",
    run_id: "run_a",
  });
  assert.notEqual(second.token, first.token);
  assert.equal(second.idempotency_replayed, false);
  assert.throws(
    () => store.attach({ interaction_id: "int_a", run_id: "run_a", token: first.token }),
    (err: unknown) => isCodedError(err, "invalid_token") || isCodedError(err, "session_invalidated")
  );
});

test("mint without an idempotency_key supersedes as before", () => {
  const clock = freshClock();
  const store = createStreamingSessionStore({ now: clock.now, ttlMs: 60_000 });
  const first = store.mint({
    browser_session_id: "bs_1",
    interaction_id: "int_a",
    run_id: "run_a",
    // No idempotency_key → behaves exactly as before this fix landed.
  });
  const second = store.mint({
    browser_session_id: "bs_2",
    interaction_id: "int_a",
    run_id: "run_a",
  });
  assert.notEqual(second.token, first.token);
  assert.equal(second.idempotency_replayed, false);
  assert.throws(
    () => store.attach({ interaction_id: "int_a", run_id: "run_a", token: first.token }),
    (err: unknown) => isCodedError(err, "invalid_token") || isCodedError(err, "session_invalidated")
  );
});

test("mint replay cannot resurrect a session that another mint superseded", () => {
  const clock = freshClock();
  const store = createStreamingSessionStore({
    mintIdempotencyTtlMs: 60_000,
    now: clock.now,
    ttlMs: 60_000,
  });
  const first = store.mint({
    browser_session_id: "bs_1",
    idempotency_key: "k-1",
    interaction_id: "int_a",
    run_id: "run_a",
  });
  // A second mint with a different key supersedes first.
  const second = store.mint({
    browser_session_id: "bs_2",
    idempotency_key: "k-2",
    interaction_id: "int_a",
    run_id: "run_a",
  });
  // Now a "replay" of k-1 must NOT return first's dead token. It must mint
  // afresh (supersedes second).
  const replay = store.mint({
    browser_session_id: "bs_3",
    idempotency_key: "k-1",
    interaction_id: "int_a",
    run_id: "run_a",
  });
  assert.notEqual(replay.token, first.token);
  assert.notEqual(replay.token, second.token);
  assert.equal(replay.idempotency_replayed, false);
  // Replay won; second is now invalidated.
  const attached = store.attach({ interaction_id: "int_a", run_id: "run_a", token: replay.token });
  assert.equal(attached.browser_session_id, "bs_3");
});

test("mint replay returns the same token even after the session is attached", () => {
  // Re-attach is now permitted, so a duplicate mint within the idempotency
  // window can honestly replay the original token — the operator gets the
  // live session they originally minted instead of a new one that would
  // supersede it. Stale-link replay protection comes from short TTL +
  // owner auth at mint time, not from refusing replays after attach.
  const clock = freshClock();
  const store = createStreamingSessionStore({
    mintIdempotencyTtlMs: 60_000,
    now: clock.now,
    ttlMs: 60_000,
  });
  const first = store.mint({
    browser_session_id: "bs_1",
    idempotency_key: "k-shared",
    interaction_id: "int_a",
    run_id: "run_a",
  });
  store.attach({ interaction_id: "int_a", run_id: "run_a", token: first.token });
  const replay = store.mint({
    browser_session_id: "bs_2",
    idempotency_key: "k-shared",
    interaction_id: "int_a",
    run_id: "run_a",
  });
  assert.equal(replay.token, first.token);
  assert.equal(replay.idempotency_replayed, true);
});

test("mint ignores empty / non-string idempotency_key (legacy callers behave as today)", () => {
  const clock = freshClock();
  const store = createStreamingSessionStore({ now: clock.now, ttlMs: 60_000 });
  const first = store.mint({
    browser_session_id: "bs_1",
    idempotency_key: "",
    interaction_id: "int_a",
    run_id: "run_a",
  });
  const second = store.mint({
    browser_session_id: "bs_2",
    idempotency_key: null,
    interaction_id: "int_a",
    run_id: "run_a",
  });
  assert.notEqual(second.token, first.token);
});
