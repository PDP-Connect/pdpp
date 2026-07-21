// Synthetic HKRecord attrs for a StepCount sample. Extracted from a real
// Apple Health export and trimmed to the fields `buildHealthRecord`
// consumes, so parsers.test.ts can table-drive record shape checks
// without shipping megabytes of XML.

import type { AppleHealthAttrs } from "../types.ts";

export const STEP_COUNT_RECORD: AppleHealthAttrs = {
  type: "HKQuantityTypeIdentifierStepCount",
  sourceName: "iPhone",
  sourceVersion: "17.5",
  unit: "count",
  creationDate: "2024-06-05 13:45:22 -0700",
  startDate: "2024-06-05 13:45:22 -0700",
  endDate: "2024-06-05 13:50:10 -0700",
  value: "42",
};

export const HEART_RATE_RECORD: AppleHealthAttrs = {
  type: "HKQuantityTypeIdentifierHeartRate",
  sourceName: "Apple Watch",
  sourceVersion: "10.5",
  unit: "count/min",
  startDate: "2024-06-05 13:45:22 -0700",
  endDate: "2024-06-05 13:45:23 -0700",
  value: "72",
};

export const CATEGORY_RECORD: AppleHealthAttrs = {
  type: "HKCategoryTypeIdentifierSleepAnalysis",
  sourceName: "Apple Watch",
  startDate: "2024-06-05 22:00:00 -0700",
  endDate: "2024-06-06 06:00:00 -0700",
  value: "HKCategoryValueSleepAnalysisAsleepCore",
};

/** A record missing startDate — should be dropped (returns null). */
export const NO_START_DATE_RECORD: AppleHealthAttrs = {
  type: "HKQuantityTypeIdentifierStepCount",
  sourceName: "iPhone",
  value: "10",
};

/** Non-numeric value — should land in value_raw, not value. */
export const NON_NUMERIC_VALUE_RECORD: AppleHealthAttrs = {
  type: "HKCategoryTypeIdentifierSleepAnalysis",
  sourceName: "Apple Watch",
  startDate: "2024-06-05 22:00:00 -0700",
  value: "HKCategoryValueSleepAnalysisAsleepCore",
};
