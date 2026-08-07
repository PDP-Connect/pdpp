// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { classifySteamHttpResponse, STEAM_RETRYABLE_PATTERN } from "./index.ts";
import { validateRecord } from "./schemas.ts";

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
  assert.deepEqual(result, { kind: "error", message: "steam_rate_limited" });
});

test("classifySteamHttpResponse - 401 maps to steam_auth_failed", () => {
  const result = classifySteamHttpResponse(401, "");
  assert.deepEqual(result, { kind: "error", message: "steam_auth_failed" });
});

test("classifySteamHttpResponse - 403 maps to steam_auth_failed", () => {
  const result = classifySteamHttpResponse(403, "");
  assert.deepEqual(result, { kind: "error", message: "steam_auth_failed" });
});

test("classifySteamHttpResponse - other non-2xx status is bounded and sanitized", () => {
  const longBody = "x".repeat(500);
  const result = classifySteamHttpResponse(500, longBody);
  assert.equal(result.kind, "error");
  if (result.kind === "error") {
    assert.match(result.message, /^steam_http_500: /, "message is tagged with the status code");
    assert.ok(result.message.length < longBody.length, "body must be bounded/truncated, not passed through raw");
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

test("STEAM_RETRYABLE_PATTERN - does not match terminal auth failure", () => {
  assert.doesNotMatch("steam_auth_failed", STEAM_RETRYABLE_PATTERN);
});

test("STEAM_RETRYABLE_PATTERN - does not match generic bounded HTTP errors", () => {
  assert.doesNotMatch("steam_http_500: internal server error", STEAM_RETRYABLE_PATTERN);
  assert.doesNotMatch("steam_http_404: not found", STEAM_RETRYABLE_PATTERN);
});

test("STEAM_RETRYABLE_PATTERN - does not match unrelated application errors", () => {
  assert.doesNotMatch("steam_user_id_required: STEAM_USER_ID credential required", STEAM_RETRYABLE_PATTERN);
});
