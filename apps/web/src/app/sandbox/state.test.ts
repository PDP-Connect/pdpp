import assert from "node:assert/strict";
import test from "node:test";
import { buildTranscript, INITIAL_STATE, reduce, type SandboxState } from "./state.ts";

function run(actions: Parameters<typeof reduce>[1]["type"][]): SandboxState {
  return actions.reduce<SandboxState>((state, type) => reduce(state, { type } as Parameters<typeof reduce>[1]), {
    ...INITIAL_STATE,
  });
}

test("happy path advances request -> approve -> query -> revoke", () => {
  const final = run(["request", "approve", "query", "revoke"]);
  assert.equal(final.phase, "revoked");
  assert.equal(final.decision, "approved");
  assert.equal(final.recordsVisible, false);
  assert.ok(final.lastDeniedQueryAt, "revoked phase records the denied-attempt timestamp");
});

test("records are only visible after a query against an approved grant", () => {
  const requested = run(["request"]);
  assert.equal(requested.recordsVisible, false);

  const granted = run(["request", "approve"]);
  assert.equal(granted.recordsVisible, false);

  const queried = run(["request", "approve", "query"]);
  assert.equal(queried.recordsVisible, true);
});

test("revoke hides records and pins the refusal evidence", () => {
  const queried = run(["request", "approve", "query"]);
  const revoked = reduce(queried, { type: "revoke" });
  assert.equal(revoked.recordsVisible, false);
  assert.ok(revoked.lastDeniedQueryAt);
});

test("deny returns to initial state but keeps history breadcrumb", () => {
  const denied = run(["request", "deny"]);
  assert.equal(denied.phase, "initial");
  assert.equal(denied.decision, "pending");
  assert.ok(denied.history.length > INITIAL_STATE.history.length);
});

test("reset returns to initial regardless of phase", () => {
  const queried = run(["request", "approve", "query"]);
  const reset = reduce(queried, { type: "reset" });
  assert.deepEqual(reset, INITIAL_STATE);
});

test("invalid transitions are no-ops, not errors", () => {
  const initial = INITIAL_STATE;
  // Cannot approve before requesting.
  assert.deepEqual(reduce(initial, { type: "approve" }), initial);
  // Cannot query before approving.
  const requested = reduce(initial, { type: "request" });
  assert.deepEqual(reduce(requested, { type: "query" }), requested);
  // Cannot query after revocation.
  const revoked = run(["request", "approve", "query", "revoke"]);
  assert.deepEqual(reduce(revoked, { type: "query" }), revoked);
});

test("transcript entries reveal in lockstep with phases reached", () => {
  const initial = buildTranscript(INITIAL_STATE);
  assert.deepEqual(
    initial.map((entry) => entry.available),
    [false, false, false, false]
  );

  const queried = buildTranscript(run(["request", "approve", "query"]));
  assert.deepEqual(
    queried.map((entry) => entry.available),
    [true, true, true, false]
  );

  const revoked = buildTranscript(run(["request", "approve", "query", "revoke"]));
  assert.deepEqual(
    revoked.map((entry) => entry.available),
    [true, true, true, true]
  );
});

test("transcript bodies always carry the simulated flag", () => {
  const revoked = buildTranscript(run(["request", "approve", "query", "revoke"]));
  for (const entry of revoked) {
    assert.equal((entry.body as { simulated: boolean }).simulated, true, `${entry.id} must be marked simulated`);
  }
});

test("revoked transcript captures the 403 refusal example", () => {
  const revoked = buildTranscript(run(["request", "approve", "query", "revoke"]));
  const last = revoked.at(-1);
  const body = last?.body as { next_attempt?: { status?: number; error?: string } };
  assert.equal(body?.next_attempt?.status, 403);
  assert.equal(body?.next_attempt?.error, "grant_revoked");
});
