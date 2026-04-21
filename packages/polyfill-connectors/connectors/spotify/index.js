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

import { createInterface } from 'node:readline';
import { resourceSet, requireCredentialsOrAsk } from '../../src/scope-filters.js';
import { stringifyForJsonl } from '../../src/safe-emit.js';

const rl = createInterface({ input: process.stdin, terminal: false });
const emit = (m) => process.stdout.write(stringifyForJsonl(m));
const flushAndExit = (code) => {
  if (process.stdout.writableLength > 0) {
    process.stdout.once('drain', () => process.exit(code));
    setTimeout(() => process.exit(code), 3000).unref();
  } else process.exit(code);
};
const fail = (m, r = false) => { emit({ type: 'DONE', status: 'failed', records_emitted: 0, error: { message: m, retryable: r } }); flushAndExit(1); };
const nowIso = () => new Date().toISOString();

let _ic = 0;
const nextInteractionId = () => `int_${Date.now()}_${++_ic}`;
async function sendInteractionAndWait(msg) {
  emit(msg);
  const reqId = msg.request_id;
  return new Promise((resolve, reject) => {
    const onLine = (line) => {
      try {
        const p = JSON.parse(line);
        if (p.type === 'INTERACTION_RESPONSE' && p.request_id === reqId) { rl.off('line', onLine); resolve(p); }
      } catch (err) { reject(err); }
    };
    rl.on('line', onLine);
  });
}

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

async function main() {
  const startMsg = await new Promise((r, j) => rl.once('line', (l) => { try { r(JSON.parse(l)); } catch (e) { j(e); } }));
  if (startMsg.type !== 'START') return fail('Expected START');

  let token = process.env.SPOTIFY_ACCESS_TOKEN;
  if (!token) {
    try {
      const creds = await requireCredentialsOrAsk({
        required: ['SPOTIFY_ACCESS_TOKEN'],
        connectorName: 'Spotify',
        sendInteractionAndWait,
        nextInteractionId,
      });
      token = creds.SPOTIFY_ACCESS_TOKEN;
    } catch (e) { return fail(e.message, false); }
  }

  const requested = new Map((startMsg.scope?.streams || []).map((s) => [s.name, s]));
  if (!requested.size) return fail('START.scope.streams is required');

  const resFilters = new Map();
  for (const [n, r] of requested) resFilters.set(n, resourceSet(r));

  const state = startMsg.state || {};
  const emittedAt = nowIso();
  let total = 0;
  const emitRecord = (s, d) => {
    if (d.id == null) return;
    const resSet = resFilters.get(s);
    if (resSet && !resSet.has(String(d.id))) return;
    emit({ type: 'RECORD', stream: s, key: d.id, data: d, emitted_at: emittedAt });
    total++;
  };

  if (requested.has('playlists')) {
    emit({ type: 'PROGRESS', stream: 'playlists', message: 'Fetching playlists' });
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
    emit({ type: 'PROGRESS', stream: 'saved_tracks', message: 'Fetching saved tracks' });
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
    emit({ type: 'PROGRESS', stream: 'top_artists', message: 'Fetching top artists' });
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
    emit({ type: 'PROGRESS', stream: 'recently_played', message: 'Fetching recently played' });
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

  emit({ type: 'DONE', status: 'succeeded', records_emitted: total });
  flushAndExit(0);
}

main().catch((e) => {
  const msg = e?.message || String(e);
  emit({ type: 'DONE', status: 'failed', records_emitted: 0, error: { message: msg, retryable: /rate_limited|ECONN|fetch failed/i.test(msg) } });
  flushAndExit(1);
});
