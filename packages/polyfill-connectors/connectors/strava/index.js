#!/usr/bin/env node
/**
 * PDPP Strava Connector (v0.1.0)
 *
 * Auth: OAuth access token via STRAVA_ACCESS_TOKEN env var.
 * Create app at https://www.strava.com/settings/api, run OAuth flow
 * with scopes: read, activity:read_all.
 *
 * API: https://www.strava.com/api/v3/athlete/activities?after=<unix>
 * Rate limits: 100 req / 15 min, 1000 req / day.
 */

import { runConnector } from '../../src/connector-runtime.js';

runConnector({
  name: 'strava',
  retryablePattern: /ECONN|fetch failed|rate_limited/i,
  auth: { kind: 'env', required: ['STRAVA_ACCESS_TOKEN'] },
  async collect({ state, requested, credentials, emit, emitRecord, progress }) {
    const token = credentials.STRAVA_ACCESS_TOKEN;

    if (requested.has('activities')) {
      progress('Fetching activities', { stream: 'activities' });
      const lastEpoch = state.activities?.last_start_epoch;
      let page = 1;
      let latest = lastEpoch || 0;
      while (true) {
        const url = new URL('https://www.strava.com/api/v3/athlete/activities');
        url.searchParams.set('per_page', '100');
        url.searchParams.set('page', String(page));
        if (lastEpoch) url.searchParams.set('after', String(lastEpoch));
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        if (res.status === 401) throw new Error('strava_auth_failed');
        if (res.status === 429) throw new Error('strava_rate_limited');
        if (!res.ok) throw new Error(`strava_http_${res.status}: ${(await res.text()).slice(0, 200)}`);
        const acts = await res.json();
        if (!acts.length) break;
        for (const a of acts) {
          const epoch = Math.floor(new Date(a.start_date).getTime() / 1000);
          emitRecord('activities', {
            id: String(a.id),
            name: a.name ?? null,
            type: a.type ?? null,
            sport_type: a.sport_type ?? null,
            start_date: a.start_date,
            start_date_local: a.start_date_local ?? null,
            timezone: a.timezone ?? null,
            distance_m: a.distance ?? null,
            moving_time_s: a.moving_time ?? null,
            elapsed_time_s: a.elapsed_time ?? null,
            total_elevation_gain_m: a.total_elevation_gain ?? null,
            average_speed_mps: a.average_speed ?? null,
            max_speed_mps: a.max_speed ?? null,
            average_heartrate: a.average_heartrate ?? null,
            max_heartrate: a.max_heartrate ?? null,
            kudos_count: a.kudos_count ?? null,
            comment_count: a.comment_count ?? null,
            achievement_count: a.achievement_count ?? null,
            start_latlng: a.start_latlng || [],
            end_latlng: a.end_latlng || [],
            map_polyline: a.map?.summary_polyline ?? null,
          });
          if (epoch > latest) latest = epoch;
        }
        if (acts.length < 100) break;
        page++;
        if (page > 200) break; // safety
      }
      emit({ type: 'STATE', stream: 'activities', cursor: { last_start_epoch: latest } });
    }
  },
});
