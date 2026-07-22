#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CollectContext } from "../../src/connector-runtime.ts";
import { runConnector } from "../../src/connector-runtime.ts";
import {
  buildLocationRecord,
  buildSearchRecord,
  buildWatchHistoryRecord,
  locationTimestampMs,
  readJsonIf,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import type {
  GoogleTakeoutState,
  LocationFile,
  SearchHistoryEntry,
  StreamTimestampState,
  WatchHistoryEntry,
} from "./types.ts";

function resolveLocationFile(importDir: string): string | null {
  const path = join(importDir, "Location History (Timeline)", "Records.json");
  if (existsSync(path)) {
    return path;
  }
  const alt = join(importDir, "Location History", "Records.json");
  if (existsSync(alt)) {
    return alt;
  }
  return null;
}

async function collectLocationHistory(
  ctx: CollectContext,
  importDir: string,
  streamState: StreamTimestampState | undefined
): Promise<void> {
  const { emit, emitRecord } = ctx;
  const stream = "location_history";
  const file = resolveLocationFile(importDir);
  const json = (file ? await readJsonIf(file) : null) as LocationFile | null;
  if (!json?.locations) {
    await emit({
      type: "SKIP_RESULT",
      stream,
      reason: "records_not_found",
      message: "Google Takeout location records were not found in the configured import directory",
    });
    return;
  }
  const since = streamState?.last_timestamp;
  let latest: string | undefined = since;
  await emit({
    type: "PROGRESS",
    stream,
    message: `Google Takeout phase=emit pass=emit stream=location_history total_items=${json.locations.length}`,
  });
  let itemOrdinal = 0;
  for (const loc of json.locations) {
    itemOrdinal++;
    const tsUnixMs = locationTimestampMs(loc);
    if (!tsUnixMs) {
      continue;
    }
    const ts = new Date(tsUnixMs).toISOString();
    if (since && ts <= since) {
      continue;
    }
    await emitRecord(stream, { ...buildLocationRecord(loc, ts) });
    if (itemOrdinal % 10_000 === 0) {
      await emit({
        type: "PROGRESS",
        stream,
        message: `Google Takeout phase=emit pass=emit stream=location_history item=${itemOrdinal}/${json.locations.length}`,
      });
    }
    if (!latest || ts > latest) {
      latest = ts;
    }
  }
  await emit({ type: "STATE", stream, cursor: { last_timestamp: latest } });
}

async function collectYoutubeWatchHistory(
  ctx: CollectContext,
  importDir: string,
  streamState: StreamTimestampState | undefined
): Promise<void> {
  const { emit, emitRecord } = ctx;
  const stream = "youtube_watch_history";
  const path = join(importDir, "YouTube and YouTube Music", "history", "watch-history.json");
  const json = (await readJsonIf(path)) as WatchHistoryEntry[] | null;
  if (!Array.isArray(json)) {
    await emit({
      type: "SKIP_RESULT",
      stream,
      reason: "history_not_found",
      message: "Google Takeout watch history was not found in the configured import directory",
    });
    return;
  }
  const since = streamState?.last_timestamp;
  let latest: string | undefined = since;
  await emit({
    type: "PROGRESS",
    stream,
    message: `Google Takeout phase=emit pass=emit stream=youtube_watch_history total_items=${json.length}`,
  });
  let itemOrdinal = 0;
  for (const e of json) {
    itemOrdinal++;
    const record = buildWatchHistoryRecord(e);
    if (!record) {
      continue;
    }
    if (since && record.watched_at <= since) {
      continue;
    }
    await emitRecord(stream, { ...record });
    if (itemOrdinal % 10_000 === 0) {
      await emit({
        type: "PROGRESS",
        stream,
        message: `Google Takeout phase=emit pass=emit stream=youtube_watch_history item=${itemOrdinal}/${json.length}`,
      });
    }
    if (!latest || record.watched_at > latest) {
      latest = record.watched_at;
    }
  }
  await emit({ type: "STATE", stream, cursor: { last_timestamp: latest } });
}

async function collectSearchHistory(
  ctx: CollectContext,
  importDir: string,
  streamState: StreamTimestampState | undefined
): Promise<void> {
  const { emit, emitRecord } = ctx;
  const stream = "search_history";
  const path = join(importDir, "My Activity", "Search", "MyActivity.json");
  const json = (await readJsonIf(path)) as SearchHistoryEntry[] | null;
  if (!Array.isArray(json)) {
    await emit({
      type: "SKIP_RESULT",
      stream,
      reason: "history_not_found",
      message: "Google Takeout search history was not found in the configured import directory",
    });
    return;
  }
  const since = streamState?.last_timestamp;
  let latest: string | undefined = since;
  await emit({
    type: "PROGRESS",
    stream,
    message: `Google Takeout phase=emit pass=emit stream=search_history total_items=${json.length}`,
  });
  let itemOrdinal = 0;
  for (const e of json) {
    itemOrdinal++;
    const record = buildSearchRecord(e);
    if (!record) {
      continue;
    }
    if (since && record.timestamp <= since) {
      continue;
    }
    await emitRecord(stream, { ...record });
    if (itemOrdinal % 10_000 === 0) {
      await emit({
        type: "PROGRESS",
        stream,
        message: `Google Takeout phase=emit pass=emit stream=search_history item=${itemOrdinal}/${json.length}`,
      });
    }
    if (!latest || record.timestamp > latest) {
      latest = record.timestamp;
    }
  }
  await emit({ type: "STATE", stream, cursor: { last_timestamp: latest } });
}

runConnector({
  name: "google_takeout",
  validateRecord,
  async collect(ctx) {
    const importDir = process.env.GOOGLE_TAKEOUT_DIR || join(homedir(), ".pdpp/imports/google_takeout");
    const typedState = ctx.state as GoogleTakeoutState;
    if (ctx.requested.has("location_history")) {
      await collectLocationHistory(ctx, importDir, typedState.location_history);
    }
    if (ctx.requested.has("youtube_watch_history")) {
      await collectYoutubeWatchHistory(ctx, importDir, typedState.youtube_watch_history);
    }
    if (ctx.requested.has("search_history")) {
      await collectSearchHistory(ctx, importDir, typedState.search_history);
    }
  },
});
