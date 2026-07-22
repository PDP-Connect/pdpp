// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Reference Explore bucket-count operation.
 *
 * Pure operation layer: validates the owner-console request shape, resolves the
 * dense calendar series from backend sparse aggregate rows, and never imports an
 * HTTP framework or storage backend directly.
 */

export const EXPLORE_RECORD_BUCKET_GRANULARITIES = ["hour", "day", "week", "month", "quarter", "year"] as const;

export type ExploreRecordBucketGranularity = (typeof EXPLORE_RECORD_BUCKET_GRANULARITIES)[number];

export interface ExploreRecordBucketsInput {
  readonly connectionIds?: readonly string[] | null;
  readonly streams?: readonly string[] | null;
  readonly excludeConnectionIds?: readonly string[] | null;
  readonly excludeStreams?: readonly string[] | null;
  readonly since?: string | null;
  readonly until?: string | null;
  readonly granularity?: ExploreRecordBucketGranularity | "auto" | string | null;
  readonly timeZone?: string | null;
  readonly now?: string | null;
}

export interface ExploreRecordBucketQueryInput {
  readonly connectionIds?: readonly string[];
  readonly streams?: readonly string[];
  readonly excludeConnectionIds?: readonly string[];
  readonly excludeStreams?: readonly string[];
  readonly since?: string;
  readonly until: string;
  readonly granularity: ExploreRecordBucketGranularity | "auto";
  readonly timeZone: "UTC";
}

export interface ExploreRecordBucketSparseRow {
  readonly bucketStart: string | null;
  readonly count: number;
  readonly extentStart: string | null;
  readonly extentEnd: string | null;
  readonly extentCount: number;
  readonly granularity: ExploreRecordBucketGranularity;
}

export interface ExploreRecordBucketsDependencies {
  fetchBucketRows(input: ExploreRecordBucketQueryInput): readonly ExploreRecordBucketSparseRow[] | Promise<readonly ExploreRecordBucketSparseRow[]>;
}

export interface ExploreRecordBucket {
  readonly start: string;
  readonly end: string;
  readonly count: number;
}

export interface ExploreRecordBucketsOutput {
  readonly object: "explore_record_buckets";
  readonly granularity: ExploreRecordBucketGranularity;
  readonly time_zone: "UTC";
  readonly extent: {
    readonly start: string | null;
    readonly end: string | null;
    readonly count: number;
  };
  readonly buckets: readonly ExploreRecordBucket[];
}

export class InvalidExploreRecordBucketsRequestError extends Error {
  readonly code = "invalid_request";
}

const MAX_DENSE_BUCKETS = 5000;

function normalizeStringList(values: readonly string[] | null | undefined): readonly string[] | undefined {
  if (!values || values.length === 0) return undefined;
  const normalized = Array.from(
    new Set(
      values
        .map((value) => String(value).trim())
        .filter((value) => value.length > 0)
    )
  );
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeGranularity(raw: ExploreRecordBucketsInput["granularity"]): ExploreRecordBucketGranularity | "auto" {
  if (raw == null) return "auto";
  const value = String(raw).trim();
  if (value === "") return "auto";
  if (value === "auto" || EXPLORE_RECORD_BUCKET_GRANULARITIES.includes(value as ExploreRecordBucketGranularity)) {
    return value as ExploreRecordBucketGranularity | "auto";
  }
  throw new InvalidExploreRecordBucketsRequestError(
    `granularity must be one of auto, ${EXPLORE_RECORD_BUCKET_GRANULARITIES.join(", ")}`
  );
}

function normalizeUtcInstant(raw: string | null | undefined, boundary: "start" | "end"): string | undefined {
  if (raw == null || raw === "") return undefined;
  const value = String(raw).trim();
  const candidate = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? `${value}T${boundary === "start" ? "00:00:00.000" : "23:59:59.999"}Z`
    : value;
  const ms = Date.parse(candidate);
  if (!Number.isFinite(ms)) {
    throw new InvalidExploreRecordBucketsRequestError(`${boundary === "start" ? "since" : "until"} must be a date or date-time`);
  }
  return new Date(ms).toISOString();
}

function normalizeNow(raw: string | null | undefined): string {
  if (raw == null || raw === "") return new Date().toISOString();
  const ms = Date.parse(String(raw));
  if (!Number.isFinite(ms)) throw new InvalidExploreRecordBucketsRequestError("now must be a date-time");
  return new Date(ms).toISOString();
}

function floorUtc(date: Date, granularity: ExploreRecordBucketGranularity): Date {
  const d = new Date(date.getTime());
  d.setUTCMinutes(0, 0, 0);
  if (granularity === "hour") return d;
  d.setUTCHours(0, 0, 0, 0);
  if (granularity === "day") return d;
  if (granularity === "week") {
    const day = d.getUTCDay();
    const diff = (day + 6) % 7;
    d.setUTCDate(d.getUTCDate() - diff);
    return d;
  }
  d.setUTCDate(1);
  if (granularity === "month") return d;
  if (granularity === "quarter") {
    d.setUTCMonth(Math.floor(d.getUTCMonth() / 3) * 3, 1);
    return d;
  }
  d.setUTCMonth(0, 1);
  return d;
}

function addUtc(date: Date, granularity: ExploreRecordBucketGranularity): Date {
  const d = new Date(date.getTime());
  if (granularity === "hour") d.setUTCHours(d.getUTCHours() + 1);
  else if (granularity === "day") d.setUTCDate(d.getUTCDate() + 1);
  else if (granularity === "week") d.setUTCDate(d.getUTCDate() + 7);
  else if (granularity === "month") d.setUTCMonth(d.getUTCMonth() + 1);
  else if (granularity === "quarter") d.setUTCMonth(d.getUTCMonth() + 3);
  else d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d;
}

function denseBuckets(rows: readonly ExploreRecordBucketSparseRow[], granularity: ExploreRecordBucketGranularity): readonly ExploreRecordBucket[] {
  const first = rows[0];
  if (!first?.extentStart || !first.extentEnd || first.extentCount === 0) return [];

  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.bucketStart) counts.set(new Date(row.bucketStart).toISOString(), Number(row.count ?? 0));
  }

  const start = floorUtc(new Date(first.extentStart), granularity);
  const end = floorUtc(new Date(first.extentEnd), granularity);
  const buckets: ExploreRecordBucket[] = [];
  for (let cursor = start; cursor.getTime() <= end.getTime(); cursor = addUtc(cursor, granularity)) {
    if (buckets.length >= MAX_DENSE_BUCKETS) {
      throw new InvalidExploreRecordBucketsRequestError(`bucket response would exceed ${MAX_DENSE_BUCKETS} buckets`);
    }
    const next = addUtc(cursor, granularity);
    const key = cursor.toISOString();
    buckets.push({ start: key, end: next.toISOString(), count: counts.get(key) ?? 0 });
  }
  return buckets;
}

export async function executeExploreRecordBuckets(
  input: ExploreRecordBucketsInput,
  deps: ExploreRecordBucketsDependencies
): Promise<ExploreRecordBucketsOutput> {
  const timeZone = input.timeZone == null || input.timeZone === "" ? "UTC" : String(input.timeZone).trim();
  if (timeZone !== "UTC") {
    throw new InvalidExploreRecordBucketsRequestError("time_zone must be UTC");
  }

  const since = normalizeUtcInstant(input.since, "start");
  const until = normalizeUtcInstant(input.until, "end") ?? normalizeNow(input.now);
  if (since && Date.parse(since) > Date.parse(until)) {
    throw new InvalidExploreRecordBucketsRequestError("since must be before until");
  }

  const connectionIds = normalizeStringList(input.connectionIds);
  const streams = normalizeStringList(input.streams);
  const excludeConnectionIds = normalizeStringList(input.excludeConnectionIds);
  const excludeStreams = normalizeStringList(input.excludeStreams);
  const queryInput: ExploreRecordBucketQueryInput = {
    ...(connectionIds ? { connectionIds } : {}),
    ...(streams ? { streams } : {}),
    ...(excludeConnectionIds ? { excludeConnectionIds } : {}),
    ...(excludeStreams ? { excludeStreams } : {}),
    ...(since ? { since } : {}),
    until,
    granularity: normalizeGranularity(input.granularity),
    timeZone: "UTC",
  };

  const rows = await deps.fetchBucketRows(queryInput);
  const first = rows[0];
  const granularity = first?.granularity ?? (queryInput.granularity === "auto" ? "day" : queryInput.granularity);

  return {
    object: "explore_record_buckets",
    granularity,
    time_zone: "UTC",
    extent: {
      start: first?.extentStart ?? null,
      end: first?.extentEnd ?? null,
      count: Number(first?.extentCount ?? 0),
    },
    buckets: denseBuckets(rows, granularity),
  };
}
