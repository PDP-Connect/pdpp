// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { EmittedMessage, StreamScope } from "../../src/connector-runtime.ts";
import { spotifyCollect } from "./index.ts";

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function makeContext(state: Record<string, unknown> = {}): {
  messages: EmittedMessage[];
  ctx: Parameters<typeof spotifyCollect>[0];
} {
  const messages: EmittedMessage[] = [];
  const requested = new Map<string, StreamScope>([["saved_tracks", { name: "saved_tracks" }]]);
  return {
    messages,
    ctx: {
      credentials: { SPOTIFY_ACCESS_TOKEN: "test-token" },
      emit: (message) => {
        messages.push(message);
        return Promise.resolve();
      },
      emitRecord: () => Promise.resolve(),
      progress: () => Promise.resolve(),
      requested,
      state,
    },
  };
}

test("spotify: a 200 page without items fails before saved-track coverage or cursor advancement", async () => {
  globalThis.fetch = async () => jsonResponse({ next: null });
  const { ctx, messages } = makeContext({ saved_tracks: { last_added_at: "2026-01-01T00:00:00Z" } });

  await assert.rejects(() => spotifyCollect(ctx), /spotify_response_malformed/);
  assert.equal(
    messages.some((message) => message.type === "STATE" && message.stream === "saved_tracks"),
    false,
    "an absent items array must not advance the saved-track cursor"
  );
  assert.equal(
    messages.some((message) => message.type === "DETAIL_COVERAGE" && message.stream === "saved_tracks"),
    false,
    "an absent items array must not prove an empty saved-track boundary"
  );
});

test("spotify: an explicit empty items array remains a valid zero boundary", async () => {
  globalThis.fetch = async () => jsonResponse({ items: [], next: null });
  const { ctx, messages } = makeContext();

  await spotifyCollect(ctx);
  assert.equal(messages.filter((message) => message.type === "STATE" && message.stream === "saved_tracks").length, 1);
  const coverage = messages.find(
    (message): message is Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> =>
      message.type === "DETAIL_COVERAGE" && message.stream === "saved_tracks"
  );
  assert.ok(coverage);
  assert.equal(coverage.considered, 0);
  assert.equal(coverage.covered, 0);
});
