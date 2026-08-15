// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Runtime guards for additive/legacy schedule projections. The wire type is
 * complete on current references, but old or partially materialized summary
 * rows can omit fields. Callers should use null as unknown, never format an
 * omitted value into NaN or treat an arbitrary truthy active-run value as an
 * href.
 */
export function scheduleIntervalSeconds(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

export function scheduleEnabled(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export function activeScheduleRunId(schedule: { readonly active_run_id?: unknown } | null | undefined): string | null {
  const value = schedule?.active_run_id;
  return typeof value === "string" && value.length > 0 ? value : null;
}
