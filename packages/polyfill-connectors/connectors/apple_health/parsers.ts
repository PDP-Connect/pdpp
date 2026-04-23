// Pure parsers for the Apple Health connector. Kept free of Node I/O so
// they can be unit-tested in isolation (see parsers.test.ts). The
// streaming XML reader and record emitter live in index.ts.

import { createHash } from "node:crypto";
import type { AppleHealthAttrs, HealthRecordOut, WorkoutRecordOut } from "./types.ts";

// ─── Module-scoped regexes (Biome useTopLevelRegex) ────────────────────

export const APPLE_HEALTH_TAG_RE = /<(Record|Workout)\s+([^/>]+)\/?>/g;
const APPLE_HEALTH_ATTR_RE = /(\w+)="([^"]*)"/g;
const APPLE_HEALTH_TYPE_PREFIX_RE = /^HKQuantityTypeIdentifier|^HKCategoryTypeIdentifier|^HKDataType/;
const APPLE_HEALTH_WORKOUT_PREFIX_RE = /^HKWorkoutActivityType/;

// Record ID length (hex). 24 chars = 96 bits of entropy — safe for a user's
// personal health-event set.
const RECORD_ID_HASH_LENGTH = 24;

// ─── Small pure helpers ────────────────────────────────────────────────

export function hashId(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, RECORD_ID_HASH_LENGTH);
}

export function parseAttrs(tag: string): AppleHealthAttrs {
  const attrs: AppleHealthAttrs = {};
  const re = new RegExp(APPLE_HEALTH_ATTR_RE.source, "g");
  let m: RegExpExecArray | null = re.exec(tag);
  while (m !== null) {
    const key = m[1];
    if (key) {
      attrs[key] = m[2];
    }
    m = re.exec(tag);
  }
  return attrs;
}

export function healthTypeShort(t: string | undefined): string | null {
  if (!t) {
    return null;
  }
  return t.replace(APPLE_HEALTH_TYPE_PREFIX_RE, "");
}

export function isoDate(v: string | undefined): string | null {
  if (!v) {
    return null;
  }
  // Apple Health dates look like "2024-06-05 13:45:22 -0700"
  const d = new Date(v);
  if (!Number.isNaN(d.getTime())) {
    return d.toISOString();
  }
  return null;
}

// ─── Record / workout builders ─────────────────────────────────────────

/**
 * Build a single `records`-stream record from a parsed HKRecord element.
 * Returns null when startDate is missing or unparseable; index.ts treats
 * that as "skip silently" since Apple Health emits some records without
 * a usable timestamp (e.g. metadata rows).
 */
export function buildHealthRecord(attrs: AppleHealthAttrs): HealthRecordOut | null {
  const startDate = isoDate(attrs.startDate);
  if (!startDate) {
    return null;
  }
  const type = healthTypeShort(attrs.type) || attrs.type || "Unknown";
  const value = attrs.value == null ? null : Number(attrs.value);
  const finite = value != null && Number.isFinite(value);
  const id = hashId(`${type}|${attrs.sourceName || ""}|${startDate}|${attrs.value || ""}`);
  return {
    id,
    type,
    source_name: attrs.sourceName || null,
    source_version: attrs.sourceVersion || null,
    unit: attrs.unit || null,
    value: finite && value != null ? value : null,
    value_raw: !finite && attrs.value ? attrs.value : null,
    start_date: startDate,
    end_date: isoDate(attrs.endDate),
  };
}

/**
 * Build a single `workouts`-stream record from a parsed HKWorkout element.
 * Returns null when startDate is missing or unparseable.
 */
export function buildWorkoutRecord(attrs: AppleHealthAttrs): WorkoutRecordOut | null {
  const startDate = isoDate(attrs.startDate);
  if (!startDate) {
    return null;
  }
  const id = hashId(`${attrs.workoutActivityType || ""}|${attrs.sourceName || ""}|${startDate}`);
  return {
    id,
    workout_activity_type: attrs.workoutActivityType
      ? attrs.workoutActivityType.replace(APPLE_HEALTH_WORKOUT_PREFIX_RE, "")
      : null,
    duration_minutes: attrs.duration ? Number(attrs.duration) : null,
    total_energy_burned_kcal: attrs.totalEnergyBurned ? Number(attrs.totalEnergyBurned) : null,
    total_distance_km: attrs.totalDistance ? Number(attrs.totalDistance) : null,
    source_name: attrs.sourceName || null,
    start_date: startDate,
    end_date: isoDate(attrs.endDate),
  };
}

// ─── Cursor / watermark helpers ────────────────────────────────────────

/**
 * Return true if `startDate` falls on or before the incremental cursor
 * `since`. index.ts uses this to skip already-emitted records.
 */
export function isBeforeCursor(startDate: string, since: string | undefined): boolean {
  return Boolean(since && startDate <= since);
}

/** Monotonic max of an existing cursor and a new ISO date string. */
export function advanceCursor(prev: string | undefined, next: string): string {
  if (!prev || next > prev) {
    return next;
  }
  return prev;
}
