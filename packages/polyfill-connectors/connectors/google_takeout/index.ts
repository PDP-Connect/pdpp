#!/usr/bin/env node
/**
 * PDPP Google Takeout Connector (v0.1.0) — file-based.
 *
 * Auth: none. User goes to https://takeout.google.com/, requests an archive,
 * downloads the .zip, extracts it into GOOGLE_TAKEOUT_DIR (defaults to
 * ~/.pdpp/imports/google_takeout/).
 *
 * Streams:
 *   - location_history (Location History/Records.json)
 *   - youtube_watch_history (YouTube and YouTube Music/history/watch-history.json)
 *   - search_history (My Activity/Search/MyActivity.json)
 *
 * Incremental: track latest timestamp per stream in state.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { runConnector } from "../../src/connector-runtime.ts";

interface GoogleActivityEntry {
  activity?: Array<{ activity?: Array<{ type?: string }> }>;
}

interface LocationPoint {
  accuracy?: number | null;
  activity?: GoogleActivityEntry["activity"];
  altitude?: number | null;
  latitudeE7?: number;
  longitudeE7?: number;
  timestamp?: string;
  timestampMs?: string;
  velocity?: number | null;
}

interface LocationFile {
  locations?: LocationPoint[];
}

interface WatchHistoryEntry {
  subtitles?: Array<{ name?: string; url?: string }>;
  time?: string;
  title?: string;
  titleUrl?: string;
}

interface SearchHistoryEntry {
  header?: string;
  time?: string;
  title?: string;
}

interface StreamTimestampState {
  last_timestamp?: string;
}

interface GoogleTakeoutState {
  location_history?: StreamTimestampState;
  search_history?: StreamTimestampState;
  youtube_watch_history?: StreamTimestampState;
}

// E7-scaled geo coords from Google's Android location schema: multiply by 1e-7.
const GOOGLE_E7_DIVISOR = 1e7;
// Length of sha256-derived record IDs — 24 hex chars = 96 bits of entropy.
const RECORD_ID_HASH_LENGTH = 24;

// Module-level regex.
const SEARCHED_FOR_PREFIX_RE = /^Searched for /;

const hashId = (s: string): string =>
  createHash("sha256").update(s).digest("hex").slice(0, RECORD_ID_HASH_LENGTH);

async function readJsonIf(path: string): Promise<unknown> {
  if (!existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

runConnector({
  name: "google_takeout",
  async collect({ state, requested, emit, emitRecord }) {
    const importDir =
      process.env.GOOGLE_TAKEOUT_DIR ||
      join(homedir(), ".pdpp/imports/google_takeout");

    const typedState = state as GoogleTakeoutState;

    // LOCATION HISTORY
    if (requested.has("location_history")) {
      const path = join(
        importDir,
        "Location History (Timeline)",
        "Records.json"
      );
      const alt = join(importDir, "Location History", "Records.json");
      const file = existsSync(path) ? path : existsSync(alt) ? alt : null;
      const json = (
        file ? await readJsonIf(file) : null
      ) as LocationFile | null;
      if (json?.locations) {
        const since = typedState.location_history?.last_timestamp;
        let latest: string | undefined = since;
        await emit({
          type: "PROGRESS",
          stream: "location_history",
          message: `Importing ${json.locations.length} location points`,
        });
        for (const loc of json.locations) {
          const tsUnixMs =
            typeof loc.timestampMs === "string"
              ? Number.parseInt(loc.timestampMs, 10)
              : loc.timestamp
                ? Date.parse(loc.timestamp)
                : null;
          if (!tsUnixMs) {
            continue;
          }
          const ts = new Date(tsUnixMs).toISOString();
          if (since && ts <= since) {
            continue;
          }
          const lat =
            typeof loc.latitudeE7 === "number"
              ? loc.latitudeE7 / GOOGLE_E7_DIVISOR
              : null;
          const lon =
            typeof loc.longitudeE7 === "number"
              ? loc.longitudeE7 / GOOGLE_E7_DIVISOR
              : null;
          const id = hashId(`loc|${ts}|${lat}|${lon}`);
          await emitRecord("location_history", {
            id,
            timestamp: ts,
            latitude: lat,
            longitude: lon,
            accuracy_meters: loc.accuracy ?? null,
            activity_type: loc.activity?.[0]?.activity?.[0]?.type ?? null,
            velocity_mps: loc.velocity ?? null,
            altitude_m: loc.altitude ?? null,
          });
          if (!latest || ts > latest) {
            latest = ts;
          }
        }
        await emit({
          type: "STATE",
          stream: "location_history",
          cursor: { last_timestamp: latest },
        });
      } else {
        await emit({
          type: "SKIP_RESULT",
          stream: "location_history",
          reason: "records_not_found",
          message: `no Records.json in ${importDir}/Location*/`,
        });
      }
    }

    // YOUTUBE WATCH HISTORY
    if (requested.has("youtube_watch_history")) {
      const path = join(
        importDir,
        "YouTube and YouTube Music",
        "history",
        "watch-history.json"
      );
      const json = (await readJsonIf(path)) as WatchHistoryEntry[] | null;
      if (Array.isArray(json)) {
        const since = typedState.youtube_watch_history?.last_timestamp;
        let latest: string | undefined = since;
        await emit({
          type: "PROGRESS",
          stream: "youtube_watch_history",
          message: `Importing ${json.length} watch-history entries`,
        });
        for (const e of json) {
          const ts = e.time || null;
          if (!ts) {
            continue;
          }
          if (since && ts <= since) {
            continue;
          }
          const videoUrl = e.titleUrl || null;
          const channelUrl = e.subtitles?.[0]?.url || null;
          const id = hashId(`yt|${ts}|${videoUrl || e.title}`);
          await emitRecord("youtube_watch_history", {
            id,
            watched_at: ts,
            video_url: videoUrl,
            video_title: e.title || null,
            channel_name: e.subtitles?.[0]?.name || null,
            channel_url: channelUrl,
          });
          if (!latest || ts > latest) {
            latest = ts;
          }
        }
        await emit({
          type: "STATE",
          stream: "youtube_watch_history",
          cursor: { last_timestamp: latest },
        });
      } else {
        await emit({
          type: "SKIP_RESULT",
          stream: "youtube_watch_history",
          reason: "history_not_found",
          message: `no watch-history.json at ${path}`,
        });
      }
    }

    // SEARCH HISTORY
    if (requested.has("search_history")) {
      const path = join(importDir, "My Activity", "Search", "MyActivity.json");
      const json = (await readJsonIf(path)) as SearchHistoryEntry[] | null;
      if (Array.isArray(json)) {
        const since = typedState.search_history?.last_timestamp;
        let latest: string | undefined = since;
        await emit({
          type: "PROGRESS",
          stream: "search_history",
          message: `Importing ${json.length} search-activity entries`,
        });
        for (const e of json) {
          const ts = e.time || null;
          if (!ts) {
            continue;
          }
          if (since && ts <= since) {
            continue;
          }
          const query = (e.title || "").replace(SEARCHED_FOR_PREFIX_RE, "");
          const id = hashId(`gs|${ts}|${query}`);
          await emitRecord("search_history", {
            id,
            timestamp: ts,
            query,
            product: e.header || null,
          });
          if (!latest || ts > latest) {
            latest = ts;
          }
        }
        await emit({
          type: "STATE",
          stream: "search_history",
          cursor: { last_timestamp: latest },
        });
      } else {
        await emit({
          type: "SKIP_RESULT",
          stream: "search_history",
          reason: "history_not_found",
          message: `no Search MyActivity.json at ${path}`,
        });
      }
    }
  },
});
