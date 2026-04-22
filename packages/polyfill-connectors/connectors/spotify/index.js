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

import { requireCredentialsOrAsk } from '../../src/scope-filters.js';
import { runConnector } from '../../src/connector-runtime.js';

const API = 'https://api.spotify.com/v1';

async function sp(path, token) {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) throw new Error('spotify_auth_failed');
  if (res.status === 429) throw new Error('spotify_rate_limited');
  if (!res.ok) throw new Error(`spotify_http_${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function paginate(path, token) {
  const all = [];
  let next = path;
  let guard = 200;
  while (next && guard-- > 0) {
    const json = await sp(next, token);
    if (Array.isArray(json.items)) all.push(...json.items);
    next = json.next ? json.next.replace(API, '') : null;
  }
  return all;
}

runConnector({
  name: 'spotify',
  retryablePattern: /rate_limited|ECONN|fetch failed/i,
  async collect({ state, requested, emit, emitRecord, progress, sendInteraction }) {
    let token = process.env.SPOTIFY_ACCESS_TOKEN;
    if (!token) {
      const creds = await requireCredentialsOrAsk({
        required: ['SPOTIFY_ACCESS_TOKEN'],
        connectorName: 'Spotify',
        sendInteraction,
        
      });
      token = creds.SPOTIFY_ACCESS_TOKEN;
    }

    if (requested.has('playlists')) {
      progress('Fetching playlists', { stream: 'playlists' });
      const items = await paginate('/me/playlists?limit=50', token);
      for (const p of items) {
        emitRecord('playlists', {
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

    if (requested.has('saved_tracks')) {
      progress('Fetching saved tracks', { stream: 'saved_tracks' });
      const items = await paginate('/me/tracks?limit=50', token);
      let latest = state.saved_tracks?.last_added_at;
      for (const item of items) {
        const t = item.track;
        if (!t) continue;
        const addedAt = item.added_at;
        if (state.saved_tracks?.last_added_at && addedAt <= state.saved_tracks.last_added_at) continue;
        emitRecord('saved_tracks', {
          id: t.id,
          name: t.name,
          artist_names: (t.artists || []).map((a) => a.name),
          album_name: t.album?.name ?? null,
          duration_ms: t.duration_ms ?? null,
          popularity: t.popularity ?? null,
          added_at: addedAt,
          isrc: t.external_ids?.isrc ?? null,
        });
        if (addedAt && (!latest || addedAt > latest)) latest = addedAt;
      }
      emit({ type: 'STATE', stream: 'saved_tracks', cursor: { last_added_at: latest || null } });
    }

    if (requested.has('top_artists')) {
      progress('Fetching top artists', { stream: 'top_artists' });
      for (const range of ['short_term', 'medium_term', 'long_term']) {
        const json = await sp(`/me/top/artists?time_range=${range}&limit=50`, token);
        for (const a of json.items || []) {
          emitRecord('top_artists', {
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

    if (requested.has('recently_played')) {
      progress('Fetching recently played', { stream: 'recently_played' });
      const after = state.recently_played?.last_played_at_unix;
      const path = `/me/player/recently-played?limit=50${after ? `&after=${after}` : ''}`;
      const json = await sp(path, token);
      let latest = null;
      for (const p of json.items || []) {
        const playedAt = p.played_at;
        const id = `${p.track.id}:${new Date(playedAt).getTime()}`;
        emitRecord('recently_played', {
          id,
          track_id: p.track.id,
          track_name: p.track.name,
          artist_names: (p.track.artists || []).map((a) => a.name),
          album_name: p.track.album?.name ?? null,
          played_at: playedAt,
          context_type: p.context?.type ?? null,
        });
        const ms = new Date(playedAt).getTime();
        if (!latest || ms > latest) latest = ms;
      }
      emit({ type: 'STATE', stream: 'recently_played', cursor: { last_played_at_unix: latest || after || null } });
    }
  },
});
