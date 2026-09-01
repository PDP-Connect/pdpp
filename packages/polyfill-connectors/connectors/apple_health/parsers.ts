// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure parsers for the Apple Health connector. Kept free of Node I/O so
// they can be unit-tested in isolation (see parsers.test.ts). The
// streaming XML reader and record emitter live in index.ts.

import { createHash } from "node:crypto";
import type {
  AppleHealthAttrs,
  AppleHealthElement,
  AppleHealthGapCounts,
  AppleHealthWorkoutEvent,
  HealthRecordOut,
  WorkoutRecordOut,
} from "./types.ts";

// ─── Module-scoped regexes (Biome useTopLevelRegex) ────────────────────

// Matches the opening tag of any element the streaming scanner in index.ts
// tracks: the two top-level record kinds (Record, Workout), their nested
// children (MetadataEntry, WorkoutEvent, WorkoutStatistics), and the two
// top-level close tags needed to know when a Record/Workout span ends.
// Longest-name-first ordering matters: regex alternation is first-match, not
// longest-match, so "Workout" would otherwise shadow "WorkoutStatistics"/
// "WorkoutEvent" and fail the tag (no immediate whitespace/`>` after the
// "Workout" prefix), silently losing those elements.
//
// The attribute-span group matches only well-formed `key="value"` pairs
// (`(?:\s+\w+="[^"]*")*`), NOT "any char but / or >". A prior version used
// `[^/>]*`, which excludes literal `/` from attribute VALUES — but Apple
// Health's own units routinely contain `/` (`count/min` for heart rate,
// `mL/min·kg` for VO2max), so that version silently failed to match, and
// silently dropped, every Record carrying such a unit. Matching only real
// attribute syntax makes the tag boundary depend on quote structure, not on
// which characters happen to appear inside a quoted value.
export const APPLE_HEALTH_TAG_RE =
  /<(WorkoutStatistics|WorkoutEvent|MetadataEntry|Workout|Record)((?:\s+[\w:-]+="[^"]*")*)\s*(\/?)>|<\/(Record|Workout)>/g;
const APPLE_HEALTH_ATTR_RE = /([\w:-]+)="([^"]*)"/g;
const APPLE_HEALTH_TYPE_PREFIX_RE = /^HKQuantityTypeIdentifier|^HKCategoryTypeIdentifier|^HKDataType/;
const APPLE_HEALTH_KNOWN_TYPE_RE =
  /^HKQuantityTypeIdentifier|^HKCategoryTypeIdentifier|^HKDataType|^HKCorrelationTypeIdentifier/;
const APPLE_HEALTH_WORKOUT_PREFIX_RE = /^HKWorkoutActivityType/;
const APPLE_HEALTH_WORKOUT_EVENT_PREFIX_RE = /^HKWorkoutEventType/;

// Bound nested-child accumulation per element so one pathological export
// (e.g. thousands of MetadataEntry on a single Workout) cannot balloon
// memory — the streaming design must survive a 500MB export.
const MAX_TRACKED_CHILDREN_PER_ELEMENT = 500;

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
    const [, key] = m;
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

// ─── Metadata / nested-child helpers ────────────────────────────────────

/** Build a `{key: value}` map from accumulated MetadataEntry children, bounded and null when empty. */
function buildMetadataMap(entries: readonly { key: string; value: string }[]): Record<string, string> | null {
  if (entries.length === 0) {
    return null;
  }
  const capped = entries.slice(0, MAX_TRACKED_CHILDREN_PER_ELEMENT);
  const out: Record<string, string> = {};
  for (const e of capped) {
    out[e.key] = e.value;
  }
  return out;
}

/** Build a WorkoutEvent record from its raw attrs (type, date, optional duration/durationUnit). */
export function buildWorkoutEvent(attrs: AppleHealthAttrs): AppleHealthWorkoutEvent {
  return {
    type: attrs.type ? attrs.type.replace(APPLE_HEALTH_WORKOUT_EVENT_PREFIX_RE, "") : null,
    date: isoDate(attrs.date),
    duration_minutes: attrs.duration ? Number(attrs.duration) : null,
  };
}

/**
 * Record a Record element's `type` in the gap tally when it does not match
 * any known HK*TypeIdentifier prefix. Apple Health's export format is
 * undocumented and has shifted across iOS versions (see
 * ai/research/apple-health-export-format/), so a new/unrecognized type
 * prefix is expected eventually — this project never drops that silently.
 */
export function trackUnrecognizedType(type: string | undefined, gaps: AppleHealthGapCounts): void {
  if (!type || APPLE_HEALTH_KNOWN_TYPE_RE.test(type)) {
    return;
  }
  gaps.unrecognizedRecordTypes.set(type, (gaps.unrecognizedRecordTypes.get(type) ?? 0) + 1);
}

export function newGapCounts(): AppleHealthGapCounts {
  return {
    unrecognizedRecordTypes: new Map(),
    recordsMissingStartDate: 0,
    workoutsMissingStartDate: 0,
  };
}

// ─── Record / workout builders ─────────────────────────────────────────

/**
 * Build a single `records`-stream record from a parsed HKRecord element
 * (attrs + any nested MetadataEntry children). Returns null when startDate
 * is missing or unparseable; index.ts counts that in `gaps` rather than
 * dropping it silently, since Apple Health emits some records without a
 * usable timestamp (e.g. metadata rows).
 */
export function buildHealthRecord(el: AppleHealthElement, gaps: AppleHealthGapCounts): HealthRecordOut | null {
  const { attrs } = el;
  trackUnrecognizedType(attrs.type, gaps);
  const startDate = isoDate(attrs.startDate);
  if (!startDate) {
    gaps.recordsMissingStartDate += 1;
    return null;
  }
  const type = healthTypeShort(attrs.type) || attrs.type || "Unknown";
  const value = attrs.value === undefined ? null : Number(attrs.value);
  const finite = value !== null && Number.isFinite(value);
  const id = hashId(`${type}|${attrs.sourceName || ""}|${startDate}|${attrs.value || ""}`);
  return {
    id,
    type,
    source_name: attrs.sourceName || null,
    source_version: attrs.sourceVersion || null,
    device: attrs.device || null,
    unit: attrs.unit || null,
    value: finite && value !== null ? value : null,
    value_raw: !finite && attrs.value ? attrs.value : null,
    start_date: startDate,
    end_date: isoDate(attrs.endDate),
    creation_date: isoDate(attrs.creationDate),
    metadata: buildMetadataMap(el.metadata),
  };
}

/**
 * Build a single `workouts`-stream record from a parsed HKWorkout element
 * (attrs + nested MetadataEntry/WorkoutEvent/WorkoutStatistics children).
 * Returns null when startDate is missing or unparseable.
 */
export function buildWorkoutRecord(el: AppleHealthElement, gaps: AppleHealthGapCounts): WorkoutRecordOut | null {
  const { attrs } = el;
  const startDate = isoDate(attrs.startDate);
  if (!startDate) {
    gaps.workoutsMissingStartDate += 1;
    return null;
  }
  const id = hashId(`${attrs.workoutActivityType || ""}|${attrs.sourceName || ""}|${startDate}`);
  return {
    id,
    workout_activity_type: attrs.workoutActivityType
      ? attrs.workoutActivityType.replace(APPLE_HEALTH_WORKOUT_PREFIX_RE, "")
      : null,
    source_version: attrs.sourceVersion || null,
    device: attrs.device || null,
    metadata: buildMetadataMap(el.metadata),
    events: el.workoutEvents.length > 0 ? el.workoutEvents.slice(0, MAX_TRACKED_CHILDREN_PER_ELEMENT) : null,
    statistics:
      el.workoutStatistics.length > 0 ? el.workoutStatistics.slice(0, MAX_TRACKED_CHILDREN_PER_ELEMENT) : null,
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
