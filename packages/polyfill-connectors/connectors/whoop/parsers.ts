// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { RecordData } from "../../src/connector-runtime.ts";
import { bootstrapResponseSchema, cyclesResponseSchema } from "./schemas.ts";
import type { WhoopBootstrap, WhoopCycleRecord } from "./types.ts";

const RANGE_RE = /^\['([^']+)','([^']+)'\)$/;

export function parseCyclesResponse(value: unknown): WhoopCycleRecord[] {
  return cyclesResponseSchema.parse(value);
}

export function parseBootstrapResponse(value: unknown): WhoopBootstrap {
  return bootstrapResponseSchema.parse(value);
}

export function rangeStart(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  return RANGE_RE.exec(value)?.[1] ?? null;
}

export function rangeEnd(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  return RANGE_RE.exec(value)?.[2] ?? null;
}

export function profileRecord(source: WhoopBootstrap): RecordData {
  return {
    id: String(source.user.id),
    user_id: source.user.id,
    username: source.account.username,
    email: source.account.email,
    account_type: source.account.type,
    first_name: source.user.first_name,
    last_name: source.user.last_name,
    country: source.user.country ?? null,
    city: source.user.city ?? null,
    gender: source.profile?.gender ?? null,
    unit_system: source.profile?.unit_system ?? null,
    fitness_level: source.profile?.fitness_level ?? null,
    birthday: source.profile?.birthday ?? null,
    timezone_offset: source.profile?.timezone_offset ?? null,
    membership_status: source.membership.status,
    membership_in_effect: source.membership.in_effect,
    observed_at: source.profile?.updated_at ?? source.account.created_at ?? null,
  };
}

export function bodyRecord(source: WhoopBootstrap): RecordData {
  return {
    id: String(source.user.id),
    user_id: source.user.id,
    height_m: source.profile?.height ?? null,
    weight_kg: source.profile?.weight ?? null,
    max_heart_rate: source.bio_data?.max_heart_rate ?? null,
    min_heart_rate: source.bio_data?.min_heart_rate ?? null,
    resting_heart_rate: source.bio_data?.resting_heart_rate ?? null,
    observed_at: source.profile?.updated_at ?? null,
  };
}

export function cycleRecord(source: WhoopCycleRecord): RecordData {
  return {
    id: String(source.cycle.id),
    cycle_id: source.cycle.id,
    days: source.cycle.days ?? null,
    start_date: rangeStart(source.cycle.days),
    end_date: rangeEnd(source.cycle.days),
    scaled_strain: source.cycle.scaled_strain ?? null,
    day_kilojoules: source.cycle.day_kilojoules ?? null,
    day_avg_heart_rate: source.cycle.day_avg_heart_rate ?? null,
    day_max_heart_rate: source.cycle.day_max_heart_rate ?? null,
  };
}

export function recoveryRecord(source: WhoopCycleRecord): RecordData | null {
  if (!source.recovery) {
    return null;
  }
  return {
    id: String(source.cycle.id),
    cycle_id: source.cycle.id,
    created_at: source.recovery.created_at,
    hrv_rmssd: source.recovery.hrv_rmssd,
    recovery_score: source.recovery.recovery_score,
    resting_heart_rate: source.recovery.resting_heart_rate ?? null,
    spo2: source.recovery.spo2 ?? null,
    skin_temp_celsius: source.recovery.skin_temp_celsius ?? null,
  };
}

export function sleepRecords(source: WhoopCycleRecord): RecordData[] {
  return source.sleeps.map((sleep) => ({
    id: sleep.activity_id,
    cycle_id: source.cycle.id,
    during: sleep.during,
    start_at: rangeStart(sleep.during),
    end_at: rangeEnd(sleep.during),
    time_in_bed: sleep.time_in_bed,
    light_sleep_duration: sleep.light_sleep_duration,
    slow_wave_sleep_duration: sleep.slow_wave_sleep_duration,
    rem_sleep_duration: sleep.rem_sleep_duration,
    wake_duration: sleep.wake_duration,
    respiratory_rate: sleep.respiratory_rate ?? null,
    score: sleep.score ?? null,
  }));
}

export function workoutRecords(source: WhoopCycleRecord): RecordData[] {
  return (source.workouts ?? []).map((workout) => {
    if (!workout.activity_id) {
      throw new Error(`whoop_schema_drift: workout in cycle ${String(source.cycle.id)} has no activity_id`);
    }
    return {
      id: workout.activity_id,
      cycle_id: source.cycle.id,
      during: workout.during ?? null,
      start_at: rangeStart(workout.during),
      end_at: rangeEnd(workout.during),
      timezone_offset: workout.timezone_offset ?? null,
      sport_id: workout.sport_id ?? null,
      kilojoules: workout.kilojoules ?? null,
      average_heart_rate: workout.average_heart_rate ?? null,
      max_heart_rate: workout.max_heart_rate ?? null,
    };
  });
}
