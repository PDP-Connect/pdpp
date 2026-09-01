// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Shared types for the Apple Health connector. Kept out of index.ts so the
// pure parsers in parsers.ts can import them without pulling in the
// runtime entry point or the streaming XML reader.

export type AppleHealthAttrs = Record<string, string | undefined>;

/** A parsed `<MetadataEntry key="..." value="..."/>` child. */
export interface AppleHealthMetadataEntry {
  key: string;
  value: string;
}

/** A parsed `<WorkoutEvent type="..." date="..." .../>` child. */
export interface AppleHealthWorkoutEvent {
  date: string | null;
  duration_minutes: number | null;
  type: string | null;
}

/** A parsed `<WorkoutStatistics type="..." .../>` child. */
export type AppleHealthWorkoutStatistics = AppleHealthAttrs;

/** A `Record` or `Workout` element together with its nested children, as assembled by the scanner in index.ts. */
export interface AppleHealthElement {
  attrs: AppleHealthAttrs;
  metadata: AppleHealthMetadataEntry[];
  tag: "Record" | "Workout";
  workoutEvents: AppleHealthWorkoutEvent[];
  workoutStatistics: AppleHealthWorkoutStatistics[];
}

export interface AppleHealthState {
  last_start_date?: string;
}

/** Tally of real-format surface the connector saw but could not (or chose not to) turn into an emitted field. Reported honestly, never silently dropped. */
export interface AppleHealthGapCounts {
  /** Record elements dropped for missing/unparseable startDate. */
  recordsMissingStartDate: number;
  /** Record elements whose `type` did not match a known HK*TypeIdentifier prefix. */
  unrecognizedRecordTypes: Map<string, number>;
  /** Workout elements dropped for missing/unparseable startDate. */
  workoutsMissingStartDate: number;
}

export interface StreamParseArgs {
  onProgress: (recordCount: number, workoutCount: number) => Promise<void>;
  onRecord: (el: AppleHealthElement) => Promise<void>;
  onWorkout: (el: AppleHealthElement) => Promise<void>;
  path: string;
}

/** Shape emitted on the `records` stream. */
export interface HealthRecordOut {
  creation_date: string | null;
  device: string | null;
  end_date: string | null;
  id: string;
  metadata: Record<string, string> | null;
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
  device: string | null;
  duration_minutes: number | null;
  end_date: string | null;
  events: AppleHealthWorkoutEvent[] | null;
  id: string;
  metadata: Record<string, string> | null;
  source_name: string | null;
  source_version: string | null;
  start_date: string;
  statistics: AppleHealthWorkoutStatistics[] | null;
  total_distance_km: number | null;
  total_energy_burned_kcal: number | null;
  workout_activity_type: string | null;
}
