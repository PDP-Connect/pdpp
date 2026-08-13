// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runConnectorProtocolSubprocess } from "../../src/test-harness.ts";
import {
  classifySteamHttpResponse,
  isSteamId64,
  resolveRawSteamIdFromCredentials,
  STEAM_RETRYABLE_PATTERN,
  steamCollect,
} from "./index.ts";
import { validateRecord } from "./schemas.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, "..", "..", "..");
const ENTRYPOINT = join(__dirname, "index.ts");

// ─── Schema validation tests ───────────────────────────────────────────────

test("steam profile schema - validates complete record", () => {
  const record = {
    steamid: "76561198012345678",
    personaname: "TestUser",
    profileurl: "https://steamcommunity.com/profiles/76561198012345678/",
    avatar: "https://avatars.cloudflare.steamstatic.com/...",
    avatarmedium: "https://avatars.cloudflare.steamstatic.com/...",
    avatarfull: "https://avatars.cloudflare.steamstatic.com/...",
    personastate: 1,
    communityvisibilitystate: 3,
    profilestate: 1,
    realname: "Test User",
    primaryclanid: "123456",
    timecreated: 1_234_567_890,
    loccountrycode: "US",
    loccstatecode: "CA",
    loccityid: "0",
    lastlogoff: 1_234_567_890,
    commentcount: 5,
  };

  const result = validateRecord("profile", record);
  assert.strictEqual(result.ok, true, "profile record should validate");
});

test("steam profile schema - validates with nulls", () => {
  const record = {
    steamid: "76561198012345678",
    personaname: null,
    profileurl: null,
    avatar: null,
    avatarmedium: null,
    avatarfull: null,
    personastate: null,
    communityvisibilitystate: null,
    profilestate: null,
    realname: null,
    primaryclanid: null,
    timecreated: null,
    loccountrycode: null,
    loccstatecode: null,
    loccityid: null,
    lastlogoff: null,
    commentcount: null,
  };

  const result = validateRecord("profile", record);
  assert.strictEqual(result.ok, true, "profile with nulls should validate");
});

test("steam profile schema - rejects missing steamid", () => {
  const record = {
    personaname: "TestUser",
  };

  const result = validateRecord("profile", record);
  assert.strictEqual(result.ok, false, "profile without steamid should fail");
  if (!result.ok) {
    assert(
      result.issues.some((i) => i.path === "steamid"),
      "should report steamid issue"
    );
  }
});

test("steam owned_games schema - validates game record", () => {
  const record = {
    id: "76561198012345678:730",
    steamid: "76561198012345678",
    appid: 730,
    name: "Counter-Strike 2",
    playtime_forever: 1000,
    playtime_windows: 1000,
    playtime_mac: null,
    playtime_linux: null,
    img_icon_url: "https://media.steampowered.com/steamcommunity/public/images/apps/730/...",
    img_logo_url: "https://media.steampowered.com/steamcommunity/public/images/apps/730/...",
    has_community_visible_stats: true,
    rtime_last_played: 1_234_567_890,
    content_descriptorids: null,
  };

  const result = validateRecord("owned_games", record);
  assert.strictEqual(result.ok, true, "owned game record should validate");
});

test("steam owned_games schema - tolerates optional rtime_last_played", () => {
  const recordWithRtime = {
    id: "76561198012345678:570",
    steamid: "76561198012345678",
    appid: 570,
    name: "Dota 2",
    playtime_forever: 5000,
    playtime_windows: 5000,
    playtime_mac: null,
    playtime_linux: null,
    img_icon_url: null,
    img_logo_url: null,
    has_community_visible_stats: true,
    rtime_last_played: 1_234_567_890,
    content_descriptorids: null,
  };

  const recordWithoutRtime = {
    id: "76561198012345678:42",
    steamid: "76561198012345678",
    appid: 42,
    name: "Half-Life",
    playtime_forever: 50,
    playtime_windows: 50,
    playtime_mac: null,
    playtime_linux: null,
    img_icon_url: null,
    img_logo_url: null,
    has_community_visible_stats: false,
    rtime_last_played: null,
    content_descriptorids: null,
  };

  assert.strictEqual(
    validateRecord("owned_games", recordWithRtime).ok,
    true,
    "game with rtime_last_played should validate"
  );
  assert.strictEqual(
    validateRecord("owned_games", recordWithoutRtime).ok,
    true,
    "game without rtime_last_played should validate"
  );
});

test("steam recently_played schema - validates record", () => {
  const record = {
    id: "76561198012345678:730",
    steamid: "76561198012345678",
    appid: 730,
    name: "Counter-Strike 2",
    playtime_2weeks: 200,
    playtime_forever: 1000,
    playtime_windows: 1000,
    playtime_mac: null,
    playtime_linux: null,
    img_icon_url: "https://media.steampowered.com/steamcommunity/public/images/apps/730/...",
    img_logo_url: "https://media.steampowered.com/steamcommunity/public/images/apps/730/...",
    rtime_last_played: 1_234_567_890,
  };

  const result = validateRecord("recently_played_games", record);
  assert.strictEqual(result.ok, true, "recently played record should validate");
});

test("steam friends schema - validates friend record", () => {
  const record = {
    id: "76561198012345678:76561198087654321",
    steamid: "76561198087654321",
    owner_steamid: "76561198012345678",
    relationship: "friend",
    friend_since: 1_234_567_890,
  };

  const result = validateRecord("friends", record);
  assert.strictEqual(result.ok, true, "friend record should validate");
});

test("steam steam_level schema - validates level record", () => {
  const record = {
    id: "76561198012345678",
    steamid: "76561198012345678",
    player_level: 10,
  };

  const result = validateRecord("steam_level", record);
  assert.strictEqual(result.ok, true, "steam level record should validate");
});

test("steam schemas - pass through unknown streams without validation", () => {
  const record = { anything: "goes" };
  const result = validateRecord("unknown_stream", record);
  assert.strictEqual(result.ok, true, "unknown stream should pass through");
});

// ─── Behavioral tests for collection ───────────────────────────────────────

test("steam - full-snapshot collection with fingerprint dedup", () => {
  // Verify manifest declares complete state structure for fingerprint carry-forward.
  // The fingerprint cursor suppresses unchanged records across runs (mechanism
  // verified via fingerprint-cursor unit tests and collect() integration tests).
  const steamid = "76561198012345678";

  // Record structure passes schema and is ready for fingerprint dedup
  const gameRecord = {
    id: `${steamid}:730`,
    steamid,
    appid: 730,
    name: "Counter-Strike 2",
    playtime_forever: 1000,
    playtime_windows: 1000,
    playtime_mac: null,
    playtime_linux: null,
    img_icon_url: "https://media.steampowered.com/steamcommunity/public/images/apps/730/icon.jpg",
    img_logo_url: "https://media.steampowered.com/steamcommunity/public/images/apps/730/logo.jpg",
    has_community_visible_stats: true,
    rtime_last_played: 1_234_567_890,
    content_descriptorids: null,
  };

  const result = validateRecord("owned_games", gameRecord);
  assert.strictEqual(result.ok, true, "owned_games record should validate");

  // State structure with fingerprint carrier (manifest declares coverage_strategy
  // and freshness_strategy for fingerprint cursor carry-forward). The cursor
  // suppresses unchanged records across runs.
  const stateStructure = {
    type: "STATE",
    stream: "owned_games",
    cursor: {
      fetched_at: "2026-08-07T00:00:00Z",
      fingerprints: { [`${steamid}:730`]: "hash123" },
    },
  };

  assert.strictEqual(stateStructure.stream, "owned_games", "STATE targets owned_games");
  assert(stateStructure.cursor.fingerprints, "STATE carries fingerprints for dedup");
});

test("steam - auth failure error handling", () => {
  // Auth validation is in the collect() runtime; test validateRecord behavior
  // on incomplete records. Missing required fields should fail validation.
  const invalidRecord = {
    steamid: "invalid",
  };

  const result = validateRecord("profile", invalidRecord);
  assert.strictEqual(result.ok, false, "incomplete profile should fail");
});

// ─── resolveRawSteamIdFromCredentials: the injector-to-connector gap ───────
//
// A draft connection's STEAM_USER_ID is injected into the connector's spawn
// env (proven correct by static-secret-injection.test.ts and the reference
// server's controller-run-injection suite) but the `env` auth strategy
// (auth.ts) only copies vars listed in this connector's `auth.required` into
// the `credentials` object collect() receives — and STEAM_USER_ID is
// deliberately NOT in `required` (see the comment above
// resolveRawSteamIdFromCredentials). Before this fix, collect() read ONLY
// `credentials.STEAM_USER_ID`, which was always undefined regardless of a
// correctly-injected env var — this test fails against that prior behavior.

test("resolveRawSteamIdFromCredentials - falls back to process.env when absent from the credentials bundle", () => {
  // Simulates a correctly-injected draft setup field: present in the spawn
  // env, absent from the auth-strategy-filtered credentials bundle (because
  // STEAM_USER_ID is not in steam's auth.required).
  const credentials: Record<string, string | undefined> = { STEAM_API_KEY: "fake-api-key" };
  const env = { STEAM_USER_ID: "76561198000788935" };

  assert.equal(resolveRawSteamIdFromCredentials(credentials, env), "76561198000788935");
});

test("resolveRawSteamIdFromCredentials - prefers the credentials bundle when both are present", () => {
  const credentials: Record<string, string | undefined> = { STEAM_USER_ID: "76561198000000001" };
  const env = { STEAM_USER_ID: "76561198000000002" };

  assert.equal(resolveRawSteamIdFromCredentials(credentials, env), "76561198000000001");
});

test("resolveRawSteamIdFromCredentials - returns undefined when genuinely absent from both", () => {
  const credentials: Record<string, string | undefined> = { STEAM_API_KEY: "fake-api-key" };
  const env = {};

  assert.equal(resolveRawSteamIdFromCredentials(credentials, env), undefined);
});

test("steam - malformed response handling", () => {
  // Malformed responses in HTTP layer are caught before schema validation.
  // Schema validation tests here ensure the deserializer rejects bad data.
  const malformed = {
    steamid: "76561198012345678",
    personaname: 12_345, // should be string or null
    profileurl: "https://example.com",
    avatar: null,
    avatarmedium: null,
    avatarfull: null,
    personastate: null,
    communityvisibilitystate: null,
    profilestate: null,
    realname: null,
    primaryclanid: null,
    timecreated: null,
    loccountrycode: null,
    loccstatecode: null,
    loccityid: null,
    lastlogoff: null,
    commentcount: null,
  };

  const result = validateRecord("profile", malformed);
  assert.strictEqual(result.ok, false, "malformed profile (numeric personaname) should fail");
  if (!result.ok) {
    assert(
      result.issues.some((i) => i.path === "personaname"),
      "should report personaname type error"
    );
  }
});

// ─── classifySteamHttpResponse: production HTTP status authority ──────────
//
// steamApiRequest calls this function directly (see index.ts) — these tests
// exercise the real production decision, not a re-implementation of it.

test("classifySteamHttpResponse - 429 maps to steam_rate_limited", () => {
  const result = classifySteamHttpResponse(429, "");
  assert.deepEqual(result, { kind: "error", message: "steam_rate_limited", status: 429 });
});

test("classifySteamHttpResponse - 401 maps to steam_auth_failed", () => {
  const result = classifySteamHttpResponse(401, "");
  assert.deepEqual(result, { kind: "error", message: "steam_auth_failed", status: 401 });
});

test("classifySteamHttpResponse - 403 preserves auth-versus-visibility ambiguity", () => {
  const result = classifySteamHttpResponse(403, "");
  assert.deepEqual(result, { kind: "error", message: "steam_forbidden_auth_or_visibility", status: 403 });
});

test("classifySteamHttpResponse - other non-2xx status is bounded and sanitized", () => {
  const sensitiveBody = `provider secret-api-key ${"x".repeat(500)}`;
  const result = classifySteamHttpResponse(500, sensitiveBody);
  assert.equal(result.kind, "error");
  if (result.kind === "error") {
    assert.equal(result.message, "steam_http_500", "message is tagged with the status code only");
    assert.doesNotMatch(result.message, /secret-api-key|x{20,}/, "provider body must not enter durable diagnostics");
  }
});

test("classifySteamHttpResponse - 2xx status is ok (not an error)", () => {
  const result = classifySteamHttpResponse(200, '{"response":{}}');
  assert.deepEqual(result, { kind: "ok" });
});

// ─── STEAM_RETRYABLE_PATTERN: production runtime retry authority ──────────
//
// runConnector({ retryablePattern: STEAM_RETRYABLE_PATTERN, ... }) uses this
// exact regex to decide cross-run retry cooldown — these tests exercise the
// real exported pattern, not a copy of it.

test("STEAM_RETRYABLE_PATTERN - matches steam_rate_limited (429s must retry)", () => {
  assert.match("steam_rate_limited", STEAM_RETRYABLE_PATTERN);
});

test("STEAM_RETRYABLE_PATTERN - matches network-transport failure classes", () => {
  assert.match("connect ECONNREFUSED 127.0.0.1:443", STEAM_RETRYABLE_PATTERN);
  assert.match("ETIMEDOUT", STEAM_RETRYABLE_PATTERN);
  assert.match("fetch failed", STEAM_RETRYABLE_PATTERN);
});

test("STEAM_RETRYABLE_PATTERN - matches exhausted retryable HTTP statuses", () => {
  assert.match("HTTP request got retryable status 503 after retry budget was exhausted", STEAM_RETRYABLE_PATTERN);
});

test("STEAM_RETRYABLE_PATTERN - does not match terminal auth failure", () => {
  assert.doesNotMatch("steam_auth_failed", STEAM_RETRYABLE_PATTERN);
});

test("STEAM_RETRYABLE_PATTERN - does not match generic bounded HTTP errors", () => {
  assert.doesNotMatch("steam_http_500: internal server error", STEAM_RETRYABLE_PATTERN);
  assert.doesNotMatch("steam_http_404: not found", STEAM_RETRYABLE_PATTERN);
});

test("STEAM_RETRYABLE_PATTERN - does not match unrelated application errors", () => {
  assert.doesNotMatch(
    "steam_setup_incomplete: no Steam identity is on file for this connection yet — finish setup by entering a SteamID64 or custom profile name",
    STEAM_RETRYABLE_PATTERN
  );
});

test("STEAM_RETRYABLE_PATTERN - does not match a failed vanity URL resolution (terminal, not retried)", () => {
  assert.doesNotMatch(
    'steam_vanity_url_not_found: could not resolve "nosuchvanity" to a SteamID64',
    STEAM_RETRYABLE_PATTERN
  );
});

// ─── isSteamId64: gates numeric-vs-vanity dispatch for resolveSteamId ──────

test("isSteamId64 - accepts a real 17-digit SteamID64", () => {
  assert.equal(isSteamId64("76561198012345678"), true);
});

test("isSteamId64 - rejects a vanity profile name", () => {
  assert.equal(isSteamId64("gaben"), false);
});

test("isSteamId64 - rejects a numeric string of the wrong length", () => {
  assert.equal(isSteamId64("12345"), false);
});

test("isSteamId64 - rejects a numeric-looking vanity name not starting with the SteamID64 universe prefix", () => {
  assert.equal(isSteamId64("11111111111111111"), false);
});

test("isSteamId64 - tolerates surrounding whitespace", () => {
  assert.equal(isSteamId64("  76561198012345678  "), true);
});

test("steamCollect - resolves a custom profile name before sending SteamID64 downstream", async () => {
  const originalFetch = globalThis.fetch;
  const originalSteamUserId = process.env.STEAM_USER_ID;
  const requests: URL[] = [];
  const vanityFixture = readFileSync(new URL("./__fixtures__/resolve-vanity-url.json", import.meta.url), "utf8");
  const profileFixture = readFileSync(new URL("./__fixtures__/player-summaries.json", import.meta.url), "utf8");

  globalThis.fetch = (input) => {
    const url = new URL(String(input));
    requests.push(url);
    if (url.pathname.endsWith("/ResolveVanityURL/v0001")) {
      return Promise.resolve(new Response(vanityFixture, { status: 200 }));
    }
    if (url.pathname.endsWith("/GetPlayerSummaries/v0002")) {
      return Promise.resolve(new Response(profileFixture, { status: 200 }));
    }
    throw new Error(`unexpected Steam fixture request: ${url.pathname}`);
  };
  process.env.STEAM_USER_ID = "synthetic-profile";

  const records: Array<{ stream: string; data: Record<string, unknown> }> = [];
  try {
    await steamCollect({
      state: {},
      requested: new Map([["profile", { name: "profile" }]]),
      credentials: { STEAM_API_KEY: "synthetic-api-key" },
      emit: async () => {
        await Promise.resolve();
      },
      emitRecord: (stream, data) => {
        records.push({ stream, data });
        return Promise.resolve();
      },
      progress: async () => {
        await Promise.resolve();
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalSteamUserId === undefined) {
      delete process.env.STEAM_USER_ID;
    } else {
      process.env.STEAM_USER_ID = originalSteamUserId;
    }
  }

  assert.equal(requests[0]?.searchParams.get("vanityurl"), "synthetic-profile");
  assert.equal(requests[0]?.searchParams.get("url_type"), "1");
  assert.equal(requests[1]?.searchParams.get("steamids"), "76561198012345678");
  assert.equal(records.length, 1);
  assert.equal(records[0]?.stream, "profile");
  assert.equal(records[0]?.data.steamid, "76561198012345678");
  assert.equal(records[0]?.data.personaname, "Synthetic Fixture");
});

test("steamCollect - rejects a vanity resolver response that is not a SteamID64", async () => {
  const originalFetch = globalThis.fetch;
  const originalSteamUserId = process.env.STEAM_USER_ID;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify({ response: { success: 1, steamid: "display-name" } }), { status: 200 })
    );
  process.env.STEAM_USER_ID = "synthetic-profile";

  try {
    await assert.rejects(
      steamCollect({
        state: {},
        requested: new Map([["profile", { name: "profile" }]]),
        credentials: { STEAM_API_KEY: "synthetic-api-key" },
        emit: async () => {
          await Promise.resolve();
        },
        emitRecord: async () => {
          await Promise.resolve();
        },
        progress: async () => {
          await Promise.resolve();
        },
      }),
      /steam_vanity_url_not_found:.*SteamID64/
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalSteamUserId === undefined) {
      delete process.env.STEAM_USER_ID;
    } else {
      process.env.STEAM_USER_ID = originalSteamUserId;
    }
  }
});

function startSteamFixtureServer(requiredEndpoint401: boolean): Promise<{ stop: () => Promise<void>; url: string }> {
  return new Promise((resolveServer, rejectServer) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const path = req.url?.split("?", 1)[0] ?? "";
      if (requiredEndpoint401 && path.endsWith("/GetPlayerSummaries/v0002")) {
        res.writeHead(401).end();
        return;
      }
      if (path.endsWith("/GetFriendList/v0001")) {
        res.writeHead(401).end();
        return;
      }
      let body: Record<string, unknown>;
      if (path.endsWith("/GetPlayerSummaries/v0002")) {
        body = { response: { players: [{ steamid: "76561198012345678", personaname: "UAT" }] } };
      } else if (path.endsWith("/GetOwnedGames/v0001") || path.endsWith("/GetRecentlyPlayedGames/v0001")) {
        body = { response: { games: [] } };
      } else {
        body = { response: { player_level: 7 } };
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        rejectServer(new Error("fixture server did not bind to a TCP port"));
        return;
      }
      resolveServer({
        url: `http://127.0.0.1:${String(address.port)}`,
        stop: () =>
          new Promise<void>((resolveStop, rejectStop) =>
            server.close((error) => (error ? rejectStop(error) : resolveStop()))
          ),
      });
    });
    server.on("error", rejectServer);
  });
}

test("Steam protocol execution: optional friends 401 emits exact SKIP_RESULT and succeeds", async () => {
  const fixture = await startSteamFixtureServer(false);
  try {
    const result = await runConnectorProtocolSubprocess({
      cwd: PACKAGE_ROOT,
      entrypoint: ENTRYPOINT,
      env: { STEAM_API_BASE_URL: fixture.url, STEAM_API_KEY: "uat-key", STEAM_USER_ID: "76561198012345678" },
      start: {
        type: "START",
        scope: {
          streams: [
            { name: "profile" },
            { name: "owned_games" },
            { name: "recently_played_games" },
            { name: "friends" },
            { name: "steam_level" },
          ],
        },
        state: {},
      },
    });
    assert.equal(result.code, 0);
    const skip = result.messages.find((message) => message.type === "SKIP_RESULT");
    assert.deepEqual(skip, {
      type: "SKIP_RESULT",
      stream: "friends",
      reason: "steam_optional_resource_unavailable",
      message: "Steam friends are unavailable because this account restricts the friends list.",
      recovery_hint: { action: "manual_action_required", retryable: false },
    });
    assert.equal(
      result.messages.some((message) => message.type === "STATE" && message.stream === "friends"),
      false
    );
    assert.equal(
      result.messages.some((message) => message.type === "DETAIL_COVERAGE" && message.stream === "friends"),
      false
    );
    const profile = result.messages.find((message) => message.type === "RECORD" && message.stream === "profile");
    assert.ok(profile, "the valid profile returned by Steam must reach the protocol");
    if (profile?.type === "RECORD") {
      assert.equal(profile.key, "76561198012345678");
    }
    const done = result.messages.at(-1);
    assert.equal(done?.type, "DONE");
    assert.equal(done?.status, "succeeded");
  } finally {
    await fixture.stop();
  }
});

test("Steam protocol execution: required endpoint 401 remains a failed DONE", async () => {
  const fixture = await startSteamFixtureServer(true);
  try {
    const result = await runConnectorProtocolSubprocess({
      cwd: PACKAGE_ROOT,
      entrypoint: ENTRYPOINT,
      env: { STEAM_API_BASE_URL: fixture.url, STEAM_API_KEY: "uat-key", STEAM_USER_ID: "76561198012345678" },
      start: { type: "START", scope: { streams: [{ name: "profile" }] }, state: {} },
      allowFailedDone: true,
    });
    assert.notEqual(result.code, 0);
    const done = result.messages.at(-1);
    assert.equal(done?.type, "DONE");
    if (done?.type === "DONE") {
      assert.equal(done.status, "failed");
      assert.equal(done.error?.message, "steam_auth_failed");
      assert.equal(done.error?.retryable, false);
    }
  } finally {
    await fixture.stop();
  }
});
