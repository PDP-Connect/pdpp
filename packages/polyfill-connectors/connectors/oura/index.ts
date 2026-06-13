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

import { createConnectorHttpGovernor } from "../../src/connector-http-governor.ts";
import { type RecordData, runConnector } from "../../src/connector-runtime.ts";
import { unauditedConservativePacingProfile } from "../../src/provider-profile.ts";
import { validateRecord } from "./schemas.ts";

const API = "https://api.ouraring.com/v2/usercollection";
const MAX_PAGES = 100;

// Single per-provider send governor + retry layer (shared convergence
// primitive). `maxAttempts: 1` keeps today's behavior byte-identical: a 429
// throws `oura_rate_limited` immediately (no inline retry), so the runtime
// `retryablePattern` cross-run source-pressure deferral/cooldown contract is
// unchanged. Raising `maxAttempts` (an owner knob) activates the now-wired
// inline Retry-After honor + bounded backoff without touching this call site.
// §3 ProviderProfile: oura declares its own pacing ceiling — a conservative,
// UNAUDITED placeholder (NOT a borrow of ChatGPT's 250ms). Replace with oura's
// real observed flagging threshold once audited (task 1b).
const httpGovernor = createConnectorHttpGovernor({
  name: "oura",
  maxAttempts: 1,
  profile: unauditedConservativePacingProfile(),
});

interface OuraSleepSession {
  average_heart_rate?: number | null;
  average_hrv?: number | null;
  bedtime_end?: string | null;
  bedtime_start?: string | null;
  day: string;
  deep_sleep_duration?: number | null;
  efficiency?: number | null;
  id: string;
  latency?: number | null;
  light_sleep_duration?: number | null;
  lowest_heart_rate?: number | null;
  readiness?: { score?: number | null } | null;
  rem_sleep_duration?: number | null;
  temperature_delta?: number | null;
  total_sleep_duration?: number | null;
}

interface OuraReadiness {
  contributors?: Record<string, unknown>;
  day: string;
  id: string;
  score?: number | null;
  temperature_deviation?: number | null;
  temperature_trend_deviation?: number | null;
}

interface OuraActivity {
  active_calories?: number | null;
  day: string;
  equivalent_walking_distance?: number | null;
  id: string;
  score?: number | null;
  steps?: number | null;
  target_calories?: number | null;
  total_calories?: number | null;
}

type OuraRow = OuraSleepSession | OuraReadiness | OuraActivity;

interface OuraListResponse<T> {
  data: T[];
  next_token?: string | null;
}

interface OuraParams {
  end_date?: string;
  next_token?: string;
  start_date?: string;
}

interface OuraRawResponse {
  body: string;
  retryAfter?: string;
  status: number;
}

async function oura<T>(endpoint: string, token: string, params: OuraParams): Promise<OuraListResponse<T>> {
  const url = new URL(`${API}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) {
      url.searchParams.set(k, v);
    }
  }
  // The governor honors Retry-After and retries 429/5xx inline through ONE
  // pre-flight send governor; terminal 429 exhaustion throws `oura_rate_limited`
  // (the runtime `retryablePattern` cross-run contract). The body is read once
  // per attempt (each attempt is a fresh fetch / fresh Response stream).
  const result = await httpGovernor.request<OuraRawResponse, OuraRawResponse>(
    async (): Promise<OuraRawResponse> => {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      const retryAfter = res.headers.get("retry-after");
      return {
        body: await res.text(),
        ...(retryAfter == null ? {} : { retryAfter }),
        status: res.status,
      };
    },
    (raw) => ({
      status: raw.status,
      headers: { "retry-after": raw.retryAfter },
      value: raw,
    })
  );
  const raw = result.value;
  if (raw.status === 401) {
    throw new Error("oura_auth_failed");
  }
  if (raw.status < 200 || raw.status >= 300) {
    throw new Error(`oura_http_${String(raw.status)}: ${raw.body.slice(0, 200)}`);
  }
  return JSON.parse(raw.body) as OuraListResponse<T>;
}

async function fetchAll<T>(endpoint: string, token: string, startDate: string | null): Promise<T[]> {
  const all: T[] = [];
  let nextToken: string | undefined;
  let guard = MAX_PAGES;
  while (guard-- > 0) {
    const params: OuraParams = {};
    if (startDate) {
      params.start_date = startDate;
    }
    if (nextToken) {
      params.next_token = nextToken;
    }
    const json = await oura<T>(endpoint, token, params);
    if (Array.isArray(json.data)) {
      all.push(...json.data);
    }
    nextToken = json.next_token || undefined;
    if (!nextToken) {
      break;
    }
  }
  return all;
}

function sleepRecord(s: OuraSleepSession): RecordData {
  return {
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
  };
}

function readinessRecord(r: OuraReadiness): RecordData {
  return {
    id: r.id,
    day: r.day,
    score: r.score ?? null,
    temperature_deviation: r.temperature_deviation ?? null,
    temperature_trend_deviation: r.temperature_trend_deviation ?? null,
    contributors: r.contributors ?? {},
  };
}

function activityRecord(a: OuraActivity): RecordData {
  return {
    id: a.id,
    day: a.day,
    score: a.score ?? null,
    active_calories: a.active_calories ?? null,
    total_calories: a.total_calories ?? null,
    steps: a.steps ?? null,
    target_calories: a.target_calories ?? null,
    equivalent_walking_distance: a.equivalent_walking_distance ?? null,
  };
}

interface StreamConfig<T extends OuraRow> {
  endpoint: string;
  streamName: string;
  toRecord: (row: T) => RecordData;
}

interface RunStreamArgs<T extends OuraRow> {
  config: StreamConfig<T>;
  emit: (msg: { type: "STATE"; stream: string; cursor: unknown }) => Promise<void>;
  emitRecord: (stream: string, data: RecordData) => Promise<void>;
  progress: (message: string, extra?: { stream?: string }) => Promise<void>;
  requested: Map<string, { time_range?: { since?: string } }>;
  state: Record<string, unknown>;
  token: string;
}

function sinceFor(
  state: Record<string, unknown>,
  requested: Map<string, { time_range?: { since?: string } }>,
  stream: string
): string | null {
  const streamState = state[stream] as { last_day?: string } | undefined;
  const priorDay = streamState?.last_day;
  const scopeReq = requested.get(stream);
  const scopeSince = scopeReq?.time_range?.since?.slice(0, 10);
  return priorDay || scopeSince || null;
}

async function runStream<T extends OuraRow>(args: RunStreamArgs<T>): Promise<void> {
  const { config, token, state, requested, emit, emitRecord, progress } = args;
  const { streamName, endpoint, toRecord } = config;
  await progress(`Fetching ${streamName}`, { stream: streamName });
  const startDate = sinceFor(state, requested, streamName);
  const rows = await fetchAll<T>(endpoint, token, startDate);
  const streamState = state[streamName] as { last_day?: string } | undefined;
  let lastDay: string | null = streamState?.last_day || null;
  for (const row of rows) {
    await emitRecord(streamName, toRecord(row));
    if (row.day && (!lastDay || row.day > lastDay)) {
      lastDay = row.day;
    }
  }
  await emit({
    type: "STATE",
    stream: streamName,
    cursor: { last_day: lastDay },
  });
}

runConnector({
  name: "oura",
  validateRecord,
  retryablePattern: /rate_limited|ECONN|fetch failed/i,
  auth: { kind: "env", required: ["OURA_PERSONAL_ACCESS_TOKEN"] },
  async collect({ state, requested, credentials, emit, emitRecord, progress }) {
    const token = credentials.OURA_PERSONAL_ACCESS_TOKEN;
    if (!token) {
      throw new Error("oura_auth_failed");
    }

    if (requested.has("sleep")) {
      await runStream<OuraSleepSession>({
        config: {
          streamName: "sleep",
          endpoint: "sleep",
          toRecord: sleepRecord,
        },
        token,
        state,
        requested,
        emit,
        emitRecord,
        progress,
      });
    }

    if (requested.has("readiness")) {
      await runStream<OuraReadiness>({
        config: {
          streamName: "readiness",
          endpoint: "daily_readiness",
          toRecord: readinessRecord,
        },
        token,
        state,
        requested,
        emit,
        emitRecord,
        progress,
      });
    }

    if (requested.has("activity")) {
      await runStream<OuraActivity>({
        config: {
          streamName: "activity",
          endpoint: "daily_activity",
          toRecord: activityRecord,
        },
        token,
        state,
        requested,
        emit,
        emitRecord,
        progress,
      });
    }
  },
});
