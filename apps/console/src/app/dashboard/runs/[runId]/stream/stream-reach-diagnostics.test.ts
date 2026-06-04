import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyStreamReachFailure,
  sanitizeStreamReachReason,
  STREAM_REACH_REASONS,
  type StreamReachReason,
} from "./stream-reach-diagnostics.ts";

test("401 classifies as invalid_token", () => {
  const { reason } = classifyStreamReachFailure({ probeStatus: 401 });
  assert.equal(reason, "invalid_token");
});

test("409 classifies as session_consumed", () => {
  const { reason } = classifyStreamReachFailure({ probeStatus: 409 });
  assert.equal(reason, "session_consumed");
});

test("410 with no code classifies as session_expired (the common expiry case)", () => {
  const { reason } = classifyStreamReachFailure({ probeStatus: 410, probeCode: null });
  assert.equal(reason, "session_expired");
});

test("410 with session_expired code classifies as session_expired", () => {
  const { reason } = classifyStreamReachFailure({ probeStatus: 410, probeCode: "session_expired" });
  assert.equal(reason, "session_expired");
});

test("410 with companion_unavailable code classifies as companion_unavailable", () => {
  // The two 410 cases share a status code; only the body code separates them.
  const { reason } = classifyStreamReachFailure({
    probeStatus: 410,
    probeCode: "companion_unavailable",
  });
  assert.equal(reason, "companion_unavailable");
});

test("a thrown probe (no HTTP response) classifies as unreachable_origin", () => {
  const { reason } = classifyStreamReachFailure({ probeStatus: null, probeError: true });
  assert.equal(reason, "unreachable_origin");
});

test("a null status without an explicit error flag still classifies as unreachable_origin", () => {
  // Defensive: any path that produced no status means the server was not
  // reached. We must not fabricate a more specific reason.
  const { reason } = classifyStreamReachFailure({ probeStatus: null });
  assert.equal(reason, "unreachable_origin");
});

test("an answered-but-unrecognized status (5xx) classifies as unknown", () => {
  const { reason } = classifyStreamReachFailure({ probeStatus: 502 });
  assert.equal(reason, "unknown");
});

test("unknown preserves the prior generic give-up message verbatim (no regression)", () => {
  const { troubleMessage } = classifyStreamReachFailure({ probeStatus: 500 });
  assert.equal(troubleMessage, "Couldn't reach the browser stream after several tries.");
});

test("every reason yields a non-empty operator message that never claims success", () => {
  for (const status of [401, 409, 410, 502]) {
    const { reason, troubleMessage } = classifyStreamReachFailure({ probeStatus: status });
    assert.ok(STREAM_REACH_REASONS.includes(reason), `reason ${reason} is in the closed set`);
    assert.ok(troubleMessage.length > 0, "message is non-empty");
    assert.ok(
      !/connected|recovered|success/i.test(troubleMessage),
      `message must not imply recovery: ${troubleMessage}`
    );
  }
});

test("specific reasons carry messages distinct from the generic give-up", () => {
  const generic = classifyStreamReachFailure({ probeStatus: 500 }).troubleMessage;
  for (const status of [401, 409, 410]) {
    const { troubleMessage } = classifyStreamReachFailure({ probeStatus: status });
    assert.notEqual(troubleMessage, generic, `status ${status} should improve on the generic message`);
  }
});

test("sanitizeStreamReachReason passes through every member of the closed set", () => {
  for (const reason of STREAM_REACH_REASONS) {
    assert.equal(sanitizeStreamReachReason(reason), reason);
  }
});

test("sanitizeStreamReachReason clamps unknown/hostile values to unknown", () => {
  const hostile: unknown[] = ["", "DROP TABLE", "INVALID_TOKEN", 401, null, undefined, {}];
  for (const value of hostile) {
    assert.equal(sanitizeStreamReachReason(value), "unknown" satisfies StreamReachReason);
  }
});
