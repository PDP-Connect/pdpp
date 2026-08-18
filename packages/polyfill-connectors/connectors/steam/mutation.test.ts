// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { EmittedMessage, StreamScope } from "../../src/connector-runtime.ts";
import { makeRecordingEmit } from "../../src/test-harness.ts";
import { steamCollect } from "./index.ts";
import { validateRecord } from "./schemas.ts";

const ORIGINAL_FETCH = globalThis.fetch;
const STEAM_ID = "76561198012345678";

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function makeContext(streams: readonly string[]): {
  ctx: Parameters<typeof steamCollect>[0];
  messages: EmittedMessage[];
  skippedRecords: ReturnType<typeof makeRecordingEmit>["skipped"];
} {
  const harness = makeRecordingEmit(validateRecord);
  const requested = new Map<string, StreamScope>(streams.map((name) => [name, { name }]));
  return {
    messages: harness.protocolMessages,
    skippedRecords: harness.skipped,
    ctx: {
      credentials: { STEAM_API_KEY: "test-key", STEAM_USER_ID: STEAM_ID },
      emit: harness.emit,
      emitRecord: harness.emitRecord,
      progress: () => Promise.resolve(),
      requested,
      state: {},
    },
  };
}

const missingArrayCases = [
  { body: { response: { game_count: 3 } }, stream: "owned_games" },
  { body: { friendslist: {} }, stream: "friends" },
] as const;

for (const { body, stream } of missingArrayCases) {
  test(`steam: 200 ${stream} envelope without its list fails before state or coverage`, async () => {
    globalThis.fetch = async () => jsonResponse(body);
    const { ctx, messages } = makeContext([stream]);

    await assert.rejects(() => steamCollect(ctx), /steam_response_malformed/);
    assert.equal(
      messages.some((message) => message.type === "STATE" && message.stream === stream),
      false,
      "an omitted list must not advance its cursor"
    );
    assert.equal(
      messages.some((message) => message.type === "DETAIL_COVERAGE" && message.stream === stream),
      false,
      "an omitted list must not prove an empty boundary"
    );
  });
}

test("steam: recently_played_games with games entirely absent is a well-formed empty answer, not malformed", async () => {
  // GetRecentlyPlayedGames documented shape when the account played nothing
  // in the trailing two-week window: {"response":{"total_count":0}}, no
  // `games` key at all. This must succeed with zero records, not throw
  // steam_response_malformed (regression for 3ccca8000).
  globalThis.fetch = async () => jsonResponse({ response: { total_count: 0 } });
  const { ctx, messages } = makeContext(["recently_played_games"]);

  await steamCollect(ctx);
  assert.equal(
    messages.filter((message) => message.type === "STATE" && message.stream === "recently_played_games").length,
    1,
    "an absent list must still advance its cursor as a real empty snapshot"
  );
  const coverage = messages.find(
    (message): message is Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> =>
      message.type === "DETAIL_COVERAGE" && message.stream === "recently_played_games"
  );
  assert.ok(coverage);
  assert.equal(coverage.considered, 0);
  assert.equal(coverage.covered, 0);
});

test("steam: recently_played_games with games present but not an array is still malformed", async () => {
  // A present-but-wrong-shaped `games` field is a genuine protocol violation
  // (unlike an absent field), and must still fail before state or coverage.
  globalThis.fetch = async () => jsonResponse({ response: { total_count: 3, games: "not-an-array" } });
  const { ctx, messages } = makeContext(["recently_played_games"]);

  await assert.rejects(() => steamCollect(ctx), /steam_response_malformed/);
  assert.equal(
    messages.some((message) => message.type === "STATE" && message.stream === "recently_played_games"),
    false,
    "a malformed list must not advance its cursor"
  );
  assert.equal(
    messages.some((message) => message.type === "DETAIL_COVERAGE" && message.stream === "recently_played_games"),
    false,
    "a malformed list must not prove an empty boundary"
  );
});

test("steam: an explicit empty games array remains valid zero proof", async () => {
  globalThis.fetch = async () => jsonResponse({ response: { games: [] } });
  const { ctx, messages } = makeContext(["owned_games"]);

  await steamCollect(ctx);
  assert.equal(messages.filter((message) => message.type === "STATE" && message.stream === "owned_games").length, 1);
  const coverage = messages.find(
    (message): message is Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> =>
      message.type === "DETAIL_COVERAGE" && message.stream === "owned_games"
  );
  assert.ok(coverage);
  assert.equal(coverage.considered, 0);
  assert.equal(coverage.covered, 0);
});

test("steam: an invalid player_level fails schema coverage without a green checkpoint", async () => {
  globalThis.fetch = async () => jsonResponse({ response: { player_level: "not-a-number" } });
  const { ctx, messages, skippedRecords } = makeContext(["steam_level"]);

  await steamCollect(ctx);
  assert.equal(
    skippedRecords.some((record) => record.stream === "steam_level"),
    true,
    "the runtime-shaped record must be rejected"
  );
  assert.equal(
    messages.some((message) => message.type === "STATE" && message.stream === "steam_level"),
    false,
    "an invalid level must not advance the stream cursor"
  );
  const coverage = messages.find(
    (message): message is Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> =>
      message.type === "DETAIL_COVERAGE" && message.stream === "steam_level"
  );
  assert.ok(coverage);
  assert.equal(coverage.considered, 1);
  assert.equal(coverage.covered, 0);
});
