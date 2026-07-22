// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Shared types for the Apple Health connector. Kept out of index.ts so the
// pure parsers in parsers.ts can import them without pulling in the
// runtime entry point or the streaming XML reader.

export type AppleHealthAttrs = Record<string, string | undefined>;

export interface AppleHealthState {
  last_start_date?: string;
}

export interface StreamParseArgs {
  onProgress: (recordCount: number, workoutCount: number) => Promise<void>;
  onRecord: (attrs: AppleHealthAttrs) => Promise<void>;
  onWorkout: (attrs: AppleHealthAttrs) => Promise<void>;
  path: string;
}

/** Shape emitted on the `records` stream. */
export interface HealthRecordOut {
  end_date: string | null;
  id: string;
  source_name: string | null;
  source_version: string | null;
  start_date: string;
  type: string;
  unit: string | null;
  value: number | null;
  value_raw: string | null;
}

/** Shape emitted on the `workouts` stream. */
export interface WorkoutRecordOut {
  duration_minutes: number | null;
  end_date: string | null;
  id: string;
  source_name: string | null;
  start_date: string;
  total_distance_km: number | null;
  total_energy_burned_kcal: number | null;
  workout_activity_type: string | null;
}
