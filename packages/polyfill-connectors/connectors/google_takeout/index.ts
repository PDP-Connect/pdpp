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
 *   - photos (Photos/ directory tree)
 *
 * Incremental: track latest timestamp per stream in state. Photos is full-snapshot,
 * not truly incremental (Takeout is not incremental); cursor tracks latest-seen
 * for range-filter efficiency only.
 */

import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CollectContext } from "../../src/connector-runtime.ts";
import { runConnector } from "../../src/connector-runtime.ts";
import {
  hydrateMediaBytes,
  resolveMaxMediaBytes,
  sanitizeHydrationError,
} from "../../src/local-media-blob-hydration.ts";
import {
  buildCoverageDiagnosticsStateSnapshot,
  buildLocalSourceInventory,
  type KnownLocalStore,
} from "../../src/local-source-inventory.ts";
import {
  buildLocationRecord,
  buildPhotoRecord,
  buildSearchRecord,
  buildWatchHistoryRecord,
  locationTimestampMs,
  matchSidecarFilename,
  photoEventTimeMs,
  readJsonIf,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import type {
  GoogleTakeoutState,
  LocationFile,
  PhotoMetadataFile,
  PhotoRecord,
  SearchHistoryEntry,
  StreamTimestampState,
  WatchHistoryEntry,
} from "./types.ts";

// Module-scoped regex (Biome useTopLevelRegex).
const PHOTO_EXTENSIONS_RE = /\.(jpg|jpeg|png|gif|bmp|webp|mp4|mov|mts|m4v|3gp|3g2|wmv|avi|mkv|flv|webm)$/i;
const SIDECAR_JSON_SUFFIX_RE = /\.json$/i;

// Same cap family as gmail's DEFAULT_MAX_ATTACHMENT_BYTES: bound local-file
// reads so one oversized export item can't blow memory or dominate a run.
const MAX_PHOTO_BYTES_ENV = "PDPP_GOOGLE_TAKEOUT_MAX_PHOTO_BYTES";

function maxPhotoBytes(env: NodeJS.ProcessEnv = process.env): number {
  return resolveMaxMediaBytes(MAX_PHOTO_BYTES_ENV, env);
}

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
    itemOrdinal += 1;
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
    itemOrdinal += 1;
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
    itemOrdinal += 1;
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

interface DiscoveredPhotoFile {
  dir: string;
  name: string;
}

async function resolveSidecarMetadata(
  file: DiscoveredPhotoFile,
  jsonFilenamesByDir: Map<string, string[]>
): Promise<PhotoMetadataFile | null> {
  const jsonInDir = jsonFilenamesByDir.get(file.dir) ?? [];
  const sidecarName = matchSidecarFilename(file.name, jsonInDir);
  if (!sidecarName) {
    return null;
  }
  return (await readJsonIf(join(file.dir, sidecarName))) as PhotoMetadataFile | null;
}

/**
 * Resolve a media file's event timestamp. Prefers sidecar metadata; falls
 * back to filesystem mtime (stable across re-runs) rather than "now" when
 * no sidecar or usable timestamp exists — a missing sidecar is expected
 * (edited variants, export gaps), not an error. Returns null when the file
 * can't be stat'd either: `event_time` is the manifest's semantic-time
 * source, so the run clock would date the photo to the import, not the
 * moment it was taken. Caller skips the file.
 */
async function resolvePhotoEventTimeMs(
  file: DiscoveredPhotoFile,
  metadata: PhotoMetadataFile | null
): Promise<number | null> {
  const fromMetadata = metadata ? photoEventTimeMs(metadata) : null;
  if (fromMetadata) {
    return fromMetadata;
  }
  const stats = await stat(join(file.dir, file.name)).catch(() => null);
  return stats?.mtimeMs ?? null;
}

/**
 * Build one photos record for a discovered media file: locate its sidecar
 * (best-effort, tolerant of missing/mismatched-suffix sidecars), resolve
 * event time, and hydrate bytes to a blob within the size cap. Null when the
 * file has no resolvable event time (see resolvePhotoEventTimeMs).
 */
async function buildPhotoRecordForFile(
  file: DiscoveredPhotoFile,
  jsonFilenamesByDir: Map<string, string[]>,
  maxBytes: number
): Promise<PhotoRecord | null> {
  const metadata = await resolveSidecarMetadata(file, jsonFilenamesByDir);
  const tsMs = await resolvePhotoEventTimeMs(file, metadata);
  if (tsMs === null) {
    return null;
  }
  const ts = new Date(tsMs).toISOString();
  const hydration = await hydrateMediaBytes({
    connectorId: "https://registry.pdpp.dev/connectors/google-takeout",
    fileName: file.name,
    filePath: join(file.dir, file.name),
    maxBytes,
    stream: "photos",
  });

  const base = buildPhotoRecord(file.name, ts, hydration.contentSha256, metadata);
  return {
    ...base,
    blob_ref: hydration.blobRef,
    content_sha256: hydration.blobRef?.sha256 ?? hydration.contentSha256,
    hydration_error: hydration.hydrationError,
    hydration_status: hydration.hydrationStatus,
    size_bytes: hydration.blobRef?.size_bytes ?? hydration.sizeBytes,
  };
}

async function emitPhotos(
  ctx: CollectContext,
  mediaEntries: DiscoveredPhotoFile[],
  jsonFilenamesByDir: Map<string, string[]>,
  since: string | undefined,
  maxBytes: number
): Promise<{ latest: string | undefined; processedItems: number }> {
  const { emit, emitRecord } = ctx;
  const stream = "photos";
  let latest: string | undefined = since;
  let processedItems = 0;

  for (const file of mediaEntries) {
    processedItems += 1;
    const record = await buildPhotoRecordForFile(file, jsonFilenamesByDir, maxBytes);
    if (!record) {
      continue;
    }

    if (since && record.event_time <= since) {
      continue;
    }

    await emitRecord(stream, { ...record });

    if (processedItems % 10_000 === 0) {
      await emit({
        type: "PROGRESS",
        stream,
        message: `Google Takeout phase=emit pass=emit stream=photos item=${processedItems}/${mediaEntries.length}`,
      });
    }

    if (!latest || record.event_time > latest) {
      latest = record.event_time;
    }
  }

  return { latest, processedItems };
}

/**
 * Enumerate the Photos/ tree once, splitting entries into candidate
 * photo/video files and per-directory JSON filename lists (sidecars).
 * Non-media, non-JSON files (e.g. per-album metadata.json is included in the
 * JSON list; genuinely unsupported extensions are dropped with a bounded
 * count, never per-file diagnostics that could carry a real filename).
 */
async function discoverPhotoFiles(photosDir: string): Promise<{
  jsonFilenamesByDir: Map<string, string[]>;
  mediaEntries: DiscoveredPhotoFile[];
  unsupportedCount: number;
}> {
  const entries = await readdir(photosDir, { recursive: true, withFileTypes: true });
  const mediaEntries: DiscoveredPhotoFile[] = [];
  const jsonFilenamesByDir = new Map<string, string[]>();
  let unsupportedCount = 0;

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    // entry.parentPath from readdir({recursive: true}) is already the full
    // path to the entry's containing directory (absolute here, since
    // photosDir is absolute) — joining it onto photosDir again doubles it.
    const parentPath = entry.parentPath || photosDir;
    if (SIDECAR_JSON_SUFFIX_RE.test(entry.name)) {
      const list = jsonFilenamesByDir.get(parentPath);
      if (list) {
        list.push(entry.name);
      } else {
        jsonFilenamesByDir.set(parentPath, [entry.name]);
      }
      continue;
    }
    if (PHOTO_EXTENSIONS_RE.test(entry.name)) {
      mediaEntries.push({ dir: parentPath, name: entry.name });
    } else {
      unsupportedCount += 1;
    }
  }

  return { jsonFilenamesByDir, mediaEntries, unsupportedCount };
}

async function collectPhotos(
  ctx: CollectContext,
  importDir: string,
  streamState: StreamTimestampState | undefined
): Promise<void> {
  const { emit } = ctx;
  const stream = "photos";
  const photosDir = join(importDir, "Photos");

  if (!existsSync(photosDir)) {
    await emit({
      type: "SKIP_RESULT",
      stream,
      reason: "photos_not_found",
      message: "Google Takeout Photos directory was not found in the configured import directory",
    });
    return;
  }

  const since = streamState?.last_timestamp;
  const maxBytes = maxPhotoBytes();

  try {
    const { jsonFilenamesByDir, mediaEntries, unsupportedCount } = await discoverPhotoFiles(photosDir);

    await emit({
      type: "PROGRESS",
      stream,
      message: `Google Takeout phase=emit pass=emit stream=photos total_items=${mediaEntries.length} unsupported_files=${unsupportedCount}`,
    });

    const { latest } = await emitPhotos(ctx, mediaEntries, jsonFilenamesByDir, since, maxBytes);
    await emit({ type: "STATE", stream, cursor: { last_timestamp: latest } });
  } catch (err) {
    // fs errors (e.g. readdir ENOENT/EACCES) embed the local path; never
    // forward err.message verbatim into an operator-facing diagnostic.
    await emit({
      type: "SKIP_RESULT",
      stream,
      reason: "directory_read_failed",
      message: `Google Takeout Photos directory could not be read: ${sanitizeHydrationError(err instanceof Error ? err.message : String(err))}`,
    });
  }
}

/**
 * Known local stores for the coverage_diagnostics stream (§ local-collector
 * bundling). Each store is the exact top-level path this connector reads for
 * one stream, mirroring the claude_code/codex coverage-inventory pattern —
 * `classification: "collect"` since these are the same paths collectRecords
 * reads directly, not a separate metadata-only inventory. `location_history`
 * uses the current Takeout export's folder name; the legacy `Location
 * History/` fallback (see resolveLocationFile) is not separately inventoried
 * since it is the same stream/store, just an older Takeout export layout.
 */
const GOOGLE_TAKEOUT_KNOWN_LOCAL_STORES: KnownLocalStore[] = [
  {
    store: "location_history",
    relativePath: "Location History (Timeline)/Records.json",
    stream: "location_history",
    classification: "collect",
    reason: "declared location history source",
  },
  {
    store: "youtube_watch_history",
    relativePath: "YouTube and YouTube Music/history/watch-history.json",
    stream: "youtube_watch_history",
    classification: "collect",
    reason: "declared YouTube watch history source",
  },
  {
    store: "search_history",
    relativePath: "My Activity/Search/MyActivity.json",
    stream: "search_history",
    classification: "collect",
    reason: "declared search history source",
  },
  {
    store: "photos",
    relativePath: "Photos",
    stream: "photos",
    classification: "collect",
    reason: "declared photos/videos source",
  },
];

runConnector({
  name: "google_takeout",
  validateRecord,
  async collect(ctx) {
    const { emit, emitRecord, requested } = ctx;
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
    if (ctx.requested.has("photos")) {
      await collectPhotos(ctx, importDir, typedState.photos);
    }
    if (requested.has("coverage_diagnostics")) {
      const inventory = await buildLocalSourceInventory("google_takeout", importDir, GOOGLE_TAKEOUT_KNOWN_LOCAL_STORES);
      for (const record of inventory.coverage) {
        await emitRecord("coverage_diagnostics", record);
      }
      await emit({
        type: "STATE",
        stream: "coverage_diagnostics",
        cursor: {
          fetched_at: new Date().toISOString(),
          stores: buildCoverageDiagnosticsStateSnapshot(inventory.coverage),
        },
      });
    }
  },
});
