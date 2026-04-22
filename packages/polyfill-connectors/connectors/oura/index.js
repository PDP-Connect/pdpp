#!/usr/bin/env node
/**
 * PDPP Oura Connector (v0.1.0)
 *
 * Auth: OURA_PERSONAL_ACCESS_TOKEN env var.
 * Generate at https://cloud.ouraring.com/personal-access-tokens
 *
 * Streams: sleep, readiness, activity. Incremental via day cursor.
 * API: https://api.ouraring.com/v2/usercollection/*
 * Rate limit: 5000/day for personal tokens.
 */

import { requireCredentialsOrAsk } from '../../src/scope-filters.js';
import { runConnector } from '../../src/connector-runtime.js';

const API = 'https://api.ouraring.com/v2/usercollection';

async function oura(endpoint, token, params = {}) {
  const url = new URL(`${API}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) throw new Error('oura_auth_failed');
  if (res.status === 429) throw new Error('oura_rate_limited');
  if (!res.ok) throw new Error(`oura_http_${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function fetchAll(endpoint, token, { startDate, endDate } = {}) {
  const all = [];
  let nextToken = undefined;
  let guard = 100;
  while (guard-- > 0) {
    const params = {};
    if (startDate) params.start_date = startDate;
    if (endDate) params.end_date = endDate;
    if (nextToken) params.next_token = nextToken;
    const json = await oura(endpoint, token, params);
    if (Array.isArray(json.data)) all.push(...json.data);
    nextToken = json.next_token || null;
    if (!nextToken) break;
  }
  return all;
}

runConnector({
  name: 'oura',
  retryablePattern: /rate_limited|ECONN|fetch failed/i,
  async collect({ state, requested, emit, emitRecord, progress, sendInteraction }) {
    let token = process.env.OURA_PERSONAL_ACCESS_TOKEN;
    if (!token) {
      const creds = await requireCredentialsOrAsk({
        required: ['OURA_PERSONAL_ACCESS_TOKEN'],
        connectorName: 'Oura',
        sendInteraction,
        
      });
      token = creds.OURA_PERSONAL_ACCESS_TOKEN;
    }

    // Helper: derive since from prior state or scope
    const sinceFor = (stream) => {
      const priorDay = state[stream]?.last_day;
      const scopeReq = requested.get(stream);
      const scopeSince = scopeReq?.time_range?.since?.slice(0, 10);
      return priorDay || scopeSince || null;
    };

    if (requested.has('sleep')) {
      progress('Fetching sleep sessions', { stream: 'sleep' });
      const startDate = sinceFor('sleep');
      const rows = await fetchAll('sleep', token, { startDate });
      let lastDay = state.sleep?.last_day || null;
      for (const s of rows) {
        emitRecord('sleep', {
          id: s.id,
          day: s.day,
          bedtime_start: s.bedtime_start ?? null,
          bedtime_end: s.bedtime_end ?? null,
          total_sleep_duration: s.total_sleep_duration ?? null,
          rem_sleep_duration: s.rem_sleep_duration ?? null,
          deep_sleep_duration: s.deep_sleep_duration ?? null,
          light_sleep_duration: s.light_sleep_duration ?? null,
          efficiency: s.efficiency ?? null,
          latency: s.latency ?? null,
          average_heart_rate: s.average_heart_rate ?? null,
          lowest_heart_rate: s.lowest_heart_rate ?? null,
          average_hrv: s.average_hrv ?? null,
          temperature_delta: s.temperature_delta ?? null,
          sleep_score: s.readiness?.score ?? null,
        });
        if (s.day && (!lastDay || s.day > lastDay)) lastDay = s.day;
      }
      emit({ type: 'STATE', stream: 'sleep', cursor: { last_day: lastDay } });
    }

    if (requested.has('readiness')) {
      progress('Fetching readiness', { stream: 'readiness' });
      const startDate = sinceFor('readiness');
      const rows = await fetchAll('daily_readiness', token, { startDate });
      let lastDay = state.readiness?.last_day || null;
      for (const r of rows) {
        emitRecord('readiness', {
          id: r.id,
          day: r.day,
          score: r.score ?? null,
          temperature_deviation: r.temperature_deviation ?? null,
          temperature_trend_deviation: r.temperature_trend_deviation ?? null,
          contributors: r.contributors ?? {},
        });
        if (r.day && (!lastDay || r.day > lastDay)) lastDay = r.day;
      }
      emit({ type: 'STATE', stream: 'readiness', cursor: { last_day: lastDay } });
    }

    if (requested.has('activity')) {
      progress('Fetching activity', { stream: 'activity' });
      const startDate = sinceFor('activity');
      const rows = await fetchAll('daily_activity', token, { startDate });
      let lastDay = state.activity?.last_day || null;
      for (const a of rows) {
        emitRecord('activity', {
          id: a.id,
          day: a.day,
          score: a.score ?? null,
          active_calories: a.active_calories ?? null,
          total_calories: a.total_calories ?? null,
          steps: a.steps ?? null,
          target_calories: a.target_calories ?? null,
          equivalent_walking_distance: a.equivalent_walking_distance ?? null,
        });
        if (a.day && (!lastDay || a.day > lastDay)) lastDay = a.day;
      }
      emit({ type: 'STATE', stream: 'activity', cursor: { last_day: lastDay } });
    }
  },
});
