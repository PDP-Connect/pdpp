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

import { type RecordData, runConnector } from "../../src/connector-runtime.ts";
import { validateRecord } from "./schemas.ts";

interface StravaActivity {
  achievement_count?: number | null;
  average_heartrate?: number | null;
  average_speed?: number | null;
  comment_count?: number | null;
  distance?: number | null;
  elapsed_time?: number | null;
  end_latlng?: number[] | null;
  id: number | string;
  kudos_count?: number | null;
  map?: { summary_polyline?: string | null } | null;
  max_heartrate?: number | null;
  max_speed?: number | null;
  moving_time?: number | null;
  name?: string | null;
  sport_type?: string | null;
  start_date: string;
  start_date_local?: string | null;
  start_latlng?: number[] | null;
  timezone?: string | null;
  total_elevation_gain?: number | null;
  type?: string | null;
}

const ACTIVITIES_URL = "https://www.strava.com/api/v3/athlete/activities";
const PAGE_SIZE = 100;
const MAX_PAGES = 200;

async function fetchActivitiesPage(
  token: string,
  page: number,
  afterEpoch: number | undefined
): Promise<StravaActivity[]> {
  const url = new URL(ACTIVITIES_URL);
  url.searchParams.set("per_page", String(PAGE_SIZE));
  url.searchParams.set("page", String(page));
  if (afterEpoch) {
    url.searchParams.set("after", String(afterEpoch));
  }
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    throw new Error("strava_auth_failed");
  }
  if (res.status === 429) {
    throw new Error("strava_rate_limited");
  }
  if (!res.ok) {
    throw new Error(`strava_http_${String(res.status)}: ${(await res.text()).slice(0, 200)}`);
  }
  return (await res.json()) as StravaActivity[];
}

function toActivityRecord(a: StravaActivity): RecordData {
  return {
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
  };
}

runConnector({
  name: "strava",
  validateRecord,
  retryablePattern: /ECONN|fetch failed|rate_limited/i,
  auth: { kind: "env", required: ["STRAVA_ACCESS_TOKEN"] },
  async collect({ state, requested, credentials, emit, emitRecord, progress }) {
    const token = credentials.STRAVA_ACCESS_TOKEN;
    if (!token) {
      throw new Error("strava_auth_failed");
    }

    if (!requested.has("activities")) {
      return;
    }
    await progress("Fetching activities", { stream: "activities" });
    const activitiesState = state.activities as { last_start_epoch?: number } | undefined;
    const lastEpoch = activitiesState?.last_start_epoch;
    let page = 1;
    let latest = lastEpoch || 0;
    while (page <= MAX_PAGES) {
      const acts = await fetchActivitiesPage(token, page, lastEpoch);
      if (!acts.length) {
        break;
      }
      for (const a of acts) {
        const epoch = Math.floor(new Date(a.start_date).getTime() / 1000);
        await emitRecord("activities", toActivityRecord(a));
        if (epoch > latest) {
          latest = epoch;
        }
      }
      if (acts.length < PAGE_SIZE) {
        break;
      }
      page++;
    }
    await emit({
      type: "STATE",
      stream: "activities",
      cursor: { last_start_epoch: latest },
    });
  },
});
