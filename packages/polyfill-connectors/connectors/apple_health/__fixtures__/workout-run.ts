// Synthetic HKWorkout attrs for parsers.test.ts.

import type { AppleHealthAttrs } from "../types.ts";

export const RUN_WORKOUT: AppleHealthAttrs = {
  workoutActivityType: "HKWorkoutActivityTypeRunning",
  duration: "32.5",
  durationUnit: "min",
  totalDistance: "5.2",
  totalDistanceUnit: "km",
  totalEnergyBurned: "345",
  totalEnergyBurnedUnit: "kcal",
  sourceName: "Apple Watch",
  sourceVersion: "10.5",
  startDate: "2024-06-05 06:30:00 -0700",
  endDate: "2024-06-05 07:02:30 -0700",
};

/** Minimal workout — only start date + type. */
export const WALK_WORKOUT_MIN: AppleHealthAttrs = {
  workoutActivityType: "HKWorkoutActivityTypeWalking",
  startDate: "2024-06-06 12:00:00 -0700",
};

/** Workout with unparseable start date — should be skipped. */
export const BAD_DATE_WORKOUT: AppleHealthAttrs = {
  workoutActivityType: "HKWorkoutActivityTypeRunning",
  startDate: "not-a-date",
};
