// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure semantic-time coercion: the single definition of how a raw
 * manifest-declared field value becomes a stored `semantic_time`.
 *
 * This is a LEAF module by design — no DB, no backend imports — because all
 * three ingest paths need it and none of them may depend on another's storage:
 * the SQLite manifest resolver (record-ingest-semantic-time.ts), the SQLite
 * ingest path (records.ts), and the Postgres ingest path (postgres-records.ts).
 * Those three previously carried three verbatim copies of this logic, which is
 * how the sentinel handling below could have been fixed in one backend and
 * silently missed in the others.
 *
 * ## What `semantic_time` means
 *
 * It answers exactly one question: where does this record belong on the
 * OWNER'S personal timeline? It is not "the most recent date in the payload".
 * Two consequences shape everything here:
 *
 *   - When a record corresponds to no moment in the owner's life, the answer is
 *     ABSENT (SEMANTIC_TIME_UNKNOWN). Absence is a complete, correct answer.
 *   - Ingest time is never the answer. Substituting it turns "unknown" into a
 *     confident wrong claim that no downstream reader can falsify.
 */

// Below this, a numeric timestamp is treated as Unix SECONDS; at or above it,
// as Unix MILLISECONDS. 1e12 seconds is the year 33658 and 1e12 ms is 2001 —
// any real record date is unambiguous against this boundary. Mirrors the
// constant in packages/operator-ui/src/lib/search-record-timestamps.ts so
// ingest and search coerce timestamps identically.
export const SEMANTIC_TIME_EPOCH_MS_THRESHOLD = 1e12;

/**
 * The stored `semantic_time` for a record whose semantic date is UNKNOWN.
 *
 * Empty string, not the ingest timestamp. `records.semantic_time` is
 * `NOT NULL DEFAULT ''` and every ordering index reads it through
 * `COALESCE(NULLIF(semantic_time, ''), emitted_at)`, so the empty string is
 * already this schema's encoding of "absent" — writing it needs no migration
 * and leaves the merged-timeline sort degrading to ingest order exactly as
 * before.
 *
 * What changes is honesty. Stamping `emitted_at` into `semantic_time` records
 * "I do not know when this happened" as "it happened at ingest", which is
 * strictly worse than recording nothing: the two are indistinguishable
 * downstream, so a reader cannot tell a real timestamp from a manufactured one,
 * and a null-rate check reports 0% nulls on a column that is partly fabricated.
 */
export const SEMANTIC_TIME_UNKNOWN = "";

/**
 * Zero-shaped date strings providers send to mean "no date", which parse into a
 * real-looking instant. Matched case-insensitively after trimming, prefix-wise,
 * so `0000-00-00`, `0000-00-00T00:00:00Z`, and `0001-01-01T00:00:00` all fall
 * out. Compared as a prefix rather than by parsing because these are precisely
 * the strings a date parser mishandles.
 */
const SENTINEL_DATE_PREFIXES = ["0000-", "0001-01-01"];

/**
 * How close to the Unix epoch a timestamp must be to read as a sentinel rather
 * than a date. 24h absorbs a `0` that a provider or an upstream layer already
 * shifted by a timezone offset; nothing in a personal timeline legitimately
 * lands on 1970-01-01.
 */
const EPOCH_SENTINEL_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Matches a string that is wholly a number, so "0" can be read as the sentinel 0 is. */
const NUMERIC_STRING_PATTERN = /^[+-]?\d+(\.\d+)?$/;

/**
 * True for a coerced instant that is a "no value" sentinel wearing a date's
 * clothes. Providers signal absence with 0 (Steam's `rtime_last_played` for a
 * game the owner never played) far more often than with null, and 0 becomes
 * 1970-01-01 — worse than absence, because it looks like evidence and sorts to
 * the beginning of the owner's timeline. Connector-agnostic: an epoch-adjacent
 * personal-timeline date is a sentinel no matter which provider sent it.
 */
function isEpochSentinel(ms: number): boolean {
  return Math.abs(ms) <= EPOCH_SENTINEL_WINDOW_MS;
}

/**
 * Coerce a manifest-declared timestamp field value to a clean ISO-8601 string,
 * matching coerceTimestampValue in search-record-timestamps.ts: an ISO string
 * passes through (trimmed); a positive finite NUMBER is a Unix epoch (seconds
 * below the threshold, ms at/above) -> ISO.
 *
 * Returns null for anything that is not a real date, INCLUDING the sentinels a
 * provider uses to mean "no date" (see isEpochSentinel / SENTINEL_DATE_PREFIXES).
 * The caller then stores SEMANTIC_TIME_UNKNOWN.
 */
export function coerceSemanticTimeValue(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return null;
    }
    const lowered = trimmed.toLowerCase();
    if (SENTINEL_DATE_PREFIXES.some((prefix) => lowered.startsWith(prefix))) {
      return null;
    }
    // A numeric string is the same epoch sentinel as the number would be; a
    // provider that JSON-encodes `rtime_last_played` as "0" means what 0 means.
    if (NUMERIC_STRING_PATTERN.test(trimmed)) {
      return coerceSemanticTimeValue(Number(trimmed));
    }
    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) || !isEpochSentinel(parsed) ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const ms = value >= SEMANTIC_TIME_EPOCH_MS_THRESHOLD ? value : value * 1000;
    if (isEpochSentinel(ms)) {
      return null;
    }
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

/**
 * First field in `fields` whose value in `data` coerces to a real semantic date,
 * or null when none does. Field order encodes preference: the caller passes
 * consent_time_field (the declared authored time) before cursor_field.
 */
export function firstSemanticTimeValue(data: Record<string, unknown>, fields: readonly unknown[]): string | null {
  for (const field of fields) {
    if (typeof field !== "string" || field === "") {
      continue;
    }
    const coerced = coerceSemanticTimeValue(data[field]);
    if (coerced) {
      return coerced;
    }
  }
  return null;
}
