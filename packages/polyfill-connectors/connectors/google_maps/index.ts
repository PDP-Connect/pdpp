#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP Google Maps Timeline Connector (v0.1.0) — file-based.
 *
 * Auth: none. The owner exports Google Maps Timeline data from Google Maps /
 * Android settings or extracts a legacy Takeout archive into
 * GOOGLE_MAPS_TIMELINE_DIR (defaults to ~/.pdpp/imports/google_maps/).
 */

import { type Dirent, existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { CollectContext } from "../../src/connector-runtime.ts";
import { buildDetailCoverageMessage, buildFullScanCoverageMessage, runConnector } from "../../src/connector-runtime.ts";
import {
  GoogleMapsElementTooLargeError,
  type GoogleMapsStreamEvent,
  streamGoogleMapsExport,
} from "./archive-stream.ts";
import { parseGoogleMapsExportElement } from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import type { GoogleMapsState, TimelinePointRecord, TimelineSegmentRecord } from "./types.ts";

const MAX_DISCOVERY_DEPTH = 5;
const MAX_DISCOVERY_ENTRIES = 2000;
const POINT_PROGRESS_INTERVAL = 10_000;
const SEGMENT_PROGRESS_INTERVAL = 1000;
const SUPPORTED_FILE_NAMES = new Set(["location-history.json", "timeline.json", "records.json"]);

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
      visited += 1;
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

async function emitRequestedSkip(ctx: CollectContext, reason: string, message: string): Promise<void> {
  for (const stream of ["timeline_points", "timeline_segments"]) {
    if (ctx.requested.has(stream)) {
      await ctx.emit({ type: "SKIP_RESULT", stream, reason, message });
    }
  }
}

interface LoadSummary {
  complete: boolean;
  latestPoint: string | undefined;
  latestSegment: string | undefined;
  pointCount: number;
  pointsEmitted: number;
  segmentCount: number;
  segmentsEmitted: number;
  unrecognizedCount: number;
  unrecognizedKinds: Set<string>;
}

const GOOGLE_MAPS_EMISSION_ERROR = Symbol("google_maps_emission_error");
type GoogleMapsEmissionError = Error & { readonly [GOOGLE_MAPS_EMISSION_ERROR]: true };

function makeGoogleMapsEmissionError(cause: unknown): GoogleMapsEmissionError {
  const error = new Error("Google Maps protocol emission failed", { cause });
  Object.defineProperty(error, GOOGLE_MAPS_EMISSION_ERROR, { value: true });
  return error as GoogleMapsEmissionError;
}

function isGoogleMapsEmissionError(error: unknown): error is GoogleMapsEmissionError {
  return error instanceof Error && (error as GoogleMapsEmissionError)[GOOGLE_MAPS_EMISSION_ERROR] === true;
}

function maxTimestamp(current: string | undefined, candidate: string): string {
  return !current || candidate > current ? candidate : current;
}

async function emitRecordSafely(ctx: CollectContext, stream: string, record: Record<string, unknown>): Promise<void> {
  try {
    await ctx.emitRecord(stream, record);
  } catch (error) {
    throw makeGoogleMapsEmissionError(error);
  }
}

async function emitProgressSafely(ctx: CollectContext, message: string, options: { stream: string }): Promise<void> {
  try {
    await ctx.progress(message, options);
  } catch (error) {
    throw makeGoogleMapsEmissionError(error);
  }
}

interface StreamLoadContext {
  readonly ctx: CollectContext;
  readonly pointSince: string | undefined;
  readonly requestedPoints: boolean;
  readonly requestedSegments: boolean;
  readonly seenPointIds: Set<string>;
  readonly seenSegmentIds: Set<string>;
  readonly segmentSince: string | undefined;
  readonly summary: LoadSummary;
}

async function processPointRecords(load: StreamLoadContext, points: readonly TimelinePointRecord[]): Promise<void> {
  for (const point of points) {
    const pointId = typeof point.id === "string" ? point.id : null;
    const timestamp = typeof point.timestamp === "string" ? point.timestamp : null;
    if (!(pointId && timestamp)) {
      continue;
    }
    if (load.seenPointIds.has(pointId)) {
      continue;
    }
    load.seenPointIds.add(pointId);
    load.summary.pointCount += 1;
    load.summary.latestPoint = maxTimestamp(load.summary.latestPoint, timestamp);
    if (!load.requestedPoints || (load.pointSince && timestamp <= load.pointSince)) {
      continue;
    }
    await emitRecordSafely(load.ctx, "timeline_points", { ...point });
    load.summary.pointsEmitted += 1;
    if (load.summary.pointsEmitted % POINT_PROGRESS_INTERVAL === 0) {
      await emitProgressSafely(
        load.ctx,
        `Google Maps phase=emit pass=emit stream=timeline_points emitted=${load.summary.pointsEmitted}/streaming`,
        { stream: "timeline_points" }
      );
    }
  }
}

function recordUnrecognizedSegment(summary: LoadSummary, segment: TimelineSegmentRecord): void {
  if (segment.segment_kind !== "unrecognized") {
    return;
  }
  summary.unrecognizedCount += 1;
  summary.unrecognizedKinds.add(segment.unrecognized_kind ?? "(no payload key)");
}

async function processSegmentRecords(
  load: StreamLoadContext,
  segments: readonly TimelineSegmentRecord[]
): Promise<void> {
  for (const segment of segments) {
    const segmentId = typeof segment.id === "string" ? segment.id : null;
    const startTime = typeof segment.start_time === "string" ? segment.start_time : null;
    if (!(segmentId && startTime)) {
      continue;
    }
    if (load.seenSegmentIds.has(segmentId)) {
      continue;
    }
    load.seenSegmentIds.add(segmentId);
    load.summary.segmentCount += 1;
    load.summary.latestSegment = maxTimestamp(load.summary.latestSegment, startTime);
    recordUnrecognizedSegment(load.summary, segment);
    if (!load.requestedSegments || (load.segmentSince && startTime <= load.segmentSince)) {
      continue;
    }
    await emitRecordSafely(load.ctx, "timeline_segments", { ...segment });
    load.summary.segmentsEmitted += 1;
    if (load.summary.segmentsEmitted % SEGMENT_PROGRESS_INTERVAL === 0) {
      await emitProgressSafely(
        load.ctx,
        `Google Maps phase=emit pass=emit stream=timeline_segments emitted=${load.summary.segmentsEmitted}/streaming`,
        { stream: "timeline_segments" }
      );
    }
  }
}

async function processStreamEvent(load: StreamLoadContext, event: GoogleMapsStreamEvent): Promise<void> {
  if (event.kind === "shape") {
    return;
  }
  const parsed = parseGoogleMapsExportElement(event.format, event.value);
  await processPointRecords(load, parsed.points);
  await processSegmentRecords(load, parsed.segments);
}

async function streamTimelineFile(load: StreamLoadContext, file: string): Promise<void> {
  await streamGoogleMapsExport(file, (event) => processStreamEvent(load, event));
}

async function reportSourceFailure(ctx: CollectContext, error: unknown): Promise<void> {
  const oversized = error instanceof GoogleMapsElementTooLargeError;
  await emitRequestedSkip(
    ctx,
    oversized ? "record_too_large" : "invalid_json",
    oversized
      ? "A Google Maps Timeline export contains a record that is too large to process safely"
      : "A Google Maps Timeline export file could not be parsed as JSON"
  );
}

async function loadExports(ctx: CollectContext, importDir: string, state: GoogleMapsState): Promise<LoadSummary> {
  const files = await discoverTimelineFiles(importDir);
  const requestedPoints = ctx.requested.has("timeline_points");
  const requestedSegments = ctx.requested.has("timeline_segments");
  const pointSince = state.timeline_points?.last_timestamp;
  const segmentSince = state.timeline_segments?.last_start_time;
  const summary: LoadSummary = {
    complete: true,
    latestPoint: pointSince,
    latestSegment: segmentSince,
    pointCount: 0,
    pointsEmitted: 0,
    segmentCount: 0,
    segmentsEmitted: 0,
    unrecognizedCount: 0,
    unrecognizedKinds: new Set(),
  };
  const load: StreamLoadContext = {
    ctx,
    pointSince,
    requestedPoints,
    requestedSegments,
    segmentSince,
    seenPointIds: new Set(),
    seenSegmentIds: new Set(),
    summary,
  };

  await ctx.progress(`Google Maps phase=index pass=index source_files=${files.length}`);
  if (requestedPoints) {
    await ctx.progress("Google Maps phase=emit pass=emit stream=timeline_points total_items=streaming", {
      stream: "timeline_points",
    });
  }
  if (requestedSegments) {
    await ctx.progress("Google Maps phase=emit pass=emit stream=timeline_segments total_items=streaming", {
      stream: "timeline_segments",
    });
  }

  let fileOrdinal = 0;
  for (const file of files) {
    fileOrdinal += 1;
    await ctx.progress(`Google Maps phase=parse pass=parse source_file=${fileOrdinal}/${files.length}`);
    try {
      await streamTimelineFile(load, file);
    } catch (error) {
      if (isGoogleMapsEmissionError(error)) {
        throw error.cause;
      }
      summary.complete = false;
      await reportSourceFailure(ctx, error);
    }
  }

  return summary;
}

async function finishPoints(ctx: CollectContext, summary: LoadSummary): Promise<void> {
  if (!summary.complete) {
    return;
  }
  await ctx.emit({
    type: "STATE",
    stream: "timeline_points",
    cursor: { last_timestamp: summary.latestPoint },
  });
  await ctx.emit(
    buildDetailCoverageMessage({
      stream: "timeline_points",
      stateStream: "timeline_points",
      requiredKeys: [],
      hydratedKeys: [],
      considered: summary.pointCount,
      covered: summary.pointCount,
    })
  );
}

async function finishSegments(ctx: CollectContext, summary: LoadSummary): Promise<void> {
  if (!summary.complete) {
    return;
  }
  if (summary.unrecognizedKinds.size > 0) {
    await ctx.progress(
      `Google Maps phase=emit pass=emit stream=timeline_segments unrecognized_segments=${summary.unrecognizedCount} unrecognized_kinds=${[
        ...summary.unrecognizedKinds,
      ]
        .sort()
        .join(",")}`,
      { stream: "timeline_segments" }
    );
  }
  await ctx.emit({
    type: "STATE",
    stream: "timeline_segments",
    cursor: { last_start_time: summary.latestSegment },
  });
  await ctx.emit(buildFullScanCoverageMessage("timeline_segments", summary.segmentCount));
}

runConnector({
  name: "google_maps",
  validateRecord,
  async collect(ctx) {
    const importDir = process.env.GOOGLE_MAPS_TIMELINE_DIR || join(homedir(), ".pdpp/imports/google_maps");
    const typedState = ctx.state as GoogleMapsState;
    const requestedPoints = ctx.requested.has("timeline_points");
    const requestedSegments = ctx.requested.has("timeline_segments");
    const summary = await loadExports(ctx, importDir, typedState);

    if (requestedPoints && summary.pointCount === 0) {
      await ctx.emit({
        type: "SKIP_RESULT",
        stream: "timeline_points",
        reason: "timeline_points_not_found",
        message: "Google Maps Timeline point records were not found in the configured import directory",
      });
    }
    if (requestedSegments && summary.segmentCount === 0) {
      await ctx.emit({
        type: "SKIP_RESULT",
        stream: "timeline_segments",
        reason: "timeline_segments_not_found",
        message: "Google Maps Timeline segment records were not found in the configured import directory",
      });
    }

    if (requestedPoints) {
      await finishPoints(ctx, summary);
    }
    if (requestedSegments) {
      await finishSegments(ctx, summary);
    }
  },
});
