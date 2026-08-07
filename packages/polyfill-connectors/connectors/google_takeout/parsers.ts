// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure parsers for the Google Takeout connector. Kept free of runtime I/O
// orchestration so they can be unit-tested in isolation (see parsers.test.ts).
// File-existence checks and the emit loop live in index.ts.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type {
  LocationPoint,
  LocationRecord,
  PhotoMetadataFile,
  PhotoRecord,
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

/**
 * Extract event timestamp from Google Takeout photo metadata.
 * Prefers photoTakenTime (EXIF) over creationTime (upload).
 * Returns null if neither is present or valid.
 */
export function photoEventTimeMs(meta: PhotoMetadataFile): number | null {
  let ts: string | undefined;
  if (meta.photoTakenTime?.timestamp) {
    ts = meta.photoTakenTime.timestamp;
  } else if (meta.creationTime?.timestamp) {
    ts = meta.creationTime.timestamp;
  }
  if (!ts) {
    return null;
  }
  const n = Date.parse(ts);
  return Number.isNaN(n) ? null : n;
}

/**
 * Google Takeout duplicates a photo's file + sidecar into every album folder
 * it belongs to (per-copy fields like creationTime/imageViews can differ
 * between copies of the same underlying photo — see connector-primary-
 * reconcile-0807.md §2). Filename + folder is therefore not a safe identity
 * key. Content sha256 is: identical bytes always mean the same underlying
 * asset, and it naturally collapses duplicate album copies to one record.
 */
export function buildPhotoRecord(
  filename: string,
  iso: string,
  contentSha256: string | null,
  metadata?: PhotoMetadataFile | null
): Omit<PhotoRecord, "blob_ref" | "hydration_error" | "hydration_status" | "size_bytes"> {
  let lat: number | null = null;
  let lon: number | null = null;
  let alt: number | null = null;

  if (metadata?.geoDataExif) {
    lat = metadata.geoDataExif.latitude ?? null;
    lon = metadata.geoDataExif.longitude ?? null;
    alt = metadata.geoDataExif.altitude ?? null;
  } else if (metadata?.geoData) {
    lat = metadata.geoData.latitude ?? null;
    lon = metadata.geoData.longitude ?? null;
    alt = metadata.geoData.altitude ?? null;
  }

  // Fall back to a filename+event_time identity when content bytes are
  // unavailable (e.g. the file could not be read) so the record can still
  // be emitted rather than dropped.
  const id = contentSha256 ? hashId(`photo|${contentSha256}`) : hashId(`photo|${iso}|${filename}`);

  return {
    id,
    filename,
    event_time: iso,
    title: metadata?.title ?? null,
    description: metadata?.description ?? null,
    latitude: lat,
    longitude: lon,
    altitude: alt,
    content_sha256: contentSha256,
  };
}

// Google Takeout sidecar naming is inconsistent across export vintages and
// truncates long filenames (see connector-primary-reconcile-0807.md §2):
// legacy `<file>.json`, newer `<file>.supplemental-metadata.json`, and both
// families can be truncated mid-suffix. Exact-name matching misses real
// sidecars, so match by longest shared prefix among candidate JSON files in
// the same directory instead of constructing one expected path.
const SIDECAR_JSON_RE = /\.json$/i;

/**
 * Pick the best-matching sidecar JSON filename for a media file from the
 * list of JSON filenames present in the same directory. Returns null when
 * no plausible candidate exists (a missing sidecar is expected, not an
 * error — see connector-primary-reconcile-0807.md §2).
 */
export function matchSidecarFilename(mediaFilename: string, jsonFilenamesInDir: readonly string[]): string | null {
  const exact = `${mediaFilename}.json`;
  if (jsonFilenamesInDir.includes(exact)) {
    return exact;
  }
  // Truncated `.supplemental-metadata.json` variants and duplicate-marker
  // reordering (`file.jpg(1).json`) both preserve the media file's own
  // extension as a substring near the start of the sidecar name. Match the
  // sidecar whose name starts with the longest prefix of `mediaFilename`.
  let best: string | null = null;
  let bestLen = 0;
  for (const candidate of jsonFilenamesInDir) {
    if (!SIDECAR_JSON_RE.test(candidate)) {
      continue;
    }
    let shared = 0;
    const max = Math.min(mediaFilename.length, candidate.length);
    while (shared < max && mediaFilename[shared] === candidate[shared]) {
      shared += 1;
    }
    // Require a meaningful prefix match (not just a shared leading char) to
    // avoid pairing unrelated files that happen to start the same way.
    if (shared > bestLen && shared >= Math.min(8, mediaFilename.length)) {
      bestLen = shared;
      best = candidate;
    }
  }
  return best;
}
