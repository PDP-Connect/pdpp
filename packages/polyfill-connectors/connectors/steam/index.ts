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
 * 250ms per-request floor with adaptive backoff on provider throttles. A 403
 * is classified as an authorization/visibility failure, not silently retried.
 * Manifest declares 1-hour polling interval as infrastructure policy (separate
 * from API pacing).
 */

import { isMainModule } from "@pdpp/connector-protocol";
import { createConnectorHttpGovernor } from "../../src/connector-http-governor.ts";
import {
  type CollectContext,
  type EmittedMessage,
  emitDetailCoverage,
  nowIso,
  type ProgressExtra,
  type RecordData,
  runConnector,
} from "../../src/connector-runtime.ts";
import { openFingerprintCursor } from "../../src/fingerprint-cursor.ts";
import { steamPacingProfile } from "../../src/provider-profile.ts";
import { validateRecord } from "./schemas.ts";

const API_BASE = process.env.STEAM_API_BASE_URL ?? "https://api.steampowered.com";

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

function requireSteamObject(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`steam_response_malformed: ${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireSteamArray<T>(value: unknown, field: string): T[] {
  if (!Array.isArray(value)) {
    throw new Error(`steam_response_malformed: ${field} must be an array`);
  }
  return value as T[];
}

function requireSteamResponse(value: unknown): Record<string, unknown> {
  const envelope = requireSteamObject(value, "wire envelope");
  return requireSteamObject(envelope.response, "response");
}

/**
 * Bind a Steam-declared inventory total to the coverage denominator.
 *
 * `GetOwnedGames` reports `game_count` and `GetRecentlyPlayedGames` reports
 * `total_count` alongside the array they serve. Both calls are unpaginated, so
 * without this check the denominator would be the length of whatever array
 * arrived — a silently truncated response would read as fully covered. Using
 * the source's own count makes a short array a visible coverage shortfall
 * instead of an invisible one (the same posture Jellyfin takes with
 * `TotalRecordCount`).
 *
 * Absent is tolerated: the field is optional in the wire contract and a missing
 * total simply falls back to the served length. A malformed or impossible total
 * fails closed, because a nonsense denominator is worse than no denominator.
 */
function steamDeclaredTotal(value: unknown, field: string, servedLength: number): number {
  if (value === undefined || value === null) {
    return servedLength;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`steam_response_malformed: ${field} must be a nonnegative integer`);
  }
  if (value < servedLength) {
    throw new Error(
      `steam_response_malformed: ${field} (${value}) is less than the served item count (${servedLength})`
    );
  }
  return value;
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
export const STEAM_RETRYABLE_PATTERN = /ECONN|ETIMEDOUT|fetch failed|steam_rate_limited|retryable status \d+/i;

export type SteamHttpClassification = { kind: "ok" } | { kind: "error"; message: string; status: number };

export class SteamHttpError extends Error {
  readonly status: number;
  readonly path: string;

  constructor(path: string, status: number, message: string) {
    super(message);
    this.name = "SteamHttpError";
    this.path = path;
    this.status = status;
  }
}

/**
 * Pure status/body classifier used by steamApiRequest. Kept separate (and
 * exported) so tests exercise the exact production decision instead of a
 * re-implementation that can silently drift from it.
 */
export function classifySteamHttpResponse(status: number, _body: string): SteamHttpClassification {
  if (status === 401) {
    return { kind: "error", message: "steam_auth_failed", status };
  }
  if (status === 403) {
    return { kind: "error", message: "steam_forbidden_auth_or_visibility", status };
  }
  if (status === 429) {
    return { kind: "error", message: "steam_rate_limited", status };
  }
  if (status < 200 || status >= 300) {
    return { kind: "error", message: `steam_http_${String(status)}`, status };
  }
  return { kind: "ok" };
}

interface SteamRawResponse {
  body: string;
  headers?: Record<string, string | undefined>;
  status: number;
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
    const r = await httpGovernor.request<SteamRawResponse, SteamRawResponse>(
      async () => {
        const res = await fetch(url, { headers: { Accept: "application/json" } });
        const retryAfter = res.headers.get("retry-after");
        return {
          body: await res.text().catch((): string => ""),
          ...(retryAfter === null ? {} : { headers: { "retry-after": retryAfter } }),
          status: res.status,
        };
      },
      (raw) => ({
        status: raw.status,
        ...(raw.headers === undefined ? {} : { headers: raw.headers }),
        value: raw,
      })
    );
    const result = r.value;

    const classification = classifySteamHttpResponse(result.status, result.body);
    if (classification.kind === "error") {
      throw new SteamHttpError(path, classification.status, classification.message);
    }
    return JSON.parse(result.body) as T;
  } catch (error) {
    if (error instanceof SteamHttpError && error.message === "steam_auth_failed") {
      await progress?.("Steam API authentication failed", extra);
    } else if (error instanceof SteamHttpError && error.message === "steam_forbidden_auth_or_visibility") {
      await progress?.("Steam API request forbidden; authentication or profile visibility may be involved", extra);
    }
    throw error;
  }
}

// A 64-bit SteamID is always a 17-digit number starting with 7656119. Anything
// else (a vanity name from steamcommunity.com/id/<name>) needs ResolveVanityURL.
const STEAM_ID64_PATTERN = /^7656119\d{10}$/;
const STEAM_PROFILE_ID_URL_PATTERN = /^https?:\/\/steamcommunity\.com\/profiles\/(7656119\d{10})\/?$/i;
const STEAM_VANITY_URL_PATTERN = /^https?:\/\/steamcommunity\.com\/id\/([^/?#]+)\/?$/i;
const STEAM_HTTP_URL_PATTERN = /^https?:\/\//i;

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
  if (!trimmed) {
    throw new Error("steam_setup_invalid: enter a SteamID64 or custom Steam profile name");
  }
  const profileIdUrl = STEAM_PROFILE_ID_URL_PATTERN.exec(trimmed);
  if (profileIdUrl?.[1]) {
    return profileIdUrl[1];
  }
  if (isSteamId64(trimmed)) {
    return trimmed;
  }
  const vanityUrl = STEAM_VANITY_URL_PATTERN.exec(trimmed)?.[1] ?? trimmed;
  if (STEAM_HTTP_URL_PATTERN.test(trimmed) && vanityUrl === trimmed) {
    throw new Error("steam_setup_invalid: use a SteamID64 or a steamcommunity.com/id/<name> profile URL");
  }
  const res = await steamApiRequest<ResolveVanityUrlResponse>("/ISteamUser/ResolveVanityURL/v0001", apiKey, {
    url_type: 1,
    vanityurl: vanityUrl,
  });
  const response = requireSteamResponse(res);
  if (response.success === 1 && typeof response.steamid === "string" && isSteamId64(response.steamid)) {
    return response.steamid;
  }
  throw new Error(`steam_vanity_url_not_found: could not resolve "${vanityUrl}" to a SteamID64`);
}

// ─── Record builders ───────────────────────────────────────────────────────

function profileRecord(summary: SteamPlayerSummary): RecordData {
  return {
    id: summary.steamid,
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

function steamLevelRecord(steamid: string, level: unknown): RecordData {
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

export interface SteamSnapshotCoverage {
  considered: number;
  covered: number;
  emitted: number;
}

/**
 * Account for every record in a full Steam snapshot independently of the
 * fingerprint cursor's changed-record emission decision. An unchanged record
 * is still covered because the source returned it and the cursor confirmed
 * that its prior state is identical. Invalid records remain a real coverage
 * shortfall instead of being counted from the raw API length.
 */
export async function emitSteamSnapshotRecords(
  stream: string,
  records: readonly RecordData[],
  cursor: ReturnType<typeof openFingerprintCursor>,
  emitRecord: (stream: string, data: RecordData) => Promise<void>
): Promise<SteamSnapshotCoverage> {
  let covered = 0;
  let emitted = 0;
  for (const record of records) {
    if (!validateRecord(stream, record).ok) {
      continue;
    }
    covered += 1;
    if (cursor.shouldEmit(record)) {
      await emitRecord(stream, record);
      emitted += 1;
    }
  }
  return { considered: records.length, covered, emitted };
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
  const response = requireSteamResponse(profileRes);
  const players = requireSteamArray<SteamPlayerSummary>(response.players, "response.players");
  const [player] = players;
  if (player) {
    const record = profileRecord(player);
    const covered = validateRecord("profile", record).ok ? 1 : 0;
    await deps.emitRecord("profile", record);
    await emitDetailCoverage(
      { emit: deps.emit },
      {
        stream: "profile",
        stateStream: "profile",
        requiredKeys: [],
        hydratedKeys: [],
        considered: 1,
        covered,
      }
    );
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
  const response = requireSteamResponse(gamesRes);
  const games = requireSteamArray<SteamOwnedGame>(response.games, "response.games");
  // Steam's own inventory size for this account. Load-bearing as the coverage
  // denominator below so a truncated `games` array cannot read as complete.
  const declaredTotal = steamDeclaredTotal(response.game_count, "response.game_count", games.length);
  await deps.progress("Fetched owned games", { stream: "owned_games", count: games.length });

  const gamesCursor = openFingerprintCursor((newState.owned_games as unknown) ?? {});
  const coverage = await emitSteamSnapshotRecords(
    "owned_games",
    games.map((game) => ownedGameRecord(game, steamid)),
    gamesCursor,
    deps.emitRecord
  );
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
      // Source-declared total, not the served array length: if Steam says it
      // owns N games and served fewer, this reads partial rather than complete.
      considered: declaredTotal,
      covered: coverage.covered,
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
  const response = requireSteamResponse(recentRes);
  // GetRecentlyPlayedGames omits `games` entirely when the account has played
  // nothing in the trailing two-week window -- the documented shape is
  // `{"response":{"total_count":0}}`. That is a well-formed empty answer, not a
  // malformed one, so requiring an array here failed the whole run for an
  // account that simply had not played recently (observed 2026-08-17:
  // `steam_response_malformed: response.games must be an array`). Absent is
  // empty; a present non-array is still a real protocol violation and still
  // throws.
  const recentGames =
    response.games === undefined ? [] : requireSteamArray<SteamRecentlyPlayed>(response.games, "response.games");
  // Steam reports `total_count` even for the empty case, so it is the honest
  // denominator for this window's inventory.
  const declaredTotal = steamDeclaredTotal(response.total_count, "response.total_count", recentGames.length);
  await deps.progress("Fetched recently played games", {
    stream: "recently_played_games",
    count: recentGames.length,
  });

  const recentCursor = openFingerprintCursor((newState.recently_played_games as unknown) ?? {});
  const coverage = await emitSteamSnapshotRecords(
    "recently_played_games",
    recentGames.map((game) => recentlyPlayedRecord(game, steamid)),
    recentCursor,
    deps.emitRecord
  );
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
      // Source-declared total, not the served array length.
      considered: declaredTotal,
      covered: coverage.covered,
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
  let friendsRes: GetFriendListResponse;
  try {
    friendsRes = await steamApiRequest<GetFriendListResponse>(
      "/ISteamUser/GetFriendList/v0001",
      apiKey,
      { steamid, relationship: "friend" },
      deps.progress,
      { stream: "friends" }
    );
  } catch (error) {
    if (error instanceof SteamHttpError && error.status === 401) {
      await deps.emit({
        type: "SKIP_RESULT",
        stream: "friends",
        reason: "steam_optional_resource_unavailable",
        message: "Steam friends are unavailable because this account restricts the friends list.",
        recovery_hint: { action: "manual_action_required", retryable: false },
      });
      return;
    }
    throw error;
  }
  const envelope = requireSteamObject(friendsRes, "wire envelope");
  const friendsList = requireSteamObject(envelope.friendslist, "friendslist");
  const friends = requireSteamArray<SteamFriend>(friendsList.friends, "friendslist.friends");
  await deps.progress("Fetched friends list", { stream: "friends", count: friends.length });

  const friendsCursor = openFingerprintCursor((newState.friends as unknown) ?? {});
  const coverage = await emitSteamSnapshotRecords(
    "friends",
    friends.map((friend) => friendRecord(friend, steamid)),
    friendsCursor,
    deps.emitRecord
  );
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
      considered: coverage.considered,
      covered: coverage.covered,
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
  const response = requireSteamResponse(levelRes);
  const level = response.player_level ?? null;
  const record = steamLevelRecord(steamid, level);
  const recordValid = validateRecord("steam_level", record).ok;
  await deps.emitRecord("steam_level", record);
  if (!recordValid) {
    await emitDetailCoverage(
      { emit: deps.emit },
      {
        stream: "steam_level",
        stateStream: "steam_level",
        requiredKeys: [],
        hydratedKeys: [],
        considered: 1,
        covered: 0,
      }
    );
    return;
  }
  newState.steam_level = { fetched_at: nowIso() };
  await deps.emit({ type: "STATE", stream: "steam_level", cursor: newState.steam_level });
  await emitDetailCoverage(
    { emit: deps.emit },
    {
      stream: "steam_level",
      stateStream: "steam_level",
      requiredKeys: [],
      hydratedKeys: [],
      considered: 1,
      covered: 1,
    }
  );
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

export async function steamCollect({
  state,
  requested,
  credentials,
  emit,
  emitRecord,
  progress,
}: Pick<CollectContext, "state" | "requested" | "credentials" | "emit" | "emitRecord" | "progress">): Promise<void> {
  const apiKey = credentials.STEAM_API_KEY;
  if (!apiKey) {
    throw new Error("steam_auth_failed");
  }

  const rawSteamId = resolveRawSteamIdFromCredentials(credentials, process.env)?.trim();
  if (!rawSteamId) {
    // Genuinely missing: no SteamID was ever captured for this connection. Name
    // the real state — the API key is fine, and setup simply never finished.
    throw new Error(
      "steam_setup_incomplete: no Steam identity is on file for this connection yet — finish setup by entering a SteamID64 or custom profile name"
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
}

if (isMainModule(import.meta.url)) {
  runConnector({
    name: "steam",
    retryablePattern: STEAM_RETRYABLE_PATTERN,
    auth: { kind: "env", required: [["STEAM_API_KEY"]] },
    validateRecord,
    collect: steamCollect,
  });
}
