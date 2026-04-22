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
import { createInterface } from "node:readline";
import type {
  EmittedMessage,
  RecordData,
  StreamScope,
} from "../../src/connector-runtime.ts";
import { stringifyForJsonl } from "../../src/safe-emit.ts";
import { resourceSet } from "../../src/scope-filters.ts";

interface StartMessage {
  scope?: { streams?: readonly StreamScope[] };
  state?: {
    location_history?: { last_timestamp?: string };
    youtube_watch_history?: { last_timestamp?: string };
    search_history?: { last_timestamp?: string };
  };
  type: string;
}

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

const rl = createInterface({ input: process.stdin, terminal: false });
const emit = (m: EmittedMessage): boolean =>
  process.stdout.write(stringifyForJsonl(m));
const flushAndExit = (code: number): void => {
  if (process.stdout.writableLength > 0) {
    process.stdout.once("drain", () => process.exit(code));
    setTimeout(() => process.exit(code), 3000).unref();
  } else {
    process.exit(code);
  }
};
const fail = (m: string, r = false): void => {
  emit({
    type: "DONE",
    status: "failed",
    records_emitted: 0,
    error: { message: m, retryable: r },
  });
  flushAndExit(1);
};
const nowIso = (): string => new Date().toISOString();
const hashId = (s: string): string =>
  createHash("sha256").update(s).digest("hex").slice(0, 24);

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

async function main(): Promise<void> {
  const startMsg = await new Promise<StartMessage>((r, j) =>
    rl.once("line", (l) => {
      try {
        r(JSON.parse(l) as StartMessage);
      } catch (e) {
        j(e);
      }
    })
  );
  if (startMsg.type !== "START") {
    return fail("Expected START");
  }

  const requested = new Map<string, StreamScope>(
    (startMsg.scope?.streams || []).map((s) => [s.name, s])
  );
  if (!requested.size) {
    return fail("START.scope.streams is required");
  }

  const importDir =
    process.env.GOOGLE_TAKEOUT_DIR ||
    join(homedir(), ".pdpp/imports/google_takeout");

  const state = startMsg.state || {};
  const emittedAt = nowIso();
  let total = 0;
  const _resFilters = new Map<string, ReadonlySet<string> | null>(
    (startMsg.scope?.streams || []).map((sr) => [sr.name, resourceSet(sr)])
  );
  const emitRecord = (s: string, d: RecordData): void => {
    if (d.id == null) {
      return;
    }
    const _rs = _resFilters.get(s);
    if (_rs && !_rs.has(String(d.id))) {
      return;
    }
    emit({
      type: "RECORD",
      stream: s,
      key: d.id,
      data: d,
      emitted_at: emittedAt,
    });
    total++;
  };

  // LOCATION HISTORY
  if (requested.has("location_history")) {
    const path = join(importDir, "Location History (Timeline)", "Records.json");
    const alt = join(importDir, "Location History", "Records.json");
    const file = existsSync(path) ? path : existsSync(alt) ? alt : null;
    const json = (file ? await readJsonIf(file) : null) as LocationFile | null;
    if (json?.locations) {
      const since = state.location_history?.last_timestamp;
      let latest: string | undefined = since;
      emit({
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
          typeof loc.latitudeE7 === "number" ? loc.latitudeE7 / 1e7 : null;
        const lon =
          typeof loc.longitudeE7 === "number" ? loc.longitudeE7 / 1e7 : null;
        const id = hashId(`loc|${ts}|${lat}|${lon}`);
        emitRecord("location_history", {
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
      emit({
        type: "STATE",
        stream: "location_history",
        cursor: { last_timestamp: latest },
      });
    } else {
      emit({
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
      const since = state.youtube_watch_history?.last_timestamp;
      let latest: string | undefined = since;
      emit({
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
        emitRecord("youtube_watch_history", {
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
      emit({
        type: "STATE",
        stream: "youtube_watch_history",
        cursor: { last_timestamp: latest },
      });
    } else {
      emit({
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
      const since = state.search_history?.last_timestamp;
      let latest: string | undefined = since;
      emit({
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
        const query = (e.title || "").replace(/^Searched for /, "");
        const id = hashId(`gs|${ts}|${query}`);
        emitRecord("search_history", {
          id,
          timestamp: ts,
          query,
          product: e.header || null,
        });
        if (!latest || ts > latest) {
          latest = ts;
        }
      }
      emit({
        type: "STATE",
        stream: "search_history",
        cursor: { last_timestamp: latest },
      });
    } else {
      emit({
        type: "SKIP_RESULT",
        stream: "search_history",
        reason: "history_not_found",
        message: `no Search MyActivity.json at ${path}`,
      });
    }
  }

  emit({ type: "DONE", status: "succeeded", records_emitted: total });
  flushAndExit(0);
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  emit({
    type: "DONE",
    status: "failed",
    records_emitted: 0,
    error: { message: msg, retryable: false },
  });
  flushAndExit(1);
});
