import assert from "node:assert/strict";
import test from "node:test";

import {
  __test__,
  createSurfaceSessionStore,
  createStreamingSessionStore,
  DEFAULT_MINT_IDEMPOTENCY_TTL_MS,
  DEFAULT_STREAMING_SESSION_TTL_MS,
  MAX_IDEMPOTENCY_KEY_LEN,
} from "./index.ts";

function freshClock() {
  let t = 1_000_000_000;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
    set(ms: number) {
      t = ms;
    },
  };
}

test("default constants preserve the reference store contract", () => {
  assert.equal(DEFAULT_STREAMING_SESSION_TTL_MS, 5 * 60 * 1000);
  assert.equal(DEFAULT_MINT_IDEMPOTENCY_TTL_MS, 60 * 1000);
  assert.equal(MAX_IDEMPOTENCY_KEY_LEN, 256);
  assert.equal(
    __test__.hashToken("token"),
    "3c469e9d6c5875d37a43f353d4f88e61fcf812c66eee3457465a40b0da4153e0",
  );
});

test("mint binds the token to a single (run, interaction, browser session)", () => {
  const clock = freshClock();
  const store = createStreamingSessionStore({ now: clock.now, ttlMs: 60_000 });
  const { token, session } = store.mint({
    run_id: "run_a",
    interaction_id: "int_a",
    browser_session_id: "bs_1",
    viewport: { width: 800, height: 600 },
  });

  assert.equal(typeof token, "string");
  assert.ok(token.length >= 32);
  assert.equal(session.run_id, "run_a");
  assert.equal(session.interaction_id, "int_a");
  assert.equal(session.browser_session_id, "bs_1");
  assert.equal(session.attached_at, null);
  assert.equal(session.invalidated, false);
});

test("surface session store exposes host-neutral session/action names", () => {
  const clock = freshClock();
  const store = createSurfaceSessionStore({ now: clock.now, ttlMs: 60_000 });

  const minted = store.mint({
    surfaceSessionId: "session_a",
    actionId: "action_a",
    browserSessionId: "browser_a",
    idempotencyKey: "same-request",
  });

  assert.equal(minted.session.surfaceSessionId, "session_a");
  assert.equal(minted.session.actionId, "action_a");
  assert.equal(minted.session.browserSessionId, "browser_a");
  assert.equal(minted.idempotencyReplayed, false);

  const replayed = store.mint({
    surfaceSessionId: "session_a",
    actionId: "action_a",
    browserSessionId: "browser_a",
    idempotencyKey: "same-request",
  });
  assert.equal(replayed.token, minted.token);
  assert.equal(replayed.idempotencyReplayed, true);

  const attached = store.attach({
    token: minted.token,
    surfaceSessionId: "session_a",
    actionId: "action_a",
  });
  assert.equal(attached.attachedAt, clock.now());

  clock.advance(1);
  assert.equal(store.authorize({ token: minted.token }).surfaceSessionId, "session_a");
  assert.equal(store.getSummary({ surfaceSessionId: "session_a", actionId: "action_a" })?.actionId, "action_a");
  assert.equal(
    store.invalidate({ surfaceSessionId: "session_a", actionId: "action_a", reason: "resolved" })?.invalidatedReason,
    "resolved",
  );
  assert.equal(store.getSummary({ surfaceSessionId: "session_a", actionId: "action_a" }), null);
});

test("default session TTL is five minutes", () => {
  const clock = freshClock();
  const store = createStreamingSessionStore({ now: clock.now });
  const { token } = store.mint({
    run_id: "run_a",
    interaction_id: "int_a",
    browser_session_id: "bs_1",
  });
  store.attach({ token, run_id: "run_a", interaction_id: "int_a" });
  clock.advance(DEFAULT_STREAMING_SESSION_TTL_MS - 1);
  assert.equal(store.authorize({ token }).run_id, "run_a");
  clock.advance(1);
  assert.throws(() => store.authorize({ token }), (err: unknown) => errorCode(err) === "session_inactive");
});

test("attach marks attached_at on first attach and is idempotent on re-attach", () => {
  const clock = freshClock();
  const store = createStreamingSessionStore({ now: clock.now, ttlMs: 60_000 });
  const { token } = store.mint({
    run_id: "run_a",
    interaction_id: "int_a",
    browser_session_id: "bs_1",
  });

  const first = store.attach({ token, run_id: "run_a", interaction_id: "int_a" });
  assert.ok(first.attached_at);

  clock.advance(1000);
  const second = store.attach({ token, run_id: "run_a", interaction_id: "int_a" });
  assert.equal(second.attached_at, first.attached_at, "attached_at preserved across re-attach");
});

test("attach rejects a token bound to a different run or interaction", () => {
  const clock = freshClock();
  const store = createStreamingSessionStore({ now: clock.now, ttlMs: 60_000 });
  const { token } = store.mint({
    run_id: "run_a",
    interaction_id: "int_a",
    browser_session_id: "bs_1",
  });

  assert.throws(
    () => store.attach({ token, run_id: "run_b", interaction_id: "int_a" }),
    (err: unknown) => errorCode(err) === "wrong_run",
  );
  assert.throws(
    () => store.attach({ token, run_id: "run_a", interaction_id: "int_other" }),
    (err: unknown) => errorCode(err) === "wrong_interaction",
  );
});

test("attach rejects an expired token", () => {
  const clock = freshClock();
  const store = createStreamingSessionStore({ now: clock.now, ttlMs: 1_000 });
  const { token } = store.mint({
    run_id: "run_a",
    interaction_id: "int_a",
    browser_session_id: "bs_1",
  });
  clock.advance(2_000);
  assert.throws(
    () => store.attach({ token, run_id: "run_a", interaction_id: "int_a" }),
    (err: unknown) => ["session_expired", "invalid_token"].includes(errorCode(err)),
  );
});

test("attach rejects a token for a resolved interaction", () => {
  const clock = freshClock();
  const store = createStreamingSessionStore({ now: clock.now, ttlMs: 60_000 });
  const { token } = store.mint({
    run_id: "run_a",
    interaction_id: "int_a",
    browser_session_id: "bs_1",
  });
  store.invalidate({ run_id: "run_a", interaction_id: "int_a", reason: "interaction_success" });
  assert.throws(
    () => store.attach({ token, run_id: "run_a", interaction_id: "int_a" }),
    (err: unknown) => ["invalid_token", "session_invalidated"].includes(errorCode(err)),
  );
});

test("mint supersedes a prior unconsumed token for the same interaction", () => {
  const clock = freshClock();
  const store = createStreamingSessionStore({ now: clock.now, ttlMs: 60_000 });
  const { token: first } = store.mint({
    run_id: "run_a",
    interaction_id: "int_a",
    browser_session_id: "bs_1",
  });
  const { token: second } = store.mint({
    run_id: "run_a",
    interaction_id: "int_a",
    browser_session_id: "bs_2",
  });
  assert.notEqual(first, second);
  assert.throws(
    () => store.attach({ token: first, run_id: "run_a", interaction_id: "int_a" }),
    (err: unknown) => ["invalid_token", "session_invalidated"].includes(errorCode(err)),
  );
  const attached = store.attach({ token: second, run_id: "run_a", interaction_id: "int_a" });
  assert.equal(attached.browser_session_id, "bs_2");
});

test("authorize requires an attached token and rejects unattached use", () => {
  const clock = freshClock();
  const store = createStreamingSessionStore({ now: clock.now, ttlMs: 60_000 });
  const { token } = store.mint({
    run_id: "run_a",
    interaction_id: "int_a",
    browser_session_id: "bs_1",
  });
  assert.throws(() => store.authorize({ token }), (err: unknown) => errorCode(err) === "session_not_attached");
  store.attach({ token, run_id: "run_a", interaction_id: "int_a" });
  const session = store.authorize({ token });
  assert.equal(session.run_id, "run_a");
});

test("authorize rejects unknown and empty tokens", () => {
  const store = createStreamingSessionStore();
  assert.throws(() => store.authorize({ token: "" }), (err: unknown) => errorCode(err) === "invalid_token");
  assert.throws(
    () => store.authorize({ token: "not-a-real-token" }),
    (err: unknown) => ["session_inactive", "invalid_token"].includes(errorCode(err)),
  );
});

test("mint with the same idempotency_key replays the original session", () => {
  const clock = freshClock();
  const store = createStreamingSessionStore({
    now: clock.now,
    ttlMs: 60_000,
    mintIdempotencyTtlMs: 60_000,
  });
  const first = store.mint({
    run_id: "run_a",
    interaction_id: "int_a",
    browser_session_id: "bs_1",
    idempotency_key: "k-shared",
  });
  clock.advance(50);
  const second = store.mint({
    run_id: "run_a",
    interaction_id: "int_a",
    browser_session_id: "bs_2_unused",
    idempotency_key: "k-shared",
  });
  assert.equal(second.token, first.token);
  assert.equal(second.idempotency_replayed, true);
  assert.equal(first.idempotency_replayed, false);
  assert.equal(second.session.browser_session_id, "bs_1");
  const attached = store.attach({ token: first.token, run_id: "run_a", interaction_id: "int_a" });
  assert.equal(attached.browser_session_id, "bs_1");
});

test("idempotency keys are truncated to 256 characters", () => {
  const clock = freshClock();
  const store = createStreamingSessionStore({
    now: clock.now,
    ttlMs: 60_000,
    mintIdempotencyTtlMs: 60_000,
  });
  const longKey = `${"a".repeat(MAX_IDEMPOTENCY_KEY_LEN)}first`;
  const sameTruncatedKey = `${"a".repeat(MAX_IDEMPOTENCY_KEY_LEN)}second`;
  const first = store.mint({
    run_id: "run_a",
    interaction_id: "int_a",
    browser_session_id: "bs_1",
    idempotency_key: longKey,
  });
  const second = store.mint({
    run_id: "run_a",
    interaction_id: "int_a",
    browser_session_id: "bs_2",
    idempotency_key: sameTruncatedKey,
  });
  assert.equal(second.token, first.token);
  assert.equal(second.idempotency_replayed, true);
});

test("mint with a different idempotency_key supersedes the prior token", () => {
  const clock = freshClock();
  const store = createStreamingSessionStore({
    now: clock.now,
    ttlMs: 60_000,
    mintIdempotencyTtlMs: 60_000,
  });
  const first = store.mint({
    run_id: "run_a",
    interaction_id: "int_a",
    browser_session_id: "bs_1",
    idempotency_key: "k-1",
  });
  const second = store.mint({
    run_id: "run_a",
    interaction_id: "int_a",
    browser_session_id: "bs_2",
    idempotency_key: "k-2",
  });
  assert.notEqual(second.token, first.token);
  assert.equal(second.idempotency_replayed, false);
  assert.throws(
    () => store.attach({ token: first.token, run_id: "run_a", interaction_id: "int_a" }),
    (err: unknown) => ["invalid_token", "session_invalidated"].includes(errorCode(err)),
  );
  const attached = store.attach({ token: second.token, run_id: "run_a", interaction_id: "int_a" });
  assert.equal(attached.browser_session_id, "bs_2");
});

test("mint after idempotency cache TTL expires returns a fresh session", () => {
  const clock = freshClock();
  const store = createStreamingSessionStore({
    now: clock.now,
    ttlMs: 5 * 60_000,
    mintIdempotencyTtlMs: 60_000,
  });
  const first = store.mint({
    run_id: "run_a",
    interaction_id: "int_a",
    browser_session_id: "bs_1",
    idempotency_key: "k-shared",
  });
  clock.advance(60_001);
  const second = store.mint({
    run_id: "run_a",
    interaction_id: "int_a",
    browser_session_id: "bs_2",
    idempotency_key: "k-shared",
  });
  assert.notEqual(second.token, first.token);
  assert.equal(second.idempotency_replayed, false);
  assert.throws(
    () => store.attach({ token: first.token, run_id: "run_a", interaction_id: "int_a" }),
    (err: unknown) => ["invalid_token", "session_invalidated"].includes(errorCode(err)),
  );
});

test("mint without an idempotency_key supersedes as before", () => {
  const clock = freshClock();
  const store = createStreamingSessionStore({ now: clock.now, ttlMs: 60_000 });
  const first = store.mint({
    run_id: "run_a",
    interaction_id: "int_a",
    browser_session_id: "bs_1",
  });
  const second = store.mint({
    run_id: "run_a",
    interaction_id: "int_a",
    browser_session_id: "bs_2",
  });
  assert.notEqual(second.token, first.token);
  assert.equal(second.idempotency_replayed, false);
  assert.throws(
    () => store.attach({ token: first.token, run_id: "run_a", interaction_id: "int_a" }),
    (err: unknown) => ["invalid_token", "session_invalidated"].includes(errorCode(err)),
  );
});

test("mint replay cannot resurrect a session that another mint superseded", () => {
  const clock = freshClock();
  const store = createStreamingSessionStore({
    now: clock.now,
    ttlMs: 60_000,
    mintIdempotencyTtlMs: 60_000,
  });
  const first = store.mint({
    run_id: "run_a",
    interaction_id: "int_a",
    browser_session_id: "bs_1",
    idempotency_key: "k-1",
  });
  const second = store.mint({
    run_id: "run_a",
    interaction_id: "int_a",
    browser_session_id: "bs_2",
    idempotency_key: "k-2",
  });
  const replay = store.mint({
    run_id: "run_a",
    interaction_id: "int_a",
    browser_session_id: "bs_3",
    idempotency_key: "k-1",
  });
  assert.notEqual(replay.token, first.token);
  assert.notEqual(replay.token, second.token);
  assert.equal(replay.idempotency_replayed, false);
  const attached = store.attach({ token: replay.token, run_id: "run_a", interaction_id: "int_a" });
  assert.equal(attached.browser_session_id, "bs_3");
});

test("mint replay returns the same token even after the session is attached", () => {
  const clock = freshClock();
  const store = createStreamingSessionStore({
    now: clock.now,
    ttlMs: 60_000,
    mintIdempotencyTtlMs: 60_000,
  });
  const first = store.mint({
    run_id: "run_a",
    interaction_id: "int_a",
    browser_session_id: "bs_1",
    idempotency_key: "k-shared",
  });
  store.attach({ token: first.token, run_id: "run_a", interaction_id: "int_a" });
  const replay = store.mint({
    run_id: "run_a",
    interaction_id: "int_a",
    browser_session_id: "bs_2",
    idempotency_key: "k-shared",
  });
  assert.equal(replay.token, first.token);
  assert.equal(replay.idempotency_replayed, true);
});

test("mint ignores empty / non-string idempotency_key (legacy callers behave as today)", () => {
  const clock = freshClock();
  const store = createStreamingSessionStore({ now: clock.now, ttlMs: 60_000 });
  const first = store.mint({
    run_id: "run_a",
    interaction_id: "int_a",
    browser_session_id: "bs_1",
    idempotency_key: "",
  });
  const second = store.mint({
    run_id: "run_a",
    interaction_id: "int_a",
    browser_session_id: "bs_2",
    idempotency_key: null,
  });
  assert.notEqual(second.token, first.token);
});

test("invalidate drops active sessions for interaction resolution and run-end reasons", () => {
  const clock = freshClock();
  const store = createStreamingSessionStore({ now: clock.now, ttlMs: 60_000 });
  const success = store.mint({
    run_id: "run_a",
    interaction_id: "int_success",
    browser_session_id: "bs_1",
  });
  const ended = store.mint({
    run_id: "run_a",
    interaction_id: "int_ended",
    browser_session_id: "bs_2",
  });

  assert.equal(
    store.invalidate({ run_id: "run_a", interaction_id: "int_success", reason: "interaction_success" })
      ?.invalidated_reason,
    "interaction_success",
  );
  assert.equal(store.invalidate({ run_id: "run_a", interaction_id: "int_ended", reason: "run_ended" })?.invalidated_reason, "run_ended");
  assert.equal(store.getSummary({ run_id: "run_a", interaction_id: "int_success" }), null);
  assert.equal(store.getSummary({ run_id: "run_a", interaction_id: "int_ended" }), null);
  assert.throws(
    () => store.authorize({ token: success.token }),
    (err: unknown) => errorCode(err) === "session_inactive",
  );
  assert.throws(() => store.authorize({ token: ended.token }), (err: unknown) => errorCode(err) === "session_inactive");
});

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : "";
}
