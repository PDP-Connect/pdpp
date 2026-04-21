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

async function main() {
  const startMsg = await new Promise((r, j) => rl.once('line', (l) => { try { r(JSON.parse(l)); } catch (e) { j(e); } }));
  if (startMsg.type !== 'START') return fail('Expected START');

  let token = process.env.STRAVA_ACCESS_TOKEN;
  if (!token) {
    try {
      const creds = await requireCredentialsOrAsk({
        required: ['STRAVA_ACCESS_TOKEN'],
        connectorName: 'Strava',
        sendInteractionAndWait,
        nextInteractionId,
      });
      token = creds.STRAVA_ACCESS_TOKEN;
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

  if (requested.has('activities')) {
    emit({ type: 'PROGRESS', stream: 'activities', message: 'Fetching activities' });
    const lastEpoch = state.activities?.last_start_epoch;
    let page = 1;
    let latest = lastEpoch || 0;
    while (true) {
      const url = new URL('https://www.strava.com/api/v3/athlete/activities');
      url.searchParams.set('per_page', '100');
      url.searchParams.set('page', String(page));
      if (lastEpoch) url.searchParams.set('after', String(lastEpoch));
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (res.status === 401) return fail('strava_auth_failed');
      if (res.status === 429) return fail('strava_rate_limited', true);
      if (!res.ok) return fail(`strava_http_${res.status}: ${(await res.text()).slice(0, 200)}`, /5\d\d/.test(String(res.status)));
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

  emit({ type: 'DONE', status: 'succeeded', records_emitted: total });
  flushAndExit(0);
}

main().catch((e) => {
  const msg = e?.message || String(e);
  emit({ type: 'DONE', status: 'failed', records_emitted: 0, error: { message: msg, retryable: /ECONN|fetch failed|rate_limited/i.test(msg) } });
  flushAndExit(1);
});
