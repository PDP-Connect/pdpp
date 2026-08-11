#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP Spotify Connector (v0.1.0)
 *
 * Auth: Spotify Web API OAuth token (user-provided). v1 expects a pre-issued
 *   token via SPOTIFY_ACCESS_TOKEN env var. Full OAuth loop deferred.
 * Scopes needed: user-library-read, user-top-read, user-read-recently-played,
 *   playlist-read-private, playlist-read-collaborative.
 *
 * Endpoints used:
 *   GET /v1/me/playlists?limit=50&offset=N
 *   GET /v1/me/tracks?limit=50&offset=N
 *   GET /v1/me/top/artists?time_range=short_term|medium_term|long_term&limit=50
 *   GET /v1/me/player/recently-played?limit=50&after=<unix_ms>
 *
 * Rate limit: Spotify does not publish a fixed numeric limit. The Web API uses
 * a rolling window and returns Retry-After on 429 responses; the connector
 * honors that header and uses a conservative provider-local pacing profile.
 */

import { createConnectorHttpGovernor } from "../../src/connector-http-governor.ts";
import {
  type CollectContext,
  type EmittedMessage,
  emitDetailCoverage,
  runConnector,
} from "../../src/connector-runtime.ts";
import { isMainModule } from "../../src/is-main-module.ts";
import { spotifyPacingProfile } from "../../src/provider-profile.ts";
import { validateRecord } from "./schemas.ts";

const API = "https://api.spotify.com/v1";

// Single per-provider send governor + retry layer. `maxAttempts: 1` keeps the
// 429 throw byte-identical (cross-run cooldown via `retryablePattern`).
// §3 ProviderProfile: spotify declares its own AUDITED pacing ceiling (500ms ≈
// 2 req/s, ~67% of the commonly-cited ~180 req/min; WI-1b). Spotify does not
// publish the exact limit (rolling 30s window), so this is margin-heavy and
// honors Retry-After on 429. NOT a borrow of ChatGPT's 250ms. See
// src/provider-profile.ts → spotifyPacingProfile and
// docs/research/per-connector-rate-profiles-2026-06-13.md for the derivation.
const httpGovernor = createConnectorHttpGovernor({
  name: "spotify",
  maxAttempts: 1,
  profile: spotifyPacingProfile(),
});
const MAX_PAGES = 200;

interface ProgressExtra {
  cursor_present?: boolean;
  item_count?: number;
  offset_ordinal?: number;
  page_index?: number;
  phase?: string;
  rate_limit_pressure?: number;
  stream?: string;
  total_seen?: number;
}

interface SpotifyArtist {
  followers?: { total?: number | null };
  genres?: string[];
  id?: string;
  name?: string;
  popularity?: number | null;
}

interface SpotifyTrack {
  album?: { name?: string | null };
  artists?: SpotifyArtist[];
  duration_ms?: number | null;
  external_ids?: { isrc?: string | null };
  id?: string;
  name?: string;
  popularity?: number | null;
}

export interface SpotifyPlaylist {
  collaborative?: boolean | null;
  description?: string | null;
  id: string;
  items?: { total?: number | null };
  name?: string;
  owner?: { id?: string; display_name?: string };
  public?: boolean | null;
  snapshot_id?: string | null;
  tracks?: { total?: number | null };
}

interface SpotifySavedTrack {
  added_at: string;
  track: SpotifyTrack | null;
}

interface SpotifyPlayHistory {
  context?: { type?: string | null };
  played_at: string;
  track: SpotifyTrack;
}

interface PagedResponse<T> {
  items?: T[];
  next?: string | null;
}

/**
 * Spotify's `after` filter is strictly exclusive. Replaying the one-ms
 * boundary keeps same-timestamp plays recoverable; the composite record id
 * makes that replay idempotent at the runtime boundary.
 */
export function recentlyPlayedAfterCursor(lastPlayedAtUnix: number | undefined): number | undefined {
  if (lastPlayedAtUnix === undefined || !Number.isFinite(lastPlayedAtUnix) || lastPlayedAtUnix <= 0) {
    return;
  }
  return Math.floor(lastPlayedAtUnix) - 1;
}

/**
 * Normalize Spotify's absolute `next` URL to the path accepted by `sp` while
 * rejecting cross-origin or no-progress links before another request is made.
 */
export function spotifyNextPath(next: string | null | undefined, currentPath: string): string | null {
  if (!next) {
    return null;
  }
  let nextUrl: URL;
  try {
    nextUrl = new URL(next, API);
  } catch (error) {
    throw new Error("spotify_pagination_invalid_next", { cause: error });
  }
  const apiUrl = new URL(API);
  if (nextUrl.origin !== apiUrl.origin || !nextUrl.pathname.startsWith(`${apiUrl.pathname}/`)) {
    throw new Error("spotify_pagination_invalid_next");
  }
  const nextPath = `${nextUrl.pathname.slice(apiUrl.pathname.length)}${nextUrl.search}`;
  if (nextPath === currentPath) {
    throw new Error("spotify_pagination_no_progress");
  }
  return nextPath;
}

export function spotifyPlaylistRecord(p: SpotifyPlaylist): Record<string, unknown> {
  return {
    id: p.id,
    name: p.name,
    owner_id: p.owner?.id ?? null,
    owner_name: p.owner?.display_name ?? null,
    public: p.public ?? null,
    collaborative: p.collaborative ?? null,
    track_count: p.items?.total ?? p.tracks?.total ?? null,
    snapshot_id: p.snapshot_id ?? null,
    description: p.description ?? null,
  };
}

interface SpotifyRawResponse {
  body: string;
  headers?: Record<string, string | undefined>;
  status: number;
}

async function sp<T>(
  path: string,
  token: string,
  progress?: (message: string, extra?: ProgressExtra) => Promise<void>,
  extra?: ProgressExtra
): Promise<T> {
  let raw: SpotifyRawResponse;
  try {
    const r = await httpGovernor.request<SpotifyRawResponse, SpotifyRawResponse>(
      async () => {
        const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
        const retryAfter = res.headers.get("retry-after");
        return {
          body: await res.text().catch((): string => ""),
          ...(retryAfter === null ? {} : { headers: { "retry-after": retryAfter } }),
          status: res.status,
        };
      },
      (resp) => ({
        status: resp.status,
        ...(resp.headers === undefined ? {} : { headers: resp.headers }),
        value: resp,
      })
    );
    raw = r.value;
  } catch (error) {
    if (error instanceof Error && error.message === "spotify_rate_limited") {
      await progress?.("Spotify request rate limited", { ...extra, phase: "rate_limit", rate_limit_pressure: 1 });
    }
    throw error;
  }
  if (raw.status === 401) {
    throw new Error("spotify_auth_failed");
  }
  if (raw.status < 200 || raw.status >= 300) {
    throw new Error(`spotify_http_${String(raw.status)}: ${raw.body.slice(0, 200)}`);
  }
  return JSON.parse(raw.body) as T;
}

async function paginate<T>(
  path: string,
  token: string,
  progress: (message: string, extra?: ProgressExtra) => Promise<void>,
  stream: string
): Promise<T[]> {
  const all: T[] = [];
  let next: string | null = path;
  let pageIndex = 0;
  while (next) {
    if (pageIndex >= MAX_PAGES) {
      throw new Error(`spotify_pagination_max_pages_exceeded: ${String(MAX_PAGES)}`);
    }
    const pageExtra = {
      stream,
      phase: "fetch",
      page_index: pageIndex,
      offset_ordinal: pageIndex,
      total_seen: all.length,
      cursor_present: pageIndex > 0,
    };
    await progress("Fetching Spotify page", pageExtra);
    const json: PagedResponse<T> = await sp<PagedResponse<T>>(next, token, progress, pageExtra);
    if (Array.isArray(json.items)) {
      all.push(...json.items);
    }
    await progress("Fetched Spotify page", {
      stream,
      phase: "page",
      page_index: pageIndex,
      offset_ordinal: pageIndex,
      item_count: json.items?.length ?? 0,
      total_seen: all.length,
      cursor_present: Boolean(json.next),
    });
    next = spotifyNextPath(json.next, next);
    pageIndex += 1;
  }
  return all;
}

async function collectPlaylists(
  token: string,
  emit: (msg: EmittedMessage) => Promise<void>,
  emitRecord: (stream: string, data: Record<string, unknown>) => Promise<void>,
  progress: (message: string, extra?: ProgressExtra) => Promise<void>
): Promise<void> {
  await progress("Fetching playlists", { stream: "playlists", phase: "start" });
  const items = await paginate<SpotifyPlaylist>("/me/playlists?limit=50", token, progress, "playlists");
  let covered = 0;
  for (const p of items) {
    const record = spotifyPlaylistRecord(p);
    if (validateRecord("playlists", record).ok) {
      covered += 1;
    }
    await emitRecord("playlists", record);
  }
  // `playlists` is a full_inventory list with no drop/filter path: the page
  // scan enumerates every playlist, so considered === covered === the exact
  // count fetched, every run (including a genuine zero-playlist account).
  await emitDetailCoverage(
    { emit },
    {
      stream: "playlists",
      stateStream: "playlists",
      requiredKeys: [],
      hydratedKeys: [],
      considered: items.length,
      covered,
    }
  );
}

interface SavedTracksState {
  last_added_at?: string;
}

async function collectSavedTracks(
  token: string,
  state: Record<string, unknown>,
  emit: (msg: EmittedMessage) => Promise<void>,
  emitRecord: (stream: string, data: Record<string, unknown>) => Promise<void>,
  progress: (message: string, extra?: ProgressExtra) => Promise<void>
): Promise<void> {
  await progress("Fetching saved tracks", { stream: "saved_tracks", phase: "start" });
  const items = await paginate<SpotifySavedTrack>("/me/tracks?limit=50", token, progress, "saved_tracks");
  const savedState = state.saved_tracks as SavedTracksState | undefined;
  let latest: string | undefined = savedState?.last_added_at;
  let covered = 0;
  for (const item of items) {
    const t = item.track;
    if (!t) {
      continue;
    }
    const addedAt = item.added_at;
    const record = {
      id: t.id ?? null,
      name: t.name,
      artist_names: (t.artists || []).map((a) => a.name),
      album_name: t.album?.name ?? null,
      duration_ms: t.duration_ms ?? null,
      popularity: t.popularity ?? null,
      added_at: addedAt,
      isrc: t.external_ids?.isrc ?? null,
    };
    const recordValid = validateRecord("saved_tracks", record).ok;
    if (recordValid) {
      covered += 1;
    }
    if (savedState?.last_added_at && addedAt < savedState.last_added_at) {
      continue;
    }
    await emitRecord("saved_tracks", record);
    if (recordValid && addedAt && (!latest || addedAt > latest)) {
      latest = addedAt;
    }
  }
  await emit({
    type: "STATE",
    stream: "saved_tracks",
    cursor: { last_added_at: latest || null },
  });
  await emitDetailCoverage(
    { emit },
    {
      stream: "saved_tracks",
      stateStream: "saved_tracks",
      requiredKeys: [],
      hydratedKeys: [],
      considered: items.length,
      covered,
    }
  );
}

async function collectTopArtists(
  token: string,
  emit: (msg: EmittedMessage) => Promise<void>,
  emitRecord: (stream: string, data: Record<string, unknown>) => Promise<void>,
  progress: (message: string, extra?: ProgressExtra) => Promise<void>
): Promise<void> {
  await progress("Fetching top artists", { stream: "top_artists", phase: "start" });
  const ranges = ["short_term", "medium_term", "long_term"] as const;
  let totalSeen = 0;
  let covered = 0;
  for (let i = 0; i < ranges.length; i += 1) {
    const range = ranges[i];
    if (!range) {
      continue;
    }
    const pageExtra = {
      stream: "top_artists",
      phase: "fetch",
      page_index: i,
      offset_ordinal: i,
      total_seen: totalSeen,
      cursor_present: i > 0,
    };
    await progress("Fetching Spotify top artists window", pageExtra);
    const artists = await paginate<SpotifyArtist>(
      `/me/top/artists?time_range=${range}&limit=50`,
      token,
      progress,
      "top_artists"
    );
    totalSeen += artists.length;
    await progress("Fetched Spotify top artists window", {
      stream: "top_artists",
      phase: "page",
      page_index: i,
      offset_ordinal: i,
      item_count: artists.length,
      total_seen: totalSeen,
      cursor_present: i < ranges.length - 1,
    });
    for (const a of artists) {
      const record = {
        id: a.id ?? null,
        name: a.name,
        genres: a.genres || [],
        popularity: a.popularity ?? null,
        followers: a.followers?.total ?? null,
        time_range: range,
      };
      if (validateRecord("top_artists", record).ok) {
        covered += 1;
      }
      await emitRecord("top_artists", record);
    }
  }
  // `top_artists` fans out across 3 fixed time-range windows. Count the API
  // boundary separately from valid emitted records so a malformed source row
  // cannot be mistaken for complete coverage.
  await emitDetailCoverage(
    { emit },
    {
      stream: "top_artists",
      stateStream: "top_artists",
      requiredKeys: [],
      hydratedKeys: [],
      considered: totalSeen,
      covered,
    }
  );
}

interface RecentlyPlayedState {
  last_played_at_unix?: number;
}

async function collectRecentlyPlayed(
  token: string,
  state: Record<string, unknown>,
  emit: (msg: EmittedMessage) => Promise<void>,
  emitRecord: (stream: string, data: Record<string, unknown>) => Promise<void>,
  progress: (message: string, extra?: ProgressExtra) => Promise<void>
): Promise<void> {
  await progress("Fetching recently played", { stream: "recently_played", phase: "start" });
  const rpState = state.recently_played as RecentlyPlayedState | undefined;
  const after = recentlyPlayedAfterCursor(rpState?.last_played_at_unix);
  const path = `/me/player/recently-played?limit=50${after === undefined ? "" : `&after=${String(after)}`}`;
  const items = await paginate<SpotifyPlayHistory>(path, token, progress, "recently_played");
  let latest: number | null = rpState?.last_played_at_unix ?? null;
  let covered = 0;
  for (const p of items) {
    const playedAt = p.played_at;
    const id = `${String(p.track.id)}:${String(new Date(playedAt).getTime())}`;
    const record = {
      id,
      track_id: p.track.id,
      track_name: p.track.name,
      artist_names: (p.track.artists || []).map((a) => a.name),
      album_name: p.track.album?.name ?? null,
      played_at: playedAt,
      context_type: p.context?.type ?? null,
    };
    if (validateRecord("recently_played", record).ok) {
      covered += 1;
    }
    await emitRecord("recently_played", record);
    const ms = new Date(playedAt).getTime();
    if (Number.isFinite(ms) && (latest === null || ms > latest)) {
      latest = ms;
    }
  }
  await emit({
    type: "STATE",
    stream: "recently_played",
    cursor: { last_played_at_unix: latest },
  });
  await emitDetailCoverage(
    { emit },
    {
      stream: "recently_played",
      stateStream: "recently_played",
      requiredKeys: [],
      hydratedKeys: [],
      considered: items.length,
      covered,
    }
  );
}

export async function spotifyCollect({
  state,
  requested,
  credentials,
  emit,
  emitRecord,
  progress,
}: Pick<CollectContext, "state" | "requested" | "credentials" | "emit" | "emitRecord" | "progress">): Promise<void> {
  const token = credentials.SPOTIFY_ACCESS_TOKEN;
  if (!token) {
    throw new Error("spotify_auth_failed");
  }

  if (requested.has("playlists")) {
    await collectPlaylists(token, emit, emitRecord, progress);
  }

  if (requested.has("saved_tracks")) {
    await collectSavedTracks(token, state, emit, emitRecord, progress);
  }

  if (requested.has("top_artists")) {
    await collectTopArtists(token, emit, emitRecord, progress);
  }

  if (requested.has("recently_played")) {
    await collectRecentlyPlayed(token, state, emit, emitRecord, progress);
  }
}

if (isMainModule(import.meta.url)) {
  runConnector({
    name: "spotify",
    validateRecord,
    retryablePattern: /rate_limited|ECONN|fetch failed|retryable status \d+/i,
    auth: { kind: "env", required: ["SPOTIFY_ACCESS_TOKEN"] },
    collect: spotifyCollect,
  });
}
