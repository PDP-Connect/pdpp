#!/usr/bin/env node
/**
 * PDPP Google Maps Timeline Connector (v0.1.0) — file-based.
 *
 * Auth: none. The owner exports Google Maps Timeline data from Google Maps /
 * Android settings or extracts a legacy Takeout archive into
 * GOOGLE_MAPS_TIMELINE_DIR (defaults to ~/.pdpp/imports/google_maps/).
 */

import { type Dirent, existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { CollectContext } from "../../src/connector-runtime.ts";
import { runConnector } from "../../src/connector-runtime.ts";
import { parseGoogleMapsExport } from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import type { GoogleMapsState, ParseResult, TimelinePointRecord, TimelineSegmentRecord } from "./types.ts";

const MAX_DISCOVERY_DEPTH = 5;
const MAX_DISCOVERY_ENTRIES = 2000;
const POINT_PROGRESS_INTERVAL = 10_000;
const SEGMENT_PROGRESS_INTERVAL = 1000;
const SUPPORTED_FILE_NAMES = new Set(["location-history.json", "timeline.json", "records.json"]);

async function readJson(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function isLikelyTimelineJson(path: string): boolean {
  const fileName = basename(path).toLowerCase();
  if (!SUPPORTED_FILE_NAMES.has(fileName)) {
    return false;
  }
  if (fileName !== "records.json") {
    return true;
  }
  const lowerPath = path.toLowerCase();
  return (
    lowerPath.includes("location history") || lowerPath.includes("timeline") || lowerPath.endsWith("/records.json")
  );
}

async function discoverTimelineFiles(importDir: string): Promise<string[]> {
  if (!existsSync(importDir)) {
    return [];
  }
  const found: string[] = [];
  let visited = 0;
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_DISCOVERY_DEPTH || visited >= MAX_DISCOVERY_ENTRIES) {
      return;
    }
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      visited++;
      if (visited > MAX_DISCOVERY_ENTRIES) {
        return;
      }
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path, depth + 1);
        continue;
      }
      if (entry.isFile() && isLikelyTimelineJson(path)) {
        found.push(path);
      }
    }
  }
  await walk(importDir, 0);
  return [...new Set(found)].sort();
}

function mergeResults(results: ParseResult[]): ParseResult {
  const points = new Map<string, TimelinePointRecord>();
  const segments = new Map<string, TimelineSegmentRecord>();
  for (const result of results) {
    for (const point of result.points) {
      points.set(point.id, point);
    }
    for (const segment of result.segments) {
      segments.set(segment.id, segment);
    }
  }
  return {
    points: [...points.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
    segments: [...segments.values()].sort((a, b) => a.start_time.localeCompare(b.start_time)),
  };
}

async function loadExports(ctx: CollectContext, importDir: string): Promise<ParseResult> {
  const files = await discoverTimelineFiles(importDir);
  await ctx.progress(`Google Maps phase=index pass=index source_files=${files.length}`);
  const results: ParseResult[] = [];
  let fileOrdinal = 0;
  for (const file of files) {
    fileOrdinal++;
    await ctx.progress(`Google Maps phase=parse pass=parse source_file=${fileOrdinal}/${files.length}`);
    const json = await readJson(file);
    if (!json) {
      await emitRequestedSkip(ctx, "invalid_json", "A Google Maps Timeline export file could not be parsed as JSON");
      continue;
    }
    results.push(parseGoogleMapsExport(json));
  }
  return mergeResults(results);
}

async function emitRequestedSkip(ctx: CollectContext, reason: string, message: string): Promise<void> {
  for (const stream of ["timeline_points", "timeline_segments"]) {
    if (ctx.requested.has(stream)) {
      await ctx.emit({ type: "SKIP_RESULT", stream, reason, message });
    }
  }
}

async function emitPoints(
  ctx: CollectContext,
  points: TimelinePointRecord[],
  since: string | undefined
): Promise<string | undefined> {
  let latest = since;
  let emitted = 0;
  await ctx.progress(`Google Maps phase=emit pass=emit stream=timeline_points total_items=${points.length}`, {
    stream: "timeline_points",
  });
  for (const point of points) {
    if (since && point.timestamp <= since) {
      continue;
    }
    await ctx.emitRecord("timeline_points", { ...point });
    emitted++;
    if (!latest || point.timestamp > latest) {
      latest = point.timestamp;
    }
    if (emitted % POINT_PROGRESS_INTERVAL === 0) {
      await ctx.progress(
        `Google Maps phase=emit pass=emit stream=timeline_points emitted=${emitted}/${points.length}`,
        {
          stream: "timeline_points",
        }
      );
    }
  }
  await ctx.emit({
    type: "STATE",
    stream: "timeline_points",
    cursor: { last_timestamp: latest },
  });
  return latest;
}

async function emitSegments(
  ctx: CollectContext,
  segments: TimelineSegmentRecord[],
  since: string | undefined
): Promise<string | undefined> {
  let latest = since;
  let emitted = 0;
  await ctx.progress(`Google Maps phase=emit pass=emit stream=timeline_segments total_items=${segments.length}`, {
    stream: "timeline_segments",
  });
  for (const segment of segments) {
    if (since && segment.start_time <= since) {
      continue;
    }
    await ctx.emitRecord("timeline_segments", { ...segment });
    emitted++;
    if (!latest || segment.start_time > latest) {
      latest = segment.start_time;
    }
    if (emitted % SEGMENT_PROGRESS_INTERVAL === 0) {
      await ctx.progress(
        `Google Maps phase=emit pass=emit stream=timeline_segments emitted=${emitted}/${segments.length}`,
        {
          stream: "timeline_segments",
        }
      );
    }
  }
  await ctx.emit({
    type: "STATE",
    stream: "timeline_segments",
    cursor: { last_start_time: latest },
  });
  return latest;
}

runConnector({
  name: "google_maps",
  validateRecord,
  async collect(ctx) {
    const importDir = process.env.GOOGLE_MAPS_TIMELINE_DIR || join(homedir(), ".pdpp/imports/google_maps");
    const typedState = ctx.state as GoogleMapsState;
    const requestedPoints = ctx.requested.has("timeline_points");
    const requestedSegments = ctx.requested.has("timeline_segments");
    const parsed = await loadExports(ctx, importDir);

    if (requestedPoints && parsed.points.length === 0) {
      await ctx.emit({
        type: "SKIP_RESULT",
        stream: "timeline_points",
        reason: "timeline_points_not_found",
        message: "Google Maps Timeline point records were not found in the configured import directory",
      });
    }
    if (requestedSegments && parsed.segments.length === 0) {
      await ctx.emit({
        type: "SKIP_RESULT",
        stream: "timeline_segments",
        reason: "timeline_segments_not_found",
        message: "Google Maps Timeline segment records were not found in the configured import directory",
      });
    }

    if (requestedPoints) {
      await emitPoints(ctx, parsed.points, typedState.timeline_points?.last_timestamp);
    }
    if (requestedSegments) {
      await emitSegments(ctx, parsed.segments, typedState.timeline_segments?.last_start_time);
    }
  },
});
