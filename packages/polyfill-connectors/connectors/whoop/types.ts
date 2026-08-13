// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

export interface WhoopFetchResult {
  invalidJson?: boolean;
  json: unknown;
  status: number;
}

export interface WhoopCycle {
  day_avg_heart_rate?: number | null | undefined;
  day_kilojoules?: number | null | undefined;
  day_max_heart_rate?: number | null | undefined;
  days?: string | null | undefined;
  id: number;
  scaled_strain?: number | null | undefined;
}

export interface WhoopRecovery {
  created_at: string;
  hrv_rmssd: number;
  recovery_score: number;
  resting_heart_rate?: number | null | undefined;
  skin_temp_celsius?: number | null | undefined;
  spo2?: number | null | undefined;
}

export interface WhoopSleep {
  activity_id: string;
  during: string;
  light_sleep_duration: number;
  rem_sleep_duration: number;
  respiratory_rate?: number | null | undefined;
  score?: number | undefined;
  slow_wave_sleep_duration: number;
  time_in_bed: number;
  wake_duration: number;
}

export interface WhoopWorkout {
  activity_id?: string | null | undefined;
  average_heart_rate?: number | null | undefined;
  during?: string | null | undefined;
  kilojoules?: number | null | undefined;
  max_heart_rate?: number | null | undefined;
  sport_id?: number | null | undefined;
  timezone_offset?: string | null | undefined;
}

export interface WhoopCycleRecord {
  cycle: WhoopCycle;
  recovery?: WhoopRecovery | null | undefined;
  sleeps: WhoopSleep[];
  workouts?: WhoopWorkout[] | undefined;
}

export interface WhoopProfileSource {
  birthday?: string | null | undefined;
  created_at?: string | undefined;
  fitness_level?: string | null | undefined;
  gender: string | null;
  height: number | null;
  timezone_offset: string;
  unit_system: string;
  updated_at?: string | undefined;
  user_id: number;
  weight: number | null;
}

export interface WhoopAccountSource {
  created_at?: string | undefined;
  email: string;
  id: number;
  type: string;
  user_id: number;
  username: string;
}

export interface WhoopUserSource {
  city?: string | null | undefined;
  country?: string | null | undefined;
  first_name: string;
  id: number;
  last_name: string;
}

export interface WhoopBioDataSource {
  max_heart_rate: number;
  min_heart_rate?: number | null | undefined;
  resting_heart_rate: number;
}

export interface WhoopBootstrap {
  account: WhoopAccountSource;
  bio_data?: WhoopBioDataSource | null | undefined;
  membership: { in_effect: boolean; status: string };
  profile?: WhoopProfileSource | null | undefined;
  user: WhoopUserSource;
}
