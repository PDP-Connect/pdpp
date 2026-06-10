#!/usr/bin/env node
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
 * Rate limit: 180 req/min per token typical.
 */

import { createConnectorHttpGovernor } from "../../src/connector-http-governor.ts";
import { runConnector } from "../../src/connector-runtime.ts";
import { validateRecord } from "./schemas.ts";

const API = "https://api.spotify.com/v1";

// Single per-provider send governor + retry layer. `maxAttempts: 1` keeps the
// 429 throw byte-identical (cross-run cooldown via `retryablePattern`).
const httpGovernor = createConnectorHttpGovernor({ name: "spotify", maxAttempts: 1 });
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

interface SpotifyPlaylist {
  collaborative?: boolean | null;
  description?: string | null;
  id: string;
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
  items: T[];
  next?: string | null;
}

async function sp<T>(
  path: string,
  token: string,
  progress?: (message: string, extra?: ProgressExtra) => Promise<void>,
  extra?: ProgressExtra
): Promise<T> {
  let raw: { body: string; status: number };
  try {
    const r = await httpGovernor.request<{ body: string; status: number }, { body: string; status: number }>(
      async () => {
        const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
        const retryAfter = res.headers.get("retry-after");
        return {
          body: await res.text().catch((): string => ""),
          ...(retryAfter == null ? {} : { headers: { "retry-after": retryAfter } }),
          status: res.status,
        } as { body: string; status: number };
      },
      (resp) => ({ status: resp.status, value: resp })
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
  let guard = MAX_PAGES;
  let pageIndex = 0;
  while (next && guard-- > 0) {
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
    next = json.next ? json.next.replace(API, "") : null;
    pageIndex++;
  }
  return all;
}

async function collectPlaylists(
  token: string,
  emitRecord: (stream: string, data: Record<string, unknown>) => Promise<void>,
  progress: (message: string, extra?: ProgressExtra) => Promise<void>
): Promise<void> {
  await progress("Fetching playlists", { stream: "playlists", phase: "start" });
  const items = await paginate<SpotifyPlaylist>("/me/playlists?limit=50", token, progress, "playlists");
  for (const p of items) {
    await emitRecord("playlists", {
      id: p.id,
      name: p.name,
      owner_id: p.owner?.id ?? null,
      owner_name: p.owner?.display_name ?? null,
      public: p.public ?? null,
      collaborative: p.collaborative ?? null,
      track_count: p.tracks?.total ?? null,
      snapshot_id: p.snapshot_id ?? null,
      description: p.description ?? null,
    });
  }
}

interface SavedTracksState {
  last_added_at?: string;
}

async function collectSavedTracks(
  token: string,
  state: Record<string, unknown>,
  emit: (msg: { type: "STATE"; stream: string; cursor: unknown }) => Promise<void>,
  emitRecord: (stream: string, data: Record<string, unknown>) => Promise<void>,
  progress: (message: string, extra?: ProgressExtra) => Promise<void>
): Promise<void> {
  await progress("Fetching saved tracks", { stream: "saved_tracks", phase: "start" });
  const items = await paginate<SpotifySavedTrack>("/me/tracks?limit=50", token, progress, "saved_tracks");
  const savedState = state.saved_tracks as SavedTracksState | undefined;
  let latest: string | undefined = savedState?.last_added_at;
  for (const item of items) {
    const t = item.track;
    if (!t) {
      continue;
    }
    const addedAt = item.added_at;
    if (savedState?.last_added_at && addedAt <= savedState.last_added_at) {
      continue;
    }
    await emitRecord("saved_tracks", {
      id: t.id,
      name: t.name,
      artist_names: (t.artists || []).map((a) => a.name),
      album_name: t.album?.name ?? null,
      duration_ms: t.duration_ms ?? null,
      popularity: t.popularity ?? null,
      added_at: addedAt,
      isrc: t.external_ids?.isrc ?? null,
    });
    if (addedAt && (!latest || addedAt > latest)) {
      latest = addedAt;
    }
  }
  await emit({
    type: "STATE",
    stream: "saved_tracks",
    cursor: { last_added_at: latest || null },
  });
}

async function collectTopArtists(
  token: string,
  emitRecord: (stream: string, data: Record<string, unknown>) => Promise<void>,
  progress: (message: string, extra?: ProgressExtra) => Promise<void>
): Promise<void> {
  await progress("Fetching top artists", { stream: "top_artists", phase: "start" });
  const ranges = ["short_term", "medium_term", "long_term"] as const;
  let totalSeen = 0;
  for (let i = 0; i < ranges.length; i++) {
    const range = ranges[i];
    const pageExtra = {
      stream: "top_artists",
      phase: "fetch",
      page_index: i,
      offset_ordinal: i,
      total_seen: totalSeen,
      cursor_present: i > 0,
    };
    await progress("Fetching Spotify top artists window", pageExtra);
    const json = await sp<{ items?: SpotifyArtist[] }>(
      `/me/top/artists?time_range=${range}&limit=50`,
      token,
      progress,
      pageExtra
    );
    totalSeen += json.items?.length ?? 0;
    await progress("Fetched Spotify top artists window", {
      stream: "top_artists",
      phase: "page",
      page_index: i,
      offset_ordinal: i,
      item_count: json.items?.length ?? 0,
      total_seen: totalSeen,
      cursor_present: i < ranges.length - 1,
    });
    for (const a of json.items || []) {
      await emitRecord("top_artists", {
        id: a.id,
        name: a.name,
        genres: a.genres || [],
        popularity: a.popularity ?? null,
        followers: a.followers?.total ?? null,
        time_range: range,
      });
    }
  }
}

interface RecentlyPlayedState {
  last_played_at_unix?: number;
}

async function collectRecentlyPlayed(
  token: string,
  state: Record<string, unknown>,
  emit: (msg: { type: "STATE"; stream: string; cursor: unknown }) => Promise<void>,
  emitRecord: (stream: string, data: Record<string, unknown>) => Promise<void>,
  progress: (message: string, extra?: ProgressExtra) => Promise<void>
): Promise<void> {
  await progress("Fetching recently played", { stream: "recently_played", phase: "start" });
  const rpState = state.recently_played as RecentlyPlayedState | undefined;
  const after = rpState?.last_played_at_unix;
  const path = `/me/player/recently-played?limit=50${after ? `&after=${String(after)}` : ""}`;
  const pageExtra = {
    stream: "recently_played",
    phase: "fetch",
    page_index: 0,
    offset_ordinal: 0,
    total_seen: 0,
    cursor_present: Boolean(after),
  };
  await progress("Fetching Spotify recently played page", pageExtra);
  const json = await sp<{ items?: SpotifyPlayHistory[] }>(path, token, progress, pageExtra);
  await progress("Fetched Spotify recently played page", {
    stream: "recently_played",
    phase: "page",
    page_index: 0,
    offset_ordinal: 0,
    item_count: json.items?.length ?? 0,
    total_seen: json.items?.length ?? 0,
    cursor_present: Boolean(after),
  });
  let latest: number | null = null;
  for (const p of json.items || []) {
    const playedAt = p.played_at;
    const id = `${String(p.track.id)}:${String(new Date(playedAt).getTime())}`;
    await emitRecord("recently_played", {
      id,
      track_id: p.track.id,
      track_name: p.track.name,
      artist_names: (p.track.artists || []).map((a) => a.name),
      album_name: p.track.album?.name ?? null,
      played_at: playedAt,
      context_type: p.context?.type ?? null,
    });
    const ms = new Date(playedAt).getTime();
    if (!latest || ms > latest) {
      latest = ms;
    }
  }
  await emit({
    type: "STATE",
    stream: "recently_played",
    cursor: { last_played_at_unix: latest || after || null },
  });
}

runConnector({
  name: "spotify",
  validateRecord,
  retryablePattern: /rate_limited|ECONN|fetch failed/i,
  auth: { kind: "env", required: ["SPOTIFY_ACCESS_TOKEN"] },
  async collect({ state, requested, credentials, emit, emitRecord, progress }) {
    const token = credentials.SPOTIFY_ACCESS_TOKEN;
    if (!token) {
      throw new Error("spotify_auth_failed");
    }

    if (requested.has("playlists")) {
      await collectPlaylists(token, emitRecord, progress);
    }

    if (requested.has("saved_tracks")) {
      await collectSavedTracks(token, state, emit, emitRecord, progress);
    }

    if (requested.has("top_artists")) {
      await collectTopArtists(token, emitRecord, progress);
    }

    if (requested.has("recently_played")) {
      await collectRecentlyPlayed(token, state, emit, emitRecord, progress);
    }
  },
});
