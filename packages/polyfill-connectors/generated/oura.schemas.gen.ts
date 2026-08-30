// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// ─────────────────────────────────────────────────────────────────────────
// GENERATED FILE — DO NOT EDIT.
//
// Source manifest: manifests/oura.json
// Manifest digest (sha256, first 16 hex chars): bd158201fc5f74d6
// Generator: validator-gen/1 (bin/generate-validators.ts)
//
// Regenerate with:
//   pnpm exec tsx bin/generate-validators.ts oura
//
// If this file is stale relative to the manifest, the digest above will not
// match a fresh hash of manifests/oura.json — regenerate rather than
// hand-editing.
// ─────────────────────────────────────────────────────────────────────────

import { z } from "zod";

export const sleepSchema = z.object({
  id: z.string(),
  day: z.string().describe("format:date"),
  bedtime_start: z.string().nullable().optional(),
  bedtime_end: z.string().nullable().optional(),
  total_sleep_duration: z.number().int().nullable().optional(),
  rem_sleep_duration: z.number().int().nullable().optional(),
  deep_sleep_duration: z.number().int().nullable().optional(),
  light_sleep_duration: z.number().int().nullable().optional(),
  efficiency: z.number().int().nullable().optional(),
  latency: z.number().int().nullable().optional(),
  average_heart_rate: z.number().nullable().optional(),
  lowest_heart_rate: z.number().int().nullable().optional(),
  average_hrv: z.number().nullable().optional(),
  temperature_delta: z.number().nullable().optional(),
  sleep_score: z.number().int().nullable().optional(),
});

export const readinessSchema = z.object({
  id: z.string(),
  day: z.string().describe("format:date"),
  score: z.number().int().nullable().optional(),
  temperature_deviation: z.number().nullable().optional(),
  temperature_trend_deviation: z.number().nullable().optional(),
  contributors: z.record(z.string(), z.unknown()).optional(),
});

export const activitySchema = z.object({
  id: z.string(),
  day: z.string().describe("format:date"),
  score: z.number().int().nullable().optional(),
  active_calories: z.number().int().nullable().optional(),
  total_calories: z.number().int().nullable().optional(),
  steps: z.number().int().nullable().optional(),
  target_calories: z.number().int().nullable().optional(),
  equivalent_walking_distance: z.number().int().nullable().optional(),
});

export const SCHEMAS: Record<string, z.ZodTypeAny> = {
  sleep: sleepSchema,
  readiness: readinessSchema,
  activity: activitySchema,
};
