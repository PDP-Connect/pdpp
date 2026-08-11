// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { recentlyPlayedAfterCursor, type SpotifyPlaylist, spotifyNextPath, spotifyPlaylistRecord } from "./index.ts";
import { playlistsSchema } from "./schemas.ts";

const playlist = JSON.parse(
  readFileSync(new URL("./__fixtures__/playlist-items-response.json", import.meta.url), "utf8")
) as SpotifyPlaylist;

test("Spotify playlist records preserve the current items.total response field", () => {
  const record = spotifyPlaylistRecord(playlist);
  assert.equal(record.track_count, 7);
  assert.equal(playlistsSchema.safeParse(record).success, true);
});

test("Spotify recently-played cursor replays the strict boundary for idempotent recovery", () => {
  assert.equal(recentlyPlayedAfterCursor(1_700_000_000_000), 1_699_999_999_999);
  assert.equal(recentlyPlayedAfterCursor(0), undefined);
  assert.equal(recentlyPlayedAfterCursor(undefined), undefined);
});

test("Spotify next-page handling stays on the API origin and rejects no-progress links", () => {
  assert.equal(
    spotifyNextPath("https://api.spotify.com/v1/me/playlists?limit=50&offset=50", "/me/playlists?limit=50"),
    "/me/playlists?limit=50&offset=50"
  );
  assert.equal(spotifyNextPath(null, "/me/playlists?limit=50"), null);
  assert.throws(
    () => spotifyNextPath("https://example.invalid/v1/me/playlists?offset=50", "/me/playlists?offset=0"),
    /spotify_pagination_invalid_next/
  );
  assert.throws(
    () => spotifyNextPath("https://api.spotify.com/v1/me/playlists?offset=0", "/me/playlists?offset=0"),
    /spotify_pagination_no_progress/
  );
});
