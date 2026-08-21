// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Steam declares its own inventory size (`game_count` on GetOwnedGames,
 * `total_count` on GetRecentlyPlayedGames) alongside the array it serves. Both
 * calls are unpaginated, so before this contract the coverage denominator was
 * the length of whatever array arrived — a silently truncated response read as
 * fully covered.
 *
 * These tests drive the real `steamCollect` path with a stubbed transport and
 * assert on the emitted DETAIL_COVERAGE, so they fail if the denominator ever
 * reverts to the served length.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { steamCollect } from "./index.ts";

const STEAM_ID = "76561198000000000";

interface CoverageMessage {
  considered: number | undefined;
  covered: number | undefined;
  stream: string;
}

function ownedGame(appid: number): Record<string, unknown> {
  return { appid, name: `Game ${appid}`, playtime_forever: 0 };
}

function recentGame(appid: number): Record<string, unknown> {
  return { appid, name: `Game ${appid}`, playtime_forever: 0, playtime_2weeks: 0 };
}

/**
 * Run one Steam stream against a canned wire payload and return the coverage
 * message the connector emitted for it.
 */
async function collectStream(
  stream: "owned_games" | "recently_played_games",
  payload: unknown
): Promise<{ coverage: CoverageMessage | undefined; recordCount: number }> {
  const originalFetch = globalThis.fetch;
  const originalUserId = process.env.STEAM_USER_ID;
  const coverages: CoverageMessage[] = [];
  let recordCount = 0;

  globalThis.fetch = (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/GetOwnedGames/v0001") || url.pathname.endsWith("/GetRecentlyPlayedGames/v0001")) {
      return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }));
    }
    throw new Error(`unexpected Steam request: ${url.pathname}`);
  };
  process.env.STEAM_USER_ID = STEAM_ID;

  try {
    await steamCollect({
      state: {},
      requested: new Map([[stream, { name: stream }]]),
      credentials: { STEAM_API_KEY: "synthetic-api-key" },
      emit: (msg) => {
        const candidate = msg as unknown as { type?: string } & CoverageMessage;
        if (candidate.type === "DETAIL_COVERAGE" && candidate.stream === stream) {
          coverages.push({
            stream: candidate.stream,
            considered: candidate.considered,
            covered: candidate.covered,
          });
        }
        return Promise.resolve();
      },
      emitRecord: () => {
        recordCount += 1;
        return Promise.resolve();
      },
      progress: () => Promise.resolve(),
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUserId === undefined) {
      delete process.env.STEAM_USER_ID;
    } else {
      process.env.STEAM_USER_ID = originalUserId;
    }
  }

  return { coverage: coverages.at(-1), recordCount };
}

test("steam owned_games - a truncated games array reads partial against the declared game_count", async () => {
  // Steam says the account owns 10 games but serves only 3. Before the provider
  // total was bound, considered would have been 3 and the run read complete.
  const { coverage, recordCount } = await collectStream("owned_games", {
    response: { game_count: 10, games: [ownedGame(10), ownedGame(20), ownedGame(30)] },
  });

  assert.equal(recordCount, 3, "only the served games can be emitted");
  assert.equal(coverage?.considered, 10, "denominator must be Steam's declared game_count, not the served length");
  assert.equal(coverage?.covered, 3, "covered counts only what was actually served and validated");
  assert.ok(
    (coverage?.covered ?? 0) < (coverage?.considered ?? 0),
    "a truncated response must read as a coverage shortfall"
  );
});

test("steam owned_games - a complete response reads fully covered", async () => {
  const { coverage } = await collectStream("owned_games", {
    response: { game_count: 2, games: [ownedGame(10), ownedGame(20)] },
  });

  assert.equal(coverage?.considered, 2);
  assert.equal(coverage?.covered, 2, "an untruncated snapshot still proves full coverage");
});

test("steam owned_games - a game_count below the served length is a protocol violation", async () => {
  // An impossible total is worse than no total: it would understate the
  // denominator and could make a partial run read as over-covered.
  await assert.rejects(
    collectStream("owned_games", {
      response: { game_count: 1, games: [ownedGame(10), ownedGame(20)] },
    }),
    /steam_response_malformed: response\.game_count \(1\) is less than the served item count \(2\)/
  );
});

test("steam owned_games - a non-integer game_count fails closed", async () => {
  await assert.rejects(
    collectStream("owned_games", {
      response: { game_count: "many", games: [ownedGame(10)] },
    }),
    /steam_response_malformed: response\.game_count must be a nonnegative integer/
  );
});

test("steam owned_games - an absent game_count falls back to the served length", async () => {
  // The field is optional in the wire contract; absence must not fail the run.
  const { coverage } = await collectStream("owned_games", {
    response: { games: [ownedGame(10), ownedGame(20)] },
  });

  assert.equal(coverage?.considered, 2);
  assert.equal(coverage?.covered, 2);
});

test("steam recently_played_games - a truncated array reads partial against total_count", async () => {
  const { coverage } = await collectStream("recently_played_games", {
    response: { total_count: 5, games: [recentGame(10)] },
  });

  assert.equal(coverage?.considered, 5, "denominator must be Steam's declared total_count");
  assert.equal(coverage?.covered, 1);
});

test("steam recently_played_games - the documented empty shape proves an empty window", async () => {
  // `{"response":{"total_count":0}}` with no `games` key is Steam's well-formed
  // answer for an account that played nothing recently. That is proven-empty,
  // not a failure.
  const { coverage, recordCount } = await collectStream("recently_played_games", {
    response: { total_count: 0 },
  });

  assert.equal(recordCount, 0);
  assert.equal(coverage?.considered, 0);
  assert.equal(coverage?.covered, 0);
});
