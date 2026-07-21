// Pure parsers for the Google Takeout connector. Kept free of runtime I/O
// orchestration so they can be unit-tested in isolation (see parsers.test.ts).
// File-existence checks and the emit loop live in index.ts.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type {
  LocationPoint,
  LocationRecord,
  SearchHistoryEntry,
  SearchRecord,
  WatchHistoryEntry,
  WatchHistoryRecord,
} from "./types.ts";

// E7-scaled geo coords from Google's Android location schema: multiply by 1e-7.
const GOOGLE_E7_DIVISOR = 1e7;
// Length of sha256-derived record IDs — 24 hex chars = 96 bits of entropy.
const RECORD_ID_HASH_LENGTH = 24;

// Module-level regex (Biome useTopLevelRegex).
export const SEARCHED_FOR_PREFIX_RE = /^Searched for /;

export function hashId(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, RECORD_ID_HASH_LENGTH);
}

export async function readJsonIf(path: string): Promise<unknown> {
  if (!existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

/**
 * Resolve a Google location point's absolute timestamp (Unix ms). Google
 * exports use either `timestampMs` (older) or ISO `timestamp` (newer).
 * Returns null when neither is usable.
 */
export function locationTimestampMs(loc: LocationPoint): number | null {
  if (typeof loc.timestampMs === "string") {
    const n = Number.parseInt(loc.timestampMs, 10);
    return Number.isFinite(n) ? n : null;
  }
  if (loc.timestamp) {
    const n = Date.parse(loc.timestamp);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

export function scaleE7(v: number | undefined): number | null {
  return typeof v === "number" ? v / GOOGLE_E7_DIVISOR : null;
}

/**
 * Build a location_history record from a raw LocationPoint at a given ISO
 * timestamp. Caller is responsible for the since-cursor filter.
 */
export function buildLocationRecord(loc: LocationPoint, iso: string): LocationRecord {
  const lat = scaleE7(loc.latitudeE7);
  const lon = scaleE7(loc.longitudeE7);
  return {
    id: hashId(`loc|${iso}|${lat}|${lon}`),
    timestamp: iso,
    latitude: lat,
    longitude: lon,
    accuracy_meters: loc.accuracy ?? null,
    activity_type: loc.activity?.[0]?.activity?.[0]?.type ?? null,
    velocity_mps: loc.velocity ?? null,
    altitude_m: loc.altitude ?? null,
  };
}

/**
 * Build a youtube_watch_history record from a raw WatchHistoryEntry. Returns
 * null if the entry is missing a timestamp.
 */
export function buildWatchHistoryRecord(e: WatchHistoryEntry): WatchHistoryRecord | null {
  const ts = e.time || null;
  if (!ts) {
    return null;
  }
  const videoUrl = e.titleUrl || null;
  const channelUrl = e.subtitles?.[0]?.url || null;
  return {
    id: hashId(`yt|${ts}|${videoUrl || e.title}`),
    watched_at: ts,
    video_url: videoUrl,
    video_title: e.title || null,
    channel_name: e.subtitles?.[0]?.name || null,
    channel_url: channelUrl,
  };
}

/**
 * Build a search_history record from a raw SearchHistoryEntry. Returns null
 * if the entry is missing a timestamp.
 */
export function buildSearchRecord(e: SearchHistoryEntry): SearchRecord | null {
  const ts = e.time || null;
  if (!ts) {
    return null;
  }
  const query = (e.title || "").replace(SEARCHED_FOR_PREFIX_RE, "");
  return {
    id: hashId(`gs|${ts}|${query}`),
    timestamp: ts,
    query,
    product: e.header || null,
  };
}
