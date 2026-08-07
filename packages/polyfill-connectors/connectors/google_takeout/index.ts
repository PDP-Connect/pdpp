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

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CollectContext } from "../../src/connector-runtime.ts";
import { runConnector } from "../../src/connector-runtime.ts";
import {
  makeReferenceBlobUploader,
  type ReferenceBlobRef,
  runtimeBlobUploadAvailable,
} from "../../src/reference-blob-uploader.ts";
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
  PhotoHydrationStatus,
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
const DEFAULT_MAX_PHOTO_BYTES = 25 * 1024 * 1024;
const MAX_PHOTO_BYTES_ENV = "PDPP_GOOGLE_TAKEOUT_MAX_PHOTO_BYTES";
// Diagnostic text must never carry a local filesystem path or filename.
const HYDRATION_ERROR_MAX_CHARS = 240;

function maxPhotoBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[MAX_PHOTO_BYTES_ENV];
  if (!raw) {
    return DEFAULT_MAX_PHOTO_BYTES;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_PHOTO_BYTES;
}

function contentTypeForFileName(fileName: string): string {
  const lower = fileName.toLowerCase();
  const map: [string, string][] = [
    [".jpg", "image/jpeg"],
    [".jpeg", "image/jpeg"],
    [".png", "image/png"],
    [".gif", "image/gif"],
    [".bmp", "image/bmp"],
    [".webp", "image/webp"],
    [".mp4", "video/mp4"],
    [".mov", "video/quicktime"],
    [".mts", "video/mp2t"],
    [".m4v", "video/x-m4v"],
    [".3gp", "video/3gpp"],
    [".3g2", "video/3gpp2"],
    [".wmv", "video/x-ms-wmv"],
    [".avi", "video/x-msvideo"],
    [".mkv", "video/x-matroska"],
    [".flv", "video/x-flv"],
    [".webm", "video/webm"],
  ];
  for (const [ext, mime] of map) {
    if (lower.endsWith(ext)) {
      return mime;
    }
  }
  return "application/octet-stream";
}

function sanitizeHydrationError(message: string): string {
  // Strip anything path-shaped and cap length so a diagnostic never leaks a
  // local filesystem location (standing PDPP PII rule: diagnostics carry
  // hashed/structural info, not raw paths or user text).
  const noPaths = message.replace(/(?:[A-Za-z]:)?[/\\][^\s"']*/g, "<path>");
  return noPaths.slice(0, HYDRATION_ERROR_MAX_CHARS);
}

function uploadPhotoBlob(args: {
  bytes: Buffer;
  mimeType: string;
  recordKey: string;
}): Promise<ReferenceBlobRef | null> {
  const rsUrl = process.env.PDPP_RS_URL || process.env.RS_URL;
  const ownerToken = process.env.PDPP_OWNER_TOKEN;
  if (!(runtimeBlobUploadAvailable(process.env) && rsUrl && ownerToken)) {
    return Promise.resolve(null);
  }
  const uploader = makeReferenceBlobUploader({
    connectorInstanceId: process.env.PDPP_CONNECTOR_INSTANCE_ID || null,
    ownerToken,
    rsUrl,
  });
  return uploader({
    connectorId: "https://registry.pdpp.org/connectors/google-takeout",
    content: [args.bytes],
    mimeType: args.mimeType,
    recordKey: args.recordKey,
    stream: "photos",
  });
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

/**
 * Read a photo/video file's bytes bounded by maxBytes. Stats first so an
 * oversized file is never fully read into memory; only files at or under the
 * cap are hashed and returned.
 */
async function readBoundedPhotoBytes(
  path: string,
  maxBytes: number
): Promise<{ bytes: Buffer | null; sizeBytes: number; tooLarge: boolean }> {
  const stats = await stat(path);
  if (stats.size > maxBytes) {
    return { bytes: null, sizeBytes: stats.size, tooLarge: true };
  }
  const bytes = await readFile(path);
  return { bytes, sizeBytes: bytes.byteLength, tooLarge: false };
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
 * (edited variants, export gaps), not an error.
 */
async function resolvePhotoEventTimeMs(file: DiscoveredPhotoFile, metadata: PhotoMetadataFile | null): Promise<number> {
  const fromMetadata = metadata ? photoEventTimeMs(metadata) : null;
  if (fromMetadata) {
    return fromMetadata;
  }
  const stats = await stat(join(file.dir, file.name)).catch(() => null);
  return stats?.mtimeMs ?? Date.now();
}

interface PhotoHydrationResult {
  blobRef: ReferenceBlobRef | null;
  contentSha256: string | null;
  hydrationError: string | null;
  hydrationStatus: PhotoHydrationStatus;
  sizeBytes: number | null;
}

/**
 * Read, hash, and attempt blob upload for a media file within the size cap.
 * Never throws — unreadable/oversized files return a hydration_status
 * describing why bytes are absent, so the stream never fabricates a
 * deletion or silently drops a discovered file.
 */
async function hydratePhotoBytes(file: DiscoveredPhotoFile, maxBytes: number): Promise<PhotoHydrationResult> {
  try {
    const { bytes, sizeBytes, tooLarge } = await readBoundedPhotoBytes(join(file.dir, file.name), maxBytes);
    if (tooLarge || !bytes) {
      return {
        blobRef: null,
        contentSha256: null,
        hydrationError: null,
        hydrationStatus: "skipped_too_large",
        sizeBytes,
      };
    }
    const contentSha256 = createHash("sha256").update(bytes).digest("hex");
    try {
      const blobRef = await uploadPhotoBlob({
        bytes,
        mimeType: contentTypeForFileName(file.name),
        recordKey: contentSha256,
      });
      return {
        blobRef,
        contentSha256,
        hydrationError: null,
        hydrationStatus: blobRef ? "hydrated" : "unavailable",
        sizeBytes,
      };
    } catch (err) {
      return {
        blobRef: null,
        contentSha256,
        hydrationError: sanitizeHydrationError(err instanceof Error ? err.message : String(err)),
        hydrationStatus: "failed",
        sizeBytes,
      };
    }
  } catch (err) {
    return {
      blobRef: null,
      contentSha256: null,
      hydrationError: sanitizeHydrationError(err instanceof Error ? err.message : String(err)),
      hydrationStatus: "failed",
      sizeBytes: null,
    };
  }
}

/**
 * Build one photos record for a discovered media file: locate its sidecar
 * (best-effort, tolerant of missing/mismatched-suffix sidecars), resolve
 * event time, and hydrate bytes to a blob within the size cap.
 */
async function buildPhotoRecordForFile(
  file: DiscoveredPhotoFile,
  jsonFilenamesByDir: Map<string, string[]>,
  maxBytes: number
): Promise<PhotoRecord> {
  const metadata = await resolveSidecarMetadata(file, jsonFilenamesByDir);
  const tsMs = await resolvePhotoEventTimeMs(file, metadata);
  const ts = new Date(tsMs).toISOString();
  const hydration = await hydratePhotoBytes(file, maxBytes);

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
    if (ctx.requested.has("photos")) {
      await collectPhotos(ctx, importDir, typedState.photos);
    }
  },
});
