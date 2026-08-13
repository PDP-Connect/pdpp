// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import { makeValidateRecord } from "../../src/schema-registry.ts";

const sourceCycleSchema = z.object({
  id: z.number().int(),
  days: z.string().nullish(),
  scaled_strain: z.number().nullish(),
  day_kilojoules: z.number().nonnegative().nullish(),
  day_avg_heart_rate: z.number().int().min(0).max(300).nullish(),
  day_max_heart_rate: z.number().int().min(0).max(300).nullish(),
});

const sourceRecoverySchema = z.object({
  hrv_rmssd: z.number(),
  recovery_score: z.number().min(0).max(100),
  created_at: z.string().datetime(),
  resting_heart_rate: z.number().int().min(0).max(300).nullish(),
  spo2: z.number().min(0).max(100).nullish(),
  skin_temp_celsius: z.number().nullish(),
});

const sourceSleepSchema = z.object({
  activity_id: z.string().uuid(),
  during: z.string().min(1),
  time_in_bed: z.number().nonnegative(),
  light_sleep_duration: z.number().nonnegative(),
  slow_wave_sleep_duration: z.number().nonnegative(),
  rem_sleep_duration: z.number().nonnegative(),
  wake_duration: z.number().nonnegative(),
  respiratory_rate: z.number().positive().nullish(),
  score: z.number().min(0).max(100).optional(),
});

const sourceWorkoutSchema = z.object({
  activity_id: z.string().nullish(),
  during: z.string().nullish(),
  timezone_offset: z.string().nullish(),
  sport_id: z.number().nullish(),
  kilojoules: z.number().nullish(),
  average_heart_rate: z.number().nullish(),
  max_heart_rate: z.number().nullish(),
});

export const cyclesResponseSchema = z
  .union([
    z.array(
      z.object({
        cycle: sourceCycleSchema,
        recovery: sourceRecoverySchema.nullish(),
        sleeps: z.array(sourceSleepSchema),
        workouts: z.array(sourceWorkoutSchema).optional(),
      })
    ),
    z.object({
      records: z.array(
        z.object({
          cycle: sourceCycleSchema,
          recovery: sourceRecoverySchema.nullish(),
          sleeps: z.array(sourceSleepSchema),
          workouts: z.array(sourceWorkoutSchema).optional(),
        })
      ),
    }),
  ])
  .transform((value) => (Array.isArray(value) ? value : value.records));

const profileSourceSchema = z.object({
  user_id: z.number().int(),
  height: z.number().nullable(),
  weight: z.number().nullable(),
  gender: z.string().nullable(),
  unit_system: z.string(),
  birthday: z.string().nullish(),
  timezone_offset: z.string(),
  fitness_level: z.string().nullish(),
  created_at: z.string().datetime().optional(),
  updated_at: z.string().datetime().optional(),
});

export const bootstrapResponseSchema = z.object({
  account: z.object({
    id: z.number().int(),
    username: z.string(),
    email: z.string().email(),
    type: z.string(),
    user_id: z.number().int(),
    created_at: z.string().datetime().optional(),
  }),
  user: z.object({
    id: z.number().int(),
    first_name: z.string(),
    last_name: z.string(),
    country: z.string().nullish(),
    city: z.string().nullish(),
  }),
  profile: profileSourceSchema.nullish(),
  bio_data: z
    .object({
      max_heart_rate: z.number(),
      min_heart_rate: z.number().nullish(),
      resting_heart_rate: z.number(),
    })
    .nullish(),
  membership: z.object({ status: z.string(), in_effect: z.boolean() }),
});

const nullableNumber = z.number().nullable();
const profileRecordSchema = z.object({
  id: z.string().min(1),
  user_id: z.number().int(),
  username: z.string(),
  email: z.string().email(),
  account_type: z.string(),
  first_name: z.string(),
  last_name: z.string(),
  country: z.string().nullable(),
  city: z.string().nullable(),
  gender: z.string().nullable(),
  unit_system: z.string().nullable(),
  fitness_level: z.string().nullable(),
  birthday: z.string().nullable(),
  timezone_offset: z.string().nullable(),
  membership_status: z.string(),
  membership_in_effect: z.boolean(),
  observed_at: z.string().datetime().nullable(),
});
const bodyRecordSchema = z.object({
  id: z.string().min(1),
  user_id: z.number().int(),
  height_m: nullableNumber,
  weight_kg: nullableNumber,
  max_heart_rate: nullableNumber,
  min_heart_rate: nullableNumber,
  resting_heart_rate: nullableNumber,
  observed_at: z.string().datetime().nullable(),
});
const cycleRecordSchema = z.object({
  id: z.string().min(1),
  cycle_id: z.number().int(),
  days: z.string().nullable(),
  start_date: z.string().date().nullable(),
  end_date: z.string().date().nullable(),
  scaled_strain: nullableNumber,
  day_kilojoules: nullableNumber,
  day_avg_heart_rate: nullableNumber,
  day_max_heart_rate: nullableNumber,
});
const recoveryRecordSchema = z.object({
  id: z.string().min(1),
  cycle_id: z.number().int(),
  created_at: z.string().datetime(),
  hrv_rmssd: z.number(),
  recovery_score: z.number(),
  resting_heart_rate: nullableNumber,
  spo2: nullableNumber,
  skin_temp_celsius: nullableNumber,
});
const sleepRecordSchema = z.object({
  id: z.string().uuid(),
  cycle_id: z.number().int(),
  during: z.string().min(1),
  start_at: z.string().datetime().nullable(),
  end_at: z.string().datetime().nullable(),
  time_in_bed: z.number().nonnegative(),
  light_sleep_duration: z.number().nonnegative(),
  slow_wave_sleep_duration: z.number().nonnegative(),
  rem_sleep_duration: z.number().nonnegative(),
  wake_duration: z.number().nonnegative(),
  respiratory_rate: nullableNumber,
  score: nullableNumber,
});
const workoutRecordSchema = z.object({
  id: z.string().min(1),
  cycle_id: z.number().int(),
  during: z.string().nullable(),
  start_at: z.string().datetime().nullable(),
  end_at: z.string().datetime().nullable(),
  timezone_offset: z.string().nullable(),
  sport_id: nullableNumber,
  kilojoules: nullableNumber,
  average_heart_rate: nullableNumber,
  max_heart_rate: nullableNumber,
});

export const SCHEMAS: Record<string, z.ZodTypeAny> = {
  profile: profileRecordSchema,
  body: bodyRecordSchema,
  cycles: cycleRecordSchema,
  recoveries: recoveryRecordSchema,
  sleeps: sleepRecordSchema,
  workouts: workoutRecordSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);
