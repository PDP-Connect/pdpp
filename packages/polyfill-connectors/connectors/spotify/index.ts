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

import { runConnector } from "../../src/connector-runtime.ts";

const API = "https://api.spotify.com/v1";
const MAX_PAGES = 200;

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

async function sp<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    throw new Error("spotify_auth_failed");
  }
  if (res.status === 429) {
    throw new Error("spotify_rate_limited");
  }
  if (!res.ok) {
    throw new Error(
      `spotify_http_${String(res.status)}: ${(await res.text()).slice(0, 200)}`
    );
  }
  return (await res.json()) as T;
}

async function paginate<T>(path: string, token: string): Promise<T[]> {
  const all: T[] = [];
  let next: string | null = path;
  let guard = MAX_PAGES;
  while (next && guard-- > 0) {
    const json: PagedResponse<T> = await sp<PagedResponse<T>>(next, token);
    if (Array.isArray(json.items)) {
      all.push(...json.items);
    }
    next = json.next ? json.next.replace(API, "") : null;
  }
  return all;
}

async function collectPlaylists(
  token: string,
  emitRecord: (stream: string, data: Record<string, unknown>) => Promise<void>,
  progress: (message: string, extra?: { stream?: string }) => Promise<void>
): Promise<void> {
  await progress("Fetching playlists", { stream: "playlists" });
  const items = await paginate<SpotifyPlaylist>(
    "/me/playlists?limit=50",
    token
  );
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
  emit: (msg: {
    type: "STATE";
    stream: string;
    cursor: unknown;
  }) => Promise<void>,
  emitRecord: (stream: string, data: Record<string, unknown>) => Promise<void>,
  progress: (message: string, extra?: { stream?: string }) => Promise<void>
): Promise<void> {
  await progress("Fetching saved tracks", { stream: "saved_tracks" });
  const items = await paginate<SpotifySavedTrack>("/me/tracks?limit=50", token);
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
  progress: (message: string, extra?: { stream?: string }) => Promise<void>
): Promise<void> {
  await progress("Fetching top artists", { stream: "top_artists" });
  for (const range of ["short_term", "medium_term", "long_term"] as const) {
    const json = await sp<{ items?: SpotifyArtist[] }>(
      `/me/top/artists?time_range=${range}&limit=50`,
      token
    );
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
  emit: (msg: {
    type: "STATE";
    stream: string;
    cursor: unknown;
  }) => Promise<void>,
  emitRecord: (stream: string, data: Record<string, unknown>) => Promise<void>,
  progress: (message: string, extra?: { stream?: string }) => Promise<void>
): Promise<void> {
  await progress("Fetching recently played", { stream: "recently_played" });
  const rpState = state.recently_played as RecentlyPlayedState | undefined;
  const after = rpState?.last_played_at_unix;
  const path = `/me/player/recently-played?limit=50${after ? `&after=${String(after)}` : ""}`;
  const json = await sp<{ items?: SpotifyPlayHistory[] }>(path, token);
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
