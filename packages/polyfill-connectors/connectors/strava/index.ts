#!/usr/bin/env node
/**
 * PDPP Strava Connector (v0.1.0)
 *
 * Auth: OAuth access token via STRAVA_ACCESS_TOKEN env var.
 * Create app at https://www.strava.com/settings/api, run OAuth flow
 * with scopes: read, activity:read_all.
 *
 * API: https://www.strava.com/api/v3/athlete/activities?after=<unix>
 * Rate limits (non-upload, read endpoints): 100 req / 15 min, 1000 req / day.
 *   Doc: https://developers.strava.com/docs/rate-limits/
 */

import { createConnectorHttpGovernor } from "../../src/connector-http-governor.ts";
import { type RecordData, runConnector } from "../../src/connector-runtime.ts";
import { stravaPacingProfile } from "../../src/provider-profile.ts";
import { validateRecord } from "./schemas.ts";

// Single per-provider send governor + retry layer. `maxAttempts: 1` keeps the
// 429 throw byte-identical (cross-run cooldown via `retryablePattern`).
// §3 ProviderProfile: strava declares its own AUDITED pacing ceiling (10000ms ≈
// 6 req/min, set BELOW the 100-req/15-min non-upload sustained rate so the AIMD
// can never drain the window budget; the tightest of the six by design — Strava's
// short window + explicit ban warning; WI-1b). NOT a borrow of ChatGPT's 250ms.
// See src/provider-profile.ts → stravaPacingProfile and
// docs/research/per-connector-rate-profiles-2026-06-13.md for the derivation.
const httpGovernor = createConnectorHttpGovernor({
  name: "strava",
  maxAttempts: 1,
  profile: stravaPacingProfile(),
});

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

interface ProgressExtra {
  cursor_present?: boolean;
  item_count?: number;
  page_index?: number;
  phase?: string;
  rate_limit_pressure?: number;
  stream?: string;
  total_seen?: number;
}

async function fetchActivitiesPage(
  token: string,
  page: number,
  afterEpoch: number | undefined,
  progress?: (message: string, extra?: ProgressExtra) => Promise<void>,
  extra?: ProgressExtra
): Promise<StravaActivity[]> {
  const url = new URL(ACTIVITIES_URL);
  url.searchParams.set("per_page", String(PAGE_SIZE));
  url.searchParams.set("page", String(page));
  if (afterEpoch) {
    url.searchParams.set("after", String(afterEpoch));
  }
  let raw: { body: string; status: number };
  try {
    const r = await httpGovernor.request<{ body: string; status: number }, { body: string; status: number }>(
      async () => {
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
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
    if (error instanceof Error && error.message === "strava_rate_limited") {
      await progress?.("Strava request rate limited", { ...extra, phase: "rate_limit", rate_limit_pressure: 1 });
    }
    throw error;
  }
  if (raw.status === 401) {
    throw new Error("strava_auth_failed");
  }
  if (raw.status < 200 || raw.status >= 300) {
    throw new Error(`strava_http_${String(raw.status)}: ${raw.body.slice(0, 200)}`);
  }
  return JSON.parse(raw.body) as StravaActivity[];
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
    const progressWithSignals = progress as (message: string, extra?: ProgressExtra) => Promise<void>;
    const token = credentials.STRAVA_ACCESS_TOKEN;
    if (!token) {
      throw new Error("strava_auth_failed");
    }

    if (!requested.has("activities")) {
      return;
    }
    await progressWithSignals("Fetching activities", { stream: "activities", phase: "start" });
    const activitiesState = state.activities as { last_start_epoch?: number } | undefined;
    const lastEpoch = activitiesState?.last_start_epoch;
    let page = 1;
    let latest = lastEpoch || 0;
    let totalSeen = 0;
    while (page <= MAX_PAGES) {
      const pageIndex = page - 1;
      const pageExtra = {
        stream: "activities",
        phase: "fetch",
        page_index: pageIndex,
        total_seen: totalSeen,
        cursor_present: Boolean(lastEpoch),
      };
      await progressWithSignals("Fetching Strava activities page", pageExtra);
      const acts = await fetchActivitiesPage(token, page, lastEpoch, progressWithSignals, pageExtra);
      totalSeen += acts.length;
      await progressWithSignals("Fetched Strava activities page", {
        stream: "activities",
        phase: "page",
        page_index: pageIndex,
        item_count: acts.length,
        total_seen: totalSeen,
        cursor_present: acts.length === PAGE_SIZE,
      });
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
