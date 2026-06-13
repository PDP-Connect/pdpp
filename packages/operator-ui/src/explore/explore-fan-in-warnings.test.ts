/**
 * Fan-in failure classification + summarization.
 *
 * Locks the Explore reading-room contract that revoked/inactive/not-granted
 * reads are summarized into ONE humane "partial view" warning (never the raw
 * RS error envelope, never one feed row per failed stream) and that warning
 * codes are deduped so the canvas never emits duplicate React keys.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyFanInFailure, type FanInFailure, summarizeFanInFailures } from "./explore-data-assembler.ts";

const FOUR_STREAMS_TWO_SOURCES_RE = /4 streams from 2 .*sources/;
const CLAUDE_CODE_RE = /Claude Code/;
const OPENAI_CODEX_RE = /OpenAI Codex CLI/;

// The live RS error message embeds the JSON envelope + HTTP status.
function rsError(path: string, status: number, envelope: object): Error {
  return new Error(`RS ${path} failed (${status}): ${JSON.stringify(envelope)}`);
}

const revokedEnvelope = {
  error: {
    type: "invalid_request_error",
    code: "connector_instance_inactive",
    message: "Connector instance 'cin_abc' is 'revoked', not active.",
    request_id: "req_1",
  },
};

test("classifies a revoked connector_instance_inactive read as expected", () => {
  const result = classifyFanInFailure(rsError("/v1/streams/sessions/records", 400, revokedEnvelope));
  assert.equal(result.expected, true);
  assert.equal(result.reason, "revoked or inactive");
});

test("classifies a 404 (manifest-dropped stream) as expected", () => {
  const result = classifyFanInFailure(rsError("/v1/streams/gone/records", 404, {}));
  assert.equal(result.expected, true);
});

test("classifies a 403 not-granted read as expected", () => {
  const result = classifyFanInFailure(
    rsError("/v1/streams/x/records", 403, { error: { code: "not_granted", message: "not granted" } })
  );
  assert.equal(result.expected, true);
  assert.equal(result.reason, "not granted");
});

test("classifies a 500 server fault as unexpected with an envelope-free reason", () => {
  const result = classifyFanInFailure(rsError("/v1/streams/x/records", 500, { error: { code: "internal" } }));
  assert.equal(result.expected, false);
  // The reason never contains the raw envelope.
  assert.ok(!result.reason.includes("{"));
});

test("summarizes many expected failures into ONE deduped partial_fan_in warning", () => {
  const failures: FanInFailure[] = [
    { connectionName: "Claude Code", expected: true, reason: "revoked or inactive", stream: "sessions" },
    { connectionName: "Claude Code", expected: true, reason: "revoked or inactive", stream: "messages" },
    { connectionName: "Claude Code", expected: true, reason: "revoked or inactive", stream: "attachments" },
    { connectionName: "OpenAI Codex CLI", expected: true, reason: "revoked or inactive", stream: "sessions" },
  ];
  const warnings = summarizeFanInFailures(failures);

  // Exactly one warning, with the stable partial_fan_in code (no duplicate keys).
  const fanIn = warnings.filter((w) => w.code === "partial_fan_in");
  assert.equal(fanIn.length, 1);
  const only = fanIn[0];
  assert.ok(only);
  // It summarizes count of streams + distinct sources, and never leaks JSON.
  assert.match(only.message, FOUR_STREAMS_TWO_SOURCES_RE);
  assert.match(only.message, CLAUDE_CODE_RE);
  assert.match(only.message, OPENAI_CODEX_RE);
  assert.ok(!only.message.includes("{"));
  assert.ok(!only.message.includes("connector_instance_inactive"));
});

test("keeps a separate terse warning for unexpected failures, still envelope-free", () => {
  const failures: FanInFailure[] = [
    { connectionName: "Claude Code", expected: true, reason: "revoked or inactive", stream: "sessions" },
    { connectionName: "Strava", expected: false, reason: "HTTP 500", stream: "activities" },
  ];
  const warnings = summarizeFanInFailures(failures);
  const codes = warnings.map((w) => w.code).sort();
  assert.deepEqual(codes, ["partial_fan_in", "partial_fan_in_error"]);
  // Codes are unique, so the canvas key={w.code} (or `${code}:${i}`) never collides.
  assert.equal(new Set(codes).size, codes.length);
  for (const w of warnings) {
    assert.ok(!w.message.includes("{"));
  }
});

test("returns no warnings when there are no failures", () => {
  assert.deepEqual(summarizeFanInFailures([]), []);
});
