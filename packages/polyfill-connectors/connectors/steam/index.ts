#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP Steam Connector (v0.1.0)
 *
 * Polyfills Steam Web API into the PDPP Collection Profile. Reads
 * STEAM_USER_ID and STEAM_API_KEY from credentials. Emits RECORD/STATE/DONE
 * messages over stdout; reads START from stdin.
 *
 * Streams:
 *   profile, owned_games, recently_played_games, friends, steam_level
 *
 * State shape:
 *   {
 *     profile:                { fetched_at?: string },
 *     owned_games:            { fetched_at?: string, fingerprints?: {} },
 *     recently_played_games:  { fetched_at?: string, fingerprints?: {} },
 *     friends:                { fetched_at?: string, fingerprints?: {} },
 *     steam_level:            { fetched_at?: string },
 *   }
 *
 * Rate limit: Steam publishes no official numeric limits. PDPP policy: use
 * 250ms per-request floor with adaptive backoff on 429/403. Manifest declares
 * 1-hour polling interval as infrastructure policy (separate from API pacing).
 */

import { createConnectorHttpGovernor } from "../../src/connector-http-governor.ts";
import {
  type EmittedMessage,
  emitDetailCoverage,
  nowIso,
  type ProgressExtra,
  type RecordData,
  runConnector,
} from "../../src/connector-runtime.ts";
import { openFingerprintCursor } from "../../src/fingerprint-cursor.ts";
import { isMainModule } from "../../src/is-main-module.ts";
import { steamPacingProfile } from "../../src/provider-profile.ts";
import { validateRecord } from "./schemas.ts";

const API_BASE = "https://api.steampowered.com";

// Conservative pacing profile: Steam doesn't publish rate limits officially.
// 60s+ interval is a community-observed safe pace to avoid multi-hour lockouts.
const httpGovernor = createConnectorHttpGovernor({
  name: "steam",
  maxAttempts: 1,
  profile: steamPacingProfile(),
});

// ─── API response types ────────────────────────────────────────────────────

interface SteamPlayerSummary {
  avatar?: string;
  avatarfull?: string;
  avatarmedium?: string;
  commentcount?: number;
  communityvisibilitystate?: number;
  lastlogoff?: number;
  loccityid?: string;
  loccountrycode?: string;
  loccstatecode?: string;
  personaname?: string;
  personastate?: number;
  personastateflags?: number;
  primaryclanid?: string;
  profilestate?: number;
  profilestate_error?: string;
  profileurl?: string;
  realname?: string;
  steamid: string;
  timecreated?: number;
}

interface SteamOwnedGame {
  appid: number;
  content_descriptorids?: number[];
  has_community_visible_stats?: boolean;
  img_icon_url?: string;
  img_logo_url?: string;
  name: string;
  playtime_forever: number;
  playtime_linux?: number;
  playtime_mac?: number;
  playtime_windows?: number;
  rtime_last_played?: number;
}

interface SteamRecentlyPlayed {
  appid: number;
  img_icon_url?: string;
  img_logo_url?: string;
  name: string;
  playtime_2weeks?: number;
  playtime_forever: number;
  playtime_linux?: number;
  playtime_mac?: number;
  playtime_windows?: number;
  rtime_last_played?: number;
}

interface SteamFriend {
  friend_since: number;
  relationship: string;
  steamid: string;
}

interface GetPlayerSummariesResponse {
  response: { players: SteamPlayerSummary[] };
}

interface GetOwnedGamesResponse {
  response: { games?: SteamOwnedGame[]; game_count?: number };
}

interface GetRecentlyPlayedResponse {
  response: { games?: SteamRecentlyPlayed[]; total_count?: number };
}

interface GetFriendListResponse {
  friendslist: { friends: SteamFriend[] };
}

interface GetSteamLevelResponse {
  response: { player_level?: number };
}

interface ResolveVanityUrlResponse {
  response: { message?: string; steamid?: string; success: number };
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────

type ProgressFn = (
  message: string,
  extra?: {
    count?: number;
    cursor_present?: boolean;
    item_count?: number;
    phase?: string;
    stream?: string;
    total?: number;
  }
) => Promise<void>;

/**
 * Runtime pattern that gates cross-run retry cooldown in `retryablePattern`
 * (see runConnector below). steam_rate_limited must stay listed here or 429s
 * become terminal instead of retried.
 */
export const STEAM_RETRYABLE_PATTERN = /ECONN|ETIMEDOUT|fetch failed|steam_rate_limited/i;

export type SteamHttpClassification = { kind: "ok" } | { kind: "error"; message: string };

/**
 * Pure status/body classifier used by steamApiRequest. Kept separate (and
 * exported) so tests exercise the exact production decision instead of a
 * re-implementation that can silently drift from it.
 */
export function classifySteamHttpResponse(status: number, body: string): SteamHttpClassification {
  if (status === 401 || status === 403) {
    return { kind: "error", message: "steam_auth_failed" };
  }
  if (status === 429) {
    return { kind: "error", message: "steam_rate_limited" };
  }
  if (status < 200 || status >= 300) {
    return { kind: "error", message: `steam_http_${String(status)}: ${body.slice(0, 200)}` };
  }
  return { kind: "ok" };
}

async function steamApiRequest<T>(
  path: string,
  apiKey: string,
  params: Record<string, string | number | boolean> = {},
  progress?: ProgressFn,
  extra?: Parameters<ProgressFn>[1]
): Promise<T> {
  const url = new URL(`${API_BASE}${path}`);
  url.searchParams.set("key", apiKey);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }

  try {
    const r = await httpGovernor.request<{ body: string; status: number }, { body: string; status: number }>(
      async () => {
        const res = await fetch(url, { headers: { Accept: "application/json" } });
        return {
          body: await res.text().catch((): string => ""),
          status: res.status,
        } as { body: string; status: number };
      },
      (raw) => ({ status: raw.status, value: raw })
    );
    const result = r.value;

    const classification = classifySteamHttpResponse(result.status, result.body);
    if (classification.kind === "error") {
      throw new Error(classification.message);
    }
    return JSON.parse(result.body) as T;
  } catch (error) {
    if (error instanceof Error && error.message === "steam_auth_failed") {
      await progress?.("Steam API key invalid or unauthorized", extra);
    }
    throw error;
  }
}

// A 64-bit SteamID is always a 17-digit number starting with 7656119. Anything
// else (a vanity name from steamcommunity.com/id/<name>) needs ResolveVanityURL.
const STEAM_ID64_PATTERN = /^7656119\d{10}$/;

export function isSteamId64(value: string): boolean {
  return STEAM_ID64_PATTERN.test(value.trim());
}

/**
 * Accepts either a numeric SteamID64 (returned as-is) or a vanity profile
 * name from steamcommunity.com/id/<name> (resolved via ResolveVanityURL).
 * Owners without a custom vanity URL never see /id/<name> in their profile
 * link, so this removes the need to explain the difference in setup copy.
 */
async function resolveSteamId(apiKey: string, rawSteamId: string): Promise<string> {
  const trimmed = rawSteamId.trim();
  if (isSteamId64(trimmed)) {
    return trimmed;
  }
  const res = await steamApiRequest<ResolveVanityUrlResponse>("/ISteamUser/ResolveVanityURL/v0001", apiKey, {
    vanityurl: trimmed,
  });
  if (res.response.success === 1 && res.response.steamid) {
    return res.response.steamid;
  }
  throw new Error(`steam_vanity_url_not_found: could not resolve "${trimmed}" to a SteamID`);
}

// ─── Record builders ───────────────────────────────────────────────────────

function profileRecord(summary: SteamPlayerSummary): RecordData {
  return {
    steamid: summary.steamid,
    personaname: summary.personaname ?? null,
    profileurl: summary.profileurl ?? null,
    avatar: summary.avatar ?? null,
    avatarmedium: summary.avatarmedium ?? null,
    avatarfull: summary.avatarfull ?? null,
    personastate: summary.personastate ?? null,
    communityvisibilitystate: summary.communityvisibilitystate ?? null,
    profilestate: summary.profilestate ?? null,
    realname: summary.realname ?? null,
    primaryclanid: summary.primaryclanid ?? null,
    timecreated: summary.timecreated ?? null,
    loccountrycode: summary.loccountrycode ?? null,
    loccstatecode: summary.loccstatecode ?? null,
    loccityid: summary.loccityid ?? null,
    lastlogoff: summary.lastlogoff ?? null,
    commentcount: summary.commentcount ?? null,
  };
}

function ownedGameRecord(game: SteamOwnedGame, steamid: string): RecordData {
  return {
    id: `${steamid}:${game.appid}`,
    steamid,
    appid: game.appid,
    name: game.name,
    playtime_forever: game.playtime_forever,
    playtime_windows: game.playtime_windows ?? null,
    playtime_mac: game.playtime_mac ?? null,
    playtime_linux: game.playtime_linux ?? null,
    img_icon_url: game.img_icon_url ?? null,
    img_logo_url: game.img_logo_url ?? null,
    has_community_visible_stats: game.has_community_visible_stats ?? null,
    rtime_last_played: game.rtime_last_played ?? null,
    content_descriptorids: game.content_descriptorids ?? null,
  };
}

function recentlyPlayedRecord(game: SteamRecentlyPlayed, steamid: string): RecordData {
  return {
    id: `${steamid}:${game.appid}`,
    steamid,
    appid: game.appid,
    name: game.name,
    playtime_2weeks: game.playtime_2weeks ?? null,
    playtime_forever: game.playtime_forever,
    playtime_windows: game.playtime_windows ?? null,
    playtime_mac: game.playtime_mac ?? null,
    playtime_linux: game.playtime_linux ?? null,
    img_icon_url: game.img_icon_url ?? null,
    img_logo_url: game.img_logo_url ?? null,
    rtime_last_played: game.rtime_last_played ?? null,
  };
}

function friendRecord(friend: SteamFriend, steamid: string): RecordData {
  return {
    id: `${steamid}:${friend.steamid}`,
    steamid: friend.steamid,
    owner_steamid: steamid,
    relationship: friend.relationship,
    friend_since: friend.friend_since,
  };
}

function steamLevelRecord(steamid: string, level: number): RecordData {
  return {
    id: steamid,
    steamid,
    player_level: level,
  };
}

// ─── Per-stream collectors ─────────────────────────────────────────────────
// Each fetches one Steam endpoint, emits its records, and writes the new
// per-stream state. Split out of collect() so each stream's control flow
// (and cognitive complexity) stays local to itself.

interface StreamDeps {
  emit: (msg: EmittedMessage) => Promise<void>;
  emitRecord: (stream: string, data: RecordData) => Promise<void>;
  progress: (message: string, extra?: ProgressExtra) => Promise<void>;
}

async function collectProfile(
  deps: StreamDeps,
  apiKey: string,
  steamid: string,
  newState: Record<string, unknown>
): Promise<void> {
  const profileRes = await steamApiRequest<GetPlayerSummariesResponse>(
    "/ISteamUser/GetPlayerSummaries/v0002",
    apiKey,
    { steamids: steamid },
    deps.progress,
    { stream: "profile" }
  );
  await deps.progress("Fetched Steam profile", { stream: "profile" });
  const [player] = profileRes.response.players;
  if (player) {
    await deps.emitRecord("profile", profileRecord(player));
  }
  newState.profile = { fetched_at: nowIso() };
  await deps.emit({ type: "STATE", stream: "profile", cursor: newState.profile });
}

async function collectOwnedGames(
  deps: StreamDeps,
  apiKey: string,
  steamid: string,
  newState: Record<string, unknown>
): Promise<void> {
  await deps.progress("Fetching owned games", { stream: "owned_games" });
  const gamesRes = await steamApiRequest<GetOwnedGamesResponse>(
    "/IPlayerService/GetOwnedGames/v0001",
    apiKey,
    { steamid, include_appinfo: true, include_played_free_games: true, skip_unvetted_apps: false },
    deps.progress,
    { stream: "owned_games" }
  );
  const games = gamesRes.response.games ?? [];
  await deps.progress("Fetched owned games", { stream: "owned_games", count: games.length });

  const gamesCursor = openFingerprintCursor((newState.owned_games as unknown) ?? {});
  let emittedCount = 0;
  for (const game of games) {
    const record = ownedGameRecord(game, steamid);
    if (gamesCursor.shouldEmit(record)) {
      await deps.emitRecord("owned_games", record);
      emittedCount += 1;
    }
  }
  gamesCursor.pruneStale();
  newState.owned_games = { fetched_at: nowIso(), fingerprints: gamesCursor.toState() };
  await deps.emit({ type: "STATE", stream: "owned_games", cursor: newState.owned_games });

  await emitDetailCoverage(
    { emit: deps.emit },
    {
      stream: "owned_games",
      stateStream: "owned_games",
      requiredKeys: [],
      hydratedKeys: [],
      considered: games.length,
      covered: emittedCount,
    }
  );
}

async function collectRecentlyPlayed(
  deps: StreamDeps,
  apiKey: string,
  steamid: string,
  newState: Record<string, unknown>
): Promise<void> {
  await deps.progress("Fetching recently played games", { stream: "recently_played_games" });
  const recentRes = await steamApiRequest<GetRecentlyPlayedResponse>(
    "/IPlayerService/GetRecentlyPlayedGames/v0001",
    apiKey,
    { steamid },
    deps.progress,
    { stream: "recently_played_games" }
  );
  const recentGames = recentRes.response.games ?? [];
  await deps.progress("Fetched recently played games", {
    stream: "recently_played_games",
    count: recentGames.length,
  });

  const recentCursor = openFingerprintCursor((newState.recently_played_games as unknown) ?? {});
  let emittedCount = 0;
  for (const game of recentGames) {
    const record = recentlyPlayedRecord(game, steamid);
    if (recentCursor.shouldEmit(record)) {
      await deps.emitRecord("recently_played_games", record);
      emittedCount += 1;
    }
  }
  recentCursor.pruneStale();
  newState.recently_played_games = { fetched_at: nowIso(), fingerprints: recentCursor.toState() };
  await deps.emit({ type: "STATE", stream: "recently_played_games", cursor: newState.recently_played_games });

  await emitDetailCoverage(
    { emit: deps.emit },
    {
      stream: "recently_played_games",
      stateStream: "recently_played_games",
      requiredKeys: [],
      hydratedKeys: [],
      considered: recentGames.length,
      covered: emittedCount,
    }
  );
}

async function collectFriends(
  deps: StreamDeps,
  apiKey: string,
  steamid: string,
  newState: Record<string, unknown>
): Promise<void> {
  await deps.progress("Fetching friends list", { stream: "friends" });
  const friendsRes = await steamApiRequest<GetFriendListResponse>(
    "/ISteamUser/GetFriendList/v0001",
    apiKey,
    { steamid, relationship: "friend" },
    deps.progress,
    { stream: "friends" }
  );
  const friends = friendsRes.friendslist.friends ?? [];
  await deps.progress("Fetched friends list", { stream: "friends", count: friends.length });

  const friendsCursor = openFingerprintCursor((newState.friends as unknown) ?? {});
  let emittedCount = 0;
  for (const friend of friends) {
    const record = friendRecord(friend, steamid);
    if (friendsCursor.shouldEmit(record)) {
      await deps.emitRecord("friends", record);
      emittedCount += 1;
    }
  }
  friendsCursor.pruneStale();
  newState.friends = { fetched_at: nowIso(), fingerprints: friendsCursor.toState() };
  await deps.emit({ type: "STATE", stream: "friends", cursor: newState.friends });

  await emitDetailCoverage(
    { emit: deps.emit },
    {
      stream: "friends",
      stateStream: "friends",
      requiredKeys: [],
      hydratedKeys: [],
      considered: friends.length,
      covered: emittedCount,
    }
  );
}

async function collectSteamLevel(
  deps: StreamDeps,
  apiKey: string,
  steamid: string,
  newState: Record<string, unknown>
): Promise<void> {
  await deps.progress("Fetching Steam level", { stream: "steam_level" });
  const levelRes = await steamApiRequest<GetSteamLevelResponse>(
    "/IPlayerService/GetSteamLevel/v0001",
    apiKey,
    { steamid },
    deps.progress,
    { stream: "steam_level" }
  );
  await deps.progress("Fetched Steam level", { stream: "steam_level" });
  const level = levelRes.response.player_level ?? 0;
  await deps.emitRecord("steam_level", steamLevelRecord(steamid, level));
  newState.steam_level = { fetched_at: nowIso() };
  await deps.emit({ type: "STATE", stream: "steam_level", cursor: newState.steam_level });
}

// STEAM_USER_ID is a non-secret setup field (the owner's SteamID64 or vanity
// URL), injected into the spawn env from the connection's
// source_binding_json, not the credential store. It is deliberately absent
// from this connector's `auth.required` (adding it there would route a
// missing value through the blocking INTERACTION credentials prompt, which
// is the wrong UX for a non-secret setup field and would hang a draft run
// for up to 30 minutes) — so it never reaches `credentials` and must be read
// directly from process.env, matching the jellyfin/gmail pattern for their
// own setup fields. See add-static-secret-owner-session-connect-path
// Decision 5.
export function resolveRawSteamIdFromCredentials(
  credentials: Record<string, string | undefined>,
  env: NodeJS.ProcessEnv
): string | undefined {
  return credentials.STEAM_USER_ID || env.STEAM_USER_ID;
}

if (isMainModule(import.meta.url)) {
  runConnector({
    name: "steam",
    retryablePattern: STEAM_RETRYABLE_PATTERN,
    auth: { kind: "env", required: [["STEAM_API_KEY"]] },
    validateRecord,
    async collect({ state, requested, credentials, emit, emitRecord, progress }) {
      const apiKey = credentials.STEAM_API_KEY;
      if (!apiKey) {
        throw new Error("steam_auth_failed");
      }

      const rawSteamId = resolveRawSteamIdFromCredentials(credentials, process.env);
      if (!rawSteamId) {
        // Genuinely missing: no SteamID was ever captured for this
        // connection. Name the real state — the API key is fine, and
        // nothing here was "re-entered" and lost; setup simply never
        // finished.
        throw new Error(
          "steam_setup_incomplete: no SteamID is on file for this connection yet — finish setup by entering the SteamID to continue"
        );
      }
      const steamid = await resolveSteamId(apiKey, rawSteamId);

      const newState: Record<string, unknown> = JSON.parse(JSON.stringify(state));
      const deps: StreamDeps = { emit, emitRecord, progress };

      await progress("Fetching Steam profile", { stream: "profile" });

      if (requested.has("profile")) {
        await collectProfile(deps, apiKey, steamid, newState);
      }
      if (requested.has("owned_games")) {
        await collectOwnedGames(deps, apiKey, steamid, newState);
      }
      if (requested.has("recently_played_games")) {
        await collectRecentlyPlayed(deps, apiKey, steamid, newState);
      }
      if (requested.has("friends")) {
        await collectFriends(deps, apiKey, steamid, newState);
      }
      if (requested.has("steam_level")) {
        await collectSteamLevel(deps, apiKey, steamid, newState);
      }
    },
  });
}
